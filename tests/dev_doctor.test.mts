import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import doctor from "../extensions/dev-doctor/index.ts";
import { createMcpInventory, formatMcpInventory, MCP_STATUS_EVENT } from "../extensions/dev-doctor/mcp-inventory.ts";

function harness() {
  const events = new EventEmitter();
  const hooks = new Map<string, Function>();
  const commands = new Map<string, any>();
  const tools: any[] = [];
  const active: string[] = [];
  let registered: any;
  const pi: any = {
    events: { on(name: string, fn: any) { events.on(name, fn); return () => events.off(name, fn); } },
    on(name: string, fn: Function) { hooks.set(name, fn); },
    getAllTools: () => tools,
    getActiveTools: () => active,
    registerCommand(name: string, command: any) { commands.set(name, command); },
    registerTool(value: any) { registered = value; },
  };
  return { pi, events, hooks, commands, tools, active, tool: () => registered };
}

function tool() {
  const h = harness();
  doctor(h.pi);
  assert.equal(h.tool().name, "dev_doctor");
  return h.tool();
}

test("doctor is sequential and explains opt-in authority and evidence limits", () => {
  const registered = tool();
  assert.equal(registered.executionMode, "sequential");
  assert.match(registered.description, /Static by default/);
  assert.match(registered.description, /NOT browser execution/);
  assert.match(registered.description, /possible side effects/);
});

test("wrapper executes the static CLI and retains structured unknown states and failures", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dev-doctor-tool-"));
  const before = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  try {
    const agent = path.join(root, ".pi/agent");
    await mkdir(agent, { recursive: true });
    await mkdir(path.join(root, ".pi/research"), { recursive: true });
    await writeFile(path.join(agent, "settings.json"), '{"extensions": []}');
    await writeFile(path.join(root, ".pi/research/config.json"), '{"browserWorkerEnabled": false}');
    process.env.HOME = root;
    process.env.PI_CODING_AGENT_DIR = agent;
    const result = await tool().execute("doctor", {}, new AbortController().signal);
    assert.equal(result.details.schema_version, 1);
    const rows = Object.fromEntries(result.details.capabilities.map((row: any) => [row.capability, row]));
    assert.equal(rows.extensions.loaded, "unknown");
    assert.equal(rows.browser_worker.outcome, "disabled");
    assert.equal(rows.dependencies.probe_type, "static");
    assert.match(result.content[0].text, /not a readiness verdict/);
    assert.equal(result.details.mcp_connections.scope.startsWith("current Pi runtime only"), true);
    assert.equal(result.details.mcp_connections.adapter.evidence, "not_observed");
    assert.match(result.content[0].text, /Extension-managed \(not listed in \/mcp\)/);
    await writeFile(path.join(agent, "settings.json"), '{SECRET_MUST_NOT_LEAK');
    const failed = await tool().execute("doctor", {}, new AbortController().signal);
    assert.equal(failed.details.outcome, "issues_found");
    assert.equal(failed.details.checker_exit_code, 1);
    assert.doesNotMatch(JSON.stringify(failed), /SECRET_MUST_NOT_LEAK/);
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("wrapper rejects invalid deadlines and observes pre-aborted signals", async () => {
  const registered = tool();
  for (const timeoutSeconds of [0, -1, 61, NaN, Infinity]) {
    await assert.rejects(registered.execute("doctor", { timeoutSeconds }, new AbortController().signal), /deadline/);
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(registered.execute("doctor", {}, controller.signal), /abort/i);
});

test("MCP inventory separates adapter reports from source-attested wrappers without connecting", () => {
  const h = harness();
  const snapshot = createMcpInventory(h.pi);
  const wrapperPath = fileURLToPath(new URL("../extensions/pi-browser-capture/src/browser-worker.ts", import.meta.url));
  h.tools.push({ name: "browser_fetch", sourceInfo: { path: wrapperPath } },
    { name: "browser_inspect", sourceInfo: { path: wrapperPath } },
    { name: "web_search", sourceInfo: { path: "/not/our/wrapper.ts" } });
  h.active.push("browser_fetch");
  h.events.emit(MCP_STATUS_EVENT, { version: 1, servers: [
    { name: "blender", status: "cached", toolCount: 6, command: "SECRET_MUST_NOT_LEAK" },
    { name: "freecad", status: "disabled", toolCount: 0 },
  ], headers: { authorization: "SECRET_MUST_NOT_LEAK" } });
  const result = snapshot();
  assert.equal(result.adapter.evidence, "adapter_reported");
  assert.equal(result.adapter.servers?.[0].status, "cached");
  assert.equal(result.adapter.servers?.[1].status, "disabled");
  assert.deepEqual(result.extension_managed[0].registered_tools, ["browser_fetch", "browser_inspect"]);
  assert.deepEqual(result.extension_managed[0].active_tools, ["browser_fetch"]);
  assert.deepEqual(result.extension_managed[1].registered_tools, []);
  assert.equal(result.extension_managed[0].service_readiness, "not_probed");
  assert.doesNotMatch(JSON.stringify(result), /SECRET_MUST_NOT_LEAK/);
  assert.match(formatMcpInventory(result), /blender: cached, 6 tools/);
  // Returned reports must not let consumers overwrite retained observations.
  result.adapter.servers![0].status = "failed";
  assert.equal(snapshot().adapter.servers?.[0].status, "cached");
  h.hooks.get("session_shutdown")!();
  assert.equal(h.events.listenerCount(MCP_STATUS_EVENT), 0);
  assert.equal(snapshot().adapter.evidence, "not_observed");
});

test("MCP inventory bounds payloads, rejects malformed updates, and keeps unknown explicit", () => {
  const h = harness();
  const snapshot = createMcpInventory(h.pi);
  assert.match(formatMcpInventory(snapshot()), /no usable adapter snapshot/);
  h.events.emit(MCP_STATUS_EVENT, { version: 1, servers: Array.from({ length: 51 }, (_, i) =>
    ({ name: `server-${i}`, status: "connected", toolCount: 2 })) });
  assert.equal(snapshot().adapter.servers?.length, 50);
  assert.equal(snapshot().adapter.total, 51);
  assert.equal(snapshot().adapter.truncated, true);
  for (const value of [null, { version: 2, servers: [] }, { version: 1, servers: "bad" },
    { version: 1, servers: [{ name: "control\u001b", status: "connected", toolCount: 1 }] },
    { version: 1, servers: [{ name: "test", status: "made-up", toolCount: 1 }] },
    { version: 1, servers: [{ name: "test", status: "cached", toolCount: -1 }] }]) {
    h.events.emit(MCP_STATUS_EVENT, value);
    assert.equal(snapshot().adapter.evidence, "invalid_report");
    assert.equal(snapshot().adapter.servers, undefined);
  }
  h.events.emit(MCP_STATUS_EVENT, { version: 1, servers: [] });
  assert.match(formatMcpInventory(snapshot()), /No servers in the last adapter report/);
});

test("mcp-connections command is diagnostic only and updates from late adapter reports", async () => {
  const h = harness();
  doctor(h.pi);
  const messages: string[] = [];
  const ctx = { hasUI: true, ui: { notify: (text: string) => messages.push(text) } };
  const command = h.commands.get("mcp-connections");
  await command.handler("", ctx);
  assert.match(messages[0], /not_observed/);
  h.events.emit(MCP_STATUS_EVENT, { version: 1, servers: [{ name: "blender", status: "cached", toolCount: 6 }] });
  await command.handler("", ctx);
  assert.match(messages[1], /blender: cached/);
  assert.match(messages[1], /service not probed/);
});
