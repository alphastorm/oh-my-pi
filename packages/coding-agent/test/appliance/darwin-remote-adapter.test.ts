import { describe, expect, test } from "bun:test";
import { buildSshForwardCommand } from "@oh-my-pi/pi-coding-agent/appliance/darwin-remote-adapter";

describe("darwin remote SSH adapter", () => {
	test("builds one authenticated loopback forward without shell parsing", () => {
		const command = buildSshForwardCommand({ host: "gpu-host", localPort: 18089, remotePort: 18089, platform: "darwin" });
		expect(command).toEqual([
			"/usr/bin/ssh", "-N", "-T", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes",
			"-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "ConnectTimeout=10", "-L",
			"127.0.0.1:18089:127.0.0.1:18089", "gpu-host",
		]);
	});
	test("preserves its command-line loopback forward in OpenSSH effective configuration", async () => {
		if (process.platform === "win32") return;
		const command = buildSshForwardCommand({ host: "example.invalid", localPort: 18089, remotePort: 18090, platform: "darwin" });
		const child = Bun.spawn([command[0]!, "-G", "-F", "/dev/null", ...command.slice(1)], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(code, stderr).toBe(0);
		expect(stdout).toContain("forwardagent no");
		expect(stdout).toContain("forwardx11 no");
		expect(stdout).toContain("clearallforwardings no");
		const localForward = stdout.split("\n").find(line => line.startsWith("localforward "));
		expect(localForward).toContain("127.0.0.1");
		expect(localForward).toContain(":18089");
		expect(localForward).toContain(":18090");
	});
	test("fails before SSH for unsafe destinations and non-macOS clients", () => {
		expect(() => buildSshForwardCommand({ host: "-oProxyCommand=bad", localPort: 1, remotePort: 1, platform: "darwin" })).toThrow("hostname");
		expect(() => buildSshForwardCommand({ host: "gpu-host\n", localPort: 1, remotePort: 1, platform: "darwin" })).toThrow();
		expect(() => buildSshForwardCommand({ host: "gpu-host", localPort: 1, remotePort: 1, platform: "linux" })).toThrow("macOS");
	});
});
