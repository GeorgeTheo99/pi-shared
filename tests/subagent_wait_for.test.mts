import assert from "node:assert/strict";
import test from "node:test";

import type { JobSnapshot } from "../extensions/_shared/job-store.ts";
import { evaluateJobMode } from "../extensions/wait-for/index.ts";

function snapshots(values: Array<[string, JobSnapshot["status"]]>): Map<string, JobSnapshot> {
	return new Map(values.map(([id, status]) => [id, { id, status }]));
}

test("wait_for wakes for awaiting_answer regardless of terminal job mode", () => {
	const state = snapshots([
		["first", "running"],
		["second", "awaiting_answer"],
	]);
	for (const mode of ["all", "any", "any_success", "any_failure"] as const) {
		const result = evaluateJobMode(["first", "second"], state, mode);
		assert.equal(result.done, true, mode);
		assert.match(result.reason, /second.*awaiting_answer/);
	}
});

test("wait_for keeps existing terminal mode behavior without pending questions", () => {
	const running = snapshots([
		["first", "completed"],
		["second", "running"],
	]);
	assert.equal(evaluateJobMode(["first", "second"], running, "all").done, false);
	assert.equal(evaluateJobMode(["first", "second"], running, "any").done, true);
	assert.equal(evaluateJobMode(["first", "second"], running, "any_success").done, true);
	assert.equal(evaluateJobMode(["first", "second"], running, "any_failure").done, false);
});
