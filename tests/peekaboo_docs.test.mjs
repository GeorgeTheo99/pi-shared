import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const guide = readFileSync(new URL("../docs/peekaboo.md", import.meta.url), "utf8");
const setup = readFileSync(new URL("../docs/peekaboo-setup.md", import.meta.url), "utf8");
const instructions = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
const servers = [...setup.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]).mcpServers.peekaboo);
const server = servers.find(entry => entry.args.includes('--no-remote'));
const bridge = servers.find(entry => entry.args.includes('--bridge-socket'));

test("Peekaboo is the direct recommendation, not a discoverable computer-use skill", () => {
  assert.equal(existsSync(new URL("../skills/macos-computer-use", import.meta.url)), false);
  assert.ok(!guide.startsWith("---"));
  assert.match(instructions, /Always use Peekaboo through Pi's official MCP integration for native macOS desktop interaction/);
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
  assert.equal(server.timeout, 30);
  assert.equal(server.exposure, "codemode");
  assert.equal(server.lifecycle, undefined);
  assert.equal(server.directTools, undefined);
  assert.equal(server.url, undefined);
});

test("desktop Bridge example disables only browser and never falls back to direct", () => {
  assert.equal(bridge.command, '/absolute/path/to/pinned/peekaboo');
  assert.deepEqual(bridge.args, ['mcp', '--bridge-socket', '/absolute/path/to/Peekaboo/bridge.sock', '--allow-foreground']);
  assert.deepEqual(bridge.env, { PEEKABOO_DISABLE_TOOLS: 'browser' });
  assert.equal(bridge.timeout, 30);
  assert.equal(bridge.exposure, 'codemode');
  assert.equal(bridge.lifecycle, undefined);
  assert.equal(bridge.url, undefined);
  assert.match(setup, /Peekaboo schema v2/);
  assert.match(setup, /25 advertised tools without `browser`/);
  assert.match(setup, /unavailable explicit host must be reported/);
});

test("native examples do not invent filters or silently transfer adapter approvals", () => {
  assert.equal(servers.length, 2);
  for (const entry of servers) {
    assert.equal(entry.includeTools, undefined);
    assert.equal(entry.excludeTools, undefined);
    assert.equal(entry.approveTools, undefined);
  }
  assert.equal(server.env, undefined);
  assert.match(setup, /full advertised Peekaboo catalog/);
  assert.match(setup, /Existing adapter approval policies do not automatically transfer/);
  assert.match(setup, /does not reproduce the adapter's lazy-start\/idle-timeout policy/);
});

test("guidance retains uncertainty, privacy, concurrency and browser-policy boundaries", () => {
  for (const text of ["never blindly replay", "NOT a cross-process lock", "not a sandbox", "Pi transcripts", "CAPTCHA", "not blanket authorization", "requiresImages:true"]) {
    assert.ok(guide.includes(text), `Missing boundary: ${text}`);
  }
  assert.match(setup, /not a substitute for loading newly changed config/);
  assert.match(setup, /Sensitive\/external actions still require user authorization/);
});
