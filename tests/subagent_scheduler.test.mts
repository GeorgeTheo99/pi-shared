import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadSubagentConfig } from "../extensions/_shared/subagent-config.ts";
import {
	SubagentFanoutError,
	createSubagentExecutionGroup,
} from "../extensions/_shared/subagent-scheduler.ts";

function tempStateDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-scheduler-test-"));
}

function configFor(stateDir: string, concurrency = 3, fanout = 16) {
	const config = loadSubagentConfig({
		PI_SUBAGENT_STATE_DIR: stateDir,
		PI_SUBAGENT_MAX_CONCURRENCY: String(concurrency),
		PI_SUBAGENT_MAX_FANOUT: String(fanout),
		PI_SUBAGENT_QUEUE_TIMEOUT_MS: "10000",
		PI_SUBAGENT_HEARTBEAT_MS: "1000",
		PI_SUBAGENT_LEASE_MS: "10000",
	});
	assert.deepEqual(config.errors, []);
	return config;
}

test("scheduler enforces one concurrency limit across request groups", async (t) => {
	const stateDir = tempStateDir();
	t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
	const config = configFor(stateDir, 3);
	const first = createSubagentExecutionGroup(config, "first");
	const second = createSubagentExecutionGroup(config, "second");
	let active = 0;
	let peak = 0;
	const tasks = Array.from({ length: 12 }, (_, index) =>
		(index % 2 ? first : second).run({ label: String(index) }, async () => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, 80));
			active--;
			return index;
		}),
	);
	assert.deepEqual(await Promise.all(tasks), Array.from({ length: 12 }, (_, index) => index));
	assert.equal(peak, 3);
});

test("execution groups reject fan-out above their configured maximum", async (t) => {
	const stateDir = tempStateDir();
	t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
	const config = configFor(stateDir, 1, 2);
	const group = createSubagentExecutionGroup(config, "fanout");
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const first = group.run({}, () => gate);
	const second = group.run({}, () => gate);
	await assert.rejects(group.run({}, async () => undefined), SubagentFanoutError);
	release();
	await Promise.all([first, second]);
});

test("an aborted queued request never starts", async (t) => {
	const stateDir = tempStateDir();
	t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
	const config = configFor(stateDir, 1);
	const activeGroup = createSubagentExecutionGroup(config, "active");
	let release!: () => void;
	let started!: () => void;
	const startedPromise = new Promise<void>((resolve) => {
		started = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const active = activeGroup.run({}, async () => {
		started();
		await gate;
	});
	await startedPromise;

	const controller = new AbortController();
	const queuedGroup = createSubagentExecutionGroup(config, "queued", controller.signal);
	let queuedStarted = false;
	const queued = queuedGroup.run({}, async () => {
		queuedStarted = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 50));
	controller.abort();
	await assert.rejects(queued, (error: any) => error?.name === "AbortError");
	assert.equal(queuedStarted, false);
	release();
	await active;
});

function runSchedulerWorker(stateDir: string, id: number): Promise<{ id: string; start: number; end: number }> {
	const fixture = path.join(import.meta.dirname, "fixtures", "subagent_scheduler_worker.mjs");
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [fixture, stateDir, String(id), "300", "2"], {
			cwd: path.resolve(import.meta.dirname, ".."),
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) return reject(new Error(`scheduler worker ${id} exited ${code}: ${stderr}`));
			resolve(JSON.parse(stdout.trim()));
		});
	});
}

test("scheduler cap is host-wide across independent Node processes", async (t) => {
	const stateDir = tempStateDir();
	t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
	const timings = await Promise.all(Array.from({ length: 6 }, (_, index) => runSchedulerWorker(stateDir, index)));
	const events = timings.flatMap((timing) => [
		{ at: timing.start, delta: 1 },
		{ at: timing.end, delta: -1 },
	]);
	events.sort((a, b) => a.at - b.at || a.delta - b.delta);
	let active = 0;
	let peak = 0;
	for (const event of events) {
		active += event.delta;
		peak = Math.max(peak, active);
	}
	assert.equal(peak, 2);
});
