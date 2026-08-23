import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { CollabController } from "@oh-my-pi/pi-coding-agent/collab/controller";
import type { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import {
	type BuiltinSlashCommandRuntime,
	executeBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { CollabQrCodeComponent } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/collab-qrcode";
import { Spacer, Text, visibleWidth } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);
});

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(() => {
	resetSettingsForTest();
});

function fakeHost(options?: { webLink?: string; webViewLink?: string }): CollabHost {
	return {
		link: "relay.example.com/r/full-control",
		viewLink: "relay.example.com/r/read-only",
		webLink: options?.webLink ?? "https://my.omp.sh/#full-control",
		webViewLink: options?.webViewLink ?? "https://my.omp.sh/#read-only",
		participants: [{ name: "host", role: "host" }],
	} as unknown as CollabHost;
}

function createRuntimeHarness(options?: { collabHost?: CollabHost }) {
	const setText = vi.fn();
	const showStatus = vi.fn();
	const showError = vi.fn();
	const present = vi.fn();
	const settingsGet = vi.fn((key: string) => {
		if (key === "collab.relayUrl") return "wss://relay.example.com";
		if (key === "collab.webUrl") return "";
		return "";
	});
	let collabHost = options?.collabHost;
	const ctx = {
		editor: { setText },
		showStatus,
		showError,
		present,
		settings: { get: settingsGet },
	} as unknown as InteractiveModeContext;
	const start = vi.fn();
	const collabController = {
		get host() {
			return collabHost;
		},
		start(startOptions: {
			relayUrl?: string;
			webUrl?: string;
			publish?: "view" | "control";
			forceReplacement?: boolean;
		}) {
			start(startOptions);
			collabHost = fakeHost({
				webLink: "https://my.omp.sh/#started-full",
				webViewLink: "https://my.omp.sh/#started-view",
			});
			return Promise.resolve();
		},
		resumePublication: vi.fn().mockResolvedValue(undefined),
		stop: vi.fn(),
	} as unknown as CollabController;
	Object.assign(ctx, { collabController });
	return {
		ctx,
		start,
		setText,
		showStatus,
		showError,
		present,
		runtime: { ctx } as BuiltinSlashCommandRuntime,
	};
}

