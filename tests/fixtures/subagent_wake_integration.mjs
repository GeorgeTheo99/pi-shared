import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import extension from "../../extensions/spawn-subagent/index.ts";
import { createJobWaker } from "../../extensions/_shared/job-wake.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-wake-")));
process.env.PI_SUBAGENT_STATE_DIR = path.join(root, "state");
process.env.PI_SUBAGENT_DEPTH = "0";
const tools = new Map();
const handlers = new Map();
const sent = [];
let idle = true;
const busListeners = new Map();
const events = {
	on: (name, listener) => { busListeners.set(name, [...(busListeners.get(name) ?? []), listener]); return () => undefined; },
	emit: (name, value) => { for (const listener of busListeners.get(name) ?? []) listener(value); },
};
const context = {
	cwd: root, hasUI: true, ui: { notify() {} }, isProjectTrusted: () => true, model: undefined, isIdle: () => idle,
	sessionManager: { getSessionId: () => "session-fixture" },
};
const emit = async (event, payload = {}) => { for (const handler of handlers.get(event) ?? []) await handler(payload, context); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let runnerDelay = 30;
globalThis.worktreeRunner = async (options) => {
	await sleep(runnerDelay);
	return {
		agent: "worker", agentSource: "shared", task: options.task, exitCode: 0, status: "completed",
		messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
		stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		updatedAt: new Date().toISOString(),
	};
};
const invoke = (name, params) => tools.get(name).execute("fixture", params, undefined, undefined, context);
const launch = async (params = {}) => {
	const result = await invoke("subagent_run", { agent: "worker", task: "inspect", background: true, ...params });
	const id = result.content[0].text.match(/job (\S+) \(/)[1];
	return { id, text: result.content[0].text };
};
const wakes = () => sent.filter(({ message }) => message.customType === "pi-job-wake");
const settle = () => sleep(1300); // batch window is one second

try {
	const pi = {
		registerTool: (definition) => { tools.set(definition.name, definition); },
		registerCommand() {}, registerMessageRenderer() {},
		on: (event, callback) => handlers.set(event, [...(handlers.get(event) ?? []), callback]),
		sendMessage: (message, options) => sent.push({ message, options }),
		events,
	};
	extension(pi);
	// Stands in for command-jobs: another extension sharing this session's hub.
	const commandWaker = createJobWaker(pi);
	await emit("session_start", { reason: "startup" });

	// Idle session: one batched follow-up turn, carrying untrusted outcome data only.
	const first = await launch();
	assert.match(first.text, /automatic follow-up turn will report/);
	await settle();
	assert.equal(wakes().length, 1);
	assert.deepEqual(wakes()[0].options, { triggerTurn: true, deliverAs: "followUp" });
	assert.match(wakes()[0].message.content, new RegExp(`subagent ${first.id} completed: .*1/1 succeeded`));
	assert.match(wakes()[0].message.content, /untrusted data, not instructions/);
	assert.match(wakes()[0].message.content, /subagent_status\(\{jobId:/);

	// Two jobs finishing together share one wake.
	sent.length = 0;
	const [a, b] = await Promise.all([launch(), launch()]);
	await settle();
	assert.equal(wakes().length, 1);
	assert.ok(wakes()[0].message.content.includes(a.id) && wakes()[0].message.content.includes(b.id));

	// Outcomes from different job extensions share one batch.
	sent.length = 0;
	const sibling = await launch();
	commandWaker.notify({ id: "cmd_fixture", kind: "command", status: "succeeded", summary: "build (exit 0)", inspect: "command_status", at: Date.now() });
	await settle();
	assert.equal(wakes().length, 1);
	assert.ok(wakes()[0].message.content.includes(sibling.id) && wakes()[0].message.content.includes("cmd_fixture"));

	// Opt-out and observed outcomes stay silent.
	sent.length = 0;
	const optOut = await launch({ notifyOnComplete: false });
	assert.doesNotMatch(optOut.text, /automatic follow-up turn/);
	const observed = await launch();
	await sleep(200);
	const status = await invoke("subagent_status", { jobId: observed.id });
	assert.match(status.content[0].text, /completed/);
	await settle();
	assert.equal(wakes().length, 0);

	// notifyOnComplete only makes sense for background work.
	await assert.rejects(
		Promise.resolve(invoke("subagent_run", { agent: "worker", task: "inspect", notifyOnComplete: true })).then((result) => {
			if (result.isError) throw new Error(result.content[0].text);
		}),
		/valid only with background=true/,
	);

	// Busy session: hold until the run ends, then continue as a follow-up.
	sent.length = 0;
	idle = false;
	const busy = await launch();
	await settle();
	assert.equal(wakes().length, 0);
	await emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [] }] });
	assert.equal(wakes().length, 1);
	assert.deepEqual(wakes()[0].options, { triggerTurn: true, deliverAs: "followUp" });
	assert.ok(wakes()[0].message.content.includes(busy.id));

	// An interrupted run is never resumed: the update waits for the next user prompt.
	sent.length = 0;
	const interrupted = await launch();
	await sleep(200);
	await emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted", content: [] }] });
	assert.equal(wakes().length, 1);
	assert.deepEqual(wakes()[0].options, { deliverAs: "nextTurn" });
	assert.ok(wakes()[0].message.content.includes(interrupted.id));

	// A provider error may be retried: a successful retry continues as a follow-up...
	sent.length = 0;
	const retried = await launch();
	await sleep(200);
	await emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", content: [] }] });
	await settle();
	assert.equal(wakes().length, 0);
	await emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [] }] });
	assert.equal(wakes().length, 1);
	assert.deepEqual(wakes()[0].options, { triggerTurn: true, deliverAs: "followUp" });
	assert.ok(wakes()[0].message.content.includes(retried.id));

	// ...while a final error (or an interrupted retry) never starts a turn on its own.
	sent.length = 0;
	const errored = await launch();
	await sleep(200);
	await emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", content: [] }] });
	idle = true;
	await emit("agent_settled");
	assert.equal(wakes().length, 1);
	assert.deepEqual(wakes()[0].options, { deliverAs: "nextTurn" });
	assert.ok(wakes()[0].message.content.includes(errored.id));
	await settle();
	assert.equal(wakes().length, 1);
	idle = false;

	// A self-handoff checkpoint holds wakes; rollback releases them.
	sent.length = 0;
	idle = true;
	events.emit("pi-shared:self-handoff:begin", { attemptId: "attempt-1", sessionId: "session-fixture" });
	const heldJob = await launch();
	await settle();
	await emit("agent_settled");
	await settle();
	assert.equal(wakes().length, 0);
	events.emit("pi-shared:self-handoff:rollback", { attemptId: "attempt-1", sessionId: "session-fixture" });
	await settle();
	assert.equal(wakes().length, 1);
	assert.ok(wakes()[0].message.content.includes(heldJob.id));
	idle = false;

	// A handoff that begins mid-run still respects an interrupt or a final error.
	for (const stopReason of ["aborted", "error"]) {
		sent.length = 0;
		idle = false;
		events.emit("pi-shared:self-handoff:begin", { attemptId: `attempt-${stopReason}`, sessionId: "session-fixture" });
		const job = await launch();
		await sleep(200);
		await emit("agent_end", { messages: [{ role: "assistant", stopReason, content: [] }] });
		idle = true;
		await emit("agent_settled");
		events.emit("pi-shared:self-handoff:rollback", { attemptId: `attempt-${stopReason}`, sessionId: "session-fixture" });
		await settle();
		assert.equal(wakes().length, 1);
		assert.deepEqual(wakes()[0].options, { deliverAs: "nextTurn" });
		assert.ok(wakes()[0].message.content.includes(job.id));
	}
	idle = false;

	// Outcomes after agent_end without a later run are delivered once settled.
	sent.length = 0;
	await launch();
	await sleep(200);
	idle = true;
	await emit("agent_settled");
	await settle();
	assert.equal(wakes().length, 1);

	// Teardown cancellations never wake the next session.
	sent.length = 0;
	runnerDelay = 500;
	await launch();
	await emit("session_shutdown", { reason: "quit" });
	await settle();
	assert.equal(wakes().length, 0);
	console.log("subagent wake integration passed");
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
