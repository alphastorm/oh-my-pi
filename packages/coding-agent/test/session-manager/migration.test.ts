import { describe, expect, it } from "bun:test";
import { CURRENT_SESSION_VERSION, type FileEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { migrateSessionEntries } from "@oh-my-pi/pi-coding-agent/session/session-migrations";

describe("migrateSessionEntries", () => {
	it("should add id/parentId to v1 entries", () => {
		const entries: FileEntry[] = [
			{ type: "session", id: "sess-1", timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
			{ type: "message", timestamp: "2025-01-01T00:00:01Z", message: { role: "user", content: "hi", timestamp: 1 } },
			{
				type: "message",
				timestamp: "2025-01-01T00:00:02Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					api: "test",
					provider: "test",
					model: "test",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					stopReason: "stop",
					timestamp: 2,
				},
			},
		] as FileEntry[];

		migrateSessionEntries(entries);

		// Header should have version set to current
		expect((entries[0] as any).version).toBe(CURRENT_SESSION_VERSION);

		// Entries should have id/parentId
		const msg1 = entries[1] as any;
		const msg2 = entries[2] as any;

		expect(msg1.id).toBeDefined();
		expect(msg1.id.length).toBe(8);
		expect(msg1.parentId).toBeNull();

		expect(msg2.id).toBeDefined();
		expect(msg2.id.length).toBe(8);
		expect(msg2.parentId).toBe(msg1.id);
	});

	it("should be idempotent (skip already migrated)", () => {
		const entries: FileEntry[] = [
			{ type: "session", id: "sess-1", version: 2, timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
			{
				type: "message",
				id: "abc12345",
				parentId: null,
				timestamp: "2025-01-01T00:00:01Z",
				message: { role: "user", content: "hi", timestamp: 1 },
			},
			{
				type: "message",
				id: "def67890",
				parentId: "abc12345",
				timestamp: "2025-01-01T00:00:02Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					api: "test",
					provider: "test",
					model: "test",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					stopReason: "stop",
					timestamp: 2,
				},
			},
		] as FileEntry[];

		migrateSessionEntries(entries);

		// IDs should be unchanged
		expect((entries[1] as any).id).toBe("abc12345");
		expect((entries[2] as any).id).toBe("def67890");
		expect((entries[2] as any).parentId).toBe("abc12345");
	});

	it("bumps v3 journals to the entry-owned blob metadata format", () => {
		const entries = [
			{ type: "session", version: 3, id: "sess-v3", timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
			{
				type: "message",
				id: "message-v3",
				parentId: null,
				timestamp: "2025-01-01T00:00:01Z",
				message: { role: "user", content: "unchanged", timestamp: 1 },
			},
		] as FileEntry[];

		migrateSessionEntries(entries);
		expect((entries[0] as { version: number }).version).toBe(CURRENT_SESSION_VERSION);
		expect((entries[1] as Extract<FileEntry, { type: "message" }>).message).toEqual({
			role: "user",
			content: "unchanged",
			timestamp: 1,
		});
	});

	it("rejects journals from a future persistence format", () => {
		const entries = [
			{
				type: "session",
				version: CURRENT_SESSION_VERSION + 1,
				id: "future",
				timestamp: "2025-01-01T00:00:00Z",
				cwd: "/tmp",
			},
		] as FileEntry[];

		expect(() => migrateSessionEntries(entries)).toThrow("Unsupported session version");
	});
});
