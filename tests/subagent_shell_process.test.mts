import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { runShellProcess } from "../extensions/_shared/shell-process.ts";

const cwd = path.resolve(import.meta.dirname, "..");

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

test("shell process preserves stdout exactly and accepts long lines", async () => {
	const result = await runShellProcess(
		`${JSON.stringify(process.execPath)} -e 'process.stdout.write("abc" + "x".repeat(70000))'`,
		cwd,
		5000,
	);
	assert.equal(result.code, 0);
	assert.equal(result.stdout.length, 70003);
	assert.equal(result.stdout.startsWith("abc"), true);
	assert.equal(result.stdout.endsWith("\n"), false);
});

test("aborting a shell process terminates its process group", { skip: process.platform === "win32" }, async () => {
	const controller = new AbortController();
	let childPid: number | undefined;
	const command = `${JSON.stringify(process.execPath)} -e 'const {spawn}=require("node:child_process"); const c=spawn(process.execPath,["-e","process.on(\\"SIGTERM\\",()=>{});setInterval(()=>{},1000)"],{stdio:["ignore","ignore","ignore"]}); console.log(c.pid); setInterval(()=>{},1000)'`;
	const run = runShellProcess(command, cwd, 5000, controller.signal);
	await new Promise((resolve) => setTimeout(resolve, 100));
	controller.abort();
	const result = await run;
	childPid = Number(result.stdout.trim());
	assert.equal(result.aborted, true);
	assert.ok(Number.isInteger(childPid));
	assert.equal(await waitUntilDead(childPid!), true, `shell descendant ${childPid} survived abort`);
});
