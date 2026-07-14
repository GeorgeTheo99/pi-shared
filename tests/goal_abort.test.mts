import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { latestAssistantMessage } from "../extensions/goal/agent-end.ts";

type GoalState = {
  status: string;
  turnsCompleted: number;
  progressLog: Array<{ note: string }>;
};

type CustomEntry = { type: "custom"; customType: string; data: unknown };

function makeHarness(hasUI = true, branch: CustomEntry[] = []) {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const commands = new Map<string, { handler: (...args: any[]) => unknown }>();
  const tools = new Map<string, { execute: (...args: any[]) => unknown }>();
  const sent: Array<{ message: any; options: any }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const statuses: Array<{ key: string; value: string | undefined }> = [];

  const pi = {
    events: { on: () => () => undefined },
    on(name: string, handler: (...args: any[]) => unknown) {
      handlers.set(name, handler);
    },
    registerCommand(name: string, command: { handler: (...args: any[]) => unknown }) {
      commands.set(name, command);
    },
    registerTool(tool: { name: string; execute: (...args: any[]) => unknown }) {
      tools.set(tool.name, tool);
    },
    appendEntry(customType: string, data: unknown) {
      branch.push({ type: "custom", customType, data });
    },
    sendMessage(message: any, options?: any) {
      sent.push({ message, options });
    },
  };

  const ctx = {
    hasUI,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      setStatus(key: string, value: string | undefined) {
        statuses.push({ key, value });
      },
    },
    sessionManager: {
      getBranch: () => branch,
      getEntries: () => branch,
      getSessionId: () => "goal-abort-test-session",
      getSessionFile: () => undefined,
    },
  };

  return { branch, commands, ctx, handlers, notifications, pi, sent, statuses, tools };
}

function latestGoalState(branch: Array<{ customType: string; data: unknown }>): GoalState {
  const entry = branch.findLast((item) => item.customType === "pi-goal-state");
  assert.ok(entry, "expected a persisted goal state");
  return entry.data as GoalState;
}

async function loadGoalExtension(label: string) {
  return (await import(`../extensions/goal/index.ts?goal-abort-test=${label}`)).default;
}

async function startGoal(harness: ReturnType<typeof makeHarness>) {
  const tool = harness.tools.get("start_goal");
  assert.ok(tool, "start_goal should be registered");
  await tool.execute(
    "start",
    { objective: "Verify abort behavior", maxTurns: 5 },
    new AbortController().signal,
    () => undefined,
    harness.ctx,
  );
  harness.sent.length = 0;
  harness.notifications.length = 0;
}

test("latestAssistantMessage returns the newest assistant turn", () => {
  const latest = latestAssistantMessage([
    { role: "assistant", stopReason: "aborted", content: [] },
    { role: "toolResult", content: [] },
    { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
  ]);

  assert.equal(latest?.stopReason, "stop");
  assert.equal(latest?.content?.[0]?.text, "done");
});

test("latestAssistantMessage handles missing and malformed message lists", () => {
  assert.equal(latestAssistantMessage(undefined), undefined);
  assert.equal(latestAssistantMessage({ role: "assistant", stopReason: "aborted" }), undefined);
  assert.equal(latestAssistantMessage([{ role: "user" }]), undefined);
});

test("an aborted active-goal turn pauses without consuming budget or queuing continuation", async () => {
  const harness = makeHarness();
  (await loadGoalExtension("aborted"))(harness.pi as any);
  await startGoal(harness);

  const agentEnd = harness.handlers.get("agent_end");
  assert.ok(agentEnd, "agent_end should be registered");
  await agentEnd(
    { messages: [{ role: "user" }, { role: "assistant", stopReason: "aborted", content: [] }] },
    harness.ctx,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));

  const state = latestGoalState(harness.branch);
  assert.equal(state.status, "paused");
  assert.equal(state.turnsCompleted, 0);
  assert.equal(state.progressLog.at(-1)?.note, "Paused because the user interrupted the active turn.");
  assert.deepEqual(harness.sent, []);
  assert.deepEqual(harness.notifications, [
    { message: "Goal paused after interrupt. Run /goal resume to continue.", level: "info" },
  ]);
});

test("an aborted turn still persists the pause without a UI", async () => {
  const harness = makeHarness(false);
  (await loadGoalExtension("no-ui"))(harness.pi as any);
  await startGoal(harness);

  const agentEnd = harness.handlers.get("agent_end");
  assert.ok(agentEnd);
  await agentEnd(
    { messages: [{ role: "assistant", stopReason: "aborted", content: [] }] },
    harness.ctx,
  );

  assert.equal(latestGoalState(harness.branch).status, "paused");
  assert.deepEqual(harness.notifications, []);
  assert.deepEqual(harness.sent, []);
});

test("the paused goal remains paused after extension reload", async () => {
  const original = makeHarness();
  (await loadGoalExtension("before-reload"))(original.pi as any);
  await startGoal(original);

  const agentEnd = original.handlers.get("agent_end");
  assert.ok(agentEnd);
  await agentEnd(
    { messages: [{ role: "assistant", stopReason: "aborted", content: [] }] },
    original.ctx,
  );

  const reloaded = makeHarness(true, original.branch);
  (await loadGoalExtension("after-reload"))(reloaded.pi as any);
  const sessionStart = reloaded.handlers.get("session_start");
  assert.ok(sessionStart);
  await sessionStart({}, reloaded.ctx);

  assert.deepEqual(reloaded.statuses.at(-1), { key: "goal", value: "goal paused" });
  assert.equal(latestGoalState(reloaded.branch).status, "paused");
});

test("a normal productive turn still consumes budget and queues continuation", async () => {
  const harness = makeHarness();
  (await loadGoalExtension("normal"))(harness.pi as any);
  await startGoal(harness);

  const agentEnd = harness.handlers.get("agent_end");
  assert.ok(agentEnd);
  await agentEnd(
    {
      messages: [
        {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "toolCall", name: "read" }, { type: "text", text: "Progress made." }],
        },
      ],
    },
    harness.ctx,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));

  const state = latestGoalState(harness.branch);
  assert.equal(state.status, "active");
  assert.equal(state.turnsCompleted, 1);
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0]?.message.customType, "goal-autopilot");
  assert.deepEqual(harness.sent[0]?.options, { deliverAs: "followUp", triggerTurn: true });
});

test("self-handoff orientation remains gated before abort handling and budget accounting", async () => {
  const source = await readFile(new URL("../extensions/goal/index.ts", import.meta.url), "utf8");
  const agentEnd = source.indexOf('pi.on("agent_end"');
  const orientationGuard = source.indexOf('if (orientation.status !== "none") return;', agentEnd);
  const abortGuard = source.indexOf('if (lastAssistant?.stopReason === "aborted")', agentEnd);
  const turnIncrement = source.indexOf("goal.turnsCompleted += 1", agentEnd);

  assert.ok(agentEnd >= 0);
  assert.ok(orientationGuard > agentEnd);
  assert.ok(abortGuard > orientationGuard);
  assert.ok(turnIncrement > abortGuard);
});
