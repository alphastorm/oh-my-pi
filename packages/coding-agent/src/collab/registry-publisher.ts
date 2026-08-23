import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const PROTOCOL_VERSION = 1;
const MAX_SERVER_FRAME_BYTES = 4 * 1024;
const AUTH_VALUE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const WINDOWS_PIPE_NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;
const SERVER_AUTH_DOMAIN = "omp-session-gateway.registry.server.v1";
const CLIENT_AUTH_DOMAIN = "omp-session-gateway.registry.client.v1";
const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";

export type PublishedCapabilityMode = "off" | "view" | "control";

/**
 * Observable publication state. A publisher that has stopped announcing itself
 * must be diagnosable from `/collab status` rather than from a warning that has
 * long since scrolled away.
 */
export type CollabPublicationState =
	| { readonly kind: "off" }
	| { readonly kind: "publishing" }
	| { readonly kind: "retrying"; readonly attempt: number; readonly reason: string }
	| { readonly kind: "disabled"; readonly reason: string };

/**
 * A local-configuration violation: the endpoint setting is not local IPC, or the
 * socket is observable by another user. Both are deterministic properties of this
 * machine, so no retry can clear them and publication latches off.
 *
 * Every other setup failure stays on the retry path — a registry that is not
 * running yet, a token file torn by an in-flight rewrite, EACCES/EMFILE/EINTR
 * while the runtime directory is recreated. Failing open on those is safe because
 * the handshake still has to authenticate against the real token, and latching on
 * them silently drops a live session out of the directory for the rest of the
 * process lifetime.
 */
class PublisherSecurityViolation extends Error {}

export interface CollabPublisherRecord {
	readonly instanceId: string;
	readonly generation: number;
	readonly pid: number;
	readonly sessionId: string;
	readonly title?: string;
	readonly cwdLabel?: string;
	readonly model?: string;
	readonly startedAt: string;
	readonly inputRequired: boolean;
	readonly viewLink: string;
	readonly controlLink?: string;
}

interface PublisherSocketState {
	buffer: string;
	readonly clientNonce: string;
	readonly token: Buffer;
	phase: "challenge" | "hello_ok";
}

interface RegistryAuthBinding {
	readonly clientNonce: string;
	readonly serverNonce: string;
	readonly instanceId: string;
	readonly pid: number;
}

interface ChallengeFrame {
	readonly serverNonce: string;
	readonly proof: string;
}

interface HelloOkFrame {
	readonly heartbeatSeconds: number;
}

function createAuthNonce(): string {
	return randomBytes(32).toString("base64url");
}

function createAuthProof(token: Buffer, domain: string, binding: RegistryAuthBinding): string {
	const digest = createHmac("sha256", token)
		.update(
			`${domain}\n${binding.clientNonce}\n${binding.serverNonce}\n${binding.instanceId}\n${binding.pid}`,
			"utf8",
		)
		.digest();
	try {
		return digest.toString("base64url");
	} finally {
		digest.fill(0);
	}
}

function authProofMatches(expected: string, actual: string): boolean {
	if (!AUTH_VALUE_PATTERN.test(expected) || !AUTH_VALUE_PATTERN.test(actual)) return false;
	const expectedBytes = Buffer.from(expected, "ascii");
	const actualBytes = Buffer.from(actual, "ascii");
	try {
		return timingSafeEqual(expectedBytes, actualBytes);
	} finally {
		expectedBytes.fill(0);
		actualBytes.fill(0);
	}
}

function countTopLevelObjectMembers(text: string): number {
	let depth = 0;
	let inString = false;
	let escaped = false;
	let members = 0;
	for (const character of text) {
		if (inString) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') inString = false;
			continue;
		}
		if (character === '"') inString = true;
		else if (character === "{") {
			depth += 1;
			if (depth > 1) return -1;
		} else if (character === "}") depth -= 1;
		else if (character === "[" || character === "]") return -1;
		else if (character === ":" && depth === 1) members += 1;
		if (depth < 0) return -1;
	}
	return depth === 0 && !inString && !escaped ? members : -1;
}

