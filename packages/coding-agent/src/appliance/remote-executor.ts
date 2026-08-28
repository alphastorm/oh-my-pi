import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import {
	BoundedApplianceExecutor,
	type BoundedCommandResult,
	type BoundedCommandRunner,
	runBoundedCommand,
} from "./bounded-executor";
import {
	encodeRemoteApplianceRequest,
	parseRemoteApplianceReceipt,
	parseRemoteDelegationManifest,
	REMOTE_APPLIANCE_BUILD_ID,
	type RemoteApplianceCompatibility,
	type RemoteApplianceInvocation,
	type RemoteDelegationMetadata,
	remoteActionMayPersist,
} from "./remote-protocol";
import type { ApplianceAction, ApplianceReceipt } from "./types";

const REMOTE_HOST = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WSL_DISTRIBUTION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REMOTE_COMMAND_TOKEN = /^[A-Za-z0-9._=/-]+$/u;
const REMOTE_IDENTITY_TIMEOUT_MS = 20_000;
const REMOTE_LIFECYCLE_TIMEOUT_MS = 30 * 60_000;
const REMOTE_LOCAL_PROFILES = new Set(["linux-docker-local", "windows-docker-local"]);
const REMOTE_CLEANUP_STATES = new Set(["ok", "failed", "not-created"]);
const REMOTE_EFFECT_STATES = new Set(["none", "confirmed", "uncertain"]);
const REMOTE_FAILURE_CODES = new Set([
	"REMOTE_BOOTSTRAP_CLEANUP_FAILED",
	"REMOTE_COMPATIBILITY_HASH_MISMATCH",
	"REMOTE_COMPATIBILITY_PROFILE_MISMATCH",
	"REMOTE_DELEGATED_ACTION_FAILED",
	"REMOTE_LOCAL_PROFILE_UNAVAILABLE",
	"REMOTE_RECEIPT_PRIVACY_REJECTED",
	"REMOTE_STAGING_FAILED",
	"REMOTE_WSL_CONTEXT_MISMATCH",
]);
const REMOTE_PRE_LOCAL_PROFILE_FAILURES = new Set([
	"REMOTE_COMPATIBILITY_HASH_MISMATCH",
	"REMOTE_COMPATIBILITY_PROFILE_MISMATCH",
	"REMOTE_LOCAL_PROFILE_UNAVAILABLE",
	"REMOTE_STAGING_FAILED",
	"REMOTE_WSL_CONTEXT_MISMATCH",
]);
const REMOTE_METADATA_KEYS = new Set([
	"schemaVersion",
	"version",
	"buildIdentity",
	"compatibilitySha256",
	"transportProfile",
	"localProfile",
	"cleanup",
	"effect",
	"failureCode",
]);
const SHA256 = /^[a-f0-9]{64}$/u;

export function validateRemoteHost(value: string): string {
	if (/[\u0000-\u001f\u007f]/u.test(value)) throw new Error("Remote appliance host contains control characters");
	const host = value.trim();
	if (!REMOTE_HOST.test(host)) throw new Error("Remote appliance host must be an SSH hostname or alias");
	return host;
}

export function validateWslDistribution(value: string | undefined): string | undefined {
	if (value !== undefined && /[\u0000-\u001f\u007f]/u.test(value))
		throw new Error("Remote WSL distribution contains control characters");
	const distribution = value?.trim();
	if (distribution && !WSL_DISTRIBUTION.test(distribution))
		throw new Error("Remote WSL distribution has invalid characters");
	return distribution || undefined;
}

export type RemoteApplianceAction = ApplianceAction;
export type RemoteCommandResult = BoundedCommandResult;
export type RemoteCommandRunner = BoundedCommandRunner;
export const runRemoteCommand = runBoundedCommand;

export type RemoteApplianceErrorCode =
	| "REMOTE_ACTION_TIMEOUT"
	| "REMOTE_BUILD_IDENTITY_MISMATCH"
	| "REMOTE_BUILD_IDENTITY_UNAVAILABLE"
	| "REMOTE_CLIENT_TIMEOUT"
	| "REMOTE_CLIENT_UNAVAILABLE"
	| "REMOTE_EFFECT_UNCERTAIN"
	| "REMOTE_RECEIPT_MALFORMED"
	| "REMOTE_RECEIPT_OVERSIZE"
	| "REMOTE_TIMEOUT_UNCERTAIN_EFFECT"
	| "REMOTE_VERSION_MISMATCH";

export class RemoteApplianceError extends Error {
	constructor(
		readonly code: RemoteApplianceErrorCode,
		message: string,
		readonly effect: "none" | "uncertain",
	) {
		super(`${code}: ${message}`);
		this.name = "RemoteApplianceError";
	}
}

export interface SshApplianceExecutorOptions {
	host: string;
	wslDistribution?: string;
	timeoutMs?: number;
	runner?: BoundedCommandRunner;
	expectedVersion?: string;
}

export type RemoteApplianceExecuteOptions = Omit<RemoteApplianceInvocation, "action"> & {
	compatibility?: RemoteApplianceCompatibility;
};

