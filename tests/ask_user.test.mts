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

test("ask_user is declared to the model but not callable from codemode", () => {
  assert.equal(registerAskUser().exposure, "model-only");
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

function runAskUser(params: Record<string, unknown>, ui: Record<string, unknown>) {
  return registerAskUser().execute("ask-user-test", params, new AbortController().signal, () => undefined, {
    hasUI: true,
    abort() {},
    ui,
  });
}

test("ask_user shows the details the user has to act on in the selector", async () => {
  let shown = "";
  const result = await runAskUser(
    {
      question: "Did the sshd check pass?",
      details: "Run in Terminal:\nsudo sshd -t && echo OK\nExpected: OK",
      options: ["Yes", "No"],
    },
    {
      async select(title: string) {
        shown = title;
        return "Yes";
      },
    },
  );

  assert.equal(shown, "Did the sshd check pass?\n\nRun in Terminal:\nsudo sshd -t && echo OK\nExpected: OK");
  assert.equal(result.details.details, "Run in Terminal:\nsudo sshd -t && echo OK\nExpected: OK");
});

test("ask_user keeps the question and details on screen while a custom answer is typed", async () => {
  const titles: string[] = [];
  const ui = {
    async select(_title: string, options: string[]) {
      return options.at(-1);
    },
    async input(title: string) {
      titles.push(title);
      return "permission denied";
    },
  };

  await runAskUser({ question: "Result?", details: "sudo sshd -t", custom_prompt: "Paste the output" }, ui);
  await runAskUser(
    { question: "Result?", details: "sudo sshd -t", options: ["OK"], allow_custom: true, custom_prompt: "Paste the output" },
    ui,
  );

  assert.deepEqual(titles, Array(2).fill("Result?\n\nsudo sshd -t\n\nPaste the output"));
});

test("ask_user leaves the details in the transcript after the dialog closes", () => {
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const rendered = registerAskUser().renderCall(
    { question: "Did the sshd check pass?", details: "sudo sshd -t\nExpected: no output", options: ["Yes", "No"] },
    theme,
  );

  assert.equal(
    rendered.text,
    "ask_user Did the sshd check pass?\n  sudo sshd -t\n  Expected: no output\n  Options: 1. Yes, 2. No",
  );
});
