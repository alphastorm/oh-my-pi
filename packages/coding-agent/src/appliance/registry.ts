import type {
	ApplianceGpuSelector,
	ApplianceHostFacts,
	ApplianceInstallation,
	ApplianceProfile,
	ApplianceProfileId,
} from "./types";

const MODEL_ARTIFACT_SHA256 = "eec39564993d6e9c7d5e383382a760f093465c9d163ec9a1bd6b80199514bf3e";

/**
 * Public profile facts frozen by the v0.1 handoff. Asset URLs, runtime hashes,
 * launch arguments, and qualification receipts remain absent until their owning
 * workstreams publish them; absent release evidence makes a profile non-installable.
 */
export const APPLIANCE_PROFILES: readonly ApplianceProfile[] = [
	{
		id: "qwen3.8-27b",
		profile: "rtx5090-linux",
		runtime: "ninfer",
		architecture: "sm_120a",
		minVramGiB: 32,
		artifactSha256: MODEL_ARTIFACT_SHA256,
		contextWindow: 131072,
		maxTokens: 32768,
		kvDtype: "bf16",
		speculation: "mtp3",
		concurrency: 1,
		protocol: "openai-responses",
		capabilities: ["tools", "reasoning", "thinking-history", "stateful-responses", "vision"],
		release: "v0.1.0-qwen38-5090",
		servedModel: "q38-ninfer",
		aliases: ["local-max", "local-fast", "local-batch", "qwen38-5090"],
		defaultPort: 8000,
		availability: {
			installable: false,
			channel: "released",
			blockers: [
				"NInfer runtime asset and checksum are not published",
				"NInfer public qualification receipt is not published",
				"Qwen3.8 model artifact URL is not published",
			],
		},
	},
	{
		id: "qwen3.8-27b",
		profile: "rtx4090-windows",
		runtime: "ninfer-4090",
		architecture: "sm_89",
		minVramGiB: 24,
		artifactSha256: MODEL_ARTIFACT_SHA256,
		contextWindow: 131072,
		maxTokens: 32768,
		kvDtype: "rk2v4-e8",
		speculation: "none",
		concurrency: 1,
		protocol: "openai-responses",
		capabilities: ["tools", "reasoning", "thinking-history", "stateful-responses", "durable-checkpoint"],
		servedModel: "q38-ninfer",
		aliases: ["local-max", "local-fast", "local-batch", "qwen38-4090"],
		defaultPort: 8000,
		availability: {
			installable: false,
			channel: "beta",
			blockers: [
				"RTX 4090 release artifact is not published",
				"Workstream K public qualification receipt is not published",
			],
		},
	},
] as const;

export interface ApplianceProfileResolution {
	profile?: ApplianceProfile;
	supported: boolean;
	blockers: string[];
}

function detectedSelector(host: ApplianceHostFacts): Exclude<ApplianceGpuSelector, "auto"> | undefined {
	for (const gpu of host.gpus) {
		const normalized = gpu.model.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
		if (normalized.includes("5090")) return "rtx5090";
		if (normalized.includes("4090")) return "rtx4090";
	}
	return undefined;
}

