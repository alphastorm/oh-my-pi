import { expect, test, vi } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollabRegistryPublisher, resolveCollabRegistryEndpoint } from "../../src/collab/registry-publisher";

/**
 * Windows secures every publisher-token fixture and re-validates its ACL through `powershell.exe`,
 * and hosted runner images have made that spawn cost seconds rather than milliseconds. The first
 * test in this file pays two cold starts. These budgets bound security assertions, not latency, so
 * keep them wide enough on Windows that a slow spawn cannot masquerade as a protocol failure.
 */
const HANDSHAKE_TIMEOUT_MS = process.platform === "win32" ? 15_000 : 2_000;
const PUBLISHER_TEST_TIMEOUT_MS = process.platform === "win32" ? 30_000 : 5_000;

const record = {
	instanceId: "publisher-test-instance",
	generation: 1,
	pid: process.pid,
	sessionId: "publisher-test-session",
	startedAt: "2026-07-19T00:00:00.000Z",
	inputRequired: false,
	viewLink: "VIEW_CAPABILITY_FIXTURE",
	controlLink: "CONTROL_CAPABILITY_FIXTURE",
};

interface AuthBinding {
	readonly clientNonce: string;
	readonly serverNonce: string;
	readonly instanceId: string;
	readonly pid: number;
}
interface AuthenticatedRegistryServer {
	readonly server: { stop(closeActiveConnections?: boolean): void };
	readonly disconnect: () => void;
	readonly frames: Array<Record<string, unknown>>;
	readonly binding: () => AuthBinding | undefined;
	readonly upsertReceived: Promise<void>;
	readonly nextUpsert: () => Promise<Record<string, unknown>>;
}

interface PublisherFixture {
	readonly root: string;
	readonly endpoint: string;
	readonly tokenPath: string;
	readonly environmentKey: "LOCALAPPDATA" | "XDG_CONFIG_HOME";
	readonly previousRoot: string | undefined;
}

function authProof(token: string, domain: string, binding: AuthBinding): string {
	const message = `${domain}\n${binding.clientNonce}\n${binding.serverNonce}\n${binding.instanceId}\n${binding.pid}`;
	return createHmac("sha256", Buffer.from(token, "ascii")).update(message, "utf8").digest("base64url");
}

async function secureWindowsPublisherToken(path: string): Promise<void> {
	if (process.platform !== "win32") return;
	const script =
		"$Path=$env:OMP_GATEWAY_TEST_TOKEN; " +
		"$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; " +
		"$sddl='D:P(A;;FA;;;SY)(A;;FA;;;'+$sid+')'; " +
		"$acl=Get-Acl -LiteralPath $Path; $acl.SetSecurityDescriptorSddlForm($sddl); " +
		"$acl.SetOwner([System.Security.Principal.SecurityIdentifier]::new($sid)); Set-Acl -LiteralPath $Path -AclObject $acl";
	const environment: Record<string, string> = { OMP_GATEWAY_TEST_TOKEN: path };
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && key.toLowerCase() !== "psmodulepath") environment[key] = value;
	}
	const subprocess = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], {
		env: environment,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	const stderr = await new Response(subprocess.stderr).text();
	if ((await subprocess.exited) !== 0) throw new Error(`failed to secure Windows publisher fixture: ${stderr}`);
}

async function createPublisherFixture(label: string): Promise<PublisherFixture> {
	const root = await mkdtemp(join(tmpdir(), `registry-publisher-${label}-`));
	const environmentKey = process.platform === "win32" ? "LOCALAPPDATA" : "XDG_CONFIG_HOME";
	const previousRoot = process.env[environmentKey];
	process.env[environmentKey] = root;
	const configDir =
		process.platform === "win32" ? join(root, "OMP Session Gateway") : join(root, "omp-session-gateway");
	await mkdir(configDir, { mode: 0o700 });
	const tokenPath = join(configDir, "publisher-token");
	await writeFile(tokenPath, `${"A".repeat(43)}\n`, { mode: 0o600 });
	await secureWindowsPublisherToken(tokenPath);
	const endpoint =
		process.platform === "win32"
			? `\\\\.\\pipe\\publisher-${label}-${randomBytes(6).toString("hex")}`
			: join(root, "registry.sock");
	return { root, endpoint, tokenPath, environmentKey, previousRoot };
}

