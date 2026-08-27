import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ApplianceAction, ApplianceAdapterId, ApplianceProfile, ApplianceProfileId, ApplianceSupportStatus } from "./types";

const SHA256 = /^[a-f0-9]{64}$/u;
const OCI_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const PROFILE_IDS = ["darwin-remote-ssh", "windows-docker-local", "linux-docker-local"] as const satisfies readonly ApplianceProfileId[];
const ADAPTERS = ["darwin-remote-ssh", "windows-docker-local", "linux-docker-local"] as const satisfies readonly ApplianceAdapterId[];
const STATUSES = ["qualified", "preview", "blocked", "unsupported"] as const satisfies readonly ApplianceSupportStatus[];
const ACTIONS = ["doctor", "plan", "install", "status", "benchmark", "checkpoint", "rollback", "support-bundle"] as const satisfies readonly ApplianceAction[];
const TRANSPORTS = ["ssh-loopback", "local-loopback"] as const;
type JsonRecord = Record<string, unknown>;

export interface CompatibilityAuthority {
	schemaVersion: 1;
	authorityId: string;
	sha256: string;
	bytes: Uint8Array;
	profiles: readonly ApplianceProfile[];
}
function record(value: unknown, label: string): JsonRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(label + " must be an object");
	return value as JsonRecord;
}
function text(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(label + " is invalid");
	return value;
}
function integer(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(label + " must be a positive integer");
	return value as number;
}
function strings(value: unknown, label: string): string[] {
	if (!Array.isArray(value)) throw new Error(label + " must be an array");
	return value.map((item, index) => text(item, label + "[" + index + "]"));
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
	const candidate = text(value, label);
	if (!allowed.includes(candidate as T)) throw new Error("Unknown " + label + ": " + candidate);
	return candidate as T;
}
function receipt(value: unknown, label: string): { url: string; sha256: string } {
	const item = record(value, label);
	const url = text(item.url, label + " URL");
	if (new URL(url).protocol !== "https:") throw new Error(label + " URL must use HTTPS");
	const sha256 = text(item.sha256, label + " SHA-256");
	if (!SHA256.test(sha256)) throw new Error(label + " SHA-256 is invalid");
	return { url, sha256 };
}
function parseProfile(value: unknown): ApplianceProfile {
	const item = record(value, "Compatibility profile");
	const profile = oneOf(item.id, PROFILE_IDS, "profile");
	const adapter = oneOf(item.adapter, ADAPTERS, "adapter");
	if (profile !== adapter) throw new Error("Profile and adapter must match in the initial closed adapter set");
	const status = oneOf(item.status, STATUSES, "status");
	const transport = oneOf(item.transport, TRANSPORTS, "transport");
	if (item.silent_cloud_fallback !== false) throw new Error("Compatibility profile must disable silent cloud fallback");
	if ((adapter === "darwin-remote-ssh") !== (transport === "ssh-loopback")) throw new Error("Profile transport does not match its adapter");
	const rawCommands = item.commands;
	if (!Array.isArray(rawCommands)) throw new Error("Profile lifecycle commands are absent");
	const commands = rawCommands.map(command => oneOf(command, ACTIONS, "lifecycle command"));
	if (commands.length === 0 || new Set(commands).size !== commands.length) throw new Error("Profile lifecycle commands are absent or duplicated");
	const runtime = record(item.runtime, "Runtime identity");
	const imageReference = text(runtime.image_reference, "Image reference");
	const imageDigest = text(runtime.image_digest, "Image digest");
	if (!OCI_DIGEST.test(imageDigest) || !imageReference.includes("@" + imageDigest) || /:latest(?:@|$)/u.test(imageReference)) {
		throw new Error("Runtime image is not immutably digest-pinned");
	}
	const modelSha256 = text(runtime.model_sha256, "Model SHA-256");
	const configurationSha256 = text(runtime.configuration_sha256, "Configuration SHA-256");
	const serverBinarySha256 = text(runtime.server_binary_sha256, "Server SHA-256");
	for (const digest of [modelSha256, configurationSha256, serverBinarySha256]) if (!SHA256.test(digest)) throw new Error("Runtime identity contains an invalid SHA-256");
	const gpu = record(item.gpu_qualification, "GPU qualification");
	const gpuStatus = oneOf(gpu.status, STATUSES, "GPU qualification status");
	const acceptance = item.acceptance_receipt == null ? undefined : receipt(item.acceptance_receipt, "Acceptance receipt");
	const gpuReceipt = receipt(gpu.receipt, "GPU qualification receipt");
	const installable = item.installable === true;
	if (status === "qualified" && (!acceptance || gpuStatus !== "qualified" || !installable)) throw new Error("Qualified profile lacks complete acceptance or GPU qualification evidence");
	if ((status === "blocked" || status === "unsupported") && installable) throw new Error("Blocked profile cannot be installable");
	const lifecycle = record(item.lifecycle, "NInfer lifecycle");
	const scriptUrl = text(lifecycle.script_url, "Lifecycle script URL");
	if (new URL(scriptUrl).protocol !== "https:") throw new Error("Lifecycle script URL must use HTTPS");
	const scriptSha256 = text(lifecycle.script_sha256, "Lifecycle script SHA-256");
	if (!SHA256.test(scriptSha256)) throw new Error("Lifecycle script SHA-256 is invalid");
	const modelUrl = text(runtime.model_url, "Model URL");
	if (new URL(modelUrl).protocol !== "https:") throw new Error("Model URL must use HTTPS");
	const capabilities = strings(runtime.capabilities, "Runtime capabilities");
	const knownCapabilities = ["tools", "reasoning", "thinking-history", "stateful-responses", "vision", "durable-checkpoint"];
	if (capabilities.some(capability => !knownCapabilities.includes(capability))) throw new Error("Runtime contains an unknown capability");
	const contextWindow = integer(runtime.maximum_context_tokens, "Maximum context");
	const maxTokens = integer(runtime.maximum_output_tokens, "Maximum output tokens");
	const concurrency = integer(runtime.maximum_concurrency, "Maximum concurrency");
	if (contextWindow !== 131072 || maxTokens !== 32768 || concurrency !== 1) throw new Error("Runtime identity declares unsupported context, output, or concurrency bounds");
	const architecture = oneOf(runtime.cuda_architecture, ["sm_120a", "sm_89"] as const, "CUDA architecture");
	if (runtime.vision !== capabilities.includes("vision") || typeof runtime.preserve_thinking !== "boolean") throw new Error("Runtime behavior flags disagree with capabilities");
	return {
		id: "qwen3.8-27b", profile, runtime: "ninfer", architecture,
		minVramGiB: integer(runtime.minimum_vram_gib, "Minimum VRAM"), minimumDiskGiB: integer(runtime.minimum_disk_gib, "Minimum disk"), artifactSha256: modelSha256,
		contextWindow, maxTokens,
		kvDtype: oneOf(runtime.kv_dtype, ["bf16", "rk2v4-e8"] as const, "KV dtype"),
		speculation: runtime.speculative_backend === "mtp" && runtime.draft_tokens === 3 ? "mtp3" : "none",
		concurrency, preserveThinking: runtime.preserve_thinking, protocol: "openai-responses", capabilities: capabilities as ApplianceProfile["capabilities"],
		release: text(item.product_release, "Product release"), servedModel: "q38-ninfer",
		aliases: strings(item.aliases, "Profile aliases"), defaultPort: integer(item.local_port, "Local port"),
		availability: {
			installable, channel: status === "qualified" ? "released" : "beta",
			blockers: strings(item.blockers ?? [], "Profile blockers"),
			...(acceptance ? { qualificationReceipt: acceptance } : {}),
		},
		assets: {
			runtime: { kind: "runtime", url: imageReference, sha256: imageDigest.slice(7) },
			model: { kind: "model", url: modelUrl, sha256: modelSha256, bytes: integer(runtime.model_bytes, "Model bytes") },
		},
		adapter, supportStatus: status, supportOwner: text(item.support_owner, "Support owner"),
		limitations: strings(item.limitations, "Profile limitations"), lifecycleCommands: commands,
		...(acceptance ? { acceptanceReceipt: acceptance } : {}),
		gpuQualification: { profile: text(gpu.profile, "GPU profile"), receipt: gpuReceipt, status: gpuStatus },
		container: {
			imageReference, imageDigest, containerPort: integer(item.container_port, "Container port"),
			serverBinarySha256, configurationSha256, restartPolicy: "no",
		},
		lifecycle: { scriptUrl, scriptSha256, arguments: strings(lifecycle.arguments ?? [], "Lifecycle arguments") },
	};
}
export async function loadCompatibilityAuthority(path: string, expectedSha256: string): Promise<CompatibilityAuthority> {
	if (!path.trim() || path.startsWith("-") || /[\u0000-\u001f\u007f]/u.test(path)) {
		throw new Error("Compatibility authority path is invalid");
	}
	if (!SHA256.test(expectedSha256)) throw new Error("Compatibility authority SHA-256 is invalid");
	const bytes = await readFile(path);
	if (bytes.byteLength > 64 * 1024) throw new Error("Compatibility authority exceeds the 64 KiB limit");
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	if (sha256 !== expectedSha256) throw new Error("Compatibility authority digest mismatch");
	const value = record(JSON.parse(bytes.toString("utf8")) as unknown, "Compatibility authority");
	if (value.schema_version !== 1) throw new Error("Unknown compatibility authority schema version");
	if (!Array.isArray(value.profiles)) throw new Error("Compatibility authority profiles are absent");
	const profiles = value.profiles.map(parseProfile);
	if (new Set(profiles.map(profile => profile.profile)).size !== profiles.length) throw new Error("Compatibility authority contains duplicate profiles");
	return { schemaVersion: 1, authorityId: text(value.authority_id, "Authority id"), sha256, bytes, profiles };
}
