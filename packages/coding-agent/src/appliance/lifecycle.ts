import type { NInferCheckpointOperation } from "@oh-my-pi/pi-ai/providers/ninfer";
import { randomUUID } from "node:crypto";
import {
	APPLIANCE_PROFILES,
	installationMatchesProfile,
	isProfileInstallable,
	resolveApplianceProfile,
} from "./registry";
import {
	APPLIANCE_RECEIPT_SCHEMA_VERSION,
	type ApplianceCandidate,
	type ApplianceEndpointStatus,
	type ApplianceGpuSelector,
	type ApplianceHostFacts,
	type ApplianceInstallation,
	type ApplianceLogger,
	type AppliancePlan,
	type AppliancePlatform,
	type ApplianceProfile,
	type ApplianceProfileId,
	type ApplianceReceipt,
	type ApplianceState,
	type ApplianceStore,
} from "./types";

const NOOP_LOGGER: ApplianceLogger = { event() {} };

export interface ApplianceLifecycleOptions {
	store: ApplianceStore;
	platform: AppliancePlatform;
	profiles?: readonly ApplianceProfile[];
	logger?: ApplianceLogger;
	now?: () => Date;
	newId?: () => string;
	probeAttempts?: number;
	sleep?: (milliseconds: number) => Promise<void>;
}

export interface AppliancePlanResult {
	plan: AppliancePlan;
	receipt: ApplianceReceipt;
}

function isLoopbackEndpoint(endpoint: string): boolean {
	try {
		const url = new URL(endpoint);
		return (
			(url.protocol === "http:" || url.protocol === "https:") &&
			["127.0.0.1", "::1", "localhost"].includes(url.hostname)
		);
	} catch {
		return false;
	}
}

function publicProfile(profile: ApplianceProfile): Record<string, unknown> {
	return {
		id: profile.id,
		profile: profile.profile,
		runtime: profile.runtime,
		architecture: profile.architecture,
		minVramGiB: profile.minVramGiB,
		artifactSha256: profile.artifactSha256,
		contextWindow: profile.contextWindow,
		maxTokens: profile.maxTokens,
		kvDtype: profile.kvDtype,
		speculation: profile.speculation,
		concurrency: profile.concurrency,
		protocol: profile.protocol,
		capabilities: profile.capabilities,
		release: profile.release,
		servedModel: profile.servedModel,
		aliases: profile.aliases,
		channel: profile.availability.channel,
	};
}

function publicHost(host: ApplianceHostFacts): Record<string, unknown> {
	return {
		os: host.os,
		architecture: host.architecture,
		totalRamGiB: host.totalRamGiB,
		freeRamGiB: host.freeRamGiB,
		freeDiskGiB: host.freeDiskGiB,
		gpus: host.gpus.map(gpu => ({
			model: gpu.model,
			uuidHash: gpu.uuidHash,
			vramGiB: gpu.vramGiB,
			computeCapability: gpu.computeCapability,
		})),
		nvidiaDriver: host.nvidiaDriver,
		cudaVersion: host.cudaVersion,
		dockerAvailable: host.dockerAvailable,
		nvidiaContainerRuntimeAvailable: host.nvidiaContainerRuntimeAvailable,
		windowsRuntimeAvailable: host.windowsRuntimeAvailable,
		secureAuthAvailable: host.secretStorageAvailable,
	};
}

function planCommands(profile: ApplianceProfile): string[] {
	if (!profile.assets || !profile.launch) return [];
	return [
		`download runtime ${profile.assets.runtime.url}`,
		`verify runtime sha256 ${profile.assets.runtime.sha256}`,
		`download model ${profile.assets.model.url}`,
		`verify model sha256 ${profile.assets.model.sha256}`,
		[`launch runtime:${profile.assets.runtime.sha256}`, ...profile.launch.args].join(" "),
		"health GET /v1/ninfer/status with bearer authentication",
		"protocol POST /v1/responses with bearer authentication",
		"qualify protocol-tool short-decode long-prefill-reuse",
		"atomically promote appliance route",
	];
}

function supportMetric(value: number | undefined, maximum?: number): number | null {
	if (value === undefined || !Number.isFinite(value) || value < 0 || (maximum !== undefined && value > maximum)) {
		return null;
	}
	return value;
}