async function prepareServerEndpoint(endpoint: string): Promise<void> {
	if (process.platform !== "win32") await chmod(endpoint, 0o600);
}

async function cleanupPublisherFixture(fixture: PublisherFixture): Promise<void> {
	if (fixture.previousRoot === undefined) delete process.env[fixture.environmentKey];
	else process.env[fixture.environmentKey] = fixture.previousRoot;
	await rm(fixture.root, { recursive: true, force: true });
}

async function beforeTimeout<T>(
	promise: Promise<T>,
	message: string,
	timeoutMilliseconds = HANDSHAKE_TIMEOUT_MS,
): Promise<T> {
	return await Promise.race([
		promise,
		Bun.sleep(timeoutMilliseconds).then(() => {
			throw new Error(message);
		}),
	]);
}

function startAuthenticatedRegistryServer(
	endpoint: string,
	token: string,
	serverNonce: string,
): AuthenticatedRegistryServer {
	const frames: Array<Record<string, unknown>> = [];
	const upsertReceived = Promise.withResolvers<void>();
	const upserts: Array<Record<string, unknown>> = [];
	const upsertWaiters: Array<(frame: Record<string, unknown>) => void> = [];
	const nextUpsert = (): Promise<Record<string, unknown>> => {
		const queued = upserts.shift();
		if (queued) return Promise.resolve(queued);
		const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
		upsertWaiters.push(resolve);
		return promise;
	};
	let binding: AuthBinding | undefined;
	let activeSocket: Bun.Socket<{ buffer: string }> | undefined;
	const server = Bun.listen<{ buffer: string }>({
		unix: endpoint,
		data: { buffer: "" },
		socket: {
			open(socket) {
				activeSocket = socket;
			},
			data(socket, data) {
				socket.data.buffer += Buffer.from(data).toString("utf8");
				while (socket.data.buffer.includes("\n")) {
					const newline = socket.data.buffer.indexOf("\n");
					const line = socket.data.buffer.slice(0, newline);
					socket.data.buffer = socket.data.buffer.slice(newline + 1);
					const frame = JSON.parse(line) as Record<string, unknown>;
					frames.push(frame);
					if (frame.op === "hello") {
						binding = {
							clientNonce: String(frame.clientNonce),
							serverNonce,
							instanceId: String(frame.instanceId),
							pid: Number(frame.pid),
						};
						socket.write(
							`${JSON.stringify({
								v: 1,
								op: "challenge",
								serverNonce,
								proof: authProof(token, "omp-session-gateway.registry.server.v1", binding),
							})}\n`,
						);
					} else if (frame.op === "authenticate") {
						socket.write(`${JSON.stringify({ v: 1, op: "hello_ok", heartbeatSeconds: 10, ttlSeconds: 35 })}\n`);
					} else if (frame.op === "upsert") {
						upsertReceived.resolve();
						const waiter = upsertWaiters.shift();
						if (waiter) waiter(frame);
						else upserts.push(frame);
					}
				}
			},
			error() {},
		},
	});
	return {
		server,
		disconnect: () => {
			activeSocket?.end();
		},
		frames,
		binding: () => binding,
		upsertReceived: upsertReceived.promise,
		nextUpsert,
	};
}

test("publisher mutual-auth proof vector matches the gateway protocol", () => {
	const binding: AuthBinding = {
		clientNonce: "B".repeat(43),
		serverNonce: "C".repeat(43),
		instanceId: "instance-test-0001",
		pid: 1234,
	};
	expect(authProof("A".repeat(43), "omp-session-gateway.registry.server.v1", binding)).toBe(
		"NT4hA8hoCUXMiqxyLsFZ6iS_9ltMu29fwwO15eysGTE",
	);
	expect(authProof("A".repeat(43), "omp-session-gateway.registry.client.v1", binding)).toBe(
		"PKJ2B96ezRFtwFaZuZhtAR23nOw_TtahkxSo32AOQuQ",
	);
});

