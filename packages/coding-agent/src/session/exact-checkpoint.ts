import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getAgentDir, isEnoent, isRecord } from "@oh-my-pi/pi-utils";

export const EXACT_CHECKPOINT_TYPE = "exact_checkpoint_v1" as const;
export const EXACT_CHECKPOINT_SCHEMA_VERSION = 1 as const;
export const MAX_EXACT_CHECKPOINT_TTL_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_EXACT_CHECKPOINT_TTL_MS = MAX_EXACT_CHECKPOINT_TTL_MS;
export const EXACT_CHECKPOINT_CLAIMS_DIR_NAME = "exact-checkpoint-claims";

const SHA256_RE = /^[a-f0-9]{64}$/;
const REPOSITORY_OID_RE = /^[a-f0-9]{40,64}$/;
const TRANSPORT_ONLY_KEYS: Record<string, true> = {
	encryptedcontent: true,
	previousresponseid: true,
	providerpayload: true,
	providerresponseid: true,
	responseid: true,
	thinkingsignature: true,
};
const PRIVATE_VALUE_KEYS: Record<string, true> = {
	accountid: true,
	accountuuid: true,
	accesstoken: true,
	apikey: true,
	authorization: true,
	authtoken: true,
	cachekey: true,
	cookie: true,
	credentials: true,
	email: true,
	orgid: true,
	password: true,
	promptcachekey: true,
	providerpromptcachekey: true,
	refreshtoken: true,
	secret: true,
	token: true,
};

export type ExactCheckpointMessage =
	| Exclude<AgentMessage, AssistantMessage>
	| (Omit<AssistantMessage, "providerPayload" | "responseId"> & {
			providerPayload?: never;
			responseId?: never;
	  });

export interface ExactCheckpointAuthority {
	provider: string;
	model: string;
	/** SHA-256 witness for the pinned serving account, never a raw account identifier. */
	accountWitness: string | null;
	/** SHA-256 witness for the provider prompt-cache key, never the key itself. */
	promptCacheIdentity: string;
	requestProfileDigest: string;
	systemDigest: string;
	contextDigest: string;
	toolDigest: string;
	xdevDigest: string;
	workspaceRoot: string;
	repositoryBaseOid: string | null;
}

export interface ExactCheckpointLineage {
	lineageId: string;
	parentCheckpointId?: string;
	parentLineageId?: string;
}

export interface ExactCheckpointCompactionAccounting {
	epoch: number;
	tokensBefore: number;
}

export interface ExactCheckpointEnvelopeV1 {
	type: typeof EXACT_CHECKPOINT_TYPE;
	schemaVersion: typeof EXACT_CHECKPOINT_SCHEMA_VERSION;
	checkpointId: string;
	createdAt: string;
	expiresAt: string;
	sourceSessionId: string;
	committedLeafId: string | null;
	lineage: ExactCheckpointLineage;
	authority: ExactCheckpointAuthority;
	compaction: ExactCheckpointCompactionAccounting;
	messages: ExactCheckpointMessage[];
	integritySha256: string;
}

export interface ExactCheckpointReceipt {
	checkpointId: string;
	path: string;
	integritySha256: string;
	messageCount: number;
	compactionEpoch: number;
	createdAt: string;
	expiresAt: string;
}

export type ExactCheckpointResumeMode = "resume" | "fork";

export interface ExactCheckpointConsumption {
	envelope: ExactCheckpointEnvelopeV1;
	mode: ExactCheckpointResumeMode;
	successorSessionId: string;
	successorLineageId: string;
	consumedAt: string;
}

export type ExactCheckpointErrorCode =
	| "already_consumed"
	| "authority_mismatch"
	| "authenticity_mismatch"
	| "boundary_changed"
	| "corrupt"
	| "expired"
	| "forbidden_field"
	| "invalid_envelope"
	| "mid_stream"
	| "partial"
	| "uncommitted";

export class ExactCheckpointError extends Error {
	readonly code: ExactCheckpointErrorCode;
	readonly mismatches: readonly (keyof ExactCheckpointAuthority)[];

