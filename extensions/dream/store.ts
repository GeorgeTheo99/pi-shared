import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type {
	Confidence,
	MetaDreamProposal,
	MetaDreamRun,
	MetaDreamStore,
	ProjectDreamProposal,
	ProjectDreamRun,
	ProjectDreamStore,
	ProjectInfo,
	RawMetaProposal,
	RawProjectProposal,
} from "./types.js";

const DREAM_VERSION = 1;
const MAX_RUNS = 20;
const MAX_MEMORY_TEXT_CHARS = 800;
const DEFAULT_REVIEW_AFTER_DAYS = 90;

const MEMORY_ROOT = process.env.PI_MEMORY_DIR || join(homedir(), ".pi", "memory");
const PROJECT_MEMORY_DIR = join(MEMORY_ROOT, "projects");
const DREAM_ROOT = join(MEMORY_ROOT, "dreams");
const PROJECT_DREAM_DIR = join(DREAM_ROOT, "projects");
const META_DREAM_PATH = join(DREAM_ROOT, "meta", "store.json");

// --- Utility functions (adapted from memory extension) ---

export function nowIso() {
	return new Date().toISOString();
}

function addDaysIso(days: number) {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString();
}

function sha256(input: string) {
	return createHash("sha256").update(input).digest("hex");
}

function safeName(value: string) {
	return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "project";
}

function gitValue(cwd: string, args: string[]): string | undefined {
	try {
		return execFileSync("git", ["-C", cwd, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2_000,
		}).trim() || undefined;
	} catch {
		return undefined;
	}
}

