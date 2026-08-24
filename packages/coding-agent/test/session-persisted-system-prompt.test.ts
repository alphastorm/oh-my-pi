import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const usage = (): Usage => ({
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const assistantMessage = (): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text: "completed" }],
	api: "openai-codex-responses",
	provider: "openai-codex",
	model: "gpt-5.2-codex",
	usage: usage(),
	stopReason: "stop",
	timestamp: 2,
});
describe("persisted main-session system prompt", () => {
	it("restores the exact assembled parts after reopening the session", async () => {
		using tempDir = TempDir.createSync("@pi-session-system-prompt-");
		const sessionDir = path.join(tempDir.path(), "sessions");
		const manager = SessionManager.create(tempDir.path(), sessionDir);
		const prompt = ["stable harness prompt", "volatile memory snapshot at 12:34 UTC"];
		const xdevCatalogNames = ["mcp__stable_lookup"];
		const model = "managed-primary/persisted-replay-model";

		manager.setPersistedSystemPrompt(prompt, xdevCatalogNames, model);
		manager.setPersistedSystemPrompt(prompt, xdevCatalogNames, model);
		expect(
			manager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "omp:system-prompt"),
		).toHaveLength(1);
		manager.appendMessage({ role: "user", content: "persist me", timestamp: Date.now() });
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a materialized session file");
		await manager.close();

		const reopened = await SessionManager.open(sessionFile, sessionDir, undefined, {
			initialCwd: tempDir.path(),
			suppressBreadcrumb: true,
		});
		expect(reopened.getPersistedSystemPromptState()).toEqual({ parts: prompt, xdevCatalogNames, model });
		await reopened.close();
	});

	it("selects the prompt revision on the active branch", () => {
		const manager = SessionManager.inMemory();
		manager.setPersistedSystemPrompt(["first"]);
		const firstPromptLeaf = manager.getLeafId();
		if (!firstPromptLeaf) throw new Error("Expected first prompt entry");
		manager.appendMessage({ role: "user", content: "branch point", timestamp: Date.now() });
		manager.setPersistedSystemPrompt(["second"]);
		expect(manager.getPersistedSystemPrompt()).toEqual(["second"]);

		manager.branch(firstPromptLeaf);
		expect(manager.getPersistedSystemPrompt()).toEqual(["first"]);
	});
	it.each([
		{ schemaVersion: 1 },
		{ schemaVersion: 1, parts: ["prompt"], xdevCatalogNames: "mcp__invalid" },
		{ schemaVersion: 1, parts: ["prompt"], xdevCatalogNames: [], model: 1 },
	])("fails closed on malformed persisted prompt state", data => {
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry("omp:system-prompt", data);
		expect(() => manager.getPersistedSystemPromptState()).toThrow("Invalid persisted system prompt state");
	});

	it("does not materialize a prompt-only session", async () => {
		using tempDir = TempDir.createSync("@pi-session-system-prompt-lazy-");
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected an allocated session path");

		manager.setPersistedSystemPrompt(["startup-only"]);
		await manager.close();

		expect(await Bun.file(sessionFile).exists()).toBe(false);
	});

	it("retains an explicitly materialized prompt-only session", async () => {
		using tempDir = TempDir.createSync("@pi-session-system-prompt-explicit-");
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected an allocated session path");

		manager.setPersistedSystemPrompt(["explicit"]);
		await manager.ensureOnDisk();
		await manager.close();

		expect(await Bun.file(sessionFile).exists()).toBe(true);
	});

	it("retains the prompt after real assistant output", async () => {
		using tempDir = TempDir.createSync("@pi-session-system-prompt-output-");
		const sessionDir = path.join(tempDir.path(), "sessions");
		const manager = SessionManager.create(tempDir.path(), sessionDir);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected an allocated session path");

		manager.setPersistedSystemPrompt(["durable"]);
		manager.appendMessage(assistantMessage());
		await manager.close();

		expect(await Bun.file(sessionFile).exists()).toBe(true);
		const reopened = await SessionManager.open(sessionFile, sessionDir, undefined, {
			initialCwd: tempDir.path(),
			suppressBreadcrumb: true,
		});
		expect(reopened.getPersistedSystemPrompt()).toEqual(["durable"]);
		await reopened.close();
	});
});
