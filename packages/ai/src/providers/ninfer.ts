import { stableStringifyJson } from "@oh-my-pi/pi-utils";
import type { FetchImpl, Model } from "../types";

export const NINFER_REQUEST_SHAPE_VERSION = "omp-openai-responses-ninfer/v1";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_REVISION_PATTERN = /^[0-9a-f]{7,64}$/;
const SAFE_IDENTITY_PATTERN = /^[A-Za-z0-9._:/-]{1,256}$/;
const MAX_STATUS_BYTES = 64 * 1024;

export interface NInferStatusV1 {
	schemaVersion: 1;
	serverInstanceId: string;
	upstreamBaseSha: string;
	patchStackSha: string;
	sourceDirty: false;
	binarySha256: string;
	artifactSha256: string;
	configSha256: string;
	deploymentProfile: string;
	servedModel: string;
}

export interface NInferEndpointIdentity {
	fingerprint: string;
	normalizedBaseUrl: string;
	servedModel: string;
	requestShapeVersion: typeof NINFER_REQUEST_SHAPE_VERSION;
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

function requireRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new NInferStatusError("NInfer status did not return an object", "schema");
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

export function parseNInferStatusV1(value: unknown): NInferStatusV1 {
	const record = requireRecord(value);
	if (record.schema_version !== 1) {
		throw new NInferStatusError("Unsupported NInfer status schema version", "schema");
	}
	if (record.source_dirty !== false) {
		throw new NInferStatusError("NInfer status reports a dirty or unknown source tree", "identity");
	}
	const artifactKey = record.artifact_sha256 !== undefined ? "artifact_sha256" : "model_artifact_sha256";
	return {
		schemaVersion: 1,
		serverInstanceId: requireSafeIdentity(record, "server_instance_id"),
		upstreamBaseSha: requireSourceRevision(record, "upstream_base_sha"),
		patchStackSha: requireSha256(record, "patch_stack_sha"),
		sourceDirty: false,
		binarySha256: requireSha256(record, "binary_sha256"),
		artifactSha256: requireSha256(record, artifactKey),
		configSha256: requireSha256(record, "config_sha256"),
		deploymentProfile: requireSafeIdentity(record, "deployment_profile"),
		servedModel: requireSafeIdentity(record, "served_model"),
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

function statusUrlForBase(normalizedBaseUrl: string): string {
	const url = new URL(normalizedBaseUrl);
	url.pathname = url.pathname.endsWith("/v1") ? `${url.pathname}/ninfer/status` : `${url.pathname}/v1/ninfer/status`;
	return url.toString();
}

function endpointFingerprint(baseUrl: string, status: NInferStatusV1): string {
	return Bun.SHA256.hash(
		stableStringifyJson({
			protocol: "openai-responses",
			normalizedBaseUrl: baseUrl,
			servedModel: status.servedModel,
			serverInstanceId: status.serverInstanceId,
			upstreamBaseSha: status.upstreamBaseSha,
			patchStackSha: status.patchStackSha,
			binarySha256: status.binarySha256,
			artifactSha256: status.artifactSha256,
			configSha256: status.configSha256,
			deploymentProfile: status.deploymentProfile,
			requestShapeVersion: NINFER_REQUEST_SHAPE_VERSION,
		}),
		"hex",
	);
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
	if (!options.apiKey.trim()) {
		throw new NInferStatusError("NInfer API authentication is required", "auth");
	}
	const normalizedBaseUrl = normalizeNInferBaseUrl(options.baseUrl);
	let response: Response;
	try {
		response = await (options.fetch ?? fetch)(statusUrlForBase(normalizedBaseUrl), {
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
	const body = await response.text();
	if (Buffer.byteLength(body) > MAX_STATUS_BYTES) {
		throw new NInferStatusError("NInfer status response exceeded the size limit", "schema");
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(body);
	} catch {
		throw new NInferStatusError("NInfer status returned invalid JSON", "schema");
	}
	const status = parseNInferStatusV1(decoded);
	const requestedModel = options.model.requestModelId ?? options.model.id;
	if (status.servedModel !== requestedModel) {
		throw new NInferStatusError("NInfer served model does not match the configured wire model", "identity");
	}
	return {
		fingerprint: endpointFingerprint(normalizedBaseUrl, status),
		normalizedBaseUrl,
		servedModel: status.servedModel,
		requestShapeVersion: NINFER_REQUEST_SHAPE_VERSION,
	};
}

export function createNInferRequestIdentity(
	sessionId: string,
	randomUuid: () => string = () => Bun.randomUUIDv7(),
): NInferRequestIdentity {
	const sessionDigest = Bun.SHA256.hash(`omp:ninfer:session:v1\0${sessionId}`, "hex");
	const requestDigest = Bun.SHA256.hash(`omp:ninfer:request:v1\0${sessionDigest}\0${randomUuid()}`, "hex");
	return { sessionDigest, requestDigest };
}

export function applyNInferRequestIdentity(params: Record<string, unknown>, identity: NInferRequestIdentity): void {
	params.ninfer_session = identity.sessionDigest;
	params.ninfer_request_id = identity.requestDigest;
	if (typeof params.prompt_cache_key === "string") params.prompt_cache_key = identity.sessionDigest;
	if (typeof params.session_id === "string") params.session_id = identity.sessionDigest;
}