function publicEndpointStatus(endpoint: ApplianceEndpointStatus): Record<string, unknown> {
	return {
		reachable: true,
		identity: {
			endpointFingerprint: endpoint.fingerprint,
			deploymentProfile: endpoint.profile,
			servedModel: endpoint.servedModel,
			upstreamBaseSha: endpoint.status.upstreamBaseSha,
			patchStackSha: endpoint.status.patchStackSha,
			binarySha256: endpoint.status.binarySha256,
			artifactSha256: endpoint.artifactSha256,
			configSha256: endpoint.status.configSha256,
			sourceDirty: endpoint.status.sourceDirty,
		},
		maxContext: endpoint.status.maxContext,
		scheduler: endpoint.status.scheduler,
		cache: endpoint.status.cache,
		mtp: endpoint.status.mtp,
	};
}

export class ApplianceLifecycle {
	readonly #store: ApplianceStore;
	readonly #platform: AppliancePlatform;
	readonly #profiles: readonly ApplianceProfile[];
	readonly #logger: ApplianceLogger;
	readonly #now: () => Date;
	readonly #newId: () => string;
	readonly #probeAttempts: number;
	readonly #sleep: (milliseconds: number) => Promise<void>;

	constructor(options: ApplianceLifecycleOptions) {
		this.#store = options.store;
		this.#platform = options.platform;
		this.#profiles = options.profiles ?? APPLIANCE_PROFILES;
		this.#logger = options.logger ?? NOOP_LOGGER;
		this.#now = options.now ?? (() => new Date());
		this.#newId = options.newId ?? randomUUID;
		this.#probeAttempts = options.probeAttempts ?? 30;
		this.#sleep = options.sleep ?? (milliseconds => Bun.sleep(milliseconds));
	}

	async doctor(port = 8000): Promise<ApplianceReceipt> {
		const [host, state, occupied] = await Promise.all([
			this.#platform.inspectHost(),
			this.#store.readState(),
			this.#platform.isPortOccupied(port),
		]);
		const detected = resolveApplianceProfile("qwen3.8", "auto", host, this.#profiles);
		const artifactChecks = detected.profile?.assets
			? {
					runtimePresent: await this.#platform.artifactPresent(detected.profile.assets.runtime),
					modelPresent: await this.#platform.artifactPresent(detected.profile.assets.model),
				}
			: { runtimePresent: false, modelPresent: false };
		let endpoint: Record<string, unknown> | undefined;
		if (state.active) {
			try {
				const secret = await this.#store.readSecret(state.active.route.secretRef);
				endpoint = publicEndpointStatus(await this.#platform.readEndpointStatus(state.active, secret));
			} catch {
				endpoint = { reachable: false };
			}
		}
		const blockers = [
			...detected.blockers,
			...(detected.profile?.availability.blockers ?? []),
			...(occupied && state.active?.route.port !== port ? [`Port ${port} is occupied`] : []),
			...(state.active && endpoint?.reachable !== true
				? ["Active appliance endpoint is unreachable or failed identity validation"]
				: []),
		];
		return this.#receipt("doctor", blockers.length === 0 ? "ok" : "blocked", {
			host: publicHost(host),
			detectedProfile: detected.profile?.profile,
			profileSupported: detected.supported,
			profileInstallable: detected.profile ? isProfileInstallable(detected.profile) : false,
			blockers,
			port: { number: port, occupied },
			artifacts: artifactChecks,
			active: state.active
				? { profile: state.active.profile, release: state.active.release, model: state.active.route.servedModel }
				: undefined,
			endpoint,
		});
	}

