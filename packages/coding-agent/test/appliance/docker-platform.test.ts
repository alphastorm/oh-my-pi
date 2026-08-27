import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoundedApplianceExecutor, type BoundedCommandResult } from "@oh-my-pi/pi-coding-agent/appliance/bounded-executor";
import {
	buildWindowsLifecycleCommand,
	detectNativeLinuxDocker,
	dockerLoopbackBinding,
	hardenWindowsApplianceRoot,
	LinuxDockerAppliancePlatform,
	parseWindowsFreeDiskBytes,
	parseWindowsPortOccupied,
} from "@oh-my-pi/pi-coding-agent/appliance/docker-platform";
import type { ApplianceProfile } from "@oh-my-pi/pi-coding-agent/appliance/types";

const roots: string[] = [];
const lifecycleScript = Buffer.from("#!/bin/sh\n");
const lifecycleScriptSha256 = createHash("sha256").update(lifecycleScript).digest("hex");

function linuxDockerProfile(): ApplianceProfile {
	return {
		id: "qwen3.8-27b", profile: "linux-docker-local", runtime: "ninfer", architecture: "sm_120a",
		minVramGiB: 32, minimumDiskGiB: 64, artifactSha256: "2".repeat(64), contextWindow: 131072, maxTokens: 32768,
		kvDtype: "bf16", speculation: "mtp3", concurrency: 1, preserveThinking: true, protocol: "openai-responses",
		capabilities: ["tools", "reasoning", "thinking-history", "stateful-responses", "vision"],
		release: "v0.2-preview", servedModel: "q38-ninfer", aliases: ["local-max"], defaultPort: 18089,
		availability: { installable: true, channel: "beta", blockers: [], qualificationReceipt: { url: "https://example.invalid/acceptance.json", sha256: "3".repeat(64) } },
		assets: {
			runtime: { kind: "runtime", url: "ghcr.io/alphastorm/ninfer@sha256:" + "4".repeat(64), sha256: "4".repeat(64) },
			model: { kind: "model", url: "https://example.invalid/model.ninfer", sha256: "2".repeat(64), bytes: 18_210_531_328 },
		},
		adapter: "linux-docker-local", supportStatus: "preview", supportOwner: "omp-ninfer", limitations: [],
		lifecycleCommands: ["doctor", "plan", "install", "status", "benchmark", "rollback", "support-bundle"],
		container: { imageReference: "ghcr.io/alphastorm/ninfer@sha256:" + "4".repeat(64), imageDigest: "sha256:" + "4".repeat(64), containerPort: 8080, serverBinarySha256: "5".repeat(64), configurationSha256: "6".repeat(64), restartPolicy: "no" },
		lifecycle: { scriptUrl: "https://example.invalid/lifecycle.sh", scriptSha256: lifecycleScriptSha256, arguments: [] },
	};
}