function parseRecord(line: string): Record<string, unknown> {
	if (line.includes("\0")) throw new Error("invalid OMP Session Gateway handshake");
	const value: unknown = JSON.parse(line);
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		countTopLevelObjectMembers(line) !== Object.keys(value).length
	) {
		throw new Error("invalid OMP Session Gateway handshake");
	}
	return value as Record<string, unknown>;
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(record);
	return actual.length === keys.length && keys.every(key => Object.hasOwn(record, key));
}

function parseChallenge(line: string): ChallengeFrame {
	const record = parseRecord(line);
	if (
		!hasExactKeys(record, ["v", "op", "serverNonce", "proof"]) ||
		record.v !== PROTOCOL_VERSION ||
		record.op !== "challenge" ||
		typeof record.serverNonce !== "string" ||
		!AUTH_VALUE_PATTERN.test(record.serverNonce) ||
		typeof record.proof !== "string" ||
		!AUTH_VALUE_PATTERN.test(record.proof)
	) {
		throw new Error("invalid OMP Session Gateway challenge");
	}
	return { serverNonce: record.serverNonce, proof: record.proof };
}

function parseHelloOk(line: string): HelloOkFrame {
	const record = parseRecord(line);
	if (
		!hasExactKeys(record, ["v", "op", "heartbeatSeconds", "ttlSeconds"]) ||
		record.v !== PROTOCOL_VERSION ||
		record.op !== "hello_ok" ||
		typeof record.heartbeatSeconds !== "number" ||
		!Number.isInteger(record.heartbeatSeconds) ||
		record.heartbeatSeconds < 2 ||
		record.heartbeatSeconds > 60 ||
		typeof record.ttlSeconds !== "number" ||
		!Number.isInteger(record.ttlSeconds) ||
		record.ttlSeconds <= record.heartbeatSeconds * 2 ||
		record.ttlSeconds > 300
	) {
		throw new Error("invalid OMP Session Gateway authentication response");
	}
	return { heartbeatSeconds: record.heartbeatSeconds };
}

function configDirectory(): string {
	if (process.platform === "win32") {
		return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "OMP Session Gateway");
	}
	return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "omp-session-gateway");
}

function publisherTokenPath(): string {
	const configured = process.env.OMP_GATEWAY_PUBLISHER_TOKEN_PATH;
	if (configured === undefined) return join(configDirectory(), "publisher-token");
	if (!isAbsolute(configured)) {
		throw new Error("OMP_GATEWAY_PUBLISHER_TOKEN_PATH must be an absolute local file path");
	}
	return configured;
}

function automaticEndpoint(): string {
	if (process.platform === "win32") {
		const identity =
			`${process.env.USERDOMAIN ?? process.env.COMPUTERNAME ?? "local"}\\${process.env.USERNAME ?? "user"}`.toLowerCase();
		const suffix = createHash("sha256").update(identity).digest("hex").slice(0, 20);
		return `${WINDOWS_PIPE_PREFIX}omp-session-gateway-${suffix}`;
	}
	if (process.platform === "linux" && process.env.XDG_RUNTIME_DIR) {
		return join(process.env.XDG_RUNTIME_DIR, "omp-session-gateway", "registry.sock");
	}
	if (process.platform === "darwin") {
		return join(
			process.env.TMPDIR ?? tmpdir(),
			`omp-session-gateway-${process.getuid?.() ?? "user"}`,
			"registry.sock",
		);
	}
	return join(
		process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
		"omp-session-gateway",
		"run",
		"registry.sock",
	);
}

export function resolveCollabRegistryEndpoint(setting: string): string | undefined {
	if (setting === "off") return undefined;
	if (setting === "auto") return automaticEndpoint();
	if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(setting)) {
		throw new PublisherSecurityViolation("collab.registryEndpoint must be local IPC, not a network URL");
	}
	if (process.platform === "win32") {
		const name = setting.startsWith(WINDOWS_PIPE_PREFIX) ? setting.slice(WINDOWS_PIPE_PREFIX.length) : "";
		if (!WINDOWS_PIPE_NAME_PATTERN.test(name)) {
			throw new PublisherSecurityViolation("collab.registryEndpoint must be a local Windows named pipe");
		}
		return setting;
	}
	if (!isAbsolute(setting)) {
		throw new PublisherSecurityViolation("collab.registryEndpoint must be an absolute local socket path");
	}
	return setting;
}

