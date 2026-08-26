import { stableStringifyJson } from "@oh-my-pi/pi-utils";
import type { FetchImpl, Model } from "../types";

export const NINFER_REQUEST_SHAPE_VERSION = "omp-openai-responses-ninfer/v1";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_REVISION_PATTERN = /^[0-9a-f]{7,64}$/;
const SAFE_IDENTITY_PATTERN = /^[A-Za-z0-9._:/-]{1,256}$/;
const MAX_STATUS_BYTES = 64 * 1024;

export interface NInferSchedulerStatus {
	maxConcurrency: number;
	maxPendingRequests: number;
	running: number;
	prefilling: number;
	decodeReady: number;
	waiting: number;
	materializing: number;
	capturePending: number;
}

export interface NInferCacheStatus {
	privateCatalogOccupied: number;
	privateCatalogCapacity: number;
	reusedPromptTokens: number;
}

export interface NInferMtpStatus {
	rounds: number;
	draftedTokens: number;
	acceptedTokens: number;
	fallbackSteps: number;
}

export interface NInferStatusV1 {
	schemaVersion: 1;
	artifactType: "ninfer_server_status";
	upstreamBaseSha: string;
	patchStackSha: string;
	sourceDirty: false;
	binarySha256: string;
	artifactSha256: string;
	configSha256: string;
	deploymentProfile: string;
	servedModel: string;
	target: string;
	modelId: string;
	maxContext: number;
	scheduler: NInferSchedulerStatus;
	cache: NInferCacheStatus;
	mtp: NInferMtpStatus;
}

export interface NInferEndpointIdentity {
	fingerprint: string;
	normalizedBaseUrl: string;
	servedModel: string;
	profile: string;
	artifactSha256: string;
	requestShapeVersion: typeof NINFER_REQUEST_SHAPE_VERSION;
	status: NInferStatusV1;
}

export interface NInferRequestIdentity {
	sessionDigest: string;
	requestDigest: string;
}

export class NInferStatusError extends Error {
	constructor(
		message: string,
		readonly kind: "auth" | "transport" | "schema" | "identity",
	) {
		super(message);
		this.name = "NInferStatusError";
	}
}

export type NInferCheckpointOperation = "status" | "save" | "delete";
export type NInferCheckpointState =
	| "available"
	| "missing"
	| "incompatible"
	| "corrupt"
	| "disabled"
	| "deleted";

export interface NInferCheckpointStatus {
	artifactType: "ninfer_session_checkpoint_status";
	schemaVersion?: number;
	sessionSha256: string;
	state: NInferCheckpointState;
	generation?: string;
	createdAtUnixMs?: number;
	bytes?: number;
	frontierTokens?: number;
	restoredTokens?: number;
	responseRecords?: number;
}

export class NInferCheckpointError extends Error {
	constructor(
		message: string,
		readonly kind: "auth" | "transport" | "schema" | "unavailable",
		readonly status?: number,
	) {
		super(message);
		this.name = "NInferCheckpointError";
	}
}

function requireRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new NInferStatusError("NInfer status did not return an object", "schema");
	}
	return value as Record<string, unknown>;
}

function requireNestedRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
	const value = record[key];
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new NInferStatusError(`NInfer status field ${key} is invalid`, "schema");
	}
	return value as Record<string, unknown>;
}

function requireSafeIdentity(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || !SAFE_IDENTITY_PATTERN.test(value)) {
		throw new NInferStatusError(`NInfer status field ${key} is invalid`, "schema");
	}
	return value;
}

function requireSha256(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
		throw new NInferStatusError(`NInfer status field ${key} is not a lowercase SHA-256`, "schema");
	}
	return value;
}

function requireSourceRevision(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || !SOURCE_REVISION_PATTERN.test(value)) {
		throw new NInferStatusError(`NInfer status field ${key} is invalid`, "schema");
	}
	return value;
}

function requireNonNegativeNumber(record: Record<string, unknown>, key: string): number {
	const value = record[key];
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new NInferStatusError(`NInfer status field ${key} is invalid`, "schema");
	}
	return value;
}

