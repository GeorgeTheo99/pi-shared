// Explicit offline smoke: node tests/fixtures/mcp_inventory_sdk_smoke.mjs /path/to/pi/dist/bundle/index.js
// Loads only the doctor and search wrappers, not real MCP servers or user profiles.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sdkPath = process.argv[2];
if (!sdkPath) throw new Error("Pass the installed Pi SDK path explicitly");
const sdk = await import(pathToFileURL(path.resolve(sdkPath)).href);
const root = fileURLToPath(new URL("../../", import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-inventory-sdk-"));
let session;
const fetch = globalThis.fetch;
let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error("Network forbidden in fixture"); };
try {
  const settingsManager = sdk.SettingsManager.inMemory({ extensions: [
    path.join(root, "extensions/dev-doctor/index.ts"), path.join(root, "extensions/websearch/index.ts"),
  ] });
  let pi;
  const loader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [api => { pi = api; }],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const runtime = await sdk.ModelRuntime.create({ authPath: path.join(dir, "auth.json"),
    modelsPath: path.join(dir, "models.json"), modelsStorePath: path.join(dir, "models-store.json"), allowModelNetwork: false });
  const model = runtime.getModel("openai", "gpt-4o");
  assert(model);
  ({ session } = await sdk.createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model,
    resourceLoader: loader, settingsManager, sessionManager: sdk.SessionManager.inMemory(dir) }));
  const errors = [];
  await session.bindExtensions({ onError: error => errors.push(error) });
  pi.events.emit("pi-mcp-adapter/status/v1", { version: 1,
    servers: [{ name: "fixture-cad", status: "cached", toolCount: 6 }] });
  assert.equal(loaded.extensions.flatMap(extension => [...extension.commands.values()]).length, 0);
  const doctor = loaded.extensions.flatMap(extension => [...extension.tools.values()])
    .find(tool => tool.definition.name === "dev_doctor")?.definition;
  assert(doctor);
  const result = await doctor.execute("smoke", { agentDir: dir }, new AbortController().signal);
  const text = result.content[0].text;
  assert.match(text, /fixture-cad: cached, 6 tools/);
  assert.match(text, /local-search: web_search, web_fetch; 2 active; service not probed/);
  assert.match(text, /browser-worker: no tools registered/);
  assert.deepEqual(errors, []);
  assert.equal(networkAttempts, 0);
  console.log("PASS: real SDK registration/provenance + adapter event + dev_doctor inventory; zero network or model calls");
} finally {
  session?.dispose();
  globalThis.fetch = fetch;
  fs.rmSync(dir, { recursive: true, force: true });
}
