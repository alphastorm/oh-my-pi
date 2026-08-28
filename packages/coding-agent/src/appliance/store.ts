import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	APPLIANCE_STATE_SCHEMA_VERSION,
	type ApplianceInstallation,
	type ApplianceProfileId,
	type ApplianceReceipt,
	type ApplianceState,
	type ApplianceStore,
} from "./types";

const PROFILE_IDS = new Set<ApplianceProfileId>([
	"rtx5090-linux",
	"rtx4090-windows",
	"darwin-remote-ssh",
	"windows-docker-local",
	"linux-docker-local",
]);

const STATE_FILE = "state.json";
const LOCK_FILE = "install.lock";
const LOCK_STALE_MS = 24 * 60 * 60 * 1000;

function initialState(): ApplianceState {
	return { schemaVersion: APPLIANCE_STATE_SCHEMA_VERSION, revision: 0 };
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
	return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function parseInstallation(value: unknown): ApplianceInstallation {
	if (!isRecord(value) || !isRecord(value.route)) throw new Error("Invalid appliance installation state");
	const route = value.route;
	const profile = value.profile;
	const routeProfile = route.profile;
	if (
		!PROFILE_IDS.has(profile as ApplianceProfileId) ||
		routeProfile !== profile ||
		route.provider !== "ninfer-appliance" ||
		route.servedModel !== "q38-ninfer" ||
		typeof route.baseUrl !== "string" ||
		typeof route.port !== "number" ||
		!Number.isSafeInteger(route.port) ||
		typeof route.secretRef !== "string" ||
		!Array.isArray(route.aliases) ||
		!route.aliases.every(alias => typeof alias === "string") ||
		typeof value.installationId !== "string" ||
		typeof value.artifactSha256 !== "string" ||
		typeof value.runtimeSha256 !== "string" ||
		typeof value.modelSha256 !== "string" ||
		typeof value.candidateId !== "string" ||
		typeof value.candidateHandle !== "string" ||
		typeof value.installedAt !== "string"
	) {
		throw new Error("Invalid appliance installation state");
	}
	for (const digest of [value.artifactSha256, value.runtimeSha256, value.modelSha256]) {
		if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid appliance artifact digest");
	}
	return {
		installationId: value.installationId,
		profile: profile as ApplianceProfileId,
		release: optionalString(value.release),
		artifactSha256: value.artifactSha256,
		runtimeSha256: value.runtimeSha256,
		modelSha256: value.modelSha256,
		candidateId: value.candidateId,
		candidateHandle: value.candidateHandle,
		route: {
			provider: "ninfer-appliance",
			baseUrl: route.baseUrl,
			port: route.port,
			servedModel: "q38-ninfer",
			profile: profile as ApplianceProfileId,
			release: optionalString(route.release),
			aliases: [...route.aliases],
			secretRef: route.secretRef,
		},
		installedAt: value.installedAt,
	};
}

function parseState(raw: string): ApplianceState {
	const parsed: unknown = JSON.parse(raw);
	if (!isRecord(parsed)) throw new Error("Invalid appliance state");
	if (parsed.schemaVersion !== APPLIANCE_STATE_SCHEMA_VERSION) {
		throw new Error(`Unsupported appliance state schema: ${String(parsed.schemaVersion)}`);
	}
	if (!Number.isSafeInteger(parsed.revision) || typeof parsed.revision !== "number" || parsed.revision < 0) {
		throw new Error("Invalid appliance state revision");
	}
	if (parsed.fleet !== undefined && !Array.isArray(parsed.fleet)) throw new Error("Invalid appliance fleet state");
	const active = parsed.active === undefined ? undefined : parseInstallation(parsed.active);
	const fleet = parsed.fleet?.map(parseInstallation);
	const installationIds = new Set<string>();
	for (const installation of [active, ...(fleet ?? [])]) {
		if (!installation) continue;
		if (installationIds.has(installation.installationId)) {
			throw new Error("Appliance fleet contains a duplicate installation");
		}
		installationIds.add(installation.installationId);
	}
	let pending: ApplianceState["pending"];
	if (parsed.pending !== undefined) {
		if (!isRecord(parsed.pending)) throw new Error("Invalid pending appliance transaction");
		const action = parsed.pending.action;
		const stage = parsed.pending.stage;
		const profile = parsed.pending.profile;
		if (
			(action !== "install" && action !== "rollback") ||
			(stage !== "before-predecessor-stop" && stage !== "after-predecessor-stop") ||
			!PROFILE_IDS.has(profile as ApplianceProfileId) ||
			typeof parsed.pending.installationId !== "string"
		) {
			throw new Error("Invalid pending appliance transaction");
		}
		pending = {
			action,
			stage,
			profile: profile as ApplianceProfileId,
			installationId: parsed.pending.installationId,
			predecessor:
				parsed.pending.predecessor === undefined ? undefined : parseInstallation(parsed.pending.predecessor),
			failureReceiptId: optionalString(parsed.pending.failureReceiptId),
		};
	}
	return {
		schemaVersion: APPLIANCE_STATE_SCHEMA_VERSION,
		revision: parsed.revision,
		active,
		fleet,
		rollbackTarget: parsed.rollbackTarget === undefined ? undefined : parseInstallation(parsed.rollbackTarget),
		pending,
		lastInstallReceiptId: optionalString(parsed.lastInstallReceiptId),
		lastRollbackReceiptId: optionalString(parsed.lastRollbackReceiptId),
	};
}

function assertSafeIdentifier(value: string, name: string): void {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) throw new Error(`Invalid ${name}`);
}

