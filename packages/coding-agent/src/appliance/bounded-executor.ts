import { spawn } from "node:child_process";

export const APPLIANCE_COMMAND_OUTPUT_LIMIT = 1024 * 1024;
export const APPLIANCE_COMMAND_TIMEOUT_MS = 120_000;

export interface BoundedCommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type BoundedCommandRunner = (
	command: readonly string[],
	timeoutMs: number,
	stdin?: Uint8Array,
) => Promise<BoundedCommandResult>;

function validateCommand(command: readonly string[]): void {
	if (command.length === 0 || !command[0]?.trim()) throw new Error("Appliance command is empty");
	for (const value of command) {
		if (!value || /[\u0000-\u001f\u007f]/u.test(value)) {
			throw new Error("Appliance command contains a blank or control-character argument");
		}
	}
}

export function runBoundedCommand(
	command: readonly string[],
	timeoutMs = APPLIANCE_COMMAND_TIMEOUT_MS,
	stdin?: Uint8Array,
): Promise<BoundedCommandResult> {
	validateCommand(command);
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Appliance command timeout is invalid");
	const { promise, resolve, reject } = Promise.withResolvers<BoundedCommandResult>();
	const child = spawn(command[0]!, [...command.slice(1)], {
		shell: false,
		stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"] as const,
		windowsHide: true,
	});
	const stdoutChunks: Buffer[] = [];
	const stderrChunks: Buffer[] = [];
	let bytes = 0;
	let settled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const finish = (error?: Error, result?: BoundedCommandResult): void => {
		if (settled) return;
		settled = true;
		if (timer) clearTimeout(timer);
		if (error) reject(error);
		else resolve(result!);
	};
	const append = (target: Buffer[], chunk: Buffer): void => {
		bytes += chunk.length;
		if (bytes > APPLIANCE_COMMAND_OUTPUT_LIMIT) {
			child.kill("SIGTERM");
			finish(new Error("Appliance command exceeded the output limit"));
			return;
		}
		target.push(chunk);
	};
	child.stdout!.on("data", (chunk: Buffer) => append(stdoutChunks, chunk));
	child.stderr!.on("data", (chunk: Buffer) => append(stderrChunks, chunk));
	if (stdin && child.stdin) {
		child.stdin.once("error", error => finish(error));
		child.stdin.end(stdin);
	}
	child.once("error", error => finish(error));
	child.once("close", code =>
		finish(undefined, {
			code: code ?? -1,
			stdout: Buffer.concat(stdoutChunks).toString("utf8"),
			stderr: Buffer.concat(stderrChunks).toString("utf8"),
		}),
	);
	timer = setTimeout(() => {
		child.kill("SIGTERM");
		finish(new Error("Appliance command timed out"));
	}, timeoutMs);
	timer.unref();
	return promise;
}

export class BoundedApplianceExecutor {
	readonly #runner: BoundedCommandRunner;
	readonly #timeoutMs: number;

	constructor(options: { runner?: BoundedCommandRunner; timeoutMs?: number } = {}) {
		this.#runner = options.runner ?? runBoundedCommand;
		this.#timeoutMs = options.timeoutMs ?? APPLIANCE_COMMAND_TIMEOUT_MS;
	}

	run(command: readonly string[], stdin?: Uint8Array): Promise<BoundedCommandResult> {
		validateCommand(command);
		return this.#runner(command, this.#timeoutMs, stdin);
	}
}