test("registry endpoint accepts only qualified local IPC", () => {
	expect(resolveCollabRegistryEndpoint("off")).toBeUndefined();
	if (process.platform === "win32") {
		expect(resolveCollabRegistryEndpoint("auto")).toMatch(/^\\\\\.\\pipe\\omp-session-gateway-[a-f0-9]{20}$/u);
		expect(resolveCollabRegistryEndpoint("\\\\.\\pipe\\omp-session-gateway-explicit")).toBe(
			"\\\\.\\pipe\\omp-session-gateway-explicit",
		);
		expect(() => resolveCollabRegistryEndpoint("\\\\.\\pipe\\nested\\other")).toThrow("local Windows named pipe");
		return;
	}
	expect(resolveCollabRegistryEndpoint("auto")).toBeString();
	expect(() => resolveCollabRegistryEndpoint("https://gateway.example.invalid")).toThrow("local IPC");
	expect(() => resolveCollabRegistryEndpoint("wss://gateway.example.invalid")).toThrow("local IPC");
	expect(() => resolveCollabRegistryEndpoint("relative.sock")).toThrow("absolute");
});

test(
	"publisher sends no token, proof, or capability to a named-pipe squatter",
	async () => {
		const fixture = await createPublisherFixture("squatter");
		const frames: Array<Record<string, unknown>> = [];
		const server = Bun.listen<{ buffer: string; challenged: boolean }>({
			unix: fixture.endpoint,
			data: { buffer: "", challenged: false },
			socket: {
				data(socket, data) {
					socket.data.buffer += Buffer.from(data).toString("utf8");
					while (socket.data.buffer.includes("\n")) {
						const newline = socket.data.buffer.indexOf("\n");
						const line = socket.data.buffer.slice(0, newline);
						socket.data.buffer = socket.data.buffer.slice(newline + 1);
						frames.push(JSON.parse(line) as Record<string, unknown>);
						if (!socket.data.challenged) {
							socket.data.challenged = true;
							socket.write(
								`${JSON.stringify({
									v: 1,
									op: "challenge",
									serverNonce: "C".repeat(43),
									proof: "X".repeat(43),
								})}\n`,
							);
						}
					}
				},
				error() {},
			},
		});
		try {
			await prepareServerEndpoint(fixture.endpoint);
			const warning = Promise.withResolvers<string>();
			const publisher = new CollabRegistryPublisher({
				instanceId: record.instanceId,
				pid: record.pid,
				endpointSetting: fixture.endpoint,
				onSecurityError: warning.resolve,
			});
			publisher.publish(record);
			const message = await beforeTimeout(warning.promise, "publisher accepted an unauthenticated registry server");
			publisher.shutdown(record.generation);
			expect(message).toContain("server authentication failed");
			expect(frames).toHaveLength(1);
			expect(frames[0]?.op).toBe("hello");
			expect(frames[0]).not.toHaveProperty("token");
			const wire = JSON.stringify(frames);
			expect(wire).not.toContain("A".repeat(43));
			expect(wire).not.toContain(record.viewLink);
			expect(wire).not.toContain(record.controlLink);
			expect(wire).not.toContain('"authenticate"');
			expect(wire).not.toContain('"upsert"');
		} finally {
			server.stop(true);
			await cleanupPublisherFixture(fixture);
		}
	},
	PUBLISHER_TEST_TIMEOUT_MS,
);

