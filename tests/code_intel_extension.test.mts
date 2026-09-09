import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
register("./fixtures/code_intel_loader.mjs", import.meta.url);
const { default: extension } = await import("../extensions/code-intel/index.ts");

test("tool registration is read-only, inert, and fails closed without Pi project trust", async () => {
  let tool: any;
  const handlers = new Map<string, (...args: any[]) => any>();
  extension({ registerTool(value: any) { tool = value; }, on(name: string, handler: any) { handlers.set(name, handler); } } as any);
  assert.equal(tool.name, "code_intel");
  assert.deepEqual(tool.parameters.properties.action.enum, ["status", "definition", "references", "hover", "diagnostics"]);
  assert.deepEqual([...handlers.keys()], ["session_shutdown"]);
  for (const trust of [undefined, () => false]) {
    await assert.rejects(tool.execute("id", { action: "status" }, undefined, undefined, { cwd: "/missing", isProjectTrusted: trust }), /untrusted_project/);
  }
  await handlers.get("session_shutdown")!();
  await handlers.get("session_shutdown")!();
});
