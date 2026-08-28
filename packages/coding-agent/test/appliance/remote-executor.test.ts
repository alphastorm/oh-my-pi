import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import type { CompatibilityAuthority } from "@oh-my-pi/pi-coding-agent/appliance/compatibility-authority";
import {
	executeRemoteApplianceAction,
	type RemoteReceiptExecutorFactory,
} from "@oh-my-pi/pi-coding-agent/appliance/remote-action";
import {
	RemoteApplianceError,
	type RemoteCommandRunner,
	runRemoteCommand,
	SshApplianceExecutor,
} from "@oh-my-pi/pi-coding-agent/appliance/remote-executor";
import {
	decodeRemoteApplianceRequest,
	REMOTE_APPLIANCE_BUILD_ID,
	REMOTE_APPLIANCE_RECEIPT_LIMIT,
	type RemoteApplianceCompatibility,
	remoteDelegationManifest,
} from "@oh-my-pi/pi-coding-agent/appliance/remote-protocol";
import type { ApplianceAction, ApplianceProfile, ApplianceReceipt } from "@oh-my-pi/pi-coding-agent/appliance/types";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";

function compatibility(text = '{"schema_version":1}'): RemoteApplianceCompatibility {
	const bytes = Buffer.from(text, "utf8");
	return {
		bytes,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		transportProfile: "darwin-remote-ssh",
	};
}

function receipt(
	action: ApplianceAction,
	compatibilityAuthority?: RemoteApplianceCompatibility,
	details: Record<string, unknown> = {},
): ApplianceReceipt {
	return {
		schemaVersion: 1,
		receiptId: `${action}-receipt`,
		action,
		status: "ok",
		timestamp: "2026-08-28T11:00:00.000Z",
		details: {
			...details,
			remoteDelegation: {
				schemaVersion: 1,
				version: VERSION,
				buildIdentity: REMOTE_APPLIANCE_BUILD_ID,
				compatibilitySha256: compatibilityAuthority?.sha256 ?? null,
				transportProfile: compatibilityAuthority?.transportProfile ?? null,
				localProfile: compatibilityAuthority ? "linux-docker-local" : null,
				cleanup: "ok",
				effect: "confirmed",
			},
		},
	};
}

function successfulRunner(
	onRequest?: (
		request: ReturnType<typeof decodeRemoteApplianceRequest>,
		command: readonly string[],
	) => ApplianceReceipt,
): { runner: RemoteCommandRunner; commands: string[][] } {
	const commands: string[][] = [];
	return {
		commands,
		runner: async (command, _timeout, stdin) => {
			commands.push([...command]);
			const remote = command.at(-1)!;
			if (remote.includes("--delegation-manifest")) {
				return { code: 0, stdout: JSON.stringify(remoteDelegationManifest()), stderr: "" };
			}
			const tokens = remote.split(" ");
			const action = tokens[tokens.indexOf("appliance") + 1] as ApplianceAction;
			const payload = tokens[tokens.indexOf("--delegation-payload") + 1]!;
			const request = decodeRemoteApplianceRequest(payload, action, stdin);
			const value = onRequest?.(request, command) ?? receipt(action, request.compatibility);
			return { code: value.status === "ok" ? 0 : 1, stdout: JSON.stringify(value), stderr: "" };
		},
	};
}

function errorCode(error: unknown): string | undefined {
	return error instanceof RemoteApplianceError ? error.code : undefined;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
		throw new Error("Expected promise to reject");
	} catch (error) {
		return error;
	}
}

