import { afterAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	BlobStore,
	parseBlobRef,
	resolveImageData,
	resolveImageDataSync,
	resolveImageDataUrl,
} from "../../src/session/blob-store";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "blob-store-test-"));
const blobDir = path.join(base, "agent", "blobs", "data");
fs.mkdirSync(blobDir, { recursive: true });
fs.writeFileSync(path.join(base, "secret.txt"), "TOP-SECRET-CONTENTS");
const store = new BlobStore(blobDir);

afterAll(() => {
	fs.rmSync(base, { recursive: true, force: true });
});

describe("parseBlobRef validation", () => {
	it("accepts a canonical 64-char lowercase hex suffix", () => {
		const hash = "a".repeat(64);
		expect(parseBlobRef(`blob:sha256:${hash}`)).toBe(hash);
	});

	it("returns null for non-blob strings", () => {
		expect(parseBlobRef("data:image/png;base64,AAAA")).toBeNull();
	});

	it.each([
		"../../../secret.txt",
		`${"../".repeat(6)}etc/passwd`,
		"A".repeat(64), // uppercase hex is not the canonical shape
		"a".repeat(63), // too short
		"a".repeat(65), // too long
		"", // empty
	])("rejects malformed suffix %p", suffix => {
		expect(parseBlobRef(`blob:sha256:${suffix}`)).toBeNull();
	});
});

describe("blob publication", () => {
	it("publishes once and reuses only matching content", async () => {
		const data = Buffer.from("atomic-content-addressed-blob");
		const first = store.putSync(data);
		const second = await store.put(data);

		expect(second.path).toBe(first.path);
		expect(fs.readFileSync(first.path)).toEqual(data);
		expect(fs.readdirSync(blobDir).filter(name => name.endsWith(".tmp"))).toEqual([]);
	});

	it("atomically repairs corrupt content left by the predecessor writer", async () => {
		const data = Buffer.from("expected-content-addressed-blob");
		const hash = new Bun.SHA256().update(data).digest("hex");
		const blobPath = path.join(blobDir, hash);
		fs.writeFileSync(blobPath, "corrupt");

		const repaired = store.putSync(data);
		expect(repaired.path).toBe(blobPath);
		expect(fs.readFileSync(blobPath)).toEqual(data);
		await expect(store.put(data)).resolves.toMatchObject({ path: blobPath });
		expect(fs.readdirSync(blobDir).filter(name => name.endsWith(".tmp"))).toEqual([]);
	});

	it("copies async caller bytes before yielding", async () => {
		const original = Buffer.from("caller-owned-stable-bytes");
		const expected = Buffer.from(original);
		const pending = store.put(original);
		original.fill(0x78);

		const published = await pending;
		expect(fs.readFileSync(published.path)).toEqual(expected);
		expect(published.hash).toBe(new Bun.SHA256().update(expected).digest("hex"));
	});

	it("propagates a real directory fsync failure", () => {
		const realFsync = fs.fsyncSync;
		let calls = 0;
		const fsync = spyOn(fs, "fsyncSync").mockImplementation(fd => {
			calls++;
			if (calls === 2) throw Object.assign(new Error("directory sync failed"), { code: "EIO" });
			return realFsync(fd);
		});
		try {
			expect(() => store.putSync(Buffer.from("directory-sync-contract"))).toThrow("directory sync failed");
			expect(calls).toBe(2);
		} finally {
			fsync.mockRestore();
		}
	});
});

describe("blob resolution path confinement", () => {
	const traversalRef = "blob:sha256:../../../secret.txt";

	it("leaves a traversal ref unresolved instead of reading outside the blob dir (base64 path)", async () => {
		expect(await resolveImageData(store, traversalRef)).toBe(traversalRef);
		expect(resolveImageDataSync(store, traversalRef)).toBe(traversalRef);
	});

	it("leaves a traversal ref unresolved instead of reading outside the blob dir (data-url path)", async () => {
		expect(await resolveImageDataUrl(store, traversalRef)).toBe(traversalRef);
	});

	it("still resolves a valid stored blob", async () => {
		const put = store.putSync(Buffer.from("hello"));
		expect(Buffer.from(resolveImageDataSync(store, put.ref), "base64").toString("utf8")).toBe("hello");
		expect(Buffer.from(await resolveImageData(store, put.ref), "base64").toString("utf8")).toBe("hello");
	});
});
