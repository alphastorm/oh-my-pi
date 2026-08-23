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
	type TerminalReceipt,
	TerminalReceiptAccumulator,
	terminalReceiptStatus,
} from "@oh-my-pi/pi-coding-agent/session/terminal-receipt";
import { TempDir } from "@oh-my-pi/pi-utils";

const reportedUsage: Usage = {
	input: 70,
	cacheRead: 30,
	cacheWrite: 4,
	output: 5,
	totalTokens: 109,
	reasoningTokens: 2,
	cttl: { ephemeral5m: 4 },
	cost: { input: 0.01, cacheRead: 0.002, cacheWrite: 0.001, output: 0.02, total: 0.033 },
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
			rateTable: {
				provider: "openai",
				model: "gpt-5",
				rates: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 },
			},
		});
		accumulator.recordTransportAttempt({
			type: "start",
			attemptId: "attempt-1",
			provider: "openai",
			model: "gpt-5",
			startedAtMs: 1_010,
		});
		accumulator.recordTransportAttempt({
			type: "settle",
			attemptId: "attempt-1",
			provider: "openai",
			model: "gpt-5",
			endedAtMs: 1_050,
			status: "success",
			cause: "completed",
			usage: reportedUsage,
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
		expect(receipt?.tokens.reasoning).toEqual({ status: "available", value: 2 });
		expect(receipt?.tokens.cacheWrite).toEqual({ status: "available", value: 4 });
		expect(receipt?.rateTable.status).toBe("available");
		expect(receipt?.rateTable.status === "available" ? receipt.rateTable.value.rates : undefined).toEqual({
			input: 1,
			cachedInput: 0.1,
			cacheWrite: 1.25,
			output: 4,
			reasoning: 4,
		});
		expect(receipt?.rateTable.status === "available" ? receipt.rateTable.value.reasoningRateBasis : undefined).toBe(
			"catalog-output-token-rate",
		);
		expect(receipt?.rateTable.status === "available" ? receipt.rateTable.value.effectiveAt : undefined).toBe(
			"1970-01-01T00:00:00.000Z",
		);
		expect(receipt?.attempts).toHaveLength(1);
		expect(receipt?.attempts[0]).toMatchObject({
			ordinal: 1,
			status: { status: "available", value: "success" },
			cause: { status: "available", value: "completed" },
			costUsd: { status: "available", value: 0.033 },
			billable: { status: "unavailable", reason: "not-observable" },
		});
		expect(receipt?.attemptCoverage).toBe("auth-dispatch");
		expect(receipt?.billingUncertain).toEqual({
			flag: true,
			reasons: ["physical-attempt-coverage-partial", "attempt-billability-unknown"],
		});
		expect(receipt?.costClassification).toBe("lower-bound");
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
		expect(missingReceipt?.tokens.reasoning).toEqual({
			status: "unavailable",
			reason: "provider-unreported",
		});
		expect(missingReceipt?.tokens.cacheWrite).toEqual({
			status: "unavailable",
			reason: "provider-unreported",
		});
		expect(missingReceipt?.attemptCoverage).toBe("unavailable");
		expect(missingReceipt?.costClassification).toBe("unavailable");
		expect(missingReceipt?.billingUncertain.reasons).toContain("physical-attempt-observation-unavailable");
	});

	it("records replay-safe failed attempts without inventing usage or billability", () => {
		const accumulator = new TerminalReceiptAccumulator({
			sessionId: "session-attempts",
			turnId: "turn-attempts",
			startedAtMs: 7_000,
			rateTable: {
				provider: "openai",
				model: "gpt-5",
				rates: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 },
			},
		});
		accumulator.recordTransportAttempt({
			type: "start",
			attemptId: "failed",
			provider: "openai",
			model: "gpt-5",
			startedAtMs: 7_010,
		});
		accumulator.recordTransportAttempt({
			type: "settle",
			attemptId: "failed",
			provider: "openai",
			model: "gpt-5",
			endedAtMs: 7_020,
			status: "error",
			cause: "credential-retry",
		});
		accumulator.recordTransportAttempt({
			type: "start",
			attemptId: "successful",
			provider: "openai",
			model: "gpt-5",
			startedAtMs: 7_030,
		});
		accumulator.recordTransportAttempt({
			type: "settle",
			attemptId: "successful",
			provider: "openai",
			model: "gpt-5",
			endedAtMs: 7_060,
			status: "success",
			cause: "completed",
			usage: reportedUsage,
		});
		accumulator.recordAssistant({ usage: reportedUsage, duration: 30 });

		const receipt = accumulator.finish({
			endedAtMs: 7_070,
			provider: "openai",
			model: "gpt-5",
			compactionEpoch: 0,
			terminalStatus: "success",
		});

		expect(receipt?.attempts.map(attempt => [attempt.ordinal, attempt.status, attempt.cause])).toEqual([
			[1, { status: "available", value: "error" }, { status: "available", value: "credential-retry" }],
			[2, { status: "available", value: "success" }, { status: "available", value: "completed" }],
		]);
		expect(receipt?.attempts[0]?.usage).toEqual({ status: "unavailable", reason: "not-reported" });
		expect(receipt?.attempts[0]?.costUsd).toEqual({ status: "unavailable", reason: "not-reported" });
		expect(receipt?.attempts[0]?.billable).toEqual({ status: "unavailable", reason: "not-observable" });
		expect(receipt?.billingUncertain.reasons).toEqual([
			"physical-attempt-coverage-partial",
			"attempt-usage-unreported",
			"attempt-cost-unreported",
			"attempt-billability-unknown",
		]);
		expect(receipt?.costClassification).toBe("lower-bound");
	});

	it("materializes unsettled attempts without ordinal gaps or invented lifecycle outcomes", () => {
		const accumulator = new TerminalReceiptAccumulator({
			sessionId: "session-open-attempt",
			turnId: "turn-open-attempt",
			startedAtMs: 8_000,
		});
		accumulator.recordTransportAttempt({
			type: "start",
			attemptId: "open",
			provider: "openai",
			model: "gpt-5",
			startedAtMs: 8_010,
		});
		accumulator.recordTransportAttempt({
			type: "start",
			attemptId: "settled",
			provider: "openai",
			model: "gpt-5",
			startedAtMs: 8_020,
		});
		accumulator.recordTransportAttempt({
			type: "settle",
			attemptId: "settled",
			provider: "openai",
			model: "gpt-5",
			endedAtMs: 8_030,
			status: "success",
			cause: "completed",
			usage: reportedUsage,
		});
		accumulator.recordAssistant({ usage: reportedUsage, duration: 10 });

		const receipt = accumulator.finish({
			endedAtMs: 8_040,
			provider: "openai",
			model: "gpt-5",
			compactionEpoch: 0,
			terminalStatus: "cancelled",
		});

		expect(receipt?.attempts.map(attempt => attempt.ordinal)).toEqual([1, 2]);
		expect(receipt?.attempts[0]).toMatchObject({
			status: { status: "unavailable", reason: "not-observable" },
			cause: { status: "unavailable", reason: "not-observable" },
			usage: { status: "unavailable", reason: "not-reported" },
			costUsd: { status: "unavailable", reason: "not-reported" },
			billable: { status: "unavailable", reason: "not-observable" },
			durationMs: { status: "unavailable", reason: "not-observable" },
		});
		expect(receipt?.attempts[1]).toMatchObject({
			status: { status: "available", value: "success" },
			cause: { status: "available", value: "completed" },
		});
		expect(receipt?.billingUncertain.reasons).toContain("attempt-lifecycle-incomplete");
	});

	it("keeps positive aggregate cost as a lower bound while marking zero provider cost unreported", () => {
		const zeroCostUsage: Usage = {
			...reportedUsage,
			cost: { ...reportedUsage.cost, total: 0 },
		};
		const accumulator = new TerminalReceiptAccumulator({
			sessionId: "session-mixed-cost",
			turnId: "turn-mixed-cost",
			startedAtMs: 9_000,
		});
		for (const [index, usage] of [reportedUsage, zeroCostUsage].entries()) {
			const attemptId = `cost-${index + 1}`;
			accumulator.recordTransportAttempt({
				type: "start",
				attemptId,
				provider: "openai",
				model: "gpt-5",
				startedAtMs: 9_010 + index * 10,
			});
			accumulator.recordTransportAttempt({
				type: "settle",
				attemptId,
				provider: "openai",
				model: "gpt-5",
				endedAtMs: 9_015 + index * 10,
				status: "success",
				cause: "completed",
				usage,
			});
			accumulator.recordAssistant({ usage, duration: 5 });
		}

		const receipt = accumulator.finish({
			endedAtMs: 9_040,
			provider: "openai",
			model: "gpt-5",
			compactionEpoch: 0,
			terminalStatus: "success",
		});

		expect(receipt?.costEquivalentUsd).toEqual({ status: "available", value: 0.033 });
		expect(receipt?.attempts[0]?.costUsd).toEqual({ status: "available", value: 0.033 });
		expect(receipt?.attempts[1]?.costUsd).toEqual({ status: "unavailable", reason: "not-reported" });
		expect(receipt?.billingUncertain.reasons).toContain("aggregate-cost-unreported");
		expect(receipt?.billingUncertain.reasons).toContain("attempt-cost-unreported");
		expect(receipt?.costClassification).toBe("lower-bound");
	});

	it("rounds rate-table provenance to a UTC day and declares the reasoning-rate basis", () => {
		const startedAtMs = Date.UTC(2026, 7, 9, 15, 42, 11, 123);
		const accumulator = new TerminalReceiptAccumulator({
			sessionId: "session-rate-time",
			turnId: "turn-rate-time",
			startedAtMs,
			rateTable: {
				provider: "openai",
				model: "gpt-5",
				rates: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 },
			},
		});
		const receipt = accumulator.finish({
			endedAtMs: startedAtMs + 1,
			provider: "openai",
			model: "gpt-5",
			compactionEpoch: 0,
			terminalStatus: "success",
		});

		expect(receipt?.rateTable).toMatchObject({
			status: "available",
			value: {
				effectiveAt: "2026-08-09T00:00:00.000Z",
				reasoningRateBasis: "catalog-output-token-rate",
			},
		});
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
			expect(receipts[0]?.schemaVersion).toBe(2);
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
