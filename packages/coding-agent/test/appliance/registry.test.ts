import { describe, expect, it } from "bun:test";
import {
	APPLIANCE_PROFILES,
	isProfileInstallable,
	resolveApplianceProfile,
} from "@oh-my-pi/pi-coding-agent/appliance/registry";
import type { ApplianceHostFacts, ApplianceProfile } from "@oh-my-pi/pi-coding-agent/appliance/types";

function host(overrides: Partial<ApplianceHostFacts> = {}): ApplianceHostFacts {
	return {
		os: "linux",
		architecture: "x64",
		totalRamGiB: 128,
		freeRamGiB: 96,
		freeDiskGiB: 500,
		gpus: [{ model: "NVIDIA GeForce RTX 5090", uuidHash: "a".repeat(64), vramGiB: 32, computeCapability: "12.0" }],
		nvidiaDriver: "999.1",
		cudaVersion: "13.0",
		dockerAvailable: true,
		nvidiaContainerRuntimeAvailable: true,
		windowsRuntimeAvailable: false,
		secretStorageAvailable: true,
		...overrides,
	};
}

describe("appliance profile registry", () => {
	it("preserves the exact released RTX 5090 profile facts", () => {
		const profile = APPLIANCE_PROFILES.find(candidate => candidate.profile === "rtx5090-linux");
		expect(profile).toMatchObject({
			id: "qwen3.8-27b",
			profile: "rtx5090-linux",
			runtime: "ninfer",
			architecture: "sm_120a",
			minVramGiB: 32,
			artifactSha256: "eec39564993d6e9c7d5e383382a760f093465c9d163ec9a1bd6b80199514bf3e",
			contextWindow: 131072,
			maxTokens: 32768,
			kvDtype: "bf16",
			speculation: "mtp3",
			concurrency: 1,
			protocol: "openai-responses",
			release: "v0.1.0-qwen38-5090",
			servedModel: "q38-ninfer",
		});
		expect(profile?.capabilities).toEqual(["tools", "reasoning", "thinking-history", "stateful-responses", "vision"]);
		expect(profile?.aliases).toEqual(["local-max", "local-fast", "local-batch", "qwen38-5090"]);
		expect(profile && isProfileInstallable(profile)).toBe(false);
	});

	it("keeps the RTX 4090 beta unavailable without inventing vision or MTP", () => {
		const profile = APPLIANCE_PROFILES.find(candidate => candidate.profile === "rtx4090-windows");
		expect(profile).toMatchObject({
			runtime: "ninfer-4090",
			architecture: "sm_89",
			minVramGiB: 24,
			kvDtype: "rk2v4-e8",
			speculation: "none",
		});
		expect(profile?.availability).toMatchObject({ installable: false, channel: "beta" });
		expect(profile?.availability.blockers.join(" ")).toContain("Workstream K");
		expect(profile?.capabilities).not.toContain("vision");
		expect(profile?.capabilities).toEqual([
			"tools",
			"reasoning",
			"thinking-history",
			"stateful-responses",
			"durable-checkpoint",
		]);
	});

	it("requires preview client acceptance independently of GPU qualification", () => {
		const base = APPLIANCE_PROFILES[0]!;
		const acceptance = { url: "https://example.invalid/client-acceptance.json", sha256: "a".repeat(64) };
		const gpuReceipt = { url: "https://example.invalid/gpu-qualification.json", sha256: "b".repeat(64) };
		const preview: ApplianceProfile = {
			...base,
			supportStatus: "preview",
			availability: { installable: true, channel: "beta", blockers: [], qualificationReceipt: acceptance },
			acceptanceReceipt: acceptance,
			gpuQualification: { profile: "rtx5090", receipt: gpuReceipt, status: "qualified" },
			assets: {
				runtime: { kind: "runtime", url: "https://example.invalid/runtime", sha256: "c".repeat(64) },
				model: { kind: "model", url: "https://example.invalid/model", sha256: base.artifactSha256 },
			},
			launch: { executable: "runtime", args: [], secretEnvironmentVariable: "NINFER_API_KEY" },
		};
		expect(
			isProfileInstallable({
				...preview,
				availability: { installable: true, channel: "beta", blockers: [] },
				acceptanceReceipt: undefined,
			}),
		).toBe(false);
		expect(isProfileInstallable({ ...preview, gpuQualification: undefined })).toBe(false);
		expect(isProfileInstallable(preview)).toBe(true);
		expect(
			isProfileInstallable({
				...preview,
				gpuQualification: { ...preview.gpuQualification!, status: "blocked" },
			}),
		).toBe(false);
	});

	it("selects supported hardware and explains unsupported hosts", () => {
		const selected = resolveApplianceProfile("qwen3.8", "auto", host());
		expect(selected.supported).toBe(true);
		expect(selected.profile?.profile).toBe("rtx5090-linux");

		const unsupported = resolveApplianceProfile(
			"qwen3.8",
			"auto",
			host({
				os: "darwin",
				architecture: "arm64",
				gpus: [],
				dockerAvailable: false,
				nvidiaContainerRuntimeAvailable: false,
			}),
		);
		expect(unsupported.supported).toBe(false);
		expect(unsupported.blockers.join(" ")).toContain("No supported NVIDIA GPU");

		const wrongCompute = resolveApplianceProfile(
			"qwen3.8",
			"rtx5090",
			host({ gpus: [{ model: "RTX 5090", vramGiB: 32, computeCapability: "8.9" }] }),
		);
		expect(wrongCompute.supported).toBe(false);
		expect(wrongCompute.blockers.join(" ")).toContain("12.0 required");
	});
});
