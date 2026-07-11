/**
 * Cross-process background-subagent job store.
 *
 * Writers merge individual records under an interprocess lock and publish with
 * atomic rename. Running jobs carry owner leases, so loading the extension in a
 * child Pi process cannot falsely fail another process's live work.
 */

import os from "node:os";
import path from "node:path";
import { atomicWriteJson, readJsonFile, withInterprocessLock } from "./file-lock.ts";

function resolveStateDir(value: string): string {
	const expanded = value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
	return path.resolve(expanded);
}

export const JOB_STORE_DIR = resolveStateDir(
	process.env.PI_SUBAGENT_STATE_DIR ||
		process.env.PI_SPAWN_SUBAGENT_DIR ||
		path.join(os.homedir(), ".pi", "agent", "spawn-subagent"),
);
export const JOB_STORE_PATH = path.join(JOB_STORE_DIR, "jobs.json");
export const JOB_STORE_LOCK_PATH = path.join(JOB_STORE_DIR, "jobs.lock");
export const JOB_STORE_VERSION = 2;

export type JobStatus = "running" | "canceling" | "completed" | "failed" | "canceled";

export const TERMINAL_JOB_STATUS: ReadonlySet<JobStatus> = new Set(["completed", "failed", "canceled"]);

export function isJobStatus(value: unknown): value is JobStatus {
	return value === "running" || value === "canceling" || value === "completed" || value === "failed" || value === "canceled";
}

export interface JobOwnerLease {
	id: string;
	pid: number;
	startedAt: string;
	heartbeatAt: string;
	leaseExpiresAt: string;
}

export interface StoredBackgroundJob {
	id: string;
	status: JobStatus;
	mode?: string;
	label?: string;
	startedAt?: string;
	updatedAt?: string;
	cwd?: string;
	notifiedAt?: string;
	result?: unknown;
	error?: string;
	owner?: JobOwnerLease;
	cancelRequestedAt?: string;
	cancelRequestedBy?: string;
}

export interface BackgroundJobStore {
	version: number;
	revision: number;
	updatedAt: string;
	jobs: StoredBackgroundJob[];
}

export interface JobSnapshot {
	id: string;
	status: JobStatus;
	label?: string;
	error?: string;
	ownerId?: string;
	ownerPid?: number;
	cancelRequestedAt?: string;
}

export interface JobStoreMutationOptions {
	signal?: AbortSignal;
	maxJobs?: number;
	maxAgeMs?: number;
}

function emptyStore(): BackgroundJobStore {
	return { version: JOB_STORE_VERSION, revision: 0, updatedAt: new Date(0).toISOString(), jobs: [] };
}

function normalizeJob(raw: unknown): StoredBackgroundJob | undefined {
	const job = raw as Record<string, unknown>;
	if (!job || typeof job.id !== "string") return undefined;
	const status = isJobStatus(job.status) ? job.status : "failed";
	const ownerRaw = job.owner as Record<string, unknown> | undefined;
	const owner: JobOwnerLease | undefined =
		ownerRaw &&
		typeof ownerRaw.id === "string" &&
		Number.isInteger(ownerRaw.pid) &&
		typeof ownerRaw.startedAt === "string" &&
		typeof ownerRaw.heartbeatAt === "string" &&
		typeof ownerRaw.leaseExpiresAt === "string"
			? {
				id: ownerRaw.id,
				pid: Number(ownerRaw.pid),
				startedAt: ownerRaw.startedAt,
				heartbeatAt: ownerRaw.heartbeatAt,
				leaseExpiresAt: ownerRaw.leaseExpiresAt,
			}
			: undefined;
	return {
		...(job as unknown as StoredBackgroundJob),
		id: job.id,
		status,
		owner,
		label: typeof job.label === "string" ? job.label : undefined,
		error: typeof job.error === "string" ? job.error : undefined,
	};
}

