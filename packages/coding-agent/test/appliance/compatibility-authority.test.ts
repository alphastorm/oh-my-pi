import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCompatibilityAuthority } from "@oh-my-pi/pi-coding-agent/appliance/compatibility-authority";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const receipt = (digit: string) => ({ url: "https://example.invalid/" + digit + ".json", sha256: digit.repeat(64) });
function profile(id: "darwin-remote-ssh" | "windows-docker-local" | "linux-docker-local", status: "qualified" | "preview" = "preview") {
	return {
		id, adapter: id, status, transport: id === "darwin-remote-ssh" ? "ssh-loopback" : "local-loopback",
		commands: ["doctor", "plan", "install", "status", "benchmark", "checkpoint", "rollback", "support-bundle"],
		silent_cloud_fallback: false,
		installable: status === "qualified" || id !== "darwin-remote-ssh", support_owner: "omp-ninfer",
		product_release: "v0.2.0-preview", aliases: ["local-max"], local_port: 18089, container_port: 8080,
		limitations: status === "qualified" ? [] : ["Preview pending real client acceptance"], blockers: [],
		acceptance_receipt: status === "qualified" ? receipt("a") : null,
		gpu_qualification: { profile: "qwen38-5090-v0.1.0", status: "qualified", receipt: receipt("b") },
		runtime: {
			image_reference: "ghcr.io/alphastorm/ninfer@sha256:" + "c".repeat(64), image_digest: "sha256:" + "c".repeat(64),
			model_url: "https://example.invalid/model.ninfer", model_bytes: 18_210_531_328, model_sha256: "d".repeat(64),
			configuration_sha256: "e".repeat(64), server_binary_sha256: "f".repeat(64), minimum_vram_gib: 32, minimum_disk_gib: 64,
			cuda_architecture: "sm_120a", maximum_context_tokens: 131072, maximum_output_tokens: 32768, maximum_concurrency: 1,
			kv_dtype: "bf16", speculative_backend: "mtp", draft_tokens: 3, vision: true, preserve_thinking: true,
			capabilities: ["tools", "reasoning", "thinking-history", "stateful-responses", "vision"],
		},
		lifecycle: { script_url: "https://example.invalid/lifecycle" + (id === "windows-docker-local" ? ".ps1" : ".sh"), script_sha256: "1".repeat(64), arguments: [] },
	};
}
async function authority(profiles: unknown[]): Promise<{ path: string; sha256: string }> {
	const root = await mkdtemp(join(tmpdir(), "omp-compatibility-")); roots.push(root);
	const bytes = Buffer.from(JSON.stringify({ schema_version: 1, authority_id: "omp-ninfer-v0.2-preview", profiles }));
	const path = join(root, "compatibility.json"); await writeFile(path, bytes);
	return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
}

describe("omp-ninfer compatibility authority", () => {
	test("binds the closed adapter set without an OS GPU matrix", async () => {
		const fixture = await authority([profile("darwin-remote-ssh", "qualified"), profile("windows-docker-local"), profile("linux-docker-local")]);
		const loaded = await loadCompatibilityAuthority(fixture.path, fixture.sha256);
		expect(loaded.profiles.map(item => item.adapter)).toEqual(["darwin-remote-ssh", "windows-docker-local", "linux-docker-local"]);
		expect(loaded.profiles[0]?.lifecycleCommands).toEqual([
			"doctor", "plan", "install", "status", "benchmark", "checkpoint", "rollback", "support-bundle",
		]);
		expect(Buffer.from(loaded.bytes).byteLength).toBeGreaterThan(0);
		expect(loaded.profiles[1]?.supportStatus).toBe("preview");
		expect(loaded.profiles[1]?.container?.imageDigest).toBe("sha256:" + "c".repeat(64));
		expect(loaded.profiles[1]?.gpuQualification?.profile).toBe("qwen38-5090-v0.1.0");
	});

	test("rejects drift and every unknown authority discriminator", async () => {
		const fixture = await authority([profile("windows-docker-local")]);
		await expect(loadCompatibilityAuthority(fixture.path, "0".repeat(64))).rejects.toThrow("digest mismatch");
		for (const mutation of [
			{ schema_version: 2, authority_id: "x", profiles: [] },
			{ schema_version: 1, authority_id: "x", profiles: [{ ...profile("windows-docker-local"), adapter: "generic" }] },
			{ schema_version: 1, authority_id: "x", profiles: [{ ...profile("windows-docker-local"), transport: "cloud" }] },
			{ schema_version: 1, authority_id: "x", profiles: [{ ...profile("windows-docker-local"), commands: ["repair"] }] },
		]) {
			const next = await authority((mutation as { profiles: unknown[] }).profiles);
			const bytes = Buffer.from(JSON.stringify(mutation)); await writeFile(next.path, bytes);
			const digest = createHash("sha256").update(bytes).digest("hex");
			await expect(loadCompatibilityAuthority(next.path, digest)).rejects.toThrow();
		}
	});

	test("rejects mutable images and incomplete qualified claims", async () => {
		const mutable = profile("windows-docker-local"); mutable.runtime.image_reference = "ghcr.io/alphastorm/ninfer:latest";
		let fixture = await authority([mutable]);
		await expect(loadCompatibilityAuthority(fixture.path, fixture.sha256)).rejects.toThrow("digest-pinned");
		const incomplete = profile("windows-docker-local", "qualified"); incomplete.acceptance_receipt = null;
		fixture = await authority([incomplete]);
		await expect(loadCompatibilityAuthority(fixture.path, fixture.sha256)).rejects.toThrow("complete acceptance");
	});
});
