import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
	fetchNInferStatus,
	requestNInferCheckpoint,
	type NInferCheckpointOperation,
	type NInferCheckpointStatus,
} from "@oh-my-pi/pi-ai/providers/ninfer";
import type {
	ApplianceAsset,
	ApplianceBenchmarkCase,
	ApplianceCandidate,
	ApplianceEndpointStatus,
	ApplianceHostFacts,
	ApplianceInstallation,
	AppliancePlatform,
	ApplianceProfile,
	ApplianceQuickQualification,
} from "./types";

const COMMAND_OUTPUT_LIMIT = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;

interface CandidateManifest {
	schemaVersion: 1;
	candidateId: string;
	command: string;
	args: string[];
	secretEnvironmentVariable: string;
	endpoint: string;
	port: number;
}

interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function gibibytes(bytes: number): number {
	return Math.round((bytes / 1024 ** 3) * 10) / 10;
}

function runCommand(command: string, args: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<CommandResult> {
	const { promise, resolve, reject } = Promise.withResolvers<CommandResult>();
	const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
	let stdout = "";
	let stderr = "";
	let settled = false;
	const append = (current: string, chunk: Buffer): string => {
		if (current.length >= COMMAND_OUTPUT_LIMIT) return current;
		return current + chunk.toString("utf8", 0, COMMAND_OUTPUT_LIMIT - current.length);
	};
	child.stdout.on("data", (chunk: Buffer) => {
		stdout = append(stdout, chunk);
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr = append(stderr, chunk);
	});
	const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
	child.once("error", error => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		reject(error);
	});
	child.once("close", code => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		resolve({ code: code ?? -1, stdout, stderr });
	});
	return promise;
}

async function commandAvailable(command: string, args: string[]): Promise<boolean> {
	try {
		return (await runCommand(command, args)).code === 0;
	} catch {
		return false;
	}
}

function safeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function endpointFor(target: ApplianceCandidate | ApplianceInstallation): string {
	return "endpoint" in target ? target.endpoint : target.route.baseUrl.replace(/\/v1\/?$/, "");
}

function servedModelFor(target: ApplianceCandidate | ApplianceInstallation): string | undefined {
	return "route" in target ? target.route.servedModel : undefined;
}

function authHeaders(secret: string): Record<string, string> {
	return { authorization: `Bearer ${secret}`, "content-type": "application/json" };
}

async function fetchJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
	const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
	if (!response.ok) throw new Error(`Appliance endpoint returned HTTP ${response.status}`);
	const value: unknown = await response.json();
	if (!isRecord(value)) throw new Error("Appliance endpoint returned invalid JSON");
	return value;
}

interface ResponsesStreamMeasurement {
	response: Record<string, unknown>;
	ttftMs: number;
	decodeMs: number;
}

async function fetchResponsesStream(url: string, init: RequestInit): Promise<ResponsesStreamMeasurement> {
	const started = performance.now();
	const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
	if (!response.ok) throw new Error(`Appliance endpoint returned HTTP ${response.status}`);
	if (!response.body) throw new Error("Appliance endpoint returned an empty stream");

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let firstTokenAt: number | undefined;
	let completedAt: number | undefined;
	let completed: Record<string, unknown> | undefined;
	const consume = (block: string): void => {
		const data = block
			.split("\n")
			.filter(line => line.startsWith("data:"))
			.map(line => line.slice(5).trimStart())
			.join("\n");
		if (!data || data === "[DONE]") return;
		const value: unknown = JSON.parse(data);
		if (!isRecord(value) || typeof value.type !== "string") {
			throw new Error("Appliance endpoint returned an invalid stream event");
		}
		if (
			firstTokenAt === undefined &&
			(value.type === "response.output_text.delta" || value.type === "response.reasoning_text.delta")
		) {
			firstTokenAt = performance.now();
		}
		if (value.type === "response.completed") {
			if (!isRecord(value.response)) throw new Error("Appliance endpoint returned an invalid completed response");
			completed = value.response;
			completedAt = performance.now();
		} else if (
			value.type === "response.failed" ||
			value.type === "response.cancelled" ||
			value.type === "response.incomplete"
		) {
			throw new Error("Appliance endpoint returned an incomplete response stream");
		}
	};

	while (true) {
		const { done, value } = await reader.read();
		buffer += decoder.decode(value, { stream: !done });
		buffer = buffer.replaceAll("\r\n", "\n");
		if (buffer.length > COMMAND_OUTPUT_LIMIT) throw new Error("Appliance response stream exceeded the size limit");
		let boundary = buffer.indexOf("\n\n");
		while (boundary >= 0) {
			consume(buffer.slice(0, boundary));
			buffer = buffer.slice(boundary + 2);
			boundary = buffer.indexOf("\n\n");
		}
		if (done) break;
	}
	if (buffer.trim()) consume(buffer);
	if (!completed || firstTokenAt === undefined || completedAt === undefined) {
		throw new Error("Appliance response stream omitted measurement events");
	}
	return {
		response: completed,
		ttftMs: Math.round(firstTokenAt - started),
		decodeMs: Math.max(completedAt - firstTokenAt, 1),
	};
}