	async plan(model: string, gpu: ApplianceGpuSelector, requestedPort?: number): Promise<AppliancePlanResult> {
		const [host, state] = await Promise.all([this.#platform.inspectHost(), this.#store.readState()]);
		const resolution = resolveApplianceProfile(model, gpu, host, this.#profiles);
		const port = requestedPort ?? resolution.profile?.defaultPort ?? 8000;
		const occupied = await this.#platform.isPortOccupied(port);
		const idempotentTarget = Boolean(
			resolution.profile && state.active && installationMatchesProfile(state.active, resolution.profile),
		);
		const blockers = [
			...resolution.blockers,
			...(resolution.profile?.availability.blockers ?? []),
			...(occupied && !idempotentTarget ? [`Port ${port} is occupied`] : []),
		];
		const assets = resolution.profile?.assets;
		const expectedBytes =
			assets?.runtime.bytes !== undefined && assets.model.bytes !== undefined
				? assets.runtime.bytes + assets.model.bytes
				: undefined;
		const plan: AppliancePlan = {
			profile: resolution.profile,
			supported: resolution.supported,
			installable: Boolean(
				resolution.profile && resolution.supported && isProfileInstallable(resolution.profile) && !occupied,
			),
			blockers,
			port,
			priorProfile: state.active?.profile,
			rollbackAvailable: Boolean(state.active),
			expectedVramGiB: resolution.profile?.minVramGiB,
			expectedDiskGiB: expectedBytes === undefined ? undefined : Math.round((expectedBytes / 1024 ** 3) * 10) / 10,
			commands: resolution.profile ? planCommands(resolution.profile) : [],
		};
		return {
			plan,
			receipt: this.#receipt("plan", plan.installable || idempotentTarget ? "ok" : "blocked", {
				profile: resolution.profile ? publicProfile(resolution.profile) : undefined,
				supported: plan.supported,
				installable: plan.installable,
				idempotentTarget,
				blockers,
				port,
				priorProfile: plan.priorProfile,
				rollbackAvailable: plan.rollbackAvailable,
				expectedVramGiB: plan.expectedVramGiB,
				expectedDiskGiB: plan.expectedDiskGiB,
				commands: plan.commands,
			}),
		};
	}

	async install(model: string, gpu: ApplianceGpuSelector, requestedPort?: number): Promise<ApplianceReceipt> {
		return this.#store.withInstallLock(async () => {
			const { plan } = await this.plan(model, gpu, requestedPort);
			if (!plan.profile) return this.#persistBlockedInstall(plan.blockers);
			const profile = plan.profile;
			const state = await this.#store.readState();
			if (state.active && installationMatchesProfile(state.active, profile)) {
				try {
					const secret = await this.#store.readSecret(state.active.route.secretRef);
					await this.#platform.probeHealth(state.active, secret);
					const receipt = this.#receipt("install", "ok", {
						profile: profile.profile,
						release: profile.release,
						idempotent: true,
						routeChanged: false,
					});
					await this.#store.writeReceipt(receipt);
					return receipt;
				} catch {
					return this.#persistBlockedInstall([
						"Existing matching appliance is unhealthy; incumbent was left unchanged",
					]);
				}
			}
			if (!plan.supported || !isProfileInstallable(profile) || plan.blockers.length > 0) {
				return this.#persistBlockedInstall(plan.blockers);
			}
			if (!profile.assets || !profile.launch?.secretEnvironmentVariable.trim()) {
				return this.#persistBlockedInstall(["Released profile lacks authenticated runtime launch metadata"]);
			}
			if (await this.#platform.isPortOccupied(plan.port)) {
				return this.#persistBlockedInstall([`Port ${plan.port} became occupied before candidate creation`]);
			}

			const installationId = this.#newId();
			let stage = "runtime-download";
			let secretRef: string | undefined;
			let candidate: ApplianceCandidate | undefined;
			let routePromoted = false;
			try {
				this.#logger.event("appliance.install.stage", { stage, profile: profile.profile });
				const runtimeRef = await this.#platform.acquireArtifact(profile.assets.runtime);
				stage = "model-download";
				this.#logger.event("appliance.install.stage", { stage, profile: profile.profile });
				const modelRef = await this.#platform.acquireArtifact(profile.assets.model);
				stage = "secret-create";
				secretRef = await this.#store.createSecret(installationId);
				const secret = await this.#store.readSecret(secretRef);
				if (!secret) throw new Error("empty-appliance-secret");
				stage = "candidate-create";
				candidate = await this.#platform.createCandidate({
					profile,
					runtimeRef,
					modelRef,
					secret,
					port: plan.port,
					installationId,
				});
				if (!isLoopbackEndpoint(candidate.endpoint)) throw new Error("candidate-non-loopback");
				stage = "candidate-start";
				await this.#platform.startCandidate(candidate);
				stage = "candidate-health";
				await this.#retryHealth(candidate, secret);
				stage = "candidate-protocol";
				await this.#platform.probeProtocol(candidate, secret);
				stage = "candidate-qualification";
				const qualification = await this.#platform.quickQualification(candidate, secret);
				if (!qualification.ok) throw new Error("candidate-qualification-failed");

				const installation: ApplianceInstallation = {
					installationId,
					profile: profile.profile,
					release: profile.release,
					artifactSha256: profile.artifactSha256,
					runtimeSha256: profile.assets.runtime.sha256,
					modelSha256: profile.assets.model.sha256,
					candidateId: candidate.candidateId,
					candidateHandle: candidate.handle,
					route: {
						provider: "ninfer-appliance",
						baseUrl: `${candidate.endpoint}/v1`,
						port: candidate.port,
						servedModel: profile.servedModel,
						profile: profile.profile,
						release: profile.release,
						aliases: [...profile.aliases],
						secretRef,
					},
					installedAt: this.#now().toISOString(),
				};
				stage = "prepared-receipt";
				const prepared = this.#receipt("install", "ok", {
					profile: profile.profile,
					release: profile.release,
					candidateId: candidate.candidateId,
					artifactSha256: profile.artifactSha256,
					runtimeSha256: profile.assets.runtime.sha256,
					modelSha256: profile.assets.model.sha256,
					qualification: qualification.cases,
					candidateProven: true,
					routeChanged: false,
				});
				await this.#store.writeReceipt(prepared);
				stage = "route-promotion";
				await this.#store.writeState(
					{
						schemaVersion: state.schemaVersion,
						revision: state.revision + 1,
						active: installation,
						fleet: state.fleet,
						rollbackTarget: state.active,
						lastInstallReceiptId: prepared.receiptId,
						lastRollbackReceiptId: state.lastRollbackReceiptId,
					},
					state.revision,
				);
				routePromoted = true;
				stage = "routed-request";
				try {
					await this.#platform.probeRoutedRequest(installation, secret);
				} catch {
					return await this.#restoreAfterPromotionFailure(state, installation, prepared.receiptId);
				}
				const receipt = this.#receipt("install", "ok", {
					profile: profile.profile,
					release: profile.release,
					candidateId: candidate.candidateId,
					artifactSha256: profile.artifactSha256,
					qualification: qualification.cases,
					candidateProven: true,
					routeChanged: true,
					rollbackRetained: Boolean(state.active),
					idempotent: false,
				});
				await this.#store.writeReceipt(receipt);
				return receipt;
			} catch {
				if (routePromoted) {
					const receipt = this.#receipt("install", "failed", {
						profile: profile.profile,
						failureStage: stage,
						routeChanged: true,
						candidatePreserved: true,
						candidateDiagnosticsRetained: true,
					});
					try {
						await this.#store.writeReceipt(receipt);
					} catch {}
					return receipt;
				}
				if (candidate) {
					try {
						await this.#platform.stopCandidate(candidate.handle);
					} catch {}
				}
				if (secretRef) await this.#store.removeSecret(secretRef);
				const receipt = this.#receipt("install", "failed", {
					profile: profile.profile,
					failureStage: stage,
					incumbentPreserved: true,
					routeChanged: false,
				});
				await this.#store.writeReceipt(receipt);
				return receipt;
			}
		});
	}

	async status(): Promise<ApplianceReceipt> {
		const state = await this.#store.readState();
		if (!state.active) {
			return this.#receipt("status", "ok", { installed: false, rollbackAvailable: false, fleet: [] });
		}
		const installations = [state.active, ...(state.fleet ?? [])];
		const endpoints = await Promise.all(
			installations.map(async installation => {
				try {
					const secret = await this.#store.readSecret(installation.route.secretRef);
					return { profile: installation.profile, endpoint: publicEndpointStatus(await this.#platform.readEndpointStatus(installation, secret)) };
				} catch {
					return { profile: installation.profile, endpoint: { reachable: false } };
				}
			}),
		);
		const allReachable = endpoints.every(item => item.endpoint.reachable === true);
		return this.#receipt("status", allReachable ? "ok" : "failed", {
			installed: true,
			stateRevision: state.revision,
			active: {
				profile: state.active.profile,
				release: state.active.release,
				artifactSha256: state.active.artifactSha256,
				servedModel: state.active.route.servedModel,
				provider: state.active.route.provider,
				port: state.active.route.port,
				aliases: state.active.route.aliases,
			},
			endpoint: endpoints[0]?.endpoint ?? { reachable: false },
			fleet: endpoints,
			rollback: state.rollbackTarget
				? { available: true, profile: state.rollbackTarget.profile, release: state.rollbackTarget.release }
				: { available: false },
		});
	}

	async benchmark(quick: boolean): Promise<ApplianceReceipt> {
		if (!quick)
			return this.#receipt("benchmark", "blocked", { blocker: "Only bounded --quick qualification is supported" });
		const state = await this.#store.readState();
		if (!state.active) return this.#receipt("benchmark", "blocked", { blocker: "No active appliance route" });
		try {
			const secret = await this.#store.readSecret(state.active.route.secretRef);
			const qualification = await this.#platform.quickQualification(state.active, secret);
			const receipt = this.#receipt("benchmark", qualification.ok ? "ok" : "failed", {
				profile: state.active.profile,
				release: state.active.release,
				quick: true,
				cases: qualification.cases,
				metrics: qualification.metrics,
			});
			await this.#store.writeReceipt(receipt);
			return receipt;
		} catch {
			const receipt = this.#receipt("benchmark", "failed", {
				profile: state.active.profile,
				quick: true,
				failureStage: "qualification-request",
			});
			await this.#store.writeReceipt(receipt);
			return receipt;
		}
	}


	async checkpoint(
		operation: NInferCheckpointOperation,
		sessionSha256: string,
		profileId?: ApplianceProfileId,
	): Promise<ApplianceReceipt> {
		const state = await this.#store.readState();
		const installations = state.active ? [state.active, ...(state.fleet ?? [])] : [];
		const checkpointInstallations = installations.filter(candidate =>
			this.#profiles
				.find(profile => profile.profile === candidate.profile)
				?.capabilities.includes("durable-checkpoint"),
		);
		const installation = profileId
			? checkpointInstallations.find(candidate => candidate.profile === profileId)
			: checkpointInstallations.length === 1
				? checkpointInstallations[0]
				: undefined;
		const profile = installation
			? this.#profiles.find(candidate => candidate.profile === installation.profile)
			: undefined;
		if (!installation || !profile?.capabilities.includes("durable-checkpoint")) {
			const receipt = this.#receipt("checkpoint", "blocked", {
				operation,
				sessionSha256,
				profile: profileId,
				blocker:
					!profileId && checkpointInstallations.length > 1
						? "Multiple appliance profiles expose durable checkpoints; specify --profile"
						: "No configured appliance profile exposes durable checkpoints",
			});
			await this.#store.writeReceipt(receipt);
			return receipt;
		}
		try {
			const secret = await this.#store.readSecret(installation.route.secretRef);
			const result = await this.#platform.checkpoint(installation, secret, operation, sessionSha256);
			const receiptStatus =
				result.state === "disabled"
					? "blocked"
					: result.state === "incompatible" || result.state === "corrupt"
						? "failed"
						: "ok";
			const receipt = this.#receipt("checkpoint", receiptStatus, {
				operation,
				sessionSha256,
				profile: installation.profile,
				state: result.state,
				bytes: result.bytes,
				frontierTokens: result.frontierTokens,
				restoredTokens: result.restoredTokens,
				responseRecords: result.responseRecords,
			});
			await this.#store.writeReceipt(receipt);
			return receipt;
		} catch {
			const receipt = this.#receipt("checkpoint", "failed", {
				operation,
				sessionSha256,
				profile: installation.profile,
				failureStage: "authenticated-checkpoint-request",
			});
			await this.#store.writeReceipt(receipt);
			return receipt;
		}
	}
	async rollback(): Promise<ApplianceReceipt> {
		return this.#store.withInstallLock(async () => {
			const state = await this.#store.readState();
			if (!state.active || !state.rollbackTarget) {
				const receipt = this.#receipt("rollback", "blocked", { blocker: "No preserved incumbent rollback target" });
				await this.#store.writeReceipt(receipt);
				return receipt;
			}
			const candidate = state.active;
			const incumbent = state.rollbackTarget;
			let stage = "incumbent-proof";
			let switched = false;
			try {
				const incumbentSecret = await this.#store.readSecret(incumbent.route.secretRef);
				await this.#platform.startInstallation(incumbent, incumbentSecret);
				await this.#retryHealth(incumbent, incumbentSecret);
				stage = "route-promotion";
				const promoted: ApplianceState = {
					schemaVersion: state.schemaVersion,
					revision: state.revision + 1,
					active: incumbent,
					fleet: state.fleet,
					rollbackTarget: candidate,
					lastInstallReceiptId: state.lastInstallReceiptId,
					lastRollbackReceiptId: state.lastRollbackReceiptId,
				};
				await this.#store.writeState(promoted, state.revision);
				switched = true;
				stage = "incumbent-routed-request";
				try {
					await this.#platform.probeRoutedRequest(incumbent, incumbentSecret);
				} catch {
					let routeRestored = false;
					let candidateProven = false;
					try {
						await this.#store.writeState({ ...state, revision: state.revision + 2 }, state.revision + 1);
						routeRestored = true;
						const candidateSecret = await this.#store.readSecret(candidate.route.secretRef);
						await this.#platform.probeRoutedRequest(candidate, candidateSecret);
						candidateProven = true;
					} catch {}
					const receipt = this.#receipt("rollback", "failed", {
						failureStage: stage,
						candidatePreserved: true,
						routeRestored,
						candidateProven,
					});
					await this.#store.writeReceipt(receipt);
					return receipt;
				}
				let candidateStopped = false;
				try {
					await this.#platform.stopCandidate(candidate.candidateHandle);
					candidateStopped = true;
				} catch {}
				const receipt = this.#receipt("rollback", "rolled-back", {
					profile: incumbent.profile,
					release: incumbent.release,
					incumbentProven: true,
					candidateStopped,
					candidateDiagnosticsRetained: true,
				});
				await this.#store.writeReceipt(receipt);
				await this.#store.writeState(
					{
						...promoted,
						revision: promoted.revision + 1,
						lastRollbackReceiptId: receipt.receiptId,
					},
					promoted.revision,
				);
				return receipt;
			} catch {
				const receipt = this.#receipt("rollback", "failed", {
					failureStage: stage,
					candidatePreserved: true,
					routeRestored: false,
					routeChanged: switched,
				});
				await this.#store.writeReceipt(receipt);
				return receipt;
			}
		});
	}
	async #persistBlockedInstall(blockers: string[]): Promise<ApplianceReceipt> {
		const receipt = this.#receipt("install", "blocked", { blockers, routeChanged: false });
		await this.#store.writeReceipt(receipt);
		return receipt;
	}

	async #retryHealth(target: Parameters<AppliancePlatform["probeHealth"]>[0], secret: string): Promise<void> {
		for (let attempt = 1; attempt <= this.#probeAttempts; attempt += 1) {
			try {
				await this.#platform.probeHealth(target, secret);
				return;
			} catch {
				if (attempt === this.#probeAttempts) throw new Error("candidate-health-timeout");
				await this.#sleep(1_000);
			}
		}
	}

	async #restoreAfterPromotionFailure(
		prior: ApplianceState,
		failed: ApplianceInstallation,
		preparedReceiptId: string,
	): Promise<ApplianceReceipt> {
		let priorSecret: string | undefined;
		if (prior.active) {
			try {
				priorSecret = await this.#store.readSecret(prior.active.route.secretRef);
				await this.#platform.startInstallation(prior.active, priorSecret);
				await this.#retryHealth(prior.active, priorSecret);
			} catch {
				const receipt = this.#receipt("install", "failed", {
					profile: failed.profile,
					failureStage: "incumbent-proof",
					priorRouteRestored: false,
					incumbentProven: false,
					candidatePreserved: true,
					candidateDiagnosticsRetained: true,
				});
				await this.#store.writeReceipt(receipt);
				return receipt;
			}
		}
		const currentRevision = prior.revision + 1;
		try {
			await this.#store.writeState(
				{
					...prior,
					revision: currentRevision + 1,
					lastInstallReceiptId: preparedReceiptId,
				},
				currentRevision,
			);
		} catch {
			const receipt = this.#receipt("install", "failed", {
				profile: failed.profile,
				failureStage: "route-restore",
				priorRouteRestored: false,
				incumbentProven: false,
				candidatePreserved: true,
				candidateDiagnosticsRetained: true,
			});
			await this.#store.writeReceipt(receipt);
			return receipt;
		}
		if (!prior.active || !priorSecret) {
			const receipt = this.#receipt("install", "rolled-back", {
				profile: failed.profile,
				failureStage: "post-promotion-routed-request",
				priorRouteRestored: true,
				incumbentProven: false,
				candidateStopped: false,
				candidateDiagnosticsRetained: true,
			});
			await this.#store.writeReceipt(receipt);
			return receipt;
		}
		try {
			await this.#platform.probeRoutedRequest(prior.active, priorSecret);
		} catch {
			const receipt = this.#receipt("install", "failed", {
				profile: failed.profile,
				failureStage: "incumbent-routed-request",
				priorRouteRestored: true,
				incumbentProven: false,
				candidatePreserved: true,
				candidateDiagnosticsRetained: true,
			});
			await this.#store.writeReceipt(receipt);
			return receipt;
		}
		let candidateStopped = false;
		try {
			await this.#platform.stopCandidate(failed.candidateHandle);
			candidateStopped = true;
		} catch {}
		const receipt = this.#receipt("install", "rolled-back", {
			profile: failed.profile,
			failureStage: "post-promotion-routed-request",
			priorRouteRestored: true,
			incumbentProven: true,
			candidateStopped,
			candidateDiagnosticsRetained: !candidateStopped,
		});
		await this.#store.writeReceipt(receipt);
		return receipt;
	}

	#receipt(
		action: ApplianceReceipt["action"],
		status: ApplianceReceipt["status"],
		details: Record<string, unknown>,
	): ApplianceReceipt {
		return {
			schemaVersion: APPLIANCE_RECEIPT_SCHEMA_VERSION,
			receiptId: this.#newId(),
			action,
			status,
			timestamp: this.#now().toISOString(),
			details,
		};
	}

	async supportBundle(): Promise<ApplianceReceipt> {
		const [host, state] = await Promise.all([this.#platform.inspectHost(), this.#store.readState()]);
		const active = state.active;
		const profile = active ? this.#profiles.find(candidate => candidate.profile === active.profile) : undefined;
		const blockers: string[] = [];
		let qualification: Awaited<ReturnType<AppliancePlatform["quickQualification"]>> | undefined;
		if (!active) {
			blockers.push("No active appliance route");
		} else {
			try {
				const secret = await this.#store.readSecret(active.route.secretRef);
				qualification = await this.#platform.quickQualification(active, secret);
				if (!qualification.ok) blockers.push("Quick qualification failed");
			} catch {
				blockers.push("Quick qualification could not reach the authenticated appliance");
			}
		}

		const protocolTool = qualification?.cases.find(testCase => testCase.name === "protocol-tool")?.ok ?? null;
		const metrics = {
			coldTtftMs: supportMetric(qualification?.metrics?.coldTtftMs),
			warmTtftMs: supportMetric(qualification?.metrics?.warmTtftMs),
			prefixReusePercent: supportMetric(qualification?.metrics?.prefixReusePercent, 100),
			decodeTokensPerSecond: supportMetric(qualification?.metrics?.decodeTokensPerSecond),
		};
		if (active && Object.values(metrics).some(value => value === null)) {
			blockers.push("Quick qualification does not expose all support-bundle performance metrics");
		}
		const rollback = state.lastRollbackReceiptId ? "passed" : null;
		if (active && rollback === null) blockers.push("No successful rollback receipt is recorded");

		const receipt = this.#receipt("support-bundle", blockers.length === 0 ? "ok" : "blocked", {
			gpuModel: host.gpus[0]?.model ?? null,
			os: host.os,
			driver: host.nvidiaDriver ?? null,
			runtimeRelease: active?.release ?? null,
			modelSha256: active?.modelSha256 ?? null,
			profile: active?.profile ?? null,
			context: profile?.contextWindow ?? null,
			verdicts: {
				protocol: protocolTool,
				tools: protocolTool,
				rollback,
			},
			metrics,
			blockers,
		});
		await this.#store.writeReceipt(receipt);
		return receipt;
	}
}
