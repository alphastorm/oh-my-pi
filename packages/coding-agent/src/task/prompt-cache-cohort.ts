import { createHash, randomUUID } from "node:crypto";
import type {
	ProviderPromptCacheLease,
	ProviderPromptCacheRequest,
	ProviderPromptCacheSettleOutcome,
} from "@oh-my-pi/pi-agent-core";

const COHORT_IDENTITY_VERSION = 1;
const MIN_COHORT_SIZE = 4;
const PARTICIPANT_RELEASED = Symbol("prompt-cache-participant-released");

export type PromptCacheSupportMechanism =
	| "anthropic-prefix-cache"
	| "openai-prompt-cache-key"
	| "kimi-prompt-cache-key";

export type PromptCacheSupportDecision =
	| { supported: true; mechanism: PromptCacheSupportMechanism }
	| { supported: false; reason: "cache-disabled" | "provider-cache-unsupported" };

export interface PromptCacheCohortIdentityInput extends ProviderPromptCacheRequest {
	contextFiles: readonly unknown[];
	xdevCatalog: readonly unknown[];
}

export interface PromptCacheCohortParticipant {
	readonly routingKey: string;
	acquire(
		request: ProviderPromptCacheRequest,
		contextFiles: readonly unknown[],
		xdevCatalog: readonly unknown[],
		signal?: AbortSignal,
	): Promise<ProviderPromptCacheLease>;
	release(): void;
}

interface WarmingCohortState {
	status: "warming";
	ownerParticipant: number;
	promise: Promise<ProviderPromptCacheSettleOutcome>;
	resolve: (outcome: ProviderPromptCacheSettleOutcome) => void;
}

interface ReadyCohortState {
	status: "ready";
}

type CohortState = WarmingCohortState | ReadyCohortState;

interface ParticipantDeparture {
	promise: Promise<typeof PARTICIPANT_RELEASED>;
	resolve: () => void;
}

interface BatchGroupState {
	participants: Set<number>;
	arrivals: Map<number, string>;
	cohorts: Map<string, CohortState>;
	eligibleIdentities?: ReadonlySet<string>;
	rendezvous: Promise<void>;
	resolveRendezvous: () => void;
}

interface BatchState {
	remaining: number;
	released: Set<number>;
	departures: Map<number, ParticipantDeparture>;
	participantGroups: Map<number, string>;
	groups: Map<string, BatchGroupState>;
	onReleased?: () => void;
}

function canonicalize(value: unknown, seen = new Set<object>()): unknown {
	if (value === undefined) return ["undefined"];
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (Number.isNaN(value)) return ["number", "NaN"];
		if (value === Number.POSITIVE_INFINITY) return ["number", "+Infinity"];
		if (value === Number.NEGATIVE_INFINITY) return ["number", "-Infinity"];
		if (Object.is(value, -0)) return ["number", "-0"];
		return value;
	}
	if (typeof value === "bigint") return ["bigint", value.toString(10)];
	if (typeof value === "symbol" || typeof value === "function") {
		throw new TypeError(`Prompt cache cohort identity cannot contain ${typeof value} values`);
	}
	if (value instanceof Date) return ["date", value.toISOString()];
	if (ArrayBuffer.isView(value)) {
		return ["bytes", Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64")];
	}
	if (value instanceof ArrayBuffer) return ["bytes", Buffer.from(value).toString("base64")];
	if (seen.has(value)) throw new TypeError("Prompt cache cohort identity cannot contain cycles");
	seen.add(value);
	try {
		if (Array.isArray(value)) return value.map(item => canonicalize(item, seen));
		if (value instanceof Map) {
			const entries = [...value.entries()].map(([key, item]) => [canonicalize(key, seen), canonicalize(item, seen)]);
			entries.sort((a, b) => {
				const left = JSON.stringify(a[0]);
				const right = JSON.stringify(b[0]);
				return left < right ? -1 : left > right ? 1 : 0;
			});
			return ["map", entries];
		}
		if (value instanceof Set) {
			const entries = [...value].map(item => canonicalize(item, seen));
			entries.sort((a, b) => {
				const left = JSON.stringify(a);
				const right = JSON.stringify(b);
				return left < right ? -1 : left > right ? 1 : 0;
			});
			return ["set", entries];
		}
		const record = value as Record<string, unknown>;
		const output: Record<string, unknown> = {};
		for (const key of Object.keys(record).sort()) output[key] = canonicalize(record[key], seen);
		return output;
	} finally {
		seen.delete(value);
	}
}

