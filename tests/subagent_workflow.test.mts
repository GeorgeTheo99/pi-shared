import assert from "node:assert/strict";
import test from "node:test";

import { PromiseTracker } from "../extensions/workflow/promise-tracker.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a rejected fire-and-forget promise remains visible after it settles", async () => {
	const tracker = new PromiseTracker<string>();
	tracker.track(Promise.reject(new Error("agent failed")));
	await delay(10);
	const result = await tracker.drain();
	assert.equal(result.failed, true);
	assert.match(String(result.error), /agent failed/);
});

test("drain waits for every tracked promise", async () => {
	const tracker = new PromiseTracker<number>();
	let completed = 0;
	for (const wait of [30, 10, 20]) {
		tracker.track(
			delay(wait).then(() => {
				completed += 1;
				return completed;
			}),
		);
	}
	const result = await tracker.drain();
	assert.equal(result.failed, false);
	assert.equal(completed, 3);
});
