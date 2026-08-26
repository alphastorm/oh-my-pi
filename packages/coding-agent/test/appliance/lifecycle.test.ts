import { describe, expect, it } from "bun:test";
import { ApplianceLifecycle } from "@oh-my-pi/pi-coding-agent/appliance/lifecycle";
import { APPLIANCE_PROFILES } from "@oh-my-pi/pi-coding-agent/appliance/registry";
import {
	APPLIANCE_STATE_SCHEMA_VERSION,
	type ApplianceAsset,
	type ApplianceCandidate,
	type ApplianceEndpointStatus,
	type ApplianceHostFacts,
	type ApplianceInstallation,
	type ApplianceLogger,
	type AppliancePlatform,
	type ApplianceProfile,
	type ApplianceQuickQualification,
	type ApplianceReceipt,
	type ApplianceState,
	type ApplianceStore,
} from "@oh-my-pi/pi-coding-agent/appliance/types";

const MODEL_SHA = "eec39564993d6e9c7d5e383382a760f093465c9d163ec9a1bd6b80199514bf3e";
const RUNTIME_SHA = "1".repeat(64);

function installableProfile(): ApplianceProfile {
	const base = APPLIANCE_PROFILES.find(profile => profile.profile === "rtx5090-linux");
	if (!base) throw new Error("RTX 5090 profile missing");
	return {
		...base,
		availability: {
			installable: true,
			channel: "released",
			blockers: [],
			qualificationReceipt: { url: "https://releases.example.test/q.json", sha256: "2".repeat(64) },
		},
		assets: {
			runtime: { kind: "runtime", url: "https://releases.example.test/ninfer", sha256: RUNTIME_SHA, bytes: 100 },
			model: { kind: "model", url: "https://releases.example.test/qwen", sha256: MODEL_SHA, bytes: 200 },
		},
		launch: {
			executable: "runtime",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: Launch descriptor placeholders are literal tokens.
			args: ["--model", "${model}", "--host", "${host}", "--port", "${port}", "--served-model", "${served_model}"],
			secretEnvironmentVariable: "NINFER_API_KEY",
		},
	};
}

function healthyHost(): ApplianceHostFacts {
	return {
		os: "linux",
		architecture: "x64",
		totalRamGiB: 128,
		freeRamGiB: 100,
		freeDiskGiB: 900,
		gpus: [{ model: "NVIDIA RTX 5090", uuidHash: "3".repeat(64), vramGiB: 32, computeCapability: "12.0" }],
		nvidiaDriver: "999.1",
		cudaVersion: "13.0",
		dockerAvailable: true,
		nvidiaContainerRuntimeAvailable: true,
		windowsRuntimeAvailable: false,
		secretStorageAvailable: true,
	};
}

function emptyState(): ApplianceState {
	return { schemaVersion: APPLIANCE_STATE_SCHEMA_VERSION, revision: 0 };
}

class MemoryStore implements ApplianceStore {
	state = emptyState();
	receipts: ApplianceReceipt[] = [];
	secrets = new Map<string, string>();
	stateWrites = 0;
	receiptWrites = 0;
	secretWrites = 0;
	lockCalls = 0;
	events: string[] = [];

	async readState(): Promise<ApplianceState> {
		return structuredClone(this.state);
	}

	async writeState(next: ApplianceState, expectedRevision: number): Promise<void> {
		if (this.state.revision !== expectedRevision) throw new Error("unexpected-state-revision");
		if (next.revision !== expectedRevision + 1) throw new Error("state-revision-not-advanced");
		this.stateWrites += 1;
		this.state = structuredClone(next);
		this.events.push(`state:${next.active?.installationId ?? "none"}`);
	}

	async writeReceipt(receipt: ApplianceReceipt): Promise<string> {
		this.receiptWrites += 1;
		this.receipts.push(structuredClone(receipt));
		return `receipt-${receipt.receiptId}`;
	}

	async createSecret(installationId: string): Promise<string> {
		const ref = `secrets/${installationId}.key`;
		this.secretWrites += 1;
		this.secrets.set(ref, `super-secret-${installationId}`);
		return ref;
	}

	async readSecret(secretRef: string): Promise<string> {
		const secret = this.secrets.get(secretRef);
		if (!secret) throw new Error("missing-secret");
		return secret;
	}

	async removeSecret(secretRef: string): Promise<void> {
		this.secrets.delete(secretRef);
	}

	async withInstallLock<T>(run: () => Promise<T>): Promise<T> {
		this.lockCalls += 1;
		return run();
	}
}

