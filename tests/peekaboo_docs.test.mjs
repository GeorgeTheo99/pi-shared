import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const guide = readFileSync(new URL("../docs/peekaboo.md", import.meta.url), "utf8");
const setup = readFileSync(new URL("../docs/peekaboo-setup.md", import.meta.url), "utf8");
const instructions = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
const example = JSON.parse(setup.match(/```json\n([\s\S]*?)\n```/)[1]);
const server = example.mcpServers.peekaboo;

test("Peekaboo is the direct recommendation, not a discoverable computer-use skill", () => {
  assert.equal(existsSync(new URL("../skills/macos-computer-use", import.meta.url)), false);
  assert.ok(!guide.startsWith("---"));
  assert.match(instructions, /Always use Peekaboo through Pi's existing MCP adapter for native macOS desktop interaction/);
  assert.match(instructions, /docs\/peekaboo\.md/);
  assert.match(guide, /Peekaboo is the opinionated choice/);
  assert.match(guide, /\[setup\]\(peekaboo-setup\.md\)/);
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

test("guidance retains uncertainty, privacy, concurrency and browser-policy boundaries", () => {
  for (const text of ["never blindly replay", "NOT a cross-process lock", "not a sandbox", "Pi transcripts", "CAPTCHA", "not blanket authorization", "requiresImages:true"]) {
    assert.ok(guide.includes(text), `Missing boundary: ${text}`);
  }
  assert.match(setup, /not a substitute for loading newly changed config/);
  assert.match(setup, /Sensitive\/external actions still require user authorization/);
});
