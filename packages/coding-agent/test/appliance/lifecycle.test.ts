import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import type { NInferCheckpointOperation, NInferCheckpointStatus } from "@oh-my-pi/pi-ai/providers/ninfer";
import { ApplianceLifecycle } from "@oh-my-pi/pi-coding-agent/appliance/lifecycle";
import { APPLIANCE_PROFILES } from "@oh-my-pi/pi-coding-agent/appliance/registry";
import {
	type DecodedRemoteApplianceRequest,
	decodeRemoteApplianceRequest,
	encodeRemoteApplianceRequest,
	type RemoteApplianceCompatibility,
	type RemoteApplianceInvocation,
	runRemoteApplianceDelegation,
} from "@oh-my-pi/pi-coding-agent/appliance/remote-protocol";
import {
	APPLIANCE_STATE_SCHEMA_VERSION,
	type ApplianceAction,
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
function cloneState(state: ApplianceState): ApplianceState {
	return JSON.parse(JSON.stringify(state)) as ApplianceState;
}

class MemoryStore implements ApplianceStore {
	state = emptyState();
	receipts: ApplianceReceipt[] = [];
	secrets = new Map<string, string>();
	stateWrites = 0;
	receiptWrites = 0;
	secretWrites = 0;
	lockCalls = 0;
	failNextStateWrite = false;
	events: string[] = [];

	async readState(): Promise<ApplianceState> {
		return cloneState(this.state);
	}

	async writeState(next: ApplianceState, expectedRevision: number): Promise<void> {
		if (this.failNextStateWrite) {
			this.failNextStateWrite = false;
			throw new Error("state-write-failed");
		}
		if (this.state.revision !== expectedRevision) throw new Error("unexpected-state-revision");
		if (next.revision !== expectedRevision + 1) throw new Error("state-revision-not-advanced");
		this.stateWrites += 1;
		this.state = cloneState(next);
		this.events.push(`state:${next.active?.installationId ?? "none"}`);
	}

	async writeReceipt(receipt: ApplianceReceipt): Promise<string> {
		this.receiptWrites += 1;
		this.receipts.push(structuredClone(receipt));
		return `receipt-${receipt.receiptId}`;
	}

	async hasSuccessfulRollbackReceipt(): Promise<boolean> {
		return this.receipts.some(receipt => receipt.action === "rollback" && receipt.status === "rolled-back");
	}

	async createSecret(installationId: string): Promise<string> {
		const ref = `secrets/${installationId}.key`;
		this.secretWrites += 1;
		this.secrets.set(ref, `super-secret-${installationId}`);
		return ref;
	}

	async readSecret(secretRef: string): Promise<string> {
		if (!this.secrets.has(secretRef)) throw new Error("missing-secret");
		return this.secrets.get(secretRef)!;
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
	failStartCandidate = false;
	failHealthInstallations = new Set<string>();
	recoverHealthOnStart = false;
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
	failEndpointStatus = false;
	checkpointCalls: Array<{
		installationId: string;
		operation: NInferCheckpointOperation;
		sessionSha256: string;
	}> = [];

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
		if (this.failStartCandidate) throw new Error("candidate-start-interrupted");
	}

	async stopCandidate(candidateHandle: string): Promise<void> {
		this.events.push("candidate:stop");
		this.stopped.push(candidateHandle);
	}
	async stopInstallation(installation: ApplianceInstallation): Promise<void> {
		this.events.push(`incumbent:stop:${installation.installationId}`);
	}

	async startInstallation(installation: ApplianceInstallation): Promise<void> {
		this.events.push(`incumbent:start:${installation.installationId}`);
		if (this.recoverHealthOnStart) this.failHealthInstallations.delete(installation.installationId);
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
			metrics: this.qualificationMetrics,
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
		if (this.failEndpointStatus) throw new Error("endpoint-status-failed");
		return {
			fingerprint: "9".repeat(64),
			normalizedBaseUrl: "http://127.0.0.1:8000/v1",
			servedModel: "q38-ninfer",
			profile: "rtx5090-linux",
			artifactSha256: MODEL_SHA,
			requestShapeVersion: "omp-openai-responses-ninfer/v1",
			status: {
				schemaVersion: 1,
				artifactType: "ninfer_server_status",
				upstreamBaseSha: "a".repeat(40),
				patchStackSha: "b".repeat(40),
				sourceDirty: false,
				binarySha256: "c".repeat(64),
				artifactSha256: MODEL_SHA,
				configSha256: "d".repeat(64),
				deploymentProfile: "rtx5090-linux",
				servedModel: "q38-ninfer",
				target: "sm_120a",
				modelId: "qwen3.8-27b",
				maxContext: 131072,
				scheduler: {
					maxConcurrency: 1,
					maxPendingRequests: 4,
					running: 1,
					prefilling: 0,
					decodeReady: 0,
					waiting: 0,
					materializing: 0,
					capturePending: 0,
				},
				cache: { privateCatalogOccupied: 2, privateCatalogCapacity: 4, reusedPromptTokens: 64 },
				mtp: { rounds: 4, draftedTokens: 12, acceptedTokens: 8, fallbackSteps: 0 },
			},
		};
	}

	async checkpoint(
		installation: ApplianceInstallation,
		_secret: string,
		operation: NInferCheckpointOperation,
		sessionSha256: string,
	): Promise<NInferCheckpointStatus> {
		this.checkpointCalls.push({ installationId: installation.installationId, operation, sessionSha256 });
		return {
			artifactType: "ninfer_session_checkpoint_status",
			schemaVersion: 1,
			sessionSha256,
			state: operation === "delete" ? "deleted" : "available",
			generation: "generation-1",
			bytes: 4096,
			frontierTokens: 32768,
			responseRecords: 2,
		};
	}
	qualificationMetrics: ApplianceQuickQualification["metrics"] = {
		coldTtftMs: 1_200,
		warmTtftMs: 80,
		prefixReusePercent: 99.5,
		decodeTokensPerSecond: 209.038,
	};
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

function harness(profile = installableProfile(), profiles: readonly ApplianceProfile[] = [profile]) {
	const store = new MemoryStore();
	const platform = new FakePlatform();
	const logger = new CapturingLogger();
	let id = 0;
	const lifecycle = new ApplianceLifecycle({
		store,
		platform,
		profiles,
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

		expect(receipt.details.endpoint).toMatchObject({
			reachable: true,
			identity: {
				endpointFingerprint: "9".repeat(64),
				deploymentProfile: "rtx5090-linux",
				servedModel: "q38-ninfer",
				artifactSha256: MODEL_SHA,
			},
			maxContext: 131072,
			scheduler: { running: 1, waiting: 0 },
			cache: { privateCatalogOccupied: 2, privateCatalogCapacity: 4 },
			mtp: { acceptedTokens: 8 },
		});
		expect(store.state).toEqual(before);
		expect(store.stateWrites).toBe(0);
		expect(store.receiptWrites).toBe(0);
		expect(store.secretWrites).toBe(0);
	});

	it("marks unreachable authenticated status as blocked or failed without changing routes", async () => {
		const { lifecycle, store, platform, profile } = harness();
		store.state = { ...emptyState(), revision: 1, active: installation("active", profile, "secret-active", 8000) };
		store.secrets.set("secret-active", "test-secret");
		platform.failEndpointStatus = true;
		const before = structuredClone(store.state);
		const doctor = await lifecycle.doctor();
		const status = await lifecycle.status();
		expect(doctor).toMatchObject({ status: "blocked", details: { endpoint: { reachable: false } } });
		expect(status).toMatchObject({ status: "failed", details: { endpoint: { reachable: false } } });
		expect(store.state).toEqual(before);
	});

	it("issues checkpoint requests with hashed session identity and redacted receipts", async () => {
		const checkpointBase = installableProfile();
		const profile: ApplianceProfile = {
			...checkpointBase,
			capabilities: [...checkpointBase.capabilities, "durable-checkpoint"],
		};
		const { lifecycle, store, platform } = harness(profile);
		store.state = { ...emptyState(), revision: 1, active: installation("active", profile, "secret-active", 8000) };
		store.secrets.set("secret-active", "super-secret-checkpoint");
		const sessionSha256 = "8".repeat(64);
		const receipt = await lifecycle.checkpoint("save", sessionSha256);
		expect(receipt).toMatchObject({
			action: "checkpoint",
			status: "ok",
			details: {
				operation: "save",
				sessionSha256,
				state: "available",
				generation: "generation-1",
				bytes: 4096,
			},
		});
		expect(platform.checkpointCalls).toEqual([{ installationId: "active", operation: "save", sessionSha256 }]);
		expect(JSON.stringify(receipt)).not.toContain("super-secret-checkpoint");
		expect(JSON.stringify(receipt)).not.toContain("baseUrl");
		expect(store.receiptWrites).toBe(1);
		expect(store.lockCalls).toBe(1);
	});

	it("requires an explicit profile when multiple appliances expose durable checkpoints", async () => {
		const checkpointBase = installableProfile();
		const primary: ApplianceProfile = {
			...checkpointBase,
			capabilities: [...checkpointBase.capabilities, "durable-checkpoint"],
		};
		const secondary: ApplianceProfile = {
			...primary,
			profile: "rtx4090-windows",
			aliases: ["local-fast", "local-batch", "qwen38-4090"],
		};
		const { lifecycle, store, platform } = harness(primary, [primary, secondary]);
		store.state = {
			...emptyState(),
			revision: 1,
			active: installation("active", primary, "secret-active", 8000),
			fleet: [installation("fleet", secondary, "secret-fleet", 8001)],
		};
		store.secrets.set("secret-active", "secret-primary");
		store.secrets.set("secret-fleet", "secret-secondary");
		const sessionSha256 = "7".repeat(64);

		const ambiguous = await lifecycle.checkpoint("status", sessionSha256);

		expect(ambiguous).toMatchObject({
			status: "blocked",
			details: {
				blocker: "Multiple appliance profiles expose durable checkpoints; specify --profile",
			},
		});
		expect(platform.checkpointCalls).toEqual([]);

		const selected = await lifecycle.checkpoint("status", sessionSha256, "rtx4090-windows");

		expect(selected.status).toBe("ok");
		expect(platform.checkpointCalls).toEqual([{ installationId: "fleet", operation: "status", sessionSha256 }]);
		expect(store.lockCalls).toBe(2);
	});

	it("blocks an explicit checkpoint profile when corrupt state contains duplicate profiles", async () => {
		const checkpointBase = installableProfile();
		const profile: ApplianceProfile = {
			...checkpointBase,
			capabilities: [...checkpointBase.capabilities, "durable-checkpoint"],
		};
		const { lifecycle, store, platform } = harness(profile);
		store.state = {
			...emptyState(),
			revision: 1,
			active: installation("active", profile, "secret-active", 8000),
			fleet: [installation("duplicate", profile, "secret-duplicate", 8001)],
		};

		const receipt = await lifecycle.checkpoint("status", "6".repeat(64), profile.profile);

		expect(receipt).toMatchObject({
			status: "blocked",
			details: {
				blocker: "Multiple rtx5090-linux installations expose durable checkpoints; repair appliance state",
			},
		});
		expect(platform.checkpointCalls).toEqual([]);
		expect(store.lockCalls).toBe(1);
	});

	it("installs once, switches the route atomically, and remains idempotent", async () => {
		const { lifecycle, store, platform } = harness();
		platform.onRoutedRequest = installed => {
			expect(store.state.active?.installationId).toBe(installed.installationId);
		};
		const first = await lifecycle.install("qwen3.8", "auto");
		expect(first.status).toBe("ok");
		expect(first.details.routeChanged).toBe(true);
		expect(store.state.revision).toBe(2);
		expect(store.state.active?.route.aliases).toContain("local-max");
		expect(platform.candidateCount).toBe(1);

		const second = await lifecycle.install("qwen3.8", "auto");
		expect(second.status).toBe("ok");
		expect(second.details).toMatchObject({ idempotent: true, routeChanged: false });
		expect(store.state.revision).toBe(2);
		expect(platform.candidateCount).toBe(1);
	});

	it("restarts a potentially clean active route before treating a missing pending marker as clean", async () => {
		const { lifecycle, store, platform, profile } = harness();
		const active = installation("active", profile, "secrets/active.key", profile.defaultPort);
		store.state = { ...emptyState(), revision: 4, active };
		store.secrets.set(active.route.secretRef, "active-secret");
		platform.failHealthInstallations.add(active.installationId);
		platform.recoverHealthOnStart = true;

		const receipt = await lifecycle.install("qwen3.8", "auto");

		expect(receipt).toMatchObject({ status: "ok", details: { idempotent: true, routeChanged: false } });
		expect(platform.events).toContain("incumbent:start:active");
		expect(platform.candidateCount).toBe(0);
		expect(store.state).toEqual({ ...emptyState(), revision: 4, active });
	});

	it("retains an upgraded incumbent as a routable fleet member", async () => {
		const target = installableProfile();
		const { lifecycle, store } = harness(target);
		const incumbent = installation("incumbent", target, "secret-incumbent", 9000);
		incumbent.release = "previous-release";
		incumbent.route.release = "previous-release";
		store.state = { ...emptyState(), revision: 3, active: incumbent };
		store.secrets.set("secret-incumbent", "incumbent-secret");

		const receipt = await lifecycle.install("qwen3.8", "auto");

		expect(receipt.status).toBe("ok");
		expect(store.state.active?.release).toBe(target.release);
		expect(store.state.fleet?.map(candidate => candidate.installationId)).toEqual(["incumbent"]);
		expect(store.state.rollbackTarget?.installationId).toBe("incumbent");

		const rollback = await lifecycle.rollback();

		expect(rollback.status).toBe("rolled-back");
		expect(store.state.active?.installationId).toBe("incumbent");
		expect(store.state.fleet).toEqual([]);
	});

	it("fails closed on interrupted runtime or model acquisition", async () => {
		for (const kind of ["runtime", "model"] as const) {
			const { lifecycle, store, platform } = harness();
			platform.failAcquireKind = kind;
			const receipt = await lifecycle.install("qwen3.8", "auto");
			expect(receipt.status).toBe("failed");
			expect(receipt.details.failureStage).toBe(`${kind}-download`);
			expect(store.state.active).toBeUndefined();
			expect(store.state.pending).toMatchObject({
				action: "install",
				stage: "before-predecessor-stop",
				failureReceiptId: expect.any(String),
			});
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
		expect(store.state.active).toBeUndefined();
		expect(store.state.pending).toMatchObject({
			action: "install",
			stage: "before-predecessor-stop",
			failureReceiptId: expect.any(String),
		});
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
		expect(store.state.active).toBeUndefined();
		expect(store.state.pending).toMatchObject({
			action: "install",
			stage: "before-predecessor-stop",
			failureReceiptId: expect.any(String),
		});
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
		expect(store.state.revision).toBe(8);
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
		expect(store.state.revision).toBe(7);
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
		expect(store.state.revision).toBe(8);
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
		expect(store.state.lastRollbackReceiptId).toBe(receipt.receiptId);
		expect(store.state.revision).toBe(11);
		expect(platform.events).toEqual([
			"incumbent:stop:candidate",
			"incumbent:start:incumbent",
			"health:incumbent",
			"routed:incumbent",
			"candidate:stop",
		]);
		expect(platform.stopped).toEqual([candidate.candidateHandle]);
	});

	it("reconciles a durable rollback receipt when the optional state pointer write fails", async () => {
		const profile = installableProfile();
		const incumbentProfile: ApplianceProfile = {
			...profile,
			profile: "rtx4090-windows",
			aliases: ["local-fast", "local-batch", "qwen38-4090"],
		};
		const { lifecycle, store, platform } = harness(profile, [profile, incumbentProfile]);
		const candidate = installation("candidate", profile, "secret-candidate", 8000);
		const incumbent = installation("incumbent", incumbentProfile, "secret-incumbent", 9000);
		store.secrets.set("secret-candidate", "candidate-secret");
		store.secrets.set("secret-incumbent", "incumbent-secret");
		store.state = { schemaVersion: 1, revision: 7, active: candidate, rollbackTarget: incumbent };
		platform.onRoutedRequest = routed => {
			if (routed.installationId === "incumbent") store.failNextStateWrite = true;
		};

		const receipt = await lifecycle.rollback();

		expect(receipt.status).toBe("rolled-back");
		expect(store.state.active?.installationId).toBe("incumbent");
		expect(store.state.lastRollbackReceiptId).toBeUndefined();
		const support = await lifecycle.supportBundle();
		expect(support.details.verdicts).toMatchObject({ rollback: "passed" });
		expect(support.details.blockers).not.toContain("No successful rollback receipt");
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
		expect(store.state.revision).toBe(11);
		expect(platform.stopped).toEqual([]);
		expect(platform.events).toEqual([
			"incumbent:stop:candidate",
			"incumbent:start:incumbent",
			"health:incumbent",
			"routed:incumbent",
			"incumbent:stop:incumbent",
			"incumbent:start:candidate",
			"health:candidate",
			"routed:candidate",
		]);
	});

	it("never restarts a rollback candidate with an empty persisted secret", async () => {
		const { lifecycle, store, platform, profile } = harness();
		const incumbentProfile = { ...profile, profile: "rtx4090-windows" as const, release: undefined };
		const candidateRef = "secrets/candidate.key";
		const incumbentRef = "secrets/incumbent.key";
		const candidate = installation("candidate", profile, candidateRef, 8000);
		const incumbent = installation("incumbent", incumbentProfile, incumbentRef, 9000);
		store.secrets.set(candidateRef, "");
		store.secrets.set(incumbentRef, "incumbent-secret");
		store.state = { schemaVersion: 1, revision: 7, active: candidate, rollbackTarget: incumbent };
		platform.failRoutedInstallations.add("incumbent");

		const receipt = await lifecycle.rollback();

		expect(receipt.status).toBe("failed");
		expect(receipt.details).toMatchObject({
			failureStage: "incumbent-routed-request",
			routeRestored: false,
			candidateProven: false,
			candidatePreserved: false,
		});
		expect(platform.events).not.toContain("incumbent:start:candidate");
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
			identity: { servedModel: "q38-ninfer", endpointFingerprint: "9".repeat(64) },
			scheduler: { running: 1 },
			mtp: { acceptedTokens: 8 },
		});
	});

	it("emits a redacted support bundle from existing appliance evidence", async () => {
		const { lifecycle, store, profile } = harness();
		store.state = {
			...emptyState(),
			revision: 2,
			active: installation("active", profile, "secrets/private-active.key", 8000),
			lastRollbackReceiptId: "private-rollback-receipt-id",
		};
		store.secrets.set("secrets/private-active.key", "super-secret-active");
		const before = structuredClone(store.state);

		const receipt = await lifecycle.supportBundle();

		expect(receipt).toMatchObject({
			action: "support-bundle",
			status: "ok",
			details: {
				gpuModel: "NVIDIA RTX 5090",
				os: "linux",
				driver: "999.1",
				runtimeRelease: "v0.1.0-qwen38-5090",
				modelSha256: MODEL_SHA,
				profile: "rtx5090-linux",
				context: 131072,
				verdicts: { protocol: true, tools: true, rollback: "passed" },
				metrics: {
					coldTtftMs: 1_200,
					warmTtftMs: 80,
					prefixReusePercent: 99.5,
					decodeTokensPerSecond: 209.038,
				},
				blockers: [],
			},
		});
		expect(store.state).toEqual(before);
		expect(store.receiptWrites).toBe(1);
		const encoded = JSON.stringify(receipt);
		for (const sensitive of [
			"super-secret-active",
			"secrets/private-active.key",
			"private-rollback-receipt-id",
			"3".repeat(64),
		]) {
			expect(encoded).not.toContain(sensitive);
		}
	});

	it("blocks an incomplete support bundle without fabricating measurements", async () => {
		const { lifecycle, store } = harness();

		const receipt = await lifecycle.supportBundle();

		expect(receipt.status).toBe("blocked");
		expect(receipt.details).toMatchObject({
			runtimeRelease: null,
			modelSha256: null,
			profile: null,
			context: null,
			verdicts: { protocol: null, tools: null, rollback: null },
			metrics: {
				coldTtftMs: null,
				warmTtftMs: null,
				prefixReusePercent: null,
				decodeTokensPerSecond: null,
			},
			blockers: ["No active appliance route"],
		});
		expect(store.stateWrites).toBe(0);
		expect(store.receiptWrites).toBe(1);
		expect(store.secretWrites).toBe(0);
	});

	it("resumes the same durable transaction after an interrupted download", async () => {
		const { lifecycle, store, platform } = harness();
		platform.failAcquireKind = "runtime";
		const failed = await lifecycle.install("qwen3.8", "auto");
		const installationId = store.state.pending?.installationId;
		expect(failed.status).toBe("failed");
		expect(store.state.pending).toMatchObject({
			stage: "before-predecessor-stop",
			failureReceiptId: expect.any(String),
		});
		platform.failAcquireKind = undefined;

		const resumed = await lifecycle.install("qwen3.8", "auto");

		expect(resumed.status).toBe("ok");
		expect(store.state.active?.installationId).toBe(installationId);
		expect(store.state.pending).toBeUndefined();
	});

	it("restores the predecessor before retrying a post-stop interruption", async () => {
		const { lifecycle, store, platform, profile } = harness();
		const predecessorProfile = { ...profile, profile: "rtx4090-windows" as const, release: undefined };
		const predecessor = installation("predecessor", predecessorProfile, "secrets/predecessor.key", 8000);
		store.secrets.set(predecessor.route.secretRef, "predecessor-secret");
		store.state = { schemaVersion: 1, revision: 3, active: predecessor };
		platform.failStartCandidate = true;

		const failed = await lifecycle.install("qwen3.8", "auto");

		expect(failed).toMatchObject({
			status: "failed",
			details: { incumbentPreserved: true, restorationFailed: false },
		});
		expect(store.state.pending?.stage).toBe("before-predecessor-stop");
		expect(platform.events).toContain("incumbent:start:predecessor");
		platform.failStartCandidate = false;

		const resumed = await lifecycle.install("qwen3.8", "auto");

		expect(resumed.status).toBe("ok");
		expect(store.state.active?.profile).toBe("rtx5090-linux");
		expect(store.state.rollbackTarget?.installationId).toBe("predecessor");
		expect(store.state.pending).toBeUndefined();
	});
});