test(
	"publisher authenticates the registry server before releasing capabilities",
	async () => {
		const fixture = await createPublisherFixture("mutual-auth");
		const token = "A".repeat(43);
		const frames: Array<Record<string, unknown>> = [];
		const upsertReceived = Promise.withResolvers<void>();
		let binding: AuthBinding | undefined;
		const server = Bun.listen<{ buffer: string }>({
			unix: fixture.endpoint,
			data: { buffer: "" },
			socket: {
				data(socket, data) {
					socket.data.buffer += Buffer.from(data).toString("utf8");
					while (socket.data.buffer.includes("\n")) {
						const newline = socket.data.buffer.indexOf("\n");
						const line = socket.data.buffer.slice(0, newline);
						socket.data.buffer = socket.data.buffer.slice(newline + 1);
						const frame = JSON.parse(line) as Record<string, unknown>;
						frames.push(frame);
						if (frames.length === 1) {
							binding = {
								clientNonce: String(frame.clientNonce),
								serverNonce: "C".repeat(43),
								instanceId: String(frame.instanceId),
								pid: Number(frame.pid),
							};
							socket.write(
								`${JSON.stringify({
									v: 1,
									op: "challenge",
									serverNonce: binding.serverNonce,
									proof: authProof(token, "omp-session-gateway.registry.server.v1", binding),
								})}\n`,
							);
						} else if (frames.length === 2) {
							socket.write(
								`${JSON.stringify({ v: 1, op: "hello_ok", heartbeatSeconds: 10, ttlSeconds: 35 })}\n`,
							);
						} else if (frame.op === "upsert") {
							upsertReceived.resolve();
						}
					}
				},
				error() {},
			},
		});
		try {
			await prepareServerEndpoint(fixture.endpoint);
			const warnings: string[] = [];
			const publisher = new CollabRegistryPublisher({
				instanceId: record.instanceId,
				pid: record.pid,
				endpointSetting: fixture.endpoint,
				onSecurityError: message => warnings.push(message),
			});
			publisher.publish(record);
			await beforeTimeout(upsertReceived.promise, "publisher did not complete mutual authentication");
			expect(warnings).toEqual([]);
			expect(binding).toBeDefined();
			expect(frames[0]?.op).toBe("hello");
			expect(frames[0]).not.toHaveProperty("token");
			expect(frames[1]).toEqual({
				v: 1,
				op: "authenticate",
				proof: authProof(token, "omp-session-gateway.registry.client.v1", binding as AuthBinding),
			});
			expect(frames[2]?.op).toBe("upsert");
			expect(frames[2]).toHaveProperty("session.viewLink", record.viewLink);
			expect(JSON.stringify(frames)).not.toContain(token);
			publisher.shutdown(record.generation);
		} finally {
			server.stop(true);
			await cleanupPublisherFixture(fixture);
		}
	},
	PUBLISHER_TEST_TIMEOUT_MS,
);

test(
	"publisher token path override preserves the ambient XDG configuration",
	async () => {
		const fixture = await createPublisherFixture("explicit-token-path");
		const token = "A".repeat(43);
		const explicitTokenPath = join(fixture.root, "publisher-token");
		await writeFile(explicitTokenPath, `${token}\n`, { mode: 0o600 });
		await secureWindowsPublisherToken(explicitTokenPath);
		await writeFile(fixture.tokenPath, `${"B".repeat(43)}\n`, { mode: 0o600 });
		const server = startAuthenticatedRegistryServer(fixture.endpoint, token, "C".repeat(43));
		await prepareServerEndpoint(fixture.endpoint);
		const subprocess = Bun.spawn(
			[process.execPath, join(import.meta.dir, "registry-publisher-explicit-token.fixture.ts")],
			{
				env: {
					...process.env,
					OMP_GATEWAY_PUBLISHER_TOKEN_PATH: explicitTokenPath,
					OMP_GATEWAY_TEST_ENDPOINT: fixture.endpoint,
				},
				stdin: "ignore",
				stdout: "ignore",
				stderr: "pipe",
			},
		);
		try {
			await beforeTimeout(server.upsertReceived, "publisher ignored the explicit token path");
			expect(server.frames.at(-1)?.op).toBe("upsert");
		} finally {
			subprocess.kill();
			await subprocess.exited;
			server.server.stop(true);
			await cleanupPublisherFixture(fixture);
		}
	},
	PUBLISHER_TEST_TIMEOUT_MS,
);

