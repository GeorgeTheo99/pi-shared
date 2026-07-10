import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCount, normalizeToolText } from "./text.ts";

test("bounds an unbroken line and marks truncation", () => {
	const output = normalizeToolText("a".repeat(20_000));
	const [firstLine] = output.split("\n");
	assert.equal(firstLine.length, 8_000);
	assert.match(output, /Output truncated locally/);
});

test("normalizes carriage returns and removes terminal controls", () => {
	const output = normalizeToolText("one\r\ntwo\rthree\u0000\u001b[31mred\u0007");
	assert.equal(output, "one\ntwo\nthree[31mred");
});

test("applies the requested total character bound including its marker", () => {
	const output = normalizeToolText("x".repeat(1_000), 100);
	assert.equal(output.length, 100);
	assert.match(output, /Output truncated locally/);
});

test("uses a bounded fallback for invalid numeric limits", () => {
	assert.equal(normalizeToolText("safe", Number.NaN), "safe");
	assert.equal(normalizeCount(Number.NaN, 8), 8);
	assert.equal(normalizeCount(Number.POSITIVE_INFINITY, 8), 8);
	assert.equal(normalizeCount(-1, 8), 0);
	assert.equal(normalizeCount(3.9, 8), 3);
});

test("leaves normal search text unchanged", () => {
	const input = "1. Result\nhttps://example.com\nA concise snippet.";
	assert.equal(normalizeToolText(input), input);
});
