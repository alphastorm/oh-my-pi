import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileApplianceStore } from "@oh-my-pi/pi-coding-agent/appliance/store";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("platform-aware appliance store", () => {
	test("hardens the product root before the first secret write", async () => {
		const parent = await mkdtemp(join(tmpdir(), "omp-store-platform-"));
		roots.push(parent);
		const root = join(parent, "appliance");
		const events: string[] = [];
		const store = new FileApplianceStore(parent, {
			root,
			beforeWrite: async value => {
				events.push(`harden:${value}`);
				expect(await lstat(join(root, "secrets")).catch(() => undefined)).toBeUndefined();
			},
		});
		const secretRef = await store.createSecret("candidate-1");
		await store.writeReceipt({
			schemaVersion: 1,
			receiptId: "receipt-1",
			action: "install",
			status: "ok",
			timestamp: new Date(0).toISOString(),
			details: {},
		});
		expect(events).toEqual([`harden:${root}`]);
		if (process.platform !== "win32") expect((await stat(join(root, secretRef))).mode & 0o077).toBe(0);
	});

	test("round-trips a durable interrupted transition", async () => {
		const parent = await mkdtemp(join(tmpdir(), "omp-store-pending-"));
		roots.push(parent);
		const store = new FileApplianceStore(parent);
		await store.writeState(
			{
				schemaVersion: 1,
				revision: 1,
				pending: {
					action: "install",
					stage: "before-predecessor-stop",
					installationId: "candidate-1",
					profile: "windows-docker-local",
					failureReceiptId: "failure-1",
				},
			},
			0,
		);
		expect(await store.readState()).toMatchObject({
			revision: 1,
			pending: {
				action: "install",
				stage: "before-predecessor-stop",
				profile: "windows-docker-local",
				failureReceiptId: "failure-1",
			},
		});
	});

	test("fails closed instead of reclaiming an existing install lock", async () => {
		const parent = await mkdtemp(join(tmpdir(), "omp-store-lock-existing-"));
		roots.push(parent);
		const store = new FileApplianceStore(parent);
		await store.createSecret("write-ready");
		const lockPath = join(parent, "appliance", "install.lock");
		const existing = `${JSON.stringify({ pid: 999_999_999, token: "dead-owner" })}\n`;
		await writeFile(lockPath, existing, "utf8");

		await expect(store.withInstallLock(async () => "entered")).rejects.toThrow(
			"Another appliance transaction is in progress",
		);
		expect(await readFile(lockPath, "utf8")).toBe(existing);
	});

	test("serializes concurrent install lock callers", async () => {
		const parent = await mkdtemp(join(tmpdir(), "omp-store-lock-concurrent-"));
		roots.push(parent);
		const store = new FileApplianceStore(parent);
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		const firstEntered = new Promise<void>(resolve => {
			entered = resolve;
		});
		const first = store.withInstallLock(async () => {
			entered();
			await gate;
		});
		await firstEntered;

		await expect(store.withInstallLock(async () => undefined)).rejects.toThrow(
			"Another appliance transaction is in progress",
		);
		release();
		await first;
		await expect(lstat(join(parent, "appliance", "install.lock"))).rejects.toThrow();
	});

	test("never removes a replacement install lock", async () => {
		const parent = await mkdtemp(join(tmpdir(), "omp-store-lock-owner-"));
		roots.push(parent);
		const store = new FileApplianceStore(parent);
		const lockPath = join(parent, "appliance", "install.lock");
		const replacement = `${JSON.stringify({ pid: process.pid, token: "replacement" })}\n`;

		await store.withInstallLock(async () => {
			await writeFile(lockPath, replacement, "utf8");
		});
		expect(await readFile(lockPath, "utf8")).toBe(replacement);
	});
});