export function parseNInferStatusV1(value: unknown): NInferStatusV1 {
	const record = requireRecord(value);
	if (record.artifact_type !== "ninfer_server_status" || record.schema_version !== 1 || record.status !== "ok") {
		throw new NInferStatusError("Unsupported NInfer status schema version", "schema");
	}
	const identity = requireNestedRecord(record, "identity");
	const runtime = requireNestedRecord(record, "runtime");
	const scheduler = requireNestedRecord(record, "scheduler");
	const cache = requireNestedRecord(record, "cache");
	const privateCatalog = requireNestedRecord(cache, "private_catalog");
	const mtp = requireNestedRecord(record, "mtp");
	if (identity.source_dirty !== false) {
		throw new NInferStatusError("NInfer status reports a dirty or unknown source tree", "identity");
	}
	return {
		schemaVersion: 1,
		artifactType: "ninfer_server_status",
		upstreamBaseSha: requireSourceRevision(identity, "upstream_base_sha"),
		patchStackSha: requireSourceRevision(identity, "patch_stack_sha"),
		sourceDirty: false,
		binarySha256: requireSha256(identity, "binary_sha256"),
		artifactSha256: requireSha256(identity, "model_artifact_sha256"),
		configSha256: requireSha256(identity, "config_sha256"),
		deploymentProfile: requireSafeIdentity(identity, "deployment_profile"),
		servedModel: requireSafeIdentity(runtime, "public_model_id"),
		target: requireSafeIdentity(identity, "target"),
		modelId: requireSafeIdentity(identity, "model_id"),
		maxContext: requireNonNegativeNumber(runtime, "max_context"),
		scheduler: {
			maxConcurrency: requireNonNegativeNumber(scheduler, "max_concurrency"),
			maxPendingRequests: requireNonNegativeNumber(scheduler, "max_pending_requests"),
			running: requireNonNegativeNumber(scheduler, "running"),
			prefilling: requireNonNegativeNumber(scheduler, "prefilling"),
			decodeReady: requireNonNegativeNumber(scheduler, "decode_ready"),
			waiting: requireNonNegativeNumber(scheduler, "waiting"),
			materializing: requireNonNegativeNumber(scheduler, "materializing"),
			capturePending: requireNonNegativeNumber(scheduler, "capture_pending"),
		},
		cache: {
			privateCatalogOccupied: requireNonNegativeNumber(privateCatalog, "occupied"),
			privateCatalogCapacity: requireNonNegativeNumber(privateCatalog, "capacity"),
			reusedPromptTokens: requireNonNegativeNumber(cache, "reused_prompt_tokens"),
		},
		mtp: {
			rounds: requireNonNegativeNumber(mtp, "rounds"),
			draftedTokens: requireNonNegativeNumber(mtp, "drafted_tokens"),
			acceptedTokens: requireNonNegativeNumber(mtp, "accepted_tokens"),
			fallbackSteps: requireNonNegativeNumber(mtp, "fallback_steps"),
		},
	};
}

export function normalizeNInferBaseUrl(baseUrl: string): string {
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		throw new NInferStatusError("NInfer base URL is invalid", "identity");
	}
	if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
		throw new NInferStatusError(
			"NInfer base URL must be an authenticated HTTP endpoint without userinfo",
			"identity",
		);
	}
	url.search = "";
	url.hash = "";
	url.pathname = url.pathname.replace(/\/+$/, "") || "/";
	return url.toString().replace(/\/$/, "");
}

function apiUrlForBase(normalizedBaseUrl: string, suffix: string): string {
	const url = new URL(normalizedBaseUrl);
	const root = url.pathname.endsWith("/v1") ? url.pathname : `${url.pathname.replace(/\/$/, "")}/v1`;
	url.pathname = `${root}/${suffix.replace(/^\//, "")}`;
	return url.toString();
}

function endpointFingerprint(baseUrl: string, status: NInferStatusV1): string {
	return Bun.SHA256.hash(
		stableStringifyJson({
			protocol: "openai-responses",
			normalizedBaseUrl: baseUrl,
			servedModel: status.servedModel,
			upstreamBaseSha: status.upstreamBaseSha,
			patchStackSha: status.patchStackSha,
			binarySha256: status.binarySha256,
			artifactSha256: status.artifactSha256,
			configSha256: status.configSha256,
			deploymentProfile: status.deploymentProfile,
			target: status.target,
			modelId: status.modelId,
			requestShapeVersion: NINFER_REQUEST_SHAPE_VERSION,
		}),
		"hex",
	);
}

