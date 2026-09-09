import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import extension from "../extensions/pi-browser-capture/src/app-test.ts";
import { appFixture } from "./fixtures/app_test_fixture.mts";

test("app_test registers only additive private router, throws evidence-bearing failures and cleans up on session transitions", async t => {
	const fixture = await appFixture();
	const dir = await mkdtemp(join(tmpdir(), "app-test-tool-"));
	const previousBase = process.env.BROWSER_MCP_APP_BASE_URL;
	const previousRoot = process.env.BROWSER_MCP_APP_ARTIFACT_DIR;
	process.env.BROWSER_MCP_APP_BASE_URL = fixture.baseUrl;
	process.env.BROWSER_MCP_APP_ARTIFACT_DIR = dir;
	const tools: any[] = [];
	const events = new Map<string, () => Promise<void>>();
	extension({ registerTool: (tool: any) => tools.push(tool), on: (name: string, handler: any) => events.set(name, handler) } as any);
	t.after(async () => {
		await events.get("session_shutdown")!(); await fixture.close(); await rm(dir, { recursive: true, force: true });
		if (previousBase === undefined) delete process.env.BROWSER_MCP_APP_BASE_URL; else process.env.BROWSER_MCP_APP_BASE_URL = previousBase;
		if (previousRoot === undefined) delete process.env.BROWSER_MCP_APP_ARTIFACT_DIR; else process.env.BROWSER_MCP_APP_ARTIFACT_DIR = previousRoot;
	});
	assert.deepEqual(tools.map(tool => tool.name), ["app_test"]);
	assert.equal(tools[0].parameters.properties.steps.maxItems, 30);
	const call = (params: any, owner = "owner-a") => tools[0].execute("tool-id", params, undefined, undefined, { sessionManager: { getSessionId: () => owner } });
	const id = (await call({ action: "create" })).details.contextId;
	await assert.rejects(call({ action: "close", contextId: id }, "owner-b"), /foreign/);
	await call({ action: "run", contextId: id, steps: [{ action: "goto", value: "/" }] });
	await assert.rejects(call({ action: "run", contextId: id, steps: [{ action: "assert_text", selector: "h1", value: "missing" }, { action: "click", selector: "#save" }] }), error => {
		const report = JSON.parse((error as Error).message);
		assert.equal(report.failedStep, 1); assert.equal(report.skipped, 1);
		assert.equal(report.artifacts.length, 3);
		return true;
	});
	for (const event of ["session_switch", "session_fork", "session_shutdown"]) {
		await events.get(event)!();
		assert.deepEqual(await readdir(join(dir, "app-test")), []);
		await assert.rejects(call({ action: "snapshot", contextId: id }), /Unknown/);
		await call({ action: "create" });
	}
});
