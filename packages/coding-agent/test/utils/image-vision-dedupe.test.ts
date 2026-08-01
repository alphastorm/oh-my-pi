import { describe, expect, it } from "bun:test";
import {
	clearVisionRequestDedupe,
	imageQuestionKey,
	runVisionRequestOnce,
} from "@oh-my-pi/pi-coding-agent/utils/image-vision-dedupe";

describe("imageQuestionKey", () => {
	it("normalizes questions while keeping request identity private and policy-specific", () => {
		const first = imageQuestionKey("aGVsbG8=", "  WHAT   is visible?  ", "provider/model", "resize:on");
		const equivalent = imageQuestionKey("aGVsbG8=", "what is visible?", "provider/model", "resize:on");
		const differentPolicy = imageQuestionKey("aGVsbG8=", "what is visible?", "provider/model", "resize:off");

		expect(first).toBe(equivalent);
		expect(first).not.toBe(differentPolicy);
		expect(first).toMatch(/^[a-f0-9]{64}$/);
		expect(first).not.toContain("visible");
		expect(first).not.toContain("provider");
	});
});

describe("runVisionRequestOnce", () => {
	it("shares successful work only inside one logical turn", async () => {
		const sessionId = "success-session";
		let calls = 0;
		let reuses = 0;
		let resolve!: (value: string) => void;
		const request = () => {
			calls += 1;
			return new Promise<string>(done => {
				resolve = done;
			});
		};

		const first = runVisionRequestOnce(sessionId, "inspect_image", "turn-1", "key", request);
		const duplicate = runVisionRequestOnce(sessionId, "inspect_image", "turn-1", "key", request, () => {
			reuses += 1;
		});
		expect(calls).toBe(1);
		resolve("answer");
		expect(await Promise.all([first, duplicate])).toEqual(["answer", "answer"]);
		expect(reuses).toBe(1);

		const later = runVisionRequestOnce(sessionId, "inspect_image", "turn-2", "key", async () => {
			calls += 1;
			return "later";
		});
		expect(await later).toBe("later");
		expect(calls).toBe(2);
		clearVisionRequestDedupe(sessionId);
	});

	it("keeps attachment and inspect-image scope changes isolated", async () => {
		const sessionId = "mixed-session";
		let attachmentCalls = 0;
		let attachmentReuses = 0;
		let resolveAttachment!: (value: string) => void;
		const attachmentRequest = () => {
			attachmentCalls += 1;
			return new Promise<string>(done => {
				resolveAttachment = done;
			});
		};
		const first = runVisionRequestOnce(sessionId, "attachment", "attachment-scope", "key", attachmentRequest);
		const inspect = runVisionRequestOnce(sessionId, "inspect_image", "inspect-scope", "key", async () => "inspect");
		const duplicate = runVisionRequestOnce(
			sessionId,
			"attachment",
			"attachment-scope",
			"key",
			attachmentRequest,
			() => {
				attachmentReuses += 1;
			},
		);
		expect(attachmentCalls).toBe(1);
		expect(attachmentReuses).toBe(1);
		resolveAttachment("attachment");
		expect(await Promise.all([first, inspect, duplicate])).toEqual(["attachment", "inspect", "attachment"]);
		clearVisionRequestDedupe(sessionId);
	});

	it("retains qualification failures for duplicate calls in the same scope", async () => {
		const sessionId = "retained-failure-session";
		let calls = 0;
		let reuses = 0;
		const request = async () => {
			calls += 1;
			throw new Error("provider failed");
		};
		const first = runVisionRequestOnce(sessionId, "attachment", "turn-1", "key", request, undefined, true);
		const duplicate = runVisionRequestOnce(
			sessionId,
			"attachment",
			"turn-1",
			"key",
			request,
			() => {
				reuses += 1;
			},
			true,
		);
		const outcomes = await Promise.allSettled([first, duplicate]);
		expect(outcomes.map(outcome => outcome.status)).toEqual(["rejected", "rejected"]);
		expect(calls).toBe(1);
		expect(reuses).toBe(1);
		clearVisionRequestDedupe(sessionId);
	});

	it("evicts failed requests so a later attempt can retry", async () => {
		const sessionId = "failure-session";
		let calls = 0;
		await expect(
			runVisionRequestOnce(sessionId, "inspect_image", "turn-1", "key", async () => {
				calls += 1;
				throw new Error("provider failed");
			}),
		).rejects.toThrow("provider failed");

		const retried = await runVisionRequestOnce(sessionId, "inspect_image", "turn-1", "key", async () => {
			calls += 1;
			return "recovered";
		});
		expect(retried).toBe("recovered");
		expect(calls).toBe(2);
		clearVisionRequestDedupe(sessionId);
	});
});
