import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type completeSimple, Effort, type ImageContent, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ImageAttachmentEntry, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { clearVisionRequestDedupe } from "@oh-my-pi/pi-coding-agent/utils/image-vision-dedupe";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const TINY_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="12" height="7"><rect width="12" height="7" fill="red"/></svg>';

const visionModel: Model<"openai-responses"> = buildModel({
	id: "gpt-4o",
	name: "GPT-4o",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
	contextWindow: 128000,
	maxTokens: 4096,
});

const textOnlyModel: Model<"openai-responses"> = {
	...visionModel,
	id: "gpt-4.1",
	input: ["text"],
};

const reasoningVisionModel: Model<"openai-responses"> = {
	...visionModel,
	id: "gpt-5-vision",
	reasoning: true,
	thinking: { mode: "effort", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
};

interface CreateSessionOptions {
	availableModels?: Model<"openai-responses">[];
	activeModel?: Model<"openai-responses">;
	configureVisionRole?: boolean;
	imageAttachments?: ImageAttachmentEntry[];
	sessionEntryCount?: () => number;
	includeSessionManager?: boolean;
	qualificationScopeId?: string | null;
}

interface CompleteSimpleStub {
	calls: unknown[][];
	fn: typeof completeSimple;
}

function createSession(
	cwd: string,
	model: Model<"openai-responses">,
	apiKey: string | undefined = "test-key",
	settings = Settings.isolated(),
	options: CreateSessionOptions = {},
): ToolSession {
	settings.set("images.autoResize", false);
	const availableModels = options.availableModels ?? [model];
	const activeModel = options.activeModel ?? model;
	if (options.configureVisionRole !== false) {
		settings.setModelRole("vision", `${model.provider}/${model.id}`);
	}

	const session: ToolSession = {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionId: () => cwd,
		getSessionSpawns: () => "*",
		getModelString: () => `${activeModel.provider}/${activeModel.id}`,
		getActiveModelString: () => `${activeModel.provider}/${activeModel.id}`,
		getActiveModel: () => activeModel,
		settings,
		modelRegistry: {
			getAvailable: () => availableModels,
			getApiKey: async () => apiKey,
			getApiKeyForProvider: async () => apiKey,
			authStorage: { rotateSessionCredential: async () => false },
			resolver: () => async () => apiKey,
		} as unknown as NonNullable<ToolSession["modelRegistry"]>,
		sessionManager:
			options.includeSessionManager === false
				? undefined
				: ({
						getEntries: () => Array.from({ length: options.sessionEntryCount?.() ?? 0 }),
						getBranch: () =>
							options.qualificationScopeId === null
								? []
								: [
										{
											type: "message",
											id: options.qualificationScopeId ?? "user-turn",
											parentId: null,
											timestamp: "2026-08-20T00:00:00.000Z",
											message: { role: "user", content: "test", timestamp: 0 },
										},
									],
					} as unknown as NonNullable<ToolSession["sessionManager"]>),
	};
	if (options.imageAttachments) {
		session.getImageAttachments = () => options.imageAttachments ?? [];
	}
	return session;
}

function createCompleteSimpleSuccessStub(text: string): CompleteSimpleStub {
	const calls: unknown[][] = [];
	const fn = (async (...args: unknown[]) => {
		calls.push(args);
		return {
			role: "assistant",
			api: visionModel.api,
			provider: visionModel.provider,
			model: visionModel.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
			content: [{ type: "text", text }],
		};
	}) as typeof completeSimple;
	return { calls, fn };
}

function createCompleteSimpleForbiddenStub(): CompleteSimpleStub {
	const calls: unknown[][] = [];
	const fn = (async (...args: unknown[]) => {
		calls.push(args);
		throw new Error("completeSimple should not be called");
	}) as typeof completeSimple;
	return { calls, fn };
}

function createCompleteSimpleHangingStub(): CompleteSimpleStub {
	const calls: unknown[][] = [];
	const fn = (async (...args: unknown[]) => {
		calls.push(args);
		const options = args[2] as { signal?: AbortSignal } | undefined;
		const signal = options?.signal;
		const aborted = Promise.withResolvers<void>();
		if (signal?.aborted) aborted.resolve();
		else signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
		await aborted.promise;
		return {
			role: "assistant",
			api: visionModel.api,
			provider: visionModel.provider,
			model: visionModel.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "aborted",
			timestamp: Date.now(),
			content: [],
		};
	}) as unknown as typeof completeSimple;
	return { calls, fn };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
}

describe("read image questions", () => {
	let testDir: string;
	let imagePath: string;

	beforeAll(() => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-read-image-question-"));
		imagePath = path.join(testDir, "screen.png");
		fs.writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
	});

	afterEach(() => {
		clearVisionRequestDedupe(testDir);
	});

	afterAll(() => {
		removeSyncWithRetries(testDir);
	});

	it("returns only answer text and sends image before the question", async () => {
		const stub = createCompleteSimpleSuccessStub("Detected text: Settings");
		const tool = new ReadTool(createSession(testDir, visionModel), stub.fn);

		const result = await tool.execute("call", { path: `${imagePath}?q=What text is visible?` });

		expect(result.content).toEqual([{ type: "text", text: "Detected text: Settings" }]);
		expect(stub.calls).toHaveLength(1);
		const request = stub.calls[0]?.[1] as { messages?: Array<{ content?: unknown }> } | undefined;
		const content = request?.messages?.[0]?.content;
		const parts = (Array.isArray(content) ? content : []) as Array<{ type: string; text?: string }>;
		expect(parts[0]?.type).toBe("image");
		expect(parts[1]).toEqual({ type: "text", text: "What text is visible?" });
	});

	it("answers questions about attachment URLs", async () => {
		const image: ImageContent = { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" };
		const stub = createCompleteSimpleSuccessStub("Attached image");
		const session = createSession(testDir, visionModel, "test-key", Settings.isolated(), {
			imageAttachments: [{ label: "Image #1", uri: "attachment://1", image, sourcePath: imagePath }],
		});

		const result = await new ReadTool(session, stub.fn).execute("call", {
			path: "attachment://1?q=Describe the attachment",
		});

		expect(result.content).toEqual([{ type: "text", text: "Attached image" }]);
		expect(stub.calls).toHaveLength(1);
	});

	it("rasterizes selected SVGs before asking the vision model", async () => {
		const svgPath = path.join(testDir, "diagram.svg");
		fs.writeFileSync(svgPath, TINY_SVG);
		const stub = createCompleteSimpleSuccessStub("Red rectangle");

		const result = await new ReadTool(createSession(testDir, visionModel), stub.fn).execute("call", {
			path: `${svgPath}:img?q=Describe the diagram`,
		});

		expect(result.content).toEqual([{ type: "text", text: "Red rectangle" }]);
		const request = stub.calls[0]?.[1] as { messages?: Array<{ content?: unknown }> } | undefined;
		const content = request?.messages?.[0]?.content;
		const parts = (Array.isArray(content) ? content : []) as Array<{ type: string; mimeType?: string }>;
		expect(parts[0]?.mimeType).toBe("image/png");
	});

	it("forwards configured thinking effort", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("vision", `${reasoningVisionModel.provider}/${reasoningVisionModel.id}:high`);
		const stub = createCompleteSimpleSuccessStub("Red");
		const session = createSession(testDir, reasoningVisionModel, "test-key", settings, {
			configureVisionRole: false,
			availableModels: [reasoningVisionModel],
		});

		await new ReadTool(session, stub.fn).execute("call", { path: `${imagePath}?q=What color?` });

		const options = stub.calls[0]?.[2] as { reasoning?: string } | undefined;
		expect(options?.reasoning).toBe("high");
	});

	it("disables nested retries and credential rotation during qualification", async () => {
		const previous = process.env.CODE_MODE_QUALIFICATION_ACTIVE;
		process.env.CODE_MODE_QUALIFICATION_ACTIVE = "1";
		try {
			const stub = createCompleteSimpleSuccessStub("Red");
			const tool = new ReadTool(createSession(testDir, visionModel, "test-key"), stub.fn);

			await tool.execute("call-qualification", { path: `${imagePath}?q=What dominant color is this image?` });

			expect(stub.calls).toHaveLength(1);
			const options = stub.calls[0]?.[2] as
				| {
						apiKey?: unknown;
						preferWebsockets?: boolean;
						codexSseMaxAttempts?: number;
						loopGuard?: { enabled?: boolean };
				  }
				| undefined;
			expect(options?.apiKey).toBe("test-key");
			expect(options?.preferWebsockets).toBe(false);
			expect(options?.codexSseMaxAttempts).toBe(1);
			expect(options?.loopGuard).toEqual({ enabled: false });
		} finally {
			if (previous === undefined) {
				delete process.env.CODE_MODE_QUALIFICATION_ACTIVE;
			} else {
				process.env.CODE_MODE_QUALIFICATION_ACTIVE = previous;
			}
		}
	});

	it("fails closed before a qualification request without a stable scope", async () => {
		const previous = process.env.CODE_MODE_QUALIFICATION_ACTIVE;
		process.env.CODE_MODE_QUALIFICATION_ACTIVE = "1";
		try {
			const stub = createCompleteSimpleSuccessStub("Red");
			const tool = new ReadTool(
				createSession(testDir, visionModel, "test-key", Settings.isolated(), {
					includeSessionManager: false,
				}),
				stub.fn,
			);
			await expect(
				tool.execute("call-qualification-no-scope", {
					path: `${imagePath}?q=What dominant color is this image?`,
				}),
			).rejects.toThrow(/require a resolved credential, stable session, and user-turn scope/);
			expect(stub.calls).toHaveLength(0);
		} finally {
			if (previous === undefined) {
				delete process.env.CODE_MODE_QUALIFICATION_ACTIVE;
			} else {
				process.env.CODE_MODE_QUALIFICATION_ACTIVE = previous;
			}
		}
	});

	it("keeps a qualification scope stable while tool results extend the session", async () => {
		const previous = process.env.CODE_MODE_QUALIFICATION_ACTIVE;
		process.env.CODE_MODE_QUALIFICATION_ACTIVE = "1";
		try {
			let sessionEntryCount = 1;
			const stub = createCompleteSimpleSuccessStub("Red");
			const tool = new ReadTool(
				createSession(testDir, visionModel, "test-key", Settings.isolated(), {
					sessionEntryCount: () => sessionEntryCount,
					qualificationScopeId: "user-turn-1",
				}),
				stub.fn,
			);
			const first = await tool.execute("call-qualification-first", {
				path: `${imagePath}?q=What dominant color is this image?`,
			});
			sessionEntryCount += 1;
			const duplicate = await tool.execute("call-qualification-duplicate", {
				path: `${imagePath}?q=  WHAT dominant color is this IMAGE?  `,
			});

			expect(duplicate.content).toEqual(first.content);
			expect(stub.calls).toHaveLength(1);
		} finally {
			if (previous === undefined) {
				delete process.env.CODE_MODE_QUALIFICATION_ACTIVE;
			} else {
				process.env.CODE_MODE_QUALIFICATION_ACTIVE = previous;
			}
		}
	});

	it("collapses in-flight duplicates but delegates later turns and distinct follow-ups", async () => {
		const stub = createCompleteSimpleSuccessStub("answer");
		let sessionEntryCount = 0;
		const tool = new ReadTool(
			createSession(testDir, visionModel, "test-key", Settings.isolated(), {
				sessionEntryCount: () => sessionEntryCount,
			}),
			stub.fn,
		);
		const [first, duplicate] = await Promise.all([
			tool.execute("call-first", { path: `${imagePath}?q=What is visible?` }),
			tool.execute("call-duplicate", { path: `${imagePath}?q=  WHAT   is visible?  ` }),
		]);
		sessionEntryCount += 1;
		const laterTurn = await tool.execute("call-later-turn", { path: `${imagePath}?q=What is visible?` });
		const followUp = await tool.execute("call-follow-up", { path: `${imagePath}?q=Quote the visible text.` });

		expect(first.content).toEqual(duplicate.content);
		expect(laterTurn.content).toEqual([{ type: "text", text: "answer" }]);
		expect(followUp.content).toEqual([{ type: "text", text: "answer" }]);
		expect(stub.calls).toHaveLength(3);
	});

	it("maps a stalled vision request to the image question timeout", async () => {
		const stub = createCompleteSimpleHangingStub();
		const settings = Settings.isolated({ "images.questionTimeoutMs": 50 });
		const tool = new ReadTool(createSession(testDir, visionModel, "test-key", settings), stub.fn);
		const timeoutController = new AbortController();
		const nativeTimeout = AbortSignal.timeout;
		let sawConfiguredTimeout = false;
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(timeoutMs => {
			if (timeoutMs !== 50) return nativeTimeout(timeoutMs);
			sawConfiguredTimeout = true;
			queueMicrotask(() => timeoutController.abort());
			return timeoutController.signal;
		});

		try {
			await expect(tool.execute("call", { path: `${imagePath}?q=Anything?` })).rejects.toThrow(
				/Image question timed out/,
			);
		} finally {
			timeoutSpy.mockRestore();
		}
		expect(sawConfiguredTimeout).toBe(true);
		expect(stub.calls).toHaveLength(1);
	});

	it("blocks delegated image questions when image submission is disabled", async () => {
		const stub = createCompleteSimpleForbiddenStub();
		const settings = Settings.isolated({ "images.blockImages": true });
		const tool = new ReadTool(createSession(testDir, visionModel, "test-key", settings), stub.fn);

		await expect(tool.execute("call", { path: `${imagePath}?q=What is visible?` })).rejects.toThrow(
			/Image submission is disabled/,
		);
		expect(stub.calls).toHaveLength(0);
	});

	it("rejects a registry containing only text-only models", async () => {
		const stub = createCompleteSimpleForbiddenStub();
		const tool = new ReadTool(createSession(testDir, textOnlyModel), stub.fn);

		await expect(tool.execute("call", { path: `${imagePath}?q=What is visible?` })).rejects.toThrow(
			/does not support image input/,
		);
		expect(stub.calls).toHaveLength(0);
	});

	it("returns metadata and a question hint without pixels for text-only active models", async () => {
		const session = createSession(testDir, visionModel, "test-key", Settings.isolated(), {
			activeModel: textOnlyModel,
			availableModels: [textOnlyModel, visionModel],
		});
		const result = await new ReadTool(session).execute("call", { path: imagePath });

		expect(textOf(result)).toContain("Dimensions:");
		expect(textOf(result)).toContain("screen.png?q=<question>");
		expect(result.content.some(entry => entry.type === "image")).toBe(false);
	});
});