function responseUsage(
	response: Record<string, unknown>,
): { inputTokens: number; cachedTokens: number; outputTokens: number } | undefined {
	if (!isRecord(response.usage) || !isRecord(response.usage.input_tokens_details)) return undefined;
	const inputTokens = safeNumber(response.usage.input_tokens);
	const cachedTokens = safeNumber(response.usage.input_tokens_details.cached_tokens);
	const outputTokens = safeNumber(response.usage.output_tokens);
	if (inputTokens === undefined || cachedTokens === undefined || outputTokens === undefined) return undefined;
	return { inputTokens, cachedTokens, outputTokens };
}

function extractOutputText(value: unknown): string {
	if (!value || typeof value !== "object") return "";
	if (Array.isArray(value)) return value.map(extractOutputText).join("");
	if (!isRecord(value)) return "";
	if ((value.type === "output_text" || value.type === "text") && typeof value.text === "string") return value.text;
	return Object.values(value).map(extractOutputText).join("");
}

function qualificationFields(seed: string): { ninfer_session: string; ninfer_request_id: string } {
	return {
		ninfer_session: sha256(`omp-appliance-qualification-session:${seed}`),
		ninfer_request_id: sha256(`omp-appliance-qualification-request:${seed}:${randomUUID()}`),
	};
}

export class LocalAppliancePlatform implements AppliancePlatform {
	readonly root: string;
	#candidateSecrets = new Map<string, string>();
	#candidateProcesses = new Map<string, ReturnType<typeof spawn>>();

	constructor(agentDir: string) {
		this.root = path.join(agentDir, "appliance");
	}

	async inspectHost(): Promise<ApplianceHostFacts> {
		let gpus: ApplianceHostFacts["gpus"] = [];
		let nvidiaDriver: string | undefined;
		let cudaVersion: string | undefined;
		try {
			const query = await runCommand("nvidia-smi", [
				"--query-gpu=name,uuid,memory.total,compute_cap,driver_version",
				"--format=csv,noheader,nounits",
			]);
			if (query.code === 0) {
				gpus = query.stdout
					.split("\n")
					.map(line => line.trim())
					.filter(Boolean)
					.flatMap(line => {
						const [model, uuid, memoryMiB, computeCapability, driver] = line
							.split(",")
							.map(value => value.trim());
						const memory = Number(memoryMiB);
						if (!model || !Number.isFinite(memory)) return [];
						nvidiaDriver ??= driver || undefined;
						return [
							{
								model,
								uuidHash: uuid ? sha256(uuid) : undefined,
								vramGiB: Math.round((memory / 1024) * 10) / 10,
								computeCapability: computeCapability || undefined,
							},
						];
					});
			}
			const summary = await runCommand("nvidia-smi", []);
			cudaVersion = summary.stdout.match(/CUDA Version:\s*([0-9.]+)/)?.[1];
		} catch {
			gpus = [];
		}

		const dockerAvailable = await commandAvailable("docker", ["version", "--format", "{{.Server.Version}}"]);
		let nvidiaContainerRuntimeAvailable = false;
		if (dockerAvailable) {
			try {
				const info = await runCommand("docker", ["info", "--format", "{{json .Runtimes}}"]);
				nvidiaContainerRuntimeAvailable = info.code === 0 && /nvidia/i.test(info.stdout);
			} catch {}
		}
		let freeDiskGiB: number | undefined;
		try {
			const stat = await fs.statfs(os.homedir());
			freeDiskGiB = gibibytes(stat.bavail * stat.bsize);
		} catch {}
		let secretStorageAvailable = false;
		try {
			await fs.access(os.homedir(), fsConstants.W_OK);
			secretStorageAvailable = true;
		} catch {}
		return {
			os: process.platform,
			architecture: process.arch,
			totalRamGiB: gibibytes(os.totalmem()),
			freeRamGiB: gibibytes(os.freemem()),
			freeDiskGiB,
			gpus,
			nvidiaDriver,
			cudaVersion,
			dockerAvailable,
			nvidiaContainerRuntimeAvailable,
			windowsRuntimeAvailable: process.platform === "win32" && gpus.length > 0,
			secretStorageAvailable,
		};
	}

