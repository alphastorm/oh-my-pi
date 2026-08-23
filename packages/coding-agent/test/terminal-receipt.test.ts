import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { OAuthAccountIdentity, StopReason, Usage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	TerminalReceiptAccumulator,
	terminalReceiptStatus,
	type TerminalReceipt,
} from "@oh-my-pi/pi-coding-agent/session/terminal-receipt";
import { TempDir } from "@oh-my-pi/pi-utils";

const reportedUsage: Usage = {
	input: 70,
	cacheRead: 30,
	cacheWrite: 0,
	output: 5,
	totalTokens: 105,
	cost: { input: 0.01, cacheRead: 0.002, cacheWrite: 0, output: 0.02, total: 0.032 },
};

const missingUsage: Usage = {
	input: 0,
	cacheRead: 0,
	cacheWrite: 0,
	output: 0,
	totalTokens: 0,
	cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 },
};

const harnesses: Array<{ session: AgentSession; authStorage: AuthStorage; tempDir: TempDir }> = [];

async function createSession(
	stopReason: StopReason,
	options?: { continueOnce?: boolean },
): Promise<{ session: AgentSession; receipts: TerminalReceipt[] }> {
	const tempDir = TempDir.createSync("@pi-terminal-receipt-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	authStorage.setRuntimeApiKey("mock", "runtime-secret-key");
	const response = {
		content: stopReason === "stop" ? ["terminal answer"] : [],
		stopReason,
		errorMessage: stopReason === "stop" ? undefined : `${stopReason} terminal state`,
		usage: reportedUsage,
		delayMs: 1,
	};
	const mock = createMockModel({ responses: options?.continueOnce ? [response, response] : [response] });
	let sessionStopCalls = 0;
	const extensionRunner = options?.continueOnce
		? ({
				emit: async () => undefined,
				emitBeforeAgentStart: async () => undefined,
				hasHandlers: (eventType: string) => eventType === "session_stop",
				emitSessionStop: async () => {
					sessionStopCalls++;
					return sessionStopCalls === 1
						? { continue: true, additionalContext: "continue without emitting a terminal receipt" }
						: undefined;
				},
			} as unknown as ExtensionRunner)
		: undefined;
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
	});
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);
	const agent = new Agent({
		getApiKey: () => "runtime-secret-key",
		initialState: { model: mock, systemPrompt: ["private system text"], tools: [], messages: [] },
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry,
		extensionRunner,
	});
	const receipts: TerminalReceipt[] = [];
	session.subscribeTerminalReceipts(event => {
		receipts.push(event.receipt);
	});
	harnesses.push({ session, authStorage, tempDir });
	return { session, receipts };
}

afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.session.dispose();
		harness.authStorage.close();
		harness.tempDir.removeSync();
	}
});