async function readBoundedJson(response: Response, error: (message: string) => Error): Promise<unknown> {
	const body = await response.text();
	if (Buffer.byteLength(body) > MAX_STATUS_BYTES) throw error("NInfer response exceeded the size limit");
	try {
		return JSON.parse(body);
	} catch {
		throw error("NInfer returned invalid JSON");
	}
}

export async function fetchNInferStatus(options: {
	baseUrl: string;
	apiKey: string;
	servedModel: string;
	fetch?: FetchImpl;
	signal?: AbortSignal;
}): Promise<NInferEndpointIdentity> {
	if (!options.apiKey.trim()) throw new NInferStatusError("NInfer API authentication is required", "auth");
	const normalizedBaseUrl = normalizeNInferBaseUrl(options.baseUrl);
	let response: Response;
	try {
		response = await (options.fetch ?? fetch)(apiUrlForBase(normalizedBaseUrl, "ninfer/status"), {
			method: "GET",
			headers: { Accept: "application/json", Authorization: `Bearer ${options.apiKey}` },
			signal: options.signal,
		});
	} catch (error) {
		if (options.signal?.aborted) throw error;
		throw new NInferStatusError("Authenticated NInfer status request failed", "transport");
	}
	if (!response.ok) {
		throw new NInferStatusError(
			response.status === 401 || response.status === 403
				? "NInfer status authentication failed"
				: `NInfer status request failed with HTTP ${response.status}`,
			response.status === 401 || response.status === 403 ? "auth" : "transport",
		);
	}
	const decoded = await readBoundedJson(response, message => new NInferStatusError(message, "schema"));
	const status = parseNInferStatusV1(decoded);
	if (status.servedModel !== options.servedModel) {
		throw new NInferStatusError("NInfer served model does not match the configured wire model", "identity");
	}
	return {
		fingerprint: endpointFingerprint(normalizedBaseUrl, status),
		normalizedBaseUrl,
		servedModel: status.servedModel,
		profile: status.deploymentProfile,
		artifactSha256: status.artifactSha256,
		requestShapeVersion: NINFER_REQUEST_SHAPE_VERSION,
		status,
	};
}

export async function fetchNInferEndpointIdentity(options: {
	model: Model<"openai-responses">;
	baseUrl: string;
	apiKey: string;
	fetch?: FetchImpl;
	signal?: AbortSignal;
}): Promise<NInferEndpointIdentity> {
	if (!options.model.compat.ninferStatefulResponses) {
		throw new NInferStatusError("Model does not declare NInfer stateful Responses capability", "identity");
	}
	return fetchNInferStatus({
		baseUrl: options.baseUrl,
		apiKey: options.apiKey,
		servedModel: options.model.requestModelId ?? options.model.id,
		fetch: options.fetch,
		signal: options.signal,
	});
}

function checkpointRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new NInferCheckpointError("NInfer checkpoint response did not return an object", "schema");
	}
	return value as Record<string, unknown>;
}

function parseCheckpointStatus(value: unknown, sessionSha256: string): NInferCheckpointStatus {
	const record = checkpointRecord(value);
	if (
		record.artifact_type !== "ninfer_session_checkpoint_status" ||
		typeof record.state !== "string" ||
		["available", "missing", "incompatible", "corrupt", "disabled", "deleted"].includes(record.state) === false
	) {
		throw new NInferCheckpointError("NInfer checkpoint response has an invalid artifact type or state", "schema");
	}
	const optionalNumber = (key: string): number | undefined => {
		const candidate = record[key];
		if (candidate === undefined) return undefined;
		if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0) {
			throw new NInferCheckpointError(`NInfer checkpoint field ${key} is invalid`, "schema");
		}
		return candidate;
	};
	const generation = record.generation;
	if (generation !== undefined && (typeof generation !== "string" || !SAFE_IDENTITY_PATTERN.test(generation))) {
		throw new NInferCheckpointError("NInfer checkpoint generation is invalid", "schema");
	}
	return {
		artifactType: "ninfer_session_checkpoint_status",
		schemaVersion: optionalNumber("schema_version"),
		sessionSha256,
		state: record.state as NInferCheckpointState,
		generation,
		createdAtUnixMs: optionalNumber("created_at_unix_ms"),
		bytes: optionalNumber("bytes"),
		frontierTokens: optionalNumber("frontier_tokens"),
		restoredTokens: optionalNumber("restored_tokens"),
		responseRecords: optionalNumber("response_records"),
	};
}

