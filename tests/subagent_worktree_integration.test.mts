import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

test("spawn_subagent worktree wiring uses the existing runner and preserves failure evidence", () => {
	const result = spawnSync(process.execPath, [
		"--no-warnings", "--experimental-loader", path.join(import.meta.dirname, "fixtures/subagent_worktree_loader.mjs"),
		path.join(import.meta.dirname, "fixtures/subagent_worktree_integration.mjs"),
	], { encoding: "utf8", timeout: 30_000, env: { ...process.env, NODE_OPTIONS: "" } });
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	assert.match(result.stdout, /worktree spawn integration passed/);
});
