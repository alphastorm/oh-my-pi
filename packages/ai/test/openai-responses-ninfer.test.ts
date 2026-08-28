import { afterEach, describe, expect, it, vi } from "bun:test";
import { NInferCheckpointError, requestNInferCheckpoint } from "@oh-my-pi/pi-ai/providers/ninfer";
import { restoreOpenAIResponsesProviderState, streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type {
	Context,
	FetchImpl,
	Model,
	ProviderSessionState,
	ProviderStatePersistenceUpdate,
	Tool,
} from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { logger } from "@oh-my-pi/pi-utils";

const bundledModel = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;
const model: Model<"openai-responses"> = {
	...bundledModel,
	provider: "ninfer-local",
	id: "qwen3.8-27b",
	name: "Qwen3.8 27B (NInfer)",
	baseUrl: "http://127.0.0.1:18080/v1",
	requestModelId: "q38-ninfer",
	compat: {
		...bundledModel.compat,
		ninferStatefulResponses: true,
	},
};

const systemPrompt = ["You are a helpful assistant."];
const firstUser = { role: "user" as const, content: "First question", timestamp: 1000 };

function createStatefulSse(text: string, responseId: string): Response {
	const events = [
		{ type: "response.created", response: { id: responseId } },
		{
			type: "response.output_item.added",
			item: { type: "message", id: `msg_${responseId}`, role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: text },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: `msg_${responseId}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: responseId,
				status: "completed",
				usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	];
	return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}
function createToolCallSse(responseId: string, callId: string): Response {
	const argumentsJson = JSON.stringify({ path: "state.txt" });
	const events = [
		{ type: "response.created", response: { id: responseId } },
		{
			type: "response.output_item.added",
			item: { type: "function_call", id: "fc_exact_1", call_id: callId, name: "read", arguments: "" },
		},
		{ type: "response.function_call_arguments.delta", item_id: "fc_exact_1", delta: argumentsJson },
		{
			type: "response.output_item.done",
			item: {
				type: "function_call",
				id: "fc_exact_1",
				call_id: callId,
				name: "read",
				arguments: argumentsJson,
			},
		},
		{
			type: "response.completed",
			response: {
				id: responseId,
				status: "completed",
				usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	];
	return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createStatusFixture(): Record<string, unknown> {
	return {
		artifact_type: "ninfer_server_status",
		schema_version: 1,
		status: "ok",
		identity: {
			upstream_base_sha: "a".repeat(40),
			patch_stack_sha: "b".repeat(40),
			source_dirty: false,
			binary_sha256: "c".repeat(64),
			model_artifact_sha256: "d".repeat(64),
			config_sha256: "e".repeat(64),
			deployment_profile: "rtx5090-linux",
			target: "sm_120a",
			model_id: "qwen3.8-27b",
		},
		runtime: { public_model_id: "q38-ninfer", max_context: 131072 },
		scheduler: {
			max_concurrency: 1,
			max_pending_requests: 4,
			running: 0,
			prefilling: 0,
			decode_ready: 0,
			waiting: 0,
			materializing: 0,
			capture_pending: 0,
		},
		cache: { private_catalog: { occupied: 1, capacity: 8 }, reused_prompt_tokens: 16 },
		mtp: { rounds: 2, drafted_tokens: 6, accepted_tokens: 4, fallback_steps: 0 },
	};
}

function statusSection(status: Record<string, unknown>, key: "identity" | "runtime"): Record<string, unknown> {
	const value = status[key];
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`missing status ${key}`);
	return value as Record<string, unknown>;
}

interface NInferFetchHarness {
	fetch: FetchImpl;
	postBodies: Array<Record<string, unknown>>;
	statusHeaders: Headers[];
	status: Record<string, unknown>;
	setChainedFailure(failure: "stale" | "generic" | undefined): void;
}

function createNInferFetchHarness(): NInferFetchHarness {
	const postBodies: Array<Record<string, unknown>> = [];
	const statusHeaders: Headers[] = [];
	const status = createStatusFixture();
	let chainedFailure: "stale" | "generic" | undefined;
	let successfulResponses = 0;
	const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("/v1/ninfer/status")) {
			statusHeaders.push(new Headers(init?.headers));
			return Response.json(status);
		}
		const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
		postBodies.push(request);
		if (typeof request.previous_response_id === "string" && chainedFailure) {
			const failure = chainedFailure;
			chainedFailure = undefined;
			return Response.json(
				failure === "stale"
					? {
							error: {
								message: "Previous response expired.",
								type: "invalid_request_error",
								param: "previous_response_id",
								code: "previous_response_expired",
							},
						}
					: { error: { message: "Request blocked.", type: "invalid_request_error", code: "invalid_prompt" } },
				{ status: failure === "stale" ? 404 : 400 },
			);
		}
		successfulResponses++;
		return createStatefulSse(`Answer ${successfulResponses}`, `resp_${successfulResponses}`);
	}) as FetchImpl;
	return {
		fetch,
		postBodies,
		statusHeaders,
		status,
		setChainedFailure(failure) {
			chainedFailure = failure;
		},
	};
}

function takePendingPersistence(
	providerSessionState: Map<string, ProviderSessionState>,
	responseId: string,
): ProviderStatePersistenceUpdate | undefined {
	let selected: ProviderStatePersistenceUpdate | undefined;
	for (const state of providerSessionState.values()) {
		const candidate = state.takePendingPersistence?.({
			provider: model.provider,
			model: model.id,
			responseId,
		});
		if (!candidate) continue;
		if (selected) throw new Error("multiple pending provider updates");
		selected = candidate;
	}
	return selected;
}

function requirePendingPersistence(
	providerSessionState: Map<string, ProviderSessionState>,
	responseId: string | undefined,
): ProviderStatePersistenceUpdate {
	if (!responseId) throw new Error("response did not carry an id");
	const update = takePendingPersistence(providerSessionState, responseId);
	if (!update) throw new Error("provider did not stage persistence");
	return update;
}

function options(providerSessionState: Map<string, ProviderSessionState>, fetch: FetchImpl) {
	return {
		apiKey: "test-key",
		sessionId: "persisted-ninfer-session",
		providerSessionState,
		providerStatePersistence: true,
		reasoning: "low" as const,
		fetch,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});
describe("NInfer stateful OpenAI Responses", () => {
	it("authenticates status, persists a restart baseline, and invalidates changed endpoint identity", async () => {
		const harness = createNInferFetchHarness();
		const initialState = new Map<string, ProviderSessionState>();
		const firstResponse = await streamOpenAIResponses(
			model,
			{ systemPrompt, messages: [firstUser] },
			options(initialState, harness.fetch),
		).result();
		expect(firstResponse.stopReason).toBe("stop");
		const firstUpdate = requirePendingPersistence(initialState, firstResponse.responseId);
		expect(JSON.stringify(firstUpdate.snapshot.requestBaseline)).not.toContain("ninfer_session");
		expect(firstUpdate.snapshot.ninferAffinity).toMatchObject({
			schemaVersion: 1,
			profile: "rtx5090-linux",
			model: "q38-ninfer",
			artifactSha256: "d".repeat(64),
		});
		expect(firstUpdate.snapshot.ninferAffinity?.sessionSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(JSON.stringify(firstUpdate.snapshot)).not.toContain("persisted-ninfer-session");
		expect(JSON.stringify(firstUpdate.snapshot)).not.toContain("127.0.0.1");
		expect(JSON.stringify(firstUpdate.snapshot)).not.toContain("test-key");
		firstUpdate.commit();

		const restoredState = new Map<string, ProviderSessionState>();
		expect(
			restoreOpenAIResponsesProviderState({
				model,
				providerSessionState: restoredState,
				sessionId: "persisted-ninfer-session",
				snapshot: firstUpdate.snapshot,
			}),
		).toBe(true);
		const secondUser = { role: "user" as const, content: "Second question", timestamp: 1001 };
		const secondResponse = await streamOpenAIResponses(
			model,
			{ systemPrompt, messages: [firstUser, firstResponse, secondUser] },
			options(restoredState, harness.fetch),
		).result();
		expect(secondResponse.stopReason).toBe("stop");
		requirePendingPersistence(restoredState, secondResponse.responseId).commit();

		statusSection(harness.status, "identity").config_sha256 = "f".repeat(64);
		const thirdResponse = await streamOpenAIResponses(
			model,
			{
				systemPrompt,
				messages: [
					firstUser,
					firstResponse,
					secondUser,
					secondResponse,
					{ role: "user", content: "Third question", timestamp: 1002 },
				],
			},
			options(restoredState, harness.fetch),
		).result();
		expect(thirdResponse.stopReason).toBe("stop");
		requirePendingPersistence(restoredState, thirdResponse.responseId).commit();

		expect(harness.statusHeaders).toHaveLength(3);
		for (const headers of harness.statusHeaders) expect(headers.get("authorization")).toBe("Bearer test-key");
		expect(harness.postBodies).toHaveLength(3);
		for (const body of harness.postBodies) {
			expect(body.include).toBeUndefined();
			expect(body.prompt_cache_key).toBeUndefined();
			expect(body.session_id).toBeUndefined();
			expect(body.reasoning).toEqual({ effort: "low" });
		}
		expect(harness.postBodies[0]?.model).toBe("q38-ninfer");
		expect(harness.postBodies[0]?.previous_response_id).toBeUndefined();
		expect(harness.postBodies[1]?.previous_response_id).toBe("resp_1");
		expect(JSON.stringify(harness.postBodies[1]?.input)).toContain("Second question");
		expect(JSON.stringify(harness.postBodies[1]?.input)).not.toContain("First question");
		expect(harness.postBodies[2]?.previous_response_id).toBeUndefined();
		expect(JSON.stringify(harness.postBodies[2]?.input)).toContain("First question");
		expect(JSON.stringify(harness.postBodies[2]?.input)).toContain("Third question");
		const sessions = harness.postBodies.map(body => body.ninfer_session);
		const requests = harness.postBodies.map(body => body.ninfer_request_id);
		for (const value of [...sessions, ...requests]) expect(value).toMatch(/^[0-9a-f]{64}$/);
		expect(new Set(sessions).size).toBe(1);
		expect(new Set(requests).size).toBe(3);
		expect(JSON.stringify(harness.postBodies)).not.toContain("persisted-ninfer-session");
	});

	it("performs exactly one full replay for a classified stale baseline and records recovery", async () => {
		const harness = createNInferFetchHarness();
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});
		const providerSessionState = new Map<string, ProviderSessionState>();
		const firstResponse = await streamOpenAIResponses(
			model,
			{ systemPrompt, messages: [firstUser] },
			options(providerSessionState, harness.fetch),
		).result();
		requirePendingPersistence(providerSessionState, firstResponse.responseId).commit();
		harness.setChainedFailure("stale");

		const secondResponse = await streamOpenAIResponses(
			model,
			{
				systemPrompt,
				messages: [firstUser, firstResponse, { role: "user", content: "Second question", timestamp: 1001 }],
			},
			options(providerSessionState, harness.fetch),
		).result();
		expect(secondResponse.stopReason).toBe("stop");
		expect(secondResponse.provider_state_recovery).toBe("full_replay");
		const update = requirePendingPersistence(providerSessionState, secondResponse.responseId);
		expect(update.snapshot.providerStateRecovery).toBe("full_replay");
		update.commit();
		expect(harness.postBodies).toHaveLength(3);
		expect(harness.postBodies[1]?.previous_response_id).toBe("resp_1");
		expect(harness.postBodies[2]?.previous_response_id).toBeUndefined();
		expect(JSON.stringify(harness.postBodies[2]?.input)).toContain("First question");
		expect({ provider_state_recovery: secondResponse.provider_state_recovery }).toEqual({
			provider_state_recovery: "full_replay",
		});
		const recoveryLogs = JSON.stringify(debugSpy.mock.calls);
		expect(recoveryLogs).not.toContain("resp_1");
		expect(recoveryLogs).not.toContain("persisted-ninfer-session");
		expect(recoveryLogs).not.toContain("test-key");
	});

	it("keeps the prior response anchor after an unrelated provider failure", async () => {
		const harness = createNInferFetchHarness();
		const providerSessionState = new Map<string, ProviderSessionState>();
		const firstResponse = await streamOpenAIResponses(
			model,
			{ systemPrompt, messages: [firstUser] },
			options(providerSessionState, harness.fetch),
		).result();
		requirePendingPersistence(providerSessionState, firstResponse.responseId).commit();
		const secondContext: Context = {
			systemPrompt,
			messages: [firstUser, firstResponse, { role: "user", content: "Second question", timestamp: 1001 }],
		};
		harness.setChainedFailure("generic");
		const failed = await streamOpenAIResponses(
			model,
			secondContext,
			options(providerSessionState, harness.fetch),
		).result();
		expect(failed.stopReason).toBe("error");
		expect(failed.provider_state_recovery).toBeUndefined();
		expect(takePendingPersistence(providerSessionState, failed.responseId ?? "missing")).toBeUndefined();

		const retried = await streamOpenAIResponses(
			model,
			secondContext,
			options(providerSessionState, harness.fetch),
		).result();
		expect(retried.stopReason).toBe("stop");
		requirePendingPersistence(providerSessionState, retried.responseId).commit();
		expect(harness.postBodies).toHaveLength(3);
		expect(harness.postBodies[1]?.previous_response_id).toBe("resp_1");
		expect(harness.postBodies[2]?.previous_response_id).toBe("resp_1");
	});

	it("invalidates continuation when the active tool schema changes", async () => {
		const harness = createNInferFetchHarness();
		const providerSessionState = new Map<string, ProviderSessionState>();
		const readToolV1: Tool = {
			name: "read",
			description: "Read a file",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			},
		};
		const readToolV2: Tool = {
			...readToolV1,
			parameters: {
				type: "object",
				properties: { path: { type: "string" }, line: { type: "number" } },
				required: ["path"],
			},
		};
		const firstResponse = await streamOpenAIResponses(
			model,
			{ systemPrompt, messages: [firstUser], tools: [readToolV1] },
			options(providerSessionState, harness.fetch),
		).result();
		requirePendingPersistence(providerSessionState, firstResponse.responseId).commit();
		const secondResponse = await streamOpenAIResponses(
			model,
			{
				systemPrompt,
				tools: [readToolV2],
				messages: [firstUser, firstResponse, { role: "user", content: "Second question", timestamp: 1001 }],
			},
			options(providerSessionState, harness.fetch),
		).result();
		expect(secondResponse.stopReason).toBe("stop");
		requirePendingPersistence(providerSessionState, secondResponse.responseId).commit();
		expect(harness.postBodies).toHaveLength(2);
		expect(harness.postBodies[1]?.previous_response_id).toBeUndefined();
		expect(JSON.stringify(harness.postBodies[1]?.input)).toContain("First question");
	});

	it("preserves exact tool-call pairing in a typed continuation delta", async () => {
		const harness = createNInferFetchHarness();
		const providerSessionState = new Map<string, ProviderSessionState>();
		let responseIndex = 0;
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			if (String(input).endsWith("/v1/ninfer/status")) return harness.fetch(input, init);
			const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
			harness.postBodies.push(request);
			responseIndex++;
			return responseIndex === 1
				? createToolCallSse("resp_tool", "call_exact_123")
				: createStatefulSse("done", "resp_after_tool");
		}) as FetchImpl;
		const readTool: Tool = {
			name: "read",
			description: "Read a file",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			},
		};
		const firstResponse = await streamOpenAIResponses(
			model,
			{ systemPrompt, messages: [firstUser], tools: [readTool] },
			options(providerSessionState, fetchMock),
		).result();
		const toolCall = firstResponse.content.find(content => content.type === "toolCall");
		expect(toolCall?.id).toBe("call_exact_123|fc_exact_1");
		requirePendingPersistence(providerSessionState, firstResponse.responseId).commit();
		const secondResponse = await streamOpenAIResponses(
			model,
			{
				systemPrompt,
				tools: [readTool],
				messages: [
					firstUser,
					firstResponse,
					{
						role: "toolResult",
						toolCallId: toolCall?.id ?? "missing-tool-call",
						toolName: "read",
						content: [{ type: "text", text: "file body" }],
						isError: false,
						timestamp: 1001,
					},
				],
			},
			options(providerSessionState, fetchMock),
		).result();
		expect(secondResponse.stopReason).toBe("stop");
		requirePendingPersistence(providerSessionState, secondResponse.responseId).commit();
		expect(harness.postBodies[1]?.previous_response_id).toBe("resp_tool");
		const delta = harness.postBodies[1]?.input as Array<Record<string, unknown>>;
		expect(delta).toHaveLength(1);
		expect(delta[0]?.type).toBe("function_call_output");
		expect(delta[0]?.call_id).toBe("call_exact_123");
	});

	it("preserves the prior response anchor after caller cancellation", async () => {
		const harness = createNInferFetchHarness();
		const providerSessionState = new Map<string, ProviderSessionState>();
		const firstResponse = await streamOpenAIResponses(
			model,
			{ systemPrompt, messages: [firstUser] },
			options(providerSessionState, harness.fetch),
		).result();
		requirePendingPersistence(providerSessionState, firstResponse.responseId).commit();
		const secondContext: Context = {
			systemPrompt,
			messages: [firstUser, firstResponse, { role: "user", content: "Second question", timestamp: 1001 }],
		};
		const controller = new AbortController();
		const cancelFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			if (String(input).endsWith("/v1/ninfer/status")) return harness.fetch(input, init);
			const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
			harness.postBodies.push(request);
			controller.abort();
			throw controller.signal.reason;
		}) as FetchImpl;
		const cancelled = await streamOpenAIResponses(model, secondContext, {
			...options(providerSessionState, cancelFetch),
			signal: controller.signal,
		}).result();
		expect(cancelled.stopReason).toBe("aborted");
		expect(cancelled.provider_state_recovery).toBeUndefined();

		const retried = await streamOpenAIResponses(
			model,
			secondContext,
			options(providerSessionState, harness.fetch),
		).result();
		expect(retried.stopReason).toBe("stop");
		requirePendingPersistence(providerSessionState, retried.responseId).commit();
		expect(harness.postBodies).toHaveLength(3);
		expect(harness.postBodies[1]?.previous_response_id).toBe("resp_1");
		expect(harness.postBodies[2]?.previous_response_id).toBe("resp_1");
	});

	it("fails closed when authenticated status serves a different model", async () => {
		const harness = createNInferFetchHarness();
		statusSection(harness.status, "runtime").public_model_id = "unexpected-model";
		const response = await streamOpenAIResponses(
			model,
			{ messages: [firstUser] },
			options(new Map(), harness.fetch),
		).result();
		expect(response.stopReason).toBe("error");
		expect(response.errorMessage).toContain("does not match the configured wire model");
		expect(response.errorMessage).not.toContain("test-key");
		expect(response.errorMessage).not.toContain("persisted-ninfer-session");
		expect(harness.postBodies).toHaveLength(0);
	});
	it("fails closed before a provider request when authentication is absent", async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error("fetch must not be called");
		}) as FetchImpl;
		const response = await streamOpenAIResponses(
			model,
			{ messages: [firstUser] },
			{
				...options(new Map(), fetchMock),
				apiKey: " ",
			},
		).result();
		expect(response.stopReason).toBe("error");
		expect(response.errorMessage).toContain("authentication is required");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("NInfer durable checkpoint client", () => {
	it("uses the authenticated operation-specific checkpoint contract", async () => {
		const sessionSha256 = "a".repeat(64);
		const calls: Array<{
			url: string;
			method: string;
			authorization: string | null;
			contentType: string | null;
			body: RequestInit["body"];
		}> = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			calls.push({
				url: String(input),
				method,
				authorization: new Headers(init?.headers).get("authorization"),
				contentType: new Headers(init?.headers).get("content-type"),
				body: init?.body,
			});
			return Response.json({
				artifact_type: "ninfer_session_checkpoint_status",
				schema_version: 1,
				state: method === "DELETE" ? "deleted" : "available",
				generation: "gen-7",
				bytes: 4096,
				frontier_tokens: 32768,
				restored_tokens: 30000,
				response_records: 2,
			});
		}) as FetchImpl;
		for (const operation of ["status", "save", "delete"] as const) {
			await requestNInferCheckpoint({
				operation,
				sessionSha256,
				baseUrl: "http://127.0.0.1:18080/v1",
				apiKey: "checkpoint-key",
				fetch: fetchMock,
			});
		}
		expect(calls.map(call => call.method)).toEqual(["GET", "POST", "DELETE"]);
		expect(calls.map(call => call.url)).toEqual([
			`http://127.0.0.1:18080/v1/ninfer/checkpoints/${sessionSha256}/status`,
			"http://127.0.0.1:18080/v1/ninfer/checkpoints",
			`http://127.0.0.1:18080/v1/ninfer/checkpoints/${sessionSha256}`,
		]);
		for (const call of calls) {
			expect(call.authorization).toBe("Bearer checkpoint-key");
		}
		expect(calls[0]).toMatchObject({ contentType: null, body: undefined });
		expect(calls[1]).toMatchObject({
			contentType: "application/json",
			body: JSON.stringify({ session_sha256: sessionSha256 }),
		});
		expect(calls[2]).toMatchObject({ contentType: null, body: undefined });
	});

	it("classifies a save with no complete response as unavailable", async () => {
		const error = await requestNInferCheckpoint({
			operation: "save",
			sessionSha256: "b".repeat(64),
			baseUrl: "http://127.0.0.1:18080/v1",
			apiKey: "checkpoint-key",
			fetch: vi.fn(async () => Response.json({ code: "checkpoint_unavailable" }, { status: 409 })) as FetchImpl,
		}).catch(candidate => candidate);
		expect(error).toBeInstanceOf(NInferCheckpointError);
		expect(error).toMatchObject({ kind: "unavailable", status: 409 });
	});

	it("cancels oversized checkpoint responses before buffering the full body", async () => {
		const chunk = new Uint8Array(16 * 1024).fill(0x20);
		let pulls = 0;
		let cancelled = false;
		const response = new Response(
			new ReadableStream<Uint8Array>({
				pull(controller) {
					pulls += 1;
					if (pulls > 32) {
						controller.close();
						return;
					}
					controller.enqueue(chunk);
				},
				cancel() {
					cancelled = true;
				},
			}),
			{ headers: { "content-type": "application/json" } },
		);

		const error = await requestNInferCheckpoint({
			operation: "status",
			sessionSha256: "c".repeat(64),
			baseUrl: "http://127.0.0.1:18080/v1",
			apiKey: "checkpoint-key",
			fetch: vi.fn(async () => response) as FetchImpl,
		}).catch(candidate => candidate);

		expect(error).toBeInstanceOf(NInferCheckpointError);
		expect(error).toMatchObject({ kind: "schema" });
		expect(cancelled).toBe(true);
		expect(pulls).toBeLessThan(32);
	});
});
