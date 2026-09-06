import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const moduleUrl = new URL("../extensions/pi-browser-capture/src/browser-worker.ts", import.meta.url);
const originalEndpoint = process.env.BROWSER_WORKER_MCP_URL;
const originalTokenFile = process.env.BROWSER_WORKER_MCP_TOKEN_FILE;
const originalFetch = globalThis.fetch;
let root: string;
let tokenFile: string;
const marker = "SENSITIVE_TEST_MARKER";

test.beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-browser-wrapper-"));
  tokenFile = join(root, "token");
  writeFileSync(tokenFile, `${marker}\n`, { mode: 0o600 });
  process.env.BROWSER_WORKER_MCP_URL = "http://127.0.0.1:18890/mcp";
  process.env.BROWSER_WORKER_MCP_TOKEN_FILE = tokenFile;
  globalThis.fetch = async () => { throw new Error("Unexpected network call"); };
});

test.afterEach(() => {
  if (originalEndpoint === undefined) delete process.env.BROWSER_WORKER_MCP_URL;
  else process.env.BROWSER_WORKER_MCP_URL = originalEndpoint;
  if (originalTokenFile === undefined) delete process.env.BROWSER_WORKER_MCP_TOKEN_FILE;
  else process.env.BROWSER_WORKER_MCP_TOKEN_FILE = originalTokenFile;
  globalThis.fetch = originalFetch;
  rmSync(root, { recursive: true, force: true });
});

async function importFresh() {
  return import(`${moduleUrl.href}?case=${Date.now()}-${Math.random()}`);
}

function harness() {
  const tools: Array<{ name: string; parameters: any; execute: Function }> = [];
  const handlers = new Map<string, Function>();
  const notices: string[] = [];
  return { tools, handlers, notices, api: {
    registerTool: (tool: any) => tools.push(tool),
    on: (name: string, handler: Function) => handlers.set(name, handler),
  }, start() {
    handlers.get("session_start")?.({}, { hasUI: true, ui: { notify: (text: string, level: string) => {
      assert.equal(level, "warning");
      notices.push(text);
    } } });
  } };
}

function listPayload(init?: RequestInit) {
  return { jsonrpc: "2.0", id: JSON.parse(String(init?.body)).id, result: {
    tools: [{ name: "browser_fetch" }, { name: "browser_inspect" }],
  } };
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

async function assertDisabled(reason: RegExp) {
  const h = harness();
  await (await importFresh()).default(h.api);
  assert.deepEqual(h.tools, []);
  h.start();
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0], reason);
  assert.match(h.notices[0], /pi-browser-check/);
  assert.match(h.notices[0], /BROWSER_WORKER_MCP_TOKEN_FILE/);
  assert.match(h.notices[0], /restart Pi or \/reload/);
  assert.equal(h.notices[0].includes(marker), false);
  return h;
}

test("import performs no network or token access, including invalid configuration", async () => {
  process.env.BROWSER_WORKER_MCP_URL = "not a URL";
  process.env.BROWSER_WORKER_MCP_TOKEN_FILE = join(root, "absent");
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("no network"); };
  await importFresh();
  assert.equal(calls, 0);
});

test("unsafe endpoints disable tools without sending a token", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return json({}); };
  for (const endpoint of [
    "http://example.com:8890/mcp", "https://127.0.0.1:8890/mcp",
    `http://user:${marker}@127.0.0.1:8890/mcp`, `http://127.0.0.1:8890/mcp?token=${marker}`,
    "http://127.0.0.1:8890/mcp#", "http://127.0.0.1:8890/other",
    "http://localhost:8890/mcp", "http://127.0.0.2:8890/mcp", "http://2130706433:8890/mcp",
    "http://127.0.0.1/mcp", "http://127.0.0.1:80/mcp", "http://127.0.0.1:0/mcp",
    "http://127.0.0.1:65536/mcp", "http://127.0.0.1:08890/mcp",
    "http://127.0.0.1:8890/../mcp", "http://127.0.0.1:8890\\mcp", "\nhttp://127.0.0.1:8890/mcp",
    "http://127.0.0.1:8890/mcp\n",
  ]) {
    process.env.BROWSER_WORKER_MCP_URL = endpoint;
    await assertDisabled(/loopback|valid/);
  }
  assert.equal(calls, 0);
});

test("missing, empty, malformed tokens disable only the public browser tools", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return json({}); };
  rmSync(tokenFile);
  await assertDisabled(/missing or unreadable/);
  for (const value of ["", " \n", "foo\nbar", "foo bar", "unicode-\u00e9", "header\r\ninjection"]) {
    writeFileSync(tokenFile, value);
    await assertDisabled(/token file/);
  }
  assert.equal(calls, 0);
});

