import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { getBlobsDir, isEnoent, parseJsonlLenient } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { BlobStore, isBlobRef, resolveImageData, resolveImageDataUrl, resolveTextData } from "./blob-store";
import { buildSessionContext } from "./session-context";
import type { FileEntry, RawFileEntry, SessionEntry, SessionHeader } from "./session-entries";
import { migrateToCurrentVersion } from "./session-migrations";
import {
	isExternalizableImagePosition,
	isImageDataPayload,
	isPersistedTextBlob,
	isPersistenceTruncatedString,
	isProviderAuthenticatedBlock,
} from "./session-persistence";
import { FileSessionStorage, type SessionStorage } from "./session-storage";
import {
	parseTitleSlotFromContent,
	parseTitleSlotLine,
	type SessionTitleUpdate,
	titleUpdateFromSlot,
} from "./session-title-slot";

const STREAM_LOAD_THRESHOLD_BYTES = 8 * 1024 * 1024;
const STREAM_YIELD_BYTES = 1 * 1024 * 1024;
const STREAM_YIELD_ENTRIES = 8_192;

export interface VisitEntriesFromFileStreamOptions {
	/** Stop after the visitor returns `false`. */
	shouldContinue?: () => boolean;
	/** Stop after this many valid or malformed JSONL records have been consumed. */
	maxRecords?: number;
	/** Read at most this many bytes from the file's current prefix. */
	maxBytes?: number;
	/** Yield to the macrotask queue after this many bytes have been consumed. */
	yieldEveryBytes?: number;
	/** Yield to the macrotask queue after this many entries have been visited. */
	yieldEveryEntries?: number;
	/** Called once for every malformed JSONL record skipped by the stream. */
	onMalformedRecord?: () => void;
}

/** Parsed session entries plus corruption metadata needed by writable loaders. */
export interface SessionLoadResult {
	entries: FileEntry[];
	titleSlot: SessionTitleUpdate | undefined;
	malformedRecords: number;
	/** Whether non-empty session data was found without a valid leading session header. */
	invalidHeader: boolean;
}

function splitTitleSlot(content: string): { body: string; slot: SessionTitleUpdate | undefined } {
	const slot = titleUpdateFromSlot(parseTitleSlotFromContent(content));
	if (!slot) return { body: content, slot: undefined };
	const newlineIndex = content.indexOf("\n");
	return { body: content.slice(newlineIndex + 1), slot };
}

function isValidSessionHeader(entry: FileEntry | undefined): entry is SessionHeader {
	return entry?.type === "session" && typeof entry.id === "string";
}

function applyTitleSlot(entry: FileEntry | undefined, slot: SessionTitleUpdate | undefined): void {
	if (!slot || !isValidSessionHeader(entry)) return;
	if (slot.title && slot.title.length > 0) {
		entry.title = slot.title;
	} else {
		delete entry.title;
	}
	if (slot.source) {
		entry.titleSource = slot.source;
	} else {
		delete entry.titleSource;
	}
}

/** Parse session JSONL while stripping and folding the optional fixed title slot. */
export function parseSessionContent(content: string): SessionLoadResult {
	const { body, slot } = splitTitleSlot(content);
	let malformedRecords = 0;
	const entries = parseJsonlLenient<RawFileEntry>(body, {
		onMalformedRecord: () => {
			malformedRecords++;
		},
	}) as FileEntry[];
	applyTitleSlot(entries[0], slot);
	return {
		entries,
		titleSlot: slot,
		malformedRecords,
		invalidHeader: entries.length > 0 ? !isValidSessionHeader(entries[0]) : malformedRecords > 0,
	};
}

