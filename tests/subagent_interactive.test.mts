import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	createInteractivePiAgent,
	getFinalAssistantOutput,
	getSubagentThinkingArgs,
	runPiAgent,
	type InteractivePiAgentSession,
} from "../extensions/_shared/pi-agent-runner.ts";
import { loadSubagentConfig } from "../extensions/_shared/subagent-config.ts";
import { createSubagentExecutionGroup } from "../extensions/_shared/subagent-scheduler.ts";

const fixture = path.join(import.meta.dirname, "fixtures", "subagent_interactive_rpc_child.mjs");
const oneShotFixture = path.join(import.meta.dirname, "fixtures", "subagent_json_child.mjs");

function setup(
	scenario = "two",
	maxExchanges: number | undefined = undefined,
	runTimeoutMs = 10000,
	maxEventBytes = 4 * 1024 * 1024,
) {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-interactive-test-"));
	const config = loadSubagentConfig({
		PI_SUBAGENT_STATE_DIR: stateDir,
		PI_SUBAGENT_MAX_CONCURRENCY: "1",
		PI_SUBAGENT_MAX_FANOUT: "4",
		PI_SUBAGENT_QUEUE_TIMEOUT_MS: "10000",
		PI_SUBAGENT_RUN_TIMEOUT_MS: String(runTimeoutMs),
		PI_SUBAGENT_TERM_GRACE_MS: "100",
		PI_SUBAGENT_MAX_CAPTURE_BYTES: "65536",
		PI_SUBAGENT_MAX_EVENT_BYTES: String(maxEventBytes),
		PI_SUBAGENT_HEARTBEAT_MS: "1000",
		PI_SUBAGENT_LEASE_MS: "10000",
	});
	assert.deepEqual(config.errors, []);
	const agents = [
		{
			name: "fixture",
			description: "fixture",
			tools: ["read"],
			systemPrompt: "Fixture agent.",
			source: "shared" as const,
			filePath: fixture,
		},
	];
	return {
		stateDir,
		config,
		create: () =>
			createInteractivePiAgent({
				config,
				defaultCwd: path.resolve(import.meta.dirname, ".."),
				agents,
				agentName: "fixture",
				task: "exercise RPC",
				maxExchanges,
				invocation: { command: process.execPath, args: [fixture, scenario] },
			}),
	};
}

async function cancelAfter(session: InteractivePiAgentSession | undefined) {
	if (!session) return;
	await session.cancel("test cleanup").catch(() => undefined);
}

test("child thinking defaults high while explicit overrides and model suffixes retain precedence", () => {
	assert.deepEqual(getSubagentThinkingArgs(undefined), ["--thinking", "high"]);
	assert.deepEqual(getSubagentThinkingArgs("provider/model"), ["--thinking", "high"]);
	assert.deepEqual(getSubagentThinkingArgs("provider/model:xhigh"), ["--thinking", "xhigh"]);
	assert.deepEqual(getSubagentThinkingArgs("provider/model:xhigh", "low"), ["--thinking", "low"]);
});

test("recognized thinking suffixes stay explicit even when the model id could be an exact catalog match", () => {
	assert.deepEqual(getSubagentThinkingArgs("ollama/foo:high"), ["--thinking", "high"]);
});

test("non-interactive runPiAgent remains one-shot through the managed runner", async (t) => {
	const env = setup("one");
	t.after(() => fs.rmSync(env.stateDir, { recursive: true, force: true }));
	const group = createSubagentExecutionGroup(env.config, "one-shot");
	const result = await runPiAgent({
		config: env.config,
		group,
		defaultCwd: path.resolve(import.meta.dirname, ".."),
		agents: [
			{
				name: "fixture",
				description: "fixture",
				systemPrompt: "Fixture agent.",
				source: "shared",
				filePath: oneShotFixture,
			},
		],
		agentName: "fixture",
		task: "one shot",
		invocation: { command: process.execPath, args: [oneShotFixture] },
	});
	assert.equal(result.status, "completed");
	assert.equal(getFinalAssistantOutput(result.messages), "one-shot-ok");
	assert.equal(result.usage.turns, 1);
});

