import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { bashToolDefinitions, settingsManagerCreates } from "@earendil-works/pi-coding-agent";
import { startManagedProcess } from "../extensions/_shared/managed-process.ts";
import { createInteractivePiAgent, getFinalAssistantOutput, runPiAgent } from "../extensions/_shared/pi-agent-runner.ts";
import {
	MAX_PROCESS_GROUP_LEDGER_BYTES,
	PROCESS_GROUP_LEDGER_ENV,
	ProcessGroupLedger,
	processGroupRegistrationPrefix,
} from "../extensions/_shared/process-group-ledger.ts";
import { loadSubagentConfig } from "../extensions/_shared/subagent-config.ts";
import { createSubagentExecutionGroup } from "../extensions/_shared/subagent-scheduler.ts";
import childBashExtension from "../extensions/spawn-subagent/child-bash.ts";

const posixOnly = { skip: process.platform === "win32" };
const repoRoot = path.resolve(import.meta.dirname, "..");
const settledChild = path.join(import.meta.dirname, "fixtures", "subagent_settled_child.mjs");
const rpcChild = path.join(import.meta.dirname, "fixtures", "subagent_interactive_rpc_child.mjs");

function groupAlive(group: number): boolean {
	try {
		process.kill(-group, 0);
		return true;
	} catch (error: any) {
		return error?.code !== "ESRCH";
	}
}

async function waitUntilGroupGone(group: number, timeoutMs = 2000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!groupAlive(group)) return true;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return false;
}

function killGroup(group: number | undefined): void {
	if (!group) return;
	try {
		process.kill(-group, "SIGKILL");
	} catch {
		// Already gone.
	}
}

/** A detached, TERM-ignoring process: its own session and process group, like a Pi Bash command. */
function startBackgroundGroup(): number {
	const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
	return child.pid!;
}

function setup(t: test.TestContext) {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-cleanup-test-"));
	t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
	const config = loadSubagentConfig({
		PI_SUBAGENT_STATE_DIR: stateDir,
		PI_SUBAGENT_MAX_CONCURRENCY: "2",
		PI_SUBAGENT_RUN_TIMEOUT_MS: "10000",
		PI_SUBAGENT_TERM_GRACE_MS: "100",
		PI_SUBAGENT_HEARTBEAT_MS: "1000",
		PI_SUBAGENT_LEASE_MS: "10000",
	});
	assert.deepEqual(config.errors, []);
	const agents = [
		{ name: "fixture", description: "fixture", tools: ["bash"], systemPrompt: "Fixture agent.", source: "shared" as const, filePath: settledChild },
	];
	return { config, agents };
}

async function runSettledChild(t: test.TestContext, mode: string) {
	const { config, agents } = setup(t);
	const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-bg-")), "pid");
	t.after(() => {
		const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8")) : undefined;
		killGroup(pid);
		fs.rmSync(path.dirname(pidFile), { recursive: true, force: true });
	});
	const startedAt = Date.now();
	const result = await runPiAgent({
		config,
		group: createSubagentExecutionGroup(config, `cleanup-${mode}`),
		defaultCwd: repoRoot,
		agents,
		agentName: "fixture",
		task: "leave a background job",
		invocation: { command: process.execPath, args: [settledChild, mode, pidFile] },
	});
	const background = Number(fs.readFileSync(pidFile, "utf8"));
	(t as any).pidFile = pidFile;
	return { result, background, elapsedMs: Date.now() - startedAt };
}

test("ledger records a shell's own process group and refuses to run once sealed", posixOnly, (t) => {
	const ledger = ProcessGroupLedger.create()!;
	t.after(() => ledger.dispose());
	const prefix = processGroupRegistrationPrefix(ledger.filePath);
	const run = () => spawnSync("sh", ["-c", `${prefix}\necho ran`], { encoding: "utf8" });

	const first = run();
	assert.equal(first.status, 0);
	assert.equal(first.stdout, "ran\n");
	const recorded = fs.readFileSync(ledger.filePath, "utf8").trim().split("\n");
	assert.equal(recorded.length, 1);
	assert.match(recorded[0], /^[1-9]\d*$/);

	ledger.seal();
	const sealed = run();
	assert.equal(sealed.status, 125);
	assert.equal(sealed.stdout, "", "a command that cannot register must not run");
	assert.match(sealed.stderr, /could not register this command/);
});

test("ledger quotes paths that contain shell metacharacters", posixOnly, (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi ledger 'quote' $x-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = path.join(dir, "groups");
	const result = spawnSync("sh", ["-c", `${processGroupRegistrationPrefix(file)}\necho ok`], { encoding: "utf8" });
	assert.equal(result.stdout, "ok\n");
	assert.match(fs.readFileSync(file, "utf8"), /^[1-9]\d*\n$/);
});

