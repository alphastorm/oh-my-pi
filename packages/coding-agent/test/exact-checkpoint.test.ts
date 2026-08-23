import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import {
	type ExactCheckpointAuthority,
	ExactCheckpointError,
	exactCheckpointDigest,
	loadExactCheckpoint,
	MAX_EXACT_CHECKPOINT_TTL_MS,
} from "@oh-my-pi/pi-coding-agent/session/exact-checkpoint";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return path.resolve(dir.path());
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

function authority(cwd: string): ExactCheckpointAuthority {
	return {
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		accountWitness: exactCheckpointDigest({ account: "anonymous-a" }),
		promptCacheIdentity: exactCheckpointDigest({ cache: "cohort-a" }),
		requestProfileDigest: exactCheckpointDigest({ thinking: "high", tier: "standard" }),
		systemDigest: exactCheckpointDigest(["system-v1"]),
		contextDigest: exactCheckpointDigest({ project: "context-v1" }),
		toolDigest: exactCheckpointDigest(["read", "edit"]),
		xdevDigest: exactCheckpointDigest(["resolve"]),
		workspaceRoot: cwd,
		repositoryBaseOid: "1".repeat(40),
	};
}

function assistantMessage(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

async function expectCheckpointError(
	operation: Promise<unknown>,
	code: ExactCheckpointError["code"],
	mismatch?: keyof ExactCheckpointAuthority,
): Promise<void> {
	try {
		await operation;
		expect.unreachable(`Expected checkpoint error ${code}`);
	} catch (error) {
		expect(error).toBeInstanceOf(ExactCheckpointError);
		const checkpointError = error as ExactCheckpointError;
		expect(checkpointError.code).toBe(code);
		if (mismatch) expect(checkpointError.mismatches).toContain(mismatch);
	}
}

async function createCommittedCheckpoint(cwd: string, checkpointPath: string) {
	const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
	manager.appendMessage({ role: "user", content: "portable question", timestamp: 1_000 });
	manager.appendMessage(assistantMessage("portable answer", 2_000));
	const receipt = await manager.createExactCheckpoint({
		authority: authority(cwd),
		checkpointPath,
		boundary: { streaming: false, committed: true },
	});
	return { manager, receipt };
}

async function rewriteChecksummedCheckpoint(
	checkpointPath: string,
	mutate: (envelope: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
	const envelope = JSON.parse(await fs.readFile(checkpointPath, "utf8")) as Record<string, unknown>;
	mutate(envelope);
	const { integritySha256: _integritySha256, ...unsigned } = envelope;
	envelope.integritySha256 = exactCheckpointDigest(unsigned);
	await fs.writeFile(checkpointPath, `${JSON.stringify(envelope)}\n`);
	return envelope;
}

describe("exact_checkpoint_v1", () => {
	it("round-trips canonical typed history and compaction accounting through a fresh session path", async () => {
		const cwd = makeTempDir("omp-exact-roundtrip-");
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		manager.appendMessage({ role: "user", content: "old question", timestamp: 1_000 });
		manager.appendMessage(assistantMessage("old answer", 2_000));
		const firstKeptEntryId = manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "kept question" }],
			timestamp: 3_000,
		});
		manager.appendMessage(assistantMessage("kept answer", 4_000));
		manager.appendCompaction("authoritative compacted history", "compacted history", firstKeptEntryId, 12_345, {
			preserveData: {
				openaiRemoteCompaction: {
					provider: "openai",
					replacementHistory: [{ id: "forbidden-provider-continuation" }],
				},
			},
		});
		const expectedMessages = manager.buildSessionContext({ portable: true }).messages;
		const checkpointPath = path.join(cwd, "portable", "roundtrip.json");
		const receipt = await manager.createExactCheckpoint({
			authority: authority(cwd),
			checkpointPath,
			boundary: { streaming: false, committed: true },
		});

		const envelope = await loadExactCheckpoint(checkpointPath, authority(cwd));
		expect(envelope.type).toBe("exact_checkpoint_v1");
		expect(envelope.schemaVersion).toBe(1);
		expect(envelope.compaction).toEqual({ epoch: 1, tokensBefore: 12_345 });
		expect(envelope.messages as readonly unknown[]).toEqual(expectedMessages);
		expect(JSON.stringify(envelope)).not.toContain("responseId");
		expect(JSON.stringify(envelope)).not.toContain("providerPayload");
		expect(JSON.stringify(envelope)).not.toContain("forbidden-provider-continuation");

		const resumed = await SessionManager.resumeExactCheckpoint(checkpointPath, authority(cwd), {
			expectedIntegritySha256: receipt.integritySha256,
			sessionDir: path.join(cwd, "successors"),
			claimRoot: path.join(cwd, "claims"),
		});
		expect(resumed.checkpointId).toBe(receipt.checkpointId);
		expect(resumed.sessionManager.getSessionId()).not.toBe(manager.getSessionId());
		expect(resumed.sessionManager.buildSessionContext().messages).toEqual(expectedMessages);
		expect(resumed.sessionManager.getCredentialPins().get("anthropic")?.hash ?? null).toBe(
			authority(cwd).accountWitness,
		);
		expect(resumed.sessionManager.getHeader()?.exactCheckpoint).toMatchObject({
			checkpointId: receipt.checkpointId,
			lineageId: manager.getSessionId(),
			mode: "resume",
			compactionEpoch: 1,
			compactionTokensBefore: 12_345,
		});
	});

	it("fails closed for every authoritative identity mismatch before consumption", async () => {
		const cwd = makeTempDir("omp-exact-mismatch-");
		const otherCwd = makeTempDir("omp-exact-mismatch-other-");
		const checkpointPath = path.join(cwd, "checkpoint.json");
		const { receipt } = await createCommittedCheckpoint(cwd, checkpointPath);
		const base = authority(cwd);
		const mismatches: Array<
			[keyof ExactCheckpointAuthority, ExactCheckpointAuthority[keyof ExactCheckpointAuthority]]
		> = [
			["provider", "openai"],
			["model", "different-model"],
			["accountWitness", exactCheckpointDigest("different-account")],
			["promptCacheIdentity", exactCheckpointDigest("different-cache")],
			["requestProfileDigest", exactCheckpointDigest("different-profile")],
			["systemDigest", exactCheckpointDigest("different-system")],
			["contextDigest", exactCheckpointDigest("different-context")],
			["toolDigest", exactCheckpointDigest("different-tools")],
			["xdevDigest", exactCheckpointDigest("different-xdev")],
			["workspaceRoot", otherCwd],
			["repositoryBaseOid", "2".repeat(40)],
		];
		for (const [field, value] of mismatches) {
			await expectCheckpointError(
				SessionManager.resumeExactCheckpoint(
					checkpointPath,
					{ ...base, [field]: value } as ExactCheckpointAuthority,
					{
						expectedIntegritySha256: receipt.integritySha256,
						sessionDir: path.join(cwd, "mismatch-successors"),
						claimRoot: path.join(cwd, "claims"),
					},
				),
				"authority_mismatch",
				field,
			);
		}
		const resumed = await SessionManager.resumeExactCheckpoint(checkpointPath, base, {
			expectedIntegritySha256: receipt.integritySha256,
			sessionDir: path.join(cwd, "mismatch-successors"),
			claimRoot: path.join(cwd, "claims"),
		});
		expect(resumed.sessionManager.buildSessionContext().messages).toHaveLength(2);
	});

	it("rejects expired, corrupt, partial, response-ID-bearing, and raw-secret-bearing envelopes", async () => {
		const cwd = makeTempDir("omp-exact-invalid-");
		const expiredPath = path.join(cwd, "expired.json");
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		manager.appendMessage({ role: "user", content: "question", timestamp: 1_000 });
		manager.appendMessage(assistantMessage("answer", 2_000));
		await manager.createExactCheckpoint({
			authority: authority(cwd),
			checkpointPath: expiredPath,
			createdAt: new Date("2026-01-01T00:00:00.000Z"),
			ttlMs: 1_000,
			boundary: { streaming: false, committed: true },
		});
		await expectCheckpointError(
			loadExactCheckpoint(expiredPath, authority(cwd), new Date("2026-01-01T00:00:02.000Z")),
			"expired",
		);

		const corruptPath = path.join(cwd, "corrupt.json");
		await createCommittedCheckpoint(cwd, corruptPath);
		const corrupt = JSON.parse(await fs.readFile(corruptPath, "utf8")) as {
			authority: { model: string };
		};
		corrupt.authority.model = "tampered";
		await fs.writeFile(corruptPath, JSON.stringify(corrupt));
		await expectCheckpointError(loadExactCheckpoint(corruptPath), "corrupt");

		const partialPath = path.join(cwd, "partial.json");
		await fs.writeFile(partialPath, '{"type":"exact_checkpoint_v1"');
		await expectCheckpointError(loadExactCheckpoint(partialPath), "partial");

		const responseIdPath = path.join(cwd, "response-id.json");
		await createCommittedCheckpoint(cwd, responseIdPath);
		const responseIdEnvelope = JSON.parse(await fs.readFile(responseIdPath, "utf8")) as {
			messages: Array<Record<string, unknown>>;
		};
		const assistant = responseIdEnvelope.messages.find(message => message.role === "assistant");
		if (!assistant) throw new Error("Expected assistant message in checkpoint fixture");
		assistant.responseId = "provider-response-id";
		await fs.writeFile(responseIdPath, JSON.stringify(responseIdEnvelope));
		await expectCheckpointError(loadExactCheckpoint(responseIdPath), "forbidden_field");

		const secretPath = path.join(cwd, "raw-secret.json");
		await createCommittedCheckpoint(cwd, secretPath);
		const secretEnvelope = JSON.parse(await fs.readFile(secretPath, "utf8")) as {
			messages: Array<Record<string, unknown>>;
		};
		const firstMessage = secretEnvelope.messages[0];
		if (!firstMessage) throw new Error("Expected typed history in checkpoint fixture");
		firstMessage.apiKey = "raw-secret";
		await fs.writeFile(secretPath, JSON.stringify(secretEnvelope));
		await expectCheckpointError(loadExactCheckpoint(secretPath), "forbidden_field");
	});

	it("rejects mid-stream and uncommitted creation boundaries", async () => {
		const cwd = makeTempDir("omp-exact-boundary-");
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		manager.appendMessage({ role: "user", content: "question", timestamp: 1_000 });
		manager.appendMessage(assistantMessage("answer", 2_000));
		await expectCheckpointError(
			manager.createExactCheckpoint({
				authority: authority(cwd),
				checkpointPath: path.join(cwd, "streaming.json"),
				boundary: { streaming: true, committed: true },
			}),
			"mid_stream",
		);
		await expectCheckpointError(
			manager.createExactCheckpoint({
				authority: authority(cwd),
				checkpointPath: path.join(cwd, "uncommitted.json"),
				boundary: { streaming: false, committed: false },
			}),
			"uncommitted",
		);
	});

	it("publishes atomically without replacing an existing checkpoint", async () => {
		const cwd = makeTempDir("omp-exact-atomic-");
		const checkpointPath = path.join(cwd, "atomic", "checkpoint.json");
		const { manager } = await createCommittedCheckpoint(cwd, checkpointPath);
		const original = await fs.readFile(checkpointPath, "utf8");
		manager.appendMessage({ role: "user", content: "later history", timestamp: 3_000 });
		await expect(
			manager.createExactCheckpoint({
				authority: authority(cwd),
				checkpointPath,
				boundary: { streaming: false, committed: true },
			}),
		).rejects.toMatchObject({ code: "EEXIST" });
		expect(await fs.readFile(checkpointPath, "utf8")).toBe(original);
		const siblingNames = await fs.readdir(path.dirname(checkpointPath));
		expect(siblingNames.some(name => name.endsWith(".tmp"))).toBe(false);
	});

	it("allows exactly one writer in a resume race", async () => {
		const cwd = makeTempDir("omp-exact-race-");
		const checkpointPath = path.join(cwd, "race.json");
		const { receipt } = await createCommittedCheckpoint(cwd, checkpointPath);
		const attempts = await Promise.allSettled([
			SessionManager.resumeExactCheckpoint(checkpointPath, authority(cwd), {
				expectedIntegritySha256: receipt.integritySha256,
				sessionDir: path.join(cwd, "successors"),
				claimRoot: path.join(cwd, "claims"),
			}),
			SessionManager.resumeExactCheckpoint(checkpointPath, authority(cwd), {
				expectedIntegritySha256: receipt.integritySha256,
				sessionDir: path.join(cwd, "successors"),
				claimRoot: path.join(cwd, "claims"),
			}),
		]);
		const fulfilled = attempts.filter(result => result.status === "fulfilled");
		const rejected = attempts.filter(result => result.status === "rejected");
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "already_consumed" });
	});

	it("content-addresses consumption across byte-identical copy paths", async () => {
		const cwd = makeTempDir("omp-exact-copy-consume-");
		const checkpointPath = path.join(cwd, "original.json");
		const copyPath = path.join(cwd, "copied.json");
		const { receipt } = await createCommittedCheckpoint(cwd, checkpointPath);
		await fs.copyFile(checkpointPath, copyPath);
		const claimRoot = path.join(cwd, "claims");

		await SessionManager.resumeExactCheckpoint(checkpointPath, authority(cwd), {
			expectedIntegritySha256: receipt.integritySha256,
			sessionDir: path.join(cwd, "successors"),
			claimRoot,
		});
		await expectCheckpointError(
			SessionManager.resumeExactCheckpoint(copyPath, authority(cwd), {
				expectedIntegritySha256: receipt.integritySha256,
				sessionDir: path.join(cwd, "successors"),
				claimRoot,
			}),
			"already_consumed",
		);
	});

	it("rejects rechecksummed history before restore and after the trusted receipt is consumed", async () => {
		const cwd = makeTempDir("omp-exact-authenticity-");
		const checkpointPath = path.join(cwd, "original.json");
		const forgedBeforePath = path.join(cwd, "forged-before.json");
		const forgedAfterPath = path.join(cwd, "forged-after.json");
		const sessionDir = path.join(cwd, "successors");
		const claimRoot = path.join(cwd, "claims");
		const { receipt } = await createCommittedCheckpoint(cwd, checkpointPath);

		await fs.copyFile(checkpointPath, forgedBeforePath);
		await rewriteChecksummedCheckpoint(forgedBeforePath, envelope => {
			const messages = envelope.messages as Array<Record<string, unknown>>;
			const first = messages[0];
			if (!first) throw new Error("Expected checkpoint history");
			first.content = "forged history before consumption";
		});
		await expectCheckpointError(
			SessionManager.resumeExactCheckpoint(forgedBeforePath, authority(cwd), {
				expectedIntegritySha256: receipt.integritySha256,
				sessionDir,
				claimRoot,
			}),
			"authenticity_mismatch",
		);
		await expect(fs.stat(sessionDir)).rejects.toThrow();
		await expect(fs.stat(claimRoot)).rejects.toThrow();

		await SessionManager.resumeExactCheckpoint(checkpointPath, authority(cwd), {
			expectedIntegritySha256: receipt.integritySha256,
			sessionDir,
			claimRoot,
		});
		await fs.copyFile(checkpointPath, forgedAfterPath);
		await rewriteChecksummedCheckpoint(forgedAfterPath, envelope => {
			const messages = envelope.messages as Array<Record<string, unknown>>;
			const first = messages[0];
			if (!first) throw new Error("Expected checkpoint history");
			first.content = "forged history after consumption";
		});
		await expectCheckpointError(
			SessionManager.resumeExactCheckpoint(forgedAfterPath, authority(cwd), {
				expectedIntegritySha256: receipt.integritySha256,
				sessionDir,
				claimRoot,
			}),
			"authenticity_mismatch",
		);
		expect(await fs.readdir(claimRoot)).toEqual([receipt.integritySha256]);
		expect((await fs.readdir(sessionDir)).filter(file => file.endsWith(".jsonl"))).toHaveLength(1);
	});

	it("authenticates own __proto__ fields before restoring history", async () => {
		const cwd = makeTempDir("omp-exact-prototype-authenticity-");
		const checkpointPath = path.join(cwd, "original.json");
		const forgedPath = path.join(cwd, "forged.json");
		const sessionDir = path.join(cwd, "successors");
		const claimRoot = path.join(cwd, "claims");
		const { receipt } = await createCommittedCheckpoint(cwd, checkpointPath);

		await fs.copyFile(checkpointPath, forgedPath);
		await rewriteChecksummedCheckpoint(forgedPath, envelope => {
			const messages = envelope.messages as Array<Record<string, unknown>>;
			const first = messages[0];
			if (!first) throw new Error("Expected checkpoint history");
			Object.defineProperty(first, "__proto__", {
				configurable: true,
				enumerable: true,
				value: { content: "forged prototype history" },
				writable: true,
			});
		});
		expect(await fs.readFile(forgedPath, "utf8")).toContain('"__proto__"');
		await expectCheckpointError(
			SessionManager.resumeExactCheckpoint(forgedPath, authority(cwd), {
				expectedIntegritySha256: receipt.integritySha256,
				sessionDir,
				claimRoot,
			}),
			"authenticity_mismatch",
		);
		await expect(fs.stat(sessionDir)).rejects.toThrow();
		await expect(fs.stat(claimRoot)).rejects.toThrow();
	});

	it("allows only one successor in a mixed resume and fork race across copies", async () => {
		const cwd = makeTempDir("omp-exact-mixed-race-");
		const checkpointPath = path.join(cwd, "original.json");
		const copyPath = path.join(cwd, "copied.json");
		const { receipt } = await createCommittedCheckpoint(cwd, checkpointPath);
		await fs.copyFile(checkpointPath, copyPath);
		const claimRoot = path.join(cwd, "claims");
		const attempts = await Promise.allSettled([
			SessionManager.resumeExactCheckpoint(checkpointPath, authority(cwd), {
				expectedIntegritySha256: receipt.integritySha256,
				mode: "resume",
				sessionDir: path.join(cwd, "successors"),
				claimRoot,
			}),
			SessionManager.resumeExactCheckpoint(copyPath, authority(cwd), {
				expectedIntegritySha256: receipt.integritySha256,
				mode: "fork",
				sessionDir: path.join(cwd, "successors"),
				claimRoot,
			}),
		]);

		expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
		const rejected = attempts.filter(result => result.status === "rejected");
		expect(rejected).toHaveLength(1);
		expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "already_consumed" });
	});

	it("bounds creation time and checkpoint lifetime on persistence and load", async () => {
		const cwd = makeTempDir("omp-exact-lifetime-");
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		manager.appendMessage({ role: "user", content: "question", timestamp: 1_000 });
		manager.appendMessage(assistantMessage("answer", 2_000));
		await expectCheckpointError(
			manager.createExactCheckpoint({
				authority: authority(cwd),
				checkpointPath: path.join(cwd, "future-persist.json"),
				createdAt: new Date(Date.now() + 60_000),
				boundary: { streaming: false, committed: true },
			}),
			"invalid_envelope",
		);
		const longCreatedAt = new Date("2026-01-01T00:00:00.000Z");
		await expectCheckpointError(
			manager.createExactCheckpoint({
				authority: authority(cwd),
				checkpointPath: path.join(cwd, "long-persist.json"),
				createdAt: longCreatedAt,
				expiresAt: new Date(longCreatedAt.getTime() + MAX_EXACT_CHECKPOINT_TTL_MS + 1),
				boundary: { streaming: false, committed: true },
			}),
			"invalid_envelope",
		);

		const futureLoadPath = path.join(cwd, "future-load.json");
		await createCommittedCheckpoint(cwd, futureLoadPath);
		await rewriteChecksummedCheckpoint(futureLoadPath, envelope => {
			envelope.createdAt = "2030-01-01T00:00:01.000Z";
			envelope.expiresAt = "2030-01-01T00:00:02.000Z";
		});
		await expectCheckpointError(
			loadExactCheckpoint(futureLoadPath, authority(cwd), new Date("2030-01-01T00:00:00.000Z")),
			"invalid_envelope",
		);

		const longLoadPath = path.join(cwd, "long-load.json");
		await createCommittedCheckpoint(cwd, longLoadPath);
		const longEnvelope = await rewriteChecksummedCheckpoint(longLoadPath, envelope => {
			const createdAt = Date.parse(envelope.createdAt as string);
			envelope.expiresAt = new Date(createdAt + MAX_EXACT_CHECKPOINT_TTL_MS + 1).toISOString();
		});
		await expectCheckpointError(
			loadExactCheckpoint(
				longLoadPath,
				authority(cwd),
				new Date(Date.parse(longEnvelope.createdAt as string) + 1_000),
			),
			"invalid_envelope",
		);
	});

	it("preserves the envelope when a consumer wins a boundary-change race", async () => {
		const cwd = makeTempDir("omp-exact-boundary-consume-race-");
		const checkpointPath = path.join(cwd, "race.json");
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		manager.appendMessage({ role: "user", content: "question", timestamp: 1_000 });
		manager.appendMessage(assistantMessage("answer", 2_000));
		const claimRoot = path.join(cwd, "claims");
		const originalLink = fs.link;
		let consumeCompleted = false;
		const linkSpy = vi.spyOn(fs, "link").mockImplementation(async (sourcePath, targetPath) => {
			await originalLink(sourcePath, targetPath);
			if (path.resolve(String(targetPath)) !== checkpointPath) return;
			manager.appendMessage({ role: "user", content: "changed boundary", timestamp: 3_000 });
			const published = JSON.parse(await fs.readFile(checkpointPath, "utf8")) as {
				integritySha256: string;
			};
			await SessionManager.resumeExactCheckpoint(checkpointPath, authority(cwd), {
				expectedIntegritySha256: published.integritySha256,
				sessionDir: path.join(cwd, "successors"),
				claimRoot,
			});
			consumeCompleted = true;
		});
		try {
			await expectCheckpointError(
				manager.createExactCheckpoint({
					authority: authority(cwd),
					checkpointPath,
					claimRoot,
					boundary: { streaming: false, committed: true },
				}),
				"boundary_changed",
			);
		} finally {
			linkSpy.mockRestore();
		}

		expect(consumeCompleted).toBe(true);
		expect(await fs.readFile(checkpointPath, "utf8")).toContain('"type":"exact_checkpoint_v1"');
	});

	it("records explicit fork lineage and parent checkpoint metadata", async () => {
		const cwd = makeTempDir("omp-exact-fork-");
		const checkpointPath = path.join(cwd, "parent.json");
		const { manager: source, receipt: parentReceipt } = await createCommittedCheckpoint(cwd, checkpointPath);
		const forked = await SessionManager.resumeExactCheckpoint(checkpointPath, authority(cwd), {
			expectedIntegritySha256: parentReceipt.integritySha256,
			mode: "fork",
			sessionDir: path.join(cwd, "forks"),
			claimRoot: path.join(cwd, "claims"),
		});
		const metadata = forked.sessionManager.getHeader()?.exactCheckpoint;
		expect(metadata).toMatchObject({
			checkpointId: parentReceipt.checkpointId,
			parentLineageId: source.getSessionId(),
			sourceSessionId: source.getSessionId(),
			mode: "fork",
		});
		if (!metadata) throw new Error("Expected exact checkpoint fork metadata");
		expect(metadata.lineageId).not.toBe(source.getSessionId());

		const childPath = path.join(cwd, "fork-child.json");
		await forked.sessionManager.createExactCheckpoint({
			authority: authority(cwd),
			checkpointPath: childPath,
			boundary: { streaming: false, committed: true },
		});
		const child = await loadExactCheckpoint(childPath, authority(cwd));
		expect(child.lineage).toEqual({
			lineageId: metadata.lineageId,
			parentCheckpointId: parentReceipt.checkpointId,
			parentLineageId: source.getSessionId(),
		});
	});
});
