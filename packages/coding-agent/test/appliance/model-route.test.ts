import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { APPLIANCE_PROFILES } from "@oh-my-pi/pi-coding-agent/appliance/registry";
import { FileApplianceStore } from "@oh-my-pi/pi-coding-agent/appliance/store";
import type { ApplianceInstallation, ApplianceProfile } from "@oh-my-pi/pi-coding-agent/appliance/types";
import type { ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	type ApplianceRouteModelRegistry,
	type ApplianceRouteSettings,
	registerActiveApplianceRoute,
} from "../../src/appliance/model-route";

class CapturingRegistry implements ApplianceRouteModelRegistry {
	provider?: string;
	config?: ProviderConfigInput;
	registerProvider(providerName: string, config: ProviderConfigInput): void {
		this.provider = providerName;
		this.config = config;
	}
}

class CapturingSettings implements ApplianceRouteSettings {
	providerOrder = ["openai", "anthropic"];
	get(): string[] {
		return [...this.providerOrder];
	}
	override(_path: "modelProviderOrder", value: string[]): void {
		this.providerOrder = [...value];
	}
}

function publishedProfile(): ApplianceProfile {
	const profile = APPLIANCE_PROFILES.find(candidate => candidate.profile === "rtx5090-linux");
	if (!profile) throw new Error("RTX 5090 profile missing");
	return {
		...profile,
		availability: {
			installable: true,
			channel: "released",
			blockers: [],
			qualificationReceipt: { url: "https://releases.example.test/qualification.json", sha256: "2".repeat(64) },
		},
		assets: {
			runtime: { kind: "runtime", url: "https://releases.example.test/ninfer", sha256: "1".repeat(64), bytes: 100 },
			model: {
				kind: "model",
				url: "https://releases.example.test/qwen",
				sha256: profile.artifactSha256,
				bytes: 200,
			},
		},
		launch: {
			executable: "runtime",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: Launch descriptor placeholders are literal tokens.
			args: ["--model", "${model}", "--host", "${host}", "--port", "${port}", "--served-model", "${served_model}"],
			secretEnvironmentVariable: "NINFER_API_KEY",
		},
	};
}

function activeInstallation(
	profile: ApplianceProfile,
	secretRef: string,
	baseUrl = "http://127.0.0.1:8000/v1",
): ApplianceInstallation {
	if (!profile.assets) throw new Error("Published profile assets missing");
	return {
		installationId: "install-1",
		profile: profile.profile,
		release: profile.release,
		artifactSha256: profile.artifactSha256,
		runtimeSha256: profile.assets.runtime.sha256,
		modelSha256: profile.assets.model.sha256,
		candidateId: "candidate-1",
		candidateHandle: "candidates/candidate-1",
		route: {
			provider: "ninfer-appliance",
			baseUrl,
			port: 8000,
			servedModel: "q38-ninfer",
			profile: profile.profile,
			release: profile.release,
			aliases: [...profile.aliases],
			secretRef,
		},
		installedAt: "2026-08-26T00:00:00.000Z",
	};
}
describe("active appliance model route", () => {
	it("keeps local-max UX while sending the exact served model over stateful Responses", async () => {
		using temp = TempDir.createSync("@omp-appliance-route-");
		const profile = publishedProfile();
		const store = new FileApplianceStore(temp.path());
		const secretRef = await store.createSecret("install-1");
		await store.writeState({ schemaVersion: 1, revision: 1, active: activeInstallation(profile, secretRef) }, 0);
		const registry = new CapturingRegistry();
		const settings = new CapturingSettings();
		expect(await registerActiveApplianceRoute(registry, settings, temp.path(), [profile])).toBe(true);
		expect(registry.provider).toBe("ninfer-appliance");
		expect(registry.config?.baseUrl).toBe("http://127.0.0.1:8000/v1");
		expect(registry.config?.api).toBe("openai-responses");
		expect(registry.config?.authHeader).toBe(true);
		expect(registry.config?.apiKey).toBeTruthy();
		const localMax = registry.config?.models?.find(model => model.id === "local-max");
		expect(localMax).toMatchObject({
			requestModelId: "q38-ninfer",
			reasoning: true,
			supportsTools: true,
			contextWindow: 131072,
			maxTokens: 32768,
			compat: { ninferStatefulResponses: true },
		});
		expect(registry.config?.models?.map(model => model.id)).toEqual([
			"local-max",
			"local-fast",
			"local-batch",
			"qwen38-5090",
		]);
		expect(settings.providerOrder).toEqual(["ninfer-appliance", "openai", "anthropic"]);
	});

	it("rejects a route until its public release assets and receipt are complete", async () => {
		using temp = TempDir.createSync("@omp-appliance-route-");
		const profile = publishedProfile();
		const store = new FileApplianceStore(temp.path());
		const secretRef = await store.createSecret("install-1");
		await store.writeState({ schemaVersion: 1, revision: 1, active: activeInstallation(profile, secretRef) }, 0);
		let error: unknown;
		try {
			await registerActiveApplianceRoute(new CapturingRegistry(), new CapturingSettings(), temp.path());
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(Error);
		expect(error instanceof Error ? error.message : "").toContain("installable public registry profile");
	});

	it("rejects aliases that drift from the published profile", async () => {
		using temp = TempDir.createSync("@omp-appliance-route-");
		const profile = publishedProfile();
		const store = new FileApplianceStore(temp.path());
		const secretRef = await store.createSecret("install-1");
		const active = activeInstallation(profile, secretRef);
		active.route.aliases = ["local-max"];
		await store.writeState({ schemaVersion: 1, revision: 1, active }, 0);
		let error: unknown;
		try {
			await registerActiveApplianceRoute(new CapturingRegistry(), new CapturingSettings(), temp.path(), [profile]);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(Error);
		expect(error instanceof Error ? error.message : "").toContain("installable public registry profile");
	});

	it("fails closed on a non-loopback promoted route", async () => {
		using temp = TempDir.createSync("@omp-appliance-route-");
		const profile = publishedProfile();
		const store = new FileApplianceStore(temp.path());
		const secretRef = await store.createSecret("install-1");
		await store.writeState(
			{ schemaVersion: 1, revision: 1, active: activeInstallation(profile, secretRef, "http://192.0.2.10:8000/v1") },
			0,
		);
		let error: unknown;
		try {
			await registerActiveApplianceRoute(new CapturingRegistry(), new CapturingSettings(), temp.path(), [profile]);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(Error);
		expect(error instanceof Error ? error.message : "").toContain("not loopback-bound");
	});

	it("rejects a future appliance state schema instead of routing through it", async () => {
		using temp = TempDir.createSync("@omp-appliance-route-");
		const applianceDir = path.join(temp.path(), "appliance");
		await fs.mkdir(applianceDir, { recursive: true });
		await fs.writeFile(
			path.join(applianceDir, "state.json"),
			`${JSON.stringify({ schemaVersion: 2, revision: 1 })}\n`,
		);
		let error: unknown;
		try {
			await registerActiveApplianceRoute(new CapturingRegistry(), new CapturingSettings(), temp.path());
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(Error);
		expect(error instanceof Error ? error.message : "").toContain("Unsupported appliance state schema");
	});
});
