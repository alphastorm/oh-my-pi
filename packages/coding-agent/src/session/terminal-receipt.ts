import { createHash } from "node:crypto";
import type { AssistantMessage, OAuthAccountIdentity, Usage } from "@oh-my-pi/pi-ai";

export const TERMINAL_RECEIPT_SCHEMA_VERSION = 1 as const;

export type TerminalReceiptStatus = "success" | "error" | "cancelled" | "unavailable";
export type TerminalReceiptUnavailableReason = "not-reported" | "not-observable";

export type TerminalReceiptValue<T> =
	| { readonly status: "available"; readonly value: T }
	| { readonly status: "unavailable"; readonly reason: TerminalReceiptUnavailableReason };

export interface TerminalReceiptModelFallback {
	readonly from: string;
	readonly to: string;
	readonly role: string;
}

/**
 * Allowlisted, payload-free accounting record emitted at a terminal agent settle.
 * Every string is either an authoritative identifier/name, a digest, or an
 * anonymous witness. Provider payloads and session message content have no slot
 * in this schema.
 */
export interface TerminalReceipt {
	readonly schemaVersion: typeof TERMINAL_RECEIPT_SCHEMA_VERSION;
	readonly receiptId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly provider: string;
	readonly model: string;
	readonly accountWitness: TerminalReceiptValue<string>;
	readonly promptCacheDigest: TerminalReceiptValue<string>;
	readonly toolSurfaceDigest: TerminalReceiptValue<string>;
	readonly xdevDigest: TerminalReceiptValue<string>;
	readonly tokens: {
		readonly input: TerminalReceiptValue<number>;
		readonly cachedInput: TerminalReceiptValue<number>;
		readonly uncachedInput: TerminalReceiptValue<number>;
		readonly output: TerminalReceiptValue<number>;
	};
	readonly durationsMs: {
		readonly model: TerminalReceiptValue<number>;
		readonly local: TerminalReceiptValue<number>;
		readonly tool: TerminalReceiptValue<number>;
	};
	readonly costEquivalentUsd: TerminalReceiptValue<number>;
	readonly accountRotationCount: number;
	readonly modelFallbacks: readonly TerminalReceiptModelFallback[];
	readonly compactionEpoch: number;
	readonly terminalStatus: TerminalReceiptStatus;
}

/** Opt-in terminal receipt event; intentionally separate from normal session event fan-out. */
export interface TerminalReceiptEvent {
	readonly type: "terminal_receipt";
	readonly receipt: TerminalReceipt;
}

export type TerminalReceiptListener = (event: TerminalReceiptEvent) => void | Promise<void>;

export interface TerminalReceiptFallbackInput {
	readonly from: string;
	readonly to: string;
	readonly role: string;
}

export interface TerminalReceiptFinishInput {
	readonly endedAtMs: number;
	readonly provider?: string;
	readonly model?: string;
	readonly accountIdentity?: OAuthAccountIdentity;
	readonly promptCacheKey?: string;
	readonly toolNames?: readonly string[];
	readonly xdevNames?: readonly string[];
	readonly compactionEpoch: number;
	readonly terminalStatus: TerminalReceiptStatus;
}

type AssistantAccounting = Pick<AssistantMessage, "usage" | "duration">;

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,95}$/;
const SENSITIVE_NAME = /(?:bearer|api[_-]?key|token|secret|password|credential|sk-[A-Za-z0-9])/i;

function digest(domain: string, value: string): string {
	return `sha256:${createHash("sha256").update(domain).update("\0").update(value).digest("hex")}`;
}

function available<T>(value: T): TerminalReceiptValue<T> {
	return { status: "available", value };
}

function unavailable<T>(reason: TerminalReceiptUnavailableReason): TerminalReceiptValue<T> {
	return { status: "unavailable", reason };
}

function finiteNonNegative(value: number | undefined): number | undefined {
	return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function measurement(
	value: number | undefined,
	reason: TerminalReceiptUnavailableReason = "not-reported",
): TerminalReceiptValue<number> {
	const normalized = finiteNonNegative(value);
	return normalized === undefined ? unavailable(reason) : available(normalized);
}

/** Redacts names that are not canonical provider/model-style selectors. */
export function sanitizeTerminalReceiptName(value: string | undefined): string {
	const normalized = value?.trim();
	if (!normalized) return "unavailable";
	if (!SAFE_NAME.test(normalized) || SENSITIVE_NAME.test(normalized)) {
		return `redacted:${digest("omp-terminal-receipt-name-v1", normalized).slice("sha256:".length, 28)}`;
	}
	return normalized;
}

function sanitizeIdentifier(value: string, domain: string): string {
	const normalized = value.trim();
	if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized) && !SENSITIVE_NAME.test(normalized)) {
		return normalized;
	}
	return `id:${digest(domain, normalized).slice("sha256:".length, 32)}`;
}

