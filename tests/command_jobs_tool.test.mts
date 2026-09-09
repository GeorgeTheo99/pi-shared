import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import commandJobs from "../extensions/command-jobs/index.ts";
import waitFor, { evaluateJobMode } from "../extensions/wait-for/index.ts";
import { getCommandRunner, shutdownCommandRunner } from "../extensions/_shared/command-job-runner.ts";
import { runShellProcess } from "../extensions/_shared/shell-process.ts";

function setup(t: any) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-command-tool-")));
	const previous = process.env.PI_COMMAND_STATE_DIR;
	process.env.PI_COMMAND_STATE_DIR = path.join(dir, "state");
	const tools = new Map<string, any>();
	const pi = { registerTool: (tool: any) => tools.set(tool.name, tool), on() {} };
	commandJobs(pi as any); waitFor(pi as any);
	t.after(async () => { await shutdownCommandRunner(); if (previous === undefined) delete process.env.PI_COMMAND_STATE_DIR; else process.env.PI_COMMAND_STATE_DIR = previous; fs.rmSync(dir, { recursive: true, force: true }); });
	const ctx = { cwd: dir, isProjectTrusted: () => true };
	const call = (name: string, args: any, signal?: AbortSignal) => tools.get(name).execute("test", args, signal, undefined, ctx);
	return { dir, tools, ctx, call };
}

test("command tool validates action, trust, and scopes cwd to caller", async t => {
	const f = setup(t);
	assert.equal(f.tools.get("command_job").executionMode, "sequential");
	assert.equal(f.tools.get("wait_for").executionMode, "sequential");
	await assert.rejects(f.call("command_job", { action: "start", command: process.execPath }), /requires/);
	await assert.rejects(f.call("command_job", { action: "list", command: "oops" }), /Invalid fields/);
	f.ctx.isProjectTrusted = () => false;
	await assert.rejects(f.call("command_job", { action: "start", command: process.execPath, timeout_seconds: 2 }), /Trust/);
	f.ctx.isProjectTrusted = () => true;
	fs.mkdirSync(path.join(f.dir, "nested"));
	const start = await f.call("command_job", { action: "start", command: process.execPath, args: ["-e", "process.stdout.write(process.cwd())"], cwd: "nested", timeout_seconds: 3 });
	const id = start.details.id;
	const waited = await f.call("wait_for", { jobs: [id], timeout: 3, poll_interval: 1 });
	assert.equal(waited.details.met, true);
	assert.match(waited.content[0].text, /command=succeeded, exit=0/);
	const log = await f.call("command_job", { action: "logs", id });
	assert.equal(log.details.text, path.join(f.dir, "nested"));
});

test("missing and impossible job waits wake with errors", async t => {
	const f = setup(t);
	await assert.rejects(f.call("wait_for", { jobs: ["cmd_00000000-0000-0000-0000-000000000000"], timeout: 5 }), /Unknown/);
	const start = await f.call("command_job", { action: "start", command: process.execPath, args: ["-e", "process.exit(7)"], timeout_seconds: 2 });
	await getCommandRunner().completion(start.details.id);
	await assert.rejects(f.call("wait_for", { jobs: [start.details.id], timeout: 5, job_mode: "any_success" }), /without matching/);
	assert.match(evaluateJobMode(["a"], new Map([["a", { id: "a", status: "completed" }]]), "any_failure").error!, /without matching/);
});

test("aborting a wait does not cancel running command jobs", async t => {
	const f = setup(t);
	const start = await f.call("command_job", { action: "start", command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], timeout_seconds: 5 });
	const abort = new AbortController(); setTimeout(() => abort.abort(), 100);
	const wait = await f.call("wait_for", { jobs: [start.details.id], timeout: 3 }, abort.signal);
	assert.equal(wait.details.aborted, true);
	assert.equal(getCommandRunner().store.read(start.details.id)?.status, "running");
	await f.call("command_job", { action: "cancel", id: start.details.id });
	assert.equal((await getCommandRunner().completion(start.details.id))?.status, "canceled");
});

test("condition and progress are bounded by overall deadline plus process cleanup grace", async t => {
	const f = setup(t); const start = Date.now();
	await assert.rejects(f.call("wait_for", { condition: "sleep 5; exit 0", progress: "sleep 5", timeout: 1 }), /Timed out/);
	assert.ok(Date.now()-start < 2500);
});

test("shell capture remains bounded on output floods", async () => {
	const result = await runShellProcess(`"${process.execPath}" -e "process.stdout.write('x'.repeat(2*1024*1024))"`, process.cwd(), 3000);
	assert.equal(result.code, 0); assert.match(result.stdout, /stdout truncated/);
	assert.ok(result.stdout.length < 1024*1024 + 100);
});