test("one-shot children cannot succeed without a final assistant result", async (t) => {
	const env = setup("one");
	t.after(() => fs.rmSync(env.stateDir, { recursive: true, force: true }));
	const group = createSubagentExecutionGroup(env.config, "empty-one-shot");
	const result = await runPiAgent({
		config: env.config,
		group,
		defaultCwd: path.resolve(import.meta.dirname, ".."),
		agents: [
			{
				name: "fixture",
				description: "fixture",
				systemPrompt: "Fixture agent.",
				source: "shared",
				filePath: oneShotFixture,
			},
		],
		agentName: "fixture",
		task: "must return a result",
		invocation: { command: process.execPath, args: ["-e", "process.exit(0)"] },
	});
	assert.equal(result.status, "failed");
	assert.match(result.errorMessage ?? "", /without a non-empty final assistant result/);
});

test("interactive RPC keeps one child across exchanges and releases/reacquires the scheduler lease", async (t) => {
	const env = setup("two");
	t.after(() => fs.rmSync(env.stateDir, { recursive: true, force: true }));
	let session: InteractivePiAgentSession | undefined;
	t.after(() => cancelAfter(session));
	session = await env.create();

	const firstGroup = createSubagentExecutionGroup(env.config, "first segment");
	const first = await session.start(firstGroup);
	assert.equal(first.status, "awaiting_answer");
	assert.equal(first.question?.exchange, 1);
	const pid = session.pid;
	assert.ok(pid);

	let releaseBlocker!: () => void;
	let blockerStarted!: () => void;
	const blockerGate = new Promise<void>((resolve) => (releaseBlocker = resolve));
	const blockerReady = new Promise<void>((resolve) => (blockerStarted = resolve));
	const blockerGroup = createSubagentExecutionGroup(env.config, "blocker");
	const blocker = blockerGroup.run({}, async () => {
		blockerStarted();
		await blockerGate;
	});
	await blockerReady;

	const secondGroup = createSubagentExecutionGroup(env.config, "second segment");
	const queuedAnswer = session.answer(secondGroup, first.question!.id, "line one\nline two\u2028kept");
	const queuedState = await Promise.race([
		queuedAnswer.then(() => "settled"),
		new Promise<string>((resolve) => setTimeout(() => resolve("queued"), 100)),
	]);
	assert.equal(queuedState, "queued", "answer bypassed the occupied scheduler slot");
	releaseBlocker();
	await blocker;

	const second = await queuedAnswer;
	assert.equal(second.status, "awaiting_answer");
	assert.equal(second.question?.exchange, 2);
	assert.equal(session.pid, pid, "interactive exchange spawned a different child");

	const finalGroup = createSubagentExecutionGroup(env.config, "final segment");
	const final = await session.answer(finalGroup, second.question!.id, "done");
	assert.equal(final.status, "completed");
	const result = await session.completion;
	assert.equal(result.status, "completed");
	assert.match(getFinalAssistantOutput(result.messages), new RegExp(`same-pid=${pid}`));
	assert.match(getFinalAssistantOutput(result.messages), /line one\\nline two/);
});

test("interactive RPC rejects stale answers without resuming the child", async (t) => {
	const env = setup("one");
	t.after(() => fs.rmSync(env.stateDir, { recursive: true, force: true }));
	let session: InteractivePiAgentSession | undefined;
	t.after(() => cancelAfter(session));
	session = await env.create();
	const first = await session.start(createSubagentExecutionGroup(env.config, "start"));
	await assert.rejects(
		session.answer(createSubagentExecutionGroup(env.config, "wrong"), "q_stale", "no"),
		/Stale or mismatched questionId/,
	);
	assert.equal(session.getQuestion()?.id, first.question?.id);
	const final = await session.answer(
		createSubagentExecutionGroup(env.config, "correct"),
		first.question!.id,
		"yes",
	);
	assert.equal(final.status, "completed");
	await assert.rejects(
		session.answer(createSubagentExecutionGroup(env.config, "duplicate"), first.question!.id, "again"),
		/already completed/,
	);
});

