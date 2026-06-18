/**
 * Shared contract for the background-subagent job store.
 *
 * Single source of truth for the on-disk job store location, the job status
 * enum, and a defensive read-only snapshot. The writer (`spawn-subagent`)
 * imports `JOB_STORE_PATH` / `JOB_STORE_VERSION` / `JobStatus` / `isJobStatus`
 * from here, and `wait_for` imports `readJobSnapshots` — so the two extensions
 * can never drift on store path, status strings, or on-disk shape.
 *
 * This module is intentionally dependency-free (only node:fs / node:path /
 * node:os) and exports no Pi extension factory, so the per-extension index.ts
 * auto-discovery glob never picks it up as an extension.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Directory holding the persisted job store. Overridable for tests/custom profiles. */
export const JOB_STORE_DIR =
	process.env.PI_SPAWN_SUBAGENT_DIR || path.join(os.homedir(), ".pi", "agent", "spawn-subagent");

/** Path to the persisted job store JSON file. */
export const JOB_STORE_PATH = path.join(JOB_STORE_DIR, "jobs.json");

/** Store schema version. Bump if the on-disk shape changes incompatibly. */
export const JOB_STORE_VERSION = 1;

/** Lifecycle status of a background subagent job. */
export type JobStatus = "running" | "completed" | "failed" | "canceled";

/** Statuses that mean the job is done (no further state changes expected). */
export const TERMINAL_JOB_STATUS: ReadonlySet<JobStatus> = new Set([
	"completed",
	"failed",
	"canceled",
]);

/** `true` if `value` is one of the {@link JobStatus} strings. */
export function isJobStatus(value: unknown): value is JobStatus {
	return value === "running" || value === "completed" || value === "failed" || value === "canceled";
}

/** Read-only view of a job; the stable contract for external consumers. */
export interface JobSnapshot {
	id: string;
	status: JobStatus;
	label?: string;
	error?: string;
}

/** On-disk envelope shape (only the parts every consumer agrees on). */
interface JobStoreEnvelope {
	version?: number;
	jobs?: unknown[];
}

/**
 * Read the job store and return a lightweight snapshot per job id.
 *
 * Defensive: a missing, unreadable, or corrupt store yields an empty map
 * (treated by callers as "no jobs terminal yet"). Jobs with an unparseable
 * `id` or `status` are skipped; unknown ids are simply absent from the map.
 * This is the canonical read for `wait_for` and any other consumer that only
 * needs job status — it must not throw.
 */
export function readJobSnapshots(): Map<string, JobSnapshot> {
	const out = new Map<string, JobSnapshot>();
	let envelope: JobStoreEnvelope;
	try {
		if (!fs.existsSync(JOB_STORE_PATH)) return out;
		envelope = JSON.parse(fs.readFileSync(JOB_STORE_PATH, "utf8")) as JobStoreEnvelope;
	} catch {
		return out;
	}
	const jobs = Array.isArray(envelope.jobs) ? envelope.jobs : [];
	for (const raw of jobs) {
		const job = raw as Record<string, unknown>;
		if (!job || typeof job.id !== "string") continue;
		const status = isJobStatus(job.status) ? job.status : undefined;
		if (!status) continue;
		out.set(job.id, {
			id: job.id,
			status,
			label: typeof job.label === "string" ? job.label : undefined,
			error: typeof job.error === "string" ? job.error : undefined,
		});
	}
	return out;
}