const MANAGED_COMMANDS: ApplianceAction[] = [
	"doctor",
	"plan",
	"install",
	"status",
	"benchmark",
	"checkpoint",
	"rollback",
	"support-bundle",
];

function managedAuthorityProfile(id: "darwin-remote-ssh" | "linux-docker-local") {
	const publicReceipt = (digit: string) => ({
		url: `https://releases.example.test/${digit}.json`,
		sha256: digit.repeat(64),
	});
	return {
		id,
		adapter: id,
		status: "preview",
		transport: id === "darwin-remote-ssh" ? "ssh-loopback" : "local-loopback",
		commands: MANAGED_COMMANDS,
		silent_cloud_fallback: false,
		installable: true,
		support_owner: "omp-ninfer",
		product_release: "v0.2.0",
		aliases: ["local-max", "local-fast", "local-batch"],
		local_port: 8000,
		container_port: 8080,
		limitations: [],
		blockers: [],
		acceptance_receipt: publicReceipt("a"),
		gpu_qualification: { profile: "qwen38-5090-v0.2.0", status: "qualified", receipt: publicReceipt("b") },
		runtime: {
			image_reference: `ghcr.io/alphastorm/ninfer@sha256:${RUNTIME_SHA}`,
			image_digest: `sha256:${RUNTIME_SHA}`,
			model_url: "https://releases.example.test/qwen.ninfer",
			model_bytes: 300,
			model_sha256: MODEL_SHA,
			configuration_sha256: "d".repeat(64),
			server_binary_sha256: "c".repeat(64),
			minimum_vram_gib: 32,
			minimum_disk_gib: 64,
			cuda_architecture: "sm_120a",
			maximum_context_tokens: 131072,
			maximum_output_tokens: 32768,
			maximum_concurrency: 1,
			kv_dtype: "bf16",
			speculative_backend: "mtp",
			draft_tokens: 3,
			vision: true,
			preserve_thinking: true,
			capabilities: ["tools", "reasoning", "thinking-history", "stateful-responses", "vision", "durable-checkpoint"],
		},
		lifecycle: {
			script_url: "https://releases.example.test/lifecycle.sh",
			script_sha256: "f".repeat(64),
			arguments: [],
		},
	};
}

