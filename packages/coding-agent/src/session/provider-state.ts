import type { ProviderStatePersistenceSnapshot, ProviderStateRecovery } from "@oh-my-pi/pi-ai/types";
import { isRecord, stableStringifyJson } from "@oh-my-pi/pi-utils";
import type { CustomEntry, SessionEntry } from "./session-entries";
import type { SessionManager } from "./session-manager";

export const PROVIDER_STATE_CUSTOM_TYPE = "omp.provider-state.v1";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BLOB_REF_PATTERN = /^blob:sha256:([0-9a-f]{64})$/;
const INVALIDATING_ENTRY_TYPES: Record<string, true> = {
	compaction: true,
	branch_summary: true,
	reset_boundary: true,
	model_change: true,
};

export interface ProviderStateBlobRef {
	sha256: string;
	bytes: number;
	blob: string;
}

export interface ProviderStateEnvelopeV1 {
	schemaVersion: 1;
	provider: "openai-responses";
	endpointFingerprint: string;
	model: string;
	lastResponseId: string;
	lastCommittedTurnId: string;
	requestBaselineRef: ProviderStateBlobRef;
	priorOutputItemsRef: ProviderStateBlobRef;
	createdAt: string;
	updatedAt: string;
	requestShapeVersion: string;
	promptCacheBreakpointPolicy?: "latest-stable-message" | "none";
	provider_state_recovery?: ProviderStateRecovery;
	transcriptBranchSha256: string;
	sessionIdentitySha256: string;
}

export type PreparedProviderStateEnvelope = Omit<
	ProviderStateEnvelopeV1,
	"lastCommittedTurnId" | "transcriptBranchSha256" | "sessionIdentitySha256"
>;

function digest(value: unknown): string {
	return Bun.SHA256.hash(stableStringifyJson(value), "hex");
}

function sessionIdentityDigest(sessionId: string): string {
	return Bun.SHA256.hash(`omp:provider-state:session:v1\0${sessionId}`, "hex");
}

async function putJsonBlob(sessionManager: SessionManager, value: unknown): Promise<ProviderStateBlobRef> {
	const data = Buffer.from(stableStringifyJson(value));
	const result = await sessionManager.putBlob(data);
	return { sha256: result.hash, bytes: data.byteLength, blob: result.ref };
}

export async function prepareProviderStateEnvelope(
	sessionManager: SessionManager,
	snapshot: ProviderStatePersistenceSnapshot,
): Promise<PreparedProviderStateEnvelope> {
	const [requestBaselineRef, priorOutputItemsRef] = await Promise.all([
		putJsonBlob(sessionManager, snapshot.requestBaseline),
		putJsonBlob(sessionManager, snapshot.priorOutputItems),
	]);
	return {
		schemaVersion: 1,
		provider: snapshot.provider,
		endpointFingerprint: snapshot.endpointFingerprint,
		model: snapshot.model,
		lastResponseId: snapshot.lastResponseId,
		requestBaselineRef,
		priorOutputItemsRef,
		createdAt: snapshot.createdAt,
		updatedAt: snapshot.updatedAt,
		requestShapeVersion: snapshot.requestShapeVersion,
		promptCacheBreakpointPolicy: snapshot.promptCacheBreakpointPolicy,
		provider_state_recovery: snapshot.providerStateRecovery,
	};
}

export function finalizeProviderStateEnvelope(options: {
	prepared: PreparedProviderStateEnvelope;
	sessionId: string;
	lastCommittedTurnId: string;
	branch: readonly SessionEntry[];
}): ProviderStateEnvelopeV1 {
	const committedIndex = options.branch.findIndex(entry => entry.id === options.lastCommittedTurnId);
	if (committedIndex < 0 || committedIndex !== options.branch.length - 1) {
		throw new Error("Provider state must be published immediately after its committed assistant turn");
	}
	return {
		...options.prepared,
		lastCommittedTurnId: options.lastCommittedTurnId,
		transcriptBranchSha256: digest(options.branch.slice(0, committedIndex + 1)),
		sessionIdentitySha256: sessionIdentityDigest(options.sessionId),
	};
}

function parseBlobRef(value: unknown): ProviderStateBlobRef | undefined {
	if (!isRecord(value)) return undefined;
	const { sha256, bytes, blob } = value;
	if (
		typeof sha256 !== "string" ||
		!SHA256_PATTERN.test(sha256) ||
		typeof bytes !== "number" ||
		!Number.isSafeInteger(bytes) ||
		bytes < 0 ||
		typeof blob !== "string" ||
		BLOB_REF_PATTERN.exec(blob)?.[1] !== sha256
	) {
		return undefined;
	}
	return { sha256, bytes, blob };
}