describe("/collab slash command QR code rendering", () => {
	it("starts hosting and prints a one-shot full-control QR", async () => {
		const harness = createRuntimeHarness();

		const handled = await executeBuiltinSlashCommand("/collab", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.start).toHaveBeenCalledWith({
			relayUrl: "wss://relay.example.com",
			webUrl: "",
			publish: "control",
		});
		const statusText = harness.showStatus.mock.calls[0]?.[0] as string;
		expect(statusText).toContain("my.omp.sh/#started-full");
		const presented = harness.present.mock.calls[0]?.[0] as readonly unknown[];
		expect(presented[0]).toBeInstanceOf(Spacer);
		expect(presented[1]).toBeInstanceOf(CollabQrCodeComponent);
		const component = presented[1] as CollabQrCodeComponent;
		expect(component.url).toBe("https://my.omp.sh/#started-full");
		expect(component.render(120).join("\n")).toMatch(/\x1b\[(?:47|40)m/);
	});

	it("starts hosting and prints a one-shot read-only QR", async () => {
		const harness = createRuntimeHarness();

		const handled = await executeBuiltinSlashCommand("/collab view", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.start).toHaveBeenCalledWith({
			relayUrl: "wss://relay.example.com",
			webUrl: "",
			publish: "view",
		});
		const statusText = harness.showStatus.mock.calls[0]?.[0] as string;
		expect(statusText).toContain("my.omp.sh/#started-view");
		expect(statusText).not.toContain("my.omp.sh/#started-full");
		const presented = harness.present.mock.calls[0]?.[0] as readonly unknown[];
		expect(presented[0]).toBeInstanceOf(Spacer);
		expect(presented[1]).toBeInstanceOf(CollabQrCodeComponent);
		const component = presented[1] as CollabQrCodeComponent;
		expect(component.url).toBe("https://my.omp.sh/#started-view");
	});

	it("prints the active full-control browser QR when hosting", async () => {
		const harness = createRuntimeHarness({ collabHost: fakeHost() });

		const handled = await executeBuiltinSlashCommand("/collab", harness.runtime);

		expect(handled).toBe(true);
		const statusText = harness.showStatus.mock.calls[0]?.[0] as string;
		expect(statusText).toContain("my.omp.sh/#full-control");
		const presented = harness.present.mock.calls[0]?.[0] as readonly unknown[];
		expect(presented[0]).toBeInstanceOf(Spacer);
		expect(presented[1]).toBeInstanceOf(CollabQrCodeComponent);
		const component = presented[1] as CollabQrCodeComponent;
		expect(component.render(120).join("\n")).toMatch(/\x1b\[(?:47|40)m/);
	});

	it("prints a one-shot read-only browser QR when hosting", async () => {
		const webLink = "https://my.omp.sh/#full-control";
		const webViewLink = "https://my.omp.sh/#read-only";
		const harness = createRuntimeHarness({ collabHost: fakeHost({ webLink, webViewLink }) });

		const handled = await executeBuiltinSlashCommand("/collab view", harness.runtime);

		expect(handled).toBe(true);
		const statusText = harness.showStatus.mock.calls[0]?.[0] as string;
		expect(statusText).toContain(webViewLink);
		expect(statusText).not.toContain(webLink);
		const presented = harness.present.mock.calls[0]?.[0] as readonly unknown[];
		expect(presented[0]).toBeInstanceOf(Spacer);
		expect(presented[1]).toBeInstanceOf(CollabQrCodeComponent);
		const component = presented[1] as CollabQrCodeComponent;
		expect(component.url).toBe(webViewLink);
		const clipped = component.render(10).join("\n");
		expect(visibleWidth(clipped)).toBeLessThanOrEqual(10);
		expect(clipped).toContain(webViewLink);
		expect(clipped).not.toContain("URL above");
	});

	it("keeps the browser URL on the first status row so transcript clipping cannot hide it", async () => {
		const webLink = `https://my.omp.sh/#${"long-collab-token".repeat(8)}`;
		const harness = createRuntimeHarness({ collabHost: fakeHost({ webLink }) });

		const handled = await executeBuiltinSlashCommand("/collab", harness.runtime);

		expect(handled).toBe(true);
		const statusText = harness.showStatus.mock.calls[0]?.[0] as string;
		const firstRow = new Text(statusText, 1, 0).render(80)[0] ?? "";
		expect(firstRow).toContain("Collab session active");
		expect(firstRow).toContain("Join in browser");
		expect(firstRow).toContain(webLink);
	});

	it("forces replacement when an explicit relay matches the active relay", async () => {
		const harness = createRuntimeHarness({ collabHost: fakeHost() });

		const handled = await executeBuiltinSlashCommand("/collab wss://relay.example.com", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.start).toHaveBeenCalledWith({
			relayUrl: "wss://relay.example.com",
			webUrl: "",
			publish: "control",
			forceReplacement: true,
		});
	});
});

describe("CollabQrCodeComponent transcript height clipping", () => {
	it("renders the full half-block symbol when the viewport allocates enough rows", () => {
		const component = new CollabQrCodeComponent("https://my.omp.sh/#clip-test");
		const full = component.render(120);
		expect(full.length).toBeGreaterThan(8);
		expect(full.join("\n")).toMatch(/\x1b\[(?:47|40)m/);

		component.setTranscriptAllocation(full.length);
		expect(component.render(120)).toEqual(full);
	});

	it("does not render a quiet-zone white line when the transcript clips to one row", () => {
		const component = new CollabQrCodeComponent("https://my.omp.sh/#clip-test");
		const full = component.render(120);
		const first = full[0] ?? "";
		expect(first).toMatch(/\x1b\[(?:47|40)m/);

		component.setTranscriptAllocation(1);
		const clipped = component.render(120);
		expect(clipped).toHaveLength(1);
		expect(clipped[0]).toContain("QR code hidden");
		expect(clipped[0]).toContain("viewport height 1");
		expect(clipped[0]).toContain("my.omp.sh/#clip-test");
		expect(clipped[0]).not.toContain("URL above");
		expect(clipped[0]).not.toMatch(/\x1b\[(?:47|40)m/);
	});

	it("keeps the browser URL as the emergency one-row transcript representation", () => {
		const component = new CollabQrCodeComponent("https://my.omp.sh/#clip-test");
		component.setTranscriptAllocation(1);
		const row = component.renderTranscriptBlockEmergencyRow(10);
		expect(visibleWidth(row)).toBeLessThanOrEqual(10);
		expect(row).toContain("https://my.omp.sh/#clip-test");
		expect(row).not.toContain("URL above");
	});
});
