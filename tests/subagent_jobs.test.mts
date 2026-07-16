import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-jobs-test-"));
process.env.PI_SUBAGENT_STATE_DIR = stateDir;
const jobs = await import("../extensions/_shared/job-store.ts");
after(() => fs.rmSync(stateDir, { recursive: true, force: true }));

function owner(id: string, pid = process.pid, leaseOffsetMs = 60_000) {
	const now = new Date();
	return {
		id,
		pid,
		startedAt: now.toISOString(),
		heartbeatAt: now.toISOString(),
		leaseExpiresAt: new Date(now.getTime() + leaseOffsetMs).toISOString(),
	};
}

test("concurrent job writes merge instead of losing records", async () => {
	const now = new Date().toISOString();
	await Promise.all(
		Array.from({ length: 20 }, (_, index) =>
			jobs.upsertStoredJob({
				id: `merge-${index}`,
				status: "completed",
				startedAt: now,
				updatedAt: now,
			}),
		),
	);
	const stored = jobs.readBackgroundJobStore().jobs.filter((job) => job.id.startsWith("merge-"));
	assert.equal(stored.length, 20);
	assert.equal(jobs.readBackgroundJobStore().version, 3);
});

test("live owner leases survive reads and remote cancellation remains nonterminal", async () => {
	const now = new Date().toISOString();
	await jobs.upsertStoredJob({
		id: "live-job",
		status: "running",
		startedAt: now,
		updatedAt: now,
		owner: owner("live-owner"),
	});
	assert.equal(jobs.readJobSnapshots().get("live-job")?.status, "running");
	const canceled = await jobs.requestStoredJobCancellation("live-job", "remote-requester");
	assert.equal(canceled?.status, "canceling");
	assert.ok(canceled?.cancelRequestedAt);
	assert.equal(jobs.TERMINAL_JOB_STATUS.has("canceling"), false);
});

test("awaiting-answer jobs remain live, actionable, and nonterminal", async () => {
	const now = new Date().toISOString();
	await jobs.upsertStoredJob({
		id: "awaiting-job",
		status: "awaiting_answer",
		startedAt: now,
		updatedAt: now,
		interactive: true,
		maxExchanges: 20,
		question: { id: "q_1", exchange: 1, text: "Which API?", askedAt: now, untrusted: true },
		owner: owner("awaiting-owner"),
	});
	const snapshot = jobs.readJobSnapshots().get("awaiting-job");
	assert.equal(snapshot?.status, "awaiting_answer");
	assert.equal(snapshot?.question?.id, "q_1");
	assert.equal(snapshot?.question?.untrusted, true);
	assert.equal(jobs.TERMINAL_JOB_STATUS.has("awaiting_answer"), false);
});

test("persisted interactive exchange limits are normalized to the supported range", async () => {
	const now = new Date().toISOString();
	await Promise.all([
		jobs.upsertStoredJob({ id: "limit-valid", status: "completed", startedAt: now, updatedAt: now, maxExchanges: 10 }),
		jobs.upsertStoredJob({ id: "limit-zero", status: "completed", startedAt: now, updatedAt: now, maxExchanges: 0 }),
		jobs.upsertStoredJob({ id: "limit-high", status: "completed", startedAt: now, updatedAt: now, maxExchanges: 21 }),
		jobs.upsertStoredJob({ id: "limit-fraction", status: "completed", startedAt: now, updatedAt: now, maxExchanges: 1.5 }),
	]);
	const stored = new Map(jobs.readBackgroundJobStore().jobs.map((job) => [job.id, job]));
	assert.equal(stored.get("limit-valid")?.maxExchanges, 10);
	assert.equal(stored.get("limit-zero")?.maxExchanges, undefined);
	assert.equal(stored.get("limit-high")?.maxExchanges, undefined);
	assert.equal(stored.get("limit-fraction")?.maxExchanges, undefined);
});

test("stale/dead owners are surfaced as failed without failing live foreign jobs", async () => {
	const now = new Date().toISOString();
	await jobs.upsertStoredJob({
		id: "dead-owner-job",
		status: "awaiting_answer",
		startedAt: now,
		updatedAt: now,
		question: { id: "q_dead", exchange: 1, text: "Dead?", askedAt: now, untrusted: true },
		owner: owner("dead-owner", 99_999_999),
	});
	const snapshot = jobs.readJobSnapshots().get("dead-owner-job");
	assert.equal(snapshot?.status, "failed");
	assert.match(snapshot?.error ?? "", /lease expired/);
	assert.equal(snapshot?.question, undefined);
	assert.equal(jobs.readJobSnapshots().get("live-job")?.status, "canceling");
});

test("background capacity reservation is transactional", async () => {
	const now = new Date().toISOString();
	const attempts = await Promise.all(
		Array.from({ length: 6 }, (_, index) =>
			jobs.createStoredJobIfCapacity(
				{
					id: `capacity-${index}`,
					status: "running",
					startedAt: now,
					updatedAt: now,
					owner: owner(`capacity-owner-${index}`),
				},
				4,
			),
		),
	);
	assert.equal(attempts.filter((attempt) => attempt.created).length, 2);
});

