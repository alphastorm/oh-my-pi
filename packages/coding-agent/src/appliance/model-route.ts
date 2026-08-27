import { fetchNInferStatus, type NInferEndpointIdentity } from "@oh-my-pi/pi-ai/providers/ninfer";
import type { FetchImpl, NInferSessionAffinity } from "@oh-my-pi/pi-ai/types";
import type { ProviderConfigInput } from "../config/model-registry";
import { loadProviderStateAffinity } from "../session/provider-state";
import type { SessionManager } from "../session/session-manager";
import { APPLIANCE_PROFILES, installationMatchesProfile } from "./registry";
import { FileApplianceStore } from "./store";
import type { ApplianceInstallation, ApplianceProfile, ApplianceProfileId, ApplianceRoute } from "./types";

export interface ApplianceRouteModelRegistry {
	registerProvider(providerName: string, config: ProviderConfigInput): void;
}

export interface ApplianceRouteSettings {
	get(path: "modelProviderOrder"): string[];
	override(path: "modelProviderOrder", value: string[]): void;
}

export type AppliancePlacement = "foreground" | "background";
export type ApplianceSelectionReason =
	| "warm_owner"
	| "foreground_preference"
	| "background_preference"
	| "cold_local_fallback";

export interface ApplianceRouteSelectionOptions {
	placement?: AppliancePlacement;
	requestedAlias?: string;
	contextTokens?: number;
	vision?: boolean;
	coldLocalFallback?: boolean;
	foregroundReservation?: boolean;
	allowUnavailable?: boolean;
	onUnavailable?: (error: unknown) => void;
	sessionManager?: SessionManager;
	sessionId?: string;
	fetch?: FetchImpl;
	now?: () => number;
}

export interface ApplianceRouteRegistration {
	profile: ApplianceProfileId;
	endpointFingerprint: string;
	artifactSha256: string;
	servedModel: string;
	placement: AppliancePlacement;
	reason: ApplianceSelectionReason;
	fallbackReason?: "warm_owner_unavailable";
	status: {
		maxContext: number;
		running: number;
		prefilling: number;
		decodeReady: number;
		queueDepth: number;
		cacheOccupied: number;
		cacheCapacity: number;
		reusedPromptTokens: number;
		mtpAcceptedTokens: number;
	};
}

interface ValidatedInstallation {
	installation: ApplianceInstallation;
	profile: ApplianceProfile;
	secret: string;
}

interface EndpointObservation extends ValidatedInstallation {
	identity?: NInferEndpointIdentity;
	failure?: string;
}

const APPLIANCE_PROVIDER = "ninfer-appliance";
const STATUS_CACHE_TTL_MS = 2_000;
const STATUS_REQUEST_TIMEOUT_MS = 2_000;
const statusCache = new Map<string, { expiresAt: number; identity?: NInferEndpointIdentity; failure?: string }>();

function assertLoopbackRoute(route: ApplianceRoute): void {
	let url: URL;
	try {
		url = new URL(route.baseUrl);
	} catch {
		throw new Error("Appliance route has an invalid base URL");
	}
	if (!["127.0.0.1", "::1", "[::1]", "localhost"].includes(url.hostname)) {
		throw new Error("Appliance route is not loopback-bound");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Appliance route has an unsupported protocol");
	}
	const effectivePort = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
	if (effectivePort !== route.port) throw new Error("Appliance route port does not match its base URL");
	if (url.username || url.password || url.search || url.hash) {
		throw new Error("Appliance route URL contains forbidden components");
	}
	const apiPath = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
	if (apiPath !== "/v1") throw new Error("Appliance route must target the /v1 API root");
}

function profileForAlias(alias: string | undefined): ApplianceProfileId | undefined {
	if (alias === "qwen38-5090") return "rtx5090-linux";
	if (alias === "qwen38-4090") return "rtx4090-windows";
	return undefined;
}

function supportsRequest(candidate: ValidatedInstallation, options: ApplianceRouteSelectionOptions): boolean {
	const explicitProfile = profileForAlias(options.requestedAlias);
	if (explicitProfile && explicitProfile !== candidate.profile.profile) return false;
	if (options.requestedAlias && !candidate.installation.route.aliases.includes(options.requestedAlias)) return false;
	if (options.vision && !candidate.profile.capabilities.includes("vision")) return false;
	if (options.contextTokens !== undefined && options.contextTokens > candidate.profile.contextWindow) return false;
	return candidate.profile.capabilities.includes("stateful-responses");
}