async function syncDirectory(directory: string): Promise<void> {
	// Node/Win32 does not expose a supported directory durability flush. NTFS
	// journals rename metadata, but does not promise that an acknowledged rename
	// survives power loss. Keep the flushed-file + atomic-rename boundary; the
	// lifecycle reconciles a potentially stopped active route before a clean install.
	if (process.platform === "win32") return;
	const handle = await fs.open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function atomicWriteJson(file: string, value: unknown): Promise<void> {
	const directory = path.dirname(file);
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	const temporary = path.join(
		directory,
		`.${path.basename(file)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
	);
	const handle = await fs.open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
		await handle.sync();
	} catch (error) {
		await handle.close();
		await fs.rm(temporary, { force: true });
		throw error;
	}
	await handle.close();
	try {
		await fs.rename(temporary, file);
		await syncDirectory(directory);
	} catch (error) {
		await fs.rm(temporary, { force: true });
		throw error;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) !== "ESRCH";
	}
}

export class FileApplianceStore implements ApplianceStore {
	readonly root: string;
	readonly #beforeWrite?: (root: string) => Promise<void>;
	#writeReady = false;

	constructor(agentDir: string, options: { root?: string; beforeWrite?: (root: string) => Promise<void> } = {}) {
		this.root = options.root ?? path.join(agentDir, "appliance");
		this.#beforeWrite = options.beforeWrite;
	}

	async #ensureWriteReady(): Promise<void> {
		if (this.#writeReady) return;
		await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
		await this.#beforeWrite?.(this.root);
		this.#writeReady = true;
	}

	async readState(): Promise<ApplianceState> {
		try {
			return parseState(await fs.readFile(path.join(this.root, STATE_FILE), "utf8"));
		} catch (error) {
			if (errorCode(error) === "ENOENT") return initialState();
			throw error;
		}
	}

	async writeState(next: ApplianceState, expectedRevision: number): Promise<void> {
		await this.#ensureWriteReady();
		const current = await this.readState();
		if (current.revision !== expectedRevision) {
			throw new Error(
				`Appliance state changed concurrently (expected ${expectedRevision}, found ${current.revision})`,
			);
		}
		if (next.schemaVersion !== APPLIANCE_STATE_SCHEMA_VERSION || next.revision !== expectedRevision + 1) {
			throw new Error("Appliance state write must advance the current schema by one revision");
		}
		await atomicWriteJson(path.join(this.root, STATE_FILE), next);
	}

	async writeReceipt(receipt: ApplianceReceipt): Promise<string> {
		await this.#ensureWriteReady();
		assertSafeIdentifier(receipt.receiptId, "receipt identifier");
		const file = path.join(this.root, "receipts", `${receipt.action}-${receipt.receiptId}.json`);
		await atomicWriteJson(file, receipt);
		return file;
	}

	async hasSuccessfulRollbackReceipt(): Promise<boolean> {
		const directory = path.join(this.root, "receipts");
		let names: string[];
		try {
			names = await fs.readdir(directory);
		} catch (error) {
			if (errorCode(error) === "ENOENT") return false;
			throw error;
		}
		for (const name of names) {
			if (!name.startsWith("rollback-") || !name.endsWith(".json")) continue;
			try {
				const receipt: unknown = JSON.parse(await fs.readFile(path.join(directory, name), "utf8"));
				if (
					isRecord(receipt) &&
					receipt.schemaVersion === 1 &&
					receipt.action === "rollback" &&
					receipt.status === "rolled-back" &&
					typeof receipt.receiptId === "string" &&
					name === `rollback-${receipt.receiptId}.json`
				) {
					return true;
				}
			} catch {
				// A corrupt receipt is not evidence of a successful rollback.
			}
		}
		return false;
	}

	async createSecret(installationId: string): Promise<string> {
		await this.#ensureWriteReady();
		assertSafeIdentifier(installationId, "installation identifier");
		const relative = path.join("secrets", `${installationId}.key`);
		const file = path.join(this.root, relative);
		await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
		await fs.writeFile(file, `${randomBytes(32).toString("base64url")}\n`, { flag: "wx", mode: 0o600 });
		return relative;
	}

	async readSecret(secretRef: string): Promise<string> {
		const normalized = path.normalize(secretRef);
		if (path.isAbsolute(normalized) || normalized.startsWith("..") || path.dirname(normalized) !== "secrets") {
			throw new Error("Invalid appliance secret reference");
		}
		return (await fs.readFile(path.join(this.root, normalized), "utf8")).trim();
	}

	async removeSecret(secretRef: string): Promise<void> {
		const normalized = path.normalize(secretRef);
		if (path.isAbsolute(normalized) || normalized.startsWith("..") || path.dirname(normalized) !== "secrets") {
			throw new Error("Invalid appliance secret reference");
		}
		await fs.rm(path.join(this.root, normalized), { force: true });
	}

	async withInstallLock<T>(run: () => Promise<T>): Promise<T> {
		await this.#ensureWriteReady();
		const lockPath = path.join(this.root, LOCK_FILE);
		let handle: fs.FileHandle | undefined;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			try {
				handle = await fs.open(lockPath, "wx", 0o600);
				break;
			} catch (error) {
				if (errorCode(error) !== "EEXIST") throw error;
				let stale = false;
				try {
					const [raw, stat] = await Promise.all([fs.readFile(lockPath, "utf8"), fs.stat(lockPath)]);
					const owner: unknown = JSON.parse(raw);
					const ownerPid = isRecord(owner) && typeof owner.pid === "number" ? owner.pid : undefined;
					stale = ownerPid === undefined ? Date.now() - stat.mtimeMs > LOCK_STALE_MS : !isProcessAlive(ownerPid);
				} catch {
					const stat = await fs.stat(lockPath);
					stale = Date.now() - stat.mtimeMs > LOCK_STALE_MS;
				}
				if (!stale || attempt > 0) throw new Error("Another appliance transaction is in progress");
				await fs.rm(lockPath, { force: true });
			}
		}
		if (!handle) throw new Error("Unable to acquire appliance install lock");
		try {
			await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
			await handle.sync();
			return await run();
		} finally {
			await handle.close();
			await fs.rm(lockPath, { force: true });
		}
	}
}
