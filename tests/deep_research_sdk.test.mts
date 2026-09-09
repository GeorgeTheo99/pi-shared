import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { runAgentLoop } from "@earendil-works/pi-agent-core";

test("installed SDK + loopback broker: native errors, success, schema, command, cancellation and credential-safe bundles", { timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "research-sdk-"));
  const envKeys = ["HOME", "PI_WEBSEARCH_MCP_URL", "SEARCH_MCP_URL", "WEBSEARCH_MCP_URL", "PI_WEBSEARCH_MCP_API_KEY", "SEARCH_MCP_API_KEY", "PI_WEBSEARCH_TAVILY_API_KEY", "TAVILY_API_KEY"];
  const old = new Map(envKeys.map(k => [k, process.env[k]]));
  for (const key of envKeys) delete process.env[key];
  process.env.HOME = root;
  let mode: "success" | "failed" | "fetch-error" | "empty" | "empty-fetch" = "success";
  let emptyEnvelope: unknown;
  const calls: any[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    calls.push(payload);
    if (req.url !== "/mcp?token=fixture-secret") { res.writeHead(401).end(); return; }
    const search = payload.params.name === "web_search";
    let result;
    if (mode === "empty-fetch" && !search) {
      result = emptyEnvelope;
    } else if (mode === "failed" || (mode === "fetch-error" && !search)) {
      result = { isError: true, content: [{ type: "text", text: "upstream denied request" }] };
    } else if (search) {
      result = { content: [{ type: "text", text: JSON.stringify({ results: mode === "empty" ? [] : [
        { title: "Primary fixture", url: "https://one.example/evidence", snippet: "solar evidence" },
        { title: "Independent fixture", url: "https://two.example/evidence", snippet: "solar evidence" },
      ] }) }] };
    } else {
      result = { content: [{ type: "text", text: "Navigation\n".repeat(200) + "Solar energy storage safety limit: 42.\n" }] };
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const address = server.address() as { port: number };
  process.env.PI_WEBSEARCH_MCP_URL = `http://127.0.0.1:${address.port}/mcp?token=fixture-secret`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
    for (const [key, value] of old) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });
  const agentDir = join(root, "profile"); mkdirSync(agentDir);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [], extensions: [resolve("extensions/deep-research/index.ts")] }));
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, noContextFiles: true,
    settingsManager: SettingsManager.create(root, agentDir, { projectTrusted: false }) });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const tool = loaded.extensions.flatMap(e => [...e.tools.values()]).find(t => t.definition.name === "deep_research")!.definition;
  assert.ok(tool);
  const ctx: any = { cwd: root };
  const model: any = { id: "fixture", name: "fixture", provider: "test", api: "openai-responses", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1024 };
  async function finalize(args: any) {
    const streamFn: any = () => {
      const stream = createAssistantMessageEventStream();
      const message: any = { role: "assistant", content: [{ type: "toolCall", id: "fixture", name: tool.name, arguments: args }], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() };
      stream.push({ type: "done", reason: "toolUse", message }); return stream;
    };
    const messages = await runAgentLoop([{ role: "user", content: "fixture only", timestamp: Date.now() }], { systemPrompt: "fixture", messages: [], tools: [{ ...tool,
      execute: (id, args, signal, update) => tool.execute(id, args, signal, update, ctx) }] }, { model, convertToLlm: (m: any) => m, shouldStopAfterTurn: () => true }, () => {}, undefined, streamFn);
    return messages.find(m => m.role === "toolResult") as any;
  }
  const invalid = await finalize({ question: "solar", max_sources: -1 });
  assert.equal(invalid.isError, true);
  assert.equal(calls.length, 0);
  const success = await finalize({ question: "solar energy storage safety", depth: "quick" });
  assert.equal(success.isError, false);
  assert.equal(success.details.status, "complete");
  assert.equal(success.details.fetchedCount, 2);
  assert.match(success.content[0].text, /limit: 42/);
  assert.ok(calls.every(c => !String(c.params.arguments.query).includes("health check")));
  let bundle = JSON.parse(readFileSync(join(success.details.bundleDir, "sources.json"), "utf8"));
  assert.equal(JSON.stringify(bundle).includes("fixture-secret"), false);
  assert.match(bundle.searchEndpoint, /redacted/i);
  assert.ok(bundle.sources[0].passages.length);

  mode = "failed";
  const failed = await finalize({ question: "solar", depth: "quick" });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /Research failed/);
  assert.match(failed.content[0].text, /Diagnostics:/);
  mode = "fetch-error";
  const partial = await finalize({ question: "solar", depth: "quick" });
  assert.equal(partial.isError, false);
  assert.equal(partial.details.status, "partial");
  bundle = JSON.parse(readFileSync(join(partial.details.bundleDir, "sources.json"), "utf8"));
  assert.ok(bundle.sources.every((s: any) => s.fetchStatus === "failed" && !s.excerpt));
  mode = "empty-fetch";
  for (const envelope of [null, {}, { content: [] }, { content: [{ type: "text", text: "" }] }, { content: [{ type: "text", text: "  " }] }]) {
    emptyEnvelope = envelope;
    const missing = await finalize({ question: "solar", depth: "quick" });
    assert.equal(missing.details.status, "partial");
    assert.equal(missing.details.fetchedCount, 0);
    const evidence = JSON.parse(readFileSync(join(missing.details.bundleDir, "sources.json"), "utf8"));
    assert.ok(evidence.sources.every((s: any) => s.fetchStatus === "failed" && !s.contentHash && !s.excerpt));
  }
  mode = "empty";
  const empty = await finalize({ question: "solar", depth: "quick" });
  assert.equal(empty.isError, false);
  assert.equal(empty.details.status, "empty");

  const beforeCancel = calls.length;
  const controller = new AbortController(); const reason = new Error("cancelled fixture"); controller.abort(reason);
  await assert.rejects(tool.execute("id", { question: "solar" }, controller.signal, undefined, ctx), e => e === reason);
  assert.equal(calls.length, beforeCancel);

  const messages: string[] = []; const prompts: string[] = []; let command: any;
  const { default: register } = await import("../extensions/deep-research/index.ts");
  register({ registerTool: () => {}, registerCommand: (_name: string, cmd: any) => { command = cmd; }, sendMessage: (m: any) => messages.push(m.content), sendUserMessage: (m: string) => prompts.push(m) } as any);
  mode = "success";
  const count = readdirSync(join(root, ".pi/research")).length;
  await command.handler('--no-save --no-synthesize --fetch 0 --depth quick solar', ctx);
  assert.equal(readdirSync(join(root, ".pi/research")).length, count);
  assert.equal(prompts.length, 0);
  await command.handler('--no-save --depth quick solar', ctx);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /untrusted evidence/);
  mode = "failed";
  await command.handler('--no-save --depth quick solar', ctx);
  assert.equal(prompts.length, 1);
  assert.ok(messages.some(m => m.includes("Research failed")));
  assert.equal(messages.join("\n").includes("fixture-secret"), false);
});
