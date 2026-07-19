import assert from "node:assert/strict";
import test from "node:test";

import {
  __resetCompleteStub,
  __setCompleteImplementation,
  completeCalls,
} from "./fixtures/tool_summary_ai_stub.mjs";

const CONFIG_TYPE = "pi-tool-summary-config";
const EXPOSURE_TYPE = "pi-tool-summary-exposure";
const COMPLETE_TYPE = "pi-tool-summary-complete";
const RETRY_TYPE = "pi-tool-summary-retry";
const SKIP_TYPE = "pi-tool-summary-skip";

function toolEntry(toolCallId: string, toolName: string, text: string, isError = false) {
  return {
    type: "message",
    id: `entry-${toolCallId}`,
    parentId: null,
    message: {
      role: "toolResult",
      toolCallId,
      toolName,
      content: [{ type: "text", text }],
      isError,
      timestamp: Date.now(),
    },
  };
}

function model(api = "openai-responses", reasoning = true, id = `test-${api}`) {
  return {
    provider: api === "anthropic-messages" ? "anthropic" : api.startsWith("google") ? "google" : "openai",
    id,
    api,
    reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 8_000,
  };
}

function makeHarness(initialBranch: any[], selectedModel = model()) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, { handler: (...args: any[]) => any }>();
  const tools = new Map<string, { execute: (...args: any[]) => any }>();
  const notifications: Array<{ message: string; level: string }> = [];
  const statuses: Array<{ key: string; value: string | undefined }> = [];
  let currentBranch = initialBranch;
  const allEntries = [...initialBranch];
  let customId = 0;

  const pi = {
    on(name: string, handler: (...args: any[]) => any) {
      handlers.set(name, handler);
    },
    registerCommand(name: string, command: { handler: (...args: any[]) => any }) {
      commands.set(name, command);
    },
    registerTool(tool: { name: string; execute: (...args: any[]) => any }) {
      tools.set(tool.name, tool);
    },
    appendEntry(customType: string, data: unknown) {
      const entry = {
        type: "custom",
        id: `custom-${++customId}`,
        parentId: currentBranch.at(-1)?.id ?? null,
        customType,
        data,
      };
      currentBranch.push(entry);
      allEntries.push(entry);
    },
  };

  const turnController = new AbortController();
  const ctx = {
    model: selectedModel,
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return { ok: true, apiKey: "test-key", headers: { "x-test": "1" }, env: { TEST_ENV: "1" } };
      },
    },
    signal: turnController.signal,
    hasUI: true,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      setStatus(key: string, value: string | undefined) {
        statuses.push({ key, value });
      },
    },
    sessionManager: {
      getBranch: () => currentBranch,
      getEntries: () => allEntries,
      buildContextEntries: () => currentBranch,
      getSessionId: () => "tool-summary-test-session",
      getSessionFile: () => "/tmp/tool-summary-test-session.jsonl",
    },
  };

  return {
    allEntries,
    commands,
    ctx,
    getBranch: () => currentBranch,
    handlers,
    notifications,
    pi,
    setBranch(next: any[]) {
      currentBranch = next;
      for (const entry of next) {
        if (!allEntries.some((candidate) => candidate.id === entry.id)) allEntries.push(entry);
      }
    },
    statuses,
    tools,
    turnController,
  };
}

async function loadExtension(label: string) {
  return (await import(`../extensions/tool-summary/index.ts?tool-summary-test=${label}`)).default;
}

async function start(harness: ReturnType<typeof makeHarness>, label: string) {
  (await loadExtension(label))(harness.pi as any);
  const handler = harness.handlers.get("session_start");
  assert.ok(handler);
  await handler({ reason: "startup" }, harness.ctx);
}

function contextMessages(harness: ReturnType<typeof makeHarness>) {
  return harness.getBranch()
    .filter((entry) => entry.type === "message")
    .map((entry) => structuredClone(entry.message));
}

async function drain() {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function providerAcceptedRaw(harness: ReturnType<typeof makeHarness>) {
  const handler = harness.handlers.get("message_end");
  assert.ok(handler, "message_end should commit raw exposure after the provider response finishes");
  await handler(
    { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [], timestamp: Date.now() } },
    harness.ctx,
  );
}

