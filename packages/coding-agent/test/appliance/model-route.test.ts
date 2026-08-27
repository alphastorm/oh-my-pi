import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage, FetchImpl } from "@oh-my-pi/pi-ai/types";
import { APPLIANCE_PROFILES } from "@oh-my-pi/pi-coding-agent/appliance/registry";
import { FileApplianceStore } from "@oh-my-pi/pi-coding-agent/appliance/store";
import type {
	ApplianceInstallation,
	ApplianceProfile,
	ApplianceProfileId,
} from "@oh-my-pi/pi-coding-agent/appliance/types";
import type { ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import {
	finalizeProviderStateEnvelope,
	PROVIDER_STATE_CUSTOM_TYPE,
	type PreparedProviderStateEnvelope,
} from "@oh-my-pi/pi-coding-agent/session/provider-state";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
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

function publishedProfile(profileId: ApplianceProfileId = "rtx5090-linux"): ApplianceProfile {
	const profile = APPLIANCE_PROFILES.find(candidate => candidate.profile === profileId);
	if (!profile) throw new Error(`${profileId} profile missing`);
	const runtimeSha256 = profileId === "rtx5090-linux" ? "1".repeat(64) : "3".repeat(64);
	return {
		...profile,
		availability: {
			installable: true,
			channel: profile.availability.channel,
			blockers: [],
			qualificationReceipt: { url: "https://releases.example.test/qualification.json", sha256: "2".repeat(64) },
		},
		assets: {
			runtime: {
				kind: "runtime",
				url: "https://releases.example.test/ninfer",
				sha256: runtimeSha256,
				bytes: 100,
			},
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

function installation(
	profile: ApplianceProfile,
	secretRef: string,
	port: number,
	installationId: string,
	baseUrl = `http://127.0.0.1:${port}/v1`,
): ApplianceInstallation {
	if (!profile.assets) throw new Error("Published profile assets missing");
	return {
		installationId,
		profile: profile.profile,
		release: profile.release,
		artifactSha256: profile.artifactSha256,
		runtimeSha256: profile.assets.runtime.sha256,
		modelSha256: profile.assets.model.sha256,
		candidateId: `candidate-${installationId}`,
		candidateHandle: `candidates/candidate-${installationId}`,
		route: {
			provider: "ninfer-appliance",
			baseUrl,
			port,
			servedModel: "q38-ninfer",
			profile: profile.profile,
			release: profile.release,
			aliases: [...profile.aliases],
			secretRef,
		},
		installedAt: "2026-08-26T00:00:00.000Z",
	};
}

function statusFixture(profile: ApplianceProfile, queueDepth = 0): Record<string, unknown> {
	return {
		artifact_type: "ninfer_server_status",
		schema_version: 1,
		status: "ok",
		identity: {
			upstream_base_sha: "a".repeat(40),
			patch_stack_sha: "b".repeat(40),
			source_dirty: false,
			binary_sha256: profile.profile === "rtx5090-linux" ? "c".repeat(64) : "4".repeat(64),
			model_artifact_sha256: profile.artifactSha256,
			config_sha256: profile.profile === "rtx5090-linux" ? "d".repeat(64) : "5".repeat(64),
			deployment_profile: profile.profile,
			target: profile.architecture,
			model_id: profile.id,
		},
		runtime: { public_model_id: profile.servedModel, max_context: profile.contextWindow },
		scheduler: {
			max_concurrency: 1,
			max_pending_requests: 4,
			running: 0,
			prefilling: 0,
			decode_ready: 0,
			waiting: queueDepth,
			materializing: 0,
			capture_pending: 0,
		},
		cache: { private_catalog: { occupied: 1, capacity: 8 }, reused_prompt_tokens: 32 },
		mtp: { rounds: 4, drafted_tokens: 12, accepted_tokens: 8, fallback_steps: 0 },
	};
}

function statusFetch(
	profilesByPort: ReadonlyMap<number, ApplianceProfile>,
	unavailablePorts: ReadonlySet<number> = new Set(),
): FetchImpl {
	return vi.fn(async (input: string | URL | Request) => {
		const url = new URL(String(input));
		const port = Number(url.port);
		if (unavailablePorts.has(port)) throw new Error("endpoint unavailable");
		const profile = profilesByPort.get(port);
		if (!profile || url.pathname !== "/v1/ninfer/status") return new Response(null, { status: 404 });
		return Response.json(statusFixture(profile));
	}) as FetchImpl;
}

function assistant(responseId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "warm" }],
		api: "openai-responses",
		provider: "ninfer-appliance",
		model: "local-max",
		responseId,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1001,
	};
}

async function publishAffinity(manager: SessionManager, endpointFingerprint: string): Promise<void> {
	manager.appendMessage({ role: "user", content: "warm question", timestamp: 1000 });
	const prepared: PreparedProviderStateEnvelope = {
		schemaVersion: 1,
		provider: "openai-responses",
		endpointFingerprint,
		model: "q38-ninfer",
		lastResponseId: "resp_warm",
		requestBaselineRef: { sha256: "6".repeat(64), bytes: 0, blob: `blob:sha256:${"6".repeat(64)}` },
		priorOutputItemsRef: { sha256: "7".repeat(64), bytes: 0, blob: `blob:sha256:${"7".repeat(64)}` },
		createdAt: "2026-08-26T00:00:00.000Z",
		updatedAt: "2026-08-26T00:00:01.000Z",
		requestShapeVersion: "omp-openai-responses-ninfer/v1",
		ninferAffinity: {
			schemaVersion: 1,
			sessionSha256: "8".repeat(64),
			endpointFingerprint,
			profile: "rtx5090-linux",
			model: "q38-ninfer",
			artifactSha256: APPLIANCE_PROFILES[0]!.artifactSha256,
			lastSuccessAt: "2026-08-26T00:00:01.000Z",
		},
	};
	await manager.appendEntriesAtomically(() => {
		const lastCommittedTurnId = manager.appendMessage(assistant("resp_warm"));
		const envelope = finalizeProviderStateEnvelope({
			prepared,
			sessionId: manager.getSessionId(),
			lastCommittedTurnId,
			branch: manager.getBranch(),
		});
		manager.appendCustomEntry(PROVIDER_STATE_CUSTOM_TYPE, envelope);
	});
}

async function writeFleet(
	temp: TempDir,
	profiles: readonly [ApplianceProfile, ApplianceProfile],
): Promise<{ active: ApplianceInstallation; fleet: ApplianceInstallation }> {
	const store = new FileApplianceStore(temp.path());
	const activeSecret = await store.createSecret("install-5090");
	const fleetSecret = await store.createSecret("install-4090");
	const active = installation(profiles[0], activeSecret, 8000, "install-5090");
	const fleet = installation(profiles[1], fleetSecret, 8001, "install-4090");
	await store.writeState({ schemaVersion: 1, revision: 1, active, fleet: [fleet] }, 0);
	return { active, fleet };
}

describe("active appliance model route", () => {
	it("keeps local-max UX while sending the exact served model over stateful Responses", async () => {
		using temp = TempDir.createSync("@omp-appliance-route-");
		const profile = publishedProfile();
		const store = new FileApplianceStore(temp.path());
		const secretRef = await store.createSecret("install-1");
		await store.writeState({ schemaVersion: 1, revision: 1, active: installation(profile, secretRef, 8000, "install-1") }, 0);
		const registry = new CapturingRegistry();
		const settings = new CapturingSettings();
		const result = await registerActiveApplianceRoute(
			registry,
			settings,
			temp.path(),
			{ fetch: statusFetch(new Map([[8000, profile]])) },
			[profile],
		);
		expect(result).toMatchObject({ profile: "rtx5090-linux", placement: "foreground", reason: "foreground_preference" });
		expect(registry.provider).toBe("ninfer-appliance");
		expect(registry.config?.baseUrl).toBe("http://127.0.0.1:8000/v1");
		expect(registry.config?.api).toBe("openai-responses");
		expect(registry.config?.authHeader).toBe(true);
		expect(registry.config?.apiKey).toBeTruthy();
		const localMax = registry.config?.models?.find(candidate => candidate.id === "local-max");
		expect(localMax).toMatchObject({
			requestModelId: "q38-ninfer",
			reasoning: true,
			supportsTools: true,
			contextWindow: 131072,
			maxTokens: 32768,
			compat: { ninferStatefulResponses: true },
		});
		expect(settings.providerOrder).toEqual(["ninfer-appliance", "openai", "anthropic"]);
	});

	it("places fresh foreground and background work on their preferred healthy appliances with a short status cache", async () => {
		using temp = TempDir.createSync("@omp-appliance-fleet-");
		const profiles = [publishedProfile("rtx5090-linux"), publishedProfile("rtx4090-windows")] as const;
		await writeFleet(temp, profiles);
		const fetchMock = statusFetch(new Map([[8000, profiles[0]], [8001, profiles[1]]]));
		const foreground = await registerActiveApplianceRoute(
			new CapturingRegistry(),
			new CapturingSettings(),
			temp.path(),
			{ placement: "foreground", fetch: fetchMock, now: () => 0 },
			profiles,
		);
		expect(foreground).toMatchObject({ profile: "rtx5090-linux", reason: "foreground_preference" });
		await registerActiveApplianceRoute(
			new CapturingRegistry(),
			new CapturingSettings(),
			temp.path(),
			{ placement: "foreground", fetch: fetchMock, now: () => 1000 },
			profiles,
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const background = await registerActiveApplianceRoute(
			new CapturingRegistry(),
			new CapturingSettings(),
			temp.path(),
			{ placement: "background", fetch: fetchMock, now: () => 3000 },
			profiles,
		);
		expect(background).toMatchObject({ profile: "rtx4090-windows", reason: "background_preference" });
		expect(fetchMock).toHaveBeenCalledTimes(4);
		const vision = await registerActiveApplianceRoute(
			new CapturingRegistry(),
			new CapturingSettings(),
			temp.path(),
			{ placement: "background", vision: true, fetch: fetchMock, now: () => 3001 },
			profiles,
		);
		expect(vision?.profile).toBe("rtx5090-linux");
	});

	it("stays on the warm owner and requires explicit cold-local fallback when it becomes unavailable", async () => {
		using temp = TempDir.createSync("@omp-appliance-affinity-");
		const profiles = [publishedProfile("rtx5090-linux"), publishedProfile("rtx4090-windows")] as const;
		await writeFleet(temp, profiles);
		const profilesByPort = new Map([[8000, profiles[0]], [8001, profiles[1]]]);
		const unavailable = new Set<number>();
		const fetchMock = statusFetch(profilesByPort, unavailable);
		const initial = await registerActiveApplianceRoute(
			new CapturingRegistry(),
			new CapturingSettings(),
			temp.path(),
			{ placement: "foreground", fetch: fetchMock, now: () => 0 },
			profiles,
		);
		if (!initial) throw new Error("initial route missing");
		const manager = SessionManager.create(temp.path(), temp.join("sessions"));
		await publishAffinity(manager, initial.endpointFingerprint);
		const warm = await registerActiveApplianceRoute(
			new CapturingRegistry(),
			new CapturingSettings(),
			temp.path(),
			{
				placement: "background",
				fetch: fetchMock,
				now: () => 1000,
				sessionManager: manager,
				sessionId: manager.getSessionId(),
			},
			profiles,
		);
		expect(warm).toMatchObject({ profile: "rtx5090-linux", reason: "warm_owner" });
		unavailable.add(8000);
		let failure: unknown;
		try {
			await registerActiveApplianceRoute(
				new CapturingRegistry(),
				new CapturingSettings(),
				temp.path(),
				{
					placement: "background",
					fetch: fetchMock,
					now: () => 3000,
					sessionManager: manager,
					sessionId: manager.getSessionId(),
				},
				profiles,
			);
		} catch (error) {
			failure = error;
		}
		expect(failure instanceof Error ? failure.message : "").toContain("cold local fallback is disabled");
		const fallbackRegistry = new CapturingRegistry();
		const fallback = await registerActiveApplianceRoute(
			fallbackRegistry,
			new CapturingSettings(),
			temp.path(),
			{
				placement: "background",
				coldLocalFallback: true,
				fetch: fetchMock,
				now: () => 6000,
				sessionManager: manager,
				sessionId: manager.getSessionId(),
			},
			profiles,
		);
		expect(fallback).toMatchObject({
			profile: "rtx4090-windows",
			reason: "cold_local_fallback",
			fallbackReason: "warm_owner_unavailable",
		});
		expect(fallbackRegistry.config?.baseUrl).toBe("http://127.0.0.1:8001/v1");
		await manager.close();
	});

	it("rejects a route until its public release assets and receipt are complete", async () => {
		using temp = TempDir.createSync("@omp-appliance-route-");
		const profile = publishedProfile();
		const store = new FileApplianceStore(temp.path());
		const secretRef = await store.createSecret("install-1");
		await store.writeState({ schemaVersion: 1, revision: 1, active: installation(profile, secretRef, 8000, "install-1") }, 0);
		let error: unknown;
		try {
			await registerActiveApplianceRoute(new CapturingRegistry(), new CapturingSettings(), temp.path());
		} catch (caught) {
			error = caught;
		}
		expect(error instanceof Error ? error.message : "").toContain("installable public registry profile");
	});

	it("rejects aliases that drift from the published profile", async () => {
		using temp = TempDir.createSync("@omp-appliance-route-");
		const profile = publishedProfile();
		const store = new FileApplianceStore(temp.path());
		const secretRef = await store.createSecret("install-1");
		const active = installation(profile, secretRef, 8000, "install-1");
		active.route.aliases = ["local-max"];
		await store.writeState({ schemaVersion: 1, revision: 1, active }, 0);
		let error: unknown;
		try {
			await registerActiveApplianceRoute(new CapturingRegistry(), new CapturingSettings(), temp.path(), {}, [profile]);
		} catch (caught) {
			error = caught;
		}
		expect(error instanceof Error ? error.message : "").toContain("installable public registry profile");
	});

	it("fails closed on a non-loopback promoted route", async () => {
		using temp = TempDir.createSync("@omp-appliance-route-");
		const profile = publishedProfile();
		const store = new FileApplianceStore(temp.path());
		const secretRef = await store.createSecret("install-1");
		await store.writeState(
			{
				schemaVersion: 1,
				revision: 1,
				active: installation(profile, secretRef, 8000, "install-1", "http://192.0.2.10:8000/v1"),
			},
			0,
		);
		let error: unknown;
		try {
			await registerActiveApplianceRoute(new CapturingRegistry(), new CapturingSettings(), temp.path(), {}, [profile]);
		} catch (caught) {
			error = caught;
		}
		expect(error instanceof Error ? error.message : "").toContain("not loopback-bound");
	});

	it("rejects a future appliance state schema instead of routing through it", async () => {
		using temp = TempDir.createSync("@omp-appliance-route-");
		const applianceDir = path.join(temp.path(), "appliance");
		await fs.mkdir(applianceDir, { recursive: true });
		await fs.writeFile(path.join(applianceDir, "state.json"), `${JSON.stringify({ schemaVersion: 2, revision: 1 })}\n`);
		let error: unknown;
		try {
			await registerActiveApplianceRoute(new CapturingRegistry(), new CapturingSettings(), temp.path());
		} catch (caught) {
			error = caught;
		}
		expect(error instanceof Error ? error.message : "").toContain("Unsupported appliance state schema");

		const unavailable: unknown[] = [];
		const skipped = await registerActiveApplianceRoute(
			new CapturingRegistry(),
			new CapturingSettings(),
			temp.path(),
			{
				allowUnavailable: true,
				onUnavailable: caught => unavailable.push(caught),
			},
		);
		expect(skipped).toBeUndefined();
		expect(unavailable).toHaveLength(1);
		expect(unavailable[0] instanceof Error ? unavailable[0].message : "").toContain(
			"Unsupported appliance state schema",
		);

		await expect(
			registerActiveApplianceRoute(
				new CapturingRegistry(),
				new CapturingSettings(),
				temp.path(),
				{ allowUnavailable: true, requestedAlias: "local-max" },
			),
		).rejects.toThrow("Unsupported appliance state schema");
	});
});