class FakePlatform implements AppliancePlatform {
	host = healthyHost();
	portOccupied = false;
	artifactPresence = true;
	failAcquireKind?: ApplianceAsset["kind"];
	failAcquireMode: "interrupted" | "checksum" = "interrupted";
	failCandidateHealth = false;
	failHealthInstallations = new Set<string>();
	failProtocol = false;
	qualificationOk = true;
	failNextRoutedRequest = false;
	failRoutedInstallations = new Set<string>();
	candidateEndpoint = "http://127.0.0.1:8000";
	candidateCount = 0;
	acquired: ApplianceAsset["kind"][] = [];
	stopped: string[] = [];
	events: string[] = [];
	onRoutedRequest?: (installation: ApplianceInstallation) => void;

	async inspectHost(): Promise<ApplianceHostFacts> {
		return structuredClone(this.host);
	}

	async isPortOccupied(): Promise<boolean> {
		return this.portOccupied;
	}

	async artifactPresent(): Promise<boolean> {
		return this.artifactPresence;
	}

	async acquireArtifact(asset: ApplianceAsset): Promise<string> {
		this.acquired.push(asset.kind);
		if (this.failAcquireKind === asset.kind) {
			throw new Error(
				this.failAcquireMode === "checksum"
					? `sensitive-path checksum mismatch ${asset.kind}`
					: "download-interrupted",
			);
		}
		return `artifacts/${asset.kind}/${asset.sha256}`;
	}

	async removeArtifact(): Promise<void> {}

	async createCandidate(input: { port: number; installationId: string }): Promise<ApplianceCandidate> {
		this.candidateCount += 1;
		this.events.push("candidate:create");
		return {
			candidateId: `candidate-${input.installationId}`,
			handle: `candidates/candidate-${input.installationId}`,
			endpoint: this.candidateEndpoint.replace(":8000", `:${input.port}`),
			port: input.port,
		};
	}

	async startCandidate(): Promise<void> {
		this.events.push("candidate:start");
	}

	async stopCandidate(candidateHandle: string): Promise<void> {
		this.events.push("candidate:stop");
		this.stopped.push(candidateHandle);
	}

	async startInstallation(installation: ApplianceInstallation): Promise<void> {
		this.events.push(`incumbent:start:${installation.installationId}`);
	}

	async probeHealth(target: ApplianceCandidate | ApplianceInstallation): Promise<void> {
		if (bodyIsInstallation(target)) {
			if (this.failHealthInstallations.has(target.installationId)) throw new Error("unhealthy-installation");
		} else if (this.failCandidateHealth) {
			throw new Error("unhealthy-candidate");
		}
		this.events.push(`health:${bodyIsInstallation(target) ? target.installationId : target.candidateId}`);
	}

	async probeProtocol(): Promise<void> {
		if (this.failProtocol) throw new Error("protocol-failed");
		this.events.push("protocol");
	}

	async quickQualification(): Promise<ApplianceQuickQualification> {
		this.events.push("qualification");
		return {
			ok: this.qualificationOk,
			cases: [
				{ name: "protocol-tool", ok: this.qualificationOk, durationMs: 1, oracleSha256: "4".repeat(64) },
				{ name: "short-decode", ok: this.qualificationOk, durationMs: 2, oracleSha256: "5".repeat(64) },
				{ name: "long-prefill-reuse", ok: this.qualificationOk, durationMs: 3, oracleSha256: "6".repeat(64) },
			],
		};
	}

	async probeRoutedRequest(installation: ApplianceInstallation): Promise<void> {
		this.events.push(`routed:${installation.installationId}`);
		this.onRoutedRequest?.(installation);
		if (this.failNextRoutedRequest) {
			this.failNextRoutedRequest = false;
			throw new Error("routed-request-failed");
		}
		if (this.failRoutedInstallations.has(installation.installationId)) throw new Error("routed-installation-failed");
	}

	async readEndpointStatus(): Promise<ApplianceEndpointStatus> {
		return {
			schemaVersion: 1,
			deploymentProfile: "rtx5090-linux",
			servedModel: "q38-ninfer",
			sessionsResident: 2,
			queueDepth: 0,
			cacheUtilization: 0.5,
			mtpDepth: 3,
			powerProfile: "performance",
		};
	}
}

function bodyIsInstallation(target: ApplianceCandidate | ApplianceInstallation): target is ApplianceInstallation {
	return "installationId" in target;
}

