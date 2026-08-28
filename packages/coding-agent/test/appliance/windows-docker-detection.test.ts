import { describe, expect, test } from "bun:test";
import { BoundedApplianceExecutor } from "@oh-my-pi/pi-coding-agent/appliance/bounded-executor";
import {
	detectNativeWindowsDocker,
	inspectNativeWindowsDocker,
	validateWindowsLocalPath,
	windowsSystem32Path,
} from "@oh-my-pi/pi-coding-agent/appliance/windows-docker-detection";

const READY = {
	platform: "win32",
	architecture: "x64",
	windowsRelease: "10.0.26100",
	dockerPath: "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
	dockerContext: "desktop-linux",
	dockerServerOs: "linux",
	dockerServerArchitecture: "amd64",
	dockerPlatformName: "Docker Desktop 4.45",
	dockerReady: true,
} as const;

describe("native Windows Docker detection", () => {
	test("accepts native Windows 11 with Docker Desktop Linux", () => {
		const result = detectNativeWindowsDocker(READY);
		expect(result.supported).toBe(true);
		expect(result.detected).toBe(true);
		expect(result.windowsBuild).toBe(26100);
		expect(result.blockers).toEqual([]);
	});

	test("accepts the default context when it resolves to Docker Desktop Linux", () => {
		expect(detectNativeWindowsDocker({ ...READY, dockerContext: "default" }).supported).toBe(true);
	});

	test.each([
		[{ ...READY, platform: "linux", wslInterop: "/run/WSL/1_interop" }, "requires native Windows OMP"],
		[{ ...READY, wslInterop: "\\\\.\\pipe\\wsl" }, "refuses WSL-hosted OMP"],
		[{ ...READY, windowsRelease: "10.0.19045" }, "Windows 11"],
		[{ ...READY, architecture: "arm64" }, "Windows x64"],
		[{ ...READY, dockerServerOs: "windows" }, "Linux-containers"],
		[{ ...READY, dockerReady: false }, "stopped or unavailable"],
	] as const)("fails partial or false-positive detection", (input, blocker) => {
		const result = detectNativeWindowsDocker(input);
		expect(result.supported).toBe(false);
		expect(result.blockers.join(" ")).toContain(blocker);
	});

	test("rejects unsafe Docker paths", () => {
		expect(() => validateWindowsLocalPath("-docker.exe", "docker")).toThrow("option-shaped");
		expect(() => validateWindowsLocalPath("\\\\server\\docker.exe", "docker")).toThrow("local absolute");
		expect(() => validateWindowsLocalPath("C:\\Docker\\bad\n.exe", "docker")).toThrow("control");
		expect(validateWindowsLocalPath("C:\\Docker\\docker.exe", "docker")).toBe("C:\\Docker\\docker.exe");
		expect(windowsSystem32Path("where.exe", "C:\\Windows")).toBe("C:\\Windows\\System32\\where.exe");
		expect(() => windowsSystem32Path("where.exe", "C:Windows")).toThrow("local absolute");
	});

	test("falls back to a user-local Docker CLI when the Program Files candidate is absent", async () => {
		const localDocker = String.raw`C:\Users\Tester\AppData\Local\Programs\DockerDesktop\resources\bin\docker.exe`;
		const executor = new BoundedApplianceExecutor({
			runner: async command => {
				if (command[0] === "C:\\Windows\\System32\\where.exe") {
					return {
						code: 0,
						stdout: `docker.exe\r\n\\\\server\\docker.exe\r\n${localDocker}\r\n`,
						stderr: "",
					};
				}
				if (command[0] === localDocker && command[1] === "context") {
					return { code: 0, stdout: "desktop-linux\n", stderr: "" };
				}
				if (command[0] === localDocker && command[1] === "version") {
					return {
						code: 0,
						stdout: JSON.stringify({
							Server: { Os: "linux", Arch: "amd64", Platform: { Name: "Docker Desktop" } },
						}),
						stderr: "",
					};
				}
				return { code: 1, stdout: "", stderr: "not found" };
			},
		});
		const result = await inspectNativeWindowsDocker(executor, {
			ProgramFiles: String.raw`C:\Program Files`,
			SystemRoot: "C:\\Windows",
		});
		expect(result.dockerPath).toBe(localDocker);
	});
});