test("an oversized result is raw once, then uses a frozen active-model summary without mutating JSONL", async () => {
  __resetCompleteStub();
  __setCompleteImplementation(async () => ({
    content: [{ type: "text", text: "- Exact result summary\n- path: /Users/example/project/file.ts\n- exit code: 0" }],
    stopReason: "stop",
  }));
  const raw = `important prose\n${"detail line\n".repeat(2_500)}`;
  assert.ok(raw.length > 16_000);
  const source = toolEntry("call-raw-first", "read", raw);
  const harness = makeHarness([source]);
  await start(harness, "raw-first");
  const context = harness.handlers.get("context");
  assert.ok(context);

  const firstMessages = contextMessages(harness);
  const firstResult = await context({ type: "context", messages: firstMessages }, harness.ctx);
  assert.equal(firstResult, undefined);
  assert.equal(firstMessages[0].content[0].text, raw);
  assert.equal(source.message.content[0].text, raw, "stored source must remain exact");
  assert.equal(harness.getBranch().filter((entry) => entry.customType === EXPOSURE_TYPE).length, 0);

  await providerAcceptedRaw(harness);
  assert.equal(harness.getBranch().filter((entry) => entry.customType === EXPOSURE_TYPE).length, 1);
  await drain();
  assert.equal(completeCalls.length, 1);
  assert.equal(completeCalls[0].model, harness.ctx.model);
  assert.equal(completeCalls[0].options.reasoningEffort, "low");
  assert.equal(completeCalls[0].options.maxTokens, 2_048);
  const completedEntries = harness.getBranch().filter((entry) => entry.customType === COMPLETE_TYPE);
  assert.equal(completedEntries.length, 1);
  assert.equal(completedEntries[0].data.source, "model");
  assert.equal("rawText" in completedEntries[0].data, false);
  assert.equal("content" in completedEntries[0].data, false);

  const secondMessages = contextMessages(harness);
  const secondResult = await context({ type: "context", messages: secondMessages }, harness.ctx);
  assert.ok(secondResult);
  const replacement = secondMessages[0].content[0].text;
  assert.notEqual(replacement, raw);
  assert.match(replacement, /Stored summary of oversized tool result/);
  assert.match(replacement, /Exact result summary/);
  assert.match(replacement, /tool_result_recall/);
  assert.ok(replacement.length <= 4_000);
  assert.equal(source.message.content[0].text, raw);

  const thirdMessages = contextMessages(harness);
  await context({ type: "context", messages: thirdMessages }, harness.ctx);
  assert.equal(thirdMessages[0].content[0].text, replacement);
  assert.equal(completeCalls.length, 1, "frozen summary must not be regenerated");
});

test("a failed provider attempt does not consume the one raw exposure", async () => {
  __resetCompleteStub();
  const raw = "prose\n".repeat(5_000);
  const harness = makeHarness([toolEntry("call-provider-retry", "read", raw)]);
  await start(harness, "provider-retry");
  const context = harness.handlers.get("context")!;

  const failedAttempt = contextMessages(harness);
  await context({ type: "context", messages: failedAttempt }, harness.ctx);
  assert.equal(failedAttempt[0].content[0].text, raw);
  await harness.handlers.get("message_end")!(
    { type: "message_end", message: { role: "assistant", stopReason: "error", content: [] } },
    harness.ctx,
  );
  await harness.handlers.get("message_end")!(
    { type: "message_end", message: { role: "assistant", stopReason: "aborted", content: [] } },
    harness.ctx,
  );
  assert.equal(harness.getBranch().filter((entry) => entry.customType === EXPOSURE_TYPE).length, 0);
  assert.equal(completeCalls.length, 0);

  const successfulRetry = contextMessages(harness);
  await context({ type: "context", messages: successfulRetry }, harness.ctx);
  assert.equal(successfulRetry[0].content[0].text, raw);
  await providerAcceptedRaw(harness);
  await drain();
  assert.equal(harness.getBranch().filter((entry) => entry.customType === EXPOSURE_TYPE).length, 1);
  assert.equal(completeCalls.length, 1);

  const afterExposure = contextMessages(harness);
  await context({ type: "context", messages: afterExposure }, harness.ctx);
  assert.match(afterExposure[0].content[0].text, /Stored summary/);
});

