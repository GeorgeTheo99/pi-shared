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

	const opened = await call({ action: "open_tab", url: "/asset" });
	assert.equal(opened.url, `${fixture.baseUrl}/asset`);
	assert.equal((await call({ action: "list_tabs" })).tabs.length, 2);
	await call({ action: "switch_tab", tab_index: 0 });
	await call({ action: "wait", url_contains: "127.0.0.1" });
	await call({ action: "close_tab", tab_index: 1 });
	assert.equal((await call({ action: "list_tabs" })).tabs.length, 1);
	assert.match((await call({ action: "screenshot", label: "inspect" })).path, /inspect.*\.png$/);

	await assert.rejects(call({ action: "switch_tab" }), /action=switch_tab requires tab_index/);
	await assert.rejects(call({ action: "request", method: "GET", url: "https://example.com/" }), /not allowed|allowed hosts/i);
	await assert.rejects(call({ action: "click" }), /action=click requires selector/);
	await assert.rejects(call({ action: "request", method: "GET" }), /action=request requires url/);
	await assert.rejects(call({ action: "open", url: "https://example.com/" }), /not allowed|allowed hosts/i);

	// The host rule covers what the browser does after the first URL: redirects, page
	// scripts and evaluate never reach a host outside the allowlist.
	// A redirect chain that leaves the app ends at the proxy's refusal, not at the other host.
	assert.equal((await call({ action: "open", url: "/escape" })).status, 403);
	await call({ action: "open" });
	await call({ action: "click", selector: "#leak" });
	await call({ action: "wait", selector: "#network-done" });
	const escaped = await call({ action: "evaluate", script: `fetch(${JSON.stringify(fixture.forbidden)}).then(r => r.status, () => "blocked")` });
	assert.notEqual(escaped.result, 200);
	assert.equal(fixture.refusedHits, 0);
	const refused = (await call({ action: "network", url_contains: "localhost" })).entries.filter((entry: any) => entry.kind === "refused");
	assert.ok(refused.length >= 3, JSON.stringify(refused));
});

test("app_inspect fails closed when the base URL yields no allowed host", async () => {
	const saved = Object.fromEntries(["BROWSER_MCP_APP_BASE_URL", "BROWSER_MCP_APP_ALLOWED_HOSTS"].map(name => [name, process.env[name]]));
	const restore = () => { for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value; };
	try {
		delete process.env.BROWSER_MCP_APP_ALLOWED_HOSTS;
		for (const [index, base] of ["127.0.0.1:8100", "localhost:3000", "myapp.test"].entries()) {
			process.env.BROWSER_MCP_APP_BASE_URL = base;
			const { default: extension } = await import(`../extensions/pi-browser-capture/src/app-testing.ts?bad-base=${index}`);
			const tools: any[] = [];
			extension({ registerTool: (tool: any) => tools.push(tool), on: () => undefined } as any);
			for (const params of [{ action: "request", method: "GET", url: "https://example.com/steal" }, { action: "open", url: "https://example.com/" }, { action: "open" }]) {
				await assert.rejects(tools[0].execute("tool-id", params, undefined), /Configure BROWSER_MCP_APP_BASE_URL as a full URL|Invalid URL|Only http and https/);
			}
		}
	} finally {
		restore();
	}
});