function managedCompatibility(): RemoteApplianceCompatibility {
	const bytes = Buffer.from(
		JSON.stringify({
			schema_version: 1,
			authority_id: "omp-ninfer-v0.2",
			profiles: [managedAuthorityProfile("darwin-remote-ssh"), managedAuthorityProfile("linux-docker-local")],
		}),
		"utf8",
	);
	return {
		bytes,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		transportProfile: "darwin-remote-ssh",
	};
}

class RemoteLifecycleHarness {
	readonly store = new MemoryStore();
	readonly platform = new FakePlatform();
	readonly compatibility = managedCompatibility();
	profile?: ApplianceProfile;
	delegatedWslDistribution?: string;
	invocations = 0;
	#id = 0;

	async execute(
		invocation: RemoteApplianceInvocation,
		overrides: {
			writeCompatibility?: (path: string, bytes: Uint8Array) => Promise<void>;
			removeOperationRoot?: (path: string) => Promise<void>;
			environment?: Record<string, string | undefined>;
		} = {},
	): Promise<ApplianceReceipt> {
		const payload = encodeRemoteApplianceRequest(invocation, this.compatibility);
		return this.executeDecoded(
			decodeRemoteApplianceRequest(payload, invocation.action, this.compatibility.bytes),
			overrides,
		);
	}