describe("SSH appliance lifecycle delegation", () => {
	it("verifies one exact remote client then sends one canonical WSL argv payload", async () => {
		const authority = compatibility('{"public":"bytes only"}');
		const state = { installs: 0 };
		const { runner, commands } = successfulRunner(request => {
			expect(request.invocation).toEqual({
				action: "install",
				model: "qwen3.8",
				gpu: "rtx5090",
				port: 18089,
			});
			expect(Buffer.from(request.compatibility!.bytes).toString("utf8")).toBe('{"public":"bytes only"}');
			expect(request.wslDistribution).toBe("Ubuntu-24.04");
			state.installs += 1;
			return receipt("install", authority, { idempotent: false });
		});
		const executor = new SshApplianceExecutor({ host: "windows-gpu-host", wslDistribution: "Ubuntu-24.04", runner });

		const result = await executor.execute("install", {
			model: "qwen3.8",
			gpu: "rtx5090",
			port: 18089,
			compatibility: authority,
		});

		expect(result.details.idempotent).toBe(false);
		expect(state.installs).toBe(1);
		expect(commands).toHaveLength(2);
		expect(commands[0]).toEqual([
			"/usr/bin/ssh",
			"-T",
			"-o",
			"BatchMode=yes",
			"-o",
			"ConnectTimeout=10",
			"-o",
			"ClearAllForwardings=yes",
			"-o",
			"ForwardAgent=no",
			"-o",
			"ForwardX11=no",
			"windows-gpu-host",
			"wsl.exe -d Ubuntu-24.04 --exec omp appliance status --delegation-manifest --json",
		]);
		const actionCommand = commands[1]!.at(-1)!;
		expect(actionCommand).toStartWith("wsl.exe -d Ubuntu-24.04 --exec omp appliance install --delegation-payload ");
		expect(actionCommand).toEndWith(" --json");
		expect(actionCommand).not.toContain("public");
	});

	it("uses the direct Linux command boundary for profileless doctor/status", async () => {
		const { runner, commands } = successfulRunner(request =>
			receipt(request.invocation.action, undefined, { installed: false }),
		);
		const executor = new SshApplianceExecutor({ host: "omp@gpu.example.internal", runner });
		const status = await executor.execute("status");
		expect(status.details.installed).toBe(false);
		expect(commands[1]!.at(-1)).toMatch(/^omp appliance status --delegation-payload [A-Za-z0-9_-]+ --json$/);
	});

	it("rejects unreachable, wrong-version, and wrong-build clients before the action", async () => {
		const unreachable = new SshApplianceExecutor({
			host: "windows-gpu-host",
			runner: async () => ({ code: 255, stdout: "", stderr: "/private/remote/log: connection refused" }),
		});
		const unavailableError = await rejection(unreachable.execute("status"));
		expect(errorCode(unavailableError)).toBe("REMOTE_CLIENT_UNAVAILABLE");
		expect(String(unavailableError)).not.toContain("/private/remote/log");
		for (const [manifest, code] of [
			[{ ...remoteDelegationManifest(), version: "18.0.8" }, "REMOTE_VERSION_MISMATCH"],
			[
				{ ...remoteDelegationManifest(), buildIdentity: `sha256:${"0".repeat(64)}` },
				"REMOTE_BUILD_IDENTITY_MISMATCH",
			],
		] as const) {
			let calls = 0;
			const executor = new SshApplianceExecutor({
				host: "windows-gpu-host",
				runner: async () => {
					calls += 1;
					return { code: 0, stdout: JSON.stringify(manifest), stderr: "" };
				},
			});
			expect(errorCode(await rejection(executor.execute("status")))).toBe(code);
			expect(calls).toBe(1);
		}
	});

	it("rejects malformed, oversized, contaminated, and action-mismatched receipts", async () => {
		for (const [stdout, code] of [
			["banner\n{}", "REMOTE_RECEIPT_MALFORMED"],
			["x".repeat(REMOTE_APPLIANCE_RECEIPT_LIMIT + 1), "REMOTE_RECEIPT_OVERSIZE"],
			[
				JSON.stringify(receipt("doctor", undefined, { message: "state root /home/operator/.omp failed" })),
				"REMOTE_RECEIPT_MALFORMED",
			],
			[JSON.stringify(receipt("doctor")), "REMOTE_RECEIPT_MALFORMED"],
		] as const) {
			let calls = 0;
			const executor = new SshApplianceExecutor({
				host: "windows-gpu-host",
				runner: async () => {
					calls += 1;
					return calls === 1
						? { code: 0, stdout: JSON.stringify(remoteDelegationManifest()), stderr: "" }
						: { code: 0, stdout, stderr: "" };
				},
			});
			expect(errorCode(await rejection(executor.execute("status")))).toBe(code);
		}
	});

	it("marks a mutating timeout or missing receipt uncertain and never retries", async () => {
		const authority = compatibility();
		for (const failure of [new Error("Appliance command timed out"), new Error("ssh stream closed")]) {
			let calls = 0;
			const executor = new SshApplianceExecutor({
				host: "windows-gpu-host",
				runner: async () => {
					calls += 1;
					if (calls === 1) return { code: 0, stdout: JSON.stringify(remoteDelegationManifest()), stderr: "" };
					throw failure;
				},
			});
			const error = await rejection(
				executor.execute("install", { model: "qwen3.8", gpu: "auto", compatibility: authority }),
			);
			expect(error).toBeInstanceOf(RemoteApplianceError);
			expect((error as RemoteApplianceError).effect).toBe("uncertain");
			expect(String(error)).toContain("must not be retried blindly");
			expect(calls).toBe(2);
		}
	});

	it("treats every receipt-persisting action as uncertain after transport loss", async () => {
		const authority = compatibility();
		for (const [action, options] of [
			["benchmark", { quick: true, compatibility: authority }],
			["checkpoint", { checkpointOperation: "status", sessionSha256: "8".repeat(64), compatibility: authority }],
			["support-bundle", { compatibility: authority }],
		] as const) {
			let calls = 0;
			const executor = new SshApplianceExecutor({
				host: "windows-gpu-host",
				runner: async () => {
					calls += 1;
					if (calls === 1) return { code: 0, stdout: JSON.stringify(remoteDelegationManifest()), stderr: "" };
					throw new Error("Appliance command timed out");
				},
			});
			const error = await rejection(executor.execute(action, options));
			expect(error).toMatchObject({ code: "REMOTE_TIMEOUT_UNCERTAIN_EFFECT", effect: "uncertain" });
			expect(calls).toBe(2);
		}
	});

	it("keeps doctor, plan, and status no-effect after transport loss", async () => {
		const authority = compatibility();
		for (const [action, options] of [
			["doctor", {}],
			["plan", { model: "qwen3.8", gpu: "auto", compatibility: authority }],
			["status", {}],
		] as const) {
			let calls = 0;
			const executor = new SshApplianceExecutor({
				host: "windows-gpu-host",
				runner: async () => {
					calls += 1;
					if (calls === 1) return { code: 0, stdout: JSON.stringify(remoteDelegationManifest()), stderr: "" };
					throw new Error("Appliance command timed out");
				},
			});
			const error = await rejection(executor.execute(action, options));
			expect(error).toMatchObject({ code: "REMOTE_ACTION_TIMEOUT", effect: "none" });
			expect(calls).toBe(2);
		}
	});

	it("preserves a no-effect authority-drift failure receipt through the SSH executor", async () => {
		const authority = compatibility();
		const { runner } = successfulRunner(() => ({
			...receipt("install", authority),
			status: "failed",
			details: {
				remoteDelegation: {
					schemaVersion: 1,
					version: VERSION,
					buildIdentity: REMOTE_APPLIANCE_BUILD_ID,
					compatibilitySha256: authority.sha256,
					transportProfile: "darwin-remote-ssh",
					localProfile: null,
					cleanup: "ok",
					effect: "none",
					failureCode: "REMOTE_COMPATIBILITY_HASH_MISMATCH",
				},
			},
		}));
		const result = await new SshApplianceExecutor({ host: "windows-gpu-host", runner }).execute("install", {
			model: "qwen3.8",
			gpu: "auto",
			compatibility: authority,
		});
		expect(result).toMatchObject({
			status: "failed",
			details: {
				remoteDelegation: {
					localProfile: null,
					cleanup: "ok",
					effect: "none",
					failureCode: "REMOTE_COMPATIBILITY_HASH_MISMATCH",
				},
			},
		});
	});

	it("preserves simultaneous action and cleanup failure through the SSH executor", async () => {
		const authority = compatibility();
		const { runner } = successfulRunner(() => ({
			...receipt("install", authority),
			status: "failed",
			details: {
				remoteDelegation: {
					schemaVersion: 1,
					version: VERSION,
					buildIdentity: REMOTE_APPLIANCE_BUILD_ID,
					compatibilitySha256: authority.sha256,
					transportProfile: "darwin-remote-ssh",
					localProfile: "linux-docker-local",
					cleanup: "failed",
					effect: "uncertain",
					failureCode: "REMOTE_DELEGATED_ACTION_FAILED",
				},
			},
		}));
		const result = await new SshApplianceExecutor({ host: "windows-gpu-host", runner }).execute("install", {
			model: "qwen3.8",
			gpu: "auto",
			compatibility: authority,
		});
		expect(result).toMatchObject({
			status: "failed",
			details: {
				remoteDelegation: { cleanup: "failed", effect: "uncertain", failureCode: "REMOTE_DELEGATED_ACTION_FAILED" },
			},
		});
	});

	it("keeps every untrusted argument inside one base64url payload", async () => {
		const injected = compatibility('{"note":"\'; touch /tmp/pwned; #"}');
		const { runner, commands } = successfulRunner();
		const executor = new SshApplianceExecutor({ host: "windows-gpu-host", runner });
		await executor.execute("install", { model: "qwen3.8", gpu: "auto", compatibility: injected });
		const wire = commands[1]!.at(-1)!;
		expect(wire).not.toContain("touch");
		expect(wire).not.toContain(";");
		expect(() => new SshApplianceExecutor({ host: "-oProxyCommand=bad" })).toThrow("SSH hostname or alias");
		expect(
			() => new SshApplianceExecutor({ host: "windows-gpu-host", wslDistribution: "Ubuntu 24.04; bad" }),
		).toThrow("invalid characters");
		await expect(
			executor.execute("checkpoint", {
				checkpointOperation: "save",
				sessionSha256: `${"a".repeat(63)};`,
				compatibility: injected,
			}),
		).rejects.toThrow("session SHA-256 is invalid");
	});

	it("allows profileless remote inspection but requires authority for remote effects", async () => {
		let executorCreations = 0;
		const actions: ApplianceAction[] = [];
		const factory: RemoteReceiptExecutorFactory = () => {
			executorCreations += 1;
			return {
				execute: async action => {
					actions.push(action);
					return receipt(action);
				},
			};
		};
		await executeRemoteApplianceAction("doctor", { remote: "windows-gpu-host" }, factory);
		await executeRemoteApplianceAction("status", { remote: "windows-gpu-host", remoteWsl: "Ubuntu-24.04" }, factory);
		expect(actions).toEqual(["doctor", "status"]);
		await expect(
			executeRemoteApplianceAction("install", { remote: "windows-gpu-host", model: "qwen3.8" }, factory),
		).rejects.toThrow("exact compatibility authority");
		for (const remote of ["", "   "]) {
			await expect(executeRemoteApplianceAction("doctor", { remote }, factory)).rejects.toThrow(
				"--remote must not be blank",
			);
		}
		await expect(executeRemoteApplianceAction("doctor", { remoteWsl: "Ubuntu-24.04" }, factory)).rejects.toThrow(
			"--remote-wsl requires --remote",
		);
		expect(executorCreations).toBe(2);

		const bytes = Buffer.from("{}", "utf8");
		const selectedProfile = {
			adapter: "darwin-remote-ssh",
			lifecycleCommands: ["install"],
		} as ApplianceProfile;
		const authority = {
			bytes,
			sha256: createHash("sha256").update(bytes).digest("hex"),
		} as unknown as CompatibilityAuthority;
		await expect(executeRemoteApplianceAction("status", { authority, selectedProfile }, factory)).rejects.toThrow(
			"requires --remote",
		);
		await expect(
			executeRemoteApplianceAction(
				"status",
				{
					remote: "windows-gpu-host",
					selectedProfile: { ...selectedProfile, adapter: "linux-docker-local" },
				},
				factory,
			),
		).rejects.toThrow("darwin-remote-ssh compatibility profile");
		await executeRemoteApplianceAction(
			"install",
			{
				remote: "windows-gpu-host",
				model: "qwen3.8",
				gpu: "auto",
				authority,
				selectedProfile,
			},
			factory,
		);
		expect(executorCreations).toBe(3);
	});

	it("decodes UTF-8 output on byte boundaries without permitting private paths", async () => {
		const expected = receipt("status", undefined, { note: "雪 is reachable" });
		const encoded = Buffer.from(JSON.stringify(expected), "utf8");
		const snow = Buffer.from("雪", "utf8");
		const boundary = encoded.indexOf(snow) + 1;
		const first = encoded.subarray(0, boundary).toString("hex");
		const second = encoded.subarray(boundary).toString("hex");
		const result = await runRemoteCommand(
			[
				process.execPath,
				"-e",
				`process.stdout.write(Buffer.from(${JSON.stringify(first)}, "hex")); setTimeout(() => process.stdout.write(Buffer.from(${JSON.stringify(second)}, "hex")), 5);`,
			],
			5_000,
		);
		expect(result.stdout).toBe(JSON.stringify(expected));
		const staged = Buffer.from("public compatibility bytes", "utf8");
		const echoed = await runRemoteCommand(
			[process.execPath, "-e", "process.stdin.pipe(process.stdout)"],
			5_000,
			staged,
		);
		expect(Buffer.from(echoed.stdout, "utf8")).toEqual(staged);
	});
});