describe("terminal receipt accounting", () => {
	it("derives uncached input and emits unavailable markers instead of plausible zeroes", () => {
		const accumulator = new TerminalReceiptAccumulator({
			sessionId: "session-1",
			turnId: "turn-1",
			startedAtMs: 1_000,
		});
		accumulator.recordAssistant({ usage: reportedUsage, duration: 40 });
		accumulator.recordToolStart("call-1", 1_100);
		accumulator.recordToolEnd("call-1", 1_120);
		const receipt = accumulator.finish({
			endedAtMs: 1_200,
			provider: "openai",
			model: "gpt-5",
			toolNames: ["bash", "read"],
			xdevNames: [],
			compactionEpoch: 2,
			terminalStatus: "success",
		});

		expect(receipt?.tokens.input).toEqual({ status: "available", value: 100 });
		expect(receipt?.tokens.cachedInput).toEqual({ status: "available", value: 30 });
		expect(receipt?.tokens.uncachedInput).toEqual({ status: "available", value: 70 });
		expect(receipt?.tokens.output).toEqual({ status: "available", value: 5 });
		expect(receipt?.durationsMs.model).toEqual({ status: "available", value: 40 });
		expect(receipt?.durationsMs.tool).toEqual({ status: "available", value: 20 });
		expect(receipt?.durationsMs.local).toEqual({ status: "available", value: 140 });

		const missing = new TerminalReceiptAccumulator({
			sessionId: "session-2",
			turnId: "turn-2",
			startedAtMs: 2_000,
		});
		missing.recordAssistant({ usage: missingUsage, duration: undefined });
		const missingReceipt = missing.finish({
			endedAtMs: 2_010,
			provider: "mock",
			model: "missing-usage",
			compactionEpoch: 0,
			terminalStatus: "error",
		});
		expect(missingReceipt?.tokens.input).toEqual({ status: "unavailable", reason: "not-reported" });
		expect(missingReceipt?.costEquivalentUsd).toEqual({ status: "unavailable", reason: "not-reported" });
		expect(missingReceipt?.durationsMs.model).toEqual({ status: "unavailable", reason: "not-reported" });
		expect(missingReceipt?.durationsMs.local).toEqual({ status: "unavailable", reason: "not-observable" });
		expect(missingReceipt?.promptCacheDigest).toEqual({ status: "unavailable", reason: "not-observable" });
	});
	it("unions overlapping tool intervals instead of summing per-tool spans", () => {
		const accumulator = new TerminalReceiptAccumulator({
			sessionId: "session-overlap",
			turnId: "turn-overlap",
			startedAtMs: 6_000,
		});
		accumulator.recordToolStart("call-1", 6_100);
		accumulator.recordToolStart("call-2", 6_110);
		accumulator.recordToolEnd("call-1", 6_120);
		accumulator.recordToolEnd("call-2", 6_130);
		const receipt = accumulator.finish({
			endedAtMs: 6_140,
			provider: "openai",
			model: "gpt-5",
			compactionEpoch: 0,
			terminalStatus: "success",
		});

		expect(receipt?.durationsMs.tool).toEqual({ status: "available", value: 30 });
	});

	it("attributes fallbacks and observed account rotations and finishes once", () => {
		const accumulator = new TerminalReceiptAccumulator({
			sessionId: "session-3",
			turnId: "turn-3",
			startedAtMs: 3_000,
		});
		accumulator.recordAssistant({ usage: reportedUsage, duration: 10 });
		accumulator.recordFallback({ from: "anthropic/claude", to: "openai/gpt-5", role: "default" });
		accumulator.recordAccountRotation();
		accumulator.recordAccountRotation();
		const receipt = accumulator.finish({
			endedAtMs: 3_020,
			provider: "openai",
			model: "gpt-5",
			toolNames: [],
			xdevNames: [],
			compactionEpoch: 1,
			terminalStatus: "success",
		});

		expect(receipt?.accountRotationCount).toBe(2);
		expect(receipt?.modelFallbacks).toEqual([{ from: "anthropic/claude", to: "openai/gpt-5", role: "default" }]);
		expect(accumulator.finish({ endedAtMs: 3_030, compactionEpoch: 1, terminalStatus: "error" })).toBeUndefined();
	});

	it("allowlists receipt fields and never copies raw identities, cache keys, credentials, or payloads", () => {
		const rawAccountId = "acct-private-123";
		const rawEmail = "person@example.test";
		const rawCacheKey = "cache-key-private-456";
		const rawPrompt = "prompt text that must never leave the session";
		const rawResponse = "response text that must never leave the session";
		const accumulator = new TerminalReceiptAccumulator({
			sessionId: "session-4",
			turnId: "turn-4",
			startedAtMs: 4_000,
		});
		accumulator.recordAssistant({ usage: reportedUsage, duration: 5 });
		accumulator.recordFallback({
			from: "credential-sk-private-value",
			to: "openai/gpt-5",
			role: "api-key-private-role",
		});
		const receipt = accumulator.finish({
			endedAtMs: 4_010,
			provider: "openai-codex",
			model: "gpt-5",
			accountIdentity: { accountId: rawAccountId, email: rawEmail },
			promptCacheKey: rawCacheKey,
			toolNames: ["read", "bash"],
			xdevNames: ["resolve", "report_issue"],
			compactionEpoch: 0,
			terminalStatus: "success",
			...({ prompt: rawPrompt, response: rawResponse, toolArgs: { password: "private" } } as Record<
				string,
				unknown
			>),
		});
		const serialized = JSON.stringify(receipt);

		expect(serialized).not.toContain(rawAccountId);
		expect(serialized).not.toContain(rawEmail);
		expect(serialized).not.toContain(rawCacheKey);
		expect(serialized).not.toContain(rawPrompt);
		expect(serialized).not.toContain(rawResponse);
		expect(serialized).not.toContain("sk-private-value");
		expect(serialized).not.toContain("password");
		expect(receipt?.accountWitness.status).toBe("available");
		expect(receipt?.promptCacheDigest.status).toBe("available");
		expect(receipt?.modelFallbacks[0]?.from).toStartWith("redacted:");
	});

	it("matches the shared raw-hex ChatGPT account witness contract", () => {
		const witnessFor = (provider: string, accountIdentity: OAuthAccountIdentity) => {
			const accumulator = new TerminalReceiptAccumulator({
				sessionId: "golden-session",
				turnId: "golden-turn",
				startedAtMs: 5_000,
			});
			return accumulator.finish({
				endedAtMs: 5_001,
				provider,
				model: "gpt-5.6-sol",
				accountIdentity,
				compactionEpoch: 0,
				terminalStatus: "success",
			})?.accountWitness;
		};

		const golden = witnessFor("openai-codex", { accountId: " Account-ABC-123 " });
		expect(golden).toEqual({
			status: "available",
			value: "059d4c43bbff4441ba9145e23fe6fd7c321bd8639e17dbca742bb583efe1b110",
		});
		expect(golden?.status === "available" ? golden.value : "").toMatch(/^[a-f0-9]{64}$/);
		expect(golden?.status === "available" ? golden.value : "").not.toStartWith("sha256:");

		expect(
			witnessFor("OPENAI-CODEX", {
				accountId: "account-abc-123",
				email: "changed@example.test",
				projectId: "changed-project",
				orgId: "changed-org",
			}),
		).toEqual(golden);
		expect(witnessFor("openai", { accountId: "account-abc-123" })).toEqual({
			status: "unavailable",
			reason: "not-observable",
		});
		expect(witnessFor("openai-codex", { email: "person@example.test" })).toEqual({
			status: "unavailable",
			reason: "not-observable",
		});
	});

	it("classifies success, error, and cancellation terminality", () => {
		expect(terminalReceiptStatus({ stopReason: "stop" })).toBe("success");
		expect(terminalReceiptStatus({ stopReason: "error" })).toBe("error");
		expect(terminalReceiptStatus({ stopReason: "aborted" })).toBe("cancelled");
		expect(terminalReceiptStatus(undefined)).toBe("unavailable");
	});
});