export function sha256Canonical(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(canonicalize(value)))
		.digest("hex");
}

export function promptCacheCohortIdentity(input: PromptCacheCohortIdentityInput): string {
	return sha256Canonical({
		version: COHORT_IDENTITY_VERSION,
		provider: input.provider,
		api: input.api,
		model: input.model,
		accountWitness: input.accountWitness,
		requestProfileDigest: sha256Canonical(input.requestProfile),
		promptCacheKeyDigest: sha256Canonical(input.promptCacheKey),
		systemPromptDigest: sha256Canonical(input.systemPrompt),
		contextFilesDigest: sha256Canonical(input.contextFiles),
		toolSurfaceDigest: sha256Canonical(input.tools),
		xdevCatalogDigest: sha256Canonical(input.xdevCatalog),
		reasoningModeDigest: sha256Canonical(input.reasoningMode),
		serviceTierDigest: sha256Canonical(input.serviceTier),
		cacheRetentionDigest: sha256Canonical(input.cacheRetention),
	});
}

export function resolvePromptCacheProviderSupport(provider: string, api: string): PromptCacheSupportDecision {
	if (provider === "kimi-code") {
		return api === "openai-completions"
			? { supported: true, mechanism: "kimi-prompt-cache-key" }
			: { supported: false, reason: "provider-cache-unsupported" };
	}
	if (api === "anthropic-messages") return { supported: true, mechanism: "anthropic-prefix-cache" };
	if (api === "openai-responses" || api === "openai-codex-responses" || api === "azure-openai-responses") {
		return { supported: true, mechanism: "openai-prompt-cache-key" };
	}
	return { supported: false, reason: "provider-cache-unsupported" };
}

export function resolvePromptCacheSupport(request: ProviderPromptCacheRequest): PromptCacheSupportDecision {
	if (request.cacheRetention === "none") return { supported: false, reason: "cache-disabled" };
	return resolvePromptCacheProviderSupport(request.provider, request.api);
}

function abortError(): Error {
	const error = new Error("Prompt cache cohort wait aborted");
	error.name = "AbortError";
	return error;
}

