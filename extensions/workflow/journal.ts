import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteJson, readJsonFile, withInterprocessLock } from "../_shared/file-lock.ts";

export const WORKFLOW_JOURNAL_VERSION = 2;

export interface WorkflowJournalEntry {
	key: string;
	value: unknown;
	completedAt: string;
}

interface StoredWorkflowJournal {
	version: number;
	id: string;
	contextHash: string;
	context: unknown;
	updatedAt: string;
	entries: WorkflowJournalEntry[];
}

export interface WorkflowJournal {
	id: string;
	filePath: string;
	lockPath: string;
	contextHash: string;
	context: unknown;
	entries: Map<string, WorkflowJournalEntry>;
}

export interface OpenWorkflowJournalOptions {
	id: string;
	context: unknown;
	directory?: string;
}

function journalDirectory(override?: string): string {
	return path.resolve(
		override ??
			process.env.PI_WORKFLOW_JOURNAL_DIR ??
			path.join(os.homedir(), ".pi", "workflow-journal"),
	);
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

function hash(value: string): string {
	return crypto.createHash("sha256").update(value).digest("hex");
}

function fileNameForJournal(id: string): string {
	const prefix = id.replace(/[^\w.-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "").slice(0, 48) || "journal";
	return `${prefix}-${hash(id).slice(0, 16)}.json`;
}

function parseStoredJournal(value: unknown, filePath: string): StoredWorkflowJournal {
	const journal = value as Partial<StoredWorkflowJournal> | undefined;
	if (
		journal?.version !== WORKFLOW_JOURNAL_VERSION ||
		typeof journal.id !== "string" ||
		typeof journal.contextHash !== "string" ||
		!Array.isArray(journal.entries)
	) {
		throw new Error(
			`Workflow journal is corrupt or uses an unsupported schema: ${filePath}. Remove it or choose a new _journal id.`,
		);
	}
	const entries: WorkflowJournalEntry[] = [];
	for (const entry of journal.entries) {
		if (
			!entry ||
			typeof entry.key !== "string" ||
			typeof entry.completedAt !== "string" ||
			!("value" in entry)
		) {
			throw new Error(`Workflow journal contains an invalid entry: ${filePath}.`);
		}
		entries.push({ key: entry.key, value: entry.value, completedAt: entry.completedAt });
	}
	return {
		version: WORKFLOW_JOURNAL_VERSION,
		id: journal.id,
		contextHash: journal.contextHash,
		context: journal.context,
		updatedAt: typeof journal.updatedAt === "string" ? journal.updatedAt : new Date(0).toISOString(),
		entries,
	};
}

function readStoredJournal(filePath: string): StoredWorkflowJournal | undefined {
	if (!fs.existsSync(filePath)) return undefined;
	return parseStoredJournal(readJsonFile<unknown>(filePath, undefined), filePath);
}

function assertJournalIdentity(
	stored: StoredWorkflowJournal,
	id: string,
	contextHash: string,
	filePath: string,
): void {
	if (stored.id !== id) {
		throw new Error(`Workflow journal identity mismatch at ${filePath}; choose a new _journal id.`);
	}
	if (stored.contextHash !== contextHash) {
		throw new Error(
			`Workflow journal ${JSON.stringify(id)} was created for different workflow code, arguments, model, agents, or working directory. Choose a new _journal id or restore the original execution context.`,
		);
	}
}

export function exactJournalValue(value: unknown, maxBytes: number): unknown {
	if (value === undefined) throw new Error("Workflow cache values must be JSON-serializable; received undefined.");
	let serialized: string;
	try {
		serialized = JSON.stringify(value);
	} catch (error: unknown) {
		throw new Error(
			`Workflow cache value is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (serialized === undefined) {
		throw new Error(`Workflow cache value is not JSON-serializable: ${String(value)}`);
	}
	const bytes = Buffer.byteLength(serialized, "utf8");
	if (bytes > maxBytes) {
		throw new Error(
			`Workflow cache value is ${bytes} bytes; exact replay limit is ${maxBytes}. Store a durable artifact and cache its path/checksum instead.`,
		);
	}
	return JSON.parse(serialized);
}

export function openWorkflowJournal(options: OpenWorkflowJournalOptions): WorkflowJournal {
	const id = options.id.trim();
	if (!id) throw new Error("Workflow journal id must be non-empty.");
	if (Buffer.byteLength(id, "utf8") > 512) throw new Error("Workflow journal id exceeds 512 UTF-8 bytes.");
	const context = exactJournalValue(options.context, 1024 * 1024);
	const contextHash = hash(canonicalJson(context));
	const filePath = path.join(journalDirectory(options.directory), fileNameForJournal(id));
	const stored = readStoredJournal(filePath);
	if (stored) assertJournalIdentity(stored, id, contextHash, filePath);
	return {
		id,
		filePath,
		lockPath: `${filePath}.lock`,
		contextHash,
		context,
		entries: new Map((stored?.entries ?? []).map((entry) => [entry.key, entry])),
	};
}

export async function persistWorkflowJournalEntry(
	journal: WorkflowJournal,
	entry: WorkflowJournalEntry,
): Promise<void> {
	await withInterprocessLock(
		journal.lockPath,
		async () => {
			const stored = readStoredJournal(journal.filePath);
			if (stored) assertJournalIdentity(stored, journal.id, journal.contextHash, journal.filePath);
			const entries = new Map((stored?.entries ?? []).map((item) => [item.key, item]));
			entries.set(entry.key, entry);
			const payload: StoredWorkflowJournal = {
				version: WORKFLOW_JOURNAL_VERSION,
				id: journal.id,
				contextHash: journal.contextHash,
				context: journal.context,
				updatedAt: new Date().toISOString(),
				entries: Array.from(entries.values()),
			};
			await atomicWriteJson(journal.filePath, payload);
			journal.entries = entries;
		},
		{ timeoutMs: 10_000, staleMs: 30_000, retryMs: 25 },
	);
}