describe("AgentSession terminal receipt seam", () => {
	for (const [stopReason, expectedStatus] of [
		["stop", "success"],
		["error", "error"],
		["aborted", "cancelled"],
	] as const) {
		it(`emits one sanitized ${expectedStatus} receipt at the real terminal boundary`, async () => {
			const { session, receipts } = await createSession(stopReason);
			expect(session.getLastTerminalReceipt()).toBeNull();
			const privatePrompt = `private prompt for ${expectedStatus}`;
			await session.prompt(privatePrompt);
			await session.waitForIdle();

			expect(receipts).toHaveLength(1);
			expect(receipts[0]?.schemaVersion).toBe(1);
			expect(receipts[0]?.terminalStatus).toBe(expectedStatus);
			expect(receipts[0]?.sessionId).toBe(session.sessionId);
			expect(JSON.stringify(receipts[0])).not.toContain(privatePrompt);
			expect(receipts[0]?.accountWitness).toEqual({ status: "unavailable", reason: "not-observable" });
			expect(session.getLastTerminalReceipt()).toEqual(receipts[0]);
		});
	}

	it("suppresses intermediate continuation receipts and emits only the final settle", async () => {
		const { session, receipts } = await createSession("stop", { continueOnce: true });
		await session.prompt("continue once");
		await session.waitForIdle();

		expect(receipts).toHaveLength(1);
		expect(receipts[0]?.terminalStatus).toBe("success");
		expect(receipts[0]?.tokens.output).toEqual({ status: "available", value: 10 });
	});
});
