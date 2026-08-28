import path from "node:path";
import type { NInferCheckpointOperation } from "@oh-my-pi/pi-ai/providers/ninfer";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { Args, CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { BoundedApplianceExecutor } from "../appliance/bounded-executor";
import { type CompatibilityAuthority, loadCompatibilityAuthority } from "../appliance/compatibility-authority";
import {
	hardenWindowsApplianceRoot,
	LinuxDockerAppliancePlatform,
	WindowsDockerAppliancePlatform,
} from "../appliance/docker-platform";
import { ApplianceLifecycle } from "../appliance/lifecycle";
import { LocalAppliancePlatform } from "../appliance/platform";
import { executeRemoteApplianceAction } from "../appliance/remote-action";
import {
	decodeRemoteApplianceRequest,
	REMOTE_APPLIANCE_AUTHORITY_LIMIT,
	type RemoteDelegatedLocalInvocation,
	remoteDelegationManifest,
	runRemoteApplianceDelegation,
} from "../appliance/remote-protocol";
import { FileApplianceStore } from "../appliance/store";
import type {
	ApplianceAction,
	ApplianceGpuSelector,
	ApplianceProfile,
	ApplianceProfileId,
	ApplianceReceipt,
} from "../appliance/types";
import { applianceHelp as commandHelp } from "../cli/command-help";

const ACTIONS: ApplianceAction[] = [
	"doctor",
	"plan",
	"install",
	"status",
	"benchmark",
	"checkpoint",
	"rollback",
	"support-bundle",
];
const GPU_SELECTORS: ApplianceGpuSelector[] = ["auto", "rtx5090", "rtx4090"];
const CHECKPOINT_OPERATIONS: NInferCheckpointOperation[] = ["save", "status", "delete"];
const PROFILE_IDS: ApplianceProfileId[] = [
	"rtx5090-linux",
	"rtx4090-windows",
	"darwin-remote-ssh",
	"windows-docker-local",
	"linux-docker-local",
];

function isApplianceAction(value: string | undefined): value is ApplianceAction {
	return value !== undefined && ACTIONS.some(action => action === value);
}

function isGpuSelector(value: string | undefined): value is ApplianceGpuSelector {
	return value !== undefined && GPU_SELECTORS.some(selector => selector === value);
}

function isCheckpointOperation(value: string | undefined): value is NInferCheckpointOperation {
	return value !== undefined && CHECKPOINT_OPERATIONS.some(operation => operation === value);
}

function isProfileId(value: string | undefined): value is ApplianceProfileId {
	return value !== undefined && PROFILE_IDS.some(profile => profile === value);
}

function writeReceipt(receipt: ApplianceReceipt, json: boolean): void {
	if (!json) {
		process.stdout.write(`Appliance ${receipt.action}: ${receipt.status}\n`);
		const blockers = receipt.details.blockers;
		if (Array.isArray(blockers)) {
			for (const blocker of blockers) {
				if (typeof blocker === "string") process.stdout.write(`- ${blocker}\n`);
			}
		}
		if (typeof receipt.details.blocker === "string") process.stdout.write(`- ${receipt.details.blocker}\n`);
		process.stdout.write("Receipt: ");
	}
	process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

async function readDelegatedAuthorityBytes(): Promise<Uint8Array> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of process.stdin) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.byteLength;
		if (bytes > REMOTE_APPLIANCE_AUTHORITY_LIMIT) {
			throw new CliUsageError("Remote compatibility authority exceeds the 64 KiB staging limit");
		}
		chunks.push(buffer);
	}
	return Buffer.concat(chunks, bytes);
}

interface LocalApplianceInvocation {
	action: ApplianceAction;
	model?: string;
	gpu: ApplianceGpuSelector;
	port?: number;
	quick?: boolean;
	checkpointOperation?: NInferCheckpointOperation;
	sessionSha256?: string;
	checkpointProfile?: ApplianceProfileId;
	delegatedWslDistribution?: string;
}