async function assertPublisherEndpointPrivate(endpoint: string): Promise<void> {
	if (process.platform === "win32") return;
	const uid = process.getuid?.();
	const [endpointInfo, parentInfo] = await Promise.all([lstat(endpoint), lstat(dirname(endpoint))]);
	if (
		uid === undefined ||
		!endpointInfo.isSocket() ||
		endpointInfo.isSymbolicLink() ||
		endpointInfo.uid !== uid ||
		(endpointInfo.mode & 0o077) !== 0 ||
		!parentInfo.isDirectory() ||
		parentInfo.isSymbolicLink() ||
		parentInfo.uid !== uid ||
		(parentInfo.mode & 0o077) !== 0
	) {
		throw new PublisherSecurityViolation("unsafe OMP Session Gateway registry endpoint");
	}
}

function windowsPowerShellEnvironment(overrides: Record<string, string>): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && key.toLowerCase() !== "psmodulepath") environment[key] = value;
	}
	return { ...environment, ...overrides };
}

async function assertWindowsPublisherTokenPrivate(path: string): Promise<void> {
	if (process.platform !== "win32") return;
	const script =
		"$Path=$env:OMP_GATEWAY_ACL_PATH; $acl=Get-Acl -LiteralPath $Path; " +
		"$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; " +
		"$owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; " +
		"$descriptor=[System.Security.AccessControl.RawSecurityDescriptor]::new($acl.Sddl); " +
		"$rules=@($descriptor.DiscretionaryAcl | ForEach-Object { [pscustomobject]@{ " +
		"Sid=$_.SecurityIdentifier.Value; Type=$_.AceType.ToString(); Mask=$_.AccessMask; Flags=[int]$_.AceFlags } }); " +
		"[pscustomobject]@{ Protected=$acl.AreAccessRulesProtected; Current=$sid; Owner=$owner; Rules=@($rules) } " +
		"| ConvertTo-Json -Compress -Depth 3";
	const subprocess = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], {
		env: windowsPowerShellEnvironment({ OMP_GATEWAY_ACL_PATH: path }),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "ignore",
	});
	const text = await new Response(subprocess.stdout).text();
	if ((await subprocess.exited) !== 0) throw new Error("failed to inspect OMP Session Gateway publisher token ACL");
	const value: unknown = JSON.parse(text);
	const protectedAcl = typeof value === "object" && value !== null ? Reflect.get(value, "Protected") : undefined;
	const current = typeof value === "object" && value !== null ? Reflect.get(value, "Current") : undefined;
	const owner = typeof value === "object" && value !== null ? Reflect.get(value, "Owner") : undefined;
	const rules = typeof value === "object" && value !== null ? Reflect.get(value, "Rules") : undefined;
	let currentSeen = false;
	let systemSeen = false;
	let rulesValid = Array.isArray(rules) && rules.length === 2;
	if (rulesValid && Array.isArray(rules)) {
		for (const rule of rules) {
			if (typeof rule !== "object" || rule === null) {
				rulesValid = false;
				break;
			}
			const sid = Reflect.get(rule, "Sid");
			if (sid === current && !currentSeen) currentSeen = true;
			else if (sid === "S-1-5-18" && !systemSeen) systemSeen = true;
			else rulesValid = false;
			if (
				Reflect.get(rule, "Type") !== "AccessAllowed" ||
				Reflect.get(rule, "Mask") !== 2_032_127 ||
				Reflect.get(rule, "Flags") !== 0
			) {
				rulesValid = false;
			}
		}
	}
	if (
		protectedAcl !== true ||
		typeof current !== "string" ||
		current === "S-1-5-18" ||
		owner !== current ||
		!rulesValid ||
		!currentSeen ||
		!systemSeen
	) {
		throw new Error("unsafe OMP Session Gateway publisher token ACL");
	}
}

function isPublisherTokenByte(value: number | undefined): boolean {
	if (value === undefined) return false;
	return (
		(value >= 0x41 && value <= 0x5a) ||
		(value >= 0x61 && value <= 0x7a) ||
		(value >= 0x30 && value <= 0x39) ||
		value === 0x2d ||
		value === 0x5f
	);
}