/** Call the authenticated standalone NInfer checkpoint contract with hashed session identity only. */
export async function requestNInferCheckpoint(options: {
	operation: NInferCheckpointOperation;
	sessionSha256: string;
	baseUrl: string;
	apiKey: string;
	fetch?: FetchImpl;
	signal?: AbortSignal;
}): Promise<NInferCheckpointStatus> {
	if (!SHA256_PATTERN.test(options.sessionSha256)) {
		throw new NInferCheckpointError("NInfer checkpoint session must be a lowercase SHA-256", "schema");
	}
	if (!options.apiKey.trim()) throw new NInferCheckpointError("NInfer API authentication is required", "auth");
	let normalizedBaseUrl: string;
	try {
		normalizedBaseUrl = normalizeNInferBaseUrl(options.baseUrl);
	} catch {
		throw new NInferCheckpointError("NInfer checkpoint base URL is invalid", "schema");
	}
	const method = options.operation === "status" ? "GET" : options.operation === "save" ? "POST" : "DELETE";
	const path =
		options.operation === "save"
			? "ninfer/checkpoints"
			: options.operation === "status"
				? `ninfer/checkpoints/${options.sessionSha256}/status`
				: `ninfer/checkpoints/${options.sessionSha256}`;
	const headers: Record<string, string> = {
		Accept: "application/json",
		Authorization: `Bearer ${options.apiKey}`,
	};
	const body = options.operation === "save" ? JSON.stringify({ session_sha256: options.sessionSha256 }) : undefined;
	if (body !== undefined) headers["Content-Type"] = "application/json";
	let response: Response;
	try {
		response = await (options.fetch ?? fetch)(apiUrlForBase(normalizedBaseUrl, path), {
			method,
			headers,
			body,
			signal: options.signal,
		});
	} catch (error) {
		if (options.signal?.aborted) throw error;
		throw new NInferCheckpointError("Authenticated NInfer checkpoint request failed", "transport");
	}
	if (!response.ok) {
		const auth = response.status === 401 || response.status === 403;
		throw new NInferCheckpointError(
			auth
				? "NInfer checkpoint authentication failed"
				: response.status === 409
					? "NInfer session has no complete checkpointable response"
					: `NInfer checkpoint request failed with HTTP ${response.status}`,
			auth ? "auth" : response.status === 409 ? "unavailable" : "transport",
			response.status,
		);
	}
	const decoded = await readBoundedJson(
		response,
		message => new NInferCheckpointError(message.replace("NInfer response", "NInfer checkpoint response"), "schema"),
	);
	const result = parseCheckpointStatus(decoded, options.sessionSha256);
	const allowedStates: Record<NInferCheckpointOperation, readonly NInferCheckpointState[]> = {
		status: ["available", "missing", "incompatible", "corrupt", "disabled"],
		save: ["available"],
		delete: ["deleted", "missing"],
	};
	if (!allowedStates[options.operation].includes(result.state)) {
		throw new NInferCheckpointError("NInfer checkpoint response state does not match the operation", "schema");
	}
	return result;
}

export function createNInferRequestIdentity(
	sessionId: string,
	randomUuid: () => string = () => Bun.randomUUIDv7(),
): NInferRequestIdentity {
	const sessionDigest = Bun.SHA256.hash(`omp:ninfer:session:v1\0${sessionId}`, "hex");
	const requestDigest = Bun.SHA256.hash(`omp:ninfer:request:v1\0${sessionDigest}\0${randomUuid()}`, "hex");
	return { sessionDigest, requestDigest };
}

export function stripUnsupportedNInferRequestFields(params: Record<string, unknown>): void {
	delete params.include;
	delete params.prompt_cache_key;
	delete params.session_id;
	const reasoning = params.reasoning;
	if (reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)) {
		for (const key of Object.keys(reasoning)) {
			if (key !== "effort") delete (reasoning as Record<string, unknown>)[key];
		}
	}
}

export function applyNInferRequestIdentity(params: Record<string, unknown>, identity: NInferRequestIdentity): void {
	stripUnsupportedNInferRequestFields(params);
	params.ninfer_session = identity.sessionDigest;
	params.ninfer_request_id = identity.requestDigest;
}
