import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const skill = readFileSync(new URL("../skills/macos-computer-use/SKILL.md", import.meta.url), "utf8");
const setup = readFileSync(new URL("../skills/macos-computer-use/references/setup.md", import.meta.url), "utf8");
const example = JSON.parse(setup.match(/```json\n([\s\S]*?)\n```/)[1]);
const server = example.mcpServers.peekaboo;

test("Mac skill has discoverable metadata and an existing setup reference", () => {
  assert.match(skill, /^---\nname: macos-computer-use\ndescription: .+\ncompatibility: .+\n---/);
  assert.ok(skill.match(/^description: (.+)$/m)[1].length <= 1024);
  assert.match(skill, /references\/setup\.md/);
});

test("MCP example uses a pinned local command and direct foreground-capable stdio", () => {
  assert.equal(server.command, "/absolute/path/to/pinned/peekaboo");
  assert.equal(server.args[0], "mcp");
  assert.ok(server.args.includes("--no-remote"));
  assert.ok(!server.args.includes("--bridge-socket"));
  assert.ok(server.args.includes("--allow-foreground"));
  assert.equal(server.lifecycle, "lazy-keep-alive");
  assert.equal(server.requestTimeoutMs, 30000);
  assert.equal(server.directTools, false);
  assert.equal(server.url, undefined);
});

test("full catalog is exposed without extra tool filtering or approval policy", () => {
  assert.equal(server.includeTools, undefined);
  assert.equal(server.excludeTools, undefined);
  assert.equal(server.approveTools, undefined);
  assert.match(setup, /full advertised Peekaboo catalog/);
  assert.match(setup, /Existing global adapter policies still apply/);
});

test("skill retains uncertainty, privacy, concurrency and browser-policy boundaries", () => {
  for (const text of ["never blindly replay", "NOT a cross-process lock", "not a sandbox", "Pi transcripts", "CAPTCHA", "not blanket authorization", "requiresImages:true"]) {
    assert.ok(skill.includes(text), `Missing boundary: ${text}`);
  }
  assert.match(setup, /not a substitute for loading newly changed config/);
  assert.match(setup, /Sensitive\/external actions still require user authorization/);
});
