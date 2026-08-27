import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { SshApplianceExecutor, validateRemoteHost, type SshApplianceExecutorOptions } from "./remote-executor";
import type { ApplianceReceipt } from "./types";

export interface SshForwardOptions {
	host: string;
	localPort: number;
	remotePort: number;
	sshExecutable?: string;
	connectTimeoutSeconds?: number;
	platform?: NodeJS.Platform;
	spawn?: typeof spawn;
}

function port(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 1 || value > 65535) throw new Error(label + " must be between 1 and 65535");
	return value;
}

export function buildSshForwardCommand(options: SshForwardOptions): string[] {
	if ((options.platform ?? process.platform) !== "darwin") throw new Error("darwin-remote-ssh requires native macOS OMP");
	const host = validateRemoteHost(options.host);
	const localPort = port(options.localPort, "Local port");
	const remotePort = port(options.remotePort, "Remote port");
	const timeout = options.connectTimeoutSeconds ?? 10;
	if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120) throw new Error("SSH connect timeout is invalid");
	const executable = options.sshExecutable ?? "/usr/bin/ssh";
	if (!executable.startsWith("/") || executable.startsWith("-") || /[\u0000-\u001f\u007f]/u.test(executable)) throw new Error("SSH executable path is invalid");
	return [executable, "-N", "-T", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ForwardAgent=no",
		"-o", "ForwardX11=no", "-o", "ConnectTimeout=" + timeout, "-L", "127.0.0.1:" + localPort + ":127.0.0.1:" + remotePort, host];
}
function waitForPort(localPort: number, child: ChildProcess, timeoutMs: number): Promise<void> {
	const started = Date.now();
	return new Promise((resolve, reject) => {
		const attempt = (): void => {
			if (child.exitCode !== null) { reject(new Error("SSH forward exited before becoming reachable")); return; }
			const socket = net.createConnection({ host: "127.0.0.1", port: localPort });
			let settled = false;
			const finish = (ready: boolean): void => {
				if (settled) return;
				settled = true;
				socket.destroy();
				if (ready) resolve();
				else if (Date.now() - started >= timeoutMs) reject(new Error("SSH forward did not become reachable"));
				else setTimeout(attempt, 50).unref();
			};
			socket.setTimeout(250, () => finish(false));
			socket.once("connect", () => finish(true));
			socket.once("error", () => finish(false));
		};
		attempt();
	});
}

export class SshLoopbackForward {
	readonly command: readonly string[];
	readonly #child: ChildProcess;
	#stopped = false;

	private constructor(command: readonly string[], child: ChildProcess) {
		this.command = command;
		this.#child = child;
	}

	static async start(options: SshForwardOptions): Promise<SshLoopbackForward> {
		const timeout = options.connectTimeoutSeconds ?? 10;
		const command = buildSshForwardCommand(options);
		const localPort = port(options.localPort, "Local port");
		const child = (options.spawn ?? spawn)(command[0]!, command.slice(1), { shell: false, stdio: ["ignore", "pipe", "pipe"] });
		const forward = new SshLoopbackForward(command, child);
		try { await waitForPort(localPort, child, timeout * 1000); return forward; }
		catch (error) { await forward.stop(); throw error; }
	}

	async stop(): Promise<void> {
		if (this.#stopped) return;
		this.#stopped = true;
		if (this.#child.exitCode !== null) return;
		this.#child.kill("SIGTERM");
		await Promise.race([
			new Promise<void>(resolve => this.#child.once("close", () => resolve())),
			new Promise<void>(resolve => setTimeout(() => { if (this.#child.exitCode === null) this.#child.kill("SIGKILL"); resolve(); }, 2_000)),
		]);
	}
}

export class DarwinRemoteSshAdapter {
	readonly #executorOptions: SshApplianceExecutorOptions;
	constructor(options: SshApplianceExecutorOptions) { this.#executorOptions = options; }
	executeRead(action: "doctor" | "status", options: { port?: number } = {}): Promise<ApplianceReceipt> {
		return new SshApplianceExecutor(this.#executorOptions).execute(action, options);
	}
	startForward(options: Omit<SshForwardOptions, "host">): Promise<SshLoopbackForward> {
		return SshLoopbackForward.start({ ...options, host: this.#executorOptions.host });
	}
}