	constructor(
		code: ExactCheckpointErrorCode,
		message: string,
		mismatches: readonly (keyof ExactCheckpointAuthority)[] = [],
	) {
		super(message);
		this.name = "ExactCheckpointError";
		this.code = code;
		this.mismatches = mismatches;
	}
}

export interface PersistExactCheckpointOptions {
	checkpointPath: string;
	checkpointId: string;
	createdAt: Date;
	expiresAt: Date;
	sourceSessionId: string;
	committedLeafId: string | null;
	lineage: ExactCheckpointLineage;
	authority: ExactCheckpointAuthority;
	compaction: ExactCheckpointCompactionAccounting;
	messages: readonly AgentMessage[];
	now?: Date;
}

export interface ExactCheckpointClaimOptions {
	claimRoot?: string;
}

export interface ConsumeExactCheckpointOptions {
	expectedIntegritySha256: string;
	mode?: ExactCheckpointResumeMode;
	now?: Date;
	claimRoot?: string;
}
type CanonicalJson = null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson };

function normalizedKey(key: string): string {
	return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function canonicalValue(value: unknown, stack: Set<object>): CanonicalJson | undefined {
	if (value === undefined) return undefined;
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			throw new ExactCheckpointError("invalid_envelope", "Checkpoint values must be finite");
		return value;
	}
	if (typeof value !== "object") {
		throw new ExactCheckpointError("invalid_envelope", `Checkpoint value has unsupported type ${typeof value}`);
	}
	if (stack.has(value)) throw new ExactCheckpointError("invalid_envelope", "Checkpoint value contains a cycle");
	stack.add(value);
	try {
		if (Array.isArray(value)) return value.map(item => canonicalValue(item, stack) ?? null);
		const result: Record<string, CanonicalJson> = Object.create(null);
		for (const key of Object.keys(value).sort()) {
			const child = canonicalValue((value as Record<string, unknown>)[key], stack);
			if (child !== undefined) result[key] = child;
		}
		return result;
	} finally {
		stack.delete(value);
	}
}

function canonicalJson(value: unknown): string {
	const canonical = canonicalValue(value, new Set());
	if (canonical === undefined) {
		throw new ExactCheckpointError("invalid_envelope", "Checkpoint root value cannot be undefined");
	}
	return JSON.stringify(canonical);
}

export function exactCheckpointDigest(value: unknown): string {
	return Bun.SHA256.hash(canonicalJson(value), "hex");
}

function assertSafeScalar(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
		throw new ExactCheckpointError("invalid_envelope", `Checkpoint ${field} is invalid`);
	}
}

function assertDigest(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || !SHA256_RE.test(value)) {
		throw new ExactCheckpointError("invalid_envelope", `Checkpoint ${field} is not a SHA-256 witness`);
	}
}

function assertAuthority(value: unknown): asserts value is ExactCheckpointAuthority {
	if (!isRecord(value)) throw new ExactCheckpointError("invalid_envelope", "Checkpoint authority is missing");
	const expectedKeys = [
		"accountWitness",
		"contextDigest",
		"model",
		"promptCacheIdentity",
		"provider",
		"repositoryBaseOid",
		"requestProfileDigest",
		"systemDigest",
		"toolDigest",
		"workspaceRoot",
		"xdevDigest",
	];
	if (Object.keys(value).sort().join("\0") !== expectedKeys.join("\0")) {
		throw new ExactCheckpointError(
			"invalid_envelope",
			"Checkpoint authority fields do not match exact_checkpoint_v1",
		);
	}
	assertSafeScalar(value.provider, "provider");
	assertSafeScalar(value.model, "model");
	if (value.accountWitness !== null) assertDigest(value.accountWitness, "accountWitness");
	assertDigest(value.promptCacheIdentity, "promptCacheIdentity");
	assertDigest(value.requestProfileDigest, "requestProfileDigest");
	assertDigest(value.systemDigest, "systemDigest");
	assertDigest(value.contextDigest, "contextDigest");
	assertDigest(value.toolDigest, "toolDigest");
	assertDigest(value.xdevDigest, "xdevDigest");
	assertSafeScalar(value.workspaceRoot, "workspaceRoot");
	if (!path.isAbsolute(value.workspaceRoot) || path.resolve(value.workspaceRoot) !== value.workspaceRoot) {
		throw new ExactCheckpointError("invalid_envelope", "Checkpoint workspaceRoot must be canonical and absolute");
	}
	if (
		value.repositoryBaseOid !== null &&
		(typeof value.repositoryBaseOid !== "string" || !REPOSITORY_OID_RE.test(value.repositoryBaseOid))
	) {
		throw new ExactCheckpointError("invalid_envelope", "Checkpoint repositoryBaseOid is invalid");
	}
}

