import os from "node:os";
import path from "node:path";
import type { BoundedApplianceExecutor } from "./bounded-executor";

export interface WindowsDockerDetectionInput {
	platform: string;
	architecture: string;
	windowsRelease: string;
	wslInterop?: string;
	dockerPath?: string;
	dockerContext?: string;
	dockerServerOs?: string;
	dockerServerArchitecture?: string;
	dockerPlatformName?: string;
	dockerReady: boolean;
}

export interface WindowsDockerDetection {
	detected: boolean;
	supported: boolean;
	windowsBuild?: number;
	dockerPath?: string;
	blockers: string[];
}

export function validateWindowsLocalPath(value: string, label: string): string {
	const trimmed = value.trim();
	if (!trimmed || trimmed.startsWith("-") || /[\u0000-\u001f\u007f]/u.test(trimmed)) {
		throw new Error(label + " is blank, option-shaped, or contains control characters");
	}
	if (/^\\\\/u.test(trimmed) || !/^[A-Za-z]:\\/u.test(trimmed)) {
		throw new Error(label + " must be a local absolute Windows drive path");
	}
	return path.win32.normalize(trimmed);
}

export function windowsSystem32Path(
	executable: "icacls.exe" | "where.exe" | "whoami.exe",
	systemRoot: string | undefined = process.env.SystemRoot,
): string {
	return validateWindowsLocalPath(
		path.win32.join(systemRoot ?? "C:\Windows", "System32", executable),
		executable + " path",
	);
}

export function detectNativeWindowsDocker(input: WindowsDockerDetectionInput): WindowsDockerDetection {
	const blockers: string[] = [];
	const releaseMatch = input.windowsRelease.match(/^10\.0\.(\d+)(?:\.\d+)?$/u);
	const windowsBuild = releaseMatch ? Number(releaseMatch[1]) : undefined;
	const detected = input.platform === "win32" && !input.wslInterop;
	if (input.platform !== "win32") blockers.push("windows-docker-local requires native Windows OMP");
	if (input.wslInterop) blockers.push("windows-docker-local refuses WSL-hosted OMP");
	if (input.architecture !== "x64") blockers.push("windows-docker-local requires Windows x64");
	if (!windowsBuild || windowsBuild < 22000) blockers.push("Windows 11 build 22000 or newer is required");
	let dockerPath: string | undefined;
	if (!input.dockerPath) blockers.push("docker.exe was not found");
	else {
		try {
			dockerPath = validateWindowsLocalPath(input.dockerPath, "docker.exe path");
		} catch (error) {
			blockers.push(error instanceof Error ? error.message : "docker.exe path is invalid");
		}
	}
	if (!input.dockerReady) blockers.push("Docker Desktop engine is stopped or unavailable");
	if (input.dockerContext !== "desktop-linux" && input.dockerContext !== "default") {
		blockers.push("Docker context is neither default nor desktop-linux");
	}
	if (input.dockerServerOs !== "linux") blockers.push("Docker Desktop is not in Linux-containers mode");
	if (input.dockerServerArchitecture !== "amd64") blockers.push("Docker Linux engine architecture is not amd64");
	if (!/docker desktop/i.test(input.dockerPlatformName ?? "")) blockers.push("Docker server is not Docker Desktop");
	return { detected, supported: detected && blockers.length === 0, windowsBuild, dockerPath, blockers };
}

function parseDockerVersion(value: string): {
	serverOs?: string;
	serverArchitecture?: string;
	platformName?: string;
} {
	try {
		const parsed = JSON.parse(value) as Record<string, unknown>;
		const server = parsed.Server && typeof parsed.Server === "object" ? (parsed.Server as Record<string, unknown>) : {};
		const platform = server.Platform && typeof server.Platform === "object" ? (server.Platform as Record<string, unknown>) : {};
		return {
			serverOs: typeof server.Os === "string" ? server.Os : undefined,
			serverArchitecture: typeof server.Arch === "string" ? server.Arch : undefined,
			platformName: typeof platform.Name === "string" ? platform.Name : undefined,
		};
	} catch {
		return {};
	}
}

async function commandOutput(executor: BoundedApplianceExecutor, command: readonly string[]): Promise<string | undefined> {
	try {
		const result = await executor.run(command);
		return result.code === 0 ? result.stdout.trim() : undefined;
	} catch {
		return undefined;
	}
}

export async function inspectNativeWindowsDocker(
	executor: BoundedApplianceExecutor,
	environment: Record<string, string | undefined> = process.env,
): Promise<WindowsDockerDetection> {
	const candidates: string[] = [];
	if (environment.OMP_DOCKER_EXE) {
		candidates.push(environment.OMP_DOCKER_EXE);
	} else {
		if (environment.ProgramFiles) {
			candidates.push(path.win32.join(environment.ProgramFiles, "Docker", "Docker", "resources", "bin", "docker.exe"));
		}
		let located: string | undefined;
		try {
			located = await commandOutput(executor, [windowsSystem32Path("where.exe", environment.SystemRoot), "docker.exe"]);
		} catch {}
		for (const candidate of located?.split(/\r?\n/u).filter(Boolean) ?? []) {
			try {
				const resolved = validateWindowsLocalPath(candidate, "resolved docker.exe path");
				if (!candidates.includes(resolved)) candidates.push(resolved);
			} catch {}
		}
	}
	let dockerPath: string | undefined;
	let context: string | undefined;
	let version: string | undefined;
	for (const candidate of candidates) {
		let normalized: string;
		try { normalized = validateWindowsLocalPath(candidate, "docker.exe path"); }
		catch { continue; }
		const [candidateContext, candidateVersion] = await Promise.all([
			commandOutput(executor, [normalized, "context", "show"]),
			commandOutput(executor, [normalized, "version", "--format", "{{json .}}"]),
		]);
		if (candidateVersion !== undefined) {
			dockerPath = normalized;
			context = candidateContext;
			version = candidateVersion;
			break;
		}
	}
	const parsed = parseDockerVersion(version ?? "");
	return detectNativeWindowsDocker({
		platform: process.platform,
		architecture: process.arch,
		windowsRelease: os.release(),
		...(environment.WSL_INTEROP !== undefined ? { wslInterop: environment.WSL_INTEROP } : {}),
		...(dockerPath !== undefined ? { dockerPath } : {}),
		...(context !== undefined ? { dockerContext: context } : {}),
		...(parsed.serverOs !== undefined ? { dockerServerOs: parsed.serverOs } : {}),
		...(parsed.serverArchitecture !== undefined ? { dockerServerArchitecture: parsed.serverArchitecture } : {}),
		...(parsed.platformName !== undefined ? { dockerPlatformName: parsed.platformName } : {}),
		dockerReady: version !== undefined,
	});
}