function digestList(domain: string, values: readonly string[] | undefined): TerminalReceiptValue<string> {
	if (!values) return unavailable("not-observable");
	const canonical = [...new Set(values.map(value => value.trim()).filter(Boolean))].sort();
	return available(digest(domain, JSON.stringify(canonical)));
}

function promptCacheDigest(promptCacheKey: string | undefined): TerminalReceiptValue<string> {
	if (!promptCacheKey) return unavailable("not-observable");
	return available(digest("omp-terminal-receipt-prompt-cache-v1", promptCacheKey));
}

function accountWitness(
	provider: string | undefined,
	identity: OAuthAccountIdentity | undefined,
): TerminalReceiptValue<string> {
	if (provider?.trim().toLowerCase() !== "openai-codex") return unavailable("not-observable");
	const accountId = identity?.accountId?.trim().toLowerCase();
	if (!accountId) return unavailable("not-observable");
	return available(
		createHash("sha256")
			.update("omp-terminal-receipt-account-v1")
			.update("\0")
			.update(JSON.stringify(["openai-codex", [["accountId", accountId]]]))
			.digest("hex"),
	);
}

function usageWasReported(usage: Usage): boolean {
	return usage.input > 0 || usage.output > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0 || usage.totalTokens > 0;
}

/**
 * Per-terminal-settle accumulator. It observes accounting-only slices of agent
 * events and is deliberately incapable of accepting message content or tool
 * arguments/results.
 */
export class TerminalReceiptAccumulator {
	readonly #sessionId: string;
	readonly #turnId: string;
	readonly #startedAtMs: number;
	readonly #toolStarts = new Map<string, number>();
	#toolIntervalStartMs: number | null = null;
	readonly #fallbacks: TerminalReceiptFallbackInput[] = [];
	#inputTokens = 0;
	#cachedInputTokens = 0;
	#outputTokens = 0;
	#costEquivalentUsd = 0;
	#modelDurationMs = 0;
	#toolDurationMs = 0;
	#assistantCount = 0;
	#accountRotationCount = 0;
	#usageComplete = true;
	#costComplete = true;
	#modelDurationComplete = true;
	#toolDurationComplete = true;
	#finished = false;

	constructor(input: { sessionId: string; turnId: string; startedAtMs: number }) {
		this.#sessionId = input.sessionId;
		this.#turnId = input.turnId;
		this.#startedAtMs = input.startedAtMs;
	}