test("unavailable backend and HTTP/auth failures cannot enable tools", async () => {
  globalThis.fetch = async () => { throw new Error(`ECONNREFUSED ${marker}`); };
  await assertDisabled(/tools\/list failed/);
  for (const status of [201, 301, 401, 403, 404, 500]) {
    globalThis.fetch = async (_input, init) => json(listPayload(init), status);
    await assertDisabled(/tools\/list failed/);
  }
  globalThis.fetch = async () => new Response("not JSON");
  await assertDisabled(/tools\/list failed/);
  globalThis.fetch = async () => new Response("x".repeat(1024 * 1024 + 1));
  await assertDisabled(/oversized response/);
});

test("wrong service, malformed inventory, RPC errors and pagination never count as ready", async () => {
  for (const tools of [
    [{ name: "web_search" }, { name: "web_fetch" }],
    [{ name: "browser_fetch" }],
    [{ name: "browser_fetch" }, { name: "browser_inspect" }, { name: "browser_open" }],
    [{ name: "browser_fetch" }, { name: "browser_fetch" }],
    [null, { name: "browser_inspect" }], {},
  ]) {
    globalThis.fetch = async (_input, init) => json({ ...listPayload(init), result: { tools } });
    await assertDisabled(/not the expected browser-worker/);
  }
  for (const mutate of [
    (p: any) => ({ ...p, error: { message: marker } }),
    (p: any) => ({ ...p, id: "wrong" }),
    (p: any) => ({ ...p, jsonrpc: "1.0" }),
    (p: any) => ({ ...p, result: { ...p.result, nextCursor: "more" } }),
    () => null,
  ]) {
    globalThis.fetch = async (_input, init) => json(mutate(listPayload(init)));
    await assertDisabled(/not the expected browser-worker/);
  }
});

test("a slow readiness request times out without registering broken tools", async () => {
  // A live handle keeps Node alive while AbortSignal.timeout's unref'ed timer runs.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
    });
    await assertDisabled(/timeout/);
  } finally {
    clearInterval(keepAlive);
  }
});

test("disabled tools report actionable warnings on stderr in headless sessions", async () => {
  rmSync(tokenFile);
  const h = await assertDisabled(/missing/);
  const originalError = console.error;
  const errors: string[] = [];
  try {
    console.error = (text) => errors.push(text);
    h.handlers.get("session_start")?.({}, { hasUI: false });
  } finally {
    console.error = originalError;
  }
  assert.match(errors[0], /^WARN: Optional public browser tools disabled:/);
});

test("healthy worker enables exactly two tools; probes are read-only and token is reread per call", async () => {
  const requests: Array<{ url: string; auth: string; body: any }> = [];
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") ?? "", body });
    assert.equal(init?.redirect, "error");
    if (body.method === "tools/list") {
      assert.ok(init?.signal);
      return json(listPayload(init));
    }
    return json({ result: { content: [{ type: "text", text: "rendered result" }] } });
  };
  const h = harness();
  await (await importFresh()).default(h.api);
  assert.deepEqual(h.tools.map((tool) => tool.name), ["browser_fetch", "browser_inspect"]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.method, "tools/list");
  assert.deepEqual(requests[0].body.params, {});
  assert.equal(requests[0].auth, `Bearer ${marker}`);
  writeFileSync(tokenFile, "ROTATED_TEST_TOKEN\n");
  const result = await h.tools[0].execute("call", { url: "https://example.com" });
  assert.equal(requests[1].body.method, "tools/call");
  assert.equal(requests[1].url, "http://127.0.0.1:18890/mcp");
  assert.equal(requests[1].auth, "Bearer ROTATED_TEST_TOKEN");
  assert.equal(JSON.stringify(result).includes(marker), false);
  assert.equal(JSON.stringify(result).includes(requests[1].url), false);
  const fetchSchema = h.tools[0].parameters.properties;
  assert.equal(fetchSchema.max_chars.minimum, 1000);
  assert.equal(fetchSchema.max_chars.maximum, 50000);
  assert.deepEqual(fetchSchema.wait_until.enum, ["load", "domcontentloaded", "networkidle", "commit"]);
  const inspectSchema = h.tools[1].parameters.properties;
  assert.deepEqual(inspectSchema.format.enum, ["A4", "Letter"]);
  assert.ok(inspectSchema.action.enum.includes("cleanup_scope"));
  assert.equal("anyOf" in inspectSchema.action, false);
});

test("default endpoint remains 8890 and IPv6 loopback is supported", async () => {
  for (const endpoint of [undefined, "http://[::1]:18890/mcp"]) {
    if (endpoint === undefined) delete process.env.BROWSER_WORKER_MCP_URL;
    else process.env.BROWSER_WORKER_MCP_URL = endpoint;
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), endpoint ?? "http://127.0.0.1:8890/mcp");
      return json(listPayload(init));
    };
    const h = harness();
    await (await importFresh()).default(h.api);
    assert.equal(h.tools.length, 2);
  }
});
