import { getAgentDir } from "@oh-my-pi/pi-utils";
import { Args, CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { ApplianceLifecycle } from "../appliance/lifecycle";
import { LocalAppliancePlatform } from "../appliance/platform";
import { FileApplianceStore } from "../appliance/store";
import type { ApplianceAction, ApplianceGpuSelector, ApplianceReceipt } from "../appliance/types";
import { applianceHelp as commandHelp } from "../cli/command-help";

const ACTIONS: ApplianceAction[] = ["doctor", "plan", "install", "status", "benchmark", "rollback", "support-bundle"];
const GPU_SELECTORS: ApplianceGpuSelector[] = ["auto", "rtx5090", "rtx4090"];
function isApplianceAction(value: string | undefined): value is ApplianceAction {
	return value !== undefined && ACTIONS.some(action => action === value);
}

function isGpuSelector(value: string | undefined): value is ApplianceGpuSelector {
	return value !== undefined && GPU_SELECTORS.some(selector => selector === value);
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

export default class Appliance extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({ description: "Appliance action", required: true, options: ACTIONS }),
		model: Args.string({ description: "Model family (qwen3.8 for plan/install)", required: false }),
	};

	static flags = {
		gpu: Flags.string({ description: "GPU profile selector", options: GPU_SELECTORS, default: "auto" }),
		port: Flags.integer({ description: "Candidate loopback port" }),
		quick: Flags.boolean({ description: "Run the bounded quick qualification" }),
		json: Flags.boolean({ description: "Emit only the machine-readable receipt" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Appliance);
		const action = args.action;
		const gpu = flags.gpu;
		if (!isApplianceAction(action)) throw new CliUsageError("Unknown appliance action");
		if (!isGpuSelector(gpu)) throw new CliUsageError("Unknown appliance GPU selector");
		if (flags.port !== undefined && (flags.port < 1 || flags.port > 65535)) {
			throw new CliUsageError("--port must be between 1 and 65535");
		}
		if ((action === "plan" || action === "install") && args.model !== "qwen3.8") {
			throw new CliUsageError(`${action} requires model qwen3.8`);
		}
		if (action === "benchmark" && !flags.quick) {
			throw new CliUsageError("appliance benchmark requires --quick");
		}
		if (!["plan", "install"].includes(action) && args.model) {
			throw new CliUsageError(`${action} does not accept a model argument`);
		}
		const agentDir = getAgentDir();
		const lifecycle = new ApplianceLifecycle({
			store: new FileApplianceStore(agentDir),
			platform: new LocalAppliancePlatform(agentDir),
		});
		let receipt: ApplianceReceipt;
		switch (action) {
			case "doctor":
				receipt = await lifecycle.doctor(flags.port);
				break;
			case "plan":
				receipt = (await lifecycle.plan(args.model ?? "qwen3.8", gpu, flags.port)).receipt;
				break;
			case "install":
				receipt = await lifecycle.install(args.model ?? "qwen3.8", gpu, flags.port);
				break;
			case "status":
				receipt = await lifecycle.status();
				break;
			case "benchmark":
				receipt = await lifecycle.benchmark(Boolean(flags.quick));
				break;
			case "rollback":
				receipt = await lifecycle.rollback();
				break;
			case "support-bundle":
				receipt = await lifecycle.supportBundle();
				break;
		}
		writeReceipt(receipt, action === "support-bundle" || Boolean(flags.json));
		if (receipt.status === "failed" || (receipt.status === "blocked" && action !== "doctor" && action !== "plan")) {
			process.exitCode = 1;
		}
	}
}
