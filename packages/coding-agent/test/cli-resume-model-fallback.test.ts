import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

const cliEntry = path.resolve(import.meta.dir, "../src/cli.ts");

describe("headless startup resume", () => {
	test.each(["print", "rpc", "rpc-ui"])(
		"does not send a saved transcript to the settings default in %s mode",
		async mode => {
			using tempDir = TempDir.createSync("@omp-resume-model-");
			const requests: string[] = [];
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(request) {
					requests.push(await request.text());
					return Response.json({ error: { message: "Unexpected transcript disclosure" } }, { status: 400 });
				},
			});
			try {
				const agentDir = tempDir.join("home", ".omp", "agent");
				await Bun.write(
					path.join(agentDir, "models.yml"),
					JSON.stringify({
						providers: {
							other: {
								baseUrl: `${server.url.origin}/v1`,
								api: "openai-completions",
								auth: "none",
								models: [
									{
										id: "default-model",
										name: "Default Model",
										reasoning: false,
										input: ["text"],
										cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
										contextWindow: 131072,
										maxTokens: 1024,
									},
								],
							},
						},
					}),
				);
				await Bun.write(
					path.join(agentDir, "config.yml"),
					JSON.stringify({
						modelRoles: { default: "other/default-model" },
						retry: { enabled: false },
						compaction: { enabled: false },
					}),
				);
				const sessionFile = tempDir.join("saved.jsonl");
				const timestamp = "2026-06-01T00:00:00.000Z";
				await Bun.write(
					sessionFile,
					`${[
						{ type: "session", version: 3, id: "saved", timestamp, cwd: tempDir.path() },
						{
							type: "model_change",
							id: "model",
							parentId: null,
							timestamp,
							model: "local/missing-model",
							role: "default",
						},
						{
							type: "message",
							id: "user",
							parentId: "model",
							timestamp,
							message: { role: "user", content: "Remember ZEBRA-42.", timestamp: Date.parse(timestamp) },
						},
					]
						.map(entry => JSON.stringify(entry))
						.join("\n")}\n`,
				);
				const rpc = mode === "rpc" || mode === "rpc-ui";
				const args = mode === "print" ? ["-p"] : ["--mode", mode];
				if (!rpc) args.push("Continue the previous turn.");
				const proc = Bun.spawn(
					[
						process.execPath,
						cliEntry,
						"--no-title",
						"--no-lsp",
						"--no-extensions",
						"--no-tools",
						"--resume",
						sessionFile,
						...args,
					],
					{
						cwd: tempDir.path(),
						env: {
							PATH: process.env.PATH,
							HOME: tempDir.join("home"),
							TMPDIR: process.env.TMPDIR,
							NO_COLOR: "1",
						},
						stdin: "pipe",
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				try {
					if (rpc) {
						proc.stdin.write(`${JSON.stringify({ id: "resume", type: "prompt", message: "Continue." })}\n`);
					} else {
						proc.stdin.end();
					}
					const stdout = (async () => {
						let text = "";
						for await (const bytes of proc.stdout) {
							text += new TextDecoder().decode(bytes);
							if (rpc && text.includes('"type":"agent_end"')) proc.stdin.end();
						}
						return text;
					})();
					const [exitCode, out, stderr] = await Promise.all([
						proc.exited,
						stdout,
						new Response(proc.stderr).text(),
					]);
					expect(stderr).toContain("Could not restore model local/missing-model");
					expect(exitCode).toBe(1);
					expect(requests).toEqual([]);
					expect(out).toBe("");
				} finally {
					proc.kill();
					await proc.exited;
				}
			} finally {
				server.stop(true);
			}
		},
		30_000,
	);
});
