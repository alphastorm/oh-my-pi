import { afterEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Api, Context, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

interface CapturedRequest {
	systemPrompt?: string[];
	messages: Context["messages"];
	tools?: Context["tools"];
}

function buildLocalModel(api: string, id = "persisted-replay-model"): Model<Api> {
	return buildModel({
		id,
		name: "Persisted Replay Model",
		api,
		provider: "managed-primary",
		baseUrl: "http://127.0.0.1:8080/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 2_000_000,
		maxTokens: 1024,
	} as ModelSpec<Api>) as Model<Api>;
}

function captureRequest(context: Context): CapturedRequest {
	return JSON.parse(
		JSON.stringify({
			systemPrompt: context.systemPrompt,
			messages: context.messages,
			tools: context.tools,
		}),
	) as CapturedRequest;
}

function textOf(message: Context["messages"][number]): string {
	if (typeof message.content === "string") return message.content;
	return message.content.map(block => ("text" in block && typeof block.text === "string" ? block.text : "")).join("");
}

function stableMcpTool(): CustomTool {
	return {
		name: "mcp__stable_lookup",
		label: "stable/lookup",
		description: "Stable reconstructed MCP tool",
		parameters: type({ query: "string" }),
		strict: true,
		mcpServerName: "stable",
		mcpToolName: "lookup",
		async execute() {
			return { content: [{ type: "text", text: "unused" }] };
		},
	} as CustomTool;
}

describe("persisted provider replay", () => {
	afterEach(() => {
		clearCustomApis();
	});

	it("reconstructs a 100K prompt and oversized tool result with an exact request prefix", async () => {
		using tempDir = TempDir.createSync("@pi-persisted-provider-replay-");
		const sessionDir = tempDir.join("sessions");
		const api = `persisted-provider-replay-${Bun.nanoseconds().toString(36)}`;
		const denseUserPrompt = `repair teardown.py without side effects\n${" x".repeat(100_000)}`;
		const largeToolResult = `RESULT:${"y".repeat(600_000)}`;
		const requests: CapturedRequest[] = [];

		registerCustomApi(api, (_model, context) => {
			requests.push(captureRequest(context));
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage(
					requests.length === 1 ? "first process done" : "resumed process done",
				);
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});

		const largeResultExtension: ExtensionFactory = pi => {
			pi.registerTool({
				name: "large_result",
				label: "Large result",
				description: "Return replay test data",
				parameters: pi.arktype({}),
				async execute() {
					return { content: [{ type: "text" as const, text: "unused" }], details: {} };
				},
			});
		};

		const createSession = async (
			manager: SessionManager,
			systemPrompt: string | (() => string),
			modelId?: string,
		) => {
			const authStorage = await AuthStorage.create(tempDir.join(`auth-${Bun.nanoseconds()}.db`));
			authStorage.setRuntimeApiKey("managed-primary", "test-key");
			const modelRegistry = new ModelRegistry(authStorage, tempDir.join(`models-${Bun.nanoseconds()}.yml`));
			const result = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: manager,
				authStorage,
				modelRegistry,
				settings: Settings.isolated({ "compaction.enabled": false, "memory.backend": "off" }),
				model: buildLocalModel(api, modelId),
				systemPrompt: typeof systemPrompt === "function" ? () => [systemPrompt()] : [systemPrompt],
				disableExtensionDiscovery: true,
				extensions: [largeResultExtension],
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				toolNames: ["large_result"],
			});
			return { ...result, authStorage };
		};

		const firstManager = SessionManager.create(tempDir.path(), sessionDir);
		const first = await createSession(firstManager, "FIRST_ASSEMBLED_PROMPT");
		const seedUser: AgentMessage = { role: "user", content: denseUserPrompt, timestamp: 1 };
		const seedAssistant = createAssistantMessage("");
		seedAssistant.content = [{ type: "toolCall", id: "call-large-result", name: "large_result", arguments: {} }];
		seedAssistant.stopReason = "toolUse";
		const seedToolResult: AgentMessage = {
			role: "toolResult",
			toolCallId: "call-large-result",
			toolName: "large_result",
			content: [{ type: "text", text: largeToolResult }],
			isError: false,
			timestamp: 3,
		};
		for (const message of [seedUser, seedAssistant, seedToolResult]) {
			first.session.agent.appendMessage(message);
			firstManager.appendMessage(message);
		}
		await first.session.refreshMCPTools([stableMcpTool()]);
		await first.session.sendUserMessage("first provider request");
		expect(requests).toHaveLength(1);
		expect(requests[0]?.systemPrompt).toEqual(["FIRST_ASSEMBLED_PROMPT"]);
		const firstUser = requests[0]!.messages.find(message => message.role === "user");
		if (!firstUser) throw new Error("Expected seeded user request message");
		const firstUserText = textOf(firstUser);
		expect(firstUserText.endsWith(denseUserPrompt)).toBe(true);
		expect(firstUserText.split(" x").length - 1).toBe(100_000);
		const firstToolResult = requests[0]!.messages.find(message => message.role === "toolResult");
		if (!firstToolResult) throw new Error("Expected seeded tool result in provider request");
		expect(textOf(firstToolResult)).toBe(largeToolResult);

		await firstManager.ensureOnDisk();
		const sessionFile = firstManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a materialized session file");
		await first.session.dispose();
		await firstManager.close();
		first.authStorage.close();
		const persistedJsonl = await Bun.file(sessionFile).text();
		expect(persistedJsonl).toContain("omp.session.text-blob.v1");
		expect(persistedJsonl).not.toContain(largeToolResult);

		const reopenedManager = await SessionManager.open(sessionFile, sessionDir, undefined, {
			initialCwd: tempDir.path(),
			suppressBreadcrumb: true,
		});
		const resumed = await createSession(reopenedManager, "CHANGED_RECONSTRUCTED_PROMPT");
		await resumed.session.refreshMCPTools([stableMcpTool()]);
		await resumed.session.sendUserMessage("continue after process restart");
		expect(requests).toHaveLength(2);

		const priorRequest = requests[0]!;
		const resumedRequest = requests[1]!;
		expect(resumedRequest.systemPrompt).toEqual(priorRequest.systemPrompt);
		expect(resumedRequest.systemPrompt).toEqual(["FIRST_ASSEMBLED_PROMPT"]);
		expect(resumedRequest.tools).toEqual(priorRequest.tools);
		expect(resumedRequest.messages.slice(0, priorRequest.messages.length)).toEqual(priorRequest.messages);
		expect(
			JSON.stringify({
				systemPrompt: resumedRequest.systemPrompt,
				messages: resumedRequest.messages.slice(0, priorRequest.messages.length),
				tools: resumedRequest.tools,
			}),
		).toBe(JSON.stringify(priorRequest));
		expect(textOf(resumedRequest.messages.at(-1)!)).toBe("continue after process restart");

		await resumed.session.dispose();
		await reopenedManager.close();
		resumed.authStorage.close();

		const modelSwitchManager = await SessionManager.open(sessionFile, sessionDir, undefined, {
			initialCwd: tempDir.path(),
			suppressBreadcrumb: true,
		});
		const switched = await createSession(modelSwitchManager, "MODEL_CHANGED_PROMPT", "different-model");
		await switched.session.sendUserMessage("continue after model switch");
		expect(requests).toHaveLength(3);
		expect(requests[2]?.systemPrompt).toEqual(["MODEL_CHANGED_PROMPT"]);
		await switched.session.dispose();
		await modelSwitchManager.close();
		switched.authStorage.close();
		const legacyManager = SessionManager.inMemory();
		legacyManager.setPersistedSystemPrompt(["LEGACY_PROMPT_WITHOUT_MODEL"]);
		let legacyPromptBuilds = 0;
		const legacy = await createSession(legacyManager, () => `LEGACY_PROMPT_REBUILT_${++legacyPromptBuilds}`);
		expect(legacyPromptBuilds).toBe(1);
		await legacy.session.refreshMCPTools([stableMcpTool()]);
		expect(legacyPromptBuilds).toBe(1);
		await legacy.session.sendUserMessage("continue from legacy prompt state");
		expect(requests).toHaveLength(4);
		expect(requests[3]?.systemPrompt).toEqual(["LEGACY_PROMPT_REBUILT_1"]);
		expect(legacyManager.getPersistedSystemPromptState()).toEqual({
			parts: ["LEGACY_PROMPT_REBUILT_1"],
			xdevCatalogNames: [],
			model: "managed-primary/persisted-replay-model",
		});
		await legacy.session.dispose();
		await legacyManager.close();
		legacy.authStorage.close();

		const noMetadataManager = SessionManager.inMemory();
		const noMetadata = await createSession(noMetadataManager, "NO_METADATA_PROMPT");
		await noMetadata.session.sendUserMessage("continue from legacy session without prompt metadata");
		expect(requests).toHaveLength(5);
		expect(requests[4]?.systemPrompt).toEqual(["NO_METADATA_PROMPT"]);
		expect(noMetadataManager.getPersistedSystemPromptState()).toEqual({
			parts: ["NO_METADATA_PROMPT"],
			xdevCatalogNames: [],
			model: "managed-primary/persisted-replay-model",
		});
		await noMetadata.session.dispose();
		await noMetadataManager.close();
		noMetadata.authStorage.close();
	});
});
