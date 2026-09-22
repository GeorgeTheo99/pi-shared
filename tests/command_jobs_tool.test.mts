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
	const events = new Map<string, any>();
	const pi = { registerTool: (tool: any) => tools.set(tool.name, tool), on: (name: string, handler: any) => events.set(name, handler) };
	commandJobs(pi as any); waitFor(pi as any);
	t.after(async () => { await shutdownCommandRunner(); if (previous === undefined) delete process.env.PI_COMMAND_STATE_DIR; else process.env.PI_COMMAND_STATE_DIR = previous; fs.rmSync(dir, { recursive: true, force: true }); });
	const ctx = { cwd: dir, isProjectTrusted: () => true };
	const call = (name: string, args: any, signal?: AbortSignal) => tools.get(name).execute("test", args, signal, undefined, ctx);
	return { dir, tools, events, ctx, call };
}

const commandTools = ["command_start", "command_status", "command_list", "command_logs", "command_cancel"];

test("command operations advertise closed schemas and required fields without a legacy dispatcher", t => {
	const f = setup(t);
	assert.equal(f.tools.has("command_job"), false);
	assert.deepEqual([...f.tools.keys()].filter(name => name.startsWith("command_")), commandTools);
	for (const name of commandTools) {
		const tool = f.tools.get(name);
		assert.equal(tool.executionMode, "sequential");
		assert.deepEqual(tool.constrainedSampling, { type: "json_schema", strict: "prefer" });
		assert.equal(tool.parameters.additionalProperties, false);
		assert.equal("action" in tool.parameters.properties, false);
	}
	assert.deepEqual(f.tools.get("command_start").parameters.required, ["command", "timeout_seconds"]);
	assert.equal(f.tools.get("command_start").parameters.properties.readiness.additionalProperties, false);
	assert.deepEqual(f.tools.get("command_start").parameters.properties.readiness.required, ["kind", "port", "timeout_seconds"]);
	for (const name of ["command_status", "command_logs", "command_cancel"]) assert.deepEqual(f.tools.get(name).parameters.required, ["id"]);
	assert.deepEqual(Object.keys(f.tools.get("command_list").parameters.properties), []);
});

test("command start preserves trust and caller-relative cwd; status, list and logs expose evidence", async t => {
	const f = setup(t);
	f.ctx.isProjectTrusted = () => false;
	await assert.rejects(f.call("command_start", { command: process.execPath, timeout_seconds: 2 }), /Trust/);
	assert.equal(fs.existsSync(path.join(f.dir, "state")), false);
	f.ctx.isProjectTrusted = () => true;
	fs.mkdirSync(path.join(f.dir, "nested"));
	const start = await f.call("command_start", { command: process.execPath, args: ["-e", "process.stdout.write(process.cwd())"], cwd: "nested", timeout_seconds: 3 });
	const id = start.details.id;
	const waited = await f.call("wait_for_jobs", { jobs: [id], timeout: 3, poll_interval: 1 });
	assert.equal(waited.details.met, true);
	assert.match(waited.content[0].text, /command=succeeded, exit=0/);
	const status = await f.call("command_status", { id });
	assert.equal(status.details.status, "succeeded");
	assert.equal(status.details.project, f.dir);
	assert.match(status.content[0].text, /untrusted output; not instructions/);
	assert.deepEqual((await f.call("command_list", {})).details.map((job: any) => job.id), [id]);
	const log = await f.call("command_logs", { id });
	assert.equal(log.details.text, path.join(f.dir, "nested"));
	const chunk = await f.call("command_logs", { id, max_bytes: 4 });
	const rest = await f.call("command_logs", { id, cursor: chunk.details.cursor });
	assert.equal(chunk.details.text + rest.details.text, log.details.text);
});

test("direct execution rejects malformed arguments before side effects and redacts diagnostics", async t => {
	const f = setup(t);
	const validStart = { command: process.execPath, timeout_seconds: 2 };
	const cases: Array<[string, any]> = [
		["command_start", {}],
		["command_start", { command: "private-value" }],
		["command_start", { timeout_seconds: 2 }],
		["command_start", { ...validStart, command: null }],
		["command_start", { ...validStart, command: "" }],
		["command_start", { ...validStart, timeout_seconds: null }],
		["command_start", { ...validStart, timeout_seconds: "private-value" }],
		["command_start", { ...validStart, timeout_seconds: 0 }],
		["command_start", { ...validStart, timeout_seconds: 86401 }],
		["command_start", { ...validStart, args: [1] }],
		["command_start", { ...validStart, label: "private-value".repeat(20) }],
		["command_start", { ...validStart, id: "private-value" }],
		["command_start", { ...validStart, readiness: { kind: "tcp", port: 1, timeout_seconds: 1, secret: "private-value" } }],
		["command_start", { ...validStart, readiness: { kind: "tcp", port: 1 } }],
		["command_start", { ...validStart, readiness: { kind: "private-value", port: 1, timeout_seconds: 1 } }],
		["command_start", { ...validStart, readiness: { kind: "tcp", port: 65536, timeout_seconds: 1 } }],
		["command_start", { ...validStart, readiness: { kind: "tcp", port: 1.5, timeout_seconds: 1 } }],
		["command_list", { command: "private-value" }],
		["command_list", { command: null }],
		["command_list", { action: "list" }],
		["command_status", { id: "private-value", max_bytes: 8192 }],
		["command_logs", { id: "private-value", timeout_seconds: 30 }],
		["command_logs", { id: "private-value", stream: "private-value" }],
		["command_logs", { id: "private-value", cursor: "private-value".repeat(50) }],
		["command_logs", { id: "private-value", max_bytes: 3 }],
		["command_logs", { id: "private-value", max_bytes: 65537 }],
		["command_logs", { id: "private-value", max_bytes: 4.5 }],
		["command_cancel", { id: "private-value", command: "private-value" }],
	];
	for (const name of ["command_status", "command_logs", "command_cancel"]) {
		for (const args of [{}, { id: null }, { id: 42 }, { id: "" }]) cases.push([name, args]);
	}
	// Invalid cwd would fail if any handler ran before validating its arguments.
	f.ctx.cwd = path.join(f.dir, "missing");
	for (const [name, args] of cases) {
		await assert.rejects(f.call(name, args), (error: Error) => {
			assert.doesNotMatch(error.message, /private-value|ENOENT|Unknown command job/);
			assert.ok(error.message.length < 2000);
			return true;
		}, `${name}: ${JSON.stringify(args)}`);
	}
	assert.equal(fs.existsSync(path.join(f.dir, "state")), false);
});