function assertLineage(value: unknown): asserts value is ExactCheckpointLineage {
	if (!isRecord(value)) throw new ExactCheckpointError("invalid_envelope", "Checkpoint lineage is missing");
	const allowed: Record<string, true> = { lineageId: true, parentCheckpointId: true, parentLineageId: true };
	if (Object.keys(value).some(key => !allowed[key])) {
		throw new ExactCheckpointError("invalid_envelope", "Checkpoint lineage has unknown fields");
	}
	assertSafeScalar(value.lineageId, "lineage.lineageId");
	if (value.parentCheckpointId !== undefined) assertSafeScalar(value.parentCheckpointId, "lineage.parentCheckpointId");
	if (value.parentLineageId !== undefined) assertSafeScalar(value.parentLineageId, "lineage.parentLineageId");
}

function assertCompaction(value: unknown): asserts value is ExactCheckpointCompactionAccounting {
	if (!isRecord(value) || Object.keys(value).sort().join("\0") !== "epoch\0tokensBefore") {
		throw new ExactCheckpointError("invalid_envelope", "Checkpoint compaction accounting is invalid");
	}
	if (typeof value.epoch !== "number" || !Number.isSafeInteger(value.epoch) || value.epoch < 0) {
		throw new ExactCheckpointError("invalid_envelope", "Checkpoint compaction epoch is invalid");
	}
	if (typeof value.tokensBefore !== "number" || !Number.isFinite(value.tokensBefore) || value.tokensBefore < 0) {
		throw new ExactCheckpointError("invalid_envelope", "Checkpoint compaction token accounting is invalid");
	}
}

function assertNoForbiddenFields(value: unknown, location = "checkpoint"): void {
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) assertNoForbiddenFields(value[index], `${location}[${index}]`);
		return;
	}
	if (!isRecord(value)) return;
	for (const [key, child] of Object.entries(value)) {
		const normalized = normalizedKey(key);
		if (TRANSPORT_ONLY_KEYS[normalized] || PRIVATE_VALUE_KEYS[normalized]) {
			throw new ExactCheckpointError("forbidden_field", `Checkpoint contains forbidden field ${location}.${key}`);
		}
		assertNoForbiddenFields(child, `${location}.${key}`);
	}
}

function assertTypedMessages(value: unknown): asserts value is ExactCheckpointMessage[] {
	if (!Array.isArray(value))
		throw new ExactCheckpointError("invalid_envelope", "Checkpoint messages must be an array");
	for (const [index, message] of value.entries()) {
		if (!isRecord(message))
			throw new ExactCheckpointError("invalid_envelope", `Checkpoint message ${index} is invalid`);
		assertSafeScalar(message.role, `messages[${index}].role`);
		if (
			(typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp)) &&
			(typeof message.timestamp !== "string" || !Number.isFinite(Date.parse(message.timestamp)))
		) {
			throw new ExactCheckpointError("invalid_envelope", `Checkpoint message ${index} has an invalid timestamp`);
		}
		if (message.role === "assistant") {
			assertSafeScalar(message.provider, `messages[${index}].provider`);
			assertSafeScalar(message.model, `messages[${index}].model`);
			assertSafeScalar(message.api, `messages[${index}].api`);
			if (!Array.isArray(message.content)) {
				throw new ExactCheckpointError(
					"invalid_envelope",
					`Checkpoint assistant message ${index} has invalid content`,
				);
			}
		} else if (message.role === "toolResult") {
			assertSafeScalar(message.toolCallId, `messages[${index}].toolCallId`);
			assertSafeScalar(message.toolName, `messages[${index}].toolName`);
			if (!Array.isArray(message.content)) {
				throw new ExactCheckpointError("invalid_envelope", `Checkpoint tool result ${index} has invalid content`);
			}
		} else if ((message.role === "user" || message.role === "developer") && message.content === undefined) {
			throw new ExactCheckpointError(
				"invalid_envelope",
				`Checkpoint ${message.role} message ${index} has no content`,
			);
		}
	}
}