function hostBlockers(profile: ApplianceProfile, host: ApplianceHostFacts): string[] {
	const blockers: string[] = [];
	if (profile.adapter === "windows-docker-local" && host.os !== "win32") {
		blockers.push(`windows-docker-local requires native Windows; detected ${host.os}`);
	}
	if (profile.adapter === "linux-docker-local" && host.os !== "linux") {
		blockers.push(`linux-docker-local requires native Linux; detected ${host.os}`);
	}
	if (profile.adapter === "darwin-remote-ssh" && host.os !== "darwin") {
		blockers.push(`darwin-remote-ssh requires macOS; detected ${host.os}`);
	}
	if (profile.profile === "rtx5090-linux" && host.os !== "linux") {
		blockers.push(`rtx5090-linux requires Linux; detected ${host.os}`);
	}
	if (profile.profile === "rtx4090-windows" && host.os !== "win32") {
		blockers.push(`rtx4090-windows requires Windows; detected ${host.os}`);
	}
	const compatibleGpu = profile.adapter === "darwin-remote-ssh" ? undefined : host.gpus.find(gpu => {
		const model = gpu.model.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
		return profile.profile === "rtx4090-windows" ? model.includes("4090") : model.includes("5090");
	});
	if (profile.adapter !== "darwin-remote-ssh" && !compatibleGpu) {
		blockers.push(`No ${profile.profile === "rtx4090-windows" ? "RTX 4090" : "RTX 5090"} detected`);
	} else if (compatibleGpu) {
		if (compatibleGpu.vramGiB < profile.minVramGiB) {
			blockers.push(`GPU has ${compatibleGpu.vramGiB} GiB VRAM; ${profile.minVramGiB} GiB required`);
		}
		const expectedComputeCapability = profile.profile === "rtx4090-windows" ? "8.9" : "12.0";
		if (compatibleGpu.computeCapability && compatibleGpu.computeCapability !== expectedComputeCapability) {
			blockers.push(
				`GPU compute capability ${compatibleGpu.computeCapability}; ${expectedComputeCapability} required`,
			);
		}
	}
	if (profile.profile !== "rtx4090-windows" && profile.adapter !== "darwin-remote-ssh") {
		if (!host.dockerAvailable) blockers.push("Docker is unavailable");
		if (!host.nvidiaContainerRuntimeAvailable) blockers.push("NVIDIA Container Toolkit is unavailable");
	}
	if (profile.profile === "rtx4090-windows" && !host.windowsRuntimeAvailable) {
		blockers.push("Required Windows NInfer runtime prerequisites are unavailable");
	}
	if (!host.secretStorageAvailable) blockers.push("Secure appliance secret storage is unavailable");
	if (profile.minimumDiskGiB !== undefined && (host.freeDiskGiB === undefined || host.freeDiskGiB < profile.minimumDiskGiB)) {
		blockers.push(`Host has ${host.freeDiskGiB ?? "unknown"} GiB free disk; ${profile.minimumDiskGiB} GiB required`);
	}
	return blockers;
}

export function resolveApplianceProfile(
	model: string,
	gpu: ApplianceGpuSelector,
	host: ApplianceHostFacts,
	profiles: readonly ApplianceProfile[] = APPLIANCE_PROFILES,
	preferredProfile?: ApplianceProfileId,
): ApplianceProfileResolution {
	if (model !== "qwen3.8") return { supported: false, blockers: [`Unsupported appliance model: ${model}`] };
	if (preferredProfile) {
		const profile = profiles.find(candidate => candidate.profile === preferredProfile);
		if (!profile) return { supported: false, blockers: [`Compatibility profile ${preferredProfile} is unavailable`] };
		const blockers = hostBlockers(profile, host);
		return { profile, supported: blockers.length === 0, blockers };
	}
	const selected = gpu === "auto" ? detectedSelector(host) : gpu;
	if (!selected) {
		return {
			supported: false,
			blockers: [
				"No supported NVIDIA GPU detected; supported profiles are RTX 5090 Linux and RTX 4090 Windows beta",
			],
		};
	}
	const targetId: ApplianceProfileId = selected === "rtx5090" ? "rtx5090-linux" : "rtx4090-windows";
	const profile = profiles.find(candidate => candidate.profile === targetId);
	if (!profile) return { supported: false, blockers: [`Registry profile ${targetId} is unavailable`] };
	const blockers = hostBlockers(profile, host);
	return { profile, supported: blockers.length === 0, blockers };
}

export function isProfileInstallable(profile: ApplianceProfile): boolean {
	return Boolean(
		profile.availability.installable &&
			profile.availability.qualificationReceipt &&
			(profile.supportStatus !== "preview" || profile.gpuQualification?.status === "qualified") &&
			profile.assets?.runtime &&
			profile.assets.model &&
			(profile.launch || (profile.container && profile.lifecycle)),
	);
}

export function installationMatchesProfile(installation: ApplianceInstallation, profile: ApplianceProfile): boolean {
	if (!isProfileInstallable(profile) || !profile.assets) return false;
	return (
		installation.profile === profile.profile &&
		installation.release === profile.release &&
		installation.artifactSha256 === profile.artifactSha256 &&
		installation.modelSha256 === profile.artifactSha256 &&
		installation.modelSha256 === profile.assets.model.sha256 &&
		installation.runtimeSha256 === profile.assets.runtime.sha256 &&
		installation.route.provider === "ninfer-appliance" &&
		installation.route.profile === profile.profile &&
		installation.route.release === profile.release &&
		installation.route.servedModel === profile.servedModel &&
		installation.route.aliases.length === profile.aliases.length &&
		profile.aliases.every((alias, index) => alias === installation.route.aliases[index])
	);
}