async function executeLocalApplianceInvocation(
	invocation: LocalApplianceInvocation,
	authority?: CompatibilityAuthority,
	selectedProfile?: ApplianceProfile,
): Promise<ApplianceReceipt> {
	const agentDir = getAgentDir();
	const executor = new BoundedApplianceExecutor();
	let store: FileApplianceStore;
	let platform: LocalAppliancePlatform | WindowsDockerAppliancePlatform | LinuxDockerAppliancePlatform;
	if (selectedProfile?.adapter === "windows-docker-local") {
		const localAppData = process.env.LOCALAPPDATA;
		if (!localAppData) throw new CliUsageError("LOCALAPPDATA is unavailable for windows-docker-local");
		const root = path.win32.join(localAppData, "OMP", "appliance");
		store = new FileApplianceStore(agentDir, {
			root,
			beforeWrite: value => hardenWindowsApplianceRoot(value, executor),
		});
		platform = new WindowsDockerAppliancePlatform({
			agentDir,
			profile: selectedProfile,
			runner: command => executor.run(command),
			root: path.win32.join(root, selectedProfile.profile),
		});
	} else if (selectedProfile?.adapter === "linux-docker-local") {
		store = new FileApplianceStore(agentDir);
		platform = new LinuxDockerAppliancePlatform({
			agentDir,
			profile: selectedProfile,
			runner: command => executor.run(command),
			...(invocation.delegatedWslDistribution
				? { delegatedWslDistribution: invocation.delegatedWslDistribution }
				: {}),
		});
	} else {
		store = new FileApplianceStore(agentDir);
		platform = new LocalAppliancePlatform(agentDir);
	}
	const lifecycle = new ApplianceLifecycle({
		store,
		platform,
		profiles: authority?.profiles,
		selectedProfileId: selectedProfile?.profile,
	});
	let receipt: ApplianceReceipt;
	switch (invocation.action) {
		case "doctor":
			receipt = await lifecycle.doctor(invocation.port ?? selectedProfile?.defaultPort);
			break;
		case "plan":
			receipt = (await lifecycle.plan(invocation.model ?? "qwen3.8", invocation.gpu, invocation.port)).receipt;
			break;
		case "install":
			receipt = await lifecycle.install(invocation.model ?? "qwen3.8", invocation.gpu, invocation.port);
			break;
		case "status":
			receipt = await lifecycle.status();
			break;
		case "benchmark":
			receipt = await lifecycle.benchmark(Boolean(invocation.quick));
			break;
		case "checkpoint":
			receipt = await lifecycle.checkpoint(
				invocation.checkpointOperation!,
				invocation.sessionSha256!,
				invocation.checkpointProfile ?? selectedProfile?.profile,
			);
			break;
		case "rollback":
			receipt = await lifecycle.rollback();
			break;
		case "support-bundle":
			receipt = await lifecycle.supportBundle();
			break;
	}
	if (authority && selectedProfile) {
		receipt.details = {
			...receipt.details,
			compatibilityAuthority: authority.authorityId,
			compatibilitySha256: authority.sha256,
			profile: receipt.details.profile ?? selectedProfile.profile,
			supportStatus: selectedProfile.supportStatus,
			...(invocation.action === "status" ? { ready: false } : {}),
		};
	}
	return receipt;
}

function delegatedInvocation(value: RemoteDelegatedLocalInvocation): LocalApplianceInvocation {
	return {
		action: value.action,
		model: value.model,
		gpu: value.gpu ?? "auto",
		port: value.port,
		quick: value.quick,
		checkpointOperation: value.checkpointOperation,
		sessionSha256: value.sessionSha256,
		checkpointProfile: value.selectedProfile?.profile,
		delegatedWslDistribution: value.delegatedWslDistribution,
	};
}

