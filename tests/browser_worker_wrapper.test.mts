import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const moduleUrl = new URL("../extensions/pi-browser-capture/src/browser-worker.ts", import.meta.url);
const originalEndpoint = process.env.BROWSER_WORKER_MCP_URL;
const originalTokenFile = process.env.BROWSER_WORKER_MCP_TOKEN_FILE;
const originalFetch = globalThis.fetch;

function restoreEnvironment() {
  if (originalEndpoint === undefined) delete process.env.BROWSER_WORKER_MCP_URL;
  else process.env.BROWSER_WORKER_MCP_URL = originalEndpoint;
  if (originalTokenFile === undefined) delete process.env.BROWSER_WORKER_MCP_TOKEN_FILE;
  else process.env.BROWSER_WORKER_MCP_TOKEN_FILE = originalTokenFile;
  globalThis.fetch = originalFetch;
}

async function importFresh(label: string) {
  return import(`${moduleUrl.href}?case=${encodeURIComponent(label)}-${Date.now()}-${Math.random()}`);
}

test.afterEach(restoreEnvironment);

test("wrapper rejects non-loopback, credentialed, and query-bearing MCP endpoints", async () => {
  for (const [label, endpoint] of [
    ["remote-http", "http://example.com:8890/mcp"],
    ["remote-https", "https://example.com:8890/mcp"],
    ["credentials", "http://user:secret@127.0.0.1:8890/mcp"],
    ["query", "http://127.0.0.1:8890/mcp?access_token=sensitive"],
    ["wrong-path", "http://127.0.0.1:8890/other"],
  ]) {
    process.env.BROWSER_WORKER_MCP_URL = endpoint;
    await assert.rejects(importFresh(label), /loopback|uncredentialed/);
  }
});

test("wrapper sends the token only to loopback and omits endpoint and token from results", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-browser-wrapper-"));
  const tokenFile = join(root, "token");
  const marker = "SENSITIVE_TEST_MARKER";
  writeFileSync(tokenFile, `${marker}\n`, { mode: 0o600 });
  process.env.BROWSER_WORKER_MCP_URL = "http://127.0.0.1:8890/mcp";
  process.env.BROWSER_WORKER_MCP_TOKEN_FILE = tokenFile;

  let requestUrl = "";
  let authorization = "";
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "test",
        result: { content: [{ type: "text", text: "rendered result" }], isError: false },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const module = await importFresh("success");
    const tools: Array<{ name: string; parameters: any; execute: Function }> = [];
    module.default({ registerTool: (tool: any) => tools.push(tool) });
    assert.deepEqual(tools.map((tool) => tool.name), ["browser_fetch", "browser_inspect"]);

    const result = await tools[0].execute("call", { url: "https://example.com" });
    assert.equal(requestUrl, "http://127.0.0.1:8890/mcp");
    assert.equal(authorization, `Bearer ${marker}`);
    assert.equal(JSON.stringify(result).includes(marker), false);
    assert.equal(JSON.stringify(result).includes(requestUrl), false);

    const fetchSchema = tools[0].parameters.properties;
    assert.equal(fetchSchema.max_chars.minimum, 1000);
    assert.equal(fetchSchema.max_chars.maximum, 50000);
    const inspectSchema = tools[1].parameters.properties;
    assert.deepEqual(fetchSchema.wait_until.enum, ["load", "domcontentloaded", "networkidle", "commit"]);
    assert.deepEqual(inspectSchema.format.enum, ["A4", "Letter"]);
    assert.ok(inspectSchema.action.enum.includes("cleanup_scope"));
    assert.equal("anyOf" in inspectSchema.action, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