function canonicalizeMessages(messages: readonly AgentMessage[]): ExactCheckpointMessage[] {
	const sanitize = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(sanitize);
		if (!isRecord(value)) return value;
		const result: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value)) {
			const normalized = normalizedKey(key);
			if (TRANSPORT_ONLY_KEYS[normalized]) continue;
			if (PRIVATE_VALUE_KEYS[normalized]) {
				throw new ExactCheckpointError("forbidden_field", `Typed history contains forbidden field ${key}`);
			}
			result[key] = sanitize(child);
		}
		return result;
	};
	const cloned = JSON.parse(canonicalJson(messages.map(sanitize))) as unknown;
	assertTypedMessages(cloned);
	return cloned;
}

function unsignedEnvelope(envelope: ExactCheckpointEnvelopeV1): Omit<ExactCheckpointEnvelopeV1, "integritySha256"> {
	const { integritySha256: _integritySha256, ...unsigned } = envelope;
	return unsigned;
}

function validateEnvelope(value: unknown, now: Date): ExactCheckpointEnvelopeV1 {
	assertNoForbiddenFields(value);
	if (!isRecord(value)) throw new ExactCheckpointError("invalid_envelope", "Checkpoint envelope is not an object");
	const expectedKeys = [
		"authority",
		"checkpointId",
		"committedLeafId",
		"compaction",
		"createdAt",
		"expiresAt",
		"integritySha256",
		"lineage",
		"messages",
		"schemaVersion",
		"sourceSessionId",
		"type",
	];
	if (Object.keys(value).sort().join("\0") !== expectedKeys.join("\0")) {
		throw new ExactCheckpointError("invalid_envelope", "Checkpoint fields do not match exact_checkpoint_v1");
	}
	if (value.type !== EXACT_CHECKPOINT_TYPE || value.schemaVersion !== EXACT_CHECKPOINT_SCHEMA_VERSION) {
		throw new ExactCheckpointError("invalid_envelope", "Unsupported exact checkpoint schema");
	}
	assertSafeScalar(value.checkpointId, "checkpointId");
	assertSafeScalar(value.sourceSessionId, "sourceSessionId");
	if (value.committedLeafId !== null) assertSafeScalar(value.committedLeafId, "committedLeafId");
	assertSafeScalar(value.createdAt, "createdAt");
	assertSafeScalar(value.expiresAt, "expiresAt");
	const createdAt = Date.parse(value.createdAt);
	const expiresAt = Date.parse(value.expiresAt);
	const validationTime = now.getTime();
	if (!Number.isFinite(validationTime)) {
		throw new ExactCheckpointError("invalid_envelope", "Checkpoint validation time is invalid");
	}
	if (
		!Number.isFinite(createdAt) ||
		!Number.isFinite(expiresAt) ||
		expiresAt <= createdAt ||
		expiresAt - createdAt > MAX_EXACT_CHECKPOINT_TTL_MS
	) {
		throw new ExactCheckpointError("invalid_envelope", "Checkpoint lifetime is invalid");
	}
	if (createdAt > validationTime) {
		throw new ExactCheckpointError("invalid_envelope", "Checkpoint creation is in the future");
	}
	assertLineage(value.lineage);
	assertAuthority(value.authority);
	assertCompaction(value.compaction);
	assertTypedMessages(value.messages);
	assertDigest(value.integritySha256, "integritySha256");
	const envelope = value as unknown as ExactCheckpointEnvelopeV1;
	if (envelope.integritySha256 !== exactCheckpointDigest(unsignedEnvelope(envelope))) {
		throw new ExactCheckpointError("corrupt", "Checkpoint integrity mismatch");
	}
	if (now.getTime() >= expiresAt) throw new ExactCheckpointError("expired", "Checkpoint has expired");
	return envelope;
}