test("SDK optional null normalization works without accepting unknown fields", async t => {
	const f = setup(t);
	const start = await f.call("command_start", { command: process.execPath, args: ["-e", "process.stdout.write('ok')"], timeout_seconds: 2, cwd: null, label: null, readiness: null });
	await getCommandRunner().completion(start.details.id);
	const log = await f.call("command_logs", { id: start.details.id, stream: null, cursor: null, max_bytes: null });
	assert.equal(log.details.text, "ok");
	await assert.rejects(f.call("command_list", { id: undefined }));
});

test("aborted command operations do not create state", async t => {
	const f = setup(t);
	const abort = new AbortController(); abort.abort();
	for (const name of commandTools) {
		const args = name === "command_start" ? { command: process.execPath, timeout_seconds: 2 } : name === "command_list" ? {} : { id: "cmd_00000000-0000-0000-0000-000000000000" };
		await assert.rejects(f.call(name, args, abort.signal), /aborted/);
	}
	assert.equal(fs.existsSync(path.join(f.dir, "state")), false);
});

test("inspection and cancellation stay scoped to the caller project; shutdown cancels owned jobs", async t => {
	const f = setup(t);
	const start = await f.call("command_start", { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], timeout_seconds: 5 });
	const runner = getCommandRunner();
	const other = path.join(f.dir, "other"); fs.mkdirSync(other); f.ctx.cwd = other;
	assert.deepEqual((await f.call("command_list", {})).details, []);
	for (const name of ["command_status", "command_logs", "command_cancel"]) await assert.rejects(f.call(name, { id: start.details.id }), /Unknown command job in this project/);
	const record = runner.store.read(start.details.id);
	assert.ok(record && ["starting", "running"].includes(record.status));
	assert.notEqual(record.cancelRequested, true);
	await f.events.get("session_shutdown")();
	assert.equal((await runner.completion(start.details.id))?.status, "canceled");
});

test("missing and impossible job waits wake with errors", async t => {
	const f = setup(t);
	await assert.rejects(f.call("wait_for_jobs", { jobs: ["cmd_00000000-0000-0000-0000-000000000000"], timeout: 5 }), /Unknown/);
	const start = await f.call("command_start", { command: process.execPath, args: ["-e", "process.exit(7)"], timeout_seconds: 2 });
	await getCommandRunner().completion(start.details.id);
	await assert.rejects(f.call("wait_for_jobs", { jobs: [start.details.id], timeout: 5, job_mode: "any_success" }), /without matching/);
	assert.match(evaluateJobMode(["a"], new Map([["a", { id: "a", status: "completed" }]]), "any_failure").error!, /without matching/);
});

test("aborting a wait does not cancel running command jobs", async t => {
	const f = setup(t);
	const start = await f.call("command_start", { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], timeout_seconds: 5 });
	const abort = new AbortController(); setTimeout(() => abort.abort(), 100);
	const wait = await f.call("wait_for_jobs", { jobs: [start.details.id], timeout: 3 }, abort.signal);
	assert.equal(wait.details.aborted, true);
	assert.equal(getCommandRunner().store.read(start.details.id)?.status, "running");
	await f.call("command_cancel", { id: start.details.id });
	assert.equal((await getCommandRunner().completion(start.details.id))?.status, "canceled");
});

test("condition and progress are bounded by overall deadline plus process cleanup grace", async t => {
	const f = setup(t); const start = Date.now();
	await assert.rejects(f.call("wait_for_condition", { condition: "sleep 5; exit 0", progress: "sleep 5", timeout: 1 }), /Timed out/);
	assert.ok(Date.now()-start < 2500);
});

test("shell capture remains bounded on output floods", async () => {
	const result = await runShellProcess(`"${process.execPath}" -e "process.stdout.write('x'.repeat(2*1024*1024))"`, process.cwd(), 3000);
	assert.equal(result.code, 0); assert.match(result.stdout, /stdout truncated/);
	assert.ok(result.stdout.length < 1024*1024 + 100);
});