test("completed summaries and raw exposure survive extension reload through custom entries", async () => {
  __resetCompleteStub();
  const raw = "prose\n".repeat(5_000);
  const original = makeHarness([toolEntry("call-reload", "read", raw)]);
  await start(original, "reload-before");
  const firstContext = original.handlers.get("context")!;
  await firstContext({ type: "context", messages: contextMessages(original) }, original.ctx);
  await providerAcceptedRaw(original);
  await drain();
  assert.equal(completeCalls.length, 1);

  const reloaded = makeHarness([...original.getBranch()]);
  __resetCompleteStub();
  await start(reloaded, "reload-after");
  const messages = contextMessages(reloaded);
  await reloaded.handlers.get("context")!({ type: "context", messages }, reloaded.ctx);
  assert.match(messages[0].content[0].text, /Stored summary of oversized tool result/);
  assert.equal(completeCalls.length, 0, "reload must reuse the persisted summary");
});

test("deterministic classes are raw first and never call a model", async () => {
  __resetCompleteStub();
  const raw = `${"ordinary log\n".repeat(1_500)}ERROR exit code 23 at /tmp/build.log\nFINAL\n`;
  const harness = makeHarness([toolEntry("call-deterministic", "bash", raw)]);
  await start(harness, "deterministic");
  const context = harness.handlers.get("context")!;
  const first = contextMessages(harness);
  await context({ type: "context", messages: first }, harness.ctx);
  assert.equal(first[0].content[0].text, raw);
  await providerAcceptedRaw(harness);
  await drain();
  assert.equal(completeCalls.length, 0);
  const second = contextMessages(harness);
  await context({ type: "context", messages: second }, harness.ctx);
  assert.match(second[0].content[0].text, /ERROR exit code 23/);
  assert.match(second[0].content[0].text, /summary source: deterministic/);
  assert.equal(
    harness.getBranch().find((entry) => entry.customType === COMPLETE_TYPE)?.data.source,
    "deterministic",
  );
});

test("memory_read remains exact and never enters summary state", async () => {
  __resetCompleteStub();
  const raw = Array.from({ length: 1_500 }, (_, index) => `mem_${index}_record durable project fact`).join("\n");
  const harness = makeHarness([toolEntry("call-memory", "memory_read", raw)]);
  await start(harness, "memory-exempt");
  const context = harness.handlers.get("context")!;
  const messages = contextMessages(harness);
  await context({ type: "context", messages }, harness.ctx);
  assert.equal(messages[0].content[0].text, raw);
  await providerAcceptedRaw(harness);
  await drain();
  assert.equal(completeCalls.length, 0);
  assert.equal(harness.getBranch().filter((entry) => entry.customType === EXPOSURE_TYPE).length, 0);
  assert.equal(harness.getBranch().filter((entry) => entry.customType === COMPLETE_TYPE).length, 0);
});

test("deterministic summaries stay raw when required evidence cannot fit", async () => {
  __resetCompleteStub();
  const headers = Array.from(
    { length: 80 },
    (_, index) => `diff --git a/${"long-path/".repeat(5)}file-${index}.ts b/${"long-path/".repeat(5)}file-${index}.ts`,
  );
  const raw = [...headers, ...Array.from({ length: 1_000 }, (_, index) => `ordinary ${index}`)].join("\n");
  const harness = makeHarness([toolEntry("call-required-overflow", "bash", raw)]);
  await start(harness, "required-overflow");
  const context = harness.handlers.get("context")!;
  await context({ type: "context", messages: contextMessages(harness) }, harness.ctx);
  await providerAcceptedRaw(harness);
  await drain();
  const skipped = harness.getBranch().find((entry) => entry.customType === SKIP_TYPE);
  assert.equal(skipped?.data.reason, "required-evidence-overflow");
  assert.equal(harness.getBranch().filter((entry) => entry.customType === COMPLETE_TYPE).length, 0);

  const later = contextMessages(harness);
  await context({ type: "context", messages: later }, harness.ctx);
  assert.equal(later[0].content[0].text, raw);
});