function remoteMetadata(receipt: ApplianceReceipt): RemoteDelegationMetadata {
	const value = receipt.details.remoteDelegation;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Remote appliance receipt lacks delegation metadata");
	}
	const metadata = value as Record<string, unknown>;
	if (
		Object.keys(metadata).some(key => !REMOTE_METADATA_KEYS.has(key)) ||
		metadata.schemaVersion !== 1 ||
		typeof metadata.version !== "string" ||
		typeof metadata.buildIdentity !== "string" ||
		(metadata.compatibilitySha256 !== null &&
			(typeof metadata.compatibilitySha256 !== "string" || !SHA256.test(metadata.compatibilitySha256))) ||
		(metadata.transportProfile !== null && metadata.transportProfile !== "darwin-remote-ssh") ||
		(metadata.localProfile !== null &&
			(typeof metadata.localProfile !== "string" || !REMOTE_LOCAL_PROFILES.has(metadata.localProfile))) ||
		typeof metadata.cleanup !== "string" ||
		!REMOTE_CLEANUP_STATES.has(metadata.cleanup) ||
		typeof metadata.effect !== "string" ||
		!REMOTE_EFFECT_STATES.has(metadata.effect) ||
		(metadata.failureCode !== undefined &&
			(typeof metadata.failureCode !== "string" || !REMOTE_FAILURE_CODES.has(metadata.failureCode)))
	) {
		throw new Error("Remote appliance delegation metadata contract mismatch");
	}
	return metadata as RemoteDelegationMetadata;
}

export class SshApplianceExecutor {
	readonly #host: string;
	readonly #wslDistribution?: string;
	readonly #identityExecutor: BoundedApplianceExecutor;
	readonly #actionExecutor: BoundedApplianceExecutor;
	readonly #expectedVersion: string;

