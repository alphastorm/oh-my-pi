import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NInferCheckpointOperation } from "@oh-my-pi/pi-ai/providers/ninfer";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { type CompatibilityAuthority, loadCompatibilityAuthority } from "./compatibility-authority";
import type {
	ApplianceAction,
	ApplianceGpuSelector,
	ApplianceProfile,
	ApplianceProfileId,
	ApplianceReceipt,
} from "./types";

export const REMOTE_APPLIANCE_BUILD_ID = "sha256:daa63c6f2cdcd18c66079503e847e78551bce5ef2b3384ad462fb7340eb6ec1c";
export const REMOTE_APPLIANCE_AUTHORITY_LIMIT = 64 * 1024;
export const REMOTE_APPLIANCE_PAYLOAD_LIMIT = 16 * 1024;
export const REMOTE_APPLIANCE_RECEIPT_LIMIT = 256 * 1024;
const REMOTE_APPLIANCE_MANIFEST_LIMIT = 4 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_PAYLOAD = /^[A-Za-z0-9_-]+$/u;
const SESSION_SHA256 = /^[a-f0-9]{64}$/u;
const WSL_DISTRIBUTION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const ACTIONS = [
	"doctor",
	"plan",
	"install",
	"status",
	"benchmark",
	"checkpoint",
	"rollback",
	"support-bundle",
] as const satisfies readonly ApplianceAction[];
const RECEIPT_STATUSES = new Set<ApplianceReceipt["status"]>(["ok", "blocked", "failed", "rolled-back"]);
const FORBIDDEN_RECEIPT_KEYS = new Set([
	"apikey",
	"authorization",
	"bearer",
	"log",
	"logs",
	"modeloutput",
	"modelref",
	"outputtext",
	"path",
	"privatepath",
	"prompt",
	"rawlog",
	"rawlogs",
	"runtimeref",
	"secret",
	"secretref",
]);
const PRIVATE_PATH = /(?:\\\\|(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]|\/(?:Users|home|root|tmp|private|var\/folders)\/)/u;

type JsonRecord = Record<string, unknown>;

export interface RemoteApplianceInvocation {
	action: ApplianceAction;
	model?: "qwen3.8";
	gpu?: ApplianceGpuSelector;
	port?: number;
	quick?: true;
	checkpointOperation?: NInferCheckpointOperation;
	sessionSha256?: string;
}

export interface RemoteApplianceCompatibility {
	bytes: Uint8Array;
	sha256: string;
	transportProfile: "darwin-remote-ssh";
}

export interface DecodedRemoteApplianceRequest {
	invocation: RemoteApplianceInvocation;
	compatibility?: RemoteApplianceCompatibility;
	wslDistribution?: string;
}

export interface RemoteDelegatedLocalInvocation extends RemoteApplianceInvocation {
	authority?: CompatibilityAuthority;
	selectedProfile?: ApplianceProfile;
	transportProfile?: "darwin-remote-ssh";
	delegatedWslDistribution?: string;
}

export interface RemoteDelegationManifest {
	schemaVersion: 1;
	kind: "omp-appliance-delegation-manifest";
	version: string;
	buildIdentity: string;
	protocolVersion: 1;
}

export type RemoteDelegationFailureCode =
	| "REMOTE_BOOTSTRAP_CLEANUP_FAILED"
	| "REMOTE_COMPATIBILITY_HASH_MISMATCH"
	| "REMOTE_COMPATIBILITY_PROFILE_MISMATCH"
	| "REMOTE_DELEGATED_ACTION_FAILED"
	| "REMOTE_LOCAL_PROFILE_UNAVAILABLE"
	| "REMOTE_RECEIPT_PRIVACY_REJECTED"
	| "REMOTE_STAGING_FAILED"
	| "REMOTE_WSL_CONTEXT_MISMATCH";