test("model failures keep raw, cool down, and retry later without freezing a fallback", async () => {
  __resetCompleteStub();
  __setCompleteImplementation(async () => {
    throw new Error("provider unavailable");
  });
  const raw = `${"long report row\n".repeat(2_000)}ERROR failed assertion at /Users/example/test.ts:19\n`;
  const harness = makeHarness([toolEntry("call-fallback", "read", raw)]);
  await start(harness, "fallback");
  const context = harness.handlers.get("context")!;
  await context({ type: "context", messages: contextMessages(harness) }, harness.ctx);
  await providerAcceptedRaw(harness);
  await drain();
  assert.equal(completeCalls.length, 1);
  assert.equal(harness.getBranch().filter((entry) => entry.customType === COMPLETE_TYPE).length, 0);
  assert.equal(harness.getBranch().filter((entry) => entry.customType === RETRY_TYPE).length, 1);

  const coolingDown = contextMessages(harness);
  await context({ type: "context", messages: coolingDown }, harness.ctx);
  assert.equal(coolingDown[0].content[0].text, raw);
  assert.equal(completeCalls.length, 1, "cooldown must prevent per-context retries");

  const dueBranch = harness.getBranch().map((entry) =>
    entry.customType === RETRY_TYPE
      ? { ...entry, data: { ...entry.data, retryAfter: entry.data.failedAt } }
      : entry,
  );
  const reloaded = makeHarness(dueBranch);
  __resetCompleteStub();
  __setCompleteImplementation(async () => ({
    content: [{ type: "text", text: "successful retry summary" }],
    stopReason: "stop",
  }));
  await start(reloaded, "fallback-retry");
  const retryContext = reloaded.handlers.get("context")!;
  const retrying = contextMessages(reloaded);
  await retryContext({ type: "context", messages: retrying }, reloaded.ctx);
  assert.equal(retrying[0].content[0].text, raw, "the retrying call must remain raw and non-blocking");
  await drain();
  assert.equal(completeCalls.length, 1);
  assert.equal(reloaded.getBranch().filter((entry) => entry.customType === COMPLETE_TYPE).length, 1);

  const afterRetry = contextMessages(reloaded);
  await retryContext({ type: "context", messages: afterRetry }, reloaded.ctx);
  assert.match(afterRetry[0].content[0].text, /successful retry summary/);
  assert.doesNotMatch(afterRetry[0].content[0].text, /deterministic-fallback/);
});

test("in-flight model summaries never block context and remain deduplicated", async () => {
  __resetCompleteStub();
  let resolveComplete!: (value: any) => void;
  __setCompleteImplementation(
    () => new Promise((resolve) => {
      resolveComplete = resolve;
    }),
  );
  const raw = "report line\n".repeat(2_500);
  const harness = makeHarness([toolEntry("call-dedupe", "read", raw)]);
  await start(harness, "dedupe");
  const context = harness.handlers.get("context")!;
  await context({ type: "context", messages: contextMessages(harness) }, harness.ctx);
  await providerAcceptedRaw(harness);
  await drain();
  assert.equal(completeCalls.length, 1);

  const secondMessages = contextMessages(harness);
  const secondCall = context({ type: "context", messages: secondMessages }, harness.ctx);
  const outcome = await Promise.race([
    secondCall.then(() => "settled"),
    new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 50)),
  ]);
  if (outcome === "blocked") {
    resolveComplete({ content: [{ type: "text", text: "deduplicated summary" }], stopReason: "stop" });
    await secondCall;
  }
  assert.equal(outcome, "settled", "context must not wait for model summarization");
  assert.equal(secondMessages[0].content[0].text, raw);
  assert.equal(completeCalls.length, 1);

  const thirdMessages = contextMessages(harness);
  await context({ type: "context", messages: thirdMessages }, harness.ctx);
  assert.equal(thirdMessages[0].content[0].text, raw);
  assert.equal(completeCalls.length, 1, "in-flight work must remain deduplicated");

  resolveComplete({ content: [{ type: "text", text: "deduplicated summary" }], stopReason: "stop" });
  await drain();
  const fourthMessages = contextMessages(harness);
  await context({ type: "context", messages: fourthMessages }, harness.ctx);
  assert.match(fourthMessages[0].content[0].text, /deduplicated summary/);
  assert.equal(completeCalls.length, 1);
});

