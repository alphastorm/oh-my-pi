import { describe, expect, test } from "bun:test";
import { CollabController } from "../../src/collab/controller";
import type { CollabPublicationState, CollabPublisherRecord } from "../../src/collab/registry-publisher";
import type { InteractiveModeContext } from "../../src/modes/types";

class FakeHost {
	readonly link = "CONTROL_CAPABILITY_FIXTURE";
	readonly viewLink = "VIEW_CAPABILITY_FIXTURE";
	readonly webLink = "https://example.invalid/client";
	readonly webViewLink = "https://example.invalid/client-view";
	readonly participants = [{ name: "host", role: "host" as const }];
	onFatal?: (reason: string) => void;
	starts = 0;
	stops = 0;

	async start(): Promise<void> {
		this.starts += 1;
	}

	async stop(): Promise<void> {
		this.stops += 1;
	}
}

function harness(autoStart: "off" | "view" | "control") {
	const values: Record<string, string> = {
		"collab.autoStart": autoStart,
		"collab.registryEndpoint": "auto",
		"collab.relayUrl": "wss://relay.example.invalid",
		"collab.webUrl": "",
	};
	let sessionName: string | undefined = "Test session";
	let cwd = "/work/repository";
	let model: { provider: string; id: string } | undefined = { provider: "anthropic", id: "claude-sonnet-4-5" };
	const warnings: string[] = [];
	const context = {
		settings: { get: (key: string) => values[key] },
		sessionManager: {
			getSessionId: () => "session-id",
			getCwd: () => cwd,
		},
		session: {
			get model() {
				return model;
			},
		},
		get sessionName() {
			return sessionName;
		},
		showWarning: (message: string) => warnings.push(message),
	} as unknown as InteractiveModeContext;
	const hosts: FakeHost[] = [];
	const events: Array<{ type: string; generation: number }> = [];
	const published: CollabPublisherRecord[] = [];
	const operations: Array<
		{ type: "publish"; record: CollabPublisherRecord } | { type: "remove"; generation: number }
	> = [];
	let publication: CollabPublicationState = { kind: "off" };
	let lastPublished: CollabPublisherRecord | undefined;
	let resumes = 0;
	const publisherEndpoints: string[] = [];
	const publisherShutdowns: Array<{ endpoint: string; generation: number | undefined }> = [];
	const controller = new CollabController(context, {
		instanceId: "test-instance-id",
		hostFactory: () => {
			const host = new FakeHost();
			hosts.push(host);
			return host;
		},
		publisherFactory: (_instanceId, _pid, endpointSetting) => {
			publisherEndpoints.push(endpointSetting);
			return {
				publish(record: CollabPublisherRecord) {
					lastPublished = { ...record };
					publication = { kind: "publishing" };
					published.push({ ...record });
					operations.push({ type: "publish", record: { ...record } });
					events.push({
						type: record.controlLink ? "publish-control" : "publish-view",
						generation: record.generation,
					});
				},
				remove(generation: number) {
					events.push({ type: "remove", generation });
					operations.push({ type: "remove", generation });
				},
				shutdown(generation: number | undefined) {
					publisherShutdowns.push({ endpoint: endpointSetting, generation });
					lastPublished = undefined;
					publication = { kind: "off" };
				},
				resume() {
					resumes += 1;
					publication = lastPublished ? { kind: "publishing" } : { kind: "off" };
				},
				publicationState() {
					return publication;
				},
			};
		},
	});
	return {
		context,
		controller,
		hosts,
		events,
		published,
		operations,
		warnings,
		publisherEndpoints,
		publisherShutdowns,
		latchPublisher(reason: string) {
			publication = { kind: "disabled", reason };
		},
		resumeCount: () => resumes,
		setRegistryEndpoint(endpoint: string) {
			values["collab.registryEndpoint"] = endpoint;
		},
		setMetadata(next: { sessionName?: string; cwd?: string; model?: { provider: string; id: string } | undefined }) {
			if ("sessionName" in next) sessionName = next.sessionName;
			if ("cwd" in next && next.cwd !== undefined) cwd = next.cwd;
			if ("model" in next) model = next.model;
		},
	};
}
function nextUpdated(controller: InstanceType<typeof CollabController>): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	let unsubscribe = (): void => {};
	unsubscribe = controller.on("updated", () => {
		unsubscribe();
		resolve();
	});
	return promise;
}