export interface RemoteDelegationMetadata extends JsonRecord {
	schemaVersion: 1;
	version: string;
	buildIdentity: string;
	compatibilitySha256: string | null;
	transportProfile: "darwin-remote-ssh" | null;
	localProfile: ApplianceProfileId | null;
	cleanup: "ok" | "failed" | "not-created";
	effect: "none" | "confirmed" | "uncertain";
	failureCode?: RemoteDelegationFailureCode;
}

function record(value: unknown, label: string): JsonRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as JsonRecord;
}

function exactKeys(value: JsonRecord, required: readonly string[], optional: readonly string[], label: string): void {
	const allowed = new Set([...required, ...optional]);
	for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} contains an unknown field`);
	for (const key of required) if (!(key in value)) throw new Error(`${label} is missing ${key}`);
}

function safeString(value: unknown, label: string, maximum = 256): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maximum ||
		/[\u0000-\u001f\u007f]/u.test(value)
	) {
		throw new Error(`${label} is invalid`);
	}
	return value;
}

function action(value: unknown): ApplianceAction {
	const candidate = safeString(value, "Remote appliance action", 32) as ApplianceAction;
	if (!ACTIONS.includes(candidate)) throw new Error("Remote appliance action is unsupported");
	return candidate;
}

function port(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 65535) {
		throw new Error("Remote appliance port must be between 1 and 65535");
	}
	return value as number;
}

function wslDistribution(value: unknown): string {
	const distribution = safeString(value, "Remote WSL distribution", 64);
	if (!WSL_DISTRIBUTION.test(distribution)) throw new Error("Remote WSL distribution has invalid characters");
	return distribution;
}

function canonicalArgv(invocation: RemoteApplianceInvocation): string[] {
	switch (invocation.action) {
		case "doctor":
			return [
				"doctor",
				...(invocation.port === undefined ? [] : ["--port", String(port(invocation.port))]),
				"--json",
			];
		case "plan":
		case "install": {
			if (invocation.model !== "qwen3.8") throw new Error("Remote plan/install requires model qwen3.8");
			const gpu = invocation.gpu ?? "auto";
			if (!["auto", "rtx5090", "rtx4090"].includes(gpu)) throw new Error("Remote appliance GPU selector is invalid");
			return [
				invocation.action,
				"qwen3.8",
				"--gpu",
				gpu,
				...(invocation.port === undefined ? [] : ["--port", String(port(invocation.port))]),
				"--json",
			];
		}
		case "status":
		case "rollback":
		case "support-bundle":
			return [invocation.action, "--json"];
		case "benchmark":
			if (invocation.quick !== true) throw new Error("Remote benchmark requires --quick");
			return ["benchmark", "--quick", "--json"];
		case "checkpoint": {
			if (!["save", "status", "delete"].includes(invocation.checkpointOperation ?? "")) {
				throw new Error("Remote checkpoint operation is invalid");
			}
			if (!SESSION_SHA256.test(invocation.sessionSha256 ?? ""))
				throw new Error("Remote checkpoint session SHA-256 is invalid");
			return [
				"checkpoint",
				invocation.checkpointOperation!,
				"--session-sha256",
				invocation.sessionSha256!,
				"--json",
			];
		}
	}
}

function invocationFromArgv(value: unknown): RemoteApplianceInvocation {
	if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
		throw new Error("Remote appliance argv must be a string array");
	}
	const argv = value as string[];
	if (argv.some(item => item.length === 0 || item.length > 128 || /[\u0000-\u001f\u007f]/u.test(item))) {
		throw new Error("Remote appliance argv contains an invalid argument");
	}
	const selectedAction = action(argv[0]);
	let invocation: RemoteApplianceInvocation;
	switch (selectedAction) {
		case "doctor":
			if (argv.length === 2 && argv[1] === "--json") invocation = { action: selectedAction };
			else if (argv.length === 4 && argv[1] === "--port" && argv[3] === "--json") {
				invocation = { action: selectedAction, port: port(Number(argv[2])) };
			} else throw new Error("Remote doctor argv is not canonical");
			break;
		case "plan":
		case "install": {
			const hasPort = argv.length === 7;
			if (
				(argv.length !== 5 && !hasPort) ||
				argv[1] !== "qwen3.8" ||
				argv[2] !== "--gpu" ||
				!["auto", "rtx5090", "rtx4090"].includes(argv[3] ?? "") ||
				argv.at(-1) !== "--json" ||
				(hasPort && argv[4] !== "--port")
			) {
				throw new Error("Remote plan/install argv is not canonical");
			}
			invocation = {
				action: selectedAction,
				model: "qwen3.8",
				gpu: argv[3] as ApplianceGpuSelector,
				...(hasPort ? { port: port(Number(argv[5])) } : {}),
			};
			break;
		}
		case "status":
		case "rollback":
		case "support-bundle":
			if (argv.length !== 2 || argv[1] !== "--json") throw new Error("Remote appliance argv is not canonical");
			invocation = { action: selectedAction };
			break;
		case "benchmark":
			if (argv.length !== 3 || argv[1] !== "--quick" || argv[2] !== "--json") {
				throw new Error("Remote benchmark argv is not canonical");
			}
			invocation = { action: selectedAction, quick: true };
			break;
		case "checkpoint":
			if (
				argv.length !== 5 ||
				!["save", "status", "delete"].includes(argv[1] ?? "") ||
				argv[2] !== "--session-sha256" ||
				!SESSION_SHA256.test(argv[3] ?? "") ||
				argv[4] !== "--json"
			) {
				throw new Error("Remote checkpoint argv is not canonical");
			}
			invocation = {
				action: selectedAction,
				checkpointOperation: argv[1] as NInferCheckpointOperation,
				sessionSha256: argv[3],
			};
			break;
	}
	if (JSON.stringify(canonicalArgv(invocation)) !== JSON.stringify(argv)) {
		throw new Error("Remote appliance argv is not canonical");
	}
	return invocation;
}

function digest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function encodeRemoteApplianceRequest(
	invocation: RemoteApplianceInvocation,
	compatibility?: RemoteApplianceCompatibility,
	delegatedWslDistribution?: string,
): string {
	const request: JsonRecord = {
		schemaVersion: 1,
		kind: "omp-appliance-delegation-request",
		expectedVersion: VERSION,
		expectedBuildIdentity: REMOTE_APPLIANCE_BUILD_ID,
		argv: canonicalArgv(invocation),
	};
	if (compatibility) {
		if (!SHA256.test(compatibility.sha256)) throw new Error("Compatibility authority SHA-256 is invalid");
		if (compatibility.bytes.byteLength > REMOTE_APPLIANCE_AUTHORITY_LIMIT) {
			throw new Error("Compatibility authority exceeds the remote staging limit");
		}
		if (digest(compatibility.bytes) !== compatibility.sha256)
			throw new Error("Compatibility authority digest mismatch");
		request.compatibility = {
			sha256: compatibility.sha256,
			byteLength: compatibility.bytes.byteLength,
			transportProfile: compatibility.transportProfile,
		};
	} else if (invocation.action !== "doctor" && invocation.action !== "status") {
		throw new Error("Remote lifecycle actions require an exact compatibility authority");
	}
	if (delegatedWslDistribution !== undefined) {
		if (compatibility?.transportProfile !== "darwin-remote-ssh") {
			throw new Error("Remote WSL delegation requires darwin-remote-ssh compatibility authority");
		}
		request.wslDistribution = wslDistribution(delegatedWslDistribution);
	}
	const payload = Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
	if (Buffer.byteLength(payload, "ascii") > REMOTE_APPLIANCE_PAYLOAD_LIMIT) {
		throw new Error("Remote appliance request exceeds the payload limit");
	}
	return payload;
}

export function decodeRemoteApplianceRequest(
	payload: string,
	expectedAction?: ApplianceAction,
	authorityBytes: Uint8Array = new Uint8Array(),
): DecodedRemoteApplianceRequest {
	if (
		payload.length === 0 ||
		Buffer.byteLength(payload, "ascii") > REMOTE_APPLIANCE_PAYLOAD_LIMIT ||
		!SAFE_PAYLOAD.test(payload)
	) {
		throw new Error("Remote appliance request payload is invalid");
	}
	const decoded = Buffer.from(payload, "base64url");
	if (decoded.toString("base64url") !== payload) throw new Error("Remote appliance request payload is not canonical");
	const request = record(JSON.parse(decoded.toString("utf8")) as unknown, "Remote appliance request");
	exactKeys(
		request,
		["schemaVersion", "kind", "expectedVersion", "expectedBuildIdentity", "argv"],
		["compatibility", "wslDistribution"],
		"Remote appliance request",
	);
	if (
		request.schemaVersion !== 1 ||
		request.kind !== "omp-appliance-delegation-request" ||
		request.expectedVersion !== VERSION ||
		request.expectedBuildIdentity !== REMOTE_APPLIANCE_BUILD_ID
	) {
		throw new Error("Remote appliance request identity does not match this client");
	}
	const invocation = invocationFromArgv(request.argv);
	const delegatedWslDistribution =
		request.wslDistribution === undefined ? undefined : wslDistribution(request.wslDistribution);
	if (expectedAction !== undefined && invocation.action !== expectedAction) {
		throw new Error("Remote appliance request action does not match its command");
	}
	if (request.compatibility === undefined) {
		if (delegatedWslDistribution !== undefined) {
			throw new Error("Remote WSL delegation requires darwin-remote-ssh compatibility authority");
		}
		if (authorityBytes.byteLength !== 0)
			throw new Error("Profileless remote action received unexpected authority bytes");
		if (invocation.action !== "doctor" && invocation.action !== "status") {
			throw new Error("Remote lifecycle actions require an exact compatibility authority");
		}
		return { invocation };
	}
	const compatibility = record(request.compatibility, "Remote compatibility authority");
	exactKeys(compatibility, ["sha256", "byteLength", "transportProfile"], [], "Remote compatibility authority");
	const sha256 = safeString(compatibility.sha256, "Compatibility authority SHA-256", 64);
	if (!SHA256.test(sha256)) throw new Error("Compatibility authority SHA-256 is invalid");
	if (compatibility.transportProfile !== "darwin-remote-ssh") throw new Error("Remote transport profile is invalid");
	if (
		!Number.isSafeInteger(compatibility.byteLength) ||
		(compatibility.byteLength as number) < 1 ||
		(compatibility.byteLength as number) > REMOTE_APPLIANCE_AUTHORITY_LIMIT ||
		authorityBytes.byteLength !== compatibility.byteLength
	) {
		throw new Error("Compatibility authority byte length does not match the request");
	}
	const bytes = Buffer.from(authorityBytes);
	return {
		invocation,
		compatibility: { bytes, sha256, transportProfile: "darwin-remote-ssh" },
		...(delegatedWslDistribution === undefined ? {} : { wslDistribution: delegatedWslDistribution }),
	};
}

export function remoteDelegationManifest(): RemoteDelegationManifest {
	return {
		schemaVersion: 1,
		kind: "omp-appliance-delegation-manifest",
		version: VERSION,
		buildIdentity: REMOTE_APPLIANCE_BUILD_ID,
		protocolVersion: 1,
	};
}

export function parseRemoteDelegationManifest(text: string): RemoteDelegationManifest {
	if (Buffer.byteLength(text, "utf8") > REMOTE_APPLIANCE_MANIFEST_LIMIT) {
		throw new Error("Remote appliance identity manifest is oversized");
	}
	const value = record(JSON.parse(text.trim()) as unknown, "Remote appliance identity manifest");
	exactKeys(
		value,
		["schemaVersion", "kind", "version", "buildIdentity", "protocolVersion"],
		[],
		"Remote appliance identity manifest",
	);
	if (value.schemaVersion !== 1 || value.kind !== "omp-appliance-delegation-manifest" || value.protocolVersion !== 1) {
		throw new Error("Remote appliance identity manifest contract mismatch");
	}
	return {
		schemaVersion: 1,
		kind: "omp-appliance-delegation-manifest",
		version: safeString(value.version, "Remote OMP version", 64),
		buildIdentity: safeString(value.buildIdentity, "Remote OMP build identity", 80),
		protocolVersion: 1,
	};
}

function assertSafeJson(value: unknown, key = "details", depth = 0): void {
	if (depth > 16) throw new Error("Remote appliance receipt is too deeply nested");
	if (value === null || typeof value === "boolean") return;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("Remote appliance receipt contains a non-finite number");
		return;
	}
	if (typeof value === "string") {
		if (value.length > 16_384 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
			throw new Error("Remote appliance receipt contains unsafe text");
		}
		if (PRIVATE_PATH.test(value)) throw new Error("Remote appliance receipt contains a private path");
		return;
	}
	if (Array.isArray(value)) {
		if (value.length > 1024) throw new Error("Remote appliance receipt contains an oversized array");
		for (const item of value) assertSafeJson(item, key, depth + 1);
		return;
	}
	if (!value || typeof value !== "object") throw new Error("Remote appliance receipt contains a non-JSON value");
	const object = value as JsonRecord;
	if (Object.keys(object).length > 1024) throw new Error("Remote appliance receipt contains an oversized object");
	for (const [childKey, child] of Object.entries(object)) {
		const normalized = childKey.replaceAll(/[^a-z0-9]/giu, "").toLowerCase();
		if (FORBIDDEN_RECEIPT_KEYS.has(normalized)) throw new Error("Remote appliance receipt contains private material");
		assertSafeJson(child, childKey, depth + 1);
	}
}

export function assertTransportSafeReceipt(receipt: ApplianceReceipt, expectedAction = receipt.action): void {
	const serialized = JSON.stringify(receipt);
	const bytes = Buffer.byteLength(serialized, "utf8");
	if (bytes > REMOTE_APPLIANCE_RECEIPT_LIMIT) throw new Error("Remote appliance receipt is oversized");
	if (
		receipt.schemaVersion !== 1 ||
		receipt.action !== expectedAction ||
		!RECEIPT_STATUSES.has(receipt.status) ||
		typeof receipt.receiptId !== "string" ||
		receipt.receiptId.length === 0 ||
		receipt.receiptId.length > 256 ||
		/[\u0000-\u001f\u007f]/u.test(receipt.receiptId) ||
		typeof receipt.timestamp !== "string" ||
		!Number.isFinite(Date.parse(receipt.timestamp)) ||
		!receipt.details ||
		typeof receipt.details !== "object" ||
		Array.isArray(receipt.details)
	) {
		throw new Error("Remote appliance receipt contract mismatch");
	}
	const wireReceipt = JSON.parse(serialized) as ApplianceReceipt;
	assertSafeJson(wireReceipt.details);
}

export function parseRemoteApplianceReceipt(text: string, expectedAction: ApplianceAction): ApplianceReceipt {
	if (Buffer.byteLength(text, "utf8") > REMOTE_APPLIANCE_RECEIPT_LIMIT) {
		throw new Error("Remote appliance receipt is oversized");
	}
	let value: unknown;
	try {
		value = JSON.parse(text.trim());
	} catch {
		throw new Error("Remote appliance receipt JSON is malformed");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Remote appliance receipt is not an object");
	}
	const receipt = value as ApplianceReceipt;
	assertTransportSafeReceipt(receipt, expectedAction);
	return receipt;
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function profilesMatch(transport: ApplianceProfile, local: ApplianceProfile): boolean {
	return (
		transport.release === local.release &&
		transport.architecture === local.architecture &&
		transport.artifactSha256 === local.artifactSha256 &&
		transport.contextWindow === local.contextWindow &&
		transport.maxTokens === local.maxTokens &&
		transport.kvDtype === local.kvDtype &&
		transport.speculation === local.speculation &&
		transport.concurrency === local.concurrency &&
		transport.preserveThinking === local.preserveThinking &&
		transport.protocol === local.protocol &&
		transport.servedModel === local.servedModel &&
		transport.defaultPort === local.defaultPort &&
		transport.minVramGiB === local.minVramGiB &&
		transport.minimumDiskGiB === local.minimumDiskGiB &&
		stringArraysEqual(transport.capabilities, local.capabilities) &&
		stringArraysEqual(transport.aliases, local.aliases) &&
		transport.assets?.runtime.sha256 === local.assets?.runtime.sha256 &&
		transport.assets?.model.sha256 === local.assets?.model.sha256 &&
		transport.container?.imageDigest === local.container?.imageDigest &&
		transport.container?.serverBinarySha256 === local.container?.serverBinarySha256 &&
		transport.container?.configurationSha256 === local.container?.configurationSha256
	);
}

export function remoteActionMayPersist(action: ApplianceAction): boolean {
	return action !== "doctor" && action !== "plan" && action !== "status";
}

function metadata(
	request: DecodedRemoteApplianceRequest,
	localProfile: ApplianceProfileId | null,
	cleanup: RemoteDelegationMetadata["cleanup"],
	effect: RemoteDelegationMetadata["effect"],
	failureCode?: RemoteDelegationFailureCode,
): RemoteDelegationMetadata {
	return {
		schemaVersion: 1,
		version: VERSION,
		buildIdentity: REMOTE_APPLIANCE_BUILD_ID,
		compatibilitySha256: request.compatibility?.sha256 ?? null,
		transportProfile: request.compatibility?.transportProfile ?? null,
		localProfile,
		cleanup,
		effect,
		...(failureCode ? { failureCode } : {}),
	};
}

function failureReceipt(
	request: DecodedRemoteApplianceRequest,
	code: RemoteDelegationFailureCode,
	localProfile: ApplianceProfileId | null,
	cleanup: RemoteDelegationMetadata["cleanup"],
	effect: RemoteDelegationMetadata["effect"],
): ApplianceReceipt {
	return {
		schemaVersion: 1,
		receiptId: `remote-bootstrap-${randomUUID()}`,
		action: request.invocation.action,
		status: "failed",
		timestamp: new Date().toISOString(),
		details: { remoteDelegation: metadata(request, localProfile, cleanup, effect, code) },
	};
}

export async function runRemoteApplianceDelegation(
	request: DecodedRemoteApplianceRequest,
	options: {
		platform?: NodeJS.Platform;
		environment?: Record<string, string | undefined>;
		createOperationRoot?: () => Promise<string>;
		writeCompatibility?: (path: string, bytes: Uint8Array) => Promise<void>;
		removeOperationRoot?: (path: string) => Promise<void>;
		invoke: (invocation: RemoteDelegatedLocalInvocation) => Promise<ApplianceReceipt>;
	},
): Promise<ApplianceReceipt> {
	const createOperationRoot = options.createOperationRoot ?? (() => mkdtemp(join(tmpdir(), "omp-appliance-remote-")));
	const writeCompatibility =
		options.writeCompatibility ?? ((path, bytes) => writeFile(path, bytes, { flag: "wx", mode: 0o600 }));
	const removeOperationRoot = options.removeOperationRoot ?? (path => rm(path, { recursive: true, force: false }));
	let operationRoot: string | undefined;
	let localProfile: ApplianceProfile | undefined;
	let authority: CompatibilityAuthority | undefined;
	let receipt: ApplianceReceipt | undefined;
	let failureCode: RemoteDelegationFailureCode | undefined;
	let invocationStarted = false;

	try {
		const platform = options.platform ?? process.platform;
		const environment = options.environment ?? process.env;
		if (
			request.compatibility &&
			(environment.WSL_INTEROP !== undefined || request.wslDistribution !== undefined) &&
			(platform !== "linux" ||
				environment.WSL_INTEROP === undefined ||
				request.wslDistribution === undefined ||
				environment.WSL_DISTRO_NAME !== request.wslDistribution)
		) {
			failureCode = "REMOTE_WSL_CONTEXT_MISMATCH";
		}
		if (!failureCode && request.compatibility) {
			operationRoot = await createOperationRoot();
			if (digest(request.compatibility.bytes) !== request.compatibility.sha256) {
				failureCode = "REMOTE_COMPATIBILITY_HASH_MISMATCH";
			} else {
				const authorityPath = join(operationRoot, "compatibility.json");
				await writeCompatibility(authorityPath, request.compatibility.bytes);
				authority = await loadCompatibilityAuthority(authorityPath, request.compatibility.sha256);
				const transport = authority.profiles.find(
					profile => profile.profile === request.compatibility!.transportProfile,
				);
				const localProfileId =
					platform === "linux" ? "linux-docker-local" : platform === "win32" ? "windows-docker-local" : undefined;
				localProfile = authority.profiles.find(profile => profile.profile === localProfileId);
				const transportMustBeInstallable =
					request.invocation.action !== "doctor" && request.invocation.action !== "status";
				if (
					!transport?.lifecycleCommands?.includes(request.invocation.action) ||
					(transportMustBeInstallable && !transport.availability.installable)
				) {
					failureCode = "REMOTE_COMPATIBILITY_PROFILE_MISMATCH";
				} else if (!localProfile?.lifecycleCommands?.includes(request.invocation.action)) {
					failureCode = "REMOTE_LOCAL_PROFILE_UNAVAILABLE";
				} else if (!profilesMatch(transport, localProfile)) {
					failureCode = "REMOTE_COMPATIBILITY_PROFILE_MISMATCH";
				}
			}
		}
		if (!failureCode) {
			invocationStarted = true;
			receipt = await options.invoke({
				...request.invocation,
				...(authority ? { authority } : {}),
				...(localProfile ? { selectedProfile: localProfile } : {}),
				...(request.compatibility ? { transportProfile: request.compatibility.transportProfile } : {}),
				...(request.wslDistribution ? { delegatedWslDistribution: request.wslDistribution } : {}),
			});
			try {
				assertTransportSafeReceipt(receipt, request.invocation.action);
			} catch {
				receipt = undefined;
				failureCode = "REMOTE_RECEIPT_PRIVACY_REJECTED";
			}
		}
	} catch {
		if (!failureCode) {
			failureCode = invocationStarted ? "REMOTE_DELEGATED_ACTION_FAILED" : "REMOTE_STAGING_FAILED";
		}
	}

	let cleanup: RemoteDelegationMetadata["cleanup"] = operationRoot ? "ok" : "not-created";
	if (operationRoot) {
		try {
			await removeOperationRoot(operationRoot);
		} catch {
			cleanup = "failed";
			failureCode ??= "REMOTE_BOOTSTRAP_CLEANUP_FAILED";
		}
	}
	if (!receipt || failureCode) {
		const confirmed = receipt !== undefined;
		const effect = confirmed
			? "confirmed"
			: invocationStarted && remoteActionMayPersist(request.invocation.action)
				? "uncertain"
				: "none";
		if (receipt && failureCode === "REMOTE_BOOTSTRAP_CLEANUP_FAILED") {
			receipt = {
				...receipt,
				status: "failed",
				details: {
					...receipt.details,
					remoteDelegation: metadata(request, localProfile?.profile ?? null, cleanup, effect, failureCode),
				},
			};
			assertTransportSafeReceipt(receipt, request.invocation.action);
			return receipt;
		}
		return failureReceipt(
			request,
			failureCode ?? "REMOTE_RECEIPT_PRIVACY_REJECTED",
			localProfile?.profile ?? null,
			cleanup,
			effect,
		);
	}
	const delegated: ApplianceReceipt = {
		...receipt,
		details: {
			...receipt.details,
			remoteDelegation: metadata(request, localProfile?.profile ?? null, cleanup, "confirmed"),
		},
	};
	assertTransportSafeReceipt(delegated, request.invocation.action);
	return delegated;
}
