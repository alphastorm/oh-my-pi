import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, statfs, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
	BoundedApplianceExecutor,
	type BoundedCommandRunner,
} from "./bounded-executor";
import type {
	ApplianceAsset,
	ApplianceBenchmarkCase,
	ApplianceCandidate,
	ApplianceEndpointStatus,
	ApplianceGpu,
	ApplianceHostFacts,
	ApplianceInstallation,
	AppliancePlatform,
	ApplianceProfile,
	ApplianceQuickQualification,
} from "./types";
import {
	inspectNativeWindowsDocker,
	validateWindowsLocalPath,
	windowsSystem32Path,
} from "./windows-docker-detection";

interface LifecycleResult {
	status: "ok" | "blocked" | "failed";
	ref?: string;
	candidateId?: string;
	handle?: string;
	containerId?: string;
	imageDigest?: string;
	modelSha256?: string;
	configurationSha256?: string;
	serverBinarySha256?: string;
	binding?: string;
	restartPolicy?: string;
	owned?: boolean;
}
interface DockerPlatformOptions {
	agentDir: string;
	profile: ApplianceProfile;
	runner?: BoundedCommandRunner;
	fetch?: typeof fetch;
	dockerPath?: string;
	root?: string;
}
interface LinuxDockerPlatformOptions extends DockerPlatformOptions {
	platform?: NodeJS.Platform;
	architecture?: string;
	environment?: Record<string, string | undefined>;
	delegatedWslDistribution?: string;
}
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("NInfer lifecycle returned a non-object receipt");
	return value as Record<string, unknown>;
}
function safe(value: unknown, label: string): string {
	if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(label + " is invalid");
	return value;
}
function parseLifecycle(stdout: string, operation: string): LifecycleResult {
	let value: unknown;
	try { value = JSON.parse(stdout.trim()); } catch { throw new Error("NInfer lifecycle returned invalid JSON"); }
	const receipt = record(value);
	if (receipt.schemaVersion !== 1 || receipt.kind !== "omp-ninfer-lifecycle-receipt" || receipt.operation !== operation) {
		throw new Error("NInfer lifecycle receipt contract mismatch");
	}
	const status = safe(receipt.status, "Lifecycle status");
	if (status !== "ok" && status !== "blocked" && status !== "failed") throw new Error("Lifecycle status is unknown");
	return {
		status,
		...(receipt.ref !== undefined ? { ref: safe(receipt.ref, "Lifecycle ref") } : {}),
		...(receipt.candidateId !== undefined ? { candidateId: safe(receipt.candidateId, "Candidate id") } : {}),
		...(receipt.handle !== undefined ? { handle: safe(receipt.handle, "Candidate handle") } : {}),
		...(receipt.containerId !== undefined ? { containerId: safe(receipt.containerId, "Container id") } : {}),
		...(receipt.imageDigest !== undefined ? { imageDigest: safe(receipt.imageDigest, "Image digest") } : {}),
		...(receipt.modelSha256 !== undefined ? { modelSha256: safe(receipt.modelSha256, "Model digest") } : {}),
		...(receipt.configurationSha256 !== undefined ? { configurationSha256: safe(receipt.configurationSha256, "Configuration digest") } : {}),
		...(receipt.serverBinarySha256 !== undefined ? { serverBinarySha256: safe(receipt.serverBinarySha256, "Server digest") } : {}),
		...(receipt.binding !== undefined ? { binding: safe(receipt.binding, "Container binding") } : {}),
		...(receipt.restartPolicy !== undefined ? { restartPolicy: safe(receipt.restartPolicy, "Restart policy") } : {}),
		...(typeof receipt.owned === "boolean" ? { owned: receipt.owned } : {}),
	};
}
function gib(bytes: number): number { return Math.round((bytes / 1024 ** 3) * 10) / 10; }
export function parseWindowsFreeDiskBytes(value: string): number | undefined {
	const bytes = Number(value.trim());
	return Number.isFinite(bytes) && bytes >= 0 ? gib(bytes) : undefined;
}
export function parseWindowsPortOccupied(value: string): boolean {
	return value.trim().toLowerCase() === "true";
}
function endpoint(target: ApplianceCandidate | ApplianceInstallation): string {
	return "endpoint" in target ? target.endpoint : target.route.baseUrl.replace(/\/v1\/?$/u, "");
}

