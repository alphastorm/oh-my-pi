import { createHash } from "node:crypto";

/**
 * Collapse identical requests within one logical turn. The key is a SHA-256
 * digest over the image, normalized question, selected model, and resize
 * policy; no prompt, model id, or image bytes are retained as identity.
 * The resolved promise remains cached only until the scope changes; failed
 * work is evicted at once.
 */
export type VisionRequestChannel = "attachment" | "inspect_image";
type VisionRequestScope = {
	scopeId?: string;
	requests: Map<string, Promise<unknown>>;
};
const requestsBySession = new Map<string, Map<VisionRequestChannel, VisionRequestScope>>();

export function imageQuestionKey(base64Image: string, question: string, model: string, resizePolicy: string): string {
	const normalizedQuestion = question.trim().replace(/\s+/g, " ").toLowerCase();
	const identity = createHash("sha256").update(base64Image, "base64");
	for (const component of [normalizedQuestion, model, resizePolicy]) {
		identity
			.update("\0")
			.update(String(Buffer.byteLength(component)))
			.update(":")
			.update(component);
	}
	return identity.digest("hex");
}

export function runVisionRequestOnce<T>(
	sessionId: string | undefined,
	channel: VisionRequestChannel,
	scopeId: string | undefined,
	key: string,
	request: () => Promise<T>,
	onReuse?: () => void,
	retainFailure = false,
): Promise<T> {
	if (!sessionId) return request();
	let channels = requestsBySession.get(sessionId);
	if (!channels) {
		channels = new Map();
		requestsBySession.set(sessionId, channels);
	}
	let scope = channels.get(channel);
	if (!scope || scope.scopeId !== scopeId) {
		scope = { scopeId, requests: new Map() };
		channels.set(channel, scope);
	}
	const existing = scope.requests.get(key);
	if (existing) {
		onReuse?.();
		return existing as Promise<T>;
	}
	const pending = request();
	scope.requests.set(key, pending);
	const evict = () => {
		const currentChannels = requestsBySession.get(sessionId);
		const current = currentChannels?.get(channel);
		if (!current || current.requests.get(key) !== pending) return;
		current.requests.delete(key);
		if (current.requests.size === 0) currentChannels?.delete(channel);
		if (currentChannels?.size === 0) requestsBySession.delete(sessionId);
	};
	if (scopeId === undefined) {
		void pending.then(evict, evict);
	} else if (!retainFailure) {
		void pending.catch(evict);
	}
	return pending;
}

/** Clear request identity when a live session is permanently disposed. */
export function clearVisionRequestDedupe(sessionId: string): void {
	requestsBySession.delete(sessionId);
}
