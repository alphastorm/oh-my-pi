import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { LocalAppliancePlatform } from "@oh-my-pi/pi-coding-agent/appliance/platform";
import { APPLIANCE_PROFILES } from "@oh-my-pi/pi-coding-agent/appliance/registry";
import type { ApplianceProfile } from "@oh-my-pi/pi-coding-agent/appliance/types";
import { TempDir } from "@oh-my-pi/pi-utils";

function launchableProfile(): ApplianceProfile {
	const profile = APPLIANCE_PROFILES.find(candidate => candidate.profile === "rtx5090-linux");
	if (!profile) throw new Error("RTX 5090 profile missing");
	return {
		...profile,
		launch: {
			executable: "runtime",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: Launch descriptor placeholders are literal tokens.
			args: ["--model", "${model}", "--host", "${host}", "--port", "${port}", "--served-model", "${served_model}"],
			secretEnvironmentVariable: "NINFER_API_KEY",
		},
	};
}

describe("local appliance platform", () => {
	it("creates an isolated private candidate and reports spawn failure without leaking its secret", async () => {
		using temp = TempDir.createSync("@omp-appliance-platform-");
		const platform = new LocalAppliancePlatform(temp.path());
		const runtimeRef = path.join("artifacts", "runtime", "1".repeat(64));
		const modelRef = path.join("artifacts", "model", "2".repeat(64));
		const secret = "candidate-secret-must-not-leak";

		const candidate = await platform.createCandidate({
			profile: launchableProfile(),
			runtimeRef,
			modelRef,
			secret,
			port: 8000,
			installationId: "install-1",
		});

		const candidateDir = path.join(temp.path(), "appliance", candidate.handle);
		const manifestPath = path.join(candidateDir, "service.json");
		const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
		expect(manifest.command).toBe(path.join(temp.path(), "appliance", runtimeRef));
		expect(manifest.args).toEqual([
			"--model",
			path.join(temp.path(), "appliance", modelRef),
			"--host",
			"127.0.0.1",
			"--port",
			"8000",
			"--served-model",
			"q38-ninfer",
		]);
		expect(JSON.stringify(manifest)).not.toContain(secret);
		if (process.platform !== "win32") {
			expect((await fs.stat(manifestPath)).mode & 0o777).toBe(0o600);
		}

		let error: unknown;
		try {
			await platform.startCandidate(candidate);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(Error);
		expect(await fs.exists(path.join(candidateDir, "pid"))).toBe(false);
		expect(await fs.readFile(path.join(candidateDir, "service.log"), "utf8")).not.toContain(secret);
	});

	it("refuses to signal a persisted process it did not launch", async () => {
		using temp = TempDir.createSync("@omp-appliance-platform-unowned-");
		const platform = new LocalAppliancePlatform(temp.path());
		const candidate = await platform.createCandidate({
			profile: launchableProfile(),
			runtimeRef: path.join("artifacts", "runtime", "1".repeat(64)),
			modelRef: path.join("artifacts", "model", "2".repeat(64)),
			secret: "candidate-secret",
			port: 8000,
			installationId: "install-unowned",
		});
		const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		try {
			await fs.writeFile(path.join(temp.path(), "appliance", candidate.handle, "pid"), `${String(child.pid)}\n`);
			await expect(platform.stopCandidate(candidate.handle)).rejects.toThrow(
				"Appliance candidate process ownership cannot be proven",
			);
			expect(process.kill(child.pid, 0)).toBe(true);
		} finally {
			child.kill("SIGTERM");
			await child.exited;
		}
	});

	it("measures TTFT, prefix reuse, and decode throughput from bounded Responses streams", async () => {
		using temp = TempDir.createSync("@omp-appliance-platform-metrics-");
		const platform = new LocalAppliancePlatform(temp.path());
		const originalFetch = globalThis.fetch;
		const requests: Array<Record<string, unknown>> = [];
		let requestNumber = 0;
		const responseBody = (
			id: string,
			text: string,
			inputTokens: number,
			cachedTokens: number,
			outputTokens: number,
		): Record<string, unknown> => ({
			id,
			output: [{ type: "message", content: [{ type: "output_text", text }] }],
			usage: {
				input_tokens: inputTokens,
				input_tokens_details: { cached_tokens: cachedTokens },
				output_tokens: outputTokens,
			},
		});
		const streamResponse = (
			body: Record<string, unknown>,
			firstTokenDelayMs: number,
			completedDelayMs: number,
		): Response => {
			const encoder = new TextEncoder();
			const event = (type: string, payload: Record<string, unknown>): Uint8Array =>
				encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						setTimeout(
							() => controller.enqueue(event("response.output_text.delta", { delta: "token" })),
							firstTokenDelayMs,
						);
						setTimeout(() => {
							controller.enqueue(event("response.completed", { response: body }));
							controller.close();
						}, completedDelayMs);
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		};

		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			requestNumber += 1;
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			requests.push(body);
			switch (requestNumber) {
				case 1:
					return Response.json({
						output: [{ type: "function_call", name: "echo", arguments: JSON.stringify({ value: "ok" }) }],
					});
				case 2:
					return streamResponse(responseBody("resp-decode", "OMP_OK", 4, 0, 4), 2, 12);
				case 3:
					return streamResponse(responseBody("resp-cold", "one", 4_100, 0, 2), 30, 35);
				case 4:
					return streamResponse(responseBody("resp-warm", "two", 4_102, 4_098, 2), 2, 7);
				default:
					throw new Error("unexpected qualification request");
			}
		}) as typeof fetch;

		try {
			const result = await platform.quickQualification(
				{ candidateId: "candidate", handle: "candidates/candidate", endpoint: "http://127.0.0.1:8000", port: 8000 },
				"private-test-secret",
			);

			expect(result.ok).toBe(true);
			expect(result.metrics).toBeDefined();
			expect(result.metrics?.coldTtftMs).toBeGreaterThanOrEqual(20);
			expect(result.metrics?.warmTtftMs).toBeLessThan(result.metrics?.coldTtftMs ?? 0);
			expect(result.metrics?.prefixReusePercent).toBeCloseTo(99.902, 3);
			expect(result.metrics?.decodeTokensPerSecond).toBeGreaterThan(0);
			expect(requests.map(request => request.stream)).toEqual([undefined, true, true, true]);
			expect(requests[3]?.previous_response_id).toBe("resp-cold");
			expect(JSON.stringify(result)).not.toContain("private-test-secret");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("bounds the complete Responses stream rather than only the current event buffer", async () => {
		using temp = TempDir.createSync("@omp-appliance-platform-stream-limit-");
		const platform = new LocalAppliancePlatform(temp.path());
		const originalFetch = globalThis.fetch;
		const encoder = new TextEncoder();
		const event = encoder.encode(
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "x".repeat(64 * 1024) })}\n\n`,
		);
		let requestNumber = 0;
		let pulls = 0;
		let cancelled = false;

		globalThis.fetch = (async (): Promise<Response> => {
			requestNumber += 1;
			if (requestNumber === 1) {
				return Response.json({
					output: [{ type: "function_call", name: "echo", arguments: JSON.stringify({ value: "ok" }) }],
				});
			}
			if (requestNumber === 2) {
				return new Response(
					new ReadableStream<Uint8Array>({
						pull(controller) {
							pulls += 1;
							if (pulls > 100) {
								controller.close();
								return;
							}
							controller.enqueue(event);
						},
						cancel() {
							cancelled = true;
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				);
			}
			return new Response(null, { status: 503 });
		}) as unknown as typeof fetch;

		try {
			const result = await platform.quickQualification(
				{ candidateId: "candidate", handle: "candidates/candidate", endpoint: "http://127.0.0.1:8000", port: 8000 },
				"private-test-secret",
			);

			expect(result.ok).toBe(false);
			expect(result.cases.find(testCase => testCase.name === "short-decode")?.ok).toBe(false);
			expect(cancelled).toBe(true);
			expect(pulls).toBeLessThan(100);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
