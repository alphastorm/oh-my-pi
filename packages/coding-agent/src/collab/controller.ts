import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { InteractiveModeContext } from "../modes/types";
import { CollabHost } from "./host";
import {
	type CollabPublicationState,
	type CollabPublisherRecord,
	CollabRegistryPublisher,
	type PublishedCapabilityMode,
} from "./registry-publisher";

const MAX_PUBLISHED_LABEL_CODEPOINTS = 256;

function truncatePublishedLabel(value: string): string {
	const codePoints = Array.from(value);
	return codePoints.length <= MAX_PUBLISHED_LABEL_CODEPOINTS
		? value
		: codePoints.slice(0, MAX_PUBLISHED_LABEL_CODEPOINTS).join("");
}

export type CollabControllerState = "stopped" | "starting" | "running" | "stopping" | "faulted";
export type CollabControllerEvent = "started" | "updated" | "stopped" | "faulted";

export interface CollabCapabilities {
	readonly instanceId: string;
	readonly generation: number;
	readonly sessionId: string;
	readonly viewLink: string;
	readonly controlLink: string;
	readonly startedAt: string;
}

interface HostLike {
	readonly link: string;
	readonly viewLink: string;
	readonly participants: CollabHost["participants"];
	onFatal?: (reason: string) => void;
	start(relayUrl: string, webUrl?: string): Promise<void>;
	stop(reason: string): Promise<void>;
}

interface PublisherLike {
	publish(record: CollabPublisherRecord): void;
	remove(generation: number, reason: "stopped" | "shutdown" | "session_changed" | "faulted"): void;
	shutdown(generation: number | undefined): void;
	resume(): void;
	publicationState(): CollabPublicationState;
}

export interface CollabControllerOptions {
	readonly instanceId?: string;
	readonly hostFactory?: (context: InteractiveModeContext) => HostLike;
	readonly publisherFactory?: (
		instanceId: string,
		pid: number,
		endpointSetting: string,
		onSecurityError: (message: string) => void,
	) => PublisherLike;
}

export class CollabController {
	readonly #context: InteractiveModeContext;
	readonly #instanceId: string;
	readonly #hostFactory: (context: InteractiveModeContext) => HostLike;
	readonly #publisherFactory: NonNullable<CollabControllerOptions["publisherFactory"]>;
	readonly #listeners = new Map<CollabControllerEvent, Set<(capabilities?: CollabCapabilities) => void>>();
	#publisher: PublisherLike | undefined;
	#publisherEndpointSetting: string | undefined;
	#host: HostLike | undefined;
	#capabilities: CollabCapabilities | undefined;
	#queue: Promise<void> = Promise.resolve();
	#generation = 0;
	#inputRequired = false;
	#inputRequiredLeaseCount = 0;
	#inputRequiredEpoch = 0;
	#manualSuspended = false;
	#restartAfterSessionReplacement = false;
	#state: CollabControllerState = "stopped";
	#publicationMode: PublishedCapabilityMode = "off";
	#relayUrl = "";

	constructor(context: InteractiveModeContext, options: CollabControllerOptions = {}) {
		this.#context = context;
		this.#instanceId = options.instanceId ?? randomUUID();
		this.#hostFactory = options.hostFactory ?? (ctx => new CollabHost(ctx));
		this.#publisherFactory =
			options.publisherFactory ??
			((instanceId, pid, endpointSetting, onSecurityError) =>
				new CollabRegistryPublisher({ instanceId, pid, endpointSetting, onSecurityError }));
	}

	get state(): CollabControllerState {
		return this.#state;
	}

	get host(): CollabHost | undefined {
		return this.#host as CollabHost | undefined;
	}

	status(): CollabCapabilities | undefined {
		return this.#capabilities;
	}

	/** Directory publication state for `/collab status`. */
	publicationState(): CollabPublicationState {
		return this.#publisher?.publicationState() ?? { kind: "off" };
	}

	on(event: CollabControllerEvent, listener: (capabilities?: CollabCapabilities) => void): () => void {
		let listeners = this.#listeners.get(event);
		if (!listeners) {
			listeners = new Set();
			this.#listeners.set(event, listeners);
		}
		listeners.add(listener);
		return () => listeners?.delete(listener);
	}
	beginInputRequired(): () => void {
		if (this.#state !== "running" || !this.#capabilities) return () => {};
		const epoch = this.#inputRequiredEpoch;
		this.#inputRequiredLeaseCount += 1;
		if (this.#inputRequiredLeaseCount === 1) this.#transitionInputRequired(epoch, true);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			if (epoch !== this.#inputRequiredEpoch || this.#inputRequiredLeaseCount === 0) return;
			this.#inputRequiredLeaseCount -= 1;
			if (this.#inputRequiredLeaseCount === 0) this.#transitionInputRequired(epoch, false);
		};
	}

	start(
		options: {
			relayUrl?: string;
			webUrl?: string;
			publish?: PublishedCapabilityMode;
			forceReplacement?: boolean;
		} = {},
	): Promise<CollabCapabilities> {
		return this.#serialize(async () => {
			this.#manualSuspended = false;
			return this.#start({ ...options, resumePublisher: true });
		});
	}

