import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { withInterprocessLock } from "../extensions/_shared/file-lock.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function tempLock(t: TestContext): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-lock-test-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return path.join(dir, "state.lock");
}

test("a live lock holder cannot be stolen after the stale-age threshold", async (t) => {
	const lockPath = tempLock(t);
	let releaseStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		releaseStarted = resolve;
	});
	let holderFinishedAt = 0;
	let contenderEnteredAt = 0;

	const holder = withInterprocessLock(
		lockPath,
		async () => {
			releaseStarted();
			await delay(250);
			holderFinishedAt = Date.now();
		},
		{ staleMs: 50, timeoutMs: 1000, retryMs: 10 },
	);
	await started;
	await delay(80);
	const contender = withInterprocessLock(
		lockPath,
		() => {
			contenderEnteredAt = Date.now();
		},
		{ staleMs: 50, timeoutMs: 1000, retryMs: 10 },
	);

	await Promise.all([holder, contender]);
	assert.ok(holderFinishedAt > 0);
	assert.ok(contenderEnteredAt >= holderFinishedAt, "contender entered while the live holder still owned the lock");
});

test("a stale lock owned by a dead process is reclaimed", async (t) => {
	const lockPath = tempLock(t);
	fs.mkdirSync(lockPath, { recursive: true });
	fs.writeFileSync(
		path.join(lockPath, "owner.json"),
		JSON.stringify({ token: "dead", pid: 99_999_999, createdAt: new Date(0).toISOString() }),
	);
	const old = new Date(Date.now() - 10_000);
	fs.utimesSync(lockPath, old, old);
	let entered = false;
	await withInterprocessLock(
		lockPath,
		() => {
			entered = true;
		},
		{ staleMs: 50, timeoutMs: 1000, retryMs: 10 },
	);
	assert.equal(entered, true);
});