test("ledger reports live groups and permanently retires dead ones", posixOnly, async (t) => {
	const ledger = ProcessGroupLedger.create()!;
	t.after(() => ledger.dispose());
	const live = startBackgroundGroup();
	t.after(() => killGroup(live));
	const dead = startBackgroundGroup();
	killGroup(dead);
	assert.equal(await waitUntilGroupGone(dead), true);
	fs.appendFileSync(ledger.filePath, `${live}\n${dead}\n${live}\n`);

	assert.deepEqual(ledger.read(), { groups: [live], error: undefined });
	killGroup(live);
	assert.equal(await waitUntilGroupGone(live), true);
	assert.deepEqual(ledger.read().groups, []);
	// Retired numbers stay retired even if the kernel reuses them later.
	assert.deepEqual(ledger.read(), { groups: [], error: undefined });
});

test("ledger evidence that is malformed, excluded, oversized, or missing is never a clean result", posixOnly, (t) => {
	const ledger = ProcessGroupLedger.create()!;
	t.after(() => ledger.dispose());
	fs.appendFileSync(ledger.filePath, "abc\n");
	assert.match(ledger.read().error ?? "", /invalid entry/);

	fs.writeFileSync(ledger.filePath, `${process.pid}\n`);
	assert.match(ledger.read().error ?? "", /invalid entry/, "the parent's own group must never be targeted");

	fs.writeFileSync(ledger.filePath, "1\n".repeat(MAX_PROCESS_GROUP_LEDGER_BYTES));
	assert.match(ledger.read().error ?? "", /exceeded/);

	fs.rmSync(ledger.filePath);
	assert.match(ledger.read().error ?? "", /unreadable/);
});

test("disposing a sealed ledger removes its private directory", posixOnly, () => {
	const ledger = ProcessGroupLedger.create()!;
	const dir = path.dirname(ledger.filePath);
	assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
	ledger.seal();
	ledger.dispose();
	assert.equal(fs.existsSync(dir), false);
});

test("natural exit reaps owned groups that outlive the leader", posixOnly, async (t) => {
	const ledger = ProcessGroupLedger.create()!;
	t.after(() => ledger.dispose());
	const background = startBackgroundGroup();
	t.after(() => killGroup(background));
	fs.appendFileSync(ledger.filePath, `${background}\n`);
	let sealed = false;
	const result = await startManagedProcess({
		command: process.execPath,
		args: ["-e", "process.exit(0)"],
		cwd: repoRoot,
		env: process.env,
		runTimeoutMs: 5000,
		termGraceMs: 100,
		maxStderrBytes: 1024,
		maxEventBytes: 1024,
		cleanupOnExit: true,
		ownedProcessGroups: () => ledger.read(),
		onTeardown: () => {
			sealed = true;
			ledger.seal();
		},
	}).completion;
	assert.equal(result.exitCode, 0);
	assert.equal(result.cleanup, "confirmed");
	assert.equal(sealed, true);
	assert.equal(groupAlive(background), false, "TERM-ignoring background group must be escalated to SIGKILL");
});

test("abort reaps owned groups and unverifiable ledgers stay unconfirmed", posixOnly, async (t) => {
	const background = startBackgroundGroup();
	t.after(() => killGroup(background));
	const controller = new AbortController();
	const handle = startManagedProcess({
		command: process.execPath,
		args: ["-e", "setInterval(()=>{},1000)"],
		cwd: repoRoot,
		env: process.env,
		signal: controller.signal,
		runTimeoutMs: 5000,
		termGraceMs: 100,
		maxStderrBytes: 1024,
		maxEventBytes: 1024,
		ownedProcessGroups: () => ({ groups: groupAlive(background) ? [background] : [], error: "fixture ledger error" }),
		onSpawn: () => setTimeout(() => controller.abort(), 25),
	});
	const result = await handle.completion;
	assert.equal(result.terminationReason, "aborted");
	assert.equal(groupAlive(background), false);
	assert.equal(result.cleanup, "unconfirmed");
	assert.match(result.cleanupDetail ?? "", /fixture ledger error/);
});

test("complete() stops a settled process without recording a failure", posixOnly, async () => {
	const handle = startManagedProcess({
		command: process.execPath,
		args: ["-e", "console.log('ready'); setInterval(()=>{},1000)"],
		cwd: repoRoot,
		env: process.env,
		runTimeoutMs: 5000,
		termGraceMs: 100,
		maxStderrBytes: 1024,
		maxEventBytes: 1024,
		onStdoutLine: () => handle.complete(),
	});
	const result = await handle.completion;
	assert.equal(result.semanticCompletion, true);
	assert.equal(result.terminationReason, undefined);
	assert.equal(result.cleanup, "confirmed");
});

test("one-shot natural exit reaps a registered background job and succeeds", posixOnly, async (t) => {
	const { result, background } = await runSettledChild(t, "exit");
	assert.equal(result.status, "completed", result.errorMessage);
	assert.equal(result.exitCode, 0);
	assert.equal(result.cleanup, "confirmed");
	assert.equal(getFinalAssistantOutput(result.messages), "answer:exit");
	assert.equal(groupAlive(background), false);
});