function compareAuthority(
	actual: ExactCheckpointAuthority,
	expected: ExactCheckpointAuthority,
): readonly (keyof ExactCheckpointAuthority)[] {
	const fields: readonly (keyof ExactCheckpointAuthority)[] = [
		"provider",
		"model",
		"accountWitness",
		"promptCacheIdentity",
		"requestProfileDigest",
		"systemDigest",
		"contextDigest",
		"toolDigest",
		"xdevDigest",
		"workspaceRoot",
		"repositoryBaseOid",
	];
	return fields.filter(field => actual[field] !== expected[field]);
}

function assertExpectedAuthority(
	envelope: ExactCheckpointEnvelopeV1,
	expectedAuthority: ExactCheckpointAuthority,
): void {
	assertAuthority(expectedAuthority);
	const mismatches = compareAuthority(envelope.authority, expectedAuthority);
	if (mismatches.length > 0) {
		throw new ExactCheckpointError(
			"authority_mismatch",
			`Checkpoint authority mismatch: ${mismatches.join(", ")}`,
			mismatches,
		);
	}
}

async function syncDirectory(directory: string): Promise<void> {
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(directory, "r");
		await handle.sync();
	} catch {
		// Atomic link publication still holds on filesystems that reject directory fsync.
	} finally {
		await handle?.close();
	}
}

async function writeAtomicExclusive(targetPath: string, content: string): Promise<void> {
	const directory = path.dirname(targetPath);
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	const tempPath = path.join(directory, `.${path.basename(targetPath)}.${Bun.randomUUIDv7()}.tmp`);
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(tempPath, "wx", 0o600);
		await handle.writeFile(content, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await fs.link(tempPath, targetPath);
		await fs.unlink(tempPath);
		await syncDirectory(directory);
	} catch (error) {
		await handle?.close().catch(() => {});
		await fs.unlink(tempPath).catch(err => {
			if (!isEnoent(err)) throw err;
		});
		throw error;
	}
}

export async function persistExactCheckpoint(options: PersistExactCheckpointOptions): Promise<ExactCheckpointReceipt> {
	assertAuthority(options.authority);
	assertLineage(options.lineage);
	assertCompaction(options.compaction);
	const createdAt = options.createdAt.getTime();
	const expiresAt = options.expiresAt.getTime();
	const validationTime = (options.now ?? new Date()).getTime();
	if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || !Number.isFinite(validationTime)) {
		throw new ExactCheckpointError("invalid_envelope", "Checkpoint lifetime is invalid");
	}
	if (createdAt > validationTime) {
		throw new ExactCheckpointError("invalid_envelope", "Checkpoint creation is in the future");
	}
	if (expiresAt <= createdAt || expiresAt - createdAt > MAX_EXACT_CHECKPOINT_TTL_MS) {
		throw new ExactCheckpointError("invalid_envelope", "Checkpoint lifetime is invalid");
	}
	const messages = canonicalizeMessages(options.messages);
	const unsigned: Omit<ExactCheckpointEnvelopeV1, "integritySha256"> = {
		type: EXACT_CHECKPOINT_TYPE,
		schemaVersion: EXACT_CHECKPOINT_SCHEMA_VERSION,
		checkpointId: options.checkpointId,
		createdAt: options.createdAt.toISOString(),
		expiresAt: options.expiresAt.toISOString(),
		sourceSessionId: options.sourceSessionId,
		committedLeafId: options.committedLeafId,
		lineage: { ...options.lineage },
		authority: { ...options.authority },
		compaction: { ...options.compaction },
		messages,
	};
	const envelope: ExactCheckpointEnvelopeV1 = {
		...unsigned,
		integritySha256: exactCheckpointDigest(unsigned),
	};
	await writeAtomicExclusive(options.checkpointPath, `${canonicalJson(envelope)}\n`);
	return {
		checkpointId: envelope.checkpointId,
		path: options.checkpointPath,
		integritySha256: envelope.integritySha256,
		messageCount: envelope.messages.length,
		compactionEpoch: envelope.compaction.epoch,
		createdAt: envelope.createdAt,
		expiresAt: envelope.expiresAt,
	};
}

