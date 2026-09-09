import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LspClient } from "../extensions/code-intel/client.ts";
import { fromLspPosition, toLspPosition } from "../extensions/code-intel/service.ts";
const fixture = fileURLToPath(new URL("./fixtures/code_intel_server.mjs", import.meta.url));

for (const encoding of ["utf-8", "utf-16", "utf-32"]) test(`Unicode code-point coordinates: ${encoding}`, () => {
  const text = 'const s = "😀é"; value\r\nnext';
  const column = [...text.split("\r")[0]].indexOf("v") + 1;
  const position = toLspPosition(text, 1, column, encoding);
  assert.deepEqual(fromLspPosition(text, position, encoding), { line: 1, column });
  assert.deepEqual(toLspPosition(text, 2, 5, encoding), { line: 1, character: 4 });
  assert.throws(() => toLspPosition(text, 0, 1, encoding), /invalid_position/);
  assert.throws(() => toLspPosition(text, 2, 6, encoding), /invalid_position/);
  if (encoding !== "utf-32") assert.throws(() => fromLspPosition("😀", { line: 0, character: 1 }, encoding), /protocol_error/);
});

test("fragmented multibyte framing, document versions, clean shutdown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "code-intel-client-"));
  const log = join(dir, "events.jsonl");
  const client = new LspClient(process.execPath, [fixture, "fragmented", log], dir);
  try {
    await client.initialize("file:///fixture", {});
    assert.equal((client.serverInfo as any).name, "fake-😀");
    assert.equal(client.sync("file:///fixture/a.ts", "typescript", "😀 old"), 1);
    assert.equal(client.sync("file:///fixture/a.ts", "typescript", "😀 old"), 1);
    assert.equal(client.sync("file:///fixture/a.ts", "typescript", "😀 changed"), 2);
    assert.equal((await client.request("textDocument/hover", {})).contents, "😀 changed");
    assert.equal((await client.close()).serverExited, true);
    assert.deepEqual(await client.close(), await client.close());
    const methods = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line).method);
    assert.equal(methods.filter(method => method === "textDocument/didChange").length, 1);
    assert.ok(methods.includes("textDocument/didClose"));
    assert.deepEqual(methods.slice(-2), ["shutdown", "exit"]);
  } finally { await client.close(); await rm(dir, { recursive: true, force: true }); }
});

for (const [mode, code] of [["crash", "server_exited|transport_closed"], ["oversize", "transport_limit"], ["badheader", "protocol_error"], ["badjson", "protocol_error"], ["badresponse", "protocol_error"], ["headerflood", "protocol_error"]]) {
  test(`fails explicitly: ${mode}`, async () => {
    const client = new LspClient(process.execPath, [fixture, mode], tmpdir());
    try { await assert.rejects(client.initialize("file:///fixture", {}), new RegExp(code)); }
    finally { assert.equal((await client.close()).serverExited, true); }
  });
}

test("missing executable is explicit", async () => {
  const client = new LspClient("/missing-code-intel-server", [], tmpdir());
  try { await assert.rejects(client.initialize("file:///fixture", {}), /missing_executable/); }
  finally { await client.close(); }
});

for (const abort of [false, true]) test(abort ? "abort sends cancellation" : "timeout sends cancellation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "code-intel-cancel-"));
  const log = join(dir, "events.jsonl");
  const client = new LspClient(process.execPath, [fixture, "queryhang", log], dir);
  try {
    await client.initialize("file:///fixture", {});
    const controller = new AbortController();
    const promise = client.request("textDocument/hover", {}, controller.signal, 60);
    if (abort) controller.abort();
    await assert.rejects(promise, new RegExp(abort ? "canceled" : "timeout"));
    await client.close();
    const events = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.ok(events.some(event => event.method === "$/cancelRequest"));
  } finally { await client.close(); await rm(dir, { recursive: true, force: true }); }
});

test("rejects server-initiated writes and unsupported methods", async () => {
  const dir = await mkdtemp(join(tmpdir(), "code-intel-readonly-"));
  const log = join(dir, "events.jsonl");
  const client = new LspClient(process.execPath, [fixture, "editrequest", log], dir);
  try {
    await client.initialize("file:///fixture", {});
    client.sync("file:///fixture/a.ts", "typescript", "value");
    await client.request("textDocument/hover", {});
    await client.close();
    const events = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(events.find(event => event.id === "server-edit").error.code, -32601);
  } finally { await client.close(); await rm(dir, { recursive: true, force: true }); }
  const unsupported = new LspClient(process.execPath, [fixture, "methoderror"], tmpdir());
  try { await unsupported.initialize("file:///fixture", {}); await assert.rejects(unsupported.request("textDocument/hover", {}), /unsupported_method/); }
  finally { await unsupported.close(); }
});

test("stderr flood is drained without retained logs; stubborn shutdown is bounded", async () => {
  const client = new LspClient(process.execPath, [fixture, "stderr"], tmpdir());
  try { await client.initialize("file:///fixture", {}); await client.close(); assert.ok(client.stderrBytes >= 2 * 1024 * 1024); }
  finally { await client.close(); }
  const stubborn = new LspClient(process.execPath, [fixture, "stubborn"], tmpdir());
  await stubborn.initialize("file:///fixture", {});
  const start = Date.now();
  assert.equal((await stubborn.close()).serverExited, true);
  assert.ok(Date.now() - start < 3000);
});