	async executeDecoded(
		request: DecodedRemoteApplianceRequest,
		overrides: {
			writeCompatibility?: (path: string, bytes: Uint8Array) => Promise<void>;
			removeOperationRoot?: (path: string) => Promise<void>;
			environment?: Record<string, string | undefined>;
		} = {},
	): Promise<ApplianceReceipt> {
		return runRemoteApplianceDelegation(request, {
			platform: "linux",
			...overrides,
			invoke: async delegated => {
				this.invocations += 1;
				this.profile = delegated.selectedProfile;
				this.delegatedWslDistribution = delegated.delegatedWslDistribution;
				const lifecycle = new ApplianceLifecycle({
					store: this.store,
					platform: this.platform,
					profiles: delegated.authority?.profiles,
					selectedProfileId: delegated.selectedProfile?.profile,
					now: () => new Date("2026-08-28T12:00:00.000Z"),
					newId: () => `remote-id-${++this.#id}`,
					probeAttempts: 1,
					sleep: async () => {},
				});
				switch (delegated.action) {
					case "doctor":
						return lifecycle.doctor(delegated.port ?? delegated.selectedProfile?.defaultPort);
					case "plan":
						return (await lifecycle.plan(delegated.model!, delegated.gpu ?? "auto", delegated.port)).receipt;
					case "install":
						return lifecycle.install(delegated.model!, delegated.gpu ?? "auto", delegated.port);
					case "status":
						return lifecycle.status();
					case "benchmark":
						return lifecycle.benchmark(delegated.quick === true);
					case "checkpoint":
						return lifecycle.checkpoint(
							delegated.checkpointOperation!,
							delegated.sessionSha256!,
							delegated.selectedProfile?.profile,
						);
					case "rollback":
						return lifecycle.rollback();
					case "support-bundle":
						return lifecycle.supportBundle();
				}
			},
		});
	}
}