export function dockerLoopbackBinding(localPort: number, containerPort: number): string {
	for (const [value, label] of [[localPort, "local"], [containerPort, "container"]] as const) {
		if (!Number.isSafeInteger(value) || value < 1 || value > 65535) throw new Error("Invalid " + label + " Docker port");
	}
	return "127.0.0.1:" + localPort + ":" + containerPort;
}

function windowsPowerShellPath(systemRoot = "C:\\Windows"): string {
	return validateWindowsLocalPath(path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "PowerShell path");
}

export function buildWindowsLifecycleCommand(script: string, args: string[], systemRoot?: string): string[] {
	const powershell = windowsPowerShellPath(systemRoot);
	return [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", validateWindowsLocalPath(script, "Lifecycle script path"), ...args];
}

export async function hardenWindowsApplianceRoot(
	root: string,
	executor: BoundedApplianceExecutor,
	systemRoot: string | undefined = process.env.SystemRoot,
): Promise<void> {
	await mkdir(root, { recursive: true });
	const whoamiPath = windowsSystem32Path("whoami.exe", systemRoot);
	const icaclsPath = windowsSystem32Path("icacls.exe", systemRoot);
	const whoami = await executor.run([whoamiPath, "/user", "/fo", "csv", "/nh"]);
	const sid = whoami.stdout.match(/S-1-5-21-(?:\d+-){3}\d+/u)?.[0];
	if (whoami.code !== 0 || !sid) throw new Error("Unable to resolve current Windows user SID");
	const acl = await executor.run([icaclsPath, root, "/inheritance:r", "/grant:r", sid + ":(OI)(CI)F", "/grant:r", "*S-1-5-18:(OI)(CI)F"]);
	if (acl.code !== 0) throw new Error("Unable to harden Windows appliance ACLs");
}

export function detectNativeLinuxDocker(input: {
	platform: string;
	architecture: string;
	wslInterop?: string;
	wslDistribution?: string;
	delegatedWslDistribution?: string;
	dockerServer: string;
	nvidiaRuntimes: string;
}): string[] {
	const blockers: string[] = [];
	const exactWslDelegation =
		input.wslInterop !== undefined && input.delegatedWslDistribution !== undefined &&
		input.wslDistribution === input.delegatedWslDistribution;
	if (
		input.platform !== "linux" ||
		(input.wslInterop !== undefined && !exactWslDelegation) ||
		(input.wslInterop === undefined && input.delegatedWslDistribution !== undefined)
	) {
		blockers.push("linux-docker-local requires native Linux OMP or an exact remote WSL delegation");
	}
	if (input.architecture !== "x64") blockers.push("linux-docker-local requires Linux x64");
	if (input.dockerServer.trim() !== "linux/amd64") blockers.push("Local Docker Linux amd64 engine is unavailable");
	if (!/nvidia/iu.test(input.nvidiaRuntimes)) blockers.push("NVIDIA Container Toolkit is unavailable");
	return blockers;
}

abstract class DockerLocalPlatform implements AppliancePlatform {
	readonly root: string;
	readonly profile: ApplianceProfile;
	protected readonly executor: BoundedApplianceExecutor;
	readonly #fetch: typeof fetch;
	readonly #dockerOverride?: string;

	protected constructor(options: DockerPlatformOptions) {
		if (!options.profile.container || !options.profile.lifecycle || !options.profile.assets) throw new Error("Docker profile lacks lifecycle authority");
		this.profile = options.profile;
		this.root = options.root ?? path.join(options.agentDir, "appliance", options.profile.profile);
		this.executor = new BoundedApplianceExecutor({ runner: options.runner });
		this.#fetch = options.fetch ?? fetch;
		this.#dockerOverride = options.dockerPath;
	}
	protected abstract platformFacts(): Promise<{ os: NodeJS.Platform; architecture: string; dockerPath: string; blockers: string[] }>;
	protected abstract lifecycleCommand(script: string, args: string[]): string[];
	protected async hardenRoot(): Promise<void> { await mkdir(this.root, { recursive: true, mode: 0o700 }); }

	async #dockerPath(): Promise<string> {
		if (this.#dockerOverride) return this.#dockerOverride;
		return (await this.platformFacts()).dockerPath;
	}
	async #scriptPath(acquire = true): Promise<string | undefined> {
		const lifecycle = this.profile.lifecycle!;
		const target = path.join(this.root, "lifecycle-" + lifecycle.scriptSha256 + (this.profile.adapter === "windows-docker-local" ? ".ps1" : ".sh"));
		try { if (createHash("sha256").update(await readFile(target)).digest("hex") === lifecycle.scriptSha256) return target; } catch {}
		if (!acquire) return undefined;
		await this.hardenRoot();
		const response = await this.#fetch(lifecycle.scriptUrl, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
		if (!response.ok || new URL(response.url).protocol !== "https:") throw new Error("NInfer lifecycle download failed");
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (createHash("sha256").update(bytes).digest("hex") !== lifecycle.scriptSha256) throw new Error("NInfer lifecycle checksum mismatch");
		try {
			await writeFile(target, bytes, { flag: "wx", mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		if (createHash("sha256").update(await readFile(target)).digest("hex") !== lifecycle.scriptSha256) {
			throw new Error("NInfer lifecycle checksum mismatch for existing script");
		}
		await chmod(target, 0o700).catch(() => {});
		return target;
	}
	async #invoke(operation: string, args: string[] = [], acquireScript = true): Promise<LifecycleResult> {
		const script = await this.#scriptPath(acquireScript);
		if (!script) throw new Error("NInfer lifecycle script is not installed");
		const command = this.lifecycleCommand(script, [
			...this.profile.lifecycle!.arguments, operation, "--profile", this.profile.profile,
			"--state-root", this.root, "--json", ...args,
		]);
		const result = await this.executor.run(command);
		const receipt = parseLifecycle(result.stdout, operation);
		if (result.code !== 0 && receipt.status === "ok") throw new Error("NInfer lifecycle exited nonzero with ok status");
		if (receipt.status !== "ok") throw new Error("NInfer lifecycle " + operation + " did not complete");
		return receipt;
	}

	async inspectHost(): Promise<ApplianceHostFacts> {
		const facts = await this.platformFacts();
		const docker = facts.dockerPath;
		let gpus: ApplianceGpu[] = [];
		const dockerAvailable = facts.blockers.length === 0;
		let nvidiaContainerRuntimeAvailable = false;
		if (facts.blockers.length === 0) {
			const image = await this.executor.run([docker, "image", "inspect", this.profile.container!.imageReference, "--format", "{{json .RepoDigests}}"]);
			const imagePresent = image.code === 0 && image.stdout.includes(this.profile.container!.imageDigest);
			if (imagePresent) {
				const gpu = await this.executor.run([docker, "run", "--rm", "--pull=never", "--network=none", "--gpus", "all", this.profile.container!.imageReference,
					"nvidia-smi", "--query-gpu=name,memory.total,compute_cap,driver_version", "--format=csv,noheader,nounits"]);
				if (gpu.code === 0) {
					nvidiaContainerRuntimeAvailable = true;
					gpus = gpu.stdout.split("\n").filter(Boolean).flatMap(line => {
						const [model, memory, computeCapability] = line.split(",").map(part => part.trim());
						const mib = Number(memory);
						return model && Number.isFinite(mib) ? [{ model, vramGiB: Math.round((mib / 1024) * 10) / 10, computeCapability }] : [];
					});
				}
			}
		}
		let freeDiskGiB: number | undefined;
		try { const value = await statfs(path.dirname(this.root)); freeDiskGiB = gib(value.bavail * value.bsize); } catch {}
		return {
			os: facts.os, architecture: facts.architecture, totalRamGiB: gib(os.totalmem()), freeRamGiB: gib(os.freemem()),
			freeDiskGiB, gpus, dockerAvailable, nvidiaContainerRuntimeAvailable,
			windowsRuntimeAvailable: facts.os === "win32" && dockerAvailable,
			secretStorageAvailable: facts.blockers.length === 0,
		};
	}
	async isPortOccupied(port: number): Promise<boolean> {
		const socketOccupied = await new Promise<boolean>(resolve => {
			const socket = net.createConnection({ host: "127.0.0.1", port });
			let done = false;
			const finish = (value: boolean): void => { if (done) return; done = true; socket.destroy(); resolve(value); };
			socket.setTimeout(500, () => finish(true));
			socket.once("connect", () => finish(true));
			socket.once("error", () => finish(false));
		});
		if (socketOccupied) return true;
		try {
			const result = await this.executor.run([await this.#dockerPath(), "ps", "--filter", "publish=" + port, "--format", "{{.ID}}"]);
			return result.code === 0 && result.stdout.trim().length > 0;
		} catch { return true; }
	}
	async artifactPresent(asset: ApplianceAsset): Promise<boolean> {
		if (asset.kind === "runtime") {
			try {
				const result = await this.executor.run([await this.#dockerPath(), "image", "inspect", this.profile.container!.imageReference, "--format", "{{json .RepoDigests}}"]);
				return result.code === 0 && result.stdout.includes(this.profile.container!.imageDigest);
			} catch {
				return false;
			}
		}
		try { const result = await this.#invoke("artifact-status", ["--kind", "model", "--sha256", asset.sha256], false); return result.status === "ok"; }
		catch { return false; }
	}
	async acquireArtifact(asset: ApplianceAsset): Promise<string> {
		const args = ["--kind", asset.kind, "--url", asset.url, "--sha256", asset.sha256];
		if (asset.bytes !== undefined) args.push("--bytes", String(asset.bytes));
		const receipt = await this.#invoke("acquire", args);
		if (!receipt.ref) throw new Error("NInfer acquire receipt omitted its immutable ref");
		return receipt.ref;
	}
	async removeArtifact(_ref: string): Promise<void> { /* immutable shared assets are never removed by OMP */ }
	async createCandidate(input: { profile: ApplianceProfile; runtimeRef: string; modelRef: string; secret: string; port: number; installationId: string }): Promise<ApplianceCandidate> {
		await this.hardenRoot();
		const secretFile = path.join(this.root, "secret-" + input.installationId + ".key");
		await writeFile(secretFile, input.secret + "\n", { flag: "wx", mode: 0o600 });
		await chmod(secretFile, 0o600).catch(() => {});
		const binding = dockerLoopbackBinding(input.port, input.profile.container!.containerPort);
		const receipt = await this.#invoke("prepare", [
			"--runtime-ref", input.runtimeRef, "--model-ref", input.modelRef, "--secret-file", secretFile,
			"--installation-id", input.installationId, "--publish", binding,
		]);
		const candidateId = receipt.candidateId ?? "candidate-" + input.installationId;
		const handle = receipt.handle ?? candidateId;
		return { candidateId, handle, endpoint: "http://127.0.0.1:" + input.port, port: input.port };
	}
	async startCandidate(candidate: ApplianceCandidate): Promise<void> { await this.#invoke("start", ["--handle", candidate.handle]); }
	async stopCandidate(candidateHandle: string): Promise<void> { await this.#invoke("stop", ["--handle", candidateHandle]); }
	async stopInstallation(installation: ApplianceInstallation): Promise<void> { await this.stopCandidate(installation.candidateHandle); }
	async startInstallation(installation: ApplianceInstallation, _secret: string): Promise<void> { await this.#invoke("restore", ["--handle", installation.candidateHandle]); }
	async #status(target: ApplianceCandidate | ApplianceInstallation, secret: string): Promise<Record<string, unknown>> {
		const handle = "handle" in target ? target.handle : target.candidateHandle;
		const lifecycle = await this.#invoke("status", ["--handle", handle], false);
		const expectedBinding = dockerLoopbackBinding("port" in target ? target.port : target.route.port, this.profile.container!.containerPort);
		if (
			!lifecycle.containerId || lifecycle.imageDigest !== this.profile.container!.imageDigest ||
			lifecycle.modelSha256 !== this.profile.assets!.model.sha256 ||
			lifecycle.configurationSha256 !== this.profile.container!.configurationSha256 ||
			lifecycle.serverBinarySha256 !== this.profile.container!.serverBinarySha256 ||
			lifecycle.binding !== expectedBinding || lifecycle.restartPolicy !== "no" || lifecycle.owned !== true
		) {
			throw new Error("NInfer container identity or ownership mismatch");
		}
		const response = await this.#fetch(endpoint(target) + "/status", { headers: { authorization: "Bearer " + secret }, signal: AbortSignal.timeout(10_000) });
		if (!response.ok) throw new Error("NInfer status request failed");
		return record(await response.json());
	}
	async probeHealth(target: ApplianceCandidate | ApplianceInstallation, secret: string): Promise<void> {
		const status = await this.#status(target, secret);
		if (status.image_digest !== this.profile.container!.imageDigest || status.model_sha256 !== this.profile.assets!.model.sha256 ||
			status.configuration_sha256 !== this.profile.container!.configurationSha256 || status.server_binary_sha256 !== this.profile.container!.serverBinarySha256) {
			throw new Error("NInfer running identity mismatch");
		}
	}
	async probeProtocol(target: ApplianceCandidate | ApplianceInstallation, secret: string): Promise<void> { await this.probeHealth(target, secret); }
	async quickQualification(target: ApplianceCandidate | ApplianceInstallation, secret: string): Promise<ApplianceQuickQualification> {
		const started = performance.now(); await this.probeHealth(target, secret);
		const item: ApplianceBenchmarkCase = { name: "short-decode", ok: true, durationMs: Math.round((performance.now() - started) * 10) / 10, oracleSha256: createHash("sha256").update("authenticated-local-status").digest("hex") };
		return { ok: true, cases: [item] };
	}
	async probeRoutedRequest(installation: ApplianceInstallation, secret: string): Promise<void> { await this.probeHealth(installation, secret); }
	async readEndpointStatus(installation: ApplianceInstallation, secret: string): Promise<ApplianceEndpointStatus> {
		const status = await this.#status(installation, secret);
		const profile = safe(status.deployment_profile, "NInfer deployment profile");
		return {
			fingerprint: createHash("sha256").update(installation.route.baseUrl + "\0" + this.profile.container!.imageDigest + "\0" + this.profile.assets!.model.sha256 + "\0" + this.profile.container!.configurationSha256).digest("hex"),
			normalizedBaseUrl: installation.route.baseUrl.replace(/\/$/u, ""),
			servedModel: this.profile.servedModel,
			profile,
			artifactSha256: this.profile.assets!.model.sha256,
			requestShapeVersion: "omp-openai-responses-ninfer/v1",
			status: status as unknown as ApplianceEndpointStatus["status"],
		};
	}
	async checkpoint(): Promise<never> { throw new Error("Docker local compatibility profile does not declare durable checkpoint ownership"); }
}

export class WindowsDockerAppliancePlatform extends DockerLocalPlatform {
	constructor(options: DockerPlatformOptions) { super(options); }
	override async inspectHost(): Promise<ApplianceHostFacts> {
		const host = await super.inspectHost();
		if (host.freeDiskGiB !== undefined) return host;
		const drive = path.win32.parse(this.root).root.slice(0, 1);
		if (!/^[A-Za-z]$/u.test(drive)) return host;
		const powershell = windowsPowerShellPath(process.env.SystemRoot);
		try {
			const result = await this.executor.run([powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `[Console]::Out.Write((Get-PSDrive -Name ${drive}).Free)`]);
			const freeDiskGiB = result.code === 0 ? parseWindowsFreeDiskBytes(result.stdout) : undefined;
			return freeDiskGiB === undefined ? host : { ...host, freeDiskGiB };
		} catch {
			return host;
		}
	}
	override async isPortOccupied(port: number): Promise<boolean> {
		const facts = await this.platformFacts();
		if (!facts.dockerPath) return true;
		const powershell = windowsPowerShellPath(process.env.SystemRoot);
		try {
			const listener = await this.executor.run([powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `[Console]::Out.Write([bool](Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue))`]);
			if (listener.code !== 0 || parseWindowsPortOccupied(listener.stdout)) return true;
			const containers = await this.executor.run([facts.dockerPath, "ps", "--filter", "publish=" + port, "--format", "{{.ID}}"]);
			return containers.code !== 0 || containers.stdout.trim().length > 0;
		} catch {
			return true;
		}
	}
	protected override async hardenRoot(): Promise<void> {
		await hardenWindowsApplianceRoot(this.root, this.executor);
	}
	protected async platformFacts(): Promise<{ os: NodeJS.Platform; architecture: string; dockerPath: string; blockers: string[] }> {
		const detection = await inspectNativeWindowsDocker(this.executor);
		return { os: process.platform, architecture: process.arch, dockerPath: detection.dockerPath ?? "", blockers: detection.blockers };
	}
	protected lifecycleCommand(script: string, args: string[]): string[] {
		return buildWindowsLifecycleCommand(script, args, process.env.SystemRoot);
	}
}

export class LinuxDockerAppliancePlatform extends DockerLocalPlatform {
	readonly #platform: NodeJS.Platform;
	readonly #architecture: string;
	readonly #wslInterop?: string;
	readonly #wslDistribution?: string;
	readonly #delegatedWslDistribution?: string;
	constructor(options: LinuxDockerPlatformOptions) {
		super(options);
		const environment = options.environment ?? process.env;
		this.#platform = options.platform ?? process.platform;
		this.#architecture = options.architecture ?? process.arch;
		this.#wslInterop = environment.WSL_INTEROP;
		this.#wslDistribution = environment.WSL_DISTRO_NAME;
		this.#delegatedWslDistribution = options.delegatedWslDistribution;
		const exactWslDelegation =
			this.#wslInterop !== undefined && this.#delegatedWslDistribution !== undefined &&
			this.#wslDistribution === this.#delegatedWslDistribution;
		if (
			this.#platform !== "linux" ||
			(this.#wslInterop !== undefined && !exactWslDelegation) ||
			(this.#wslInterop === undefined && this.#delegatedWslDistribution !== undefined)
		) {
			throw new Error("linux-docker-local requires native Linux OMP or an exact remote WSL delegation");
		}
	}
	protected async platformFacts(): Promise<{ os: NodeJS.Platform; architecture: string; dockerPath: string; blockers: string[] }> {
		const version = await this.executor.run(["docker", "version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"]);
		const info = await this.executor.run(["docker", "info", "--format", "{{json .Runtimes}}"]);
		const blockers = detectNativeLinuxDocker({
			platform: this.#platform,
			architecture: this.#architecture,
			...(this.#wslInterop === undefined ? {} : { wslInterop: this.#wslInterop }),
			...(this.#wslDistribution === undefined ? {} : { wslDistribution: this.#wslDistribution }),
			...(this.#delegatedWslDistribution === undefined
				? {}
				: { delegatedWslDistribution: this.#delegatedWslDistribution }),
			dockerServer: version.code === 0 ? version.stdout : "",
			nvidiaRuntimes: info.code === 0 ? info.stdout : "",
		});
		return { os: this.#platform, architecture: this.#architecture, dockerPath: "docker", blockers };
	}
	protected lifecycleCommand(script: string, args: string[]): string[] { return ["/bin/sh", script, ...args]; }
}
