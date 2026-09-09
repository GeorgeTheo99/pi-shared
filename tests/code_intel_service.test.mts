import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodeIntelService } from "../extensions/code-intel/service.ts";
const fixture = fileURLToPath(new URL("./fixtures/code_intel_server.mjs", import.meta.url));
const server = fileURLToPath(new URL("../extensions/code-intel/node_modules/typescript-language-server/lib/cli.mjs", import.meta.url));
const tsserver = fileURLToPath(new URL("../extensions/code-intel/node_modules/typescript/lib/tsserver.js", import.meta.url));
async function workspace(mode = "normal", real = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "code-intel-service-")));
  await mkdir(join(root, ".pi"));
  await writeFile(join(root, ".pi/code-intel.json"), JSON.stringify({ version: 1, adapter: "typescript-language-server", workspace: ".", executable: process.execPath,
    args: real ? [server, "--stdio"] : [fixture, mode, join(root, "events.jsonl")], timeoutMs: 10000, ...(real ? { tsserverPath: tsserver } : {}) }));
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "commonjs" }, include: ["*.ts"] }));
  await writeFile(join(root, "a.ts"), 'export const shared: number = 1;\n');
  await writeFile(join(root, "b.ts"), 'import { shared } from "./a";\nconst emoji = "😀é"; console.log(shared);\nfunction other() { const shared = "local"; return shared; }\n');
  return root;
}
const remove = (root: string) => rm(root, { recursive: true, force: true });

test("trust gate and status never execute server", async () => {
  const root = await workspace(); const service = new CodeIntelService();
  try {
    await assert.rejects(service.run(root, false, { action: "status" }), /untrusted_project/);
    const status: any = await service.run(root, true, { action: "status" });
    assert.equal(status.execution, "not_started"); assert.equal(status.freshness, "not_checked");
    await assert.rejects(access(join(root, "events.jsonl")));
    await writeFile(join(root, ".pi/code-intel.json"), "{}");
    await assert.rejects(service.run(root, true, { action: "status" }), /invalid_config/);
  } finally { await service.close(); await remove(root); }
});

test("missing config/server, invalid coordinates, scope and unsupported diagnostics fail explicitly", async () => {
  const root = await workspace(); const service = new CodeIntelService();
  try {
    await assert.rejects(service.run(root, true, { action: "hover", path: "a.ts", line: 1, column: 999 }), /invalid_position/);
    await assert.rejects(access(join(root, "events.jsonl")));
    await assert.rejects(service.run(root, true, { action: "hover", path: "../escape.ts", line: 1, column: 1 }));
    await assert.rejects(service.run(root, true, { action: "diagnostics", path: "a.ts" }), /unsupported_method/);
    const config = JSON.parse(await readFile(join(root, ".pi/code-intel.json"), "utf8"));
    config.executable = "/missing-code-intel";
    await writeFile(join(root, ".pi/code-intel.json"), JSON.stringify(config));
    await assert.rejects(service.run(root, true, { action: "status" }), /missing_executable/);
    await rm(join(root, ".pi/code-intel.json"));
    await assert.rejects(service.run(root, true, { action: "status" }), /not_configured/);
  } finally { await service.close(); await remove(root); }
});

test("edit then query reopens current document with a new server identity", async () => {
  const root = await workspace(); const service = new CodeIntelService();
  try {
    const before: any = await service.run(root, true, { action: "hover", path: "a.ts", line: 1, column: 14 });
    await writeFile(join(root, "a.ts"), 'export const changed = "😀";\n');
    const after: any = await service.run(root, true, { action: "hover", path: "a.ts", line: 1, column: 14 });
    assert.notEqual(before.document.digest, after.document.digest);
    assert.notEqual(before.server.instanceId, after.server.instanceId);
    assert.equal(after.document.version, 1);
    assert.match(after.result.contents, /changed/);
    assert.equal(after.sourceIdentity.status, "matched_before_after");
  } finally { await service.close(); await remove(root); }
});