	stop(reason = "host stopped", manual = true): Promise<void> {
		return this.#serialize(async () => {
			if (manual) this.#manualSuspended = true;
			await this.#stop(reason, reason === "session changed" ? "session_changed" : "stopped");
		});
	}

	/**
	 * Manual `/collab` on a session that is already hosting: clear a latched
	 * publisher and re-announce the current capabilities without restarting the
	 * host. That is the path a user whose session went silent actually takes, and
	 * it never reaches `start()`.
	 */
	resumePublication(): Promise<void> {
		return this.#serialize(async () => {
			const capabilities = this.#capabilities;
			const mode = this.#publicationMode;
			if (capabilities && mode !== "off") this.#publish(capabilities, mode, true);
		});
	}

	autoStart(): Promise<void> {
		return this.#serialize(async () => {
			const mode = this.#autoMode();
			if (mode === "off" || this.#manualSuspended || this.#host) return;
			try {
				await this.#start({ publish: mode });
			} catch {
				this.#context.showWarning("Automatic collaboration could not connect; normal OMP operation is unaffected.");
			}
		});
	}

	refreshMetadata(): Promise<void> {
		return this.#serialize(async () => {
			const capabilities = this.#capabilities;
			const mode = this.#publicationMode;
			if (!capabilities || mode === "off") return;
			this.#publish(capabilities, mode);
			this.#emit("updated", capabilities);
		});
	}

	prepareActiveSessionReplacement(): Promise<void> {
		return this.#serialize(async () => {
			this.#restartAfterSessionReplacement = this.#restartAfterSessionReplacement || this.#autoMode() !== "off";
			await this.#stop("session changed", "session_changed");
			this.#manualSuspended = false;
		});
	}

	restoreActiveSession(): Promise<void> {
		return this.#serialize(async () => {
			const restart = this.#restartAfterSessionReplacement;
			this.#restartAfterSessionReplacement = false;
			if (!restart) return;
			try {
				await this.#start({ publish: this.#autoMode() });
			} catch {
				this.#context.showWarning("Collaboration did not restart for the active session.");
			}
		});
	}

	async replaceActiveSession(): Promise<void> {
		await this.prepareActiveSessionReplacement();
		await this.restoreActiveSession();
	}

	shutdown(): Promise<void> {
		return this.#serialize(async () => {
			this.#restartAfterSessionReplacement = false;
			const generation = this.#capabilities?.generation;
			await this.#stop("OMP shutdown", "shutdown");
			this.#publisher?.shutdown(generation);
			this.#publisher = undefined;
			this.#publisherEndpointSetting = undefined;
		});
	}

	async #start(options: {
		relayUrl?: string;
		webUrl?: string;
		publish?: PublishedCapabilityMode;
		forceReplacement?: boolean;
		resumePublisher?: boolean;
	}): Promise<CollabCapabilities> {
		const relayInput = options.relayUrl ?? this.#context.settings.get("collab.relayUrl") ?? "";
		if (!relayInput) throw new Error("No collaboration relay is configured");
		const relayUrl = relayInput.includes("://") ? relayInput : `wss://${relayInput}`;
		const publish = options.publish ?? this.#autoMode();
		if (!options.forceReplacement && this.#host && relayUrl === this.#relayUrl && this.#capabilities) {
			if (publish !== this.#publicationMode) {
				this.#publisher?.remove(this.#capabilities.generation, "session_changed");
				this.#publicationMode = publish;
				if (publish !== "off") this.#publish(this.#capabilities, publish, options.resumePublisher);
				this.#emit("updated", this.#capabilities);
			} else if (publish !== "off" && options.resumePublisher) {
				this.#publish(this.#capabilities, publish, true);
				this.#emit("updated", this.#capabilities);
			}
			return this.#capabilities;
		}
		if (this.#host) await this.#stop("relay replaced", "session_changed");

		this.#state = "starting";
		this.#generation += 1;
		const generation = this.#generation;
		const host = this.#hostFactory(this.#context);
		host.onFatal = reason => void this.#handleFatal(host, generation, reason);
		try {
			await host.start(relayUrl, options.webUrl ?? this.#context.settings.get("collab.webUrl") ?? "");
		} catch (error) {
			this.#state = "faulted";
			this.#emit("faulted");
			throw error;
		}

		const capabilities: CollabCapabilities = {
			instanceId: this.#instanceId,
			generation,
			sessionId: this.#context.sessionManager.getSessionId(),
			viewLink: host.viewLink,
			controlLink: host.link,
			startedAt: new Date().toISOString(),
		};
		this.#host = host;
		this.#relayUrl = relayUrl;
		this.#capabilities = capabilities;
		this.#state = "running";
		this.#publicationMode = publish;
		if (publish !== "off") this.#publish(capabilities, publish, options.resumePublisher);
		this.#emit("started", capabilities);
		return capabilities;
	}

	async #stop(reason: string, publisherReason: "stopped" | "shutdown" | "session_changed" | "faulted"): Promise<void> {
		const host = this.#host;
		const capabilities = this.#capabilities;
		const publicationMode = this.#publicationMode;
		this.#resetInputRequired(capabilities, publicationMode);
		if (!host || !capabilities) {
			this.#state = "stopped";
			this.#publicationMode = "off";
			return;
		}
		this.#state = "stopping";
		this.#publisher?.remove(capabilities.generation, publisherReason);
		this.#capabilities = undefined;
		this.#host = undefined;
		this.#publicationMode = "off";
		await host.stop(reason);
		this.#state = "stopped";
		this.#emit("stopped");
	}

	#publish(capabilities: CollabCapabilities, mode: Exclude<PublishedCapabilityMode, "off">, resume = false): void {
		const endpointSetting = this.#context.settings.get("collab.registryEndpoint") ?? "auto";
		if (this.#publisher && this.#publisherEndpointSetting !== endpointSetting) {
			this.#publisher.shutdown(capabilities.generation);
			this.#publisher = undefined;
			this.#publisherEndpointSetting = undefined;
		}
		if (endpointSetting === "off") return;
		if (!this.#publisher) {
			this.#publisher = this.#publisherFactory(this.#instanceId, process.pid, endpointSetting, message => {
				this.#context.showWarning(message);
			});
			this.#publisherEndpointSetting = endpointSetting;
		}
		if (resume) this.#publisher.resume();
		this.#publisher.publish({
			instanceId: capabilities.instanceId,
			generation: capabilities.generation,
			pid: process.pid,
			sessionId: capabilities.sessionId,
			...(this.#context.sessionName ? { title: truncatePublishedLabel(this.#context.sessionName) } : {}),
			cwdLabel: truncatePublishedLabel(basename(this.#context.sessionManager.getCwd())),
			...(this.#context.session.model
				? {
						model: truncatePublishedLabel(
							`${this.#context.session.model.provider}/${this.#context.session.model.id}`,
						),
					}
				: {}),
			startedAt: capabilities.startedAt,
			inputRequired: this.#inputRequired,
			viewLink: capabilities.viewLink,
			...(mode === "control" ? { controlLink: capabilities.controlLink } : {}),
		});
	}

	#autoMode(): PublishedCapabilityMode {
		return this.#context.settings.get("collab.autoStart") ?? "off";
	}

	#handleFatal(host: HostLike, generation: number, _reason: string): Promise<void> {
		return this.#serialize(async () => {
			if (this.#host !== host || this.#capabilities?.generation !== generation) return;
			const capabilities = this.#capabilities;
			this.#resetInputRequired(capabilities, this.#publicationMode);
			this.#publisher?.remove(generation, "faulted");
			this.#host = undefined;
			this.#capabilities = undefined;
			this.#publicationMode = "off";
			this.#state = "faulted";
			this.#emit("faulted");
		});
	}

	#transitionInputRequired(epoch: number, desired: boolean): void {
		if (epoch !== this.#inputRequiredEpoch || desired === this.#inputRequired) return;
		this.#inputRequired = desired;
		void this.#serialize(async () => {
			const capabilities = this.#capabilities;
			const mode = this.#publicationMode;
			if (epoch !== this.#inputRequiredEpoch || this.#inputRequired !== desired || !capabilities || mode === "off") {
				return;
			}
			this.#publish(capabilities, mode);
			this.#emit("updated", capabilities);
		});
	}

	#resetInputRequired(capabilities: CollabCapabilities | undefined, mode: PublishedCapabilityMode): void {
		const changed = this.#inputRequired;
		this.#inputRequiredEpoch += 1;
		this.#inputRequiredLeaseCount = 0;
		this.#inputRequired = false;
		if (changed && capabilities && mode !== "off") {
			this.#publish(capabilities, mode);
			this.#emit("updated", capabilities);
		}
	}

	#emit(event: CollabControllerEvent, capabilities?: CollabCapabilities): void {
		for (const listener of this.#listeners.get(event) ?? []) listener(capabilities);
	}

	#serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
		const next = this.#queue.then(operation, operation);
		this.#queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}
}
