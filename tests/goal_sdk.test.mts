import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Goal lifecycle fixture timed out");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function assistant(model: any, stopReason = "stop") {
  return { role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [{ type: "text", text: "Fixture step completed." }], stopReason, timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as any;
}

function goalState(session: any) {
  return session.sessionManager.getBranch().findLast((entry: any) => entry.type === "custom" && entry.customType === "pi-goal-state")?.data;
}

async function fixture(run: (session: any) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "pi-goal-sdk-"));
  const fetch = globalThis.fetch;
  let networkAttempts = 0;
  let session: any;
  globalThis.fetch = async () => { networkAttempts++; throw new Error("Network forbidden in goal fixture"); };
  try {
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("extensions/goal/index.ts")] });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(),
      modelsPath: join(dir, "models.json"), modelsStorePath: join(dir, "models-store.json"), allowModelNetwork: false });
    const model = runtime.getModel("openai", "gpt-4o");
    assert(model);
    await runtime.setRuntimeApiKey("openai", "local-fixture-not-a-real-key");
    ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model,
      resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(dir), tools: [] }));
    const errors: unknown[] = [];
    await session.bindExtensions({ onError: (error: unknown) => errors.push(error) });
    await session.extensionRunner.getToolDefinition("start_goal").execute("start", {
      objective: "Complete two local fixture steps", maxTurns: 2,
    }, undefined, undefined, session.extensionRunner.createContext());
    await run(session);
    assert.equal(networkAttempts, 0);
    assert.deepEqual(errors, []);
  } finally {
    if (session) {
      await session.abort();
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
      session.dispose();
    }
    globalThis.fetch = fetch;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("real SDK: goal continuation stops after the final budget-summary turn", { timeout: 15000 }, async () => {
  await fixture(async session => {
    let calls = 0;
    session.agent.streamFunction = (model: any) => {
      assert(++calls <= 3, "goal must stop after its two budgeted turns and final summary");
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message: assistant(model) });
      stream.end();
      return stream;
    };
    await session.prompt("Run the fixture.");
    await waitUntil(() => goalState(session)?.status === "budget_limited" && calls === 3 && session.isIdle);
    // Give deferred continuation timers a chance to run before cleanup can cancel them.
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(calls, 3);
    assert.equal(goalState(session).turnsCompleted, 2);
    assert.equal(goalState(session).budgetNoticeSent, true);
    assert.equal(session.sessionManager.getBranch().filter((entry: any) => entry.customType === "goal-autopilot").length, 2);
  });
});

test("real SDK: abort pauses the goal and does not schedule another model call", { timeout: 15000 }, async () => {
  await fixture(async session => {
    let calls = 0;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    session.agent.streamFunction = (model: any, _context: any, options: any) => {
      calls++;
      const stream = createAssistantMessageEventStream();
      const abort = () => {
        stream.push({ type: "error", reason: "aborted", error: assistant(model, "aborted") });
        stream.end();
      };
      options.signal.addEventListener("abort", abort, { once: true });
      if (options.signal.aborted) abort();
      entered();
      return stream;
    };
    const prompt = session.prompt("Run until interrupted.");
    try { await started; await session.abort(); } finally { await prompt; }
    // Observe queued timers before shutdown, rather than masking a stray continuation.
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(goalState(session).status, "paused");
    assert.equal(goalState(session).turnsCompleted, 0);
    assert.equal(calls, 1);
    assert.equal(session.sessionManager.getBranch().some((entry: any) => entry.customType === "goal-autopilot"), false);
  });
});