function normalizeStore(raw: unknown): BackgroundJobStore {
	const value = raw as Partial<BackgroundJobStore> | undefined;
	const jobs = Array.isArray(value?.jobs)
		? value!.jobs.map(normalizeJob).filter((job): job is StoredBackgroundJob => Boolean(job))
		: [];
	return {
		version: JOB_STORE_VERSION,
		revision: Number.isInteger(value?.revision) ? Number(value?.revision) : 0,
		updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
		jobs,
	};
}

export function readBackgroundJobStore(): BackgroundJobStore {
	return normalizeStore(readJsonFile<unknown>(JOB_STORE_PATH, emptyStore()));
}

export function isProcessAlive(pid: number | undefined): boolean {
	if (!Number.isInteger(pid) || Number(pid) <= 0) return false;
	try {
		process.kill(Number(pid), 0);
		return true;
	} catch (error: any) {
		return error?.code === "EPERM";
	}
}

export function isJobOwnerStale(job: StoredBackgroundJob, nowMs = Date.now(), legacyLeaseMs = 60_000): boolean {
	if (TERMINAL_JOB_STATUS.has(job.status)) return false;
	if (job.owner) {
		const expiresAt = Date.parse(job.owner.leaseExpiresAt);
		return !isProcessAlive(job.owner.pid) || !Number.isFinite(expiresAt) || expiresAt <= nowMs;
	}
	const updatedAt = Date.parse(job.updatedAt ?? job.startedAt ?? "");
	return !Number.isFinite(updatedAt) || nowMs - updatedAt > legacyLeaseMs;
}

function effectiveSnapshot(job: StoredBackgroundJob, nowMs: number): JobSnapshot {
	if (!TERMINAL_JOB_STATUS.has(job.status) && isJobOwnerStale(job, nowMs)) {
		return {
			id: job.id,
			status: "failed",
			label: job.label,
			error: job.error ?? "Background job owner lease expired before the job reached a terminal state.",
			ownerId: job.owner?.id,
			ownerPid: job.owner?.pid,
			cancelRequestedAt: job.cancelRequestedAt,
		};
	}
	return {
		id: job.id,
		status: job.status,
		label: job.label,
		error: job.error,
		ownerId: job.owner?.id,
		ownerPid: job.owner?.pid,
		cancelRequestedAt: job.cancelRequestedAt,
	};
}

export function readJobSnapshots(): Map<string, JobSnapshot> {
	const out = new Map<string, JobSnapshot>();
	const now = Date.now();
	for (const job of readBackgroundJobStore().jobs) out.set(job.id, effectiveSnapshot(job, now));
	return out;
}

export function readStoredJob(jobId: string): StoredBackgroundJob | undefined {
	return readBackgroundJobStore().jobs.find((job) => job.id === jobId);
}

function pruneJobs(store: BackgroundJobStore, nowMs: number, maxJobs: number, maxAgeMs: number): void {
	for (const job of store.jobs) {
		if (!TERMINAL_JOB_STATUS.has(job.status) && isJobOwnerStale(job, nowMs)) {
			job.status = "failed";
			job.updatedAt = new Date(nowMs).toISOString();
			job.error = job.error ?? "Background job owner lease expired before the job reached a terminal state.";
		}
	}

	const active = store.jobs.filter((job) => !TERMINAL_JOB_STATUS.has(job.status));
	const terminal = store.jobs
		.filter((job) => {
			if (!TERMINAL_JOB_STATUS.has(job.status)) return false;
			const updatedAt = Date.parse(job.updatedAt ?? job.startedAt ?? "");
			return !Number.isFinite(updatedAt) || nowMs - updatedAt <= maxAgeMs;
		})
		.sort((a, b) => String(a.startedAt ?? "").localeCompare(String(b.startedAt ?? "")));
	const terminalLimit = Math.max(0, maxJobs - active.length);
	const retainedTerminal = terminalLimit > 0 ? terminal.slice(-terminalLimit) : [];
	store.jobs = [...active, ...retainedTerminal].sort((a, b) =>
		String(a.startedAt ?? "").localeCompare(String(b.startedAt ?? "")),
	);
}