/** Parse session JSONL and visit each entry without retaining prior entries. */
export async function visitEntriesFromFileStream(
	filePath: string,
	visit: (entry: FileEntry) => void | boolean,
	options: VisitEntriesFromFileStreamOptions = {},
): Promise<SessionTitleUpdate | undefined> {
	let titleSlot: SessionTitleUpdate | undefined;
	let sawFirstLine = false;
	let sawFirstEntry = false;
	let bytesSinceYield = 0;
	let entriesSinceYield = 0;
	let recordsSeen = 0;
	const maxRecords = Math.max(0, options.maxRecords ?? Number.POSITIVE_INFINITY);
	let stopped = false;
	let visitorThrew = false;
	const yieldEveryBytes = Math.max(0, options.yieldEveryBytes ?? STREAM_YIELD_BYTES);
	const yieldEveryEntries = Math.max(0, options.yieldEveryEntries ?? STREAM_YIELD_ENTRIES);
	const maxBytes = Math.max(0, options.maxBytes ?? Number.POSITIVE_INFINITY);
	// Byte buffer (NOT a decoded string): multibyte UTF-8 sequences that straddle
	// a stream-chunk boundary stay intact, and Bun.JSONL.parseChunk accepts typed
	// arrays directly. Only the unconsumed remainder is held (≤ one record + a
	// chunk), so the ≥8MiB memory guard is preserved (the file is never fully
	// loaded into memory).
	let buffer: Uint8Array = new Uint8Array();
	const decoder = new TextDecoder();

	const yieldToMacrotask = async (): Promise<void> => {
		if (yieldEveryBytes === 0 && yieldEveryEntries === 0) return;
		const bytesReady = yieldEveryBytes === 0 || bytesSinceYield < yieldEveryBytes;
		const entriesReady = yieldEveryEntries === 0 || entriesSinceYield < yieldEveryEntries;
		if (bytesReady && entriesReady) {
			return;
		}
		bytesSinceYield = 0;
		entriesSinceYield = 0;
		await Bun.sleep(0);
	};

	const drain = async (): Promise<void> => {
		while (buffer.length > 0 && !stopped) {
			if (recordsSeen >= maxRecords) {
				stopped = true;
				break;
			}
			const { values, error, read, done } = Bun.JSONL.parseChunk(buffer);
			for (const value of values) {
				if (recordsSeen >= maxRecords) {
					stopped = true;
					break;
				}
				if (options.shouldContinue && !options.shouldContinue()) {
					stopped = true;
					break;
				}
				const entry = value as FileEntry;
				if (!sawFirstEntry) {
					sawFirstEntry = true;
					applyTitleSlot(entry, titleSlot);
				}
				try {
					if (visit(entry) === false) {
						stopped = true;
						break;
					}
					recordsSeen++;
					entriesSinceYield++;
					if (recordsSeen >= maxRecords) {
						stopped = true;
						break;
					}
				} catch (err) {
					visitorThrew = true;
					throw err;
				}
				await yieldToMacrotask();
			}
			if (stopped) break;
			if (error) {
				// Malformed record: skip past the next newline and continue.
				const nextNewline = buffer.indexOf(0x0a, read);
				if (nextNewline === -1) break; // rest of the bad line not yet received
				let nonWhitespace = false;
				for (let index = read; index < nextNewline; index++) {
					const byte = buffer[index];
					if (byte !== 0x09 && byte !== 0x0d && byte !== 0x20) {
						nonWhitespace = true;
						break;
					}
				}
				if (nonWhitespace) options.onMalformedRecord?.();
				recordsSeen++;
				buffer = buffer.subarray(nextNewline + 1);
				if (recordsSeen >= maxRecords) {
					stopped = true;
					break;
				}
				continue;
			}
			if (read === 0) break; // incomplete record awaiting more data
			buffer = buffer.subarray(read);
			if (done) {
				buffer = new Uint8Array();
				break;
			}
		}
	};

	try {
		const file = Bun.file(filePath);
		const source = Number.isFinite(maxBytes) ? file.slice(0, maxBytes) : file;
		for await (const chunk of source.stream()) {
			if (stopped) break;
			bytesSinceYield += chunk.byteLength;
			buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
			// The optional fixed-width title slot is a physical first line that is
			// NOT JSON; peel it before the parser would (correctly) reject it. The
			// first line ends at a '\n' byte, so it is a complete UTF-8 sequence and
			// safe to decode. A non-slot first line is a real entry and is left for
			// the parser; a blank first line is left for the parser to skip.
			if (!sawFirstLine) {
				const newline = buffer.indexOf(0x0a);
				if (newline !== -1) {
					sawFirstLine = true;
					const firstLine = decoder.decode(buffer.subarray(0, newline)).trim();
					if (firstLine) {
						const slot = parseTitleSlotLine(firstLine);
						if (slot) {
							titleSlot = titleUpdateFromSlot(slot);
							buffer = buffer.subarray(newline + 1);
						}
					}
				}
			}
			await drain();
			await yieldToMacrotask();
		}
		// A trailing record without a final newline: terminate it so the parser
		// can complete it (readline yielded it; parseChunk needs the delimiter).
		if (!stopped && buffer.length > 0 && buffer[buffer.length - 1] !== 0x0a) {
			buffer = Buffer.concat([buffer, new Uint8Array([0x0a])]);
			await drain();
		}
	} catch (err) {
		if (visitorThrew) throw err;
		if (isEnoent(err)) return undefined;
		throw err;
	}

	return titleSlot;
}