test("interactive state revisions prevent stale question and cancellation regressions", async () => {
	const now = new Date().toISOString();
	await jobs.upsertStoredJob({
		id: "revision-job",
		status: "awaiting_answer",
		stateRevision: 2,
		startedAt: now,
		updatedAt: now,
		owner: owner("revision-owner"),
		question: { id: "q_current", exchange: 1, text: "Current?", askedAt: now, untrusted: true },
	});
	await jobs.upsertStoredJob({
		id: "revision-job",
		status: "running",
		stateRevision: 1,
		startedAt: now,
		updatedAt: new Date(Date.now() + 1000).toISOString(),
		owner: owner("revision-owner"),
	});
	assert.equal(jobs.readStoredJob("revision-job")?.status, "awaiting_answer");
	assert.equal(jobs.readStoredJob("revision-job")?.question?.id, "q_current");

	const canceled = await jobs.requestStoredJobCancellation("revision-job", "remote");
	assert.equal(canceled?.status, "canceling");
	const canceledAgain = await jobs.requestStoredJobCancellation("revision-job", "remote-again");
	assert.equal(canceledAgain?.stateRevision, canceled?.stateRevision);
	await jobs.upsertStoredJob({
		id: "revision-job",
		status: "awaiting_answer",
		stateRevision: 2,
		startedAt: now,
		updatedAt: new Date(Date.now() + 2000).toISOString(),
		owner: owner("revision-owner"),
		question: { id: "q_stale", exchange: 1, text: "Stale?", askedAt: now, untrusted: true },
	});
	const stored = jobs.readStoredJob("revision-job");
	assert.equal(stored?.status, "canceling");
	assert.equal(stored?.question, undefined);
});

test("answer claims are atomic, owner-bound, and correlated", async () => {
	const now = new Date().toISOString();
	await jobs.upsertStoredJob({
		id: "claim-job",
		status: "awaiting_answer",
		stateRevision: 4,
		startedAt: now,
		updatedAt: now,
		owner: owner("claim-owner"),
		question: { id: "q_claim", exchange: 2, text: "Claim?", askedAt: now, untrusted: true },
	});
	assert.equal((await jobs.claimStoredJobAnswer("claim-job", "other-owner", "q_claim")).reason, "not_owner");
	assert.equal((await jobs.claimStoredJobAnswer("claim-job", "claim-owner", "q_wrong")).reason, "question_mismatch");
	const [first, second] = await Promise.all([
		jobs.claimStoredJobAnswer("claim-job", "claim-owner", "q_claim"),
		jobs.claimStoredJobAnswer("claim-job", "claim-owner", "q_claim"),
	]);
	assert.equal([first, second].filter((result) => result.claimed).length, 1);
	const stored = jobs.readStoredJob("claim-job");
	assert.equal(stored?.status, "running");
	assert.equal(stored?.question, undefined);
	assert.equal(stored?.lastAnsweredQuestionId, "q_claim");
	assert.equal(stored?.stateRevision, 5);
});

test("a stale running write cannot overwrite a terminal record", async () => {
	const now = new Date().toISOString();
	await jobs.upsertStoredJob({ id: "terminal-job", status: "completed", startedAt: now, updatedAt: now, result: { final: true } });
	await jobs.upsertStoredJob({
		id: "terminal-job",
		status: "running",
		startedAt: now,
		updatedAt: new Date(Date.now() - 1000).toISOString(),
		result: { stale: true },
		owner: owner("stale-writer"),
	});
	const stored = jobs.readStoredJob("terminal-job");
	assert.equal(stored?.status, "completed");
	assert.deepEqual(stored?.result, { final: true });
});

function runWriter(prefix: string): Promise<void> {
	const fixture = path.join(import.meta.dirname, "fixtures", "subagent_job_writer.mjs");
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [fixture, stateDir, prefix, "10"], {
			cwd: path.resolve(import.meta.dirname, ".."),
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("error", reject);
		child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`writer ${prefix} exited ${code}: ${stderr}`))));
	});
}

test("independent processes preserve every job record", async () => {
	await Promise.all([runWriter("writer-a"), runWriter("writer-b"), runWriter("writer-c"), runWriter("writer-d")]);
	const writerJobs = jobs.readBackgroundJobStore().jobs.filter((job) => job.id.startsWith("writer-"));
	assert.equal(writerJobs.length, 40);
});

test("history caps never evict active jobs", async () => {
	const activeStartedAt = new Date("2000-01-01T00:00:00.000Z").toISOString();
	const activeIds = Array.from({ length: 3 }, (_, index) => `retained-active-${index}`);
	for (const [index, id] of activeIds.entries()) {
		await jobs.upsertStoredJob({
			id,
			status: "running",
			startedAt: activeStartedAt,
			updatedAt: activeStartedAt,
			owner: owner(`retained-owner-${index}`),
		});
	}
	for (let index = 0; index < 20; index++) {
		const future = new Date(Date.UTC(2030, 0, 1, 0, 0, index)).toISOString();
		await jobs.upsertStoredJob({
			id: `newer-terminal-${index}`,
			status: "completed",
			startedAt: future,
			updatedAt: future,
		});
	}
	await jobs.mutateBackgroundJobStore(() => undefined, { maxJobs: 5 });
	const stored = jobs.readBackgroundJobStore();
	for (const id of activeIds) assert.equal(stored.jobs.find((job) => job.id === id)?.status, "running");
});