test(
	"publisher reconnects after registry restart and rereads the rotated token",
	async () => {
		const fixture = await createPublisherFixture("restart-token");
		const initialToken = "A".repeat(43);
		const rotatedToken = "B".repeat(43);
		const first = startAuthenticatedRegistryServer(fixture.endpoint, initialToken, "C".repeat(43));
		let firstStopped = false;
		let second: AuthenticatedRegistryServer | undefined;
		const warnings: string[] = [];
		const publisher = new CollabRegistryPublisher({
			instanceId: record.instanceId,
			pid: record.pid,
			endpointSetting: fixture.endpoint,
			onSecurityError: message => warnings.push(message),
		});
		const reconnectScheduled = Promise.withResolvers<() => void>();
		try {
			await prepareServerEndpoint(fixture.endpoint);
			publisher.publish(record);
			await first.upsertReceived;
			const firstBinding = first.binding();
			expect(firstBinding).toBeDefined();
			expect(first.frames[1]).toHaveProperty(
				"proof",
				authProof(initialToken, "omp-session-gateway.registry.client.v1", firstBinding as AuthBinding),
			);
			expect(first.frames[2]).toHaveProperty("session.viewLink", record.viewLink);
			expect(await first.nextUpsert()).toHaveProperty("session.inputRequired", false);
			publisher.publish({ ...record, inputRequired: true });
			expect(await first.nextUpsert()).toHaveProperty("session.inputRequired", true);

			const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
				callback: (...callbackArguments: unknown[]) => void,
				_delay?: number,
				...callbackArguments: unknown[]
			) => {
				reconnectScheduled.resolve(() => callback(...callbackArguments));
				return undefined as never;
			}) as unknown as typeof setTimeout);
			first.disconnect();
			const reconnect = await reconnectScheduled.promise;
			first.server.stop(true);
			firstStopped = true;
			timeoutSpy.mockRestore();

			if (process.platform !== "win32") await rm(fixture.endpoint, { force: true });
			await writeFile(fixture.tokenPath, `${rotatedToken}\n`, { mode: 0o600 });
			await secureWindowsPublisherToken(fixture.tokenPath);
			second = startAuthenticatedRegistryServer(fixture.endpoint, rotatedToken, "D".repeat(43));
			await prepareServerEndpoint(fixture.endpoint);

			reconnect();
			await second.upsertReceived;
			const secondBinding = second.binding();
			expect(secondBinding).toBeDefined();
			expect(secondBinding?.clientNonce).not.toBe(firstBinding?.clientNonce);
			expect(second.frames[0]?.op).toBe("hello");
			expect(second.frames[1]).toHaveProperty(
				"proof",
				authProof(rotatedToken, "omp-session-gateway.registry.client.v1", secondBinding as AuthBinding),
			);
			expect(second.frames[2]).toHaveProperty("session.viewLink", record.viewLink);
			expect(second.frames[2]).toHaveProperty("session.inputRequired", true);
			expect(warnings).toEqual([]);
			const wire = JSON.stringify([...first.frames, ...second.frames]);
			expect(wire).not.toContain(initialToken);
			expect(wire).not.toContain(rotatedToken);
		} finally {
			publisher.shutdown(record.generation);
			if (!firstStopped) first.server.stop(true);
			second?.server.stop(true);
			vi.restoreAllMocks();
			await cleanupPublisherFixture(fixture);
		}
	},
	PUBLISHER_TEST_TIMEOUT_MS,
);

test("invalid publisher configuration fails safely without exposing capabilities", async () => {
	const warning = Promise.withResolvers<string>();
	const publisher = new CollabRegistryPublisher({
		instanceId: record.instanceId,
		pid: process.pid,
		endpointSetting: "https://gateway.example.invalid",
		onSecurityError: warning.resolve,
	});
	publisher.publish(record);
	const message = await warning.promise;
	publisher.shutdown(record.generation);
	expect(message).toContain("local IPC");
	expect(message).not.toContain(record.viewLink);
	expect(message).not.toContain(record.controlLink);
});