test("serialized model jobs start their timeout only when provider work begins", async () => {
  __resetCompleteStub();
  let resolveFirst: ((value: any) => void) | undefined;
  let callNumber = 0;
  __setCompleteImplementation(() => {
    callNumber += 1;
    if (callNumber === 1) {
      return new Promise((resolve) => {
        resolveFirst = resolve;
      });
    }
    return Promise.resolve({ content: [{ type: "text", text: "second summary" }], stopReason: "stop" });
  });

  const originalSetTimeout = globalThis.setTimeout;
  const timeoutRegistrations: number[] = [];
  globalThis.setTimeout = ((handler: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    if (delay === 90_000) {
      timeoutRegistrations.push(delay);
      return 0 as any;
    }
    return originalSetTimeout(handler, delay, ...args);
  }) as typeof setTimeout;

  try {
    const harness = makeHarness([
      toolEntry("call-queue-one", "read", "first report\n".repeat(2_500)),
      toolEntry("call-queue-two", "read", "second report\n".repeat(2_500)),
    ]);
    await start(harness, "queue-timeout");
    await harness.handlers.get("context")!({ type: "context", messages: contextMessages(harness) }, harness.ctx);
    await providerAcceptedRaw(harness);
    await drain();
    assert.equal(completeCalls.length, 1);
    assert.equal(timeoutRegistrations.length, 1, "queued work must not start its timeout");

    resolveFirst?.({ content: [{ type: "text", text: "first summary" }], stopReason: "stop" });
    await drain();
    assert.equal(completeCalls.length, 2);
    assert.equal(timeoutRegistrations.length, 2, "the second timeout starts with its provider call");
    assert.equal(harness.getBranch().filter((entry) => entry.customType === COMPLETE_TYPE).length, 2);
    assert.equal(harness.getBranch().filter((entry) => entry.customType === RETRY_TYPE).length, 0);
  } finally {
    resolveFirst?.({ content: [{ type: "text", text: "cleanup" }], stopReason: "stop" });
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("summary completions are discarded after branch navigation", async () => {
  __resetCompleteStub();
  let resolveComplete!: (value: any) => void;
  __setCompleteImplementation(
    () => new Promise((resolve) => {
      resolveComplete = resolve;
    }),
  );
  const raw = "report line\n".repeat(2_500);
  const source = toolEntry("call-stale", "read", raw);
  const harness = makeHarness([source]);
  await start(harness, "stale");
  await harness.handlers.get("context")!({ type: "context", messages: contextMessages(harness) }, harness.ctx);
  await providerAcceptedRaw(harness);
  await drain();
  assert.equal(completeCalls.length, 1);

  harness.setBranch([{ type: "message", id: "alternate", message: { role: "user", content: "alternate", timestamp: Date.now() } }]);
  await harness.handlers.get("session_tree")!({ type: "session_tree" }, harness.ctx);
  resolveComplete({ content: [{ type: "text", text: "stale summary" }], stopReason: "stop" });
  await drain();
  assert.equal(harness.allEntries.filter((entry) => entry.customType === COMPLETE_TYPE).length, 0);
});

test("new-branch summaries are not blocked by an old provider that ignores abort", async () => {
  __resetCompleteStub();
  let firstResolve!: (value: any) => void;
  let callNumber = 0;
  __setCompleteImplementation(() => {
    callNumber += 1;
    if (callNumber === 1) {
      return new Promise((resolve) => {
        firstResolve = resolve;
      });
    }
    return Promise.resolve({ content: [{ type: "text", text: "new branch summary" }], stopReason: "stop" });
  });

  const first = toolEntry("call-old-branch", "read", "old\n".repeat(7_000));
  const harness = makeHarness([first]);
  await start(harness, "queue-branch");
  await harness.handlers.get("context")!({ type: "context", messages: contextMessages(harness) }, harness.ctx);
  await providerAcceptedRaw(harness);
  await drain();
  assert.equal(completeCalls.length, 1);

  const second = toolEntry("call-new-branch", "read", "new\n".repeat(7_000));
  harness.setBranch([second]);
  await harness.handlers.get("session_tree")!({ type: "session_tree" }, harness.ctx);
  await harness.handlers.get("context")!({ type: "context", messages: contextMessages(harness) }, harness.ctx);
  await providerAcceptedRaw(harness);
  await drain();
  assert.equal(completeCalls.length, 2, "new generation should detach from the ignored old request");
  assert.ok(harness.getBranch().some((entry) => entry.customType === COMPLETE_TYPE && entry.data.toolCallId === "call-new-branch"));

  firstResolve({ content: [{ type: "text", text: "stale old summary" }], stopReason: "stop" });
  await drain();
  assert.equal(harness.allEntries.filter((entry) => entry.customType === COMPLETE_TYPE && entry.data.toolCallId === "call-old-branch").length, 0);
});

test("pause retains existing substitutions, off restores raw with a growth warning, and on is immediate", async () => {
  __resetCompleteStub();
  const raw = "prose\n".repeat(5_000);
  const source = toolEntry("call-controls", "read", raw);
  const harness = makeHarness([source]);
  await start(harness, "controls");
  const context = harness.handlers.get("context")!;
  await context({ type: "context", messages: contextMessages(harness) }, harness.ctx);
  await providerAcceptedRaw(harness);
  await drain();
  const command = harness.commands.get("tool-summary")?.handler;
  assert.ok(command);

  await command("pause", harness.ctx);
  let messages = contextMessages(harness);
  await context({ type: "context", messages }, harness.ctx);
  assert.match(messages[0].content[0].text, /Stored summary/);

  const newRaw = "new prose\n".repeat(3_000);
  const newEntry = toolEntry("call-paused-new", "read", newRaw);
  harness.getBranch().push(newEntry);
  harness.allEntries.push(newEntry);
  messages = contextMessages(harness);
  await context({ type: "context", messages }, harness.ctx);
  assert.equal(messages[1].content[0].text, newRaw);
  assert.equal(
    harness.getBranch().filter((entry) => entry.customType === EXPOSURE_TYPE && entry.data.toolCallId === "call-paused-new").length,
    0,
  );

  await command("off", harness.ctx);
  messages = contextMessages(harness);
  await context({ type: "context", messages }, harness.ctx);
  assert.equal(messages[0].content[0].text, raw);
  assert.ok(harness.notifications.some((item) => item.level === "warning" && item.message.includes("growth")));

  await command("on", harness.ctx);
  messages = contextMessages(harness);
  await context({ type: "context", messages }, harness.ctx);
  assert.match(messages[0].content[0].text, /Stored summary/);
  assert.ok(harness.getBranch().some((entry) => entry.customType === CONFIG_TYPE && entry.data.mode === "on"));
});

test("pause cancels unfinished summary creation while keeping prior completed summaries", async () => {
  __resetCompleteStub();
  let resolveComplete!: (value: any) => void;
  __setCompleteImplementation(() => new Promise((resolve) => {
    resolveComplete = resolve;
  }));
  const harness = makeHarness([toolEntry("call-pause-running", "read", "prose\n".repeat(5_000))]);
  await start(harness, "pause-running");
  await harness.handlers.get("context")!({ type: "context", messages: contextMessages(harness) }, harness.ctx);
  await providerAcceptedRaw(harness);
  await drain();
  assert.equal(completeCalls.length, 1);
  await harness.commands.get("tool-summary")!.handler("pause", harness.ctx);
  resolveComplete({ content: [{ type: "text", text: "must not persist" }], stopReason: "stop" });
  await drain();
  assert.equal(harness.allEntries.filter((entry) => entry.customType === COMPLETE_TYPE).length, 0);
});

test("aborting during delayed auth never starts an outbound summary completion", async () => {
  __resetCompleteStub();
  let resolveAuth!: (value: any) => void;
  const harness = makeHarness([toolEntry("call-delayed-auth", "read", "prose\n".repeat(5_000))]);
  harness.ctx.modelRegistry.getApiKeyAndHeaders = () => new Promise((resolve) => {
    resolveAuth = resolve;
  });
  await start(harness, "delayed-auth");
  await harness.handlers.get("context")!({ type: "context", messages: contextMessages(harness) }, harness.ctx);
  await providerAcceptedRaw(harness);
  await drain();
  assert.equal(completeCalls.length, 0);

  await harness.commands.get("tool-summary")!.handler("off", harness.ctx);
  resolveAuth({ ok: true, apiKey: "late-key", headers: {}, env: {} });
  await drain();
  assert.equal(completeCalls.length, 0);
  assert.equal(harness.allEntries.filter((entry) => entry.customType === COMPLETE_TYPE).length, 0);
  assert.equal(harness.allEntries.filter((entry) => entry.customType === RETRY_TYPE).length, 0);
});

test("a non-worthwhile replacement is terminal and never retried", async () => {
  __resetCompleteStub();
  const hugeId = `call-${"id".repeat(1_600)}`;
  const raw = `ERROR ${"x".repeat(4_103)}`;
  const harness = makeHarness([toolEntry(hugeId, "bash", raw, true)]);
  await start(harness, "not-worthwhile");
  await harness.commands.get("tool-summary")!.handler("threshold 4001 16k", harness.ctx);
  const context = harness.handlers.get("context")!;
  await context({ type: "context", messages: contextMessages(harness) }, harness.ctx);
  await providerAcceptedRaw(harness);
  await drain();
  assert.equal(harness.getBranch().filter((entry) => entry.customType === SKIP_TYPE).length, 1);
  assert.equal(harness.getBranch().filter((entry) => entry.customType === COMPLETE_TYPE).length, 0);

  const second = contextMessages(harness);
  await context({ type: "context", messages: second }, harness.ctx);
  assert.equal(second[0].content[0].text, raw);
  assert.equal(harness.getBranch().filter((entry) => entry.customType === SKIP_TYPE).length, 1);
  assert.equal(completeCalls.length, 0);
});

test("threshold, status, and reset controls persist without reload", async () => {
  __resetCompleteStub();
  const harness = makeHarness([]);
  await start(harness, "thresholds");
  const command = harness.commands.get("tool-summary")!.handler;
  await command("threshold 9k 18k", harness.ctx);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(harness.getBranch().findLast((entry) => entry.customType === CONFIG_TYPE).data)
        .filter(([key]) => key.endsWith("Threshold")),
    ),
    { standardThreshold: 9_000, highFidelityThreshold: 18_000 },
  );
  await command("status", harness.ctx);
  assert.ok(harness.notifications.at(-1)?.message.includes("standard 9.0K chars"));
  await command("reset", harness.ctx);
  const latest = harness.getBranch().findLast((entry) => entry.customType === CONFIG_TYPE).data;
  assert.notEqual(latest.epoch, "initial");
  assert.equal(latest.standardThreshold, 9_000);
  assert.equal(latest.highFidelityThreshold, 18_000);

  await command("threshold reset", harness.ctx);
  const defaults = harness.getBranch().findLast((entry) => entry.customType === CONFIG_TYPE).data;
  assert.equal(defaults.standardThreshold, 16_000);
  assert.equal(defaults.highFidelityThreshold, 24_000);
});

test("active-model summarization requests low reasoning only through supported provider options", async (t) => {
  const cases = [
    { api: "openai-responses", id: "gpt-5.4", expected: { reasoningEffort: "low" } },
    { api: "anthropic-messages", id: "claude-opus-4-6", expected: { thinkingEnabled: true, effort: "low" } },
    { api: "google-generative-ai", id: "gemini-2.5-pro", expected: { thinking: { enabled: true, budgetTokens: 2_048 } } },
    { api: "google-generative-ai", id: "gemini-3.1-pro-preview", expected: { thinking: { enabled: true, level: "LOW" } } },
  ];
  for (const item of cases) {
    await t.test(`${item.api}/${item.id}`, async () => {
      __resetCompleteStub();
      const raw = "prose\n".repeat(5_000);
      const harness = makeHarness([toolEntry(`call-${item.id}`, "read", raw)], model(item.api, true, item.id));
      await start(harness, `reasoning-${item.id}`);
      await harness.handlers.get("context")!({ type: "context", messages: contextMessages(harness) }, harness.ctx);
      await providerAcceptedRaw(harness);
      await drain();
      assert.equal(completeCalls.length, 1);
      for (const [key, value] of Object.entries(item.expected)) {
        assert.deepEqual(completeCalls[0].options[key], value);
      }
    });
  }

  await t.test("non-reasoning model", async () => {
    __resetCompleteStub();
    const raw = "prose\n".repeat(5_000);
    const harness = makeHarness([toolEntry("call-no-reasoning", "read", raw)], model("openai-responses", false));
    await start(harness, "reasoning-none");
    await harness.handlers.get("context")!({ type: "context", messages: contextMessages(harness) }, harness.ctx);
    await providerAcceptedRaw(harness);
    await drain();
    assert.equal(completeCalls.length, 1);
    assert.equal("reasoningEffort" in completeCalls[0].options, false);
  });
});

test("recall retrieves exact head, tail, line-range, and literal search without recursive summarization", async () => {
  __resetCompleteStub();
  const raw = "one\nTwo target\r\ntHree\nfour";
  const source = toolEntry("call-recall", "bash", raw);
  const harness = makeHarness([source]);
  await start(harness, "recall");
  const recall = harness.tools.get("tool_result_recall")?.execute;
  assert.ok(recall);

  const range = await recall(
    "recall-range",
    { toolCallId: "call-recall", operation: "line-range", startLine: 2, endLine: 3 },
    new AbortController().signal,
    () => undefined,
    harness.ctx,
  );
  assert.match(range.content[0].text, /Two target\r\ntHree\n\n\[End exact recall\]/);
  assert.equal(range.details.exact, true);

  const search = await recall(
    "recall-search",
    { toolCallId: "call-recall", operation: "search", query: "TARGET", caseSensitive: false },
    new AbortController().signal,
    () => undefined,
    harness.ctx,
  );
  assert.match(search.content[0].text, /exact match at line 2/);
  assert.match(search.content[0].text, /Two target\r/);
  assert.equal(search.details.totalMatches, 1);

  const head = await recall(
    "recall-head",
    { toolCallId: "call-recall", operation: "head", lineCount: 2 },
    new AbortController().signal,
    () => undefined,
    harness.ctx,
  );
  assert.match(head.content[0].text, /one\nTwo target\r\n\n\[End exact recall\]/);

  const tail = await recall(
    "recall-tail",
    { toolCallId: "call-recall", operation: "tail", lineCount: 1 },
    new AbortController().signal,
    () => undefined,
    harness.ctx,
  );
  assert.match(tail.content[0].text, /four\n\[End exact recall\]/);

  const outOfBounds = await recall(
    "recall-out-of-bounds",
    { toolCallId: "call-recall", operation: "line-range", startLine: 99, endLine: 100 },
    new AbortController().signal,
    () => undefined,
    harness.ctx,
  );
  assert.match(outOfBounds.content[0].text, /outside the stored result's 1-4 line range/);
  assert.equal(outOfBounds.details.error, "line range out of bounds");

  const recallMessage = {
    role: "toolResult",
    toolCallId: "recall-output",
    toolName: "tool_result_recall",
    content: [{ type: "text", text: "x".repeat(60_000) }],
    isError: false,
  };
  const messages = [structuredClone(recallMessage)];
  await harness.handlers.get("context")!({ type: "context", messages }, harness.ctx);
  assert.equal(messages[0].content[0].text.length, 60_000);
  assert.equal(
    harness.getBranch().filter((entry) => entry.customType === EXPOSURE_TYPE && entry.data.toolCallId === "recall-output").length,
    0,
  );
});

test("recall is active-branch scoped and preserves whitespace-sensitive literal search", async () => {
  __resetCompleteStub();
  const inactive = toolEntry("call-inactive-secret", "bash", "inactive secret");
  const activeWhitespace = toolEntry("call-whitespace", "bash", "has space\nnospace\n");
  const boundedSearch = toolEntry(
    "call-bounded-search",
    "bash",
    Array.from({ length: 130 }, (_, index) => `match-${index} ${"x".repeat(450)}`).join("\n"),
  );
  const harness = makeHarness([inactive]);
  harness.setBranch([activeWhitespace, boundedSearch]);
  await start(harness, "recall-branch-search");
  const recall = harness.tools.get("tool_result_recall")!.execute;

  const inactiveResult = await recall(
    "inactive",
    { toolCallId: "call-inactive-secret", operation: "head", lineCount: 1 },
    new AbortController().signal,
    () => undefined,
    harness.ctx,
  );
  assert.match(inactiveResult.content[0].text, /No stored tool result found/);

  const whitespaceResult = await recall(
    "whitespace",
    { toolCallId: "call-whitespace", operation: "search", query: " ", caseSensitive: true },
    new AbortController().signal,
    () => undefined,
    harness.ctx,
  );
  assert.match(whitespaceResult.content[0].text, /has space/);
  assert.equal(whitespaceResult.details.totalMatches, 1);

  const boundedResult = await recall(
    "bounded",
    { toolCallId: "call-bounded-search", operation: "search", query: "match-", maxMatches: 100 },
    new AbortController().signal,
    () => undefined,
    harness.ctx,
  );
  assert.ok(boundedResult.content[0].text.length <= 50_000);
  assert.match(boundedResult.content[0].text, /additional matching lines omitted/);
  assert.match(boundedResult.content[0].text, /\[End exact recall\]$/);
});

test("recall refuses an exact slice that exceeds its output guard", async () => {
  __resetCompleteStub();
  const raw = "x".repeat(60_000);
  const harness = makeHarness([toolEntry("call-recall-bound", "bash", raw)]);
  await start(harness, "recall-bound");
  const result = await harness.tools.get("tool_result_recall")!.execute(
    "recall-bound-tool",
    { toolCallId: "call-recall-bound", operation: "line-range", startLine: 1, endLine: 1 },
    new AbortController().signal,
    () => undefined,
    harness.ctx,
  );
  assert.match(result.content[0].text, /exceeding the recall output guard/);
  assert.equal(result.details.exact, false);
  assert.ok(result.content[0].text.length < 1_000);
});