test("one-shot child that hangs after agent_settled is stopped and still succeeds", posixOnly, async (t) => {
	const { result, background, elapsedMs } = await runSettledChild(t, "hang");
	assert.equal(result.status, "completed", result.errorMessage);
	assert.equal(result.exitCode, 0);
	assert.equal(result.timedOut, undefined);
	assert.ok(elapsedMs < 5000, `settled child took ${elapsedMs}ms to stop`);
	assert.equal(groupAlive(background), false);
});

test("a settled child gets time to finish its own shutdown before being stopped", posixOnly, async (t) => {
	const { result, background } = await runSettledChild(t, "slow-dispose");
	assert.equal(result.status, "completed", result.errorMessage);
	assert.equal(result.exitCode, 0);
	const pidFile = (t as any).pidFile as string;
	assert.equal(fs.existsSync(`${pidFile}.disposed`), true, "child was stopped during its shutdown hooks");
	assert.equal(groupAlive(background), false);
});

test("a later successful assistant turn clears a retried provider error", posixOnly, async (t) => {
	const { result } = await runSettledChild(t, "retry");
	assert.equal(result.status, "completed");
	assert.equal(result.errorMessage, undefined);
	assert.equal(result.stopReason, "stop");
});

test("unverifiable cleanup fails the run but retains the final output", posixOnly, async (t) => {
	const { result, background } = await runSettledChild(t, "garbage");
	assert.equal(result.status, "failed");
	assert.equal(result.cleanup, "unconfirmed");
	assert.match(result.errorMessage ?? "", /process cleanup unconfirmed: .*invalid entry/);
	assert.match(result.errorMessage ?? "", /Final output \(retained\):\nanswer:garbage/);
	assert.equal(groupAlive(background), false, "valid entries are still reaped");
});

test("interactive child that hangs after agent_settled is stopped and still succeeds", posixOnly, async (t) => {
	const { config } = setup(t);
	const session = await createInteractivePiAgent({
		config,
		defaultCwd: repoRoot,
		agents: [{ name: "fixture", description: "fixture", tools: ["read"], systemPrompt: "Fixture agent.", source: "shared", filePath: rpcChild }],
		agentName: "fixture",
		task: "exercise RPC",
		invocation: { command: process.execPath, args: [rpcChild, "hang-after-settle"] },
	});
	t.after(() => session.cancel("test cleanup").catch(() => undefined));
	const first = await session.start(createSubagentExecutionGroup(config, "interactive start"));
	assert.equal(first.status, "awaiting_answer");
	const finished = await session.answer(createSubagentExecutionGroup(config, "interactive answer"), first.question!.id, "yes");
	assert.equal(finished.status, "completed", finished.result.errorMessage);
	const result = await session.completion;
	assert.equal(result.exitCode, 0);
	assert.equal(result.cleanup, "confirmed");
	assert.equal(groupAlive(session.pid!), false);
});

test("child Bash override registers each command and mirrors Pi shell settings", (t) => {
	const ledgerPath = path.join(os.tmpdir(), "pi-child-bash-ledger");
	process.env[PROCESS_GROUP_LEDGER_ENV] = ledgerPath;
	t.after(() => delete process.env[PROCESS_GROUP_LEDGER_ENV]);
	const tools: any[] = [];
	childBashExtension({ registerTool: (tool: any) => tools.push(tool) } as any);
	assert.equal(tools.length, 1);
	assert.equal(tools[0].name, "bash");
	assert.equal(process.env[PROCESS_GROUP_LEDGER_ENV], undefined, "commands must not inherit the ledger variable");

	const before = bashToolDefinitions.length;
	const ctx = { cwd: "/work/project", isProjectTrusted: () => true };
	return tools[0].execute("call-1", { command: "echo hi" }, undefined, undefined, ctx).then(() => {
		const created = bashToolDefinitions[before];
		assert.equal(created.cwd, "/work/project");
		assert.equal(created.options.shellPath, "/bin/stub-shell");
		assert.equal(created.options.commandPrefix, "stub-prefix");
		assert.deepEqual(settingsManagerCreates.at(-1), {
			cwd: "/work/project",
			agentDir: "/tmp/pi-stub-agent",
			options: { projectTrusted: true },
		});
		assert.equal(created.executions.length, 1);
		const spawned = created.options.spawnHook({ command: "stub-prefix\necho hi", cwd: "/work/project", env: {} });
		assert.equal(spawned.command, `${processGroupRegistrationPrefix(ledgerPath)}\nstub-prefix\necho hi`);
	});
});

test("child Bash override is inert without a parent ledger", () => {
	delete process.env[PROCESS_GROUP_LEDGER_ENV];
	const tools: any[] = [];
	childBashExtension({ registerTool: (tool: any) => tools.push(tool) } as any);
	assert.deepEqual(tools, []);
});
