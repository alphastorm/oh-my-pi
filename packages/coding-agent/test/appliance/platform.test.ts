import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { LocalAppliancePlatform } from "@oh-my-pi/pi-coding-agent/appliance/platform";
import { APPLIANCE_PROFILES } from "@oh-my-pi/pi-coding-agent/appliance/registry";
import type { ApplianceProfile } from "@oh-my-pi/pi-coding-agent/appliance/types";
import { TempDir } from "@oh-my-pi/pi-utils";

function launchableProfile(): ApplianceProfile {
	const profile = APPLIANCE_PROFILES.find(candidate => candidate.profile === "rtx5090-linux");
	if (!profile) throw new Error("RTX 5090 profile missing");
	return {
		...profile,
		launch: {
			executable: "runtime",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: Launch descriptor placeholders are literal tokens.
			args: ["--model", "${model}", "--host", "${host}", "--port", "${port}", "--served-model", "${served_model}"],
			secretEnvironmentVariable: "NINFER_API_KEY",
		},
	};
}

describe("local appliance platform", () => {
	it("creates an isolated private candidate and reports spawn failure without leaking its secret", async () => {
		using temp = TempDir.createSync("@omp-appliance-platform-");
		const platform = new LocalAppliancePlatform(temp.path());
		const runtimeRef = path.join("artifacts", "runtime", "1".repeat(64));
		const modelRef = path.join("artifacts", "model", "2".repeat(64));
		const secret = "candidate-secret-must-not-leak";

		const candidate = await platform.createCandidate({
			profile: launchableProfile(),
			runtimeRef,
			modelRef,
			secret,
			port: 8000,
			installationId: "install-1",
		});

		const candidateDir = path.join(temp.path(), "appliance", candidate.handle);
		const manifestPath = path.join(candidateDir, "service.json");
		const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
		expect(manifest.command).toBe(path.join(temp.path(), "appliance", runtimeRef));
		expect(manifest.args).toEqual([
			"--model",
			path.join(temp.path(), "appliance", modelRef),
			"--host",
			"127.0.0.1",
			"--port",
			"8000",
			"--served-model",
			"q38-ninfer",
		]);
		expect(JSON.stringify(manifest)).not.toContain(secret);
		if (process.platform !== "win32") {
			expect((await fs.stat(manifestPath)).mode & 0o777).toBe(0o600);
		}

		let error: unknown;
		try {
			await platform.startCandidate(candidate);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(Error);
		expect(await fs.exists(path.join(candidateDir, "pid"))).toBe(false);
		expect(await fs.readFile(path.join(candidateDir, "service.log"), "utf8")).not.toContain(secret);
	});

	it("refuses to signal a persisted process it did not launch", async () => {
		using temp = TempDir.createSync("@omp-appliance-platform-unowned-");
		const platform = new LocalAppliancePlatform(temp.path());
		const candidate = await platform.createCandidate({
			profile: launchableProfile(),
			runtimeRef: path.join("artifacts", "runtime", "1".repeat(64)),
			modelRef: path.join("artifacts", "model", "2".repeat(64)),
			secret: "candidate-secret",
			port: 8000,
			installationId: "install-unowned",
		});
		const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		try {
			await fs.writeFile(path.join(temp.path(), "appliance", candidate.handle, "pid"), `${String(child.pid)}\n`);
			await expect(platform.stopCandidate(candidate.handle)).rejects.toThrow(
				"Appliance candidate process ownership cannot be proven",
			);
			expect(process.kill(child.pid, 0)).toBe(true);
		} finally {
			child.kill("SIGTERM");
			await child.exited;
		}
	});
});
