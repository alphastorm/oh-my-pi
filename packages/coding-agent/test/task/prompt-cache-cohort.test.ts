import { afterEach, describe, expect, it } from "bun:test";
import type { ProviderPromptCacheLease, ProviderPromptCacheRequest } from "@oh-my-pi/pi-agent-core";
import {
	PromptCacheCohortManager,
	promptCacheCohortIdentity,
	resolvePromptCacheSupport,
	sha256Canonical,
} from "@oh-my-pi/pi-coding-agent/task/prompt-cache-cohort";

const baseRequest: ProviderPromptCacheRequest = {
	provider: "openai",
	model: "gpt-5.6",
	api: "openai-responses",
	accountWitness: sha256Canonical("account-a"),
	requestProfile: { api: "openai-responses", baseUrl: "https://api.openai.com/v1", temperature: 0 },
	promptCacheKey: "batch-routing-key",
	systemPrompt: ["system", "shared context"],
	tools: [
		{ name: "read", description: "Read", parameters: { type: "object", properties: {} } },
		{ name: "write", description: "Write", parameters: { type: "object", properties: {} } },
	] as ProviderPromptCacheRequest["tools"],
	reasoningMode: { reasoning: "high", disabled: false },
	serviceTier: "priority",
	cacheRetention: "long",
};
const contextFiles = [{ path: "/repo/AGENTS.md", content: "rules", depth: 0 }];
const xdevCatalog = [{ name: "browser", summary: "Browser automation" }];

function fourParticipants(manager: PromptCacheCohortManager) {
	const participants = manager.createBatch(["same", "same", "same", "same"]);
	return participants.map(participant => {
		expect(participant).toBeDefined();
		return participant!;
	});
}

afterEach(() => {
	PromptCacheCohortManager.resetGlobalForTests();
});