	recordAssistant(message: AssistantAccounting): void {
		if (this.#finished) return;
		this.#assistantCount++;
		if (usageWasReported(message.usage)) {
			this.#inputTokens += message.usage.input + message.usage.cacheRead;
			this.#cachedInputTokens += message.usage.cacheRead;
			this.#outputTokens += message.usage.output;
		} else {
			this.#usageComplete = false;
		}
		const cost = finiteNonNegative(message.usage.cost.total);
		if (cost === undefined || cost === 0 || !usageWasReported(message.usage)) {
			this.#costComplete = false;
		} else {
			this.#costEquivalentUsd += cost;
		}
		const duration = finiteNonNegative(message.duration);
		if (duration === undefined) {
			this.#modelDurationComplete = false;
		} else {
			this.#modelDurationMs += duration;
		}
	}
	recordToolStart(toolCallId: string, startedAtMs: number): void {
		if (this.#finished) return;
		if (this.#toolStarts.has(toolCallId)) {
			this.#toolDurationComplete = false;
			return;
		}
		const transitionedToActive = this.#toolStarts.size === 0;
		this.#toolStarts.set(toolCallId, startedAtMs);
		if (transitionedToActive) {
			this.#toolIntervalStartMs = startedAtMs;
		}
	}

	recordToolEnd(toolCallId: string, endedAtMs: number): void {
		if (this.#finished) return;
		const startedAtMs = this.#toolStarts.get(toolCallId);
		if (startedAtMs === undefined) {
			this.#toolDurationComplete = false;
			return;
		}
		this.#toolStarts.delete(toolCallId);
		if (finiteNonNegative(endedAtMs - startedAtMs) === undefined) {
			this.#toolDurationComplete = false;
			return;
		}
		if (this.#toolStarts.size === 0) {
			const intervalStartMs = this.#toolIntervalStartMs;
			if (intervalStartMs === null) {
				this.#toolDurationComplete = false;
				return;
			}
			const intervalDuration = finiteNonNegative(endedAtMs - intervalStartMs);
			if (intervalDuration === undefined) {
				this.#toolDurationComplete = false;
				return;
			}
			this.#toolDurationMs += intervalDuration;
			this.#toolIntervalStartMs = null;
		}
	}

	recordFallback(fallback: TerminalReceiptFallbackInput): void {
		if (!this.#finished) this.#fallbacks.push(fallback);
	}

	recordAccountRotation(count = 1): void {
		if (this.#finished) return;
		const normalized = finiteNonNegative(count);
		if (normalized !== undefined) this.#accountRotationCount += Math.trunc(normalized);
	}

	finish(input: TerminalReceiptFinishInput): TerminalReceipt | undefined {
		if (this.#finished) return undefined;
		this.#finished = true;
		if (this.#toolStarts.size > 0) this.#toolDurationComplete = false;

		const usageAvailable = this.#assistantCount > 0 && this.#usageComplete;
		const modelDurationAvailable = this.#assistantCount > 0 && this.#modelDurationComplete;
		const toolDurationAvailable = this.#toolDurationComplete;
		const elapsedMs = finiteNonNegative(input.endedAtMs - this.#startedAtMs);
		const localDuration =
			elapsedMs !== undefined && modelDurationAvailable && toolDurationAvailable
				? Math.max(0, elapsedMs - this.#modelDurationMs - this.#toolDurationMs)
				: undefined;
		const inputTokens = usageAvailable ? this.#inputTokens : undefined;
		const cachedInputTokens = usageAvailable ? this.#cachedInputTokens : undefined;
		const uncachedInputTokens =
			inputTokens !== undefined && cachedInputTokens !== undefined
				? Math.max(0, inputTokens - cachedInputTokens)
				: undefined;
		const sessionId = sanitizeIdentifier(this.#sessionId, "omp-terminal-receipt-session-id-v1");
		const turnId = sanitizeIdentifier(this.#turnId, "omp-terminal-receipt-turn-id-v1");
		const receiptId = digest("omp-terminal-receipt-id-v1", `${sessionId}\0${turnId}`);

		return {
			schemaVersion: TERMINAL_RECEIPT_SCHEMA_VERSION,
			receiptId,
			sessionId,
			turnId,
			provider: sanitizeTerminalReceiptName(input.provider),
			model: sanitizeTerminalReceiptName(input.model),
			accountWitness: accountWitness(input.provider, input.accountIdentity),
			promptCacheDigest: promptCacheDigest(input.promptCacheKey),
			toolSurfaceDigest: digestList("omp-terminal-receipt-tools-v1", input.toolNames),
			xdevDigest: digestList("omp-terminal-receipt-xdev-v1", input.xdevNames),
			tokens: {
				input: measurement(inputTokens),
				cachedInput: measurement(cachedInputTokens),
				uncachedInput: measurement(uncachedInputTokens),
				output: measurement(usageAvailable ? this.#outputTokens : undefined),
			},
			durationsMs: {
				model: measurement(modelDurationAvailable ? this.#modelDurationMs : undefined),
				local: measurement(localDuration, "not-observable"),
				tool: measurement(toolDurationAvailable ? this.#toolDurationMs : undefined, "not-observable"),
			},
			costEquivalentUsd: measurement(
				this.#assistantCount > 0 && this.#costComplete ? this.#costEquivalentUsd : undefined,
			),
			accountRotationCount: this.#accountRotationCount,
			modelFallbacks: this.#fallbacks.map(fallback => ({
				from: sanitizeTerminalReceiptName(fallback.from),
				to: sanitizeTerminalReceiptName(fallback.to),
				role: sanitizeTerminalReceiptName(fallback.role),
			})),
			compactionEpoch: Math.max(0, Math.trunc(finiteNonNegative(input.compactionEpoch) ?? 0)),
			terminalStatus: input.terminalStatus,
		};
	}
}

export function terminalReceiptStatus(
	message: Pick<AssistantMessage, "stopReason"> | undefined,
): TerminalReceiptStatus {
	if (!message) return "unavailable";
	if (message.stopReason === "error") return "error";
	if (message.stopReason === "aborted") return "cancelled";
	return "success";
}
