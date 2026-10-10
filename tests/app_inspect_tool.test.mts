import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { appFixture } from "./fixtures/app_test_fixture.mts";

test("app_inspect is the single persistent app tool and dispatches actions against the allowed app", async t => {
	const fixture = await appFixture();
	const dir = await mkdtemp(join(tmpdir(), "app-inspect-"));
	const saved = Object.fromEntries(["BROWSER_MCP_APP_BASE_URL", "BROWSER_MCP_STORAGE_ROOT"].map(name => [name, process.env[name]]));
	process.env.BROWSER_MCP_APP_BASE_URL = fixture.baseUrl;
	process.env.BROWSER_MCP_STORAGE_ROOT = dir;
	const { default: extension } = await import("../extensions/pi-browser-capture/src/app-testing.ts");
	const tools: any[] = [];
	const events = new Map<string, () => Promise<void>>();
	extension({ registerTool: (tool: any) => tools.push(tool), on: (name: string, handler: any) => events.set(name, handler) } as any);
	t.after(async () => {
		await events.get("session_shutdown")!();
		await fixture.close();
		await rm(dir, { recursive: true, force: true });
		for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
	});

	assert.deepEqual(tools.map(tool => tool.name), ["app_inspect"]);
	const schema = tools[0].parameters.properties;
	assert.deepEqual(schema.action.enum, [
		"open", "open_tab", "list_tabs", "switch_tab", "close_tab", "click", "type", "wait",
		"extract_text", "evaluate", "screenshot", "console", "network", "request", "state",
	]);
	assert.equal("anyOf" in schema.action, false);

	const call = async (params: any) => (await tools[0].execute("tool-id", params, undefined)).details;
	await call({ action: "open" });
	await call({ action: "wait", selector: "h1" });
	assert.match((await call({ action: "extract_text", selector: "h1" })).text, /Fixture app/);
	await call({ action: "type", selector: "#name", text: "Ada" });
	await call({ action: "click", selector: "#save" });
	assert.equal(await call({ action: "evaluate", script: "document.querySelector('#name').value" }).then(r => r.result), "Ada");
	// Patchright suppresses page console events for stealth; only the dispatch shape is asserted.
	assert.ok(Array.isArray((await call({ action: "console" })).logs));
	assert.ok((await call({ action: "network", url_contains: "/asset" })).entries.length > 0);
	assert.equal((await call({ action: "request", method: "GET", url: "/asset" })).body, "asset");
	assert.equal((await call({ action: "state" })).active_page.url, `${fixture.baseUrl}/`);

	await assert.rejects(call({ action: "click" }), /action=click requires selector/);
	await assert.rejects(call({ action: "request", method: "GET" }), /action=request requires url/);
	await assert.rejects(call({ action: "open", url: "https://example.com/" }), /not allowed|allowed hosts/i);
});
