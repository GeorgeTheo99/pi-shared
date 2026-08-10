import assert from "node:assert/strict";
import test from "node:test";

import askUser from "../extensions/ask-user/index.ts";

function registerAskUser() {
  let tool: any;
  askUser({
    registerTool(candidate: any) {
      tool = candidate;
    },
  } as any);
  assert.ok(tool, "ask_user should be registered");
  return tool;
}

test("ask_user forces sibling tool calls to execute sequentially", () => {
  const tool = registerAskUser();
  assert.equal(tool.executionMode, "sequential");
});

test("ask_user forwards cancellation and timeout to its selector", async () => {
  const tool = registerAskUser();
  const controller = new AbortController();
  let dialogOptions: any;

  const result = await tool.execute(
    "ask-user-test",
    {
      question: "How should the job be stored?",
      options: ["Memory", "JSON"],
      timeout_ms: 5_000,
    },
    controller.signal,
    () => undefined,
    {
      hasUI: true,
      abort() {
        controller.abort();
      },
      ui: {
        async select(_question: string, _options: string[], options: any) {
          dialogOptions = options;
          return "JSON";
        },
      },
    },
  );

  assert.equal(dialogOptions.signal, controller.signal);
  assert.equal(dialogOptions.timeout, 5_000);
  assert.equal(result.content[0].text, "User selected: 2. JSON");
});
