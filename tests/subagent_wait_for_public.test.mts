import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";

// Set the subagent store before importing its module-level path constants.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-public-")));
const previous = process.env.PI_SUBAGENT_STATE_DIR;
process.env.PI_SUBAGENT_STATE_DIR = path.join(root, "subagents");
const { default: waitFor } = await import("../extensions/wait-for/index.ts");
const { CommandJobStore } = await import("../extensions/_shared/command-job-store.ts");
const { upsertStoredJob } = await import("../extensions/_shared/job-store.ts");
test.after(() => {
	if (previous === undefined) delete process.env.PI_SUBAGENT_STATE_DIR;
	else process.env.PI_SUBAGENT_STATE_DIR = previous;
	fs.rmSync(root, { recursive: true, force: true });
});

function setup(t: any) {
	const dir = fs.mkdtempSync(path.join(root, "case-"));
	const oldCommandDir = process.env.PI_COMMAND_STATE_DIR;
	process.env.PI_COMMAND_STATE_DIR = path.join(dir, "commands");
	t.after(() => {
		if (oldCommandDir === undefined) delete process.env.PI_COMMAND_STATE_DIR;
		else process.env.PI_COMMAND_STATE_DIR = oldCommandDir;
	});
	const tools = new Map<string, any>();
	waitFor({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any);
	const ctx = { cwd: dir };
	const call = (name: string, args: any, signal?: AbortSignal, update?: any) => tools.get(name).execute("test", args, signal, update, ctx);
	const store = new CommandJobStore();
	async function command(status = "running", readiness = "ready") {
		const id = `cmd_${randomUUID()}`;
		await store.reserve({ version: 1, id, owner: "fixture", ownerPid: process.pid, project: dir, label: "fixture", createdAt: Date.now(), updatedAt: Date.now(), status, readiness, exitCode: status === "failed" ? 7 : undefined, stdoutBytes: 0, stderrBytes: 0, stdoutOmitted: 0, stderrOmitted: 0 } as any);
		return id;
	}
	return { tools, ctx, call, command, store };
}

const names = ["wait_for_condition", "wait_for_jobs", "wait_for_ready"];
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

test("public wait operations have closed narrow schemas, constrained sampling, and accurate render titles", t => {
	const f = setup(t);
	assert.deepEqual([...f.tools.keys()], names);
	const fields = [
		["condition", "timeout", "poll_interval", "progress", "failure_exit_codes"],
		["jobs", "timeout", "poll_interval", "job_mode"],
		["jobs", "timeout", "poll_interval"],
	];
	for (const [index, name] of names.entries()) {
		const tool = f.tools.get(name);
		assert.equal(tool.parameters.additionalProperties, false);
		assert.deepEqual(Object.keys(tool.parameters.properties), fields[index]);
		assert.deepEqual(tool.parameters.required, [index === 0 ? "condition" : "jobs", "timeout"]);
		assert.equal(tool.executionMode, "sequential");
		assert.deepEqual(tool.constrainedSampling, { type: "json_schema", strict: "prefer" });
		assert.match(tool.renderCall({}, theme).text, new RegExp(`^${name} `));
		assert.match(tool.renderCall({ condition: "true", jobs: [], readiness: true }, theme).text, new RegExp(`^${name} `));
		assert.doesNotMatch([tool.description, tool.promptSnippet, ...tool.promptGuidelines].join("\n"), /spawn_subagent|command_job|jobAction|\bwait_for\b/);
	}
	assert.deepEqual(f.tools.get("wait_for_jobs").parameters.properties.job_mode.enum, ["all", "any", "any_success", "any_failure"]);
});

test("direct execute and prepareArguments reject missing, malformed, and cross-operation arguments without leaking input", async t => {
	const f = setup(t);
	f.ctx.cwd = path.join(root, "does-not-exist"); // No engine invocation should reach filesystem access.
	const secret = "private-argument-marker";
	const condition = { condition: `printf ${secret}`, timeout: 1 };
	const jobs = { jobs: ["sub_fixture"], timeout: 1 };
	const ready = { jobs: [`cmd_${randomUUID()}`], timeout: 1 };
	const cases: Array<[string, any]> = [];
	for (const [name, args] of [[names[0], condition], [names[1], jobs], [names[2], ready]] as const) {
		for (const input of [{}, { timeout: 1 }, { ...args, timeout: undefined }, { ...args, timeout: null }, { ...args, timeout: 0 }, { ...args, timeout: secret }, { ...args, poll_interval: secret }, { ...args, extra: secret }, { ...args, extra: null }]) cases.push([name, input]);
	}
	for (const input of [{ condition: null }, { condition: " " }, { condition: [] }, { jobs: [] }, { job_mode: "all" }, { readiness: false }, { failure_exit_codes: [0] }, { failure_exit_codes: [256] }, { failure_exit_codes: [1.5] }, { failure_exit_codes: Array(256).fill(2) }]) cases.push([names[0], { ...condition, ...input }]);
	for (const name of names.slice(1)) {
		const base = name === names[1] ? jobs : ready;
		for (const input of [{ jobs: [] }, { jobs: null }, { jobs: [" "] }, { jobs: [1] }, { jobs: Array(65).fill("sub_fixture") }, { condition: secret }, { progress: secret }, { failure_exit_codes: [] }, { readiness: true }]) cases.push([name, { ...base, ...input }]);
	}
	cases.push([names[1], { ...jobs, job_mode: secret }], [names[2], { ...ready, jobs: ["sub_fixture"] }], [names[2], { ...ready, job_mode: "all" }]);
	for (const [name, args] of cases) {
		const check = (error: Error) => {
			assert.match(error.message, new RegExp(`Invalid arguments for ${name}`));
			assert.doesNotMatch(error.message, new RegExp(`${secret}|ENOENT`));
			return true;
		};
		assert.throws(() => f.tools.get(name).prepareArguments(args), check);
		await assert.rejects(f.call(name, args), check);
	}
});

test("condition facade preserves fatal exit codes, timeout diagnostics, timing clamps, and stock optional null handling", async t => {
	const f = setup(t);
	const met = await f.call(names[0], { condition: "true", timeout: 90000, poll_interval: -1, progress: null, failure_exit_codes: null });
	assert.equal(met.details.met, true);
	assert.equal(met.details.timeout, 86400);
	assert.equal(met.details.pollInterval, 1);
	await assert.rejects(f.call(names[0], { condition: "exit 127", timeout: 5 }), /exit 127/);
	await assert.rejects(f.call(names[0], { condition: "printf fatal >&2; exit 2", failure_exit_codes: [2], timeout: 5 }), /exit 2[\s\S]*fatal/);
	await assert.rejects(f.call(names[0], { condition: "printf pending; exit 127", failure_exit_codes: [], timeout: 1 }), /Timed out[\s\S]*pending/);
});

test("job facade preserves unsuccessful terminal outcomes, impossible modes, and actionable interactive wake", async t => {
	const f = setup(t);
	const failed = await f.command("failed", "not_requested");
	const result = await f.call(names[1], { jobs: [failed], timeout: 2 });
	assert.equal(result.details.met, true);
	assert.equal(result.details.failedJobs, 1);
	assert.match(result.content[0].text, /Terminal does not imply successful/);
	assert.match(result.content[0].text, /command_status\(.*subagent_status\(.*subagent_answer\(/s);
	assert.doesNotMatch(result.content[0].text, /command_job|spawn_subagent/);
	await assert.rejects(f.call(names[1], { jobs: [failed], timeout: 2, job_mode: "any_success" }), /All jobs terminal without matching/);
	await assert.rejects(f.call(names[1], { jobs: [`cmd_${randomUUID()}`], timeout: 2 }), /Unknown job IDs/);
	const id = `sub_${randomUUID()}`;
	await upsertStoredJob({ id, status: "awaiting_answer", updatedAt: new Date().toISOString(), interactive: true, question: { id: "q_fixture", exchange: 1, text: "Question?", askedAt: new Date().toISOString(), untrusted: true } });
	for (const job_mode of ["all", "any", "any_success", "any_failure"]) {
		const answer = await f.call(names[1], { jobs: [failed, id], timeout: 2, job_mode });
		assert.equal(answer.details.awaitingJobs, 1);
		assert.equal(answer.details.met, true);
	}
});

test("readiness facade fixes all/ready mode, waits for every probe, and rejects unavailable readiness", async t => {
	const f = setup(t);
	const ready = await f.command();
	const pending = await f.command("running", "pending");
	let updated = false;
	const result = await f.call(names[2], { jobs: [ready, pending], timeout: 3, poll_interval: 1 }, undefined, () => {
		updated = true;
		// Fixture-only synchronous publication avoids racing the next poll.
		const record = f.store.read(pending)!;
		fs.writeFileSync(path.join(f.store.jobDir(pending), "job.json"), JSON.stringify({ ...record, readiness: "ready" }));
	});
	assert.equal(updated, true);
	assert.equal(result.details.checks, 2);
	assert.equal(result.details.jobMode, "all");
	assert.match(result.content[0].text, /Readiness is not completion/);
	for (const [status, readiness] of [["running", "not_requested"], ["running", "failed"], ["succeeded", "ready"]]) {
		const id = await f.command(status, readiness);
		await assert.rejects(f.call(names[2], { jobs: [id], timeout: 2 }), /cannot become ready/);
	}
});

test("aborted public waits preserve job state and use operation-specific cancellation guidance", async t => {
	const f = setup(t);
	const id = await f.command("running", "pending");
	const abort = new AbortController();
	abort.abort();
	for (const name of names) {
		const args = name === names[0] ? { condition: "true", timeout: 1 } : { jobs: [id], timeout: 1 };
		const result = await f.call(name, args, abort.signal);
		assert.equal(result.details.aborted, true);
		assert.equal(result.details.met, false);
		if (name !== names[0]) assert.match(result.content[0].text, /command_cancel.*subagent_cancel/);
	}
	assert.equal(f.store.read(id)?.status, "running");
});
