import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const links = [...readme.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)].map(match => match[1]);
const localLinks = links.filter(link => !/^[a-z][a-z0-9+.-]*:/i.test(link));
const localPaths = localLinks.map(link => decodeURIComponent(link.split("#")[0])).filter(Boolean);
const documented = path => localPaths.some(link => link === path || link.startsWith(`${path}/`));

// These checks prevent missing entry points and broken local links, not false prose.
// Behavioral claims still require source review and the feature's own tests.
test("README local documentation links and heading anchors resolve", () => {
  for (const link of localLinks) {
    const [path, fragment] = link.split("#").map(decodeURIComponent);
    const target = join(root, path || "README.md");
    assert.ok(existsSync(target), `Broken README link: ${link}`);
    if (!fragment) continue;
    assert.ok(target.endsWith(".md"), `Expected a Markdown heading target: ${link}`);
    const headings = [...readFileSync(target, "utf8").matchAll(/^#{1,6}\s+(.+)$/gm)];
    const anchors = new Set();
    for (const [, heading] of headings) {
      const base = heading.toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, "").replace(/ /g, "-");
      let slug = base;
      for (let suffix = 1; anchors.has(slug); suffix++) slug = `${base}-${suffix}`;
      anchors.add(slug);
    }
    assert.ok(anchors.has(fragment), `Broken README heading anchor: ${link}`);
  }
});

test("README links every shipped extension entry point", () => {
  for (const entry of readdirSync(join(root, "extensions"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = `extensions/${entry.name}`;
    const manifestPath = join(root, path, "package.json");
    const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
    const isExtension = existsSync(join(root, path, "index.ts")) || existsSync(join(root, path, "index.js")) || manifest.pi?.extensions?.length;
    if (isExtension) assert.ok(documented(path), `Missing README feature entry: ${path}`);
  }
});

test("README names every bundled agent role", () => {
  for (const name of readdirSync(join(root, "extensions/spawn-subagent/agents"))) {
    if (name.endsWith(".md")) {
      assert.ok(readme.includes(`\`${name.slice(0, -3)}\``), `Missing README agent role: ${name}`);
    }
  }
});

test("README links every bundled skill and saved workflow", () => {
  for (const entry of readdirSync(join(root, "skills"), { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(join(root, "skills", entry.name, "SKILL.md"))) {
      assert.ok(documented(`skills/${entry.name}`), `Missing README skill: ${entry.name}`);
    }
  }
  for (const name of readdirSync(join(root, "workflows"))) {
    if (name.endsWith(".js")) assert.ok(documented(`workflows/${name}`), `Missing README workflow: ${name}`);
  }
});