	constructor(options: SshApplianceExecutorOptions) {
		this.#host = validateRemoteHost(options.host);
		this.#wslDistribution = validateWslDistribution(options.wslDistribution);
		if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)) {
			throw new Error("Remote appliance timeout must be a positive integer");
		}
		this.#identityExecutor = new BoundedApplianceExecutor({
			runner: options.runner,
			timeoutMs: options.timeoutMs ?? REMOTE_IDENTITY_TIMEOUT_MS,
		});
		this.#actionExecutor = new BoundedApplianceExecutor({
			runner: options.runner,
			timeoutMs: options.timeoutMs ?? REMOTE_LIFECYCLE_TIMEOUT_MS,
		});
		this.#expectedVersion = options.expectedVersion ?? VERSION;
	}

	#command(remoteArgv: readonly string[]): string[] {
		if (remoteArgv.some(value => !REMOTE_COMMAND_TOKEN.test(value))) {
			throw new Error("Remote appliance command contains a non-canonical token");
		}
		const remote = this.#wslDistribution
			? ["wsl.exe", "-d", this.#wslDistribution, "--exec", ...remoteArgv]
			: [...remoteArgv];
		if (remote.some(value => !REMOTE_COMMAND_TOKEN.test(value))) {
			throw new Error("Remote appliance command contains a non-canonical token");
		}
		return [
			"/usr/bin/ssh",
			"-T",
			"-o",
			"BatchMode=yes",
			"-o",
			"ConnectTimeout=10",
			"-o",
			"ClearAllForwardings=yes",
			"-o",
			"ForwardAgent=no",
			"-o",
			"ForwardX11=no",
			this.#host,
			remote.join(" "),
		];
	}

	async #run(
		command: readonly string[],
		phase: "identity" | "action",
		uncertain: boolean,
		stdin?: Uint8Array,
	): Promise<BoundedCommandResult> {
		try {
			return await (phase === "identity" ? this.#identityExecutor : this.#actionExecutor).run(command, stdin);
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			if (message === "Appliance command timed out") {
				if (phase === "action" && uncertain) {
					throw new RemoteApplianceError(
						"REMOTE_TIMEOUT_UNCERTAIN_EFFECT",
						"the remote mutating action timed out; its effect is uncertain and it must not be retried blindly",
						"uncertain",
					);
				}
				throw new RemoteApplianceError(
					phase === "identity" ? "REMOTE_CLIENT_TIMEOUT" : "REMOTE_ACTION_TIMEOUT",
					phase === "identity"
						? "the exact remote OMP client did not answer in time"
						: "the remote non-mutating action timed out",
					"none",
				);
			}
			if (message === "Appliance command exceeded the output limit") {
				throw new RemoteApplianceError(
					phase === "action" ? "REMOTE_RECEIPT_OVERSIZE" : "REMOTE_BUILD_IDENTITY_UNAVAILABLE",
					phase === "action"
						? uncertain
							? "the remote mutating action exceeded the receipt bound; its effect is uncertain and it must not be retried blindly"
							: "the remote action exceeded the receipt bound"
						: "the remote OMP identity response exceeded its bound",
					uncertain ? "uncertain" : "none",
				);
			}
			throw new RemoteApplianceError(
				phase === "action" && uncertain ? "REMOTE_EFFECT_UNCERTAIN" : "REMOTE_CLIENT_UNAVAILABLE",
				phase === "action" && uncertain
					? "the SSH action ended without a receipt; its effect is uncertain and it must not be retried blindly"
					: "the exact remote OMP client is unavailable",
				phase === "action" && uncertain ? "uncertain" : "none",
			);
		}
	}

	async execute(action: ApplianceAction, options: RemoteApplianceExecuteOptions = {}): Promise<ApplianceReceipt> {
		const identity = await this.#run(
			this.#command(["omp", "appliance", "status", "--delegation-manifest", "--json"]),
			"identity",
			false,
		);
		if (identity.code !== 0) {
			throw new RemoteApplianceError(
				"REMOTE_CLIENT_UNAVAILABLE",
				"the remote host did not expose the required OMP appliance delegation client",
				"none",
			);
		}
		let manifest: ReturnType<typeof parseRemoteDelegationManifest>;
		try {
			manifest = parseRemoteDelegationManifest(identity.stdout);
		} catch {
			throw new RemoteApplianceError(
				"REMOTE_BUILD_IDENTITY_UNAVAILABLE",
				"the remote OMP client returned an invalid build identity manifest",
				"none",
			);
		}
		if (manifest.version !== this.#expectedVersion) {
			throw new RemoteApplianceError(
				"REMOTE_VERSION_MISMATCH",
				`remote OMP version ${manifest.version} does not equal required version ${this.#expectedVersion}`,
				"none",
			);
		}
		if (manifest.buildIdentity !== REMOTE_APPLIANCE_BUILD_ID) {
			throw new RemoteApplianceError(
				"REMOTE_BUILD_IDENTITY_MISMATCH",
				"the remote OMP appliance build identity does not match this client",
				"none",
			);
		}

		const { compatibility, ...invocationOptions } = options;
		const invocation: RemoteApplianceInvocation = { action, ...invocationOptions };
		const payload = encodeRemoteApplianceRequest(
			invocation,
			compatibility,
			compatibility ? this.#wslDistribution : undefined,
		);
		const isEffectful = remoteActionMayPersist(action);
		const result = await this.#run(
			this.#command(["omp", "appliance", action, "--delegation-payload", payload, "--json"]),
			"action",
			isEffectful,
			compatibility?.bytes,
		);
		let receipt: ApplianceReceipt;
		try {
			receipt = parseRemoteApplianceReceipt(result.stdout, action);
		} catch (error) {
			const oversized = error instanceof Error && error.message.includes("oversized");
			throw new RemoteApplianceError(
				oversized ? "REMOTE_RECEIPT_OVERSIZE" : "REMOTE_RECEIPT_MALFORMED",
				isEffectful
					? "the remote mutating action returned no trustworthy receipt; its effect is uncertain and it must not be retried blindly"
					: oversized
						? "the remote appliance receipt exceeded its bound"
						: "the remote appliance receipt was malformed or contained private material",
				isEffectful ? "uncertain" : "none",
			);
		}
		let delegation: RemoteDelegationMetadata;
		try {
			delegation = remoteMetadata(receipt);
			if (
				delegation.schemaVersion !== 1 ||
				delegation.version !== this.#expectedVersion ||
				delegation.buildIdentity !== REMOTE_APPLIANCE_BUILD_ID ||
				delegation.compatibilitySha256 !== (options.compatibility?.sha256 ?? null) ||
				delegation.transportProfile !== (options.compatibility?.transportProfile ?? null)
			) {
				throw new Error("mismatch");
			}
			const preLocalProfileFailure =
				receipt.status === "failed" &&
				delegation.localProfile === null &&
				delegation.effect === "none" &&
				delegation.failureCode !== undefined &&
				REMOTE_PRE_LOCAL_PROFILE_FAILURES.has(delegation.failureCode);
			if (
				(options.compatibility
					? delegation.localProfile === null && !preLocalProfileFailure
					: delegation.localProfile !== null) ||
				(delegation.effect === "uncertain" && receipt.status !== "failed") ||
				(delegation.cleanup === "failed" && delegation.failureCode === undefined) ||
				(delegation.cleanup !== "failed" && delegation.failureCode === "REMOTE_BOOTSTRAP_CLEANUP_FAILED") ||
				(receipt.status !== "failed" && delegation.failureCode !== undefined)
			) {
				throw new Error("state mismatch");
			}
		} catch {
			throw new RemoteApplianceError(
				"REMOTE_RECEIPT_MALFORMED",
				isEffectful
					? "the remote receipt did not bind the delegated authority and build; its effect is uncertain and it must not be retried blindly"
					: "the remote receipt did not bind the delegated authority and build",
				isEffectful ? "uncertain" : "none",
			);
		}
		if (
			result.code !== 0 &&
			receipt.status !== "failed" &&
			receipt.status !== "blocked" &&
			receipt.status !== "rolled-back"
		) {
			throw new RemoteApplianceError(
				"REMOTE_EFFECT_UNCERTAIN",
				"the remote command exit and receipt disagree; the effect is uncertain and the action must not be retried blindly",
				isEffectful ? "uncertain" : "none",
			);
		}
		return receipt;
	}
}