async function waitForPromise<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) throw abortError();
	const { promise: aborted, reject } = Promise.withResolvers<never>();
	const onAbort = () => reject(abortError());
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([promise, aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

/**
 * Process-local, account-scoped prompt-cache single-flight for task batches.
 * Raw prefix material is hashed at the acquire boundary and is never retained.
 */
export class PromptCacheCohortManager {
	static #global: PromptCacheCohortManager | undefined;
	readonly #batches = new Map<string, BatchState>();

	static global(): PromptCacheCohortManager {
		if (!PromptCacheCohortManager.#global) {
			PromptCacheCohortManager.#global = new PromptCacheCohortManager();
		}
		return PromptCacheCohortManager.#global;
	}

	/** Test-only process reset; live callers release through participant leases. */
	static resetGlobalForTests(): void {
		PromptCacheCohortManager.#global = undefined;
	}

	get activeBatchCount(): number {
		return this.#batches.size;
	}

	get activeCohortCount(): number {
		let count = 0;
		for (const batch of this.#batches.values()) {
			for (const group of batch.groups.values()) count += group.cohorts.size;
		}
		return count;
	}

	/**
	 * Preflight signatures only identify candidates that may rendezvous. The
	 * minimum size is enforced again after every candidate has either supplied
	 * its full provider-facing identity or released.
	 */
	createBatch(
		candidateSignatures: readonly (string | undefined)[],
		onReleased?: () => void,
	): Array<PromptCacheCohortParticipant | undefined> {
		const counts = new Map<string, number>();
		for (const signature of candidateSignatures) {
			if (signature !== undefined) counts.set(signature, (counts.get(signature) ?? 0) + 1);
		}
		const admitted = new Map<string, number>();
		const eligible = candidateSignatures.map(signature => {
			if (signature === undefined || (counts.get(signature) ?? 0) < MIN_COHORT_SIZE) return false;
			const admittedCount = admitted.get(signature) ?? 0;
			if (admittedCount >= MIN_COHORT_SIZE) return false;
			admitted.set(signature, admittedCount + 1);
			return true;
		});
		const remaining = eligible.filter(Boolean).length;
		if (remaining === 0) return candidateSignatures.map(() => undefined);

		const batchId = randomUUID();
		const batch: BatchState = {
			remaining,
			released: new Set(),
			departures: new Map(),
			participantGroups: new Map(),
			groups: new Map(),
			onReleased,
		};
		for (const [participantId, signature] of candidateSignatures.entries()) {
			if (!eligible[participantId] || signature === undefined) continue;
			let group = batch.groups.get(signature);
			if (!group) {
				const deferred = Promise.withResolvers<void>();
				group = {
					participants: new Set(),
					arrivals: new Map(),
					cohorts: new Map(),
					rendezvous: deferred.promise,
					resolveRendezvous: () => deferred.resolve(),
				};
				batch.groups.set(signature, group);
			}
			group.participants.add(participantId);
			batch.participantGroups.set(participantId, signature);
			const departure = Promise.withResolvers<typeof PARTICIPANT_RELEASED>();
			batch.departures.set(participantId, {
				promise: departure.promise,
				resolve: () => departure.resolve(PARTICIPANT_RELEASED),
			});
		}
		this.#batches.set(batchId, batch);

		return candidateSignatures.map((signature, participantId) => {
			if (!eligible[participantId] || signature === undefined) return undefined;
			const routingKey = sha256Canonical({ version: COHORT_IDENTITY_VERSION, batchId, signature });
			let released = false;
			return {
				routingKey,
				acquire: (request, contextFiles, xdevCatalog, signal) =>
					this.#acquire(batchId, participantId, request, contextFiles, xdevCatalog, signal),
				release: () => {
					if (released) return;
					released = true;
					this.#release(batchId, participantId);
				},
			};
		});
	}

	async #acquire(
		batchId: string,
		participantId: number,
		request: ProviderPromptCacheRequest,
		contextFiles: readonly unknown[],
		xdevCatalog: readonly unknown[],
		signal?: AbortSignal,
	): Promise<ProviderPromptCacheLease> {
		if (signal?.aborted) {
			this.#release(batchId, participantId);
			throw abortError();
		}
		const support = resolvePromptCacheSupport(request);
		if (!support.supported) {
			this.#release(batchId, participantId);
			return { decision: "unsupported", reason: support.reason };
		}
		if (!/^[a-f0-9]{64}$/.test(request.accountWitness)) {
			this.#release(batchId, participantId);
			return { decision: "ineligible", reason: "identity-unavailable" };
		}

		let identity: string;
		try {
			identity = promptCacheCohortIdentity({ ...request, contextFiles, xdevCatalog });
		} catch {
			this.#release(batchId, participantId);
			return { decision: "ineligible", reason: "identity-unavailable" };
		}

		const batch = this.#batches.get(batchId);
		if (!batch || batch.released.has(participantId)) {
			return { decision: "ineligible", reason: "batch-released" };
		}
		const signature = batch.participantGroups.get(participantId);
		const group = signature === undefined ? undefined : batch.groups.get(signature);
		const departure = batch.departures.get(participantId);
		if (!group || !departure) return { decision: "ineligible", reason: "batch-released" };

		const registeredIdentity = group.arrivals.get(participantId);
		if (registeredIdentity !== undefined && registeredIdentity !== identity) {
			return { decision: "ineligible", reason: "identity-changed" };
		}
		if (registeredIdentity === undefined) group.arrivals.set(participantId, identity);
		this.#sealGroup(batch, group);

		if (group.eligibleIdentities === undefined) {
			try {
				const rendezvous = await waitForPromise(Promise.race([group.rendezvous, departure.promise]), signal);
				if (rendezvous === PARTICIPANT_RELEASED) {
					return { decision: "ineligible", reason: "batch-released" };
				}
			} catch (error) {
				if (signal?.aborted) this.#release(batchId, participantId);
				throw error;
			}
		}

		const liveBatch = this.#batches.get(batchId);
		if (!liveBatch || liveBatch.released.has(participantId)) {
			return { decision: "ineligible", reason: "batch-released" };
		}
		const liveSignature = liveBatch.participantGroups.get(participantId);
		const liveGroup = liveSignature === undefined ? undefined : liveBatch.groups.get(liveSignature);
		if (!liveGroup?.eligibleIdentities?.has(identity)) {
			return { decision: "ineligible", reason: "insufficient-exact-cohort" };
		}

		while (true) {
			if (signal?.aborted) throw abortError();
			const currentBatch = this.#batches.get(batchId);
			const currentSignature = currentBatch?.participantGroups.get(participantId);
			const currentGroup = currentSignature === undefined ? undefined : currentBatch?.groups.get(currentSignature);
			if (!currentBatch || currentBatch.released.has(participantId) || !currentGroup) {
				return { decision: "ineligible", reason: "batch-released" };
			}
			const current = currentGroup.cohorts.get(identity);
			if (current?.status === "ready") {
				return { decision: "ready", promptCacheKey: identity };
			}
			if (current?.status === "warming") {
				const outcome = await waitForPromise(Promise.race([current.promise, departure.promise]), signal);
				if (outcome === PARTICIPANT_RELEASED) {
					return { decision: "ineligible", reason: "batch-released" };
				}
				if (outcome === "ready") return { decision: "ready", promptCacheKey: identity };
				continue;
			}

			const deferred = Promise.withResolvers<ProviderPromptCacheSettleOutcome>();
			const warming: WarmingCohortState = {
				status: "warming",
				ownerParticipant: participantId,
				promise: deferred.promise,
				resolve: deferred.resolve,
			};
			currentGroup.cohorts.set(identity, warming);
			let settled = false;
			return {
				decision: "warmup-owner",
				promptCacheKey: identity,
				settle: outcome => {
					if (settled) return;
					settled = true;
					const settledBatch = this.#batches.get(batchId);
					const settledSignature = settledBatch?.participantGroups.get(participantId);
					const settledGroup =
						settledSignature === undefined ? undefined : settledBatch?.groups.get(settledSignature);
					if (!settledGroup || settledGroup.cohorts.get(identity) !== warming) {
						warming.resolve("failed");
						return;
					}
					if (outcome === "ready") settledGroup.cohorts.set(identity, { status: "ready" });
					else settledGroup.cohorts.delete(identity);
					warming.resolve(outcome);
				},
			};
		}
	}

	#sealGroup(batch: BatchState, group: BatchGroupState): void {
		if (group.eligibleIdentities !== undefined) return;
		for (const participantId of group.participants) {
			if (!group.arrivals.has(participantId) && !batch.released.has(participantId)) return;
		}

		const counts = new Map<string, number>();
		for (const [participantId, identity] of group.arrivals) {
			if (batch.released.has(participantId)) continue;
			counts.set(identity, (counts.get(identity) ?? 0) + 1);
		}
		group.eligibleIdentities = new Set(
			[...counts].filter(([, count]) => count >= MIN_COHORT_SIZE).map(([identity]) => identity),
		);
		group.resolveRendezvous();
	}

	#release(batchId: string, participantId: number): void {
		const batch = this.#batches.get(batchId);
		if (!batch || batch.released.has(participantId)) return;
		batch.released.add(participantId);
		batch.remaining -= 1;
		batch.departures.get(participantId)?.resolve();

		const signature = batch.participantGroups.get(participantId);
		const group = signature === undefined ? undefined : batch.groups.get(signature);
		if (group) {
			this.#sealGroup(batch, group);
			for (const [identity, cohort] of group.cohorts) {
				if (cohort.status === "warming" && cohort.ownerParticipant === participantId) {
					group.cohorts.delete(identity);
					cohort.resolve("failed");
				}
			}
		}

		if (batch.remaining > 0) return;
		this.#batches.delete(batchId);
		for (const batchGroup of batch.groups.values()) {
			if (batchGroup.eligibleIdentities === undefined) {
				batchGroup.eligibleIdentities = new Set();
				batchGroup.resolveRendezvous();
			}
			for (const cohort of batchGroup.cohorts.values()) {
				if (cohort.status === "warming") cohort.resolve("failed");
			}
			batchGroup.cohorts.clear();
		}
		batch.onReleased?.();
	}
}