export async function loadExactCheckpoint(
	checkpointPath: string,
	expectedAuthority?: ExactCheckpointAuthority,
	now: Date = new Date(),
): Promise<ExactCheckpointEnvelopeV1> {
	let text: string;
	try {
		text = await Bun.file(checkpointPath).text();
	} catch (error) {
		if (isEnoent(error)) throw new ExactCheckpointError("partial", "Checkpoint does not exist");
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new ExactCheckpointError("partial", "Checkpoint is partial or not valid JSON");
	}
	const envelope = validateEnvelope(parsed, now);
	if (expectedAuthority) {
		assertExpectedAuthority(envelope, expectedAuthority);
	}
	return envelope;
}

export async function reserveExactCheckpointClaim(
	integritySha256: string,
	options: ExactCheckpointClaimOptions = {},
): Promise<string> {
	assertDigest(integritySha256, "integritySha256");
	const claimRoot = path.resolve(options.claimRoot ?? path.join(getAgentDir(), EXACT_CHECKPOINT_CLAIMS_DIR_NAME));
	await fs.mkdir(claimRoot, { recursive: true, mode: 0o700 });
	const claimDirectory = path.join(claimRoot, integritySha256);
	try {
		// This non-recursive mkdir is the cross-process one-writer
		// linearization point. Never weaken it to a recursive mkdir.
		await fs.mkdir(claimDirectory, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new ExactCheckpointError("already_consumed", "Checkpoint already has a writer");
		}
		throw error;
	}
	return claimDirectory;
}

export async function consumeExactCheckpoint(
	checkpointPath: string,
	expectedAuthority: ExactCheckpointAuthority,
	options: ConsumeExactCheckpointOptions,
): Promise<ExactCheckpointConsumption> {
	assertDigest(options.expectedIntegritySha256, "expectedIntegritySha256");
	const now = options.now ?? new Date();
	const envelope = await loadExactCheckpoint(checkpointPath, undefined, now);
	if (envelope.integritySha256 !== options.expectedIntegritySha256) {
		throw new ExactCheckpointError("authenticity_mismatch", "Checkpoint does not match the trusted creator receipt");
	}
	assertExpectedAuthority(envelope, expectedAuthority);
	const mode = options.mode ?? "resume";
	const successorSessionId = Bun.randomUUIDv7();
	const successorLineageId = mode === "fork" ? Bun.randomUUIDv7() : envelope.lineage.lineageId;
	const claimDirectory = await reserveExactCheckpointClaim(options.expectedIntegritySha256, {
		claimRoot: options.claimRoot,
	});
	const consumedAt = now.toISOString();
	const claim = {
		type: "exact_checkpoint_consumption_v1",
		checkpointDigest: options.expectedIntegritySha256,
		mode,
		successorIdentity: exactCheckpointDigest(successorSessionId),
		successorLineageWitness: exactCheckpointDigest(successorLineageId),
		consumedAt,
	};
	// mkdir is the cross-process one-writer linearization point. Leave it in
	// place if the anonymous claim receipt fails so a crash cannot reopen it.
	await writeAtomicExclusive(path.join(claimDirectory, "claim.json"), `${canonicalJson(claim)}\n`);
	return { envelope, mode, successorSessionId, successorLineageId, consumedAt };
}
