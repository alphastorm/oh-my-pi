import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage, ProviderStatePersistenceSnapshot } from "@oh-my-pi/pi-ai/types";
import {
	finalizeProviderStateEnvelope,
	loadProviderStateSnapshot,
	PROVIDER_STATE_CUSTOM_TYPE,
	type ProviderStateEnvelopeV1,
	prepareProviderStateEnvelope,
} from "@oh-my-pi/pi-coding-agent/session/provider-state";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getAgentDir, getBlobsDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const REQUEST_SHAPE_VERSION = "omp-openai-responses-ninfer/v1";
const MODEL = "q38-ninfer";

function assistant(responseId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "completed response" }],
		api: "openai-responses",
		provider: "ninfer-local",
		model: "qwen3.8-27b",
		responseId,
		usage: {
			input: 10,
			output: 4,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 14,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1001,
	};
}

function snapshot(responseId: string): ProviderStatePersistenceSnapshot {
	return {
		schemaVersion: 1,
		provider: "openai-responses",
		endpointFingerprint: "a".repeat(64),
		model: MODEL,
		lastResponseId: responseId,
		requestBaseline: {
			model: MODEL,
			input: [{ role: "user", content: [{ type: "input_text", text: "question" }] }],
			store: true,
		},
		priorOutputItems: [
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "completed response" }] },
		],
		createdAt: "2026-08-26T00:00:00.000Z",
		updatedAt: "2026-08-26T00:00:01.000Z",
		requestShapeVersion: REQUEST_SHAPE_VERSION,
	};
}

async function publishState(
	manager: SessionManager,
	responseId = "resp_1",
): Promise<{ envelope: ProviderStateEnvelopeV1; snapshot: ProviderStatePersistenceSnapshot }> {
	manager.appendMessage({ role: "user", content: "question", timestamp: 1000 });
	const providerSnapshot = snapshot(responseId);
	const prepared = await prepareProviderStateEnvelope(manager, providerSnapshot);
	let envelope: ProviderStateEnvelopeV1 | undefined;
	await manager.appendEntriesAtomically(() => {
		const lastCommittedTurnId = manager.appendMessage(assistant(responseId));
		envelope = finalizeProviderStateEnvelope({
			prepared,
			sessionId: manager.getSessionId(),
			lastCommittedTurnId,
			branch: manager.getBranch(),
		});
		manager.appendCustomEntry(PROVIDER_STATE_CUSTOM_TYPE, envelope);
	});
	if (!envelope) throw new Error("provider state was not published");
	return { envelope, snapshot: providerSnapshot };
}

function load(manager: SessionManager) {
	return loadProviderStateSnapshot({
		sessionManager: manager,
		sessionId: manager.getSessionId(),
		model: MODEL,
		requestShapeVersion: REQUEST_SHAPE_VERSION,
	});
}

describe("provider state journal", () => {
	let previousAgentDir: string;
	let tempDir: TempDir;

	beforeEach(() => {
		previousAgentDir = getAgentDir();
		tempDir = TempDir.createSync("@omp-provider-state-");
		setAgentDir(tempDir.join("agent"));
	});

	afterEach(() => {
		setAgentDir(previousAgentDir);
		tempDir[Symbol.dispose]();
	});

	it("restores content-addressed state from the exact durable session branch", async () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		const { snapshot: expected } = await publishState(manager);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("session file was not created");
		await manager.close();

		const reopened = await SessionManager.open(sessionFile, tempDir.path());
		expect(await load(reopened)).toEqual(expected);
		await reopened.close();
	});

	it("ignores marker-shaped user data and fails closed on a newer metadata schema", async () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		await publishState(manager);
		manager.appendMessage({
			role: "user",
			content: JSON.stringify({ customType: PROVIDER_STATE_CUSTOM_TYPE, schemaVersion: 1, lastResponseId: "spoof" }),
			timestamp: 1002,
		});
		expect((await load(manager))?.lastResponseId).toBe("resp_1");

		manager.appendCustomEntry(PROVIDER_STATE_CUSTOM_TYPE, { schemaVersion: 2, lastResponseId: "future" });
		expect(await load(manager)).toBeUndefined();
		await manager.close();
	});

	it("requires the exact configured model and request-shape contract", async () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		await publishState(manager);
		expect(
			await loadProviderStateSnapshot({
				sessionManager: manager,
				sessionId: manager.getSessionId(),
				model: "other-model",
				requestShapeVersion: REQUEST_SHAPE_VERSION,
			}),
		).toBeUndefined();
		expect(
			await loadProviderStateSnapshot({
				sessionManager: manager,
				sessionId: manager.getSessionId(),
				model: MODEL,
				requestShapeVersion: "future-request-shape",
			}),
		).toBeUndefined();
		await manager.close();
	});
	it("invalidates state after compaction, a model boundary, and a copied session identity", async () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		await publishState(manager);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("session file was not created");
		manager.appendModelChange("other/model");
		expect(await load(manager)).toBeUndefined();
		await manager.close();

		const source = SessionManager.create(tempDir.path(), tempDir.join("source-sessions"));
		await publishState(source, "resp_copy");
		const sourceFile = source.getSessionFile();
		if (!sourceFile) throw new Error("source session file was not created");
		await source.close();
		const forked = await SessionManager.forkFrom(sourceFile, tempDir.path(), tempDir.join("forks"), undefined, {
			suppressBreadcrumb: true,
		});
		expect(await load(forked)).toBeUndefined();
		await forked.close();
		const compacted = SessionManager.create(tempDir.path(), tempDir.join("compacted-sessions"));
		const { envelope } = await publishState(compacted, "resp_compacted");
		compacted.appendCompaction("summary", undefined, envelope.lastCommittedTurnId, 100);
		expect(await load(compacted)).toBeUndefined();
		await compacted.close();
	});

	it("rejects a missing or corrupted content-addressed baseline", async () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		const { envelope } = await publishState(manager);
		await Bun.write(`${getBlobsDir()}/${envelope.requestBaselineRef.sha256}`, "corrupted");
		expect(await load(manager)).toBeUndefined();
		await manager.close();
	});
});
