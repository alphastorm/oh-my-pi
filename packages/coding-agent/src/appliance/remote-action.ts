import type { NInferCheckpointOperation } from "@oh-my-pi/pi-ai/providers/ninfer";
import { CliUsageError } from "@oh-my-pi/pi-utils/cli";
import type { CompatibilityAuthority } from "./compatibility-authority";
import {
	type RemoteApplianceExecuteOptions,
	SshApplianceExecutor,
	type SshApplianceExecutorOptions,
} from "./remote-executor";
import type { ApplianceAction, ApplianceGpuSelector, ApplianceProfile, ApplianceReceipt } from "./types";

type RemoteReceiptExecutor = Pick<SshApplianceExecutor, "execute">;
export type RemoteReceiptExecutorFactory = (options: SshApplianceExecutorOptions) => RemoteReceiptExecutor;

export interface RemoteApplianceActionFlags {
	remote?: string;
	remoteWsl?: string;
	port?: number;
	model?: string;
	gpu?: ApplianceGpuSelector;
	quick?: boolean;
	checkpointOperation?: NInferCheckpointOperation;
	sessionSha256?: string;
	authority?: CompatibilityAuthority;
	selectedProfile?: ApplianceProfile;
}

export async function executeRemoteApplianceAction(
	action: ApplianceAction,
	flags: RemoteApplianceActionFlags,
	executorFactory: RemoteReceiptExecutorFactory = options => new SshApplianceExecutor(options),
): Promise<ApplianceReceipt | undefined> {
	const remotePresent = flags.remote !== undefined;
	const wslPresent = flags.remoteWsl !== undefined;
	if (remotePresent && flags.remote!.trim().length === 0) {
		throw new CliUsageError("--remote must not be blank");
	}
	if (wslPresent && flags.remoteWsl!.trim().length === 0) {
		throw new CliUsageError("--remote-wsl must not be blank");
	}
	if (wslPresent && !remotePresent) throw new CliUsageError("--remote-wsl requires --remote");
	if (!remotePresent) {
		if (flags.selectedProfile?.adapter === "darwin-remote-ssh") {
			throw new CliUsageError("darwin-remote-ssh requires --remote");
		}
		return undefined;
	}
	if (flags.selectedProfile && flags.selectedProfile.adapter !== "darwin-remote-ssh") {
		throw new CliUsageError("Remote lifecycle delegation requires the darwin-remote-ssh compatibility profile");
	}
	if (action !== "doctor" && action !== "status" && (!flags.authority || !flags.selectedProfile)) {
		throw new CliUsageError(
			"Remote lifecycle actions require the darwin-remote-ssh profile and exact compatibility authority",
		);
	}
	if (flags.selectedProfile && !flags.selectedProfile.lifecycleCommands?.includes(action)) {
		throw new CliUsageError(`Compatibility profile does not declare appliance ${action}`);
	}
	const options: RemoteApplianceExecuteOptions = {
		...(flags.model === "qwen3.8" ? { model: "qwen3.8" as const } : {}),
		...(flags.gpu ? { gpu: flags.gpu } : {}),
		...(flags.port === undefined ? {} : { port: flags.port }),
		...(flags.quick ? { quick: true as const } : {}),
		...(flags.checkpointOperation ? { checkpointOperation: flags.checkpointOperation } : {}),
		...(flags.sessionSha256 ? { sessionSha256: flags.sessionSha256 } : {}),
		...(flags.authority && flags.selectedProfile
			? {
					compatibility: {
						bytes: flags.authority.bytes,
						sha256: flags.authority.sha256,
						transportProfile: "darwin-remote-ssh" as const,
					},
				}
			: {}),
	};
	return executorFactory({ host: flags.remote!, wslDistribution: flags.remoteWsl }).execute(action, options);
}