export default class Appliance extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({ description: "Appliance action", required: true, options: ACTIONS }),
		model: Args.string({
			description: "Model family (plan/install) or checkpoint operation (save/status/delete)",
			required: false,
		}),
	};

	static flags = {
		gpu: Flags.string({ description: "GPU profile selector", options: GPU_SELECTORS, default: "auto" }),
		port: Flags.integer({ description: "Candidate loopback port" }),
		quick: Flags.boolean({ description: "Run the bounded quick qualification" }),
		json: Flags.boolean({ description: "Emit only the machine-readable receipt" }),
		"session-sha256": Flags.string({ description: "Lowercase SHA-256 of the OMP session identity" }),
		profile: Flags.string({ description: "Compatibility or installed appliance profile", options: PROFILE_IDS }),
		remote: Flags.string({ description: "SSH host or alias for exact remote lifecycle delegation" }),
		"remote-wsl": Flags.string({ description: "WSL distribution on the remote Windows host" }),
		compatibility: Flags.string({ description: "Exact trusted omp-ninfer compatibility.json authority" }),
		"compatibility-sha256": Flags.string({ description: "Pinned SHA-256 of compatibility.json" }),
		"delegation-manifest": Flags.boolean({
			description: "Emit the internal remote delegation identity",
			hidden: true,
		}),
		"delegation-payload": Flags.string({
			description: "Execute one internal remote delegation request",
			hidden: true,
		}),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Appliance);
		const action = args.action;
		if (!isApplianceAction(action)) throw new CliUsageError("Unknown appliance action");
		if (flags["delegation-manifest"]) {
			if (
				action !== "status" ||
				!flags.json ||
				flags["delegation-payload"] !== undefined ||
				args.model !== undefined ||
				flags.remote !== undefined ||
				flags["remote-wsl"] !== undefined ||
				flags.compatibility !== undefined ||
				flags["compatibility-sha256"] !== undefined ||
				flags.profile !== undefined ||
				flags.port !== undefined ||
				flags.quick ||
				flags["session-sha256"] !== undefined
			) {
				throw new CliUsageError("Invalid appliance delegation identity invocation");
			}
			process.stdout.write(`${JSON.stringify(remoteDelegationManifest())}\n`);
			return;
		}
		if (flags["delegation-payload"] !== undefined) {
			if (
				!flags.json ||
				args.model !== undefined ||
				flags.remote !== undefined ||
				flags["remote-wsl"] !== undefined ||
				flags.compatibility !== undefined ||
				flags["compatibility-sha256"] !== undefined ||
				flags.profile !== undefined ||
				flags.port !== undefined ||
				flags.quick ||
				flags["session-sha256"] !== undefined
			) {
				throw new CliUsageError("Invalid appliance delegation action invocation");
			}
			const authorityBytes = await readDelegatedAuthorityBytes();
			const request = decodeRemoteApplianceRequest(flags["delegation-payload"], action, authorityBytes);
			const receipt = await runRemoteApplianceDelegation(request, {
				invoke: value =>
					executeLocalApplianceInvocation(delegatedInvocation(value), value.authority, value.selectedProfile),
			});
			writeReceipt(receipt, true);
			if (
				receipt.status === "failed" ||
				(receipt.status === "blocked" && action !== "doctor" && action !== "plan")
			) {
				process.exitCode = 1;
			}
			return;
		}

		const gpu = flags.gpu;
		if (!isGpuSelector(gpu)) throw new CliUsageError("Unknown appliance GPU selector");
		if (flags.profile !== undefined && !isProfileId(flags.profile))
			throw new CliUsageError("Unknown appliance profile");
		if (flags["remote-wsl"] !== undefined && flags.remote === undefined)
			throw new CliUsageError("--remote-wsl requires --remote");
		if (flags.port !== undefined && (flags.port < 1 || flags.port > 65535)) {
			throw new CliUsageError("--port must be between 1 and 65535");
		}
		if ((action === "plan" || action === "install") && args.model !== "qwen3.8") {
			throw new CliUsageError(`${action} requires model qwen3.8`);
		}
		if (action === "benchmark" && !flags.quick) throw new CliUsageError("appliance benchmark requires --quick");
		if (action === "checkpoint") {
			if (!isCheckpointOperation(args.model)) {
				throw new CliUsageError("appliance checkpoint requires save, status, or delete");
			}
			if (!flags["session-sha256"] || !/^[0-9a-f]{64}$/.test(flags["session-sha256"])) {
				throw new CliUsageError("appliance checkpoint requires --session-sha256 with a lowercase SHA-256");
			}
		} else if (!["plan", "install"].includes(action) && args.model) {
			throw new CliUsageError(`${action} does not accept a model argument`);
		}
		const compatibilityPresent = flags.compatibility !== undefined || flags["compatibility-sha256"] !== undefined;
		if (compatibilityPresent && (!flags.compatibility || !flags["compatibility-sha256"] || !flags.profile)) {
			throw new CliUsageError(
				"Compatibility profiles require --compatibility, --compatibility-sha256, and --profile",
			);
		}
		if (
			!compatibilityPresent &&
			["darwin-remote-ssh", "windows-docker-local", "linux-docker-local"].includes(flags.profile ?? "")
		) {
			throw new CliUsageError("Managed compatibility profiles require an exact compatibility authority");
		}
		const authority = compatibilityPresent
			? await loadCompatibilityAuthority(flags.compatibility!, flags["compatibility-sha256"]!)
			: undefined;
		const selectedProfile = authority?.profiles.find(candidate => candidate.profile === flags.profile);
		if (authority && !selectedProfile)
			throw new CliUsageError("Requested profile is absent from the compatibility authority");
		if (selectedProfile && !selectedProfile.lifecycleCommands?.includes(action)) {
			throw new CliUsageError(`Compatibility profile does not declare appliance ${action}`);
		}
		const remoteReceipt = await executeRemoteApplianceAction(action, {
			remote: flags.remote,
			remoteWsl: flags["remote-wsl"],
			port: flags.port,
			model: args.model,
			gpu,
			quick: flags.quick,
			checkpointOperation: action === "checkpoint" ? (args.model as NInferCheckpointOperation) : undefined,
			sessionSha256: flags["session-sha256"],
			authority,
			selectedProfile,
		});
		if (remoteReceipt) {
			writeReceipt(remoteReceipt, action === "support-bundle" || Boolean(flags.json));
			if (
				remoteReceipt.status === "failed" ||
				(remoteReceipt.status === "blocked" && action !== "doctor" && action !== "plan")
			) {
				process.exitCode = 1;
			}
			return;
		}
		const receipt = await executeLocalApplianceInvocation(
			{
				action,
				model: args.model,
				gpu,
				port: flags.port,
				quick: flags.quick,
				checkpointOperation: action === "checkpoint" ? (args.model as NInferCheckpointOperation) : undefined,
				sessionSha256: flags["session-sha256"],
				checkpointProfile: flags.profile as ApplianceProfileId | undefined,
			},
			authority,
			selectedProfile,
		);
		writeReceipt(receipt, action === "support-bundle" || Boolean(flags.json));
		if (receipt.status === "failed" || (receipt.status === "blocked" && action !== "doctor" && action !== "plan")) {
			process.exitCode = 1;
		}
	}
}
