import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import extension from "../../extensions/spawn-subagent/index.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-integration-")));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
process.env.PI_SUBAGENT_STATE_DIR = path.join(root, "state");
process.env.PI_SUBAGENT_DEPTH = "0";
let tool;
const events = new Map();
const context = { cwd: root, hasUI: false, isProjectTrusted: () => true, model: undefined };
try {
	git(root, "init");
	git(root, "config", "user.name", "Fixture");
	git(root, "config", "user.email", "fixture@example.invalid");
	git(root, "config", "commit.gpgsign", "false");
	fs.writeFileSync(path.join(root, "file.txt"), "base\n");
	git(root, "add", "file.txt");
	git(root, "commit", "-m", "base");
	extension({ registerTool: (definition) => { tool = definition; }, registerCommand() {}, on: (event, callback) => events.set(event, callback) });
	let invocations = 0;
	let outcome = "completed";
	globalThis.worktreeRunner = async (options) => {
		invocations++;
		const cwd = options.cwd ?? options.defaultCwd;
		if (options.task.includes("Workspace metadata")) {
			assert.notEqual(cwd, root);
			assert.match(options.task, /NOT a security sandbox/);
			assert.match(options.task, /no dirty or ignored files were copied/);
			assert.ok(options.task.includes(cwd));
			assert.equal(fs.readFileSync(path.join(cwd, "file.txt"), "utf8"), "base\n");
			fs.writeFileSync(path.join(cwd, "file.txt"), "worker change\n");
			if (outcome === "completed") git(cwd, "commit", "-am", "worker commit");
		}
		if (outcome === "throw") throw new Error("PRIVATE_RUNNER_ERROR");
		return {
			agent: "worker", agentSource: "shared", task: options.task,
			exitCode: outcome === "completed" ? 0 : 1, status: outcome,
			messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
			stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
			updatedAt: new Date().toISOString(),
		};
	};
	const invokeRaw = (params, signal) => tool.execute("fixture", params, signal, undefined, context);
	const invoke = async (params, signal) => {
		try { return await invokeRaw(params, signal); }
		catch (error) { return { isError: true, content: [{ type: "text", text: error.message }], details: error.details }; }
	};
	const standard = { agent: "worker", task: "edit" };
	const nonisolated = await invoke(standard);
	assert.equal(nonisolated.details.results[0].worktree, undefined);
	assert.equal(nonisolated.content[0].text, "done");
	assert.equal(invocations, 1);
	for (const invalid of [
		{ ...standard, isolation: "worktree", interactive: true },
		{ ...standard, isolation: "worktree", background: true },
		{ tasks: [standard], isolation: "worktree" },
		{ chain: [standard], isolation: "worktree" },
		{ tasks: [{ ...standard, isolation: "worktree" }] },
		{ ...standard, baseRevision: "HEAD" },
	]) await assert.rejects(invokeRaw(invalid));
	assert.equal(invocations, 1);
	fs.writeFileSync(path.join(root, "file.txt"), "parent dirty\n");
	assert.equal((await invoke({ ...standard, isolation: "worktree" })).isError, true);
	assert.equal(invocations, 1);
	for (outcome of ["completed", "failed", "canceled", "throw"]) {
		const result = await invoke({ ...standard, isolation: "worktree", baseRevision: "HEAD" });
		assert.equal(Boolean(result.isError), outcome !== "completed");
		const report = result.details.results[0].worktree;
		assert.ok(report);
		assert.equal(report.retained, true);
		assert.equal(report.inventory.status, "complete");
		assert.ok(fs.existsSync(report.path));
		assert.deepEqual(report.inventory.tracked, ["file.txt"]);
		assert.equal(fs.readFileSync(path.join(root, "file.txt"), "utf8"), "parent dirty\n");
		assert.ok(result.content[0].text.includes(report.path));
		assert.doesNotMatch(result.content[0].text, /PRIVATE_RUNNER_ERROR/);
		if (outcome === "completed") {
			assert.notEqual(report.base, report.head);
			assert.equal(git(report.path, "status", "--porcelain"), "");
		}
	}
	const canceled = await invoke({ ...standard, isolation: "worktree", baseRevision: "HEAD" }, AbortSignal.abort());
	assert.equal(canceled.isError, true);
	assert.equal(invocations, 5);
	console.log("worktree spawn integration passed: default, rejected modes, dirty base, commits, failures, cancellation, runner throw");
} finally {
	await events.get("session_shutdown")?.({}, context);
	fs.rmSync(root, { recursive: true, force: true });
}