class CapturingLogger implements ApplianceLogger {
	events: Array<{ name: string; fields?: Record<string, string | number | boolean | undefined> }> = [];
	event(name: string, fields?: Record<string, string | number | boolean | undefined>): void {
		this.events.push({ name, fields });
	}
}

function installation(id: string, profile: ApplianceProfile, secretRef: string, port: number): ApplianceInstallation {
	return {
		installationId: id,
		profile: profile.profile,
		release: profile.release,
		artifactSha256: profile.artifactSha256,
		runtimeSha256: profile.assets?.runtime.sha256 ?? RUNTIME_SHA,
		modelSha256: profile.assets?.model.sha256 ?? MODEL_SHA,
		candidateId: `candidate-${id}`,
		candidateHandle: `candidates/candidate-${id}`,
		route: {
			provider: "ninfer-appliance",
			baseUrl: `http://127.0.0.1:${port}/v1`,
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

function harness(profile = installableProfile()) {
	const store = new MemoryStore();
	const platform = new FakePlatform();
	const logger = new CapturingLogger();
	let id = 0;
	const lifecycle = new ApplianceLifecycle({
		store,
		platform,
		profiles: [profile],
		logger,
		now: () => new Date("2026-08-26T00:00:00.000Z"),
		newId: () => `id-${++id}`,
		probeAttempts: 1,
		sleep: async () => {},
	});
	return { store, platform, logger, lifecycle, profile };
}

describe("appliance lifecycle", () => {
	it("keeps doctor, plan, and repeated status calls read-only", async () => {
		const { lifecycle, store } = harness();
		const before = structuredClone(store.state);
		expect((await lifecycle.doctor()).action).toBe("doctor");
		expect((await lifecycle.plan("qwen3.8", "auto")).plan.installable).toBe(true);
		expect((await lifecycle.status()).details.installed).toBe(false);
		expect((await lifecycle.status()).details.installed).toBe(false);
		expect(store.state).toEqual(before);
		expect(store.stateWrites).toBe(0);
		expect(store.receiptWrites).toBe(0);
		expect(store.secretWrites).toBe(0);
	});

	it("reports active endpoint reachability without mutating appliance state", async () => {
		const { lifecycle, store, profile } = harness();
		store.state = { ...emptyState(), revision: 1, active: installation("active", profile, "secret-active", 8000) };
		store.secrets.set("secret-active", "test-secret");
		const before = structuredClone(store.state);

		const receipt = await lifecycle.doctor();

		expect(receipt.details.endpoint).toEqual({
			reachable: true,
			schemaVersion: 1,
			deploymentProfile: "rtx5090-linux",
			servedModel: "q38-ninfer",
			sessionsResident: 2,
			queueDepth: 0,
			cacheUtilization: 0.5,
			mtpDepth: 3,
			powerProfile: "performance",
		});
		expect(store.state).toEqual(before);
		expect(store.stateWrites).toBe(0);
		expect(store.receiptWrites).toBe(0);
		expect(store.secretWrites).toBe(0);
	});

	it("installs once, switches the route atomically, and remains idempotent", async () => {
		const { lifecycle, store, platform } = harness();
		platform.onRoutedRequest = installed => {
			expect(store.state.active?.installationId).toBe(installed.installationId);
		};
		const first = await lifecycle.install("qwen3.8", "auto");
		expect(first.status).toBe("ok");
		expect(first.details.routeChanged).toBe(true);
		expect(store.state.revision).toBe(1);
		expect(store.state.active?.route.aliases).toContain("local-max");
		expect(platform.candidateCount).toBe(1);

		const second = await lifecycle.install("qwen3.8", "auto");
		expect(second.status).toBe("ok");
		expect(second.details).toMatchObject({ idempotent: true, routeChanged: false });
		expect(store.state.revision).toBe(1);
		expect(platform.candidateCount).toBe(1);
	});

	it("fails closed on interrupted runtime or model acquisition", async () => {
		for (const kind of ["runtime", "model"] as const) {
			const { lifecycle, store, platform } = harness();
			platform.failAcquireKind = kind;
			const receipt = await lifecycle.install("qwen3.8", "auto");
			expect(receipt.status).toBe("failed");
			expect(receipt.details.failureStage).toBe(`${kind}-download`);
			expect(store.state).toEqual(emptyState());
			expect(platform.candidateCount).toBe(0);
			expect(store.secrets.size).toBe(0);
			expect(JSON.stringify(receipt)).not.toContain("sensitive-path");
		}
	});

	it("fails closed on an artifact checksum mismatch", async () => {
		const { lifecycle, store, platform } = harness();
		platform.failAcquireKind = "model";
		platform.failAcquireMode = "checksum";

		const receipt = await lifecycle.install("qwen3.8", "auto");

		expect(receipt.status).toBe("failed");
		expect(receipt.details.failureStage).toBe("model-download");
		expect(store.state).toEqual(emptyState());
		expect(platform.candidateCount).toBe(0);
		expect(store.secrets.size).toBe(0);
		expect(JSON.stringify(receipt)).not.toContain("sensitive-path");
	});

	it("blocks port collisions before downloads", async () => {
		const { lifecycle, store, platform } = harness();
		platform.portOccupied = true;
		const receipt = await lifecycle.install("qwen3.8", "auto");
		expect(receipt.status).toBe("blocked");
		expect(JSON.stringify(receipt.details.blockers)).toContain("Port 8000 is occupied");
		expect(platform.acquired).toEqual([]);
		expect(store.stateWrites).toBe(0);
	});

	it("requires authenticated launch metadata", async () => {
		const profile = installableProfile();
		if (!profile.launch) throw new Error("launch fixture missing");
		profile.launch.secretEnvironmentVariable = "";
		const { lifecycle, store, platform } = harness(profile);
		const receipt = await lifecycle.install("qwen3.8", "auto");
		expect(receipt.status).toBe("blocked");
		expect(JSON.stringify(receipt.details)).toContain("authenticated runtime launch metadata");
		expect(store.secretWrites).toBe(0);
		expect(platform.candidateCount).toBe(0);
	});

	it("leaves the incumbent unchanged when candidate health fails", async () => {
		const { lifecycle, store, platform } = harness();
		platform.failCandidateHealth = true;
		const receipt = await lifecycle.install("qwen3.8", "auto");
		expect(receipt.status).toBe("failed");
		expect(receipt.details).toMatchObject({
			failureStage: "candidate-health",
			incumbentPreserved: true,
			routeChanged: false,
		});
		expect(store.state).toEqual(emptyState());
		expect(platform.stopped).toHaveLength(1);
		expect(store.secrets.size).toBe(0);
	});

	it("restores and proves the incumbent after a post-promotion failure", async () => {
		const { lifecycle, store, platform, profile } = harness();
		const incumbentProfile = { ...profile, profile: "rtx4090-windows" as const, release: undefined };
		const incumbentRef = "secrets/incumbent.key";
		const incumbent = installation("incumbent", incumbentProfile, incumbentRef, 9000);
		store.secrets.set(incumbentRef, "incumbent-secret");
		store.state = { schemaVersion: 1, revision: 4, active: incumbent };
		platform.failNextRoutedRequest = true;
		const receipt = await lifecycle.install("qwen3.8", "auto", 8000);
		expect(receipt.status).toBe("rolled-back");
		expect(receipt.details).toMatchObject({
			priorRouteRestored: true,
			incumbentProven: true,
			candidateStopped: true,
		});
		expect(store.state.active?.installationId).toBe("incumbent");
		expect(store.state.revision).toBe(6);
		expect(platform.stopped).toEqual(["candidates/candidate-id-2"]);
	});

	it("keeps the promoted candidate when the incumbent cannot be proven directly", async () => {
		const { lifecycle, store, platform, profile } = harness();
		const incumbentProfile = { ...profile, profile: "rtx4090-windows" as const, release: undefined };
		const incumbentRef = "secrets/incumbent.key";
		const incumbent = installation("incumbent", incumbentProfile, incumbentRef, 9000);
		store.secrets.set(incumbentRef, "incumbent-secret");
		store.state = { schemaVersion: 1, revision: 4, active: incumbent };
		platform.failNextRoutedRequest = true;
		platform.failHealthInstallations.add("incumbent");

		const receipt = await lifecycle.install("qwen3.8", "auto", 8000);

		expect(receipt.status).toBe("failed");
		expect(receipt.details).toMatchObject({
			failureStage: "incumbent-proof",
			priorRouteRestored: false,
			incumbentProven: false,
			candidatePreserved: true,
		});
		expect(store.state.active?.installationId).toBe("id-2");
		expect(store.state.revision).toBe(5);
		expect(platform.stopped).toEqual([]);
		expect(store.secrets.size).toBe(2);
	});

	it("retains the candidate when restored incumbent routing proof fails", async () => {
		const { lifecycle, store, platform, profile } = harness();
		const incumbentProfile = { ...profile, profile: "rtx4090-windows" as const, release: undefined };
		const incumbentRef = "secrets/incumbent.key";
		const incumbent = installation("incumbent", incumbentProfile, incumbentRef, 9000);
		store.secrets.set(incumbentRef, "incumbent-secret");
		store.state = { schemaVersion: 1, revision: 4, active: incumbent };
		platform.failNextRoutedRequest = true;
		platform.failRoutedInstallations.add("incumbent");

		const receipt = await lifecycle.install("qwen3.8", "auto", 8000);

		expect(receipt.status).toBe("failed");
		expect(receipt.details).toMatchObject({
			failureStage: "incumbent-routed-request",
			priorRouteRestored: true,
			incumbentProven: false,
			candidatePreserved: true,
		});
		expect(store.state.active?.installationId).toBe("incumbent");
		expect(store.state.revision).toBe(6);
		expect(platform.stopped).toEqual([]);
		expect(store.secrets.size).toBe(2);
	});

	it("rolls back only after the preserved incumbent passes direct and routed proof", async () => {
		const { lifecycle, store, platform, profile } = harness();
		const incumbentProfile = { ...profile, profile: "rtx4090-windows" as const, release: undefined };
		const candidateRef = "secrets/candidate.key";
		const incumbentRef = "secrets/incumbent.key";
		const candidate = installation("candidate", profile, candidateRef, 8000);
		const incumbent = installation("incumbent", incumbentProfile, incumbentRef, 9000);
		store.secrets.set(candidateRef, "candidate-secret");
		store.secrets.set(incumbentRef, "incumbent-secret");
		store.state = { schemaVersion: 1, revision: 7, active: candidate, rollbackTarget: incumbent };
		const receipt = await lifecycle.rollback();
		expect(receipt.status).toBe("rolled-back");
		expect(store.state.active?.installationId).toBe("incumbent");
		expect(store.state.rollbackTarget?.installationId).toBe("candidate");
		expect(platform.events).toEqual([
			"incumbent:start:incumbent",
			"health:incumbent",
			"routed:incumbent",
			"candidate:stop",
		]);
		expect(platform.stopped).toEqual([candidate.candidateHandle]);
	});

	it("restores and proves the candidate when explicit rollback routing fails", async () => {
		const { lifecycle, store, platform, profile } = harness();
		const incumbentProfile = { ...profile, profile: "rtx4090-windows" as const, release: undefined };
		const candidateRef = "secrets/candidate.key";
		const incumbentRef = "secrets/incumbent.key";
		const candidate = installation("candidate", profile, candidateRef, 8000);
		const incumbent = installation("incumbent", incumbentProfile, incumbentRef, 9000);
		store.secrets.set(candidateRef, "candidate-secret");
		store.secrets.set(incumbentRef, "incumbent-secret");
		store.state = { schemaVersion: 1, revision: 7, active: candidate, rollbackTarget: incumbent };
		platform.failRoutedInstallations.add("incumbent");

		const receipt = await lifecycle.rollback();

		expect(receipt.status).toBe("failed");
		expect(receipt.details).toMatchObject({
			failureStage: "incumbent-routed-request",
			routeRestored: true,
			candidateProven: true,
			candidatePreserved: true,
		});
		expect(store.state.active?.installationId).toBe("candidate");
		expect(store.state.rollbackTarget?.installationId).toBe("incumbent");
		expect(store.state.revision).toBe(9);
		expect(platform.stopped).toEqual([]);
		expect(platform.events).toEqual([
			"incumbent:start:incumbent",
			"health:incumbent",
			"routed:incumbent",
			"routed:candidate",
		]);
	});

	it("keeps receipts, status, and logs free of secrets and private references", async () => {
		const { lifecycle, store, logger } = harness();
		const installReceipt = await lifecycle.install("qwen3.8", "auto");
		const before = structuredClone(store.state);
		const firstStatus = await lifecycle.status();
		const secondStatus = await lifecycle.status();
		expect(store.state).toEqual(before);
		const publicOutput = JSON.stringify({ installReceipt, firstStatus, secondStatus, logs: logger.events });
		expect(publicOutput).not.toContain("super-secret");
		expect(publicOutput).not.toContain("secrets/");
		expect(publicOutput).not.toContain("baseUrl");
		expect(publicOutput).not.toContain("argv");
		expect(publicOutput).not.toContain("/Users/");
		expect(firstStatus.details.endpoint).toMatchObject({
			reachable: true,
			servedModel: "q38-ninfer",
			sessionsResident: 2,
			mtpDepth: 3,
		});
	});
});