/** Exported for testing — the ≥8MiB streaming path (works on any file size). */
export async function loadEntriesFromFileStream(filePath: string): Promise<SessionLoadResult> {
	const entries: FileEntry[] = [];
	let malformedRecords = 0;
	const titleSlot = await visitEntriesFromFileStream(
		filePath,
		entry => {
			entries.push(entry);
		},
		{
			onMalformedRecord: () => {
				malformedRecords++;
			},
		},
	);
	return {
		entries,
		titleSlot,
		malformedRecords,
		invalidHeader: entries.length > 0 ? !isValidSessionHeader(entries[0]) : malformedRecords > 0,
	};
}

/** Exported for compaction.test.ts */
export function parseSessionEntries(content: string): FileEntry[] {
	return parseSessionContent(content).entries;
}

function shouldStreamEntries(storage: SessionStorage, size: number): boolean {
	return storage instanceof FileSessionStorage && size >= STREAM_LOAD_THRESHOLD_BYTES;
}

async function loadWithKnownSize(filePath: string, storage: SessionStorage, size: number): Promise<SessionLoadResult> {
	const loaded = shouldStreamEntries(storage, size)
		? await loadEntriesFromFileStream(filePath)
		: parseSessionContent(await storage.readText(filePath));
	return loaded.invalidHeader ? { ...loaded, entries: [] } : loaded;
}

/** Load and validate a session while retaining malformed-record diagnostics. */
export async function loadSessionFile(
	filePath: string,
	storage: SessionStorage = new FileSessionStorage(),
): Promise<SessionLoadResult> {
	try {
		return await loadWithKnownSize(filePath, storage, storage.statSync(filePath).size);
	} catch (err) {
		if (isEnoent(err)) return { entries: [], titleSlot: undefined, malformedRecords: 0, invalidHeader: false };
		throw err;
	}
}

/** Load the valid entries from a session file, skipping malformed records. */
export async function loadEntriesFromFile(
	filePath: string,
	storage: SessionStorage = new FileSessionStorage(),
): Promise<FileEntry[]> {
	return (await loadSessionFile(filePath, storage)).entries;
}

/**
 * Visit session entries, using bounded streaming for large file-backed journals.
 * Small files and non-file backends keep the existing full-load path.
 */
export async function visitEntriesFromFile(
	filePath: string,
	visit: (entry: FileEntry) => void | boolean,
	storage: SessionStorage = new FileSessionStorage(),
): Promise<void> {
	const size = storage.statSync(filePath).size;
	if (shouldStreamEntries(storage, size)) {
		let sawFirstEntry = false;
		await visitEntriesFromFileStream(filePath, entry => {
			if (!sawFirstEntry) {
				sawFirstEntry = true;
				if (!isValidSessionHeader(entry)) return false;
			}
			return visit(entry);
		});
		return;
	}

	for (const entry of (await loadWithKnownSize(filePath, storage, size)).entries) {
		if (visit(entry) === false) return;
	}
}