describe("PromptCacheCohortManager", () => {
	it("uses coarse signatures only as a preflight candidate filter", () => {
		const manager = new PromptCacheCohortManager();
		expect(manager.createBatch(["same", "same", "same"])).toEqual([undefined, undefined, undefined]);
		expect(manager.activeBatchCount).toBe(0);

		const mixed = manager.createBatch(["a", "a", "a", "a", "b", "b", "b"]);
		expect(mixed.slice(0, 4).every(Boolean)).toBe(true);
		expect(mixed.slice(4).every(value => value === undefined)).toBe(true);
		for (const participant of mixed) participant?.release();
		expect(manager.activeBatchCount).toBe(0);
	});

	it("qualifies four exact siblings with one warmup owner", async () => {
		const manager = new PromptCacheCohortManager();
		const participants = fourParticipants(manager);
		const settled: ProviderPromptCacheLease[] = [];
		const acquisitions = participants.map(participant =>
			participant.acquire(baseRequest, contextFiles, xdevCatalog).then(lease => {
				settled.push(lease);
				return lease;
			}),
		);

		const owner = await Promise.race(acquisitions);
		expect(owner.decision).toBe("warmup-owner");
		expect(settled).toHaveLength(1);
		if (owner.decision !== "warmup-owner") throw new Error("expected warmup owner");
		expect(owner.promptCacheKey).toMatch(/^[a-f0-9]{64}$/);
		owner.settle("ready");

		const leases = await Promise.all(acquisitions);
		expect(leases.filter(lease => lease.decision === "warmup-owner")).toHaveLength(1);
		expect(leases.filter(lease => lease.decision === "ready")).toHaveLength(3);
		expect(
			leases.every(
				lease =>
					(lease.decision === "warmup-owner" || lease.decision === "ready") &&
					lease.promptCacheKey === owner.promptCacheKey,
			),
		).toBe(true);
		for (const participant of participants) participant.release();
		expect(manager.activeBatchCount).toBe(0);
		expect(manager.activeCohortCount).toBe(0);
	});

	it("rejects a two-plus-two full-identity split without blocking either pair", async () => {
		const manager = new PromptCacheCohortManager();
		const participants = fourParticipants(manager);
		const accountB = { ...baseRequest, accountWitness: sha256Canonical("account-b") };
		const leases = await Promise.all(
			participants.map((participant, index) =>
				participant.acquire(index < 2 ? baseRequest : accountB, contextFiles, xdevCatalog),
			),
		);

		expect(leases).toEqual([
			{ decision: "ineligible", reason: "insufficient-exact-cohort" },
			{ decision: "ineligible", reason: "insufficient-exact-cohort" },
			{ decision: "ineligible", reason: "insufficient-exact-cohort" },
			{ decision: "ineligible", reason: "insufficient-exact-cohort" },
		]);
		expect(manager.activeCohortCount).toBe(0);
		for (const participant of participants) participant.release();
	});

	it("settles rendezvous when a sibling releases before acquiring", async () => {
		const manager = new PromptCacheCohortManager();
		const participants = fourParticipants(manager);
		const acquisitions = participants
			.slice(0, 3)
			.map(participant => participant.acquire(baseRequest, contextFiles, xdevCatalog));
		participants[3].release();

		expect(await Promise.all(acquisitions)).toEqual([
			{ decision: "ineligible", reason: "insufficient-exact-cohort" },
			{ decision: "ineligible", reason: "insufficient-exact-cohort" },
			{ decision: "ineligible", reason: "insufficient-exact-cohort" },
		]);
		for (const participant of participants.slice(0, 3)) participant.release();
		expect(manager.activeBatchCount).toBe(0);
	});

	it("unblocks a released waiter before the warmup owner settles", async () => {
		const manager = new PromptCacheCohortManager();
		const participants = fourParticipants(manager);
		const acquisitions = participants.map((participant, index) =>
			participant.acquire(baseRequest, contextFiles, xdevCatalog).then(lease => ({ index, lease })),
		);
		const owner = await Promise.race(acquisitions);
		if (owner.lease.decision !== "warmup-owner") throw new Error("expected warmup owner");
		const waiterIndex = participants.findIndex((_, index) => index !== owner.index);
		participants[waiterIndex].release();

		expect(await acquisitions[waiterIndex]).toEqual({
			index: waiterIndex,
			lease: { decision: "ineligible", reason: "batch-released" },
		});
		owner.lease.settle("ready");
		const remaining = await Promise.all(
			acquisitions.filter((_, index) => index !== owner.index && index !== waiterIndex),
		);
		expect(remaining.every(result => result.lease.decision === "ready")).toBe(true);
		for (const [index, participant] of participants.entries()) {
			if (index !== waiterIndex) participant.release();
		}
	});

	it("releases a warmup owner and permits exactly one retry owner", async () => {
		const manager = new PromptCacheCohortManager();
		const participants = fourParticipants(manager);
		const acquisitions = participants.map((participant, index) =>
			participant.acquire(baseRequest, contextFiles, xdevCatalog).then(lease => ({ index, lease })),
		);
		const first = await Promise.race(acquisitions);
		expect(first.lease.decision).toBe("warmup-owner");
		participants[first.index].release();

		const retry = await Promise.race(acquisitions.filter((_, index) => index !== first.index));
		expect(retry.lease.decision).toBe("warmup-owner");
		if (retry.lease.decision !== "warmup-owner") throw new Error("expected retry warmup owner");
		retry.lease.settle("ready");
		const remaining = await Promise.all(
			acquisitions.filter((_, index) => index !== first.index && index !== retry.index),
		);
		expect(remaining.every(result => result.lease.decision === "ready")).toBe(true);
		for (const [index, participant] of participants.entries()) {
			if (index !== first.index) participant.release();
		}
		expect(manager.activeBatchCount).toBe(0);
	});

	it("fails callable tool schemas closed without rejecting an acquire", async () => {
		const manager = new PromptCacheCohortManager();
		const participants = fourParticipants(manager);
		const callableParameters = Object.assign(() => undefined, {
			in: { type: "object" },
			assert: () => true,
		});
		const request = {
			...baseRequest,
			tools: [
				{
					name: "callable",
					description: "ArkType/Zod-like callable schema",
					parameters: callableParameters,
				},
			] as unknown as ProviderPromptCacheRequest["tools"],
		};

		const leases = await Promise.all(
			participants.map(participant => participant.acquire(request, contextFiles, xdevCatalog)),
		);
		expect(leases).toEqual([
			{ decision: "ineligible", reason: "identity-unavailable" },
			{ decision: "ineligible", reason: "identity-unavailable" },
			{ decision: "ineligible", reason: "identity-unavailable" },
			{ decision: "ineligible", reason: "identity-unavailable" },
		]);
		expect(manager.activeBatchCount).toBe(0);
	});

	it("keeps account rotation outside an already-qualified cohort", async () => {
		const manager = new PromptCacheCohortManager();
		const participants = fourParticipants(manager);
		const acquisitions = participants.map(participant => participant.acquire(baseRequest, contextFiles, xdevCatalog));
		const owner = await Promise.race(acquisitions);
		if (owner.decision !== "warmup-owner") throw new Error("expected warmup owner");
		owner.settle("ready");
		await Promise.all(acquisitions);

		expect(
			await participants[0].acquire(
				{ ...baseRequest, accountWitness: sha256Canonical("account-rotated") },
				contextFiles,
				xdevCatalog,
			),
		).toEqual({ decision: "ineligible", reason: "identity-changed" });
		expect(await participants[0].acquire(baseRequest, contextFiles, xdevCatalog)).toEqual({
			decision: "ready",
			promptCacheKey: owner.promptCacheKey,
		});
		for (const participant of participants) participant.release();
	});

	it("hashes every authoritative account, tool, and context identity dimension", () => {
		const base = promptCacheCohortIdentity({ ...baseRequest, contextFiles, xdevCatalog });
		const variants = [
			promptCacheCohortIdentity({
				...baseRequest,
				accountWitness: sha256Canonical("account-b"),
				contextFiles,
				xdevCatalog,
			}),
			promptCacheCohortIdentity({
				...baseRequest,
				tools: [...baseRequest.tools].reverse(),
				contextFiles,
				xdevCatalog,
			}),
			promptCacheCohortIdentity({
				...baseRequest,
				contextFiles: [{ path: "/repo/AGENTS.md", content: "changed", depth: 0 }],
				xdevCatalog,
			}),
			promptCacheCohortIdentity({
				...baseRequest,
				contextFiles,
				xdevCatalog: [{ name: "computer", summary: "Desktop automation" }],
			}),
		];

		expect(base).toMatch(/^[a-f0-9]{64}$/);
		expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
	});

	it("supports kimi-code only through openai-completions", async () => {
		const manager = new PromptCacheCohortManager();
		const participants = fourParticipants(manager);
		const supported = { ...baseRequest, provider: "kimi-code", api: "openai-completions" };
		const mismatched = { ...supported, api: "anthropic-messages" };
		expect(resolvePromptCacheSupport(supported)).toEqual({
			supported: true,
			mechanism: "kimi-prompt-cache-key",
		});
		expect(resolvePromptCacheSupport(mismatched)).toEqual({
			supported: false,
			reason: "provider-cache-unsupported",
		});
		expect(await participants[0].acquire(mismatched, contextFiles, xdevCatalog)).toEqual({
			decision: "unsupported",
			reason: "provider-cache-unsupported",
		});
		for (const participant of participants.slice(1)) participant.release();
		expect(manager.activeCohortCount).toBe(0);
	});

	it("uses a canonical versioned SHA-256 identity", () => {
		const left = promptCacheCohortIdentity({ ...baseRequest, contextFiles, xdevCatalog });
		const right = promptCacheCohortIdentity({
			...baseRequest,
			requestProfile: { temperature: 0, baseUrl: "https://api.openai.com/v1", api: "openai-responses" },
			contextFiles,
			xdevCatalog,
		});
		expect(left).toMatch(/^[a-f0-9]{64}$/);
		expect(right).toBe(left);
	});
});
