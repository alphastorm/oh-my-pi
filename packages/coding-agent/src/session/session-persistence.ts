import { isAnthropicServerToolHistoryBlock } from "@oh-my-pi/pi-ai/providers/anthropic-wire";
import {
	type BlobStore,
	externalizeImageDataSync,
	externalizeImageDataUrlSync,
	externalizeTextDataSync,
	isBlobRef,
	isImageDataUrl,
	parseBlobRef,
} from "./blob-store";
import type { FileEntry, PersistedTextBlobLocation, PersistedTextBlobValue } from "./session-entries";

const MAX_INLINE_PERSIST_CHARS = 500_000;
const TRUNCATION_NOTICE = "\n\n[Session persistence truncated large content]";
/** Minimum base64 length to externalize to blob store (skip tiny inline images) */
const BLOB_EXTERNALIZE_THRESHOLD = 1024;
const TEXT_CONTENT_KEY = "content";
/** Parent key under which snapcompact persists its base64 PNG frame archive
 *  (`preserveData.snapcompact.frames[]`). Frame objects are image payloads, so
 *  their base64 must externalize to the blob store rather than fall through to
 *  generic string truncation, which appends {@link TRUNCATION_NOTICE} and
 *  corrupts the base64 the provider decodes on resume. */
const SNAPCOMPACT_FRAMES_KEY = "frames";
const PERSISTED_TEXT_BLOB_TYPE = "omp.session.text-blob.v1";

export type PersistedTextBlob = PersistedTextBlobValue;

export interface PersistedTextBlobMarker {
	type: "omp.session.text-blob.v1";
	ref?: unknown;
	chars?: unknown;
}

/** Recognize the reserved marker type inside entry-owned persistence metadata. */
export function isPersistedTextBlobMarker(value: unknown): value is PersistedTextBlobMarker {
	return typeof value === "object" && value !== null && "type" in value && value.type === PERSISTED_TEXT_BLOB_TYPE;
}

export function isPersistedTextBlob(value: unknown): value is PersistedTextBlob {
	return (
		isPersistedTextBlobMarker(value) &&
		Object.keys(value).length === 3 &&
		typeof value.ref === "string" &&
		parseBlobRef(value.ref) !== null &&
		typeof value.chars === "number" &&
		Number.isSafeInteger(value.chars) &&
		value.chars >= 0
	);
}

/** Detect strings damaged by an older persistence pass so loaders can migrate them safely. */
export function isPersistenceTruncatedString(value: unknown): value is string {
	return typeof value === "string" && value.endsWith(TRUNCATION_NOTICE);
}

export function isImageBlock(value: unknown): value is { type: "image"; data: string; mimeType?: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		(value as { type?: string }).type === "image" &&
		"data" in value &&
		typeof (value as { data?: string }).data === "string"
	);
}

function isImageMimeType(value: unknown): value is string {
	return typeof value === "string" && value.toLowerCase().startsWith("image/");
}

export function isImageDataPayload(value: unknown): value is { data: string; mimeType?: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"data" in value &&
		typeof (value as { data?: string }).data === "string" &&
		(isImageBlock(value) || ("mimeType" in value && isImageMimeType((value as { mimeType?: unknown }).mimeType)))
	);
}

/**
 * True when an image payload sits in a persistence position whose base64 is
 * externalized to the blob store instead of truncated as a generic string: a
 * `content` image block, an `images[]` entry, or a snapcompact frame under
 * `frames[]`. Shared by the persist path ({@link shouldExternalizeImagePayload})
 * and the load path (`resolvePersistedBlobRefs`) so the two never drift and
 * strand a payload externalized on write but not resolved on read.
 */
export function isExternalizableImagePosition(
	value: unknown,
	key: string | undefined,
): value is { data: string; mimeType?: string } {
	if (!isImageDataPayload(value)) return false;
	return (key === TEXT_CONTENT_KEY && isImageBlock(value)) || key === "images" || key === SNAPCOMPACT_FRAMES_KEY;
}

function shouldExternalizeImagePayload(
	value: unknown,
	key: string | undefined,
): value is { data: string; mimeType?: string } {
	if (!isExternalizableImagePosition(value, key)) return false;
	if (isBlobRef(value.data) || value.data.length < BLOB_EXTERNALIZE_THRESHOLD) return false;
	return true;
}