function shouldResolveImagePayload(value: unknown, key?: string): value is { data: string; mimeType?: string } {
	return isExternalizableImagePosition(value, key) && isBlobRef(value.data);
}

function invalidTextBlobMetadata(detail: string): Error {
	return new Error(`Invalid persisted text blob metadata: ${detail}`);
}

type TextBlobTarget = { container: unknown[] | Record<string, unknown>; key: string | number };

function locateTextBlobTarget(entry: FileEntry, path: unknown): TextBlobTarget {
	if (!Array.isArray(path) || path.length === 0) throw invalidTextBlobMetadata("path must be non-empty");
	let current: unknown = entry;
	for (let i = 0; i < path.length; i++) {
		if (isProviderAuthenticatedBlock(current)) {
			throw invalidTextBlobMetadata("path enters a provider-authenticated block");
		}
		const segment = path[i];
		const isLast = i === path.length - 1;
		if (Array.isArray(current)) {
			if (!Number.isSafeInteger(segment) || (segment as number) < 0 || !Object.hasOwn(current, segment as number)) {
				throw invalidTextBlobMetadata("array path segment does not exist");
			}
			if (isLast) {
				if (current[segment as number] !== null)
					throw invalidTextBlobMetadata("path must target a null placeholder");
				return { container: current, key: segment as number };
			}
			current = current[segment as number];
			continue;
		}
		if (typeof current !== "object" || current === null || typeof segment !== "string") {
			throw invalidTextBlobMetadata("object path segment is invalid");
		}
		const record = current as Record<string, unknown>;
		if (!Object.hasOwn(record, segment)) throw invalidTextBlobMetadata("object path segment does not exist");
		if (isLast) {
			if (record[segment] !== null) throw invalidTextBlobMetadata("path must target a null placeholder");
			return { container: record, key: segment };
		}
		current = record[segment];
	}
	throw invalidTextBlobMetadata("path is empty");
}

async function resolveEntryTextBlobs(entry: FileEntry, blobStore: BlobStore): Promise<void> {
	const metadata = (entry as FileEntry & { persistedTextBlobs?: unknown }).persistedTextBlobs;
	if (!Array.isArray(metadata) || metadata.length === 0) throw invalidTextBlobMetadata("expected a non-empty array");

	const seenPaths = new Set<string>();
	const validated = metadata.map(location => {
		if (
			typeof location !== "object" ||
			location === null ||
			Object.keys(location).length !== 2 ||
			!("path" in location) ||
			!("blob" in location) ||
			!isPersistedTextBlob(location.blob)
		) {
			throw invalidTextBlobMetadata("location shape is invalid");
		}
		const pathKey = JSON.stringify(location.path);
		if (seenPaths.has(pathKey)) throw invalidTextBlobMetadata("duplicate path");
		seenPaths.add(pathKey);
		return {
			target: locateTextBlobTarget(entry, location.path),
			blob: location.blob,
		};
	});

	const texts = await Promise.all(validated.map(({ blob }) => resolveTextData(blobStore, blob.ref, blob.chars)));
	for (let i = 0; i < validated.length; i++) {
		const { container, key } = validated[i]!.target;
		const text = texts[i]!;
		if (Array.isArray(container)) {
			container[key as number] = text;
		} else {
			Object.defineProperty(container, key, {
				value: text,
				writable: true,
				enumerable: true,
				configurable: true,
			});
		}
	}
	delete (entry as FileEntry & { persistedTextBlobs?: unknown }).persistedTextBlobs;
}