function realpathSafe(path: string) {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function ensureDir(path: string) {
	mkdirSync(path, { recursive: true });
}

function clampText(text: string) {
	return text.trim().replace(/\s+/g, " ").slice(0, MAX_MEMORY_TEXT_CHARS);
}

function normalizeTags(tags: unknown): string[] {
	if (!Array.isArray(tags)) return [];
	return [...new Set(tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 12);
}

function looksSecretish(text: string) {
	const secretPatterns = [
		/\b(?:sk|pk|ghp|gho|ghu|github_pat|xox[baprs])-[-_a-z0-9]{12,}\b/i,
		/\b(?:api[_-]?key|token|secret|password|credential)\b\s*[:=]/i,
		/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	];
	return secretPatterns.some((pattern) => pattern.test(text));
}

function makeMemoryId() {
	return `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// --- Project detection ---

export type ProjectLocation = {
	project: ProjectInfo;
	dreamStorePath: string;
	memoryStorePath: string;
};

export function detectProjectForDream(cwd: string): ProjectLocation {
	const rootRaw = gitValue(cwd, ["rev-parse", "--show-toplevel"]);
	const root = rootRaw ? realpathSafe(rootRaw) : realpathSafe(cwd);
	const remote = gitValue(root, ["config", "--get", "remote.origin.url"]);
	const id = sha256(`${root}\0${remote ?? ""}`).slice(0, 24);
	const name = safeName(basename(root));
	const timestamp = nowIso();
	return {
		project: { id, name, root, remote, firstSeenAt: timestamp, lastSeenAt: timestamp },
		dreamStorePath: join(PROJECT_DREAM_DIR, `${name}-${id}.json`),
		memoryStorePath: join(PROJECT_MEMORY_DIR, `${name}-${id}.json`),
	};
}

// --- Atomic write ---

function atomicWrite(path: string, data: string) {
	ensureDir(dirname(path));
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, data, "utf8");
	renameSync(tmp, path);
}

// --- Project dream store ---

function emptyProjectDreamStore(project: ProjectInfo): ProjectDreamStore {
	return { version: DREAM_VERSION as 1, project, runs: [] };
}

export function readProjectDreamStore(path: string, project: ProjectInfo): ProjectDreamStore {
	ensureDir(dirname(path));
	if (!existsSync(path)) return emptyProjectDreamStore(project);
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ProjectDreamStore>;
		return {
			version: DREAM_VERSION as 1,
			project: {
				...project,
				firstSeenAt: parsed.project?.firstSeenAt ?? project.firstSeenAt,
				lastSeenAt: nowIso(),
			},
			runs: Array.isArray(parsed.runs) ? parsed.runs : [],
		};
	} catch {
		return emptyProjectDreamStore(project);
	}
}

// --- Meta dream store ---

function emptyMetaDreamStore(): MetaDreamStore {
	return { version: DREAM_VERSION as 1, runs: [] };
}

export function readMetaDreamStore(): MetaDreamStore {
	ensureDir(dirname(META_DREAM_PATH));
	if (!existsSync(META_DREAM_PATH)) return emptyMetaDreamStore();
	try {
		const parsed = JSON.parse(readFileSync(META_DREAM_PATH, "utf8")) as Partial<MetaDreamStore>;
		return {
			version: DREAM_VERSION as 1,
			runs: Array.isArray(parsed.runs) ? parsed.runs : [],
		};
	} catch {
		return emptyMetaDreamStore();
	}
}

// --- Save dream runs ---

export async function saveDreamRun(location: ProjectLocation, run: ProjectDreamRun): Promise<void> {
	await withFileMutationQueue(location.dreamStorePath, async () => {
		const store = readProjectDreamStore(location.dreamStorePath, location.project);
		store.runs.push(run);
		if (store.runs.length > MAX_RUNS) {
			store.runs = store.runs.slice(-MAX_RUNS);
		}
		store.project.lastSeenAt = nowIso();
		atomicWrite(location.dreamStorePath, `${JSON.stringify(store, null, 2)}\n`);
	});
}

export async function saveMetaDreamRun(run: MetaDreamRun): Promise<void> {
	await withFileMutationQueue(META_DREAM_PATH, async () => {
		const store = readMetaDreamStore();
		store.runs.push(run);
		if (store.runs.length > MAX_RUNS) {
			store.runs = store.runs.slice(-MAX_RUNS);
		}
		atomicWrite(META_DREAM_PATH, `${JSON.stringify(store, null, 2)}\n`);
	});
}

// --- Proposal lookup ---

export type FoundProposal<T> = { run: { id: string; timestamp: string; summary: string }; proposal: T; runIndex: number; proposalIndex: number };

export function findProjectProposal(
	store: ProjectDreamStore,
	proposalId: string,
): FoundProposal<ProjectDreamProposal> | null {
	for (let ri = store.runs.length - 1; ri >= 0; ri--) {
		const run = store.runs[ri];
		for (let pi = 0; pi < run.proposals.length; pi++) {
			if (run.proposals[pi].id === proposalId) {
				return { run: { id: run.id, timestamp: run.timestamp, summary: run.summary }, proposal: run.proposals[pi], runIndex: ri, proposalIndex: pi };
			}
		}
	}
	return null;
}

export function findMetaProposal(
	store: MetaDreamStore,
	proposalId: string,
): FoundProposal<MetaDreamProposal> | null {
	for (let ri = store.runs.length - 1; ri >= 0; ri--) {
		const run = store.runs[ri];
		for (let pi = 0; pi < run.proposals.length; pi++) {
			if (run.proposals[pi].id === proposalId) {
				return { run: { id: run.id, timestamp: run.timestamp, summary: run.summary }, proposal: run.proposals[pi], runIndex: ri, proposalIndex: pi };
			}
		}
	}
	return null;
}

// --- Apply / dismiss proposals ---

type MemoryEntry = {
	id: string;
	text: string;
	tags: string[];
	source?: string;
	confidence: Confidence;
	status: "active" | "archived";
	createdAt: string;
	updatedAt: string;
	reviewAfter?: string;
	archivedAt?: string;
	archiveReason?: string;
};

type MemoryStore = {
	version: number;
	project: ProjectInfo;
	memories: MemoryEntry[];
};

function readMemoryStore(path: string, project: ProjectInfo): MemoryStore {
	if (!existsSync(path)) return { version: 1, project, memories: [] };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return {
			version: 1,
			project: {
				...project,
				firstSeenAt: parsed.project?.firstSeenAt ?? project.firstSeenAt,
				lastSeenAt: nowIso(),
			},
			memories: Array.isArray(parsed.memories) ? parsed.memories : [],
		};
	} catch {
		return { version: 1, project, memories: [] };
	}
}

export async function applyProjectProposal(proposalId: string, location: ProjectLocation): Promise<string> {
	// Lock both files: dream store first, then memory store
	return withFileMutationQueue(location.dreamStorePath, async () => {
		const dreamStore = readProjectDreamStore(location.dreamStorePath, location.project);
		const found = findProjectProposal(dreamStore, proposalId);
		if (!found) return `Proposal not found: ${proposalId}`;
		if (found.proposal.status !== "pending") return `Proposal ${proposalId} is already ${found.proposal.status}`;

		const proposal = found.proposal;

		return withFileMutationQueue(location.memoryStorePath, async () => {
			const memStore = readMemoryStore(location.memoryStorePath, location.project);
			const timestamp = nowIso();
			let resultMsg: string;

			switch (proposal.action) {
				case "add": {
					if (!proposal.proposedText?.trim()) return `Proposal ${proposalId} has no proposed text`;
					const text = clampText(proposal.proposedText);
					if (looksSecretish(text)) return `Refusing to apply: proposed text looks like a secret`;
					const memory: MemoryEntry = {
						id: makeMemoryId(),
						text,
						tags: normalizeTags(proposal.proposedTags),
						source: `Applied from dream proposal ${proposalId}`,
						confidence: proposal.confidence,
						status: "active",
						createdAt: timestamp,
						updatedAt: timestamp,
						reviewAfter: addDaysIso(DEFAULT_REVIEW_AFTER_DAYS),
					};
					memStore.memories.push(memory);
					resultMsg = `Added memory ${memory.id}: ${text.slice(0, 80)}...`;
					break;
				}
				case "update": {
					const target = memStore.memories.find((m) => m.id === proposal.targetMemoryId);
					if (!target) return `Target memory not found: ${proposal.targetMemoryId}`;
					if (proposal.proposedText) {
						const text = clampText(proposal.proposedText);
						if (looksSecretish(text)) return `Refusing to apply: proposed text looks like a secret`;
						target.text = text;
					}
					if (proposal.proposedTags) target.tags = normalizeTags(proposal.proposedTags);
					target.status = "active";
					target.updatedAt = timestamp;
					target.reviewAfter = addDaysIso(DEFAULT_REVIEW_AFTER_DAYS);
					delete target.archivedAt;
					delete target.archiveReason;
					resultMsg = `Updated memory ${target.id}`;
					break;
				}
				case "archive": {
					const target = memStore.memories.find((m) => m.id === proposal.targetMemoryId);
					if (!target) return `Target memory not found: ${proposal.targetMemoryId}`;
					target.status = "archived";
					target.updatedAt = timestamp;
					target.archivedAt = timestamp;
					target.archiveReason = proposal.reason || "Archived by dream proposal";
					resultMsg = `Archived memory ${target.id}`;
					break;
				}
				case "merge": {
					if (!proposal.mergeSourceIds?.length) return `Merge proposal has no source IDs`;
					if (!proposal.proposedText?.trim()) return `Merge proposal has no proposed text`;
					const text = clampText(proposal.proposedText);
					if (looksSecretish(text)) return `Refusing to apply: proposed text looks like a secret`;
					// Archive source memories
					const archivedIds: string[] = [];
					for (const srcId of proposal.mergeSourceIds) {
						const src = memStore.memories.find((m) => m.id === srcId);
						if (src) {
							src.status = "archived";
							src.updatedAt = timestamp;
							src.archivedAt = timestamp;
							src.archiveReason = `Merged into new memory by dream proposal ${proposalId}`;
							archivedIds.push(srcId);
						}
					}
					// Create merged memory
					const memory: MemoryEntry = {
						id: makeMemoryId(),
						text,
						tags: normalizeTags(proposal.proposedTags),
						source: `Merged from [${archivedIds.join(", ")}] by dream proposal ${proposalId}`,
						confidence: proposal.confidence,
						status: "active",
						createdAt: timestamp,
						updatedAt: timestamp,
						reviewAfter: addDaysIso(DEFAULT_REVIEW_AFTER_DAYS),
					};
					memStore.memories.push(memory);
					resultMsg = `Merged ${archivedIds.length} memories into ${memory.id}`;
					break;
				}
				default:
					return `Unknown proposal action: ${(proposal as any).action}`;
			}

			// Mark proposal as applied
			proposal.status = "applied";

			// Write both stores
			memStore.project.lastSeenAt = nowIso();
			atomicWrite(location.memoryStorePath, `${JSON.stringify(memStore, null, 2)}\n`);
			atomicWrite(location.dreamStorePath, `${JSON.stringify(dreamStore, null, 2)}\n`);

			return resultMsg;
		});
	});
}

export async function dismissProjectProposal(proposalId: string, location: ProjectLocation): Promise<string> {
	return withFileMutationQueue(location.dreamStorePath, async () => {
		const store = readProjectDreamStore(location.dreamStorePath, location.project);
		const found = findProjectProposal(store, proposalId);
		if (!found) return `Proposal not found: ${proposalId}`;
		if (found.proposal.status !== "pending") return `Proposal ${proposalId} is already ${found.proposal.status}`;
		found.proposal.status = "dismissed";
		atomicWrite(location.dreamStorePath, `${JSON.stringify(store, null, 2)}\n`);
		return `Dismissed proposal ${proposalId}`;
	});
}

export async function dismissMetaProposal(proposalId: string): Promise<string> {
	return withFileMutationQueue(META_DREAM_PATH, async () => {
		const store = readMetaDreamStore();
		const found = findMetaProposal(store, proposalId);
		if (!found) return `Proposal not found: ${proposalId}`;
		if (found.proposal.status !== "pending") return `Proposal ${proposalId} is already ${found.proposal.status}`;
		found.proposal.status = "dismissed";
		atomicWrite(META_DREAM_PATH, `${JSON.stringify(store, null, 2)}\n`);
		return `Dismissed proposal ${proposalId}`;
	});
}

// --- ID generators ---

export function makeDreamProposalId() {
	return `dp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function makeMetaProposalId() {
	return `dm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function makeDreamRunId() {
	return `pdr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function makeMetaDreamRunId() {
	return `mdr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// --- Formatting helpers ---

export function formatProjectProposal(p: ProjectDreamProposal, index: number): string {
	const statusBadge = p.status !== "pending" ? ` [${p.status}]` : "";
	const target = p.targetMemoryId ? ` → ${p.targetMemoryId}` : "";
	const merge = p.mergeSourceIds?.length ? ` (merge: ${p.mergeSourceIds.join(", ")})` : "";
	const text = p.proposedText ? `\n   Text: ${p.proposedText.slice(0, 120)}${p.proposedText.length > 120 ? "..." : ""}` : "";
	const tags = p.proposedTags?.length ? `\n   Tags: ${p.proposedTags.map((t) => `#${t}`).join(" ")}` : "";
	return `${index + 1}. [${p.id}] ${p.action.toUpperCase()}${target}${merge}${statusBadge} (${p.confidence})\n   Reason: ${p.reason}${text}${tags}`;
}

export function formatMetaProposal(p: MetaDreamProposal, index: number): string {
	const statusBadge = p.status !== "pending" ? ` [${p.status}]` : "";
	return `${index + 1}. [${p.id}] ${p.changeType.toUpperCase()} — ${p.riskLevel} risk${statusBadge}\n   Problem: ${p.problem}\n   Resource: ${p.affectedResource}\n   Fix: ${p.proposedFix.slice(0, 150)}${p.proposedFix.length > 150 ? "..." : ""}`;
}

export function formatDreamRunSummary(run: ProjectDreamRun | MetaDreamRun, index: number): string {
	const pending = run.proposals.filter((p) => p.status === "pending").length;
	const applied = run.proposals.filter((p) => p.status === "applied").length;
	const dismissed = run.proposals.filter((p) => p.status === "dismissed").length;
	return `${index + 1}. ${run.timestamp} — ${run.sessionsAnalyzed} sessions — ${run.proposals.length} proposals (${pending} pending, ${applied} applied, ${dismissed} dismissed)\n   ${run.summary}`;
}

// --- Read current memory for dream context ---

export function readCurrentMemories(location: ProjectLocation): string {
	const memStore = readMemoryStore(location.memoryStorePath, location.project);
	const active = memStore.memories.filter((m) => m.status === "active");
	if (active.length === 0) return "No active project memories.";
	return active
		.map((m) => {
			const tags = m.tags.length ? ` #${m.tags.join(" #")}` : "";
			return `- [${m.id}] ${m.text}${tags}`;
		})
		.join("\n");
}

export function readAllProjectMemories(): Map<string, { project: ProjectInfo; memories: string }> {
	const result = new Map<string, { project: ProjectInfo; memories: string }>();
	if (!existsSync(PROJECT_MEMORY_DIR)) return result;
	try {
		const files = readdirSync(PROJECT_MEMORY_DIR).filter((f) => f.endsWith(".json"));
		for (const file of files) {
			const path = join(PROJECT_MEMORY_DIR, file);
			try {
				const parsed = JSON.parse(readFileSync(path, "utf8"));
				if (!parsed.project?.name || !Array.isArray(parsed.memories)) continue;
				const active = parsed.memories.filter((m: any) => m.status === "active");
				if (active.length === 0) continue;
				const memories = active
					.map((m: any) => {
						const tags = m.tags?.length ? ` #${m.tags.join(" #")}` : "";
						return `- [${m.id}] ${m.text}${tags}`;
					})
					.join("\n");
				result.set(parsed.project.name, { project: parsed.project, memories });
			} catch {
				// skip corrupt files
			}
		}
	} catch {
		// ignore
	}
	return result;
}
