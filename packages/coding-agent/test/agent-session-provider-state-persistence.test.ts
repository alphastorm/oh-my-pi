import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { Agent, type StreamFn } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type {
	ProviderSessionState,
	ProviderStatePersistenceSnapshot,
	ProviderStatePersistenceUpdate,
} from "@oh-my-pi/pi-ai/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { PROVIDER_STATE_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/session/provider-state";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

function providerSnapshot(): ProviderStatePersistenceSnapshot {
	return {
		schemaVersion: 1,
		provider: "openai-responses",
		endpointFingerprint: "a".repeat(64),
		model: "q38-ninfer",
		lastResponseId: "resp_1",
		requestBaseline: {
			model: "q38-ninfer",
			input: [{ role: "user", content: [{ type: "input_text", text: "sensitive baseline" }] }],
			store: true,
		},
		priorOutputItems: [
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "completed response" }] },
		],
		createdAt: "2026-08-26T00:00:00.000Z",
		updatedAt: "2026-08-26T00:00:01.000Z",
		requestShapeVersion: "omp-openai-responses-ninfer/v1",
	};
}

class FailNextAtomicStorage extends FileSessionStorage {
	armed = false;

	override async writeTextAtomic(
		filePath: string,
		body: string,
		options?: { commitGuard?: () => boolean },
	): Promise<void> {
		if (this.armed) {
			this.armed = false;
			throw new Error("injected provider-state publish failure");
		}
		return super.writeTextAtomic(filePath, body, options);
	}
}

interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
	update: ProviderStatePersistenceUpdate;
	commits: () => number;
	rollbacks: () => number;
	rolledBack: Promise<void>;
}

async function createHarness(tempDir: TempDir, storage?: FileSessionStorage): Promise<Harness> {
	const mock = createMockModel({
		provider: "ninfer-local",
		id: "qwen3.8-27b",
		responses: [{ content: ["completed response"], responseId: "resp_1" }],
	});
	let commitCount = 0;
	let rollbackCount = 0;
	let settled = false;
	const rollbackSignal = Promise.withResolvers<void>();
	const snapshot = providerSnapshot();
	const update: ProviderStatePersistenceUpdate = {
		snapshot,
		commit() {
			if (settled) return;
			settled = true;
			commitCount++;
		},
		rollback() {
			if (settled) return;
			settled = true;
			rollbackCount++;
			rollbackSignal.resolve();
		},
	};
	const providerState: ProviderSessionState = {
		close() {
			update.rollback();
		},
		takePendingPersistence(selection) {
			return !settled &&
				selection.provider === mock.provider &&
				selection.model === mock.id &&
				selection.responseId === snapshot.lastResponseId
				? update
				: undefined;
		},
	};
	const streamFn: StreamFn = (model, context, options) => {
		options?.providerSessionState?.set("test-provider-state", providerState);
		return mock.stream(model, context, options);
	};
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.setRuntimeApiKey(mock.provider, "test-key");
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
	});
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);
	const sessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"), storage);
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: mock, systemPrompt: ["Test"], tools: [], messages: [] },
		convertToLlm,
		streamFn,
	});
	const session = new AgentSession({ agent, sessionManager, settings, modelRegistry, toolRegistry: new Map() });
	return {
		session,
		sessionManager,
		update,
		commits: () => commitCount,
		rollbacks: () => rollbackCount,
		rolledBack: rollbackSignal.promise,
	};
}

describe("AgentSession provider-state publication", () => {
	let tempDir: TempDir;
	const sessions: AgentSession[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-provider-state-session-");
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		tempDir[Symbol.dispose]();
	});

	it("publishes the assistant and provider snapshot durably before message_end exposure", async () => {
		const harness = await createHarness(tempDir);
		sessions.push(harness.session);
		let observedDurablePublication = false;
		harness.session.subscribe(event => {
			if (event.type !== "message_end" || event.message.role !== "assistant") return;
			const sessionFile = harness.sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("assistant was exposed before the session file existed");
			const durableEntries = readFileSync(sessionFile, "utf8")
				.trim()
				.split("\n")
				.map(line => JSON.parse(line) as Record<string, unknown>);
			const assistantIndex = durableEntries.findIndex(
				entry =>
					entry.type === "message" &&
					(entry.message as { role?: string; responseId?: string } | undefined)?.role === "assistant" &&
					(entry.message as { responseId?: string } | undefined)?.responseId === "resp_1",
			);
			const providerIndex = durableEntries.findIndex(
				entry => entry.type === "custom" && entry.customType === PROVIDER_STATE_CUSTOM_TYPE,
			);
			observedDurablePublication =
				harness.commits() === 1 && assistantIndex >= 0 && providerIndex === assistantIndex + 1;
		});

		await harness.session.prompt("question");
		await harness.session.waitForIdle();
		expect(observedDurablePublication).toBe(true);
		expect(harness.commits()).toBe(1);
		expect(harness.rollbacks()).toBe(0);
		const sessionFile = harness.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("session file was not created");
		expect(readFileSync(sessionFile, "utf8")).not.toContain("sensitive baseline");
	});

	it("rolls back and withholds the assistant when atomic publication fails", async () => {
		const storage = new FailNextAtomicStorage();
		const harness = await createHarness(tempDir, storage);
		sessions.push(harness.session);
		let exposed = false;
		harness.session.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "assistant") exposed = true;
		});
		storage.armed = true;

		await harness.session.prompt("question").catch(() => false);
		await harness.rolledBack;
		expect(exposed).toBe(false);
		expect(harness.commits()).toBe(0);
		expect(harness.rollbacks()).toBe(1);
		expect(
			harness.sessionManager
				.getBranch()
				.some(entry => entry.type === "custom" && entry.customType === PROVIDER_STATE_CUSTOM_TYPE),
		).toBe(false);
		expect(
			harness.sessionManager
				.getBranch()
				.some(entry => entry.type === "message" && entry.message.role === "assistant"),
		).toBe(false);
	});
});