test("source changed during request is discarded; concurrent requests fail busy", async () => {
  const root = await workspace("delay"); const service = new CodeIntelService();
  try {
    const promise = service.run(root, true, { action: "hover", path: "a.ts", line: 1, column: 14 });
    await assert.rejects(service.run(root, true, { action: "status" }), /busy/);
    // Wait for the fixture's query receipt, rather than racing process startup.
    const deadline = Date.now() + 5000;
    while (true) {
      const log = await readFile(join(root, "events.jsonl"), "utf8").catch(() => "");
      if (log.includes('"method":"textDocument/hover"')) break;
      if (Date.now() > deadline) throw new Error("No query received");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await writeFile(join(root, "b.ts"), "export const mutation = 1;\n");
    await assert.rejects(promise, /stale_source/);
  } finally { await service.close(); await remove(root); }
});

test("workspace symlinks and oversized input fail before execution", async () => {
  const root = await workspace(); const service = new CodeIntelService();
  try {
    await symlink(join(root, "a.ts"), join(root, "alias.ts"));
    await assert.rejects(service.run(root, true, { action: "hover", path: "a.ts", line: 1, column: 14 }), /unsupported_symlink/);
    await rm(join(root, "alias.ts"));
    await writeFile(join(root, "huge.ts"), "x".repeat(1024 * 1024 + 1));
    await assert.rejects(service.run(root, true, { action: "hover", path: "a.ts", line: 1, column: 14 }), /source_limit/);
    await assert.rejects(access(join(root, "events.jsonl")));
  } finally { await service.close(); await remove(root); }
});

test("malformed diagnostics cannot become a clean verdict from a green push", async () => {
  const root = await workspace("malformed-diagnostics"); const service = new CodeIntelService();
  try { await assert.rejects(service.run(root, true, { action: "diagnostics", path: "a.ts" }), /incomplete_diagnostics/); }
  finally { await service.close(); await remove(root); }
});

for (const shutdown of [false, true]) test(shutdown ? "session shutdown cancels the active query" : "overall configured deadline terminates an unresponsive server", async () => {
  const root = await workspace("queryhang"); const service = new CodeIntelService();
  try {
    const configPath = join(root, ".pi/code-intel.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.timeoutMs = 1000;
    await writeFile(configPath, JSON.stringify(config));
    const started = Date.now();
    const promise = service.run(root, true, { action: "hover", path: "a.ts", line: 1, column: 14 });
    const outcome = assert.rejects(promise, new RegExp(shutdown ? "canceled" : "timeout"));
    if (shutdown) {
      const deadline = Date.now() + 5000;
      while (true) {
        const log = await readFile(join(root, "events.jsonl"), "utf8").catch(() => "");
        if (log.includes('"method":"textDocument/hover"')) break;
        if (Date.now() > deadline) throw new Error("No query received");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await service.close();
    }
    await outcome;
    assert.ok(Date.now() - started < 4000);
    // Ownership is released after cleanup; a follow-up call is possible.
    assert.equal((await service.run(root, true, { action: "status" })).status, "configured");
  } finally { await service.close(); await remove(root); }
});

let realAvailable = true;
try { await access(server); await access(tsserver); } catch { realAvailable = false; }
test("real TLS: cross-file definitions/references, unrelated scopes, Unicode, diagnostics, dependency edit freshness", { skip: !realAvailable && "Install optional extensions/code-intel dependencies to run real smoke", timeout: 60000 }, async () => {
  const root = await workspace("normal", true); const service = new CodeIntelService();
  try {
    const text = await readFile(join(root, "b.ts"), "utf8");
    const column = [...text.split("\n")[1].split("shared")[0]].length + 1;
    const definition: any = await service.run(root, true, { action: "definition", path: "b.ts", line: 2, column });
    assert.equal(definition.result.length, 1);
    assert.equal(definition.result[0].path, join(root, "a.ts"));
    assert.equal(definition.result[0].range.start.column, 14);
    assert.equal(definition.cleanup.serverExited, true);
    const refs: any = await service.run(root, true, { action: "references", path: "b.ts", line: 2, column });
    assert.ok(refs.result.some((item: any) => item.path.endsWith("a.ts")));
    assert.ok(refs.result.some((item: any) => item.path.endsWith("b.ts") && item.range.start.line === 2 && item.range.start.column === column));
    assert.ok(!refs.result.some((item: any) => item.path.endsWith("b.ts") && item.range.start.line === 3));
    const hover: any = await service.run(root, true, { action: "hover", path: "b.ts", line: 2, column });
    assert.match(JSON.stringify(hover.result), /number/);
    const clean: any = await service.run(root, true, { action: "diagnostics", path: "a.ts" });
    assert.deepEqual(clean.result.items, []);
    await writeFile(join(root, "a.ts"), 'export const shared: string = "updated";\n');
    const edited: any = await service.run(root, true, { action: "hover", path: "b.ts", line: 2, column });
    assert.match(JSON.stringify(edited.result), /string/);
    assert.notEqual(edited.sourceIdentity.digest, hover.sourceIdentity.digest);
    await writeFile(join(root, "a.ts"), 'export const shared: number = "bad";\n');
    const errors: any = await service.run(root, true, { action: "diagnostics", path: "a.ts" });
    assert.ok(errors.result.items.some((item: any) => item.code === 2322));
    await writeFile(join(root, "a.ts"), 'export const shared: number = 2;\n');
    const fixed: any = await service.run(root, true, { action: "diagnostics", path: "a.ts" });
    assert.deepEqual(fixed.result.items, []);
    assert.notEqual(fixed.document.digest, errors.document.digest);
  } finally { await service.close(); await remove(root); }
});
