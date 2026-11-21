import assert from "node:assert/strict";
import test from "node:test";

import {
  contextUnderPressure,
  IMAGE_CONTEXT_CHARS,
  messageContextChars,
  selectEditsToApply,
} from "../extensions/tool-summary/cache-batching.ts";

test("message size counts text, thinking, tool calls, and images at a fixed weight", () => {
  assert.equal(messageContextChars({ role: "user", content: "hello" }), 5);
  assert.equal(
    messageContextChars({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "abc" },
        { type: "text", text: "de" },
        { type: "toolCall", name: "read", arguments: { path: "/x" } },
      ],
    }),
    3 + 2 + 4 + JSON.stringify({ path: "/x" }).length,
  );
  assert.equal(
    messageContextChars({ role: "toolResult", content: [{ type: "image", data: "x".repeat(500_000), mimeType: "image/png" }] }),
    IMAGE_CONTEXT_CHARS,
  );
  assert.equal(messageContextChars({ role: "bashExecution", command: "ls", output: "abcd" }), 4);
  assert.equal(messageContextChars({ role: "compactionSummary", summary: "abcdef" }), 6);
  assert.equal(messageContextChars(undefined), 0);
});

test("edits near the tail apply; edits deep in a large suffix wait", () => {
  const chars = [20_000, 60_000, 20_000];
  const selected = selectEditsToApply(
    [
      { key: "deep", messageIndex: 0, savedChars: 16_000 },
      { key: "tail", messageIndex: 2, savedChars: 16_000 },
    ],
    chars,
    false,
  );
  assert.deepEqual([...selected], ["tail"]);
});

test("pending edits batch into one flush once their combined savings justify the suffix", () => {
  const chars = [20_000, 5_000, 20_000];
  const pending = [
    { key: "a", messageIndex: 0, savedChars: 16_000 },
    { key: "b", messageIndex: 2, savedChars: 16_000 },
  ];
  assert.deepEqual([...selectEditsToApply(pending, chars, false)].sort(), ["a", "b"]);
  assert.deepEqual([...selectEditsToApply([pending[0]!], chars, false)], [], "alone, a cannot justify 45K");
});

test("cold cache or context pressure applies every pending edit", () => {
  const pending = [{ key: "deep", messageIndex: 0, savedChars: 1_000 }];
  assert.deepEqual([...selectEditsToApply(pending, [20_000, 80_000], true)], ["deep"]);
  assert.equal(contextUnderPressure([100_000, 100_000], 100_000), true);
  assert.equal(contextUnderPressure([100_000], 100_000), false);
  assert.equal(contextUnderPressure([100_000], undefined), false);
  assert.deepEqual([...selectEditsToApply([], [1], true)], []);
});
