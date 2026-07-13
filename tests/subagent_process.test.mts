import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { runManagedProcess } from "../extensions/_shared/managed-process.ts";

const baseOptions = {
	cwd: path.resolve(import.meta.dirname, ".."),
	env: process.env,
	runTimeoutMs: 5000,
	termGraceMs: 100,
	maxStderrBytes: 64,
	maxEventBytes: 1024,
};

test("managed processes stream lines and bound stderr", async () => {
	const lines: string[] = [];
	const result = await runManagedProcess({
		...baseOptions,
		command: process.execPath,
		args: ["-e", 'console.log(JSON.stringify({ok:true})); console.error("x".repeat(200))'],
		onStdoutLine: (line) => lines.push(line),
	});
	assert.equal(result.exitCode, 0);
	assert.equal(result.terminationReason, undefined);
	assert.deepEqual(lines, ['{"ok":true}']);
	assert.equal(result.stderrTruncated, true);
	assert.match(result.stderr, /stderr truncated/);
	assert.ok(Buffer.byteLength(result.stderr, "utf8") < 160);
});

test("managed processes reject oversized unterminated events", async () => {
	const result = await runManagedProcess({
		...baseOptions,
		command: process.execPath,
		args: ["-e", 'process.stdout.write("x".repeat(4096)); setInterval(()=>{},1000)'],
		maxEventBytes: 256,
	});
	assert.equal(result.terminationReason, "output_limit");
	assert.notEqual(result.exitCode, 0);
});

test("abort waits for actual child shutdown", async () => {
	const controller = new AbortController();
	let pid: number | undefined;
	const run = runManagedProcess({
		...baseOptions,
		command: process.execPath,
		args: ["-e", "setInterval(()=>{},1000)"],
		signal: controller.signal,
		onSpawn: (value) => {
			pid = value;
			setTimeout(() => controller.abort(), 50);
		},
	});
	const result = await run;
	assert.equal(result.terminationReason, "aborted");
	assert.ok(pid);
	assert.throws(() => process.kill(pid!, 0));
});

async function waitUntilDead(pid: number, timeoutMs = 1500): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch {
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return false;
}

test("leader exit during termination cannot leak a stubborn descendant", async (t) => {
	const fixture = path.join(import.meta.dirname, "fixtures", "subagent_cooperative_parent_stubborn_child.mjs");
	assert.equal(fs.existsSync(fixture), true);
	let childPid: number | undefined;
	t.after(() => {
		if (!childPid) return;
		try {
			process.kill(childPid, "SIGKILL");
		} catch {
			// Already reaped.
		}
	});
	const result = await runManagedProcess({
		...baseOptions,
		command: process.execPath,
		args: [fixture],
		runTimeoutMs: 750,
		termGraceMs: 500,
		onStdoutLine: (line) => {
			childPid = JSON.parse(line).childPid;
		},
	});
	assert.equal(result.terminationReason, "timeout");
	assert.notEqual(result.exitCode, 0);
	assert.ok(childPid);
	assert.equal(await waitUntilDead(childPid!), true, `descendant ${childPid} survived after its leader exited`);
});

test("abort settles when an orphaned descendant keeps output pipes open", { skip: process.platform === "win32" }, async (t) => {
	const fixture = path.join(import.meta.dirname, "fixtures", "subagent_orphaned_pipe.mjs");
	assert.equal(fs.existsSync(fixture), true);
	const controller = new AbortController();
	let childPid: number | undefined;
	t.after(() => {
		if (!childPid) return;
		try {
			process.kill(childPid, "SIGKILL");
		} catch {
			// Already dead.
		}
	});
	const startedAt = Date.now();
	const run = runManagedProcess({
		...baseOptions,
		command: process.execPath,
		args: [fixture],
		signal: controller.signal,
		termGraceMs: 100,
		onStdoutLine: (line) => {
			childPid = JSON.parse(line).childPid;
			setTimeout(() => controller.abort(), 25);
		},
	});
	const result = await run;
	assert.equal(result.terminationReason, "aborted");
	assert.ok(Date.now() - startedAt < 1500, "managed process did not settle after forced termination");
	assert.ok(childPid);
	assert.equal(await waitUntilDead(childPid!), true, `descendant ${childPid} survived forced settlement`);
});

test("timeout escalates to SIGKILL for a stubborn process tree", { skip: process.platform === "win32" }, async () => {
	const fixture = path.join(import.meta.dirname, "fixtures", "subagent_stubborn_tree.mjs");
	assert.equal(fs.existsSync(fixture), true);
	let childPid: number | undefined;
	const startedAt = Date.now();
	const result = await runManagedProcess({
		...baseOptions,
		command: process.execPath,
		args: [fixture],
		runTimeoutMs: 150,
		termGraceMs: 100,
		onStdoutLine: (line) => {
			const parsed = JSON.parse(line);
			childPid = parsed.childPid;
		},
	});
	assert.equal(result.terminationReason, "timeout");
	assert.notEqual(result.exitCode, 0);
	assert.ok(Date.now() - startedAt < 3000);
	assert.ok(childPid);
	assert.equal(await waitUntilDead(childPid!), true, `descendant ${childPid} survived process-group termination`);
});