/** True for a non-empty string — marks signature/encrypted fields whose block must persist verbatim. */
function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/** Provider-authenticated history is atomic on both persistence and rehydration. */
export function isProviderAuthenticatedBlock(obj: unknown): boolean {
	if (typeof obj !== "object" || obj === null || !("type" in obj)) return false;
	if (obj.type === "anthropicServerTool" && "block" in obj) {
		const block = obj.block;
		if (typeof block === "object" && block !== null && "type" in block && typeof block.type === "string") {
			const validationView = {
				type: block.type,
				...("name" in block ? { name: block.name } : {}),
				...("id" in block ? { id: block.id } : {}),
				...("tool_use_id" in block ? { tool_use_id: block.tool_use_id } : {}),
				...("content" in block ? { content: block.content } : {}),
			};
			if (isAnthropicServerToolHistoryBlock(validationView)) return true;
		}
	}
	const signed =
		(obj.type === "thinking" && "thinkingSignature" in obj && isNonEmptyString(obj.thinkingSignature)) ||
		(obj.type === "text" && "textSignature" in obj && isNonEmptyString(obj.textSignature)) ||
		(obj.type === "toolCall" && "thoughtSignature" in obj && isNonEmptyString(obj.thoughtSignature));
	const redacted = obj.type === "redactedThinking" && "data" in obj && isNonEmptyString(obj.data);
	const encryptedReasoning =
		obj.type === "reasoning" && "encrypted_content" in obj && isNonEmptyString(obj.encrypted_content);
	return signed || redacted || encryptedReasoning;
}

/**
 * Prepare an entry for bounded, lossless session persistence.
 * Oversized unsigned text is replaced by null and its entry-owned path is
 * recorded separately, so model/tool JSON can never forge a persistence marker.
 */
function externalizeForPersistence(
	obj: unknown,
	blobStore: BlobStore,
	persistedTextBlobs: PersistedTextBlobLocation[],
	valuePath: Array<string | number> = [],
	key?: string,
): unknown {
	if (obj === null || obj === undefined) return obj;
	if (isProviderAuthenticatedBlock(obj)) return obj;
	if (
		typeof obj === "object" &&
		"type" in obj &&
		obj.type === "image_generation_call" &&
		"result" in obj &&
		typeof obj.result === "string" &&
		!isBlobRef(obj.result) &&
		obj.result.length >= BLOB_EXTERNALIZE_THRESHOLD
	) {
		return { ...obj, result: externalizeImageDataSync(blobStore, obj.result) };
	}
	if (shouldExternalizeImagePayload(obj, key)) {
		return { ...obj, data: externalizeImageDataSync(blobStore, obj.data, obj.mimeType) };
	}

	if (typeof obj === "string") {
		if (key === "image_url" && isImageDataUrl(obj)) {
			return externalizeImageDataUrlSync(blobStore, obj);
		}
		if (obj.length > MAX_INLINE_PERSIST_CHARS) {
			if (key === "thinkingSignature" || key === "thoughtSignature" || key === "textSignature") return obj;
			const ref = externalizeTextDataSync(blobStore, obj);
			if (ref === null) return obj;
			persistedTextBlobs.push({
				path: [...valuePath],
				blob: { type: PERSISTED_TEXT_BLOB_TYPE, ref, chars: obj.length },
			});
			return null;
		}
		return obj;
	}

	if (Array.isArray(obj)) {
		let changed = false;
		const result: unknown[] = new Array(obj.length);
		for (let i = 0; i < obj.length; i++) {
			const item = obj[i];
			const newItem = externalizeForPersistence(item, blobStore, persistedTextBlobs, [...valuePath, i], key);
			if (newItem !== item) changed = true;
			result[i] = newItem;
		}
		return changed ? result : obj;
	}

	if (typeof obj === "object") {
		let changed = false;
		const entries: Array<readonly [string, unknown]> = [];
		for (const [childKey, value] of Object.entries(obj)) {
			if (childKey === "jsonlEvents") {
				changed = true;
				continue;
			}
			const newValue = externalizeForPersistence(
				value,
				blobStore,
				persistedTextBlobs,
				[...valuePath, childKey],
				childKey,
			);
			if (newValue !== value) changed = true;
			entries.push([childKey, newValue]);
		}
		return changed ? Object.fromEntries(entries) : obj;
	}

	return obj;
}

