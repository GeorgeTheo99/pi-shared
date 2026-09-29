import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;
const extensions = join(root, "extensions");

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules") return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|mts|js|mjs)$/.test(entry.name) ? [path] : [];
  });
}

test("extensions import shared code only from extensions/_shared, which imports no extension", () => {
  const violations = [];
  for (const file of sourceFiles(extensions)) {
    const owner = relative(extensions, file).split("/")[0];
    const source = readFileSync(file, "utf8");
    for (const [, specifier] of source.matchAll(/(?:from|import\(?)\s*["']((?:\.\.\/)+[^"']+)["']/g)) {
      const target = relative(extensions, join(file, "..", specifier)).split("/")[0];
      if (target === owner || target.startsWith("..")) continue;
      if (target !== "_shared" || owner === "_shared") violations.push(`${relative(root, file)} -> ${specifier}`);
    }
  }
  assert.deepEqual(violations, []);
});