export async function mutateBackgroundJobStore<T>(
	mutator: (store: BackgroundJobStore) => T | Promise<T>,
	options: JobStoreMutationOptions = {},
): Promise<T> {
	return withInterprocessLock(
		JOB_STORE_LOCK_PATH,
		async () => {
			const store = readBackgroundJobStore();
			pruneJobs(store, Date.now(), options.maxJobs ?? 100, options.maxAgeMs ?? 30 * 24 * 60 * 60 * 1000);
			const result = await mutator(store);
			store.version = JOB_STORE_VERSION;
			store.revision++;
			store.updatedAt = new Date().toISOString();
			await atomicWriteJson(JOB_STORE_PATH, store);
			return result;
		},
		{ signal: options.signal, timeoutMs: 10_000, staleMs: 30_000, retryMs: 25 },
	);
}

function mergeJob(existing: StoredBackgroundJob | undefined, incoming: StoredBackgroundJob): StoredBackgroundJob {
	if (!existing) return incoming;
	if (TERMINAL_JOB_STATUS.has(existing.status) && !TERMINAL_JOB_STATUS.has(incoming.status)) return existing;
	const merged: StoredBackgroundJob = { ...existing, ...incoming };
	if (existing.cancelRequestedAt && !incoming.cancelRequestedAt) {
		merged.cancelRequestedAt = existing.cancelRequestedAt;
		merged.cancelRequestedBy = existing.cancelRequestedBy;
	}
	if (existing.status === "canceling" && incoming.status === "running") merged.status = "canceling";
	return merged;
}

export async function upsertStoredJob(job: StoredBackgroundJob, options: JobStoreMutationOptions = {}): Promise<void> {
	await mutateBackgroundJobStore((store) => {
		const index = store.jobs.findIndex((candidate) => candidate.id === job.id);
		if (index < 0) store.jobs.push(job);
		else store.jobs[index] = mergeJob(store.jobs[index], job);
	}, options);
}

export async function createStoredJobIfCapacity(
	job: StoredBackgroundJob,
	maxActiveJobs: number,
	options: JobStoreMutationOptions = {},
): Promise<{ created: boolean; activeJobs: number }> {
	return mutateBackgroundJobStore((store) => {
		const activeJobs = store.jobs.filter((candidate) => !TERMINAL_JOB_STATUS.has(candidate.status)).length;
		if (activeJobs >= maxActiveJobs) return { created: false, activeJobs };
		store.jobs.push(job);
		return { created: true, activeJobs: activeJobs + 1 };
	}, options);
}

export async function requestStoredJobCancellation(
	jobId: string,
	requestedBy: string,
	options: JobStoreMutationOptions = {},
): Promise<StoredBackgroundJob | undefined> {
	return mutateBackgroundJobStore((store) => {
		const job = store.jobs.find((candidate) => candidate.id === jobId);
		if (!job || TERMINAL_JOB_STATUS.has(job.status)) return job;
		job.status = "canceling";
		job.cancelRequestedAt = job.cancelRequestedAt ?? new Date().toISOString();
		job.cancelRequestedBy = requestedBy;
		job.updatedAt = new Date().toISOString();
		return { ...job };
	}, options);
}

export async function heartbeatStoredJobs(
	ownerId: string,
	leaseMs: number,
	options: JobStoreMutationOptions = {},
): Promise<Set<string>> {
	return mutateBackgroundJobStore((store) => {
		const now = new Date();
		const cancelRequested = new Set<string>();
		for (const job of store.jobs) {
			if (!job.owner || job.owner.id !== ownerId || TERMINAL_JOB_STATUS.has(job.status)) continue;
			job.owner.heartbeatAt = now.toISOString();
			job.owner.leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
			job.updatedAt = now.toISOString();
			if (job.cancelRequestedAt || job.status === "canceling") cancelRequested.add(job.id);
		}
		return cancelRequested;
	}, options);
}