/**
 * Read the duplication-relevant fields of an OpenAI Responses reasoning item.
 * Returns `undefined` for anything that is not a `type: "reasoning"` object, so
 * non-reasoning payload entries and corrupt signatures are never matched.
 */
function readReasoningItem(item: unknown): { encrypted_content?: string; id?: string } | undefined {
	if (item === null || typeof item !== "object") return undefined;
	if (!("type" in item) || item.type !== "reasoning") return undefined;
	const reasoning: { encrypted_content?: string; id?: string } = {};
	if ("encrypted_content" in item && typeof item.encrypted_content === "string" && item.encrypted_content.length > 0) {
		reasoning.encrypted_content = item.encrypted_content;
	}
	if ("id" in item && typeof item.id === "string" && item.id.length > 0) reasoning.id = item.id;
	return reasoning;
}

/**
 * True when a `thinkingSignature` (a JSON-encoded reasoning item) is already
 * carried by a reasoning item in the message's provider payload — matched on
 * `encrypted_content` (the load-bearing blob) when present, else on item `id`.
 * A signature the payload does not cover is never reported as recoverable, so it
 * is always kept.
 */
function signatureCoveredByPayload(
	signature: string,
	encrypted: ReadonlySet<string>,
	ids: ReadonlySet<string>,
): boolean {
	let parsed: unknown;
	try {
		parsed = JSON.parse(signature);
	} catch {
		return false;
	}
	const reasoning = readReasoningItem(parsed);
	if (!reasoning) return false;
	if (reasoning.encrypted_content) return encrypted.has(reasoning.encrypted_content);
	if (reasoning.id) return ids.has(reasoning.id);
	return false;
}

/**
 * Drop `thinkingSignature` from assistant thinking blocks whose reasoning item is
 * already carried, verbatim, in the message's OpenAI Responses `providerPayload`.
 *
 * Responses/Codex turns mint each reasoning item once and store it twice:
 * `providerPayload.items` (the authoritative native-history copy that replay and
 * remote compaction read) and `content[].thinkingSignature`, which is literally
 * `JSON.stringify(reasoningItem)` — including the large `encrypted_content` blob.
 * Replay only ever reads the payload; the signature is a no-payload fallback that
 * same-provider turns never reach and cross-model turns strip as untrustworthy.
 * Persisting both stores the encrypted reasoning twice for zero token or replay
 * benefit, so the on-disk copy drops the duplicate signature whenever its
 * reasoning item is recoverable from the payload. The in-memory entry is left
 * untouched; only the serialized line is slimmed.
 */
function stripReplayedReasoningSignatures(entry: FileEntry): FileEntry {
	if (entry.type !== "message" || entry.message.role !== "assistant") return entry;
	const message = entry.message;
	const payload = message.providerPayload;
	if (payload?.type !== "openaiResponsesHistory" || !Array.isArray(payload.items)) return entry;
	const hasSignedThinking = message.content.some(
		block =>
			block.type === "thinking" && typeof block.thinkingSignature === "string" && block.thinkingSignature.length > 0,
	);
	if (!hasSignedThinking) return entry;

	const encrypted = new Set<string>();
	const ids = new Set<string>();
	for (const rawItem of payload.items) {
		const reasoning = readReasoningItem(rawItem);
		if (!reasoning) continue;
		if (reasoning.encrypted_content) encrypted.add(reasoning.encrypted_content);
		if (reasoning.id) ids.add(reasoning.id);
	}
	if (encrypted.size === 0 && ids.size === 0) return entry;

	let changed = false;
	const content = message.content.map(block => {
		if (
			block.type !== "thinking" ||
			typeof block.thinkingSignature !== "string" ||
			block.thinkingSignature.length === 0
		) {
			return block;
		}
		if (!signatureCoveredByPayload(block.thinkingSignature, encrypted, ids)) return block;
		changed = true;
		return { ...block, thinkingSignature: undefined };
	});
	if (!changed) return entry;
	return { ...entry, message: { ...message, content } };
}

export function prepareEntryForPersistence(entry: FileEntry, blobStore: BlobStore): FileEntry {
	const stripped = stripReplayedReasoningSignatures(entry);
	if (stripped.type === "session") return stripped;
	const persistedTextBlobs: PersistedTextBlobLocation[] = [];
	const prepared = externalizeForPersistence(stripped, blobStore, persistedTextBlobs) as typeof stripped;
	if (persistedTextBlobs.length === 0) return prepared;
	return { ...prepared, persistedTextBlobs };
}