test("publisher rejects an untrusted local endpoint before sending capabilities", async () => {
	if (process.platform === "win32") return;
	const root = await mkdtemp(join(tmpdir(), "registry-publisher-endpoint-"));
	const previousRoot = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = root;
	try {
		const configDir = join(root, "omp-session-gateway");
		const endpoint = join(root, "not-a-socket");
		await mkdir(configDir, { mode: 0o700 });
		await writeFile(join(configDir, "publisher-token"), `${"A".repeat(43)}\n`, { mode: 0o600 });
		await writeFile(endpoint, "", { mode: 0o600 });
		const warning = Promise.withResolvers<string>();
		const publisher = new CollabRegistryPublisher({
			instanceId: record.instanceId,
			pid: process.pid,
			endpointSetting: endpoint,
			onSecurityError: warning.resolve,
		});
		publisher.publish(record);
		const message = await warning.promise;
		publisher.shutdown(record.generation);
		expect(message).toContain("unsafe");
		expect(message).not.toContain(record.viewLink);
	} finally {
		if (previousRoot === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = previousRoot;
		await rm(root, { recursive: true, force: true });
	}
});

test("shutdown closes a pending handshake before capabilities are sent", async () => {
	if (process.platform === "win32") return;
	const root = await mkdtemp(join(tmpdir(), "registry-publisher-handshake-"));
	const previousRoot = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = root;
	const endpoint = join(root, "registry.sock");
	const accepted = Promise.withResolvers<void>();
	const closed = Promise.withResolvers<void>();
	let received = "";
	const server = Bun.listen({
		unix: endpoint,
		socket: {
			open() {
				accepted.resolve();
			},
			data(_socket, data) {
				received += Buffer.from(data).toString("utf8");
			},
			close() {
				closed.resolve();
			},
			error() {},
		},
	});
	try {
		await chmod(endpoint, 0o600);
		const configDir = join(root, "omp-session-gateway");
		await mkdir(configDir, { mode: 0o700 });
		await writeFile(join(configDir, "publisher-token"), `${"A".repeat(43)}\n`, { mode: 0o600 });
		const publisher = new CollabRegistryPublisher({
			instanceId: record.instanceId,
			pid: process.pid,
			endpointSetting: endpoint,
			onSecurityError: message => {
				throw new Error(message);
			},
		});
		publisher.publish(record);
		await accepted.promise;
		publisher.shutdown(record.generation);
		await Promise.race([
			closed.promise,
			Bun.sleep(1_000).then(() => {
				throw new Error("pending publisher handshake did not close");
			}),
		]);
		expect(received).not.toContain(record.viewLink);
		expect(received).not.toContain(record.controlLink);
		expect(received).not.toContain("A".repeat(43));
	} finally {
		server.stop(true);
		if (previousRoot === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = previousRoot;
		await rm(root, { recursive: true, force: true });
	}
});

test("oversized publisher tokens fail closed before they are read", async () => {
	if (process.platform === "win32") return;
	const root = await mkdtemp(join(tmpdir(), "registry-publisher-token-"));
	const environmentKey = "XDG_CONFIG_HOME";
	const previousRoot = process.env[environmentKey];
	process.env[environmentKey] = root;
	const configDir = join(root, "omp-session-gateway");
	try {
		await mkdir(configDir, { recursive: true, mode: 0o700 });
		await writeFile(join(configDir, "publisher-token"), "A".repeat(46), { mode: 0o600 });
		const warning = Promise.withResolvers<string>();
		const publisher = new CollabRegistryPublisher({
			instanceId: record.instanceId,
			pid: process.pid,
			endpointSetting: "auto",
			onSecurityError: warning.resolve,
		});
		publisher.publish(record);
		const message = await warning.promise;
		publisher.shutdown(record.generation);
		expect(message).toContain("invalid");
		expect(message).not.toContain(record.viewLink);
	} finally {
		if (previousRoot === undefined) delete process.env[environmentKey];
		else process.env[environmentKey] = previousRoot;
		await rm(root, { recursive: true, force: true });
	}
});

test("disabled publication is a no-op", () => {
	const publisher = new CollabRegistryPublisher({
		instanceId: record.instanceId,
		pid: process.pid,
		endpointSetting: "off",
		onSecurityError: () => {
			throw new Error("off must not report an error");
		},
	});
	publisher.publish(record);
	publisher.shutdown(record.generation);
});

test(
	"a transient publisher token failure retries instead of latching off",
	async () => {
		if (process.platform === "win32") return;
		const fixture = await createPublisherFixture("transient-token");
		const token = "A".repeat(43);
		const server = startAuthenticatedRegistryServer(fixture.endpoint, token, "C".repeat(43));
		const warnings: string[] = [];
		const publisher = new CollabRegistryPublisher({
			instanceId: record.instanceId,
			pid: record.pid,
			endpointSetting: fixture.endpoint,
			onSecurityError: message => warnings.push(message),
		});
		const reconnectScheduled = Promise.withResolvers<() => void>();
		const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
			callback: (...callbackArguments: unknown[]) => void,
			_delay?: number,
			...callbackArguments: unknown[]
		) => {
			reconnectScheduled.resolve(() => callback(...callbackArguments));
			return undefined as never;
		}) as unknown as typeof setTimeout);
		try {
			await prepareServerEndpoint(fixture.endpoint);
			// A token file caught mid-rewrite: the byte length is briefly wrong. The
			// gateway is healthy, so this must not mute the session permanently.
			await writeFile(fixture.tokenPath, "A".repeat(46), { mode: 0o600 });
			publisher.publish(record);
			const reconnect = await beforeTimeout(reconnectScheduled.promise, "publisher did not schedule a retry");
			timeoutSpy.mockRestore();
			expect(warnings).toEqual(["invalid OMP Session Gateway publisher token"]);
			expect(publisher.publicationState()).toEqual({
				kind: "retrying",
				attempt: 1,
				reason: "invalid OMP Session Gateway publisher token",
			});

			await writeFile(fixture.tokenPath, `${token}\n`, { mode: 0o600 });
			reconnect();
			await beforeTimeout(server.upsertReceived, "publisher never recovered after the token became readable");
			expect(server.frames.at(-1)).toHaveProperty("session.viewLink", record.viewLink);
			expect(publisher.publicationState()).toEqual({ kind: "publishing" });
			expect(warnings).toEqual(["invalid OMP Session Gateway publisher token"]);
		} finally {
			vi.restoreAllMocks();
			publisher.shutdown(record.generation);
			server.server.stop(true);
			await cleanupPublisherFixture(fixture);
		}
	},
	PUBLISHER_TEST_TIMEOUT_MS,
);

