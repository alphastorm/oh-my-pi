import { createHash } from "node:crypto";
import type {
	AssistantMessage,
	Model,
	OAuthAccountIdentity,
	TransportAttemptCause,
	TransportAttemptEvent,
	TransportAttemptStatus,
	Usage,
} from "@oh-my-pi/pi-ai";

export const TERMINAL_RECEIPT_SCHEMA_VERSION = 2 as const;

export type TerminalReceiptStatus = "success" | "error" | "cancelled" | "unavailable";
export type TerminalReceiptUnavailableReason = "not-reported" | "not-observable" | "provider-unreported";

export type TerminalReceiptValue<T> =
	| { readonly status: "available"; readonly value: T }
	| { readonly status: "unavailable"; readonly reason: TerminalReceiptUnavailableReason };

export interface TerminalReceiptModelFallback {
	readonly from: string;
	readonly to: string;
	readonly role: string;
}

export interface TerminalReceiptRateTable {
	readonly digest: string;
	/** UTC catalog-snapshot day; deliberately excludes the exact turn time. */
	readonly effectiveAt: string;
	readonly currency: "USD";
	readonly unit: "usd-per-million-tokens";
	/** The catalog has no separate reasoning tariff; reasoning uses the output-token rate. */
	readonly reasoningRateBasis: "catalog-output-token-rate";
	readonly rates: {
		readonly input: number;
		readonly cachedInput: number;
		readonly cacheWrite: number;
		readonly output: number;
		readonly reasoning: number;
	};
}

export interface TerminalReceiptAttemptUsage {
	readonly input: number;
	readonly cachedInput: number;
	readonly uncachedInput: number;
	readonly cacheWrite: TerminalReceiptValue<number>;
	readonly output: number;
	readonly reasoning: TerminalReceiptValue<number>;
}

export interface TerminalReceiptAttempt {
	readonly ordinal: number;
	readonly provider: string;
	readonly model: string;
	readonly status: TerminalReceiptValue<TransportAttemptStatus>;
	readonly usage: TerminalReceiptValue<TerminalReceiptAttemptUsage>;
	/** Catalog-equivalent cost; never treated as proof that the provider billed the attempt. */
	readonly costUsd: TerminalReceiptValue<number>;
	/** Provider billability only; local token/rate multiplication cannot make this available. */
	readonly billable: TerminalReceiptValue<boolean>;
	readonly cause: TerminalReceiptValue<TransportAttemptCause>;
	readonly durationMs: TerminalReceiptValue<number>;
}

export type TerminalReceiptAttemptCoverage = "auth-dispatch" | "unavailable";
export type TerminalReceiptBillingUncertaintyReason =
	| "physical-attempt-observation-unavailable"
	| "physical-attempt-coverage-partial"
	| "attempt-lifecycle-incomplete"
	| "attempt-usage-unreported"
	| "attempt-cost-unreported"
	| "attempt-billability-unknown"
	| "aggregate-cost-unreported"
	| "rate-table-unavailable"
	| "rate-table-model-mismatch"
	| "reasoning-provider-unreported"
	| "cache-write-provider-unreported";

export interface TerminalReceiptBillingUncertain {
	readonly flag: boolean;
	readonly reasons: readonly TerminalReceiptBillingUncertaintyReason[];
}