	isPortOccupied(port: number): Promise<boolean> {
		const { promise, resolve } = Promise.withResolvers<boolean>();
		const socket = net.createConnection({ host: "127.0.0.1", port });
		let settled = false;
		const finish = (occupied: boolean) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(occupied);
		};
		socket.setTimeout(750, () => finish(true));
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
		return promise;
	}

	async artifactPresent(asset: ApplianceAsset): Promise<boolean> {
		try {
			return (await this.#hashFile(this.#artifactPath(asset))) === asset.sha256;
		} catch {
			return false;
		}
	}

	async acquireArtifact(asset: ApplianceAsset): Promise<string> {
		if (!/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error(`Invalid ${asset.kind} artifact checksum`);
		const source = new URL(asset.url);
		if (source.protocol !== "https:") throw new Error(`${asset.kind} artifact URL must use HTTPS`);
		const destination = this.#artifactPath(asset);
		if (await this.artifactPresent(asset)) return this.#artifactRef(asset);
		await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
		const temporary = `${destination}.${process.pid}.${randomUUID()}.part`;
		try {
			const response = await fetch(source, { redirect: "follow", signal: AbortSignal.timeout(60 * 60 * 1000) });
			if (!response.ok || !response.body)
				throw new Error(`${asset.kind} artifact download failed with HTTP ${response.status}`);
			if (new URL(response.url).protocol !== "https:")
				throw new Error(`${asset.kind} artifact redirected off HTTPS`);
			const hash = createHash("sha256");
			let bytes = 0;
			const hasher = new Transform({
				transform(chunk: Buffer, _encoding, callback) {
					bytes += chunk.length;
					hash.update(chunk);
					callback(null, chunk);
				},
			});
			// DOM and Node publish structurally compatible ReadableStream types from separate declarations.
			const nodeCompatibleBody = response.body as never;
			await pipeline(
				Readable.fromWeb(nodeCompatibleBody),
				hasher,
				createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
			);
			if (asset.bytes !== undefined && bytes !== asset.bytes)
				throw new Error(`${asset.kind} artifact byte count mismatch`);
			if (hash.digest("hex") !== asset.sha256) throw new Error(`${asset.kind} artifact checksum mismatch`);
			await fs.rename(temporary, destination);
			if (asset.kind === "runtime") await fs.chmod(destination, 0o700);
			return this.#artifactRef(asset);
		} catch (error) {
			await fs.rm(temporary, { force: true });
			throw error;
		}
	}

	async removeArtifact(ref: string): Promise<void> {
		await fs.rm(this.#resolveRef(ref, "artifacts"), { force: true });
	}

	async createCandidate(input: {
		profile: ApplianceProfile;
		runtimeRef: string;
		modelRef: string;
		secret: string;
		port: number;
		installationId: string;
	}): Promise<ApplianceCandidate> {
		if (!input.profile.launch) throw new Error(`Profile ${input.profile.profile} has no released launch descriptor`);
		const runtime = this.#resolveRef(input.runtimeRef, "artifacts");
		const model = this.#resolveRef(input.modelRef, "artifacts");
		const candidateId = `candidate-${input.installationId}`;
		const handle = path.join("candidates", candidateId);
		const directory = this.#resolveRef(handle, "candidates");
		await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
		await fs.mkdir(directory, { recursive: false, mode: 0o700 });
		const replacements: Record<string, string> = {
			"${runtime}": runtime,
			"${model}": model,
			"${host}": "127.0.0.1",
			"${port}": String(input.port),
			"${served_model}": input.profile.servedModel,
		};
		const render = (value: string): string => {
			let rendered = value;
			for (const [token, replacement] of Object.entries(replacements))
				rendered = rendered.replaceAll(token, replacement);
			if (/\$\{[^}]+\}/.test(rendered)) throw new Error(`Unknown launch token in profile ${input.profile.profile}`);
			return rendered;
		};
		const endpoint = `http://127.0.0.1:${input.port}`;
		const manifest: CandidateManifest = {
			schemaVersion: 1,
			candidateId,
			command: runtime,
			args: input.profile.launch.args.map(render),
			secretEnvironmentVariable: input.profile.launch.secretEnvironmentVariable,
			endpoint,
			port: input.port,
		};
		await this.#writePrivateJson(path.join(directory, "service.json"), manifest);
		this.#candidateSecrets.set(handle, input.secret);
		return { candidateId, handle, endpoint, port: input.port };
	}

	async startCandidate(candidate: ApplianceCandidate): Promise<void> {
		const secret = this.#candidateSecrets.get(candidate.handle);
		if (!secret) throw new Error("Candidate secret is unavailable");
		try {
			await this.#startHandle(candidate.handle, secret);
		} finally {
			this.#candidateSecrets.delete(candidate.handle);
		}
	}

	async stopCandidate(candidateHandle: string): Promise<void> {
		const directory = this.#resolveRef(candidateHandle, "candidates");
		const child = this.#candidateProcesses.get(candidateHandle);
		if (!child?.pid) {
			throw new Error("Appliance candidate process ownership cannot be proven");
		}
		const pidFile = path.join(directory, "pid");
		const recordedPid = Number((await fs.readFile(pidFile, "utf8")).trim());
		if (recordedPid !== child.pid) {
			throw new Error("Appliance candidate process identifier does not match its owned child");
		}
		if (child.exitCode !== null || child.signalCode !== null) {
			await fs.rm(pidFile, { force: true });
			return;
		}

		const exited = Promise.withResolvers<void>();
		child.once("exit", () => exited.resolve());
		if (!child.kill("SIGTERM")) {
			await exited.promise;
			await fs.rm(pidFile, { force: true });
			return;
		}
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const stopped = await Promise.race([
			exited.promise.then(() => true),
			new Promise<boolean>(resolve => {
				timeout = setTimeout(() => resolve(false), 5_000);
			}),
		]);
		if (timeout) clearTimeout(timeout);
		if (!stopped) {
			if (!child.kill("SIGKILL") && child.exitCode === null) {
				throw new Error("Appliance candidate process could not be stopped");
			}
			await exited.promise;
		}
		await fs.rm(pidFile, { force: true });
	}

	async startInstallation(installation: ApplianceInstallation, secret: string): Promise<void> {
		await this.#startHandle(installation.candidateHandle, secret);
	}

	async probeHealth(target: ApplianceCandidate | ApplianceInstallation, secret: string): Promise<void> {
		const status = await this.#fetchStatus(target, secret);
		const expected = servedModelFor(target);
		if (expected && status.servedModel !== expected) {
			throw new Error(`Appliance served-model mismatch: expected ${expected}, found ${String(status.servedModel)}`);
		}
	}

	async probeProtocol(target: ApplianceCandidate | ApplianceInstallation, secret: string): Promise<void> {
		const model = servedModelFor(target) ?? "q38-ninfer";
		const body = await fetchJson(`${endpointFor(target)}/v1/responses`, {
			method: "POST",
			headers: authHeaders(secret),
			body: JSON.stringify({
				model,
				input: [{ role: "user", content: [{ type: "input_text", text: "Reply with one nonempty token." }] }],
				max_output_tokens: 8,
				store: true,
				...qualificationFields("protocol"),
			}),
		});
		if (!safeString(body.id) || !extractOutputText(body))
			throw new Error("Appliance protocol smoke returned no completed output");
	}

	async quickQualification(
		target: ApplianceCandidate | ApplianceInstallation,
		secret: string,
	): Promise<ApplianceQuickQualification> {
		const endpoint = endpointFor(target);
		const model = servedModelFor(target) ?? "q38-ninfer";
		const runCase = async (
			name: ApplianceBenchmarkCase["name"],
			run: () => Promise<string>,
		): Promise<ApplianceBenchmarkCase> => {
			const started = performance.now();
			try {
				const oracle = await run();
				return {
					name,
					ok: true,
					durationMs: Math.round(performance.now() - started),
					oracleSha256: sha256(oracle),
				};
			} catch {
				return {
					name,
					ok: false,
					durationMs: Math.round(performance.now() - started),
					oracleSha256: sha256(`${name}:failed`),
					detail: "request-failed",
				};
			}
		};
		const toolCase = await runCase("protocol-tool", async () => {
			const response = await fetchJson(`${endpoint}/v1/responses`, {
				method: "POST",
				headers: authHeaders(secret),
				body: JSON.stringify({
					model,
					input: [{ role: "user", content: [{ type: "input_text", text: "Call the echo tool with value ok." }] }],
					tools: [
						{
							type: "function",
							name: "echo",
							description: "Echo one value",
							parameters: {
								type: "object",
								properties: { value: { type: "string", enum: ["ok"] } },
								required: ["value"],
								additionalProperties: false,
							},
						},
					],
					tool_choice: { type: "function", name: "echo" },
					max_output_tokens: 64,
					store: true,
					...qualificationFields("tool"),
				}),
			});
			const output = Array.isArray(response.output) ? response.output : [];
			const call = output.find(
				item => item !== null && typeof item === "object" && "type" in item && item.type === "function_call",
			);
			if (!call) throw new Error("missing-tool-call");
			const name = "name" in call && typeof call.name === "string" ? call.name : undefined;
			const rawArguments = "arguments" in call && typeof call.arguments === "string" ? call.arguments : undefined;
			let argumentsValue: unknown;
			try {
				argumentsValue = rawArguments === undefined ? undefined : JSON.parse(rawArguments);
			} catch {
				throw new Error("invalid-tool-arguments");
			}
			if (name !== "echo" || !isRecord(argumentsValue) || argumentsValue.value !== "ok") {
				throw new Error("incorrect-tool-call");
			}
			return JSON.stringify({ type: "function_call", name, value: argumentsValue.value });
		});
		let decodeTokensPerSecond: number | undefined;
		const decodeCase = await runCase("short-decode", async () => {
			const measurement = await fetchResponsesStream(`${endpoint}/v1/responses`, {
				method: "POST",
				headers: authHeaders(secret),
				body: JSON.stringify({
					model,
					input: [{ role: "user", content: [{ type: "input_text", text: "Reply exactly OMP_OK." }] }],
					max_output_tokens: 16,
					store: true,
					stream: true,
					...qualificationFields("decode"),
				}),
			});
			const text = extractOutputText(measurement.response).trim();
			const usage = responseUsage(measurement.response);
			if (text !== "OMP_OK") throw new Error("incorrect-decode");
			if (!usage || usage.outputTokens < 2) throw new Error("missing-decode-usage");
			decodeTokensPerSecond =
				Math.round(((usage.outputTokens - 1) / (measurement.decodeMs / 1_000)) * 1_000) / 1_000;
			return text;
		});
		let coldTtftMs: number | undefined;
		let warmTtftMs: number | undefined;
		let prefixReusePercent: number | undefined;
		const reuseCase = await runCase("long-prefill-reuse", async () => {
			const fields = qualificationFields("reuse");
			const first = await fetchResponsesStream(`${endpoint}/v1/responses`, {
				method: "POST",
				headers: authHeaders(secret),
				body: JSON.stringify({
					model,
					input: [
						{ role: "user", content: [{ type: "input_text", text: `${"alpha ".repeat(4096)}\nReply one.` }] },
					],
					max_output_tokens: 8,
					store: true,
					stream: true,
					...fields,
				}),
			});
			const responseId = safeString(first.response.id);
			if (!responseId) throw new Error("missing-response-id");
			const second = await fetchResponsesStream(`${endpoint}/v1/responses`, {
				method: "POST",
				headers: authHeaders(secret),
				body: JSON.stringify({
					model,
					previous_response_id: responseId,
					input: [{ role: "user", content: [{ type: "input_text", text: "Reply two." }] }],
					max_output_tokens: 8,
					store: true,
					stream: true,
					...fields,
					ninfer_request_id: sha256(`omp-appliance-qualification-request:reuse:${randomUUID()}`),
				}),
			});
			const usage = responseUsage(second.response);
			if (!safeString(second.response.id) || !extractOutputText(second.response)) throw new Error("reuse-failed");
			if (!usage || usage.inputTokens <= 0) throw new Error("missing-reuse-usage");
			coldTtftMs = first.ttftMs;
			warmTtftMs = second.ttftMs;
			prefixReusePercent = Math.round((usage.cachedTokens / usage.inputTokens) * 100_000) / 1_000;
			return JSON.stringify({ first: true, continuation: true });
		});
		const cases = [toolCase, decodeCase, reuseCase];
		const metrics =
			coldTtftMs !== undefined &&
			warmTtftMs !== undefined &&
			prefixReusePercent !== undefined &&
			decodeTokensPerSecond !== undefined
				? { coldTtftMs, warmTtftMs, prefixReusePercent, decodeTokensPerSecond }
				: undefined;
		return { ok: cases.every(result => result.ok), cases, metrics };
	}

	async probeRoutedRequest(installation: ApplianceInstallation, secret: string): Promise<void> {
		await this.probeProtocol(installation, secret);
	}

	async readEndpointStatus(installation: ApplianceInstallation, secret: string): Promise<ApplianceEndpointStatus> {
		return this.#fetchStatus(installation, secret);
	}

	async checkpoint(
		installation: ApplianceInstallation,
		secret: string,
		operation: NInferCheckpointOperation,
		sessionSha256: string,
	): Promise<NInferCheckpointStatus> {
		return requestNInferCheckpoint({
			operation,
			sessionSha256,
			baseUrl: installation.route.baseUrl,
			apiKey: secret,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	}

	#artifactRef(asset: ApplianceAsset): string {
		return path.join("artifacts", asset.kind, asset.sha256);
	}

	#artifactPath(asset: ApplianceAsset): string {
		return path.join(this.root, this.#artifactRef(asset));
	}

	#resolveRef(ref: string, expectedRoot: "artifacts" | "candidates"): string {
		const normalized = path.normalize(ref);
		if (
			path.isAbsolute(normalized) ||
			normalized.startsWith("..") ||
			normalized.split(path.sep)[0] !== expectedRoot
		) {
			throw new Error(`Invalid appliance ${expectedRoot} reference`);
		}
		return path.join(this.root, normalized);
	}

	async #hashFile(file: string): Promise<string> {
		const hash = createHash("sha256");
		for await (const chunk of createReadStream(file)) hash.update(chunk);
		return hash.digest("hex");
	}

	async #writePrivateJson(file: string, value: unknown): Promise<void> {
		const handle = await fs.open(file, "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	async #readManifest(handle: string): Promise<CandidateManifest> {
		const value: unknown = JSON.parse(
			await fs.readFile(path.join(this.#resolveRef(handle, "candidates"), "service.json"), "utf8"),
		);
		if (
			!isRecord(value) ||
			value.schemaVersion !== 1 ||
			typeof value.candidateId !== "string" ||
			typeof value.command !== "string" ||
			!Array.isArray(value.args) ||
			!value.args.every(argument => typeof argument === "string") ||
			typeof value.secretEnvironmentVariable !== "string" ||
			typeof value.endpoint !== "string" ||
			typeof value.port !== "number"
		) {
			throw new Error("Invalid appliance candidate manifest");
		}
		return {
			schemaVersion: 1,
			candidateId: value.candidateId,
			command: value.command,
			args: [...value.args],
			secretEnvironmentVariable: value.secretEnvironmentVariable,
			endpoint: value.endpoint,
			port: value.port,
		};
	}

	async #startHandle(handle: string, secret: string): Promise<void> {
		const directory = this.#resolveRef(handle, "candidates");
		const manifest = await this.#readManifest(handle);
		try {
			const pid = Number((await fs.readFile(path.join(directory, "pid"), "utf8")).trim());
			if (Number.isSafeInteger(pid) && pid > 1) {
				process.kill(pid, 0);
				return;
			}
		} catch {}
		const log = await fs.open(path.join(directory, "service.log"), "a", 0o600);
		try {
			const child = spawn(manifest.command, manifest.args, {
				cwd: directory,
				detached: true,
				shell: false,
				stdio: ["ignore", log.fd, log.fd],
				windowsHide: true,
				env: { ...process.env, [manifest.secretEnvironmentVariable]: secret },
			});
			const started = Promise.withResolvers<void>();
			child.once("spawn", started.resolve);
			child.once("error", started.reject);
			await started.promise;
			if (!child.pid) throw new Error("Appliance candidate did not start");
			try {
				await fs.writeFile(path.join(directory, "pid"), `${child.pid}\n`, { mode: 0o600 });
			} catch (error) {
				child.kill("SIGTERM");
				throw error;
			}
			this.#candidateProcesses.set(handle, child);
			child.once("exit", () => {
				if (this.#candidateProcesses.get(handle) === child) this.#candidateProcesses.delete(handle);
			});
			child.unref();
		} finally {
			await log.close();
		}
	}

	async #fetchStatus(
		target: ApplianceCandidate | ApplianceInstallation,
		secret: string,
	): Promise<ApplianceEndpointStatus> {
		return fetchNInferStatus({
			baseUrl: `${endpointFor(target)}/v1`,
			apiKey: secret,
			servedModel: servedModelFor(target) ?? "q38-ninfer",
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	}
}