function parseEnvelope(value: unknown): ProviderStateEnvelopeV1 | undefined {
	if (!isRecord(value) || value.schemaVersion !== 1) return undefined;
	const requestBaselineRef = parseBlobRef(value.requestBaselineRef);
	const priorOutputItemsRef = parseBlobRef(value.priorOutputItemsRef);
	if (
		value.provider !== "openai-responses" ||
		typeof value.endpointFingerprint !== "string" ||
		!SHA256_PATTERN.test(value.endpointFingerprint) ||
		typeof value.model !== "string" ||
		!value.model ||
		typeof value.lastResponseId !== "string" ||
		!value.lastResponseId ||
		typeof value.lastCommittedTurnId !== "string" ||
		!value.lastCommittedTurnId ||
		!requestBaselineRef ||
		!priorOutputItemsRef ||
		typeof value.createdAt !== "string" ||
		!Number.isFinite(Date.parse(value.createdAt)) ||
		typeof value.updatedAt !== "string" ||
		!Number.isFinite(Date.parse(value.updatedAt)) ||
		typeof value.requestShapeVersion !== "string" ||
		!value.requestShapeVersion ||
		(value.promptCacheBreakpointPolicy !== undefined &&
			value.promptCacheBreakpointPolicy !== "latest-stable-message" &&
			value.promptCacheBreakpointPolicy !== "none") ||
		(value.provider_state_recovery !== undefined && value.provider_state_recovery !== "full_replay") ||
		typeof value.transcriptBranchSha256 !== "string" ||
		!SHA256_PATTERN.test(value.transcriptBranchSha256) ||
		typeof value.sessionIdentitySha256 !== "string" ||
		!SHA256_PATTERN.test(value.sessionIdentitySha256)
	) {
		return undefined;
	}
	return {
		schemaVersion: 1,
		provider: "openai-responses",
		endpointFingerprint: value.endpointFingerprint,
		model: value.model,
		lastResponseId: value.lastResponseId,
		lastCommittedTurnId: value.lastCommittedTurnId,
		requestBaselineRef,
		priorOutputItemsRef,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
		requestShapeVersion: value.requestShapeVersion,
		promptCacheBreakpointPolicy: value.promptCacheBreakpointPolicy as "latest-stable-message" | "none" | undefined,
		provider_state_recovery: value.provider_state_recovery as ProviderStateRecovery | undefined,
		transcriptBranchSha256: value.transcriptBranchSha256,
		sessionIdentitySha256: value.sessionIdentitySha256,
	};
}

async function readJsonBlob(sessionManager: SessionManager, ref: ProviderStateBlobRef): Promise<unknown | undefined> {
	const data = await sessionManager.readBlob(ref.blob);
	if (!data || data.byteLength !== ref.bytes || Bun.SHA256.hash(data, "hex") !== ref.sha256) return undefined;
	try {
		return JSON.parse(data.toString("utf8"));
	} catch {
		return undefined;
	}
}

function latestProviderStateEntry(branch: readonly SessionEntry[]): { entry: CustomEntry; index: number } | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "custom" && entry.customType === PROVIDER_STATE_CUSTOM_TYPE) {
			return { entry, index };
		}
	}
	return undefined;
}

/** Load only a snapshot bound to this exact session branch and request contract. */
export async function loadProviderStateSnapshot(options: {
	sessionManager: SessionManager;
	sessionId: string;
	model: string;
	requestShapeVersion: string;
}): Promise<ProviderStatePersistenceSnapshot | undefined> {
	try {
		const branch = options.sessionManager.getBranch();
		const located = latestProviderStateEntry(branch);
		if (!located) return undefined;
		const envelope = parseEnvelope(located.entry.data);
		if (!envelope) return undefined;
		if (
			envelope.model !== options.model ||
			envelope.requestShapeVersion !== options.requestShapeVersion ||
			envelope.sessionIdentitySha256 !== sessionIdentityDigest(options.sessionId)
		) {
			return undefined;
		}
		const committedIndex = branch.findIndex(entry => entry.id === envelope.lastCommittedTurnId);
		if (
			committedIndex < 0 ||
			committedIndex >= located.index ||
			located.entry.parentId !== envelope.lastCommittedTurnId
		) {
			return undefined;
		}
		const committedEntry = branch[committedIndex];
		if (
			committedEntry.type !== "message" ||
			committedEntry.message.role !== "assistant" ||
			committedEntry.message.responseId !== envelope.lastResponseId ||
			digest(branch.slice(0, committedIndex + 1)) !== envelope.transcriptBranchSha256
		) {
			return undefined;
		}
		for (const entry of branch.slice(located.index + 1)) {
			if (INVALIDATING_ENTRY_TYPES[entry.type]) return undefined;
		}
		const [requestBaseline, priorOutputItems] = await Promise.all([
			readJsonBlob(options.sessionManager, envelope.requestBaselineRef),
			readJsonBlob(options.sessionManager, envelope.priorOutputItemsRef),
		]);
		if (!isRecord(requestBaseline) || !Array.isArray(priorOutputItems)) return undefined;
		return {
			schemaVersion: 1,
			provider: "openai-responses",
			endpointFingerprint: envelope.endpointFingerprint,
			model: envelope.model,
			lastResponseId: envelope.lastResponseId,
			requestBaseline,
			priorOutputItems,
			createdAt: envelope.createdAt,
			updatedAt: envelope.updatedAt,
			requestShapeVersion: envelope.requestShapeVersion,
			promptCacheBreakpointPolicy: envelope.promptCacheBreakpointPolicy,
			providerStateRecovery: envelope.provider_state_recovery,
		};
	} catch {
		return undefined;
	}
}