/**
 * Allowlisted, payload-free accounting record emitted at a terminal agent settle.
 * Every string is either an authoritative identifier/name, a digest, a fixed
 * accounting classification, or an anonymous witness. Provider payloads and
 * session message content have no slot in this schema.
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
		readonly cacheWrite: TerminalReceiptValue<number>;
		readonly output: TerminalReceiptValue<number>;
		readonly reasoning: TerminalReceiptValue<number>;
	};
	readonly durationsMs: {
		readonly model: TerminalReceiptValue<number>;
		readonly local: TerminalReceiptValue<number>;
		readonly tool: TerminalReceiptValue<number>;
	};
	readonly costEquivalentUsd: TerminalReceiptValue<number>;
	readonly costClassification: "lower-bound" | "unavailable";
	readonly rateTable: TerminalReceiptValue<TerminalReceiptRateTable>;
	readonly attempts: readonly TerminalReceiptAttempt[];
	readonly attemptCoverage: TerminalReceiptAttemptCoverage;
	readonly billingUncertain: TerminalReceiptBillingUncertain;
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

export interface TerminalReceiptRateTableInput {
	readonly provider: string;
	readonly model: string;
	readonly rates: Readonly<Model["cost"]>;
}

type AssistantAccounting = Pick<AssistantMessage, "usage" | "duration">;
type AttemptDraft = {
	readonly ordinal: number;
	readonly provider: string;
	readonly model: string;
	readonly startedAtMs?: number;
};
type RateTableSnapshot = {
	readonly provider: string;
	readonly model: string;
	readonly receipt: TerminalReceiptRateTable;
};

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,95}$/;
const SENSITIVE_NAME = /(?:bearer|api[_-]?key|token|secret|password|credential|sk-[A-Za-z0-9])/i;
const DAY_MS = 86_400_000;

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
	return (
		usage.input > 0 ||
		usage.output > 0 ||
		usage.cacheRead > 0 ||
		usage.cacheWrite > 0 ||
		(usage.reasoningTokens ?? 0) > 0 ||
		usage.totalTokens > 0
	);
}

function cacheWriteWasReported(usage: Usage): boolean {
	return usage.cacheWrite > 0 || usage.cttl !== undefined;
}

function attemptUsage(usage: Readonly<Usage> | undefined): TerminalReceiptValue<TerminalReceiptAttemptUsage> {
	if (!usage || !usageWasReported(usage)) return unavailable("not-reported");
	const uncachedInput = finiteNonNegative(usage.input);
	const cachedInput = finiteNonNegative(usage.cacheRead);
	const output = finiteNonNegative(usage.output);
	if (uncachedInput === undefined || cachedInput === undefined || output === undefined) {
		return unavailable("not-reported");
	}
	const reasoning = finiteNonNegative(usage.reasoningTokens);
	const cacheWrite = finiteNonNegative(usage.cacheWrite);
	return available({
		input: uncachedInput + cachedInput,
		cachedInput,
		uncachedInput,
		cacheWrite:
			cacheWriteWasReported(usage) && cacheWrite !== undefined
				? available(cacheWrite)
				: unavailable("provider-unreported"),
		output,
		reasoning:
			reasoning !== undefined && reasoning <= output ? available(reasoning) : unavailable("provider-unreported"),
	});
}

function rateTableSnapshot(
	input: TerminalReceiptRateTableInput | undefined,
	startedAtMs: number,
): RateTableSnapshot | undefined {
	if (!input || finiteNonNegative(startedAtMs) === undefined) return undefined;
	const provider = sanitizeTerminalReceiptName(input.provider).toLowerCase();
	const model = sanitizeTerminalReceiptName(input.model);
	if (provider === "unavailable" || model === "unavailable") return undefined;
	const inputRate = finiteNonNegative(input.rates.input);
	const outputRate = finiteNonNegative(input.rates.output);
	const cacheReadRate = finiteNonNegative(input.rates.cacheRead);
	const cacheWriteRate = finiteNonNegative(input.rates.cacheWrite);
	if (
		inputRate === undefined ||
		outputRate === undefined ||
		cacheReadRate === undefined ||
		cacheWriteRate === undefined
	) {
		return undefined;
	}
	const rates = {
		input: inputRate,
		cachedInput: cacheReadRate,
		cacheWrite: cacheWriteRate,
		output: outputRate,
		reasoning: outputRate,
	};
	const row = {
		provider,
		model,
		currency: "USD" as const,
		unit: "usd-per-million-tokens" as const,
		reasoningRateBasis: "catalog-output-token-rate" as const,
		rates,
	};
	return {
		provider,
		model,
		receipt: {
			digest: digest("omp-terminal-receipt-rate-table-v2", JSON.stringify(row)),
			effectiveAt: new Date(Math.floor(startedAtMs / DAY_MS) * DAY_MS).toISOString(),
			currency: row.currency,
			unit: row.unit,
			reasoningRateBasis: row.reasoningRateBasis,
			rates,
		},
	};
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
	readonly #rateTable: RateTableSnapshot | undefined;
	readonly #toolStarts = new Map<string, number>();
	#toolIntervalStartMs: number | null = null;
	readonly #fallbacks: TerminalReceiptFallbackInput[] = [];
	readonly #openAttempts = new Map<string, AttemptDraft>();
	readonly #settledAttemptIds = new Set<string>();
	readonly #attempts: TerminalReceiptAttempt[] = [];
	#nextAttemptOrdinal = 1;
	#attemptLifecycleComplete = true;
	#inputTokens = 0;
	#cachedInputTokens = 0;
	#cacheWriteTokens = 0;
	#outputTokens = 0;
	#reasoningTokens = 0;
	#costEquivalentUsd = 0;
	#costObserved = false;
	#modelDurationMs = 0;
	#toolDurationMs = 0;
	#assistantCount = 0;
	#accountRotationCount = 0;
	#usageComplete = true;
	#cacheWriteComplete = true;
	#reasoningComplete = true;
	#costComplete = true;
	#modelDurationComplete = true;
	#toolDurationComplete = true;
	#finished = false;

	constructor(input: {
		sessionId: string;
		turnId: string;
		startedAtMs: number;
		rateTable?: TerminalReceiptRateTableInput;
	}) {
		this.#sessionId = input.sessionId;
		this.#turnId = input.turnId;
		this.#startedAtMs = input.startedAtMs;
		this.#rateTable = rateTableSnapshot(input.rateTable, input.startedAtMs);
	}

	recordAssistant(message: AssistantAccounting): void {
		if (this.#finished) return;
		this.#assistantCount++;
		if (usageWasReported(message.usage)) {
			this.#inputTokens += message.usage.input + message.usage.cacheRead;
			this.#cachedInputTokens += message.usage.cacheRead;
			this.#outputTokens += message.usage.output;
			const reasoning = finiteNonNegative(message.usage.reasoningTokens);
			if (reasoning === undefined || reasoning > message.usage.output) {
				this.#reasoningComplete = false;
			} else {
				this.#reasoningTokens += reasoning;
			}
			const cacheWrite = finiteNonNegative(message.usage.cacheWrite);
			if (!cacheWriteWasReported(message.usage) || cacheWrite === undefined) {
				this.#cacheWriteComplete = false;
			} else {
				this.#cacheWriteTokens += cacheWrite;
			}
		} else {
			this.#usageComplete = false;
			this.#reasoningComplete = false;
			this.#cacheWriteComplete = false;
		}
		const cost = finiteNonNegative(message.usage.cost.total);
		if (cost === undefined || cost === 0 || !usageWasReported(message.usage)) {
			this.#costComplete = false;
		} else {
			this.#costObserved = true;
			this.#costEquivalentUsd += cost;
		}
		const duration = finiteNonNegative(message.duration);
		if (duration === undefined) {
			this.#modelDurationComplete = false;
		} else {
			this.#modelDurationMs += duration;
		}
	}

	recordTransportAttempt(event: TransportAttemptEvent): void {
		if (this.#finished) return;
		if (event.type === "start") {
			if (this.#openAttempts.has(event.attemptId) || this.#settledAttemptIds.has(event.attemptId)) {
				this.#attemptLifecycleComplete = false;
				return;
			}
			this.#openAttempts.set(event.attemptId, {
				ordinal: this.#nextAttemptOrdinal++,
				provider: sanitizeTerminalReceiptName(event.provider),
				model: sanitizeTerminalReceiptName(event.model),
				startedAtMs: finiteNonNegative(event.startedAtMs),
			});
			return;
		}

		if (this.#settledAttemptIds.has(event.attemptId)) {
			this.#attemptLifecycleComplete = false;
			return;
		}
		let draft = this.#openAttempts.get(event.attemptId);
		if (!draft) {
			this.#attemptLifecycleComplete = false;
			draft = {
				ordinal: this.#nextAttemptOrdinal++,
				provider: sanitizeTerminalReceiptName(event.provider),
				model: sanitizeTerminalReceiptName(event.model),
			};
		}
		this.#openAttempts.delete(event.attemptId);
		this.#settledAttemptIds.add(event.attemptId);
		const usage = attemptUsage(event.usage);
		const reportedUsage = event.usage && usageWasReported(event.usage) ? event.usage : undefined;
		const cost = finiteNonNegative(reportedUsage?.cost.total);
		this.#attempts.push({
			ordinal: draft.ordinal,
			provider: draft.provider,
			model: draft.model,
			status: available(event.status),
			usage,
			costUsd: measurement(cost !== undefined && cost > 0 ? cost : undefined),
			billable: unavailable("not-observable"),
			cause: available(event.cause),
			durationMs: measurement(
				draft.startedAtMs === undefined ? undefined : event.endedAtMs - draft.startedAtMs,
				"not-observable",
			),
		});
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
		if (this.#openAttempts.size > 0) {
			this.#attemptLifecycleComplete = false;
			for (const draft of this.#openAttempts.values()) {
				this.#attempts.push({
					ordinal: draft.ordinal,
					provider: draft.provider,
					model: draft.model,
					status: unavailable("not-observable"),
					usage: unavailable("not-reported"),
					costUsd: unavailable("not-reported"),
					billable: unavailable("not-observable"),
					cause: unavailable("not-observable"),
					durationMs: unavailable("not-observable"),
				});
			}
			this.#openAttempts.clear();
		}

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
		const provider = sanitizeTerminalReceiptName(input.provider);
		const model = sanitizeTerminalReceiptName(input.model);
		const attempts = [...this.#attempts].sort((left, right) => left.ordinal - right.ordinal);
		const attemptCoverage: TerminalReceiptAttemptCoverage = attempts.length > 0 ? "auth-dispatch" : "unavailable";
		const rateTableModelMismatch =
			this.#rateTable !== undefined &&
			(this.#rateTable.provider !== provider.toLowerCase() ||
				this.#rateTable.model !== model ||
				attempts.some(
					attempt =>
						this.#rateTable!.provider !== attempt.provider.toLowerCase() ||
						this.#rateTable!.model !== attempt.model,
				));
		const rateTable =
			this.#rateTable && !rateTableModelMismatch
				? available(this.#rateTable.receipt)
				: unavailable<TerminalReceiptRateTable>("not-observable");
		const reasoning = measurement(
			usageAvailable && this.#reasoningComplete ? this.#reasoningTokens : undefined,
			"provider-unreported",
		);
		const cacheWrite = measurement(
			usageAvailable && this.#cacheWriteComplete ? this.#cacheWriteTokens : undefined,
			"provider-unreported",
		);
		const costEquivalentUsd = measurement(this.#costObserved ? this.#costEquivalentUsd : undefined);

		const uncertaintyReasons: TerminalReceiptBillingUncertaintyReason[] = [];
		const addUncertainty = (reason: TerminalReceiptBillingUncertaintyReason): void => {
			if (!uncertaintyReasons.includes(reason)) uncertaintyReasons.push(reason);
		};
		if (attemptCoverage === "unavailable") addUncertainty("physical-attempt-observation-unavailable");
		else addUncertainty("physical-attempt-coverage-partial");
		if (!this.#attemptLifecycleComplete) addUncertainty("attempt-lifecycle-incomplete");
		if (rateTable.status === "unavailable") {
			addUncertainty(rateTableModelMismatch ? "rate-table-model-mismatch" : "rate-table-unavailable");
		}
		if (attempts.some(attempt => attempt.usage.status === "unavailable")) {
			addUncertainty("attempt-usage-unreported");
		}
		if (attempts.some(attempt => attempt.costUsd.status === "unavailable")) {
			addUncertainty("attempt-cost-unreported");
		}
		if (attempts.some(attempt => attempt.billable.status === "unavailable")) {
			addUncertainty("attempt-billability-unknown");
		}
		if (!this.#costComplete || costEquivalentUsd.status === "unavailable") {
			addUncertainty("aggregate-cost-unreported");
		}
		if (reasoning.status === "unavailable") addUncertainty("reasoning-provider-unreported");
		if (cacheWrite.status === "unavailable") addUncertainty("cache-write-provider-unreported");

		return {
			schemaVersion: TERMINAL_RECEIPT_SCHEMA_VERSION,
			receiptId,
			sessionId,
			turnId,
			provider,
			model,
			accountWitness: accountWitness(input.provider, input.accountIdentity),
			promptCacheDigest: promptCacheDigest(input.promptCacheKey),
			toolSurfaceDigest: digestList("omp-terminal-receipt-tools-v1", input.toolNames),
			xdevDigest: digestList("omp-terminal-receipt-xdev-v1", input.xdevNames),
			tokens: {
				input: measurement(inputTokens),
				cachedInput: measurement(cachedInputTokens),
				uncachedInput: measurement(uncachedInputTokens),
				cacheWrite,
				output: measurement(usageAvailable ? this.#outputTokens : undefined),
				reasoning,
			},
			durationsMs: {
				model: measurement(modelDurationAvailable ? this.#modelDurationMs : undefined),
				local: measurement(localDuration, "not-observable"),
				tool: measurement(toolDurationAvailable ? this.#toolDurationMs : undefined, "not-observable"),
			},
			costEquivalentUsd,
			costClassification: costEquivalentUsd.status === "unavailable" ? "unavailable" : "lower-bound",
			rateTable,
			attempts,
			attemptCoverage,
			billingUncertain: { flag: uncertaintyReasons.length > 0, reasons: uncertaintyReasons },
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
