import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { runManagedProcess, startManagedProcess } from "../extensions/_shared/managed-process.ts";

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

test("managed processes provide ordered bounded JSONL stdin and graceful EOF", async () => {
	const lines: string[] = [];
	const handle = startManagedProcess({
		...baseOptions,
		command: process.execPath,
		args: [
			"-e",
			`let b="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>{b+=c});process.stdin.on("end",()=>{for(const l of b.split("\\n").filter(Boolean)){const v=JSON.parse(l);console.log(JSON.stringify({index:v.index,value:v.index===1?v.value:v.value.length}));}});`,
		],
		stdin: "pipe",
		onStdoutLine: (line) => lines.push(line),
	});
	await Promise.all([
		handle.writeJsonLine({ index: 1, value: "line one\nline two\u2028kept" }),
		handle.writeJsonLine({ index: 2, value: "🙂".repeat(1000) }),
	]);
	await handle.endStdin();
	const result = await handle.completion;
	assert.equal(result.exitCode, 0);
	assert.deepEqual(lines.map((line) => JSON.parse(line).index), [1, 2]);
	assert.equal(JSON.parse(lines[0]).value, "line one\nline two\u2028kept");
});

test("managed stdin EPIPE rejects writes without crashing the parent process", async () => {
	const handle = startManagedProcess({
		...baseOptions,
		command: process.execPath,
		args: ["-e", "require('node:fs').closeSync(0); setTimeout(()=>{},1000)"],
		stdin: "pipe",
	});
	await new Promise((resolve) => setTimeout(resolve, 75));
	await assert.rejects(handle.writeStdin("x".repeat(64 * 1024)), /EPIPE|stdin/i);
	const result = await handle.completion;
	assert.notEqual(result.exitCode, 0);
	assert.match(result.errorMessage ?? "", /stdin failed|EPIPE/i);
});

test("managed processes reject stdin writes after graceful EOF", async () => {
	const handle = startManagedProcess({
		...baseOptions,
		command: process.execPath,
		args: ["-e", "process.stdin.resume()"],
		stdin: "pipe",
	});
	await handle.endStdin();
	await assert.rejects(handle.writeJsonLine({ late: true }), /stdin is not writable/);
	assert.equal((await handle.completion).exitCode, 0);
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

test("output-limit termination never flushes a trailing forged frame", async () => {
	const lines: string[] = [];
	const result = await runManagedProcess({
		...baseOptions,
		command: process.execPath,
		args: [
			"-e",
			'process.stdout.write("x".repeat(300)+"\\n"+JSON.stringify({forged:true})); setInterval(()=>{},1000)',
		],
		maxEventBytes: 256,
		onStdoutLine: (line) => lines.push(line),
	});
	assert.equal(result.terminationReason, "output_limit");
	assert.deepEqual(lines, []);
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