function endpointCacheKey(agentDir: string, installation: ApplianceInstallation): string {
	return Bun.SHA256.hash(
		`${agentDir}\u0000${installation.installationId}\u0000${installation.runtimeSha256}\u0000${installation.modelSha256}\u0000${installation.route.baseUrl}`,
		"hex",
	);
}

async function observeEndpoint(
	candidate: ValidatedInstallation,
	agentDir: string,
	options: ApplianceRouteSelectionOptions,
): Promise<EndpointObservation> {
	const now = options.now?.() ?? Date.now();
	const key = endpointCacheKey(agentDir, candidate.installation);
	const cached = statusCache.get(key);
	if (cached && cached.expiresAt > now) return { ...candidate, identity: cached.identity, failure: cached.failure };
	let identity: NInferEndpointIdentity | undefined;
	let failure: string | undefined;
	try {
		identity = await fetchNInferStatus({
			baseUrl: candidate.installation.route.baseUrl,
			apiKey: candidate.secret,
			servedModel: candidate.installation.route.servedModel,
			fetch: options.fetch,
			signal: AbortSignal.timeout(STATUS_REQUEST_TIMEOUT_MS),
		});
		if (identity.artifactSha256 !== candidate.installation.artifactSha256) {
			throw new Error("served artifact does not match the promoted installation");
		}
	} catch (error) {
		failure = error instanceof Error ? error.message : "authenticated status failed";
	}
	statusCache.set(key, { expiresAt: now + STATUS_CACHE_TTL_MS, identity, failure });
	return { ...candidate, identity, failure };
}

function endpointLoad(identity: NInferEndpointIdentity): number {
	const scheduler = identity.status.scheduler;
	return (
		scheduler.running +
		scheduler.prefilling +
		scheduler.decodeReady +
		scheduler.waiting +
		scheduler.materializing +
		scheduler.capturePending
	);
}

function selectFresh(
	observations: readonly EndpointObservation[],
	placement: AppliancePlacement,
	foregroundReservation: boolean,
): EndpointObservation | undefined {
	const healthy = observations.filter(candidate => candidate.identity);
	const preferred: ApplianceProfileId = placement === "foreground" ? "rtx5090-linux" : "rtx4090-windows";
	return healthy.toSorted((left, right) => {
		const leftIdentity = left.identity!;
		const rightIdentity = right.identity!;
		const leftSaturated = leftIdentity.status.scheduler.waiting >= leftIdentity.status.scheduler.maxPendingRequests;
		const rightSaturated = rightIdentity.status.scheduler.waiting >= rightIdentity.status.scheduler.maxPendingRequests;
		if (leftSaturated !== rightSaturated) return leftSaturated ? 1 : -1;
		const leftPreferred = left.profile.profile === preferred;
		const rightPreferred = right.profile.profile === preferred;
		if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1;
		if (placement === "background" && foregroundReservation) {
			const leftReserved = left.profile.profile === "rtx5090-linux";
			const rightReserved = right.profile.profile === "rtx5090-linux";
			if (leftReserved !== rightReserved) return leftReserved ? 1 : -1;
		}
		return endpointLoad(leftIdentity) - endpointLoad(rightIdentity);
	})[0];
}

function readAffinity(options: ApplianceRouteSelectionOptions): NInferSessionAffinity | undefined {
	if (!options.sessionManager || !options.sessionId) return undefined;
	return loadProviderStateAffinity({ sessionManager: options.sessionManager, sessionId: options.sessionId });
}

async function validateInstallations(
	installations: readonly ApplianceInstallation[],
	store: FileApplianceStore,
	profiles: readonly ApplianceProfile[],
): Promise<ValidatedInstallation[]> {
	return Promise.all(
		installations.map(async installation => {
			assertLoopbackRoute(installation.route);
			const profile = profiles.find(candidate => candidate.profile === installation.profile);
			if (!profile || !installationMatchesProfile(installation, profile)) {
				throw new Error("Appliance route does not match an installable public registry profile");
			}
			if (installation.route.provider !== APPLIANCE_PROVIDER) {
				throw new Error("Appliance route has an invalid provider");
			}
			const secret = await store.readSecret(installation.route.secretRef);
			if (!secret) throw new Error("Appliance route has no authentication secret");
			return { installation, profile, secret };
		}),
	);
}

