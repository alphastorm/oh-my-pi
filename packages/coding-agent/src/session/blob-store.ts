import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";

const BLOB_PREFIX = "blob:sha256:";

/** Canonical blob hash shape: exactly 64 lowercase hex chars (a SHA-256 digest). */
export const BLOB_HASH_RE = /^[a-f0-9]{64}$/;

export interface BlobPutOptions {
	/** Optional file extension for a sidecar hardlink/copy that OS openers can type-detect. */
	extension?: string;
}

export interface BlobPutResult {
	hash: string;
	/** Canonical content-addressed path, always `<dir>/<sha256-hex>`. */
	path: string;
	/** Path with the requested extension when supplied, otherwise the canonical path. */
	displayPath: string;
	get ref(): string;
}

/**
 * Content-addressed blob store for externalizing large binary data (images) from session JSONL files.
 *
 * Files are stored canonically at `<dir>/<sha256-hex>`. Callers may also request
 * a typed sidecar path (`<dir>/<sha256-hex>.<ext>`) for `file://` links and OS
 * image viewers; blob refs and reads still address the extensionless hash path.
 * The SHA-256 hash is computed over the raw binary data (not base64).
 * Content-addressing makes writes idempotent and provides automatic deduplication
 * across sessions.
 */

const IMAGE_EXTENSION_BY_MIME: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/svg+xml": "svg",
};

function normalizeBlobExtension(extension: string | undefined): string | undefined {
	if (!extension) return undefined;
	const normalized = extension.startsWith(".") ? extension.slice(1) : extension;
	if (normalized.length === 0 || normalized.length > 32) return undefined;
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(normalized)) return undefined;
	return normalized.toLowerCase();
}

async function ensureDisplayPath(blobPath: string, displayPath: string, data: Buffer): Promise<void> {
	if (displayPath === blobPath) return;
	try {
		await fsp.link(blobPath, displayPath);
		return;
	} catch (err) {
		if (typeof err === "object" && err !== null && "code" in err && err.code === "EEXIST") return;
		logger.debug("Blob display hardlink failed; falling back to copy", {
			blobPath,
			displayPath,
			error: err instanceof Error ? err.message : String(err),
		});
	}
	await Bun.write(displayPath, data);
}

function ensureDisplayPathSync(blobPath: string, displayPath: string, data: Buffer): void {
	if (displayPath === blobPath) return;
	try {
		fs.linkSync(blobPath, displayPath);
		return;
	} catch (err) {
		if (typeof err === "object" && err !== null && "code" in err && err.code === "EEXIST") return;
		logger.debug("Blob display hardlink failed; falling back to copy", {
			blobPath,
			displayPath,
			error: err instanceof Error ? err.message : String(err),
		});
	}
	fs.writeFileSync(displayPath, data);
}

function hasFsCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function blobMatchesHash(data: Buffer, expectedHash: string): boolean {
	return new Bun.SHA256().update(data).digest("hex") === expectedHash;
}

function isUnsupportedDirectorySync(error: unknown): boolean {
	if (hasFsCode(error, "EINVAL") || hasFsCode(error, "ENOTSUP") || hasFsCode(error, "ENOSYS")) return true;
	return process.platform === "win32" && (hasFsCode(error, "EPERM") || hasFsCode(error, "EISDIR"));
}

async function syncDirectory(directory: string): Promise<void> {
	let handle: fsp.FileHandle | undefined;
	try {
		handle = await fsp.open(directory, "r");
		await handle.sync();
	} catch (error) {
		if (!isUnsupportedDirectorySync(error)) throw error;
	} finally {
		await handle?.close();
	}
}

