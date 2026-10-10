import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { webSearchSelection } from "../extensions/_shared/mcp-client.ts";

test("webSearchEnabled defaults on, honors false, and fails closed on non-booleans", () => {
	assert.deepEqual(webSearchSelection({}), { enabled: true });
	assert.deepEqual(webSearchSelection({ webSearchEnabled: true }), { enabled: true });
	assert.deepEqual(webSearchSelection({ webSearchEnabled: false }), { enabled: false });
	for (const value of ["false", 0, null]) {
		const selection = webSearchSelection({ webSearchEnabled: value });
		assert.equal(selection.enabled, false);
		assert.match(selection.warning ?? "", /webSearchEnabled .* must be true or false/);
	}
});

const loader = new URL("./fixtures/research_test_loader.mjs", import.meta.url).href;
const extensions = {
	websearch: new URL("../extensions/websearch/index.ts", import.meta.url).href,
	research: new URL("../extensions/deep-research/index.ts", import.meta.url).href,
};

function registered(config: Record<string, unknown> | undefined) {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "pi-search-select-")));
	try {
		if (config) {
			mkdirSync(join(home, ".pi", "research"), { recursive: true, mode: 0o700 });
			writeFileSync(join(home, ".pi", "research", "config.json"), JSON.stringify(config), { mode: 0o600 });
		}
		const script = `
			const tools = [], commands = [], events = [];
			const pi = { registerTool: t => tools.push(t.name), registerCommand: n => commands.push(n), on: e => events.push(e), sendMessage() {}, sendUserMessage() {} };
			for (const href of ${JSON.stringify(Object.values(extensions))}) (await import(href)).default(pi);
			console.log(JSON.stringify({ tools, commands, events }));
		`;
		const env: Record<string, string | undefined> = { ...process.env, HOME: home };
		const result = spawnSync(process.execPath, ["--no-warnings", "--experimental-loader", loader, "--input-type=module", "-e", script], { env, encoding: "utf8", timeout: 20_000 });
		assert.equal(result.status, 0, result.stderr);
		return JSON.parse(result.stdout.trim().split("\n").at(-1)!) as { tools: string[]; commands: string[]; events: string[] };
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

test("search extensions register by default and step aside when webSearchEnabled is false", () => {
	for (const config of [undefined, {}, { webSearchEnabled: true }]) {
		const result = registered(config);
		assert.deepEqual(result.tools.sort(), ["deep_research", "web_fetch", "web_search"]);
		assert.deepEqual(result.commands, ["research"]);
		assert.deepEqual(result.events, []);
	}
	const off = registered({ webSearchEnabled: false, websearchMcpUrl: "http://127.0.0.1:9/mcp" });
	assert.deepEqual(off, { tools: [], commands: [], events: [] });
	const invalid = registered({ webSearchEnabled: "no" });
	assert.deepEqual(invalid.tools, []);
	assert.deepEqual(invalid.events, ["session_start", "session_start"]);
});