describe("remote appliance lifecycle delegation", () => {
	it("runs a managed action in the exact caller-selected WSL distribution while retaining remote state ownership", async () => {
		const remote = new RemoteLifecycleHarness();
		const payload = encodeRemoteApplianceRequest(
			{ action: "install", model: "qwen3.8", gpu: "auto" },
			remote.compatibility,
			"Ubuntu-24.04",
		);
		const request = decodeRemoteApplianceRequest(payload, "install", remote.compatibility.bytes);

		const installed = await remote.executeDecoded(request, {
			environment: { WSL_INTEROP: "/run/WSL/1_interop", WSL_DISTRO_NAME: "Ubuntu-24.04" },
		});

		expect(installed).toMatchObject({
			status: "ok",
			details: { remoteDelegation: { transportProfile: "darwin-remote-ssh", localProfile: "linux-docker-local" } },
		});
		expect(remote.delegatedWslDistribution).toBe("Ubuntu-24.04");
		expect(remote.store.state.active?.profile).toBe("linux-docker-local");
		expect(remote.store.stateWrites).toBeGreaterThan(0);

		const mismatched = await remote.executeDecoded(request, {
			environment: { WSL_INTEROP: "/run/WSL/1_interop", WSL_DISTRO_NAME: "Debian" },
		});
		expect(mismatched).toMatchObject({
			status: "failed",
			details: {
				remoteDelegation: { failureCode: "REMOTE_WSL_CONTEXT_MISMATCH", effect: "none", localProfile: null },
			},
		});
	});

	it("classifies benchmark, checkpoint status, and support bundles as effectful before a missing receipt", async () => {
		const remote = new RemoteLifecycleHarness();
		for (const invocation of [
			{ action: "benchmark", quick: true },
			{ action: "checkpoint", checkpointOperation: "status", sessionSha256: "8".repeat(64) },
			{ action: "support-bundle" },
		] as const) {
			const payload = encodeRemoteApplianceRequest(invocation, remote.compatibility);
			const request = decodeRemoteApplianceRequest(payload, invocation.action, remote.compatibility.bytes);
			const failure = await runRemoteApplianceDelegation(request, {
				platform: "linux",
				invoke: async () => {
					throw new Error("transport ended without a receipt");
				},
			});
			expect(failure.details.remoteDelegation).toMatchObject({ effect: "uncertain" });
		}

		const planPayload = encodeRemoteApplianceRequest(
			{ action: "plan", model: "qwen3.8", gpu: "auto" },
			remote.compatibility,
		);
		const planRequest = decodeRemoteApplianceRequest(planPayload, "plan", remote.compatibility.bytes);
		const planFailure = await runRemoteApplianceDelegation(planRequest, {
			platform: "linux",
			invoke: async () => {
				throw new Error("transport ended without a receipt");
			},
		});
		expect(planFailure.details.remoteDelegation).toMatchObject({ effect: "none" });
	});

	it("owns clean install, already-installed, benchmark, and checkpoint state only on the remote loopback lifecycle", async () => {
		const remote = new RemoteLifecycleHarness();
		const callerStore = new MemoryStore();
		const callerBefore = cloneState(callerStore.state);

		const plan = await remote.execute({ action: "plan", model: "qwen3.8", gpu: "auto" });
		expect(plan).toMatchObject({
			status: "ok",
			details: { installable: true, profile: { profile: "linux-docker-local" } },
		});
		expect(remote.store.stateWrites).toBe(0);

		const installed = await remote.execute({ action: "install", model: "qwen3.8", gpu: "auto" });
		expect(installed).toMatchObject({ status: "ok", details: { routeChanged: true } });
		expect(remote.store.state.active?.profile).toBe("linux-docker-local");
		expect(remote.platform.candidateCount).toBe(1);
		const stateRevision = remote.store.state.revision;

		const repeated = await remote.execute({ action: "install", model: "qwen3.8", gpu: "auto" });
		expect(repeated).toMatchObject({ status: "ok", details: { idempotent: true, routeChanged: false } });
		expect(remote.platform.candidateCount).toBe(1);
		expect(remote.store.state.revision).toBe(stateRevision);

		const benchmark = await remote.execute({ action: "benchmark", quick: true });
		expect(benchmark).toMatchObject({ status: "ok", details: { quick: true } });
		const checkpoint = await remote.execute({
			action: "checkpoint",
			checkpointOperation: "save",
			sessionSha256: "8".repeat(64),
		});
		expect(checkpoint).toMatchObject({ status: "ok", details: { operation: "save", state: "available" } });
		expect(remote.platform.checkpointCalls).toHaveLength(1);
		expect(callerStore.state).toEqual(callerBefore);
		expect(callerStore.stateWrites).toBe(0);
		expect(JSON.stringify([installed, checkpoint])).not.toContain("super-secret");
		expect(JSON.stringify(installed)).not.toContain("secretRef");
	});

	it("preserves an upgrade predecessor, rolls it back exactly, and emits only a sanitized support receipt", async () => {
		const remote = new RemoteLifecycleHarness();
		await remote.execute({ action: "plan", model: "qwen3.8", gpu: "auto" });
		const target = remote.profile!;
		const predecessor = installation("predecessor", target, "secrets/predecessor.key", 9000);
		predecessor.release = "v0.1.0";
		predecessor.route.release = "v0.1.0";
		remote.store.state = { ...emptyState(), revision: 3, active: predecessor };
		remote.store.secrets.set(predecessor.route.secretRef, "remote-predecessor-secret");

		const upgrade = await remote.execute({ action: "install", model: "qwen3.8", gpu: "auto" });
		expect(upgrade.status).toBe("ok");
		expect(remote.store.state.active?.release).toBe(target.release);
		expect(remote.store.state.rollbackTarget?.installationId).toBe("predecessor");
		expect(remote.store.state.fleet?.map(value => value.installationId)).toEqual(["predecessor"]);

		const rollback = await remote.execute({ action: "rollback" });
		expect(rollback.status).toBe("rolled-back");
		expect(remote.store.state.active?.installationId).toBe("predecessor");
		expect(remote.store.state.fleet).toEqual([]);

		const support = await remote.execute({ action: "support-bundle" });
		expect(support.status).toBe("ok");
		expect(support.details).toMatchObject({
			profile: "linux-docker-local",
			verdicts: { rollback: "passed" },
			remoteDelegation: { cleanup: "ok", effect: "confirmed" },
		});
		const serialized = JSON.stringify(support);
		for (const forbidden of [
			"remote-predecessor-secret",
			"secretRef",
			"privatePath",
			"rawLog",
			"prompt",
			"modelOutput",
		]) {
			expect(serialized).not.toContain(forbidden);
		}
	});

	it("resumes the same pre-stop transaction and restores before retrying a post-stop interruption", async () => {
		const preStop = new RemoteLifecycleHarness();
		preStop.platform.failAcquireKind = "runtime";
		const failedDownload = await preStop.execute({ action: "install", model: "qwen3.8", gpu: "auto" });
		const installationId = preStop.store.state.pending?.installationId;
		expect(failedDownload).toMatchObject({ status: "failed", details: { failureStage: "runtime-download" } });
		expect(preStop.store.state.pending?.stage).toBe("before-predecessor-stop");
		preStop.platform.failAcquireKind = undefined;
		const resumedDownload = await preStop.execute({ action: "install", model: "qwen3.8", gpu: "auto" });
		expect(resumedDownload.status).toBe("ok");
		expect(preStop.store.state.active?.installationId).toBe(installationId);
		expect(preStop.store.state.pending).toBeUndefined();

		const postStop = new RemoteLifecycleHarness();
		await postStop.execute({ action: "plan", model: "qwen3.8", gpu: "auto" });
		const predecessor = installation("predecessor", postStop.profile!, "secrets/predecessor.key", 8000);
		predecessor.release = "v0.1.0";
		predecessor.route.release = "v0.1.0";
		postStop.store.secrets.set(predecessor.route.secretRef, "predecessor-secret");
		postStop.store.state = { ...emptyState(), revision: 3, active: predecessor };
		postStop.platform.failStartCandidate = true;
		const failedStart = await postStop.execute({ action: "install", model: "qwen3.8", gpu: "auto" });
		expect(failedStart).toMatchObject({
			status: "failed",
			details: { incumbentPreserved: true, restorationFailed: false },
		});
		expect(postStop.store.state.pending?.stage).toBe("before-predecessor-stop");
		expect(postStop.platform.events).toContain("incumbent:start:predecessor");
		postStop.platform.failStartCandidate = false;
		const resumedStart = await postStop.execute({ action: "install", model: "qwen3.8", gpu: "auto" });
		expect(resumedStart.status).toBe("ok");
		expect(postStop.store.state.rollbackTarget?.installationId).toBe("predecessor");
		expect(postStop.store.state.pending).toBeUndefined();
	});

	it("fails closed on authority hash drift and reports cleanup failure after a confirmed effect", async () => {
		const mismatch = new RemoteLifecycleHarness();
		const payload = encodeRemoteApplianceRequest(
			{ action: "install", model: "qwen3.8", gpu: "auto" },
			mismatch.compatibility,
		);
		const request = decodeRemoteApplianceRequest(payload, "install", mismatch.compatibility.bytes);
		request.compatibility!.sha256 = "0".repeat(64);
		const rejected = await mismatch.executeDecoded(request);
		expect(rejected).toMatchObject({
			status: "failed",
			details: { remoteDelegation: { failureCode: "REMOTE_COMPATIBILITY_HASH_MISMATCH", effect: "none" } },
		});
		expect(mismatch.invocations).toBe(0);
		expect(mismatch.store.stateWrites).toBe(0);

		const cleanup = new RemoteLifecycleHarness();
		const cleanupFailure = await cleanup.execute(
			{ action: "install", model: "qwen3.8", gpu: "auto" },
			{
				removeOperationRoot: async path => {
					await rm(path, { recursive: true });
					throw new Error("cleanup denied /private/path");
				},
			},
		);
		expect(cleanupFailure).toMatchObject({
			status: "failed",
			details: {
				routeChanged: true,
				remoteDelegation: {
					failureCode: "REMOTE_BOOTSTRAP_CLEANUP_FAILED",
					cleanup: "failed",
					effect: "confirmed",
				},
			},
		});
		expect(cleanup.store.state.active?.profile).toBe("linux-docker-local");
		expect(JSON.stringify(cleanupFailure)).not.toContain("/private/path");
	});

	it("preserves a delegated action failure when bootstrap cleanup also fails", async () => {
		const remote = new RemoteLifecycleHarness();
		const payload = encodeRemoteApplianceRequest(
			{ action: "install", model: "qwen3.8", gpu: "auto" },
			remote.compatibility,
		);
		const request = decodeRemoteApplianceRequest(payload, "install", remote.compatibility.bytes);
		const failure = await runRemoteApplianceDelegation(request, {
			platform: "linux",
			invoke: async () => {
				throw new Error("delegated install failed");
			},
			removeOperationRoot: async path => {
				await rm(path, { recursive: true });
				throw new Error("cleanup also failed");
			},
		});
		expect(failure).toMatchObject({
			status: "failed",
			details: {
				remoteDelegation: {
					failureCode: "REMOTE_DELEGATED_ACTION_FAILED",
					cleanup: "failed",
					effect: "uncertain",
				},
			},
		});
	});
});