function registerSelected(
	modelRegistry: ApplianceRouteModelRegistry,
	settings: ApplianceRouteSettings,
	selected: EndpointObservation,
): void {
	const { installation, profile, secret } = selected;
	const statefulResponses = profile.capabilities.includes("stateful-responses");
	const input: ("text" | "image")[] = profile.capabilities.includes("vision") ? ["text", "image"] : ["text"];
	modelRegistry.registerProvider(APPLIANCE_PROVIDER, {
		baseUrl: installation.route.baseUrl,
		apiKey: secret,
		api: "openai-responses",
		authHeader: true,
		compat: { ninferStatefulResponses: statefulResponses },
		models: installation.route.aliases.map(alias => ({
			id: alias,
			requestModelId: installation.route.servedModel,
			name: `${alias} (${profile.profile})`,
			api: "openai-responses",
			reasoning: profile.capabilities.includes("reasoning"),
			input,
			supportsTools: profile.capabilities.includes("tools"),
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: profile.contextWindow,
			maxTokens: profile.maxTokens,
			compat: { ninferStatefulResponses: statefulResponses },
		})),
	});
	const currentProviderOrder = settings.get("modelProviderOrder");
	settings.override("modelProviderOrder", [
		APPLIANCE_PROVIDER,
		...currentProviderOrder.filter(provider => provider !== APPLIANCE_PROVIDER),
	]);
}

function registrationReceipt(
	selected: EndpointObservation,
	placement: AppliancePlacement,
	reason: ApplianceSelectionReason,
	fallbackReason?: "warm_owner_unavailable",
): ApplianceRouteRegistration {
	const identity = selected.identity!;
	const scheduler = identity.status.scheduler;
	return {
		profile: selected.profile.profile,
		endpointFingerprint: identity.fingerprint,
		artifactSha256: identity.artifactSha256,
		servedModel: identity.servedModel,
		placement,
		reason,
		fallbackReason,
		status: {
			maxContext: identity.status.maxContext,
			running: scheduler.running,
			prefilling: scheduler.prefilling,
			decodeReady: scheduler.decodeReady,
			queueDepth: scheduler.waiting + scheduler.materializing + scheduler.capturePending,
			cacheOccupied: identity.status.cache.privateCatalogOccupied,
			cacheCapacity: identity.status.cache.privateCatalogCapacity,
			reusedPromptTokens: identity.status.cache.reusedPromptTokens,
			mtpAcceptedTokens: identity.status.mtp.acceptedTokens,
		},
	};
}

/** Select and register one authenticated local endpoint. Explicit local and affined sessions fail closed. */
export async function registerActiveApplianceRoute(
	modelRegistry: ApplianceRouteModelRegistry,
	settings: ApplianceRouteSettings,
	agentDir: string,
	options: ApplianceRouteSelectionOptions = {},
	profiles: readonly ApplianceProfile[] = APPLIANCE_PROFILES,
): Promise<ApplianceRouteRegistration | undefined> {
	const affinity = readAffinity(options);
	try {
		const store = new FileApplianceStore(agentDir);
		const state = await store.readState();
		if (!state.active) return undefined;
		const installations = [state.active, ...(state.fleet ?? [])];
		const validated = (await validateInstallations(installations, store, profiles)).filter(candidate =>
			supportsRequest(candidate, options),
		);
		if (validated.length === 0) {
			throw new Error("No compatible local NInfer appliance is configured for this request");
		}
		const observations = await Promise.all(validated.map(candidate => observeEndpoint(candidate, agentDir, options)));
		const placement = options.placement ?? "foreground";
		let selected: EndpointObservation | undefined;
		let reason: ApplianceSelectionReason;
		let fallbackReason: "warm_owner_unavailable" | undefined;
		if (affinity) {
			selected = observations.find(candidate => candidate.identity?.fingerprint === affinity.endpointFingerprint);
			if (selected) {
				reason = "warm_owner";
			} else {
				if (!options.coldLocalFallback) {
					throw new Error(
						"Warm NInfer session owner is unavailable or changed; cold local fallback is disabled",
					);
				}
				selected = selectFresh(observations, placement, options.foregroundReservation ?? true);
				if (!selected) {
					throw new Error("Warm NInfer session owner is unavailable and no cold local fallback is healthy");
				}
				reason = "cold_local_fallback";
				fallbackReason = "warm_owner_unavailable";
			}
		} else {
			selected = selectFresh(observations, placement, options.foregroundReservation ?? true);
			if (!selected) throw new Error("No healthy compatible local NInfer appliance is available");
			reason = placement === "foreground" ? "foreground_preference" : "background_preference";
		}
		registerSelected(modelRegistry, settings, selected);
		return registrationReceipt(selected, placement, reason, fallbackReason);
	} catch (error) {
		if (!options.allowUnavailable || options.requestedAlias || affinity) throw error;
		options.onUnavailable?.(error);
		return undefined;
	}
}