describe("CollabController", () => {
	test("off preserves startup behavior", async () => {
		const { controller, hosts } = harness("off");
		await controller.autoStart();
		expect(hosts).toHaveLength(0);
	});

	test("serializes concurrent starts around exactly one host", async () => {
		const { controller, hosts } = harness("control");
		await Promise.all([controller.start(), controller.start(), controller.start()]);
		expect(hosts).toHaveLength(1);
		expect(hosts[0]?.starts).toBe(1);
	});

	test("view auto-start publishes no control capability", async () => {
		const { controller, events } = harness("view");
		await controller.autoStart();
		expect(events).toEqual([{ type: "publish-view", generation: 1 }]);
	});
	test("publishes only first and last generation-scoped input-required lease transitions", async () => {
		const { controller, published } = harness("control");
		await controller.autoStart();
		expect(published.map(record => record.inputRequired)).toEqual([false]);

		const required = nextUpdated(controller);
		const releaseFirst = controller.beginInputRequired();
		const releaseSecond = controller.beginInputRequired();
		await required;
		expect(published.map(record => record.inputRequired)).toEqual([false, true]);

		await controller.refreshMetadata();
		expect(published.at(-1)?.inputRequired).toBe(true);
		const beforeIntermediateRelease = published.length;
		releaseFirst();
		expect(published).toHaveLength(beforeIntermediateRelease);

		const cleared = nextUpdated(controller);
		releaseSecond();
		await cleared;
		expect(published.at(-1)?.inputRequired).toBe(false);
		const afterClear = published.length;
		releaseSecond();
		expect(published).toHaveLength(afterClear);
	});

	test("clears before replacement removal and ignores a stale generation lease release", async () => {
		const { controller, operations, published } = harness("control");
		await controller.autoStart();
		const required = nextUpdated(controller);
		const staleRelease = controller.beginInputRequired();
		await required;

		await controller.prepareActiveSessionReplacement();
		expect(published.map(record => record.inputRequired)).toEqual([false, true, false]);
		expect(operations.at(-2)).toMatchObject({
			type: "publish",
			record: { generation: 1, inputRequired: false },
		});
		expect(operations.at(-1)).toEqual({ type: "remove", generation: 1 });

		await controller.restoreActiveSession();
		expect(published.at(-1)).toMatchObject({ generation: 2, inputRequired: false });
		const beforeStaleRelease = published.length;
		staleRelease();
		expect(published).toHaveLength(beforeStaleRelease);
	});

	test("refreshes same-generation title, cwd, and model metadata without rotating capabilities", async () => {
		const { controller, events, published, setMetadata } = harness("control");
		await controller.autoStart();
		expect(published[0]).toMatchObject({
			generation: 1,
			title: "Test session",
			cwdLabel: "repository",
			model: "anthropic/claude-sonnet-4-5",
		});

		setMetadata({
			sessionName: "Renamed session",
			cwd: "/work/other-project",
			model: { provider: "openai", id: "gpt-5.4" },
		});
		await controller.refreshMetadata();

		expect(published).toHaveLength(2);
		expect(published[1]).toMatchObject({
			instanceId: published[0]?.instanceId,
			sessionId: published[0]?.sessionId,
			generation: 1,
			title: "Renamed session",
			cwdLabel: "other-project",
			model: "openai/gpt-5.4",
			viewLink: "VIEW_CAPABILITY_FIXTURE",
			controlLink: "CONTROL_CAPABILITY_FIXTURE",
		});
		expect(events).toEqual([
			{ type: "publish-control", generation: 1 },
			{ type: "publish-control", generation: 1 },
		]);

		await controller.stop();
		await controller.refreshMetadata();
		expect(published).toHaveLength(2);
		expect(events.at(-1)).toEqual({ type: "remove", generation: 1 });
	});
	test("revokes a deselected registry and rebinds publication to the replacement endpoint", async () => {
		const { controller, published, publisherEndpoints, publisherShutdowns, setRegistryEndpoint } = harness("control");
		setRegistryEndpoint("/tmp/registry-a.sock");
		await controller.autoStart();
		expect(publisherEndpoints).toEqual(["/tmp/registry-a.sock"]);

		setRegistryEndpoint("off");
		await controller.refreshMetadata();
		expect(publisherShutdowns).toEqual([{ endpoint: "/tmp/registry-a.sock", generation: 1 }]);
		expect(controller.publicationState()).toEqual({ kind: "off" });
		const publishedBeforeReplacement = published.length;

		setRegistryEndpoint("/tmp/registry-b.sock");
		await controller.refreshMetadata();
		expect(publisherEndpoints).toEqual(["/tmp/registry-a.sock", "/tmp/registry-b.sock"]);
		expect(published).toHaveLength(publishedBeforeReplacement + 1);
	});

	test("bounds refreshed metadata labels to the gateway protocol limit", async () => {
		const { controller, published, setMetadata } = harness("control");
		setMetadata({
			sessionName: "🙂".repeat(300),
			cwd: `/work/${"c".repeat(300)}`,
			model: { provider: "p".repeat(200), id: "m".repeat(200) },
		});
		await controller.autoStart();

		const record = published[0];
		expect(Array.from(record?.title ?? "")).toHaveLength(256);
		expect(Array.from(record?.cwdLabel ?? "")).toHaveLength(256);
		expect(Array.from(record?.model ?? "")).toHaveLength(256);
	});

	test("replacement revokes generation N before session mutation and publishes N+1 afterward", async () => {
		const { controller, events } = harness("control");
		await controller.autoStart();
		await controller.prepareActiveSessionReplacement();
		expect(controller.state).toBe("stopped");
		expect(events).toEqual([
			{ type: "publish-control", generation: 1 },
			{ type: "remove", generation: 1 },
		]);
		await controller.restoreActiveSession();
		expect(events).toEqual([
			{ type: "publish-control", generation: 1 },
			{ type: "remove", generation: 1 },
			{ type: "publish-control", generation: 2 },
		]);
	});

	test("manual collaboration stays stopped across replacement when auto-start is off", async () => {
		const { controller, hosts } = harness("off");
		await controller.start();
		await controller.prepareActiveSessionReplacement();
		await controller.restoreActiveSession();
		expect(controller.state).toBe("stopped");
		expect(hosts).toHaveLength(1);
		expect(hosts[0]?.stops).toBe(1);
	});

	test("same-relay publication mode changes revoke before republishing", async () => {
		const { controller, hosts, events } = harness("off");
		await controller.start({ publish: "control" });
		await controller.start({ relayUrl: "wss://relay.example.invalid", publish: "view" });
		expect(hosts).toHaveLength(1);
		expect(events).toEqual([
			{ type: "publish-control", generation: 1 },
			{ type: "remove", generation: 1 },
			{ type: "publish-view", generation: 1 },
		]);
	});

	test("explicit same-relay starts replace the host and generation", async () => {
		const { controller, hosts, events } = harness("off");
		await controller.start({ publish: "control" });
		await controller.start({
			relayUrl: "wss://relay.example.invalid",
			publish: "control",
			forceReplacement: true,
		});
		expect(hosts).toHaveLength(2);
		expect(hosts[0]?.stops).toBe(1);
		expect(events).toEqual([
			{ type: "publish-control", generation: 1 },
			{ type: "remove", generation: 1 },
			{ type: "publish-control", generation: 2 },
		]);
	});

	test("manual stop unregisters and suspends only the current generation", async () => {
		const { controller, events } = harness("control");
		await controller.autoStart();
		await controller.stop();
		expect(events.at(-1)).toEqual({ type: "remove", generation: 1 });
		await controller.autoStart();
		expect(controller.state).toBe("stopped");
		await controller.replaceActiveSession();
		expect(controller.state).toBe("running");
	});

	test("fatal host closure unregisters immediately", async () => {
		const { controller, hosts, events, operations, published } = harness("control");
		await controller.autoStart();
		const required = nextUpdated(controller);
		const staleRelease = controller.beginInputRequired();
		await required;
		const faulted = Promise.withResolvers<void>();
		controller.on("faulted", () => faulted.resolve());
		hosts[0]?.onFatal?.("relay failed");
		await faulted.promise;
		expect(published.at(-1)?.inputRequired).toBe(false);
		expect(operations.at(-2)).toMatchObject({
			type: "publish",
			record: { generation: 1, inputRequired: false },
		});
		expect(operations.at(-1)).toEqual({ type: "remove", generation: 1 });
		expect(events.at(-1)).toEqual({ type: "remove", generation: 1 });
		expect(controller.state).toBe("faulted");
		const beforeStaleRelease = published.length;
		staleRelease();
		expect(published).toHaveLength(beforeStaleRelease);
	});

	test("publication state is reported and only a manual start clears a latch", async () => {
		const { controller, latchPublisher, resumeCount } = harness("control");
		expect(controller.publicationState()).toEqual({ kind: "off" });
		await controller.autoStart();
		expect(controller.publicationState()).toEqual({ kind: "publishing" });

		latchPublisher("unsafe OMP Session Gateway registry endpoint");
		expect(controller.publicationState()).toEqual({
			kind: "disabled",
			reason: "unsafe OMP Session Gateway registry endpoint",
		});

		// Auto-start keeps its caution: it must not clear a latch on its own.
		await controller.autoStart();
		expect(resumeCount()).toBe(0);
		expect(controller.publicationState().kind).toBe("disabled");

		await controller.start({ publish: "control" });
		expect(resumeCount()).toBe(1);
		expect(controller.publicationState()).toEqual({ kind: "publishing" });
	});

	test("resumePublication re-announces a hosting session without restarting the host", async () => {
		const { controller, hosts, latchPublisher, resumeCount, operations } = harness("control");
		await controller.autoStart();
		latchPublisher("unsafe OMP Session Gateway registry endpoint");
		const before = operations.length;

		await controller.resumePublication();
		expect(resumeCount()).toBe(1);
		expect(hosts).toHaveLength(1);
		expect(hosts[0]?.stops).toBe(0);
		expect(operations.slice(before)).toMatchObject([{ type: "publish", record: { generation: 1 } }]);
		expect(controller.publicationState()).toEqual({ kind: "publishing" });
	});
});