async function readPublisherToken(): Promise<Buffer> {
	const tokenPath = publisherTokenPath();
	const info = await lstat(tokenPath);
	if (!info.isFile() || info.isSymbolicLink()) throw new Error("unsafe OMP Session Gateway publisher token file");
	if (info.size < 43 || info.size > 45) throw new Error("invalid OMP Session Gateway publisher token");
	if (process.platform === "win32") {
		await assertWindowsPublisherTokenPrivate(tokenPath);
	} else {
		const uid = process.getuid?.();
		if (uid === undefined || info.uid !== uid || (info.mode & 0o077) !== 0) {
			throw new Error("unsafe OMP Session Gateway publisher token permissions");
		}
	}
	const fileBytes = await readFile(tokenPath);
	try {
		let tokenLength = fileBytes.byteLength;
		while (tokenLength > 0 && (fileBytes[tokenLength - 1] === 0x0a || fileBytes[tokenLength - 1] === 0x0d)) {
			tokenLength -= 1;
		}
		if (tokenLength !== 43) throw new Error("invalid OMP Session Gateway publisher token");
		for (let index = 0; index < tokenLength; index += 1) {
			if (!isPublisherTokenByte(fileBytes[index])) throw new Error("invalid OMP Session Gateway publisher token");
		}
		return Buffer.from(fileBytes.subarray(0, tokenLength));
	} finally {
		fileBytes.fill(0);
	}
}

export class CollabRegistryPublisher {
	readonly #instanceId: string;
	readonly #pid: number;
	readonly #endpointSetting: string;
	readonly #onSecurityError: (message: string) => void;
	#current: CollabPublisherRecord | undefined;
	#socket: Bun.Socket<PublisherSocketState> | undefined;
	#pendingSocket: Bun.Socket<PublisherSocketState> | undefined;
	#handshakeTimer: Timer | undefined;
	#heartbeatTimer: Timer | undefined;
	#reconnectTimer: Timer | undefined;
	#connecting = false;
	#stopping = false;
	#disabledReason: string | undefined;
	#retryReason: string | undefined;
	#concernReported = false;
	#attempt = 0;

	constructor(options: {
		instanceId: string;
		pid: number;
		endpointSetting: string;
		onSecurityError(message: string): void;
	}) {
		this.#instanceId = options.instanceId;
		this.#pid = options.pid;
		this.#endpointSetting = options.endpointSetting;
		this.#onSecurityError = options.onSecurityError;
	}