async function resolvePersistedBlobRefs(value: unknown, blobStore: BlobStore, key?: string): Promise<unknown> {
	if (isProviderAuthenticatedBlock(value)) return value;
	if (shouldResolveImagePayload(value, key)) {
		if (typeof value === "string") return await resolveImageData(blobStore, value);
		if (Array.isArray(value)) {
			return await Promise.all(
				value.map(async item => (typeof item === "string" ? await resolveImageData(blobStore, item) : item)),
			);
		}
		if (isImageDataPayload(value)) {
			return { ...value, data: await resolveImageData(blobStore, value.data) };
		}
	}
	if (typeof value === "string") {
		if (key === "image_url" && isBlobRef(value)) {
			return await resolveImageDataUrl(blobStore, value);
		}
		return value;
	}
	if (Array.isArray(value)) {
		return await Promise.all(value.map(async item => await resolvePersistedBlobRefs(item, blobStore, key)));
	}
	if (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		value.type === "image_generation_call" &&
		"result" in value &&
		typeof value.result === "string" &&
		isBlobRef(value.result)
	) {
		return { ...value, result: await resolveImageData(blobStore, value.result) };
	}
	if (typeof value === "object" && value !== null) {
		const entries = await Promise.all(
			Object.entries(value).map(async ([childKey, child]) => [
				childKey,
				await resolvePersistedBlobRefs(child, blobStore, childKey),
			]),
		);
		return Object.fromEntries(entries);
	}
	return value;
}

function containsBlobRef(value: unknown): boolean {
	if (isProviderAuthenticatedBlock(value)) return false;
	if (typeof value === "string") return isBlobRef(value);
	if (Array.isArray(value)) {
		for (const item of value) {
			if (containsBlobRef(item)) return true;
		}
		return false;
	}
	if (typeof value === "object" && value !== null) {
		for (const child of Object.values(value)) {
			if (containsBlobRef(child)) return true;
		}
	}
	return false;
}

/**
 * Older persistence versions truncated oversized frame base64 in place. Recover
 * those archives from their retained source text so an already-wedged session
 * resumes as text instead of sending malformed image data to the provider.
 */
function repairTruncatedSnapcompactFrames(entry: FileEntry): void {
	if (entry.type !== "compaction") return;
	const archive = snapcompact.getPreservedArchive(entry.preserveData);
	if (!archive?.frames.some(frame => isPersistenceTruncatedString(frame.data))) return;
	const slot = entry.preserveData?.[snapcompact.PRESERVE_KEY];
	if (typeof slot !== "object" || slot === null) return;

	if (archive.text) {
		Object.assign(slot, { frames: [], textHead: archive.text, textTail: "" });
		return;
	}
	Object.assign(slot, {
		frames: archive.frames.filter(frame => !isPersistenceTruncatedString(frame.data)),
	});
}

export async function resolveBlobRefsInEntries(entries: FileEntry[], blobStore: BlobStore): Promise<void> {
	const pending: Promise<void>[] = [];
	for (const entry of entries) {
		if (entry.type === "session") continue;
		repairTruncatedSnapcompactFrames(entry);
		const hasTextMetadata = Object.hasOwn(entry, "persistedTextBlobs");
		if (!hasTextMetadata && !containsBlobRef(entry)) continue;
		pending.push(
			(async () => {
				if (hasTextMetadata) await resolveEntryTextBlobs(entry, blobStore);
				if (!containsBlobRef(entry)) return;
				const resolved = await resolvePersistedBlobRefs(entry, blobStore);
				if (typeof resolved === "object" && resolved !== null) Object.assign(entry, resolved);
			})(),
		);
	}
	await Promise.all(pending);
}

/**
 * Read-only transcript view of a session file: load entries, migrate to the
 * current version, resolve blob refs, and build the display transcript along
 * the persisted leaf path (last entry). Uses transcript mode (collapsed to the
 * latest compaction) so failed/aborted tail turns stay visible, unlike the
 * provider-context builder which drops them. Does NOT create a writer or take
 * the session lock — safe to call against a file another session is writing.
 */
export async function loadSessionMessagesReadOnly(filePath: string): Promise<AgentMessage[]> {
	const entries = await loadEntriesFromFile(filePath);
	if (entries.length === 0) return [];
	migrateToCurrentVersion(entries);
	await resolveBlobRefsInEntries(entries, new BlobStore(getBlobsDir()));
	const sessionEntries = entries.filter((e): e is SessionEntry => e.type !== "session");
	return buildSessionContext(sessionEntries, undefined, undefined, {
		transcript: true,
		collapseCompactedHistory: true,
	}).messages;
}
