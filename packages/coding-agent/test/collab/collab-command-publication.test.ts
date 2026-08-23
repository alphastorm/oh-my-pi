import { beforeAll, expect, test } from "bun:test";
import type { CollabPublicationState } from "../../src/collab/registry-publisher";
import { initTheme } from "../../src/modes/theme/theme";
import type { InteractiveModeContext } from "../../src/modes/types";
import { lookupBuiltinSlashCommand } from "../../src/slash-commands/builtin-registry";

/**
 * A host can be perfectly healthy on the relay while its gateway publication is
 * retrying or latched off. `/collab status` is the only place that state is
 * observable — the publisher's single warning is long gone from scrollback — and
 * a bare `/collab` on an already-hosting session is the only recovery short of
 * restarting OMP, so it must reach the controller rather than return early.
 */

// Resolved through the registry: importing the collab module directly trips the
// builtin-modes import cycle before the registry finishes initializing.
const collabCommand = lookupBuiltinSlashCommand("collab");
const SGR_PATTERN = /\x1b\[[0-9;]*m/gu;

function harness(publication: CollabPublicationState) {
	const statuses: string[] = [];
	let resumes = 0;
	const ctx = {
		editor: { setText() {} },
		present() {},
		showStatus: (message: string) => statuses.push(message.replace(SGR_PATTERN, "")),
		showError: (message: string) => statuses.push(`ERROR ${message}`),
		settings: { get: () => "" },
		collabController: {
			host: {
				participants: [{ name: "host", role: "host" as const }],
				link: "CONTROL_CAPABILITY_FIXTURE",
				viewLink: "VIEW_CAPABILITY_FIXTURE",
				webLink: "https://example.invalid/client",
				webViewLink: "https://example.invalid/client-view",
			},
			publicationState: () => publication,
			resumePublication: async () => {
				resumes += 1;
			},
		},
	} as unknown as InteractiveModeContext;
	return {
		statuses,
		resumeCount: () => resumes,
		run: async (args: string) => {
			await collabCommand?.handleTui?.({ name: "collab", args, text: `/collab ${args}`.trimEnd() }, {
				ctx,
			} as never);
			return statuses.join("\n");
		},
	};
}

beforeAll(async () => {
	await initTheme();
});

test("/collab status names a latched publisher and how to clear it", async () => {
	const collab = harness({ kind: "disabled", reason: "unsafe OMP Session Gateway registry endpoint" });
	const rendered = await collab.run("status");
	expect(rendered).toContain("Session directory: disabled — unsafe OMP Session Gateway registry endpoint");
	expect(rendered).toContain("Run /collab to clear it and retry publication.");
});

test("/collab status distinguishes publishing from retrying", async () => {
	expect(await harness({ kind: "publishing" }).run("status")).toContain("Session directory: publishing");
	expect(await harness({ kind: "retrying", attempt: 3, reason: "EACCES" }).run("status")).toContain(
		"Session directory: retrying (attempt 3: EACCES)",
	);
	expect(await harness({ kind: "off" }).run("status")).toContain("Session directory: not published");
});

test("a bare /collab on a hosting session clears the latch instead of only reprinting the link", async () => {
	const collab = harness({ kind: "disabled", reason: "unsafe OMP Session Gateway registry endpoint" });
	const rendered = await collab.run("");
	expect(collab.resumeCount()).toBe(1);
	expect(rendered).toContain("Collab session active");
});
