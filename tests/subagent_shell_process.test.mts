import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
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

test("aborting a shell process terminates its process group", { skip: process.platform === "win32" }, async (t) => {
	const controller = new AbortController();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-shell-ready-"));
	const readyFile = path.join(dir, "ready");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const script = `const {spawn}=require("node:child_process"); const c=spawn(process.execPath,["-e","process.on(\\"SIGTERM\\",()=>{});setInterval(()=>{},1000)"],{stdio:["ignore","ignore","ignore"]}); console.log(c.pid); require("node:fs").writeFileSync(${JSON.stringify(readyFile)},String(c.pid)); setInterval(()=>{},1000)`;
	const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
	const run = runShellProcess(command, cwd, 5000, controller.signal);
	try {
		const deadline = Date.now() + 4000;
		let childPid = 0;
		while (Date.now() < deadline && childPid <= 0) {
			try { childPid = Number(fs.readFileSync(readyFile, "utf8")); } catch {}
			if (!(childPid > 0)) await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.ok(Number.isInteger(childPid) && childPid > 0, "shell descendant must be ready before abort");
		controller.abort();
		const result = await run;
		assert.equal(result.aborted, true);
		assert.equal(Number(result.stdout.trim()), childPid);
		assert.equal(await waitUntilDead(childPid), true, `shell descendant ${childPid} survived abort`);
	} finally {
		controller.abort();
		await run;
	}
});