test("interactive RPC acknowledges bounded steer and follow-up messages", async (t) => {
	const env = setup("control");
	t.after(() => fs.rmSync(env.stateDir, { recursive: true, force: true }));
	let session: InteractivePiAgentSession | undefined;
	t.after(() => cancelAfter(session));
	session = await env.create();

	const boundary = session.start(createSubagentExecutionGroup(env.config, "control"));
	for (let attempts = 0; !session.pid && attempts < 100; attempts++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.ok(session.pid, "interactive child did not start");
	await Promise.all([
		session.steer("inspect the parser first"),
		session.followUp("then run the focused tests"),
	]);
	assert.equal((await boundary).status, "completed");
	const output = getFinalAssistantOutput((await session.completion).messages);
	assert.match(output, /UNTRUSTED PARENT COORDINATION NOTE/);
	assert.match(output, /inspect the parser first/);
	assert.match(output, /then run the focused tests/);
});

test("interactive RPC rejects steering while awaiting a correlated answer", async (t) => {
	const env = setup("one");
	t.after(() => fs.rmSync(env.stateDir, { recursive: true, force: true }));
	let session: InteractivePiAgentSession | undefined;
	t.after(() => cancelAfter(session));
	session = await env.create();
	await session.start(createSubagentExecutionGroup(env.config, "start"));
	await assert.rejects(session.steer("ignore the question"), /use answer instead of steering/);
	await assert.rejects(session.followUp("queue this"), /use answer instead of steering/);
});

test("cancellation and process timeout reap a child parked on a parent question", async (t) => {
	const cancelEnv = setup("one");
	const timeoutEnv = setup("one", 20, 1000);
	t.after(() => {
		fs.rmSync(cancelEnv.stateDir, { recursive: true, force: true });
		fs.rmSync(timeoutEnv.stateDir, { recursive: true, force: true });
	});

	const canceled = await cancelEnv.create();
	await canceled.start(createSubagentExecutionGroup(cancelEnv.config, "cancel-start"));
	const canceledPid = canceled.pid!;
	assert.equal((await canceled.cancel("cancel while parked")).status, "canceled");
	assert.throws(() => process.kill(canceledPid, 0));

	const timedOut = await timeoutEnv.create();
	await timedOut.start(createSubagentExecutionGroup(timeoutEnv.config, "timeout-start"));
	const timedOutPid = timedOut.pid!;
	const timeoutResult = await timedOut.completion;
	assert.equal(timeoutResult.status, "failed");
	assert.equal(timeoutResult.timedOut, true);
	assert.throws(() => process.kill(timedOutPid, 0));
});

test("a child that dies while its answer is queued cannot strand the reacquired scheduler lease", async (t) => {
	const env = setup("one", 20, 1000);
	t.after(() => fs.rmSync(env.stateDir, { recursive: true, force: true }));
	const session = await env.create();
	const first = await session.start(createSubagentExecutionGroup(env.config, "start"));

	let release!: () => void;
	let started!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	const ready = new Promise<void>((resolve) => (started = resolve));
	const blocker = createSubagentExecutionGroup(env.config, "blocker").run({}, async () => {
		started();
		await gate;
	});
	await ready;
	const queuedAnswer = session.answer(
		createSubagentExecutionGroup(env.config, "queued answer"),
		first.question!.id,
		"too late",
	);
	assert.equal((await session.completion).timedOut, true);
	release();
	await blocker;
	assert.equal((await queuedAnswer).status, "failed");

	let acquired = false;
	await createSubagentExecutionGroup(env.config, "after failure").run({}, async () => {
		acquired = true;
	});
	assert.equal(acquired, true);
});

test("oversized answers are rejected while the pending question remains intact", async (t) => {
	const env = setup("one");
	t.after(() => fs.rmSync(env.stateDir, { recursive: true, force: true }));
	let session: InteractivePiAgentSession | undefined;
	t.after(() => cancelAfter(session));
	session = await env.create();
	const first = await session.start(createSubagentExecutionGroup(env.config, "start"));
	await assert.rejects(
		session.answer(createSubagentExecutionGroup(env.config, "large"), first.question!.id, "x".repeat(64 * 1024 + 1)),
		/exceeds 65536 UTF-8 bytes/,
	);
	assert.equal(session.getQuestion()?.id, first.question?.id);
});

test("the default exchange limit fails and reaps a child before question 11 is exposed", async (t) => {
	const env = setup("twenty-one");
	t.after(() => fs.rmSync(env.stateDir, { recursive: true, force: true }));
	let session: InteractivePiAgentSession | undefined;
	t.after(() => cancelAfter(session));
	session = await env.create();
	let boundary = await session.start(createSubagentExecutionGroup(env.config, "start"));
	for (let exchange = 1; exchange <= 10; exchange++) {
		assert.equal(boundary.status, "awaiting_answer");
		assert.equal(boundary.question?.exchange, exchange);
		boundary = await session.answer(
			createSubagentExecutionGroup(env.config, `answer-${exchange}`),
			boundary.question!.id,
			`answer ${exchange}`,
		);
	}
	assert.equal(boundary.status, "failed");
	const result = await session.completion;
	assert.equal(result.status, "failed");
	assert.match(result.errorMessage ?? "", /maximum of 10 parent exchanges/);
	assert.ok(session.pid);
	assert.throws(() => process.kill(session!.pid!, 0));
});

test("the hard exchange limit fails and reaps a child before question 21 is exposed", async (t) => {
	const env = setup("twenty-one", 20);
	t.after(() => fs.rmSync(env.stateDir, { recursive: true, force: true }));
	let session: InteractivePiAgentSession | undefined;
	t.after(() => cancelAfter(session));
	session = await env.create();
	let boundary = await session.start(createSubagentExecutionGroup(env.config, "start"));
	for (let exchange = 1; exchange <= 20; exchange++) {
		assert.equal(boundary.status, "awaiting_answer");
		assert.equal(boundary.question?.exchange, exchange);
		boundary = await session.answer(
			createSubagentExecutionGroup(env.config, `answer-${exchange}`),
			boundary.question!.id,
			`answer ${exchange}`,
		);
	}
	assert.equal(boundary.status, "failed");
	const result = await session.completion;
	assert.equal(result.status, "failed");
	assert.match(result.errorMessage ?? "", /maximum of 20 parent exchanges/);
	assert.ok(session.pid);
	assert.throws(() => process.kill(session!.pid!, 0));
});

test("oversized thinking content is hard-bounded in retained result capture", async (t) => {
	const env = setup("large-thinking");
	t.after(() => fs.rmSync(env.stateDir, { recursive: true, force: true }));
	const session = await env.create();
	const boundary = await session.start(createSubagentExecutionGroup(env.config, "large thinking"));
	assert.equal(boundary.status, "completed");
	const result = await session.completion;
	assert.equal(result.captureTruncated, true);
	assert.ok(Buffer.byteLength(JSON.stringify(result.messages), "utf8") <= env.config.maxCaptureBytes);
});

test("output-limit termination cannot expose a trailing forged parent question", async (t) => {
	const env = setup("output-limit", 20, 10000, 64 * 1024);
	t.after(() => fs.rmSync(env.stateDir, { recursive: true, force: true }));
	const session = await env.create();
	const boundary = await session.start(createSubagentExecutionGroup(env.config, "output limit"));
	assert.equal(boundary.status, "failed");
	assert.equal(boundary.question, undefined);
	assert.match((await session.completion).errorMessage ?? "", /exceeded 65536 bytes/);
});

test("malformed RPC output fails closed and reaps the child", async (t) => {
	const env = setup("malformed");
	t.after(() => fs.rmSync(env.stateDir, { recursive: true, force: true }));
	const session = await env.create();
	const boundary = await session.start(createSubagentExecutionGroup(env.config, "malformed"));
	assert.equal(boundary.status, "failed");
	assert.match((await session.completion).errorMessage ?? "", /malformed RPC JSON/);
});