function syncDirectorySync(directory: string): void {
	let fd: number | undefined;
	try {
		fd = fs.openSync(directory, "r");
		fs.fsyncSync(fd);
	} catch (error) {
		if (!isUnsupportedDirectorySync(error)) throw error;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

async function existingBlobMatches(blobPath: string, hash: string): Promise<boolean> {
	try {
		return blobMatchesHash(await fsp.readFile(blobPath), hash);
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

function existingBlobMatchesSync(blobPath: string, hash: string): boolean {
	try {
		return blobMatchesHash(fs.readFileSync(blobPath), hash);
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

async function publishBlob(blobPath: string, data: Buffer, hash: string): Promise<void> {
	const directory = path.dirname(blobPath);
	await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
	if (await existingBlobMatches(blobPath, hash)) return;

	const tempPath = path.join(directory, `.${path.basename(blobPath)}.${Bun.randomUUIDv7()}.tmp`);
	let handle: fsp.FileHandle | undefined;
	let tempExists = false;
	try {
		handle = await fsp.open(tempPath, "wx", 0o600);
		tempExists = true;
		await handle.writeFile(data);
		await handle.sync();
		await handle.close();
		handle = undefined;
		try {
			await fsp.link(tempPath, blobPath);
		} catch (error) {
			if (!hasFsCode(error, "EEXIST")) throw error;
			if (!(await existingBlobMatches(blobPath, hash))) {
				// The predecessor wrote canonical paths directly. Replace only content
				// that violates its own hash name, using the complete fsynced temp file.
				await fsp.rename(tempPath, blobPath);
				tempExists = false;
			}
		}
		if (tempExists) {
			await fsp.unlink(tempPath);
			tempExists = false;
		}
		await syncDirectory(directory);
	} catch (error) {
		await handle?.close().catch(() => {});
		if (tempExists) await fsp.unlink(tempPath).catch(() => {});
		throw error;
	}
}

function publishBlobSync(blobPath: string, data: Buffer, hash: string): void {
	const directory = path.dirname(blobPath);
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	if (existingBlobMatchesSync(blobPath, hash)) return;

	const tempPath = path.join(directory, `.${path.basename(blobPath)}.${Bun.randomUUIDv7()}.tmp`);
	let fd: number | undefined;
	let tempExists = false;
	try {
		fd = fs.openSync(tempPath, "wx", 0o600);
		tempExists = true;
		fs.writeFileSync(fd, data);
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		try {
			fs.linkSync(tempPath, blobPath);
		} catch (error) {
			if (!hasFsCode(error, "EEXIST")) throw error;
			if (!existingBlobMatchesSync(blobPath, hash)) {
				fs.renameSync(tempPath, blobPath);
				tempExists = false;
			}
		}
		if (tempExists) {
			fs.unlinkSync(tempPath);
			tempExists = false;
		}
		syncDirectorySync(directory);
	} catch (error) {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {}
		}
		if (tempExists) {
			try {
				fs.unlinkSync(tempPath);
			} catch {}
		}
		throw error;
	}
}

export function blobExtensionForImageMimeType(mimeType: string | undefined): string | undefined {
	if (!mimeType) return undefined;
	const lower = mimeType.toLowerCase();
	const known = IMAGE_EXTENSION_BY_MIME[lower];
	if (known) return known;
	if (!lower.startsWith("image/")) return undefined;
	const subtype = lower.slice("image/".length).split(";")[0]?.split("+")[0];
	return normalizeBlobExtension(subtype);
}

export class BlobStore {
	constructor(readonly dir: string) {}

	/**
	 * Write binary data to the blob store.
	 * @returns SHA-256 hex hash of the data
	 */
	async put(data: Buffer, options?: BlobPutOptions): Promise<BlobPutResult> {
		// The first await in publishBlob yields to the caller. Snapshot caller-owned
		// bytes before hashing so later mutation cannot publish under a stale path.
		const stableData = Buffer.from(data);
		const hash = new Bun.SHA256().update(stableData).digest("hex");
		const blobPath = path.join(this.dir, hash);
		const extension = normalizeBlobExtension(options?.extension);
		const displayPath = extension ? `${blobPath}.${extension}` : blobPath;
		const result = {
			hash,
			path: blobPath,
			displayPath,
			get ref() {
				return `${BLOB_PREFIX}${hash}`;
			},
		};

		await publishBlob(blobPath, stableData, hash);
		await ensureDisplayPath(blobPath, displayPath, stableData);
		return result;
	}

	/**
	 * Synchronous variant of {@link put}. Use on persistence hot paths where the caller
	 * cannot afford the microtask hops of the async version (e.g. OOM-safe session writes).
	 * Returns once the bytes are in the kernel page cache.
	 */
	putSync(data: Buffer, options?: BlobPutOptions): BlobPutResult {
		const hash = new Bun.SHA256().update(data).digest("hex");
		const blobPath = path.join(this.dir, hash);
		const extension = normalizeBlobExtension(options?.extension);
		const displayPath = extension ? `${blobPath}.${extension}` : blobPath;
		const result = {
			hash,
			path: blobPath,
			displayPath,
			get ref() {
				return `${BLOB_PREFIX}${hash}`;
			},
		};
		publishBlobSync(blobPath, data, hash);
		ensureDisplayPathSync(blobPath, displayPath, data);
		return result;
	}

	/** Read blob by hash, returns Buffer or null if not found. */
	async get(hash: string): Promise<Buffer | null> {
		const blobPath = path.join(this.dir, hash);
		try {
			const file = Bun.file(blobPath);
			const ab = await file.arrayBuffer();
			return Buffer.from(ab);
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
	}

	/** Synchronous variant of {@link get}. */
	getSync(hash: string): Buffer | null {
		const blobPath = path.join(this.dir, hash);
		try {
			return fs.readFileSync(blobPath);
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
	}

	/** Check if a blob exists. */
	async has(hash: string): Promise<boolean> {
		try {
			await fsp.access(path.join(this.dir, hash));
			return true;
		} catch {
			return false;
		}
	}
}

/** Check if a data string is a blob reference. */
export function isBlobRef(data: string): boolean {
	return data.startsWith(BLOB_PREFIX);
}

/**
 * Extract the SHA-256 hash from a blob reference string.
 *
 * Returns null when the string is not a blob ref, or when the suffix is not a
 * canonical 64-char lowercase hex hash. Rejecting non-hash suffixes here is the
 * single choke point that keeps every resolution path confined to the blob dir:
 * `get`/`getSync` feed this value into `path.join(this.dir, hash)`, so an
 * unvalidated `../` suffix would otherwise escape the store and read arbitrary files.
 */
export function parseBlobRef(data: string): string | null {
	if (!data.startsWith(BLOB_PREFIX)) return null;
	const hash = data.slice(BLOB_PREFIX.length);
	if (!BLOB_HASH_RE.test(hash)) {
		logger.warn("Rejected malformed blob reference", { suffix: hash });
		return null;
	}
	return hash;
}

/** Identify provider transport image data URLs so persistence can externalize and restore them losslessly. */
export function isImageDataUrl(data: string): boolean {
	return data.startsWith("data:image/") && data.includes(";base64,");
}

/**
 * Externalize a provider image data URL to the blob store, returning a blob reference.
 * The full data URL string is preserved so transport-native history can be reconstructed on resume.
 */
export async function externalizeImageDataUrl(blobStore: BlobStore, dataUrl: string): Promise<string> {
	if (isBlobRef(dataUrl)) return dataUrl;
	const { ref } = await blobStore.put(Buffer.from(dataUrl, "utf8"));
	return ref;
}

/** Synchronous variant of {@link externalizeImageDataUrl}. */
export function externalizeImageDataUrlSync(blobStore: BlobStore, dataUrl: string): string {
	if (isBlobRef(dataUrl)) return dataUrl;
	return blobStore.putSync(Buffer.from(dataUrl, "utf8")).ref;
}

/** Externalize replay-critical text, or return null when UTF-8 cannot represent its code units exactly. */
export function externalizeTextDataSync(blobStore: BlobStore, text: string): string | null {
	for (let i = 0; i < text.length; i++) {
		const codeUnit = text.charCodeAt(i);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			const next = text.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				i++;
				continue;
			}
			return null;
		}
		if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return null;
	}
	return blobStore.putSync(Buffer.from(text, "utf8")).ref;
}

/**
 * Externalize an image's base64 data to the blob store, returning a blob reference.
 * If the data is already a blob reference, returns it unchanged.
 */
export async function externalizeImageData(
	blobStore: BlobStore,
	base64Data: string,
	mimeType?: string,
): Promise<string> {
	if (isBlobRef(base64Data)) return base64Data;
	const buffer = Buffer.from(base64Data, "base64");
	const { ref } = await blobStore.put(buffer, {
		extension: blobExtensionForImageMimeType(mimeType),
	});
	return ref;
}

/** Synchronous variant of {@link externalizeImageData}. */
export function externalizeImageDataSync(blobStore: BlobStore, base64Data: string, mimeType?: string): string {
	if (isBlobRef(base64Data)) return base64Data;
	return blobStore.putSync(Buffer.from(base64Data, "base64"), {
		extension: blobExtensionForImageMimeType(mimeType),
	}).ref;
}

/**
 * Resolve an externalized provider image data URL back to its original string.
 * If the data is not a blob reference, returns it unchanged.
 * If the blob is missing, logs a warning and returns the reference as-is.
 */
export async function resolveImageDataUrl(blobStore: BlobStore, data: string): Promise<string> {
	const hash = parseBlobRef(data);
	if (!hash) return data;

	const buffer = await blobStore.get(hash);
	if (!buffer) {
		logger.warn("Blob not found for persisted image data URL", { hash });
		return data;
	}
	return buffer.toString("utf8");
}

/** Resolve and validate replay-critical UTF-8 text externalized by session persistence. */
export async function resolveTextData(blobStore: BlobStore, data: string, expectedChars: number): Promise<string> {
	const hash = parseBlobRef(data);
	if (!hash) throw new Error("Invalid persisted text blob reference");

	const buffer = await blobStore.get(hash);
	if (!buffer) throw new Error(`Missing persisted text blob: ${hash}`);
	const actualHash = new Bun.SHA256().update(buffer).digest("hex");
	if (actualHash !== hash) throw new Error(`Persisted text blob hash mismatch: ${hash}`);

	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
	} catch (error) {
		throw new Error(`Persisted text blob is not valid UTF-8: ${hash}`, { cause: error });
	}
	if (text.length !== expectedChars) {
		throw new Error(`Persisted text blob character count mismatch: ${hash}`);
	}
	return text;
}

/**
 * Resolve a blob reference back to base64 data.
 * If the data is not a blob reference, returns it unchanged.
 * If the blob is missing, logs a warning and returns a placeholder.
 */
export async function resolveImageData(blobStore: BlobStore, data: string): Promise<string> {
	const hash = parseBlobRef(data);
	if (!hash) return data;

	const buffer = await blobStore.get(hash);
	if (!buffer) {
		logger.warn("Blob not found for image reference", { hash });
		return data; // Return the ref as-is; downstream will see invalid base64 but won't crash
	}
	return buffer.toString("base64");
}

/** Synchronous variant of {@link resolveImageData}. */
export function resolveImageDataSync(blobStore: BlobStore, data: string): string {
	const hash = parseBlobRef(data);
	if (!hash) return data;

	const buffer = blobStore.getSync(hash);
	if (!buffer) {
		logger.warn("Blob not found for image reference", { hash });
		return data;
	}
	return buffer.toString("base64");
}
