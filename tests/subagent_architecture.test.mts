import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

test("all Pi subagent processes go through the shared managed runner", () => {
	const spawnExtension = read("extensions/spawn-subagent/index.ts");
	const workflowExtension = read("extensions/workflow/index.ts");
	const runner = read("extensions/_shared/pi-agent-runner.ts");
	const managed = read("extensions/_shared/managed-process.ts");

	for (const source of [spawnExtension, workflowExtension, runner]) {
		assert.doesNotMatch(source, /node:child_process/);
		assert.doesNotMatch(source, /\bspawn\s*\(/);
	}
	assert.match(managed, /from "node:child_process"/);
	assert.equal((managed.match(/\bspawn\s*\(/g) ?? []).length, 1);
	assert.match(spawnExtension, /runPiAgent/);
	assert.match(workflowExtension, /runPiAgent/);
});

test("both orchestration tools share configured limits and scheduler", () => {
	const spawnExtension = read("extensions/spawn-subagent/index.ts");
	const workflowExtension = read("extensions/workflow/index.ts");
	for (const source of [spawnExtension, workflowExtension]) {
		assert.match(source, /loadSubagentConfig/);
		assert.match(source, /createSubagentExecutionGroup/);
		assert.doesNotMatch(source, /const MAX_CONCURRENCY/);
		assert.doesNotMatch(source, /mapWithConcurrencyLimit/);
	}
});

test("nested delegation is blocked in child CLI arguments as defense in depth", () => {
	const runner = read("extensions/_shared/pi-agent-runner.ts");
	assert.match(runner, /PI_SUBAGENT_DEPTH/);
	assert.match(runner, /--exclude-tools/);
	assert.match(runner, /spawn_subagent,workflow/);
});

test("workflow tracks even fire-and-forget agent promises before returning", () => {
	const workflow = read("extensions/workflow/index.ts");
	assert.match(workflow, /new PromiseTracker<string>\(\)/);
	assert.match(workflow, /runtime\.sealAgents\(\)/);
	assert.match(workflow, /await runtime\.drainAgents\(\)/);
});

test("extensions clean up child work on session shutdown", () => {
	assert.match(read("extensions/spawn-subagent/index.ts"), /pi\.on\("session_shutdown"/);
	assert.match(read("extensions/workflow/index.ts"), /pi\.on\("session_shutdown"/);
});

test("supervisor accepts only the exact ACCEPT control verdict", () => {
	const supervisor = read("workflows/supervisor.js");
	assert.match(supervisor, /\/\^accept\$\/i/);
	assert.match(supervisor, /test\(normalized\)/);
	assert.doesNotMatch(supervisor, /\/\^accept\\b/);
});
