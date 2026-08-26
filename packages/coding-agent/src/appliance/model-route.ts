import type { ProviderConfigInput } from "../config/model-registry";
import { APPLIANCE_PROFILES, installationMatchesProfile } from "./registry";
import { FileApplianceStore } from "./store";
import type { ApplianceProfile, ApplianceRoute } from "./types";

export interface ApplianceRouteModelRegistry {
	registerProvider(providerName: string, config: ProviderConfigInput): void;
}

export interface ApplianceRouteSettings {
	get(path: "modelProviderOrder"): string[];
	override(path: "modelProviderOrder", value: string[]): void;
}
const APPLIANCE_PROVIDER = "ninfer-appliance";

function assertLoopbackRoute(route: ApplianceRoute): void {
	let url: URL;
	try {
		url = new URL(route.baseUrl);
	} catch {
		throw new Error("Active appliance route has an invalid base URL");
	}
	if (!["127.0.0.1", "::1", "[::1]", "localhost"].includes(url.hostname)) {
		throw new Error("Active appliance route is not loopback-bound");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Active appliance route has an unsupported protocol");
	}
	const effectivePort = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
	if (effectivePort !== route.port) throw new Error("Active appliance route port does not match its base URL");
	if (url.username || url.password || url.search || url.hash)
		throw new Error("Active appliance route URL contains forbidden components");
	const apiPath = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
	if (apiPath !== "/v1") throw new Error("Active appliance route must target the /v1 API root");
}

/** Register the atomically promoted appliance route before model selection. */
export async function registerActiveApplianceRoute(
	modelRegistry: ApplianceRouteModelRegistry,
	settings: ApplianceRouteSettings,
	agentDir: string,
	profiles: readonly ApplianceProfile[] = APPLIANCE_PROFILES,
): Promise<boolean> {
	const store = new FileApplianceStore(agentDir);
	const state = await store.readState();
	if (!state.active) return false;
	const { active } = state;
	assertLoopbackRoute(active.route);
	const profile = profiles.find(candidate => candidate.profile === active.profile);
	if (!profile || !installationMatchesProfile(active, profile)) {
		throw new Error("Active appliance route does not match an installable public registry profile");
	}
	if (active.route.provider !== APPLIANCE_PROVIDER) throw new Error("Active appliance route has an invalid provider");
	const secret = await store.readSecret(active.route.secretRef);
	if (!secret) throw new Error("Active appliance route has no authentication secret");
	const statefulResponses = profile.capabilities.includes("stateful-responses");
	const input: ("text" | "image")[] = profile.capabilities.includes("vision") ? ["text", "image"] : ["text"];
	modelRegistry.registerProvider(APPLIANCE_PROVIDER, {
		baseUrl: active.route.baseUrl,
		apiKey: secret,
		api: "openai-responses",
		authHeader: true,
		compat: { ninferStatefulResponses: statefulResponses },
		models: active.route.aliases.map(alias => ({
			id: alias,
			requestModelId: active.route.servedModel,
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
	return true;
}
