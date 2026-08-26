export const APPLIANCE_STATE_SCHEMA_VERSION = 1 as const;
export const APPLIANCE_RECEIPT_SCHEMA_VERSION = 1 as const;

export type ApplianceProfileId = "rtx5090-linux" | "rtx4090-windows";
export type ApplianceGpuSelector = "auto" | "rtx5090" | "rtx4090";
export type ApplianceAction = "doctor" | "plan" | "install" | "status" | "benchmark" | "rollback" | "support-bundle";
export type ApplianceCapability =
	| "tools"
	| "reasoning"
	| "thinking-history"
	| "stateful-responses"
	| "vision"
	| "durable-checkpoint";

export interface ApplianceAsset {
	kind: "runtime" | "model";
	url: string;
	sha256: string;
	bytes?: number;
	signatureUrl?: string;
}

export interface ApplianceLaunchDescriptor {
	executable: "runtime";
	args: string[];
	secretEnvironmentVariable: string;
}

export interface ApplianceAvailability {
	installable: boolean;
	channel: "released" | "beta";
	blockers: string[];
	qualificationReceipt?: { url: string; sha256: string };
}

export interface ApplianceProfile {
	id: "qwen3.8-27b";
	profile: ApplianceProfileId;
	runtime: "ninfer" | "ninfer-4090";
	architecture: "sm_120a" | "sm_89";
	minVramGiB: number;
	artifactSha256: string;
	contextWindow: 131072;
	maxTokens: 32768;
	kvDtype: "bf16" | "rk2v4-e8";
	speculation: "mtp3" | "none";
	concurrency: 1;
	protocol: "openai-responses";
	capabilities: ApplianceCapability[];
	release?: "v0.1.0-qwen38-5090";
	servedModel: "q38-ninfer";
	aliases: string[];
	defaultPort: number;
	availability: ApplianceAvailability;
	assets?: { runtime: ApplianceAsset; model: ApplianceAsset };
	launch?: ApplianceLaunchDescriptor;
}

export interface ApplianceGpu {
	model: string;
	uuidHash?: string;
	vramGiB: number;
	computeCapability?: string;
}

export interface ApplianceHostFacts {
	os: NodeJS.Platform;
	architecture: string;
	totalRamGiB: number;
	freeRamGiB: number;
	freeDiskGiB?: number;
	gpus: ApplianceGpu[];
	nvidiaDriver?: string;
	cudaVersion?: string;
	dockerAvailable: boolean;
	nvidiaContainerRuntimeAvailable: boolean;
	windowsRuntimeAvailable: boolean;
	secretStorageAvailable: boolean;
}

export interface ApplianceRoute {
	provider: "ninfer-appliance";
	baseUrl: string;
	port: number;
	servedModel: "q38-ninfer";
	profile: ApplianceProfileId;
	release?: string;
	aliases: string[];
	secretRef: string;
}

export interface ApplianceInstallation {
	installationId: string;
	profile: ApplianceProfileId;
	release?: string;
	artifactSha256: string;
	runtimeSha256: string;
	modelSha256: string;
	candidateId: string;
	candidateHandle: string;
	route: ApplianceRoute;
	installedAt: string;
}

export interface ApplianceState {
	schemaVersion: typeof APPLIANCE_STATE_SCHEMA_VERSION;
	revision: number;
	active?: ApplianceInstallation;
	rollbackTarget?: ApplianceInstallation;
	lastInstallReceiptId?: string;
	lastRollbackReceiptId?: string;
}

export interface ApplianceBenchmarkCase {
	name: "protocol-tool" | "short-decode" | "long-prefill-reuse";
	ok: boolean;
	durationMs: number;
	oracleSha256: string;
	detail?: string;
}

export interface ApplianceQuickQualification {
	ok: boolean;
	cases: ApplianceBenchmarkCase[];
	metrics?: {
		coldTtftMs: number;
		warmTtftMs: number;
		prefixReusePercent: number;
		decodeTokensPerSecond: number;
	};
}

export interface ApplianceCandidate {
	candidateId: string;
	handle: string;
	endpoint: string;
	port: number;
}
export interface ApplianceEndpointStatus {
	schemaVersion?: number;
	deploymentProfile?: string;
	servedModel?: string;
	sessionsResident?: number;
	queueDepth?: number;
	cacheUtilization?: number;
	mtpDepth?: number;
	powerProfile?: string;
}

export interface AppliancePlan {
	profile?: ApplianceProfile;
	supported: boolean;
	installable: boolean;
	blockers: string[];
	port: number;
	priorProfile?: ApplianceProfileId;
	rollbackAvailable: boolean;
	expectedVramGiB?: number;
	expectedDiskGiB?: number;
	commands: string[];
}

export interface ApplianceReceipt<T extends Record<string, unknown> = Record<string, unknown>> {
	schemaVersion: typeof APPLIANCE_RECEIPT_SCHEMA_VERSION;
	receiptId: string;
	action: ApplianceAction;
	status: "ok" | "blocked" | "failed" | "rolled-back";
	timestamp: string;
	details: T;
}

export interface ApplianceLogger {
	event(name: string, fields?: Record<string, string | number | boolean | undefined>): void;
}

export interface ApplianceStore {
	readState(): Promise<ApplianceState>;
	writeState(next: ApplianceState, expectedRevision: number): Promise<void>;
	writeReceipt(receipt: ApplianceReceipt): Promise<string>;
	createSecret(installationId: string): Promise<string>;
	readSecret(secretRef: string): Promise<string>;
	removeSecret(secretRef: string): Promise<void>;
	withInstallLock<T>(run: () => Promise<T>): Promise<T>;
}

export interface AppliancePlatform {
	inspectHost(): Promise<ApplianceHostFacts>;
	isPortOccupied(port: number): Promise<boolean>;
	artifactPresent(asset: ApplianceAsset): Promise<boolean>;
	acquireArtifact(asset: ApplianceAsset): Promise<string>;
	removeArtifact(ref: string): Promise<void>;
	createCandidate(input: {
		profile: ApplianceProfile;
		runtimeRef: string;
		modelRef: string;
		secret: string;
		port: number;
		installationId: string;
	}): Promise<ApplianceCandidate>;
	startCandidate(candidate: ApplianceCandidate): Promise<void>;
	stopCandidate(candidateHandle: string): Promise<void>;
	startInstallation(installation: ApplianceInstallation, secret: string): Promise<void>;
	probeHealth(candidate: ApplianceCandidate | ApplianceInstallation, secret: string): Promise<void>;
	probeProtocol(candidate: ApplianceCandidate | ApplianceInstallation, secret: string): Promise<void>;
	quickQualification(
		candidate: ApplianceCandidate | ApplianceInstallation,
		secret: string,
	): Promise<ApplianceQuickQualification>;
	probeRoutedRequest(installation: ApplianceInstallation, secret: string): Promise<void>;
	readEndpointStatus(installation: ApplianceInstallation, secret: string): Promise<ApplianceEndpointStatus>;
}
