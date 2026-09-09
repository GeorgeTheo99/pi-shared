import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = join(root, "extensions", "pi-browser-capture");
const packageJson = JSON.parse(readFileSync(join(extensionRoot, "package.json"), "utf8"));
const loadedEntrypoints = packageJson.pi.extensions as string[];

function registeredNames(relativePath: string): string[] {
  const source = readFileSync(join(extensionRoot, relativePath), "utf8");
  return [...source.matchAll(/name:\s*"((?:browser|app)_[a-z_]+)"/g)].map((match) => match[1]);
}

const legacyPublicNames = new Set([
  "browser_open",
  "browser_navigate",
  "browser_open_tab",
  "browser_list_tabs",
  "browser_switch_tab",
  "browser_close_tab",
  "browser_click",
  "browser_type",
  "browser_wait_for",
  "browser_extract_text",
  "browser_evaluate",
  "browser_screenshot",
  "browser_export_pdf",
  "browser_console_logs",
  "browser_page_state",
  "browser_close",
]);
const workerNames = new Set(["browser_fetch", "browser_inspect"]);
const expectedAppNames = [
  "app_api_request",
  "app_click",
  "app_close_tab",
  "app_console_logs",
  "app_evaluate",
  "app_extract_text",
  "app_list_tabs",
  "app_network_log",
  "app_open",
  "app_open_tab",
  "app_page_state",
  "app_screenshot",
  "app_switch_tab",
  "app_type_text",
  "app_wait_for",
].sort();

test("public browser cutover loads only browser_fetch and browser_inspect", () => {
  assert.deepEqual(loadedEntrypoints, ["./src/browser-worker.ts", "./src/app-testing.ts", "./src/app-test.ts"]);
  const loadedNames = new Set(loadedEntrypoints.flatMap(registeredNames));
  assert.deepEqual(
    [...loadedNames].filter((name) => name.startsWith("browser_")).sort(),
    [...workerNames].sort(),
  );
  assert.equal([...legacyPublicNames].some((name) => loadedNames.has(name)), false);
});

test("legacy and worker public browser families can never be loaded together", () => {
  const loadedNames = new Set(loadedEntrypoints.flatMap(registeredNames));
  const hasLegacy = [...legacyPublicNames].some((name) => loadedNames.has(name));
  const hasWorker = [...workerNames].some((name) => loadedNames.has(name));
  assert.equal(hasLegacy && hasWorker, false);
});

test("app testing inventory remains unchanged and separately loaded", () => {
  assert.ok(loadedEntrypoints.includes("./src/app-testing.ts"));
  assert.deepEqual(registeredNames("./src/app-testing.ts").sort(), expectedAppNames);
  assert.deepEqual(registeredNames("./src/app-test.ts"), ["app_test"]);
});