function withHostPlatform<T>(platform: NodeJS.Platform, wslInterop: string | undefined, callback: () => T): T {
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
	const originalWslInterop = process.env.WSL_INTEROP;
	Object.defineProperty(process, "platform", { ...descriptor, value: platform });
	if (wslInterop === undefined) delete process.env.WSL_INTEROP;
	else process.env.WSL_INTEROP = wslInterop;
	try { return callback(); }
	finally {
		Object.defineProperty(process, "platform", descriptor);
		if (originalWslInterop === undefined) delete process.env.WSL_INTEROP;
		else process.env.WSL_INTEROP = originalWslInterop;
	}
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("explicit local Docker adapters", () => {
	test("builds exact native Windows PowerShell arguments", () => {
		const command = buildWindowsLifecycleCommand("C:\\Users\\tester\\lifecycle.ps1", ["install", "--json"], "C:\\Windows");
		expect(command).toEqual([
			"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
			"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
			"C:\\Users\\tester\\lifecycle.ps1", "install", "--json",
		]);
		expect(command.join(" ")).not.toMatch(/ssh|wsl|putty/iu);
		expect(buildWindowsLifecycleCommand("C:\\Users\\tester\\lifecycle.ps1", [])[0]).toBe(
			"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
		);
		expect(() => buildWindowsLifecycleCommand("C:\\Users\\tester\\lifecycle.ps1", [], "C:Windows")).toThrow("local absolute");
		expect(() => buildWindowsLifecycleCommand("\\\\server\\lifecycle.ps1", [])).toThrow("local absolute");
	});

	test("publishes only an explicit loopback binding", () => {
		expect(dockerLoopbackBinding(18089, 8080)).toBe("127.0.0.1:18089:8080");
		expect(() => dockerLoopbackBinding(0, 8080)).toThrow("Invalid local");
	});

	test("parses native Windows free-disk bytes without platform rounding drift", () => {
		expect(parseWindowsFreeDiskBytes(String(100 * 1024 ** 3))).toBe(100);
		expect(parseWindowsFreeDiskBytes("not-a-number")).toBeUndefined();
	});

	test("parses native Windows listener state exactly", () => {
		expect(parseWindowsPortOccupied("True\r\n")).toBe(true);
		expect(parseWindowsPortOccupied("False\r\n")).toBe(false);
	});

	test("hardens Windows ACLs before adapter secret writes", async () => {
		const root = await mkdtemp(join(tmpdir(), "omp-windows-acl-contract-"));
		roots.push(root);
		const commands: readonly string[][] = [];
		const mutable = commands as string[][];
		const runner = async (command: readonly string[]): Promise<BoundedCommandResult> => {
			mutable.push([...command]);
			if (command[0] === "C:\\Windows\\System32\\whoami.exe") return { code: 0, stdout: '"tester","S-1-5-21-1-2-3-1001"\r\n', stderr: "" };
			return { code: 0, stdout: "processed", stderr: "" };
		};
		await hardenWindowsApplianceRoot(root, new BoundedApplianceExecutor({ runner }), "C:\\Windows");
		expect(commands).toEqual([
			["C:\\Windows\\System32\\whoami.exe", "/user", "/fo", "csv", "/nh"],
			["C:\\Windows\\System32\\icacls.exe", root, "/inheritance:r", "/grant:r", "S-1-5-21-1-2-3-1001:(OI)(CI)F", "/grant:r", "*S-1-5-18:(OI)(CI)F"],
		]);
		await expect(hardenWindowsApplianceRoot(root, new BoundedApplianceExecutor({ runner }), "C:Windows"))
			.rejects.toThrow("local absolute");
	});

	test("detects native Linux without coupling to GPU model", () => {
		expect(detectNativeLinuxDocker({ platform: "linux", architecture: "x64", dockerServer: "linux/amd64", nvidiaRuntimes: '{"nvidia":{}}' })).toEqual([]);
		expect(detectNativeLinuxDocker({ platform: "linux", architecture: "x64", wslInterop: "/run/WSL/1", dockerServer: "linux/amd64", nvidiaRuntimes: '{"nvidia":{}}' }).join(" ")).toContain("linux-docker-local requires native Linux OMP");
		expect(detectNativeLinuxDocker({
			platform: "linux",
			architecture: "x64",
			wslInterop: "/run/WSL/1",
			wslDistribution: "Ubuntu-24.04",
			delegatedWslDistribution: "Ubuntu-24.04",
			dockerServer: "linux/amd64",
			nvidiaRuntimes: '{"nvidia":{}}',
		})).toEqual([]);
		expect(detectNativeLinuxDocker({ platform: "linux", architecture: "x64", dockerServer: "linux/amd64", nvidiaRuntimes: "{}" })).toContain("NVIDIA Container Toolkit is unavailable");
		expect(() => withHostPlatform("darwin", undefined, () => new LinuxDockerAppliancePlatform({
			agentDir: ".",
			profile: linuxDockerProfile(),
		}))).toThrow("native Linux");
		expect(() => withHostPlatform("linux", "/run/WSL/1", () => new LinuxDockerAppliancePlatform({
			agentDir: ".",
			profile: linuxDockerProfile(),
		}))).toThrow("native Linux");
		expect(() => new LinuxDockerAppliancePlatform({
			agentDir: ".",
			profile: linuxDockerProfile(),
			platform: "linux",
			architecture: "x64",
			environment: { WSL_INTEROP: "/run/WSL/1", WSL_DISTRO_NAME: "Ubuntu-24.04" },
			delegatedWslDistribution: "Ubuntu-24.04",
		})).not.toThrow();
		expect(() => new LinuxDockerAppliancePlatform({
			agentDir: ".",
			profile: linuxDockerProfile(),
			platform: "linux",
			architecture: "x64",
			environment: { WSL_INTEROP: "/run/WSL/1", WSL_DISTRO_NAME: "Debian" },
			delegatedWslDistribution: "Ubuntu-24.04",
		})).toThrow("exact remote WSL delegation");
	});

	test("delegates immutable acquisition and candidate setup without exposing secrets", async () => {
		const root = await mkdtemp(join(tmpdir(), "omp-linux-docker-adapter-"));
		roots.push(root);
		const profile = linuxDockerProfile();
		const commands: string[][] = [];
		const runner = async (command: readonly string[]): Promise<BoundedCommandResult> => {
			commands.push([...command]);
			const operation = command.find(value => ["acquire", "prepare", "start", "status"].includes(value)) ?? "unknown";
			const kind = command[command.indexOf("--kind") + 1];
			return { code: 0, stderr: "", stdout: JSON.stringify({
				schemaVersion: 1, kind: "omp-ninfer-lifecycle-receipt", operation, status: "ok",
				...(operation === "acquire" ? { ref: kind + "-ref" } : {}),
				...(operation === "prepare" ? { candidateId: "candidate-1", handle: "container-1" } : {}),
				...(operation === "status" ? { containerId: "container-id-1", imageDigest: profile.container!.imageDigest, modelSha256: profile.assets!.model.sha256, configurationSha256: profile.container!.configurationSha256, serverBinarySha256: profile.container!.serverBinarySha256, binding: "127.0.0.1:18089:8080", restartPolicy: "no", owned: true } : {}),
			}) };
		};
		const fakeFetch = (async (input: string | URL | Request) => String(input).endsWith("/status")
			? { ok: true, json: async () => ({ deployment_profile: "qwen38-5090-v0.1.0", image_digest: profile.container!.imageDigest, model_sha256: profile.assets!.model.sha256, configuration_sha256: profile.container!.configurationSha256, server_binary_sha256: profile.container!.serverBinarySha256 }) }
			: { ok: true, url: "https://example.invalid/lifecycle.sh", arrayBuffer: async () => lifecycleScript.buffer.slice(lifecycleScript.byteOffset, lifecycleScript.byteOffset + lifecycleScript.byteLength) }) as unknown as typeof fetch;
		const platform = withHostPlatform("linux", undefined, () => new LinuxDockerAppliancePlatform({ agentDir: root, root, profile, runner, fetch: fakeFetch }));
		const runtimeRef = await platform.acquireArtifact(profile.assets!.runtime);
		const modelRef = await platform.acquireArtifact(profile.assets!.model);
		const candidate = await platform.createCandidate({ profile, runtimeRef, modelRef, secret: "never-on-command-line", port: 18089, installationId: "installation-1" });
		await platform.startCandidate(candidate);
		await platform.probeHealth(candidate, "never-on-command-line");

		expect(candidate).toMatchObject({ candidateId: "candidate-1", handle: "container-1", endpoint: "http://127.0.0.1:18089" });
		expect(commands.flat()).not.toContain("never-on-command-line");
		expect(commands.flat()).not.toContain("ssh");
		const prepareCommand = commands.find(command => command.includes("prepare"));
		expect(prepareCommand).toContain("127.0.0.1:18089:8080");
		const secretPath = prepareCommand?.[prepareCommand.indexOf("--secret-file") + 1];
		expect(secretPath).toBeTruthy();
		if (process.platform !== "win32") expect((await stat(secretPath!)).mode & 0o077).toBe(0);
		expect((await readFile(secretPath!, "utf8")).trim()).toBe("never-on-command-line");
	});

	test("rejects wrong existing lifecycle-script bytes after exclusive-create collision", async () => {
		const root = await mkdtemp(join(tmpdir(), "omp-linux-docker-script-collision-"));
		roots.push(root);
		const profile = linuxDockerProfile();
		const target = join(root, "lifecycle-" + lifecycleScriptSha256 + ".sh");
		await writeFile(target, "foreign lifecycle bytes", { mode: 0o700 });
		const commands: string[][] = [];
		const platform = withHostPlatform("linux", undefined, () => new LinuxDockerAppliancePlatform({
			agentDir: root,
			root,
			profile,
			runner: async command => { commands.push([...command]); throw new Error("lifecycle must not execute"); },
			fetch: (async () => ({
				ok: true,
				url: "https://example.invalid/lifecycle.sh",
				arrayBuffer: async () => lifecycleScript.buffer.slice(
					lifecycleScript.byteOffset,
					lifecycleScript.byteOffset + lifecycleScript.byteLength,
				),
			})) as unknown as typeof fetch,
		}));
		await expect(platform.acquireArtifact(profile.assets!.runtime)).rejects.toThrow("checksum mismatch for existing script");
		expect(commands).toEqual([]);
	});
});
