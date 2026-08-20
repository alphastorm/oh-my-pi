import { describe, expect, it } from "bun:test";
import type { Model, ServiceTierByFamily } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { buildServiceTierByFamily, validateAgentTierOverrides } from "@oh-my-pi/pi-coding-agent/config/service-tier";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { applyAgentTierOverride, createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";

function bundledModel(provider: Parameters<typeof getBundledModel>[0], id: string): Model {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected bundled model ${provider}/${id}`);
	return model;
}

const openAIModel = bundledModel("openai-codex", "gpt-5.6-sol");
const anthropicModel = bundledModel("anthropic", "claude-sonnet-4-5");
const googleModel = bundledModel("google", "gemini-2.5-flash");

function effectiveChildTiers(
	baseSettings: Settings,
	agentName: string,
	model: Model,
	parentServiceTier?: ServiceTierByFamily | null,
): ServiceTierByFamily {
	const child = createSubagentSettings(baseSettings, undefined, parentServiceTier);
	applyAgentTierOverride(child, baseSettings, agentName, model, parentServiceTier);
	return buildServiceTierByFamily(child.get("tier.openai"), child.get("tier.anthropic"), child.get("tier.google"));
}

describe("task.agentTierOverrides", () => {
	it("keeps tier.subagent behavior unchanged when the exact agent key is absent", () => {
		const settings = Settings.isolated({ "tier.subagent": "none" });
		expect(effectiveChildTiers(settings, "scout", openAIModel)).toEqual({});

		const inherited = Settings.isolated({ "tier.subagent": "priority" });
		expect(effectiveChildTiers(inherited, "task", openAIModel)).toEqual({
			openai: "priority",
			anthropic: "priority",
			google: "priority",
		});
	});

	it("targets only the exact OpenAI scout without spilling onto other agents", () => {
		const settings = Settings.isolated({
			"tier.subagent": "none",
			"task.agentTierOverrides": { scout: "priority" },
		});

		expect(effectiveChildTiers(settings, "scout", openAIModel)).toEqual({ openai: "priority" });
		expect(effectiveChildTiers(settings, "task", openAIModel)).toEqual({});
		expect(effectiveChildTiers(settings, "reviewer", anthropicModel)).toEqual({});
		expect(effectiveChildTiers(settings, "designer", googleModel)).toEqual({});
		expect(effectiveChildTiers(settings, "Scout", openAIModel)).toEqual({});
	});

	it("lets an explicit none override beat global priority", () => {
		const settings = Settings.isolated({
			"tier.subagent": "priority",
			"task.agentTierOverrides": { scout: "none" },
		});
		expect(effectiveChildTiers(settings, "scout", openAIModel)).toEqual({});
	});

	it("tracks the parent live tier map for inherit on each spawn", () => {
		const settings = Settings.isolated({
			"tier.subagent": "none",
			"task.agentTierOverrides": { scout: "inherit" },
		});

		expect(effectiveChildTiers(settings, "scout", openAIModel, { openai: "priority" })).toEqual({
			openai: "priority",
		});
		expect(effectiveChildTiers(settings, "scout", openAIModel, null)).toEqual({});
	});

	it("stamps concrete tiers only on the resolved model family", () => {
		const settings = Settings.isolated({
			"tier.subagent": "none",
			"task.agentTierOverrides": { reviewer: "priority", designer: "flex" },
		});
		expect(effectiveChildTiers(settings, "reviewer", anthropicModel)).toEqual({ anthropic: "priority" });
		expect(effectiveChildTiers(settings, "designer", googleModel)).toEqual({ google: "flex" });

		settings.override("task.agentTierOverrides", { reviewer: "scale" });
		expect(effectiveChildTiers(settings, "reviewer", anthropicModel)).toEqual({});
	});

	it("validates normal settings loads and isolated runtime resolution defensively", async () => {
		expect(validateAgentTierOverrides({})).toEqual({});
		await expect(
			Settings.loadIsolated({
				inMemory: true,
				overrides: { "task.agentTierOverrides": { scout: "turbo" } },
			}),
		).rejects.toThrow("task.agentTierOverrides.scout");

		const isolated = Settings.isolated({
			"task.agentTierOverrides": { scout: "turbo" } as never,
		});
		expect(() => effectiveChildTiers(isolated, "scout", openAIModel)).toThrow("task.agentTierOverrides.scout");
	});

	it("persists the effective child tier in live session state", async () => {
		const baseSettings = Settings.isolated({
			"tier.subagent": "none",
			"task.agentTierOverrides": { scout: "priority" },
		});
		const childSettings = createSubagentSettings(baseSettings);
		applyAgentTierOverride(childSettings, baseSettings, "scout", openAIModel);
		const authStorage = await AuthStorage.create(":memory:");
		const sessionManager = SessionManager.inMemory();
		try {
			const { session } = await createAgentSession({
				cwd: process.cwd(),
				agentDir: process.cwd(),
				model: openAIModel,
				modelRegistry: new ModelRegistry(authStorage),
				settings: childSettings,
				sessionManager,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});
			try {
				expect(session.serviceTierByFamily).toEqual({ openai: "priority" });
				expect(sessionManager.getEntries()).toContainEqual(
					expect.objectContaining({
						type: "service_tier_change",
						serviceTier: { openai: "priority" },
					}),
				);
			} finally {
				await session.dispose();
			}
		} finally {
			authStorage.close();
		}
	});
});