test(
	"a genuine endpoint violation latches publication until an explicit resume",
	async () => {
		if (process.platform === "win32") return;
		const fixture = await createPublisherFixture("latched-endpoint");
		const token = "A".repeat(43);
		const server = startAuthenticatedRegistryServer(fixture.endpoint, token, "C".repeat(43));
		const warnings: string[] = [];
		const violation = Promise.withResolvers<string>();
		const publisher = new CollabRegistryPublisher({
			instanceId: record.instanceId,
			pid: record.pid,
			endpointSetting: fixture.endpoint,
			onSecurityError: message => {
				warnings.push(message);
				violation.resolve(message);
			},
		});
		try {
			// A world-readable socket is a real privacy violation: no retry can fix it.
			await chmod(fixture.endpoint, 0o666);
			publisher.publish(record);
			expect(await beforeTimeout(violation.promise, "publisher accepted a world-readable endpoint")).toBe(
				"unsafe OMP Session Gateway registry endpoint",
			);
			expect(publisher.publicationState()).toEqual({
				kind: "disabled",
				reason: "unsafe OMP Session Gateway registry endpoint",
			});

			// Latched means latched: the connect guard rejects a further publish
			// synchronously, so nothing can reach the endpoint.
			publisher.publish({ ...record, inputRequired: true });
			expect(publisher.publicationState().kind).toBe("disabled");
			expect(server.frames).toEqual([]);

			// An explicit /collab is unambiguous intent and re-arms publication.
			await prepareServerEndpoint(fixture.endpoint);
			publisher.resume();
			await beforeTimeout(server.upsertReceived, "an explicit resume did not restore publication");
			expect(publisher.publicationState()).toEqual({ kind: "publishing" });
			// One handshake only — the frame log proves the latched publish never
			// opened a connection, without waiting on a clock to say so.
			expect(server.frames[0]?.op).toBe("hello");
			expect(server.frames.at(-1)).toHaveProperty("session.inputRequired", true);
			expect(warnings).toEqual(["unsafe OMP Session Gateway registry endpoint"]);
			expect(JSON.stringify(server.frames)).not.toContain(token);
		} finally {
			publisher.shutdown(record.generation);
			server.server.stop(true);
			await cleanupPublisherFixture(fixture);
		}
	},
	PUBLISHER_TEST_TIMEOUT_MS,
);