	publish(record: CollabPublisherRecord): void {
		this.#current = record;
		this.#stopping = false;
		if (this.#socket) this.#sendUpsert(this.#socket, record);
		else void this.#connect();
	}

	remove(generation: number, reason: "stopped" | "shutdown" | "session_changed" | "faulted"): void {
		const current = this.#current;
		if (!current || current.generation !== generation) return;
		if (this.#socket) {
			this.#socket.write(
				`${JSON.stringify({ v: PROTOCOL_VERSION, op: "remove", instanceId: this.#instanceId, generation, reason })}\n`,
			);
		}
		this.#current = undefined;
		clearInterval(this.#heartbeatTimer);
		this.#heartbeatTimer = undefined;
	}

	shutdown(generation: number | undefined): void {
		this.#stopping = true;
		if (generation !== undefined) this.remove(generation, "shutdown");
		clearTimeout(this.#reconnectTimer);
		clearInterval(this.#heartbeatTimer);
		this.#reconnectTimer = undefined;
		this.#heartbeatTimer = undefined;
		clearTimeout(this.#handshakeTimer);
		this.#handshakeTimer = undefined;
		this.#pendingSocket?.data.token.fill(0);
		this.#pendingSocket?.end();
		this.#pendingSocket = undefined;
		this.#socket?.end();
		this.#socket = undefined;
		this.#current = undefined;
	}

	/** Publication state for `/collab status`; a latched publisher reports why. */
	publicationState(): CollabPublicationState {
		const disabled = this.#disabledReason;
		if (disabled !== undefined) return { kind: "disabled", reason: disabled };
		if (this.#socket) return { kind: "publishing" };
		if (!this.#current) return { kind: "off" };
		return { kind: "retrying", attempt: this.#attempt, reason: this.#retryReason ?? "connecting" };
	}

	/**
	 * Clear a latched publisher and reconnect immediately. An explicit `/collab` is
	 * unambiguous user intent and the only recovery short of restarting OMP, so it
	 * also re-arms the one-shot warning: if the condition persists, say so again.
	 */
	resume(): void {
		this.#disabledReason = undefined;
		this.#retryReason = undefined;
		this.#concernReported = false;
		this.#attempt = 0;
		clearTimeout(this.#reconnectTimer);
		this.#reconnectTimer = undefined;
		if (this.#current && !this.#stopping) void this.#connect();
	}

	async #connect(): Promise<void> {
		if (this.#connecting || this.#socket || !this.#current || this.#stopping || this.#disabledReason !== undefined) {
			return;
		}
		this.#connecting = true;
		let endpoint: string;
		let token: Buffer | undefined;
		try {
			const resolved = resolveCollabRegistryEndpoint(this.#endpointSetting);
			if (resolved === undefined) {
				this.#connecting = false;
				return;
			}
			endpoint = resolved;
			token = await readPublisherToken();
			await assertPublisherEndpointPrivate(endpoint);
			if (this.#stopping || !this.#current) {
				token.fill(0);
				this.#connecting = false;
				return;
			}
		} catch (error) {
			token?.fill(0);
			this.#connecting = false;
			if (error instanceof PublisherSecurityViolation) this.#disableForSecurity(error);
			else this.#retryAfterFailure(error);
			return;
		}
		if (token === undefined) {
			this.#connecting = false;
			this.#disableForSecurity(new Error("OMP Session Gateway publisher token was unavailable"));
			return;
		}

		try {
			const owner = this;
			await Bun.connect<PublisherSocketState>({
				unix: endpoint,
				data: { buffer: "", clientNonce: createAuthNonce(), token, phase: "challenge" },
				socket: {
					open(socket) {
						owner.#pendingSocket = socket;
						if (owner.#stopping || !owner.#current) {
							socket.data.token.fill(0);
							socket.end();
							return;
						}
						socket.write(
							`${JSON.stringify({
								v: PROTOCOL_VERSION,
								op: "hello",
								clientNonce: socket.data.clientNonce,
								instanceId: owner.#instanceId,
								pid: owner.#pid,
							})}\n`,
						);
						owner.#handshakeTimer = setTimeout(() => {
							if (owner.#pendingSocket === socket) socket.end();
						}, 5_000);
					},
					data(socket, data) {
						if (owner.#stopping || owner.#pendingSocket !== socket) {
							socket.data.token.fill(0);
							socket.end();
							return;
						}
						socket.data.buffer += Buffer.from(data).toString("utf8");
						if (Buffer.byteLength(socket.data.buffer, "utf8") > MAX_SERVER_FRAME_BYTES) {
							socket.data.token.fill(0);
							owner.#disableForSecurity(new Error("oversized OMP Session Gateway handshake response"));
							socket.end();
							return;
						}
						while (socket.data.buffer.includes("\n")) {
							const newline = socket.data.buffer.indexOf("\n");
							const line = socket.data.buffer.slice(0, newline);
							socket.data.buffer = socket.data.buffer.slice(newline + 1);
							if (socket.data.phase === "challenge") {
								let clientProof: string;
								try {
									const challenge = parseChallenge(line);
									const binding: RegistryAuthBinding = {
										clientNonce: socket.data.clientNonce,
										serverNonce: challenge.serverNonce,
										instanceId: owner.#instanceId,
										pid: owner.#pid,
									};
									const expectedProof = createAuthProof(socket.data.token, SERVER_AUTH_DOMAIN, binding);
									if (!authProofMatches(expectedProof, challenge.proof)) {
										throw new Error("OMP Session Gateway registry server authentication failed");
									}
									clientProof = createAuthProof(socket.data.token, CLIENT_AUTH_DOMAIN, binding);
								} catch (error) {
									socket.data.token.fill(0);
									owner.#disableForSecurity(error);
									socket.end();
									return;
								}
								socket.data.token.fill(0);
								socket.write(
									`${JSON.stringify({ v: PROTOCOL_VERSION, op: "authenticate", proof: clientProof })}\n`,
								);
								socket.data.phase = "hello_ok";
								continue;
							}

							let response: HelloOkFrame;
							try {
								response = parseHelloOk(line);
								if (socket.data.buffer.length !== 0) {
									throw new Error("unexpected OMP Session Gateway authentication data");
								}
							} catch (error) {
								owner.#disableForSecurity(error);
								socket.end();
								return;
							}
							if (owner.#stopping || !owner.#current || owner.#pendingSocket !== socket) {
								socket.end();
								return;
							}
							clearTimeout(owner.#handshakeTimer);
							owner.#handshakeTimer = undefined;
							owner.#pendingSocket = undefined;
							owner.#connecting = false;
							owner.#socket = socket;
							owner.#attempt = 0;
							owner.#retryReason = undefined;
							socket.data.buffer = "";
							const current = owner.#current;
							if (current) owner.#sendUpsert(socket, current);
							owner.#startHeartbeat(response.heartbeatSeconds);
							return;
						}
					},
					close(socket) {
						socket.data.token.fill(0);
						socket.data.buffer = "";
						owner.#connecting = false;
						if (owner.#pendingSocket === socket) owner.#pendingSocket = undefined;
						clearTimeout(owner.#handshakeTimer);
						owner.#handshakeTimer = undefined;
						if (owner.#socket === socket) owner.#socket = undefined;
						clearInterval(owner.#heartbeatTimer);
						owner.#heartbeatTimer = undefined;
						owner.#retryReason = "connection closed";
						owner.#scheduleReconnect();
					},
					error() {},
				},
			});
			token = undefined;
		} catch {
			token?.fill(0);
			this.#connecting = false;
			this.#scheduleReconnect();
		}
	}

	#sendUpsert(socket: Bun.Socket<PublisherSocketState>, record: CollabPublisherRecord): void {
		socket.write(`${JSON.stringify({ v: PROTOCOL_VERSION, op: "upsert", session: record })}\n`);
	}

	#startHeartbeat(seconds: number): void {
		clearInterval(this.#heartbeatTimer);
		this.#heartbeatTimer = setInterval(() => {
			const current = this.#current;
			if (!current || !this.#socket) return;
			this.#socket.write(
				`${JSON.stringify({ v: PROTOCOL_VERSION, op: "heartbeat", instanceId: this.#instanceId, generation: current.generation })}\n`,
			);
		}, seconds * 1_000);
	}

	#scheduleReconnect(): void {
		if (this.#reconnectTimer || !this.#current || this.#stopping || this.#disabledReason !== undefined) return;
		const base = Math.min(30_000, 250 * 2 ** Math.min(this.#attempt, 7));
		const delay = Math.floor(base * (0.75 + Math.random() * 0.5));
		this.#attempt += 1;
		this.#reconnectTimer = setTimeout(() => {
			this.#reconnectTimer = undefined;
			void this.#connect();
		}, delay);
	}

	/**
	 * Transient setup failure: keep retrying, and say so once unless this is the
	 * routine "registry is not running" state. Reporting without latching is what
	 * keeps a token-file hiccup from muting a live session permanently.
	 */
	#retryAfterFailure(error: unknown): void {
		const code =
			typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
				? error.code
				: undefined;
		this.#retryReason = code ?? (error instanceof Error ? error.message : "unknown publication failure");
		if (code !== "ENOENT" && code !== "ECONNREFUSED") this.#reportConcern(error);
		this.#scheduleReconnect();
	}

	#disableForSecurity(error: unknown): void {
		const alreadyLatched = this.#disabledReason !== undefined;
		this.#disabledReason =
			error instanceof Error ? error.message : "unsafe OMP Session Gateway publisher configuration";
		// Latching is the severe state and always speaks once, even when a retryable
		// concern already consumed the warning slot.
		if (alreadyLatched) return;
		this.#concernReported = true;
		this.#onSecurityError(this.#disabledReason);
	}

	#reportConcern(error: unknown): void {
		if (this.#concernReported) return;
		this.#concernReported = true;
		this.#onSecurityError(
			error instanceof Error ? error.message : "unsafe OMP Session Gateway publisher configuration",
		);
	}
}
