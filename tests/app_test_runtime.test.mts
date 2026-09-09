import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { AppTestRuntime, LIMITS, type AppTestInput, type Step } from "../extensions/pi-browser-capture/src/app-test-runtime.ts";
import { appTargetPolicy, startAppProxy } from "../extensions/pi-browser-capture/src/app-test-policy.ts";
import { appFixture } from "./fixtures/app_test_fixture.mts";
import { chromium as persistentChromium } from "../extensions/pi-browser-capture/node_modules/patchright/index.mjs";
import { execFileSync } from "node:child_process";
import net from "node:net";

async function setup(t: any) {
	const dir = await mkdtemp(join(tmpdir(), "app-test-integration-"));
	const fixture = await appFixture();
	const runtime = new AppTestRuntime({ BROWSER_MCP_APP_BASE_URL: fixture.baseUrl, BROWSER_MCP_APP_ARTIFACT_DIR: dir });
	t.after(async () => { await runtime.dispose(); await fixture.close(); await rm(dir, { recursive: true, force: true }); });
	const call = (input: AppTestInput, owner = "session-a", signal?: AbortSignal) => runtime.execute(owner, input, signal);
	const run = (contextId: string, steps: Step[]) => call({ action: "run", contextId, steps });
	return { dir, fixture, runtime, call, run };
}

test("target policy rejects credentials, non-HTTP URLs and wildcard lookalikes", () => {
	const policy = appTargetPolicy("http://127.0.0.1:8100", "*.dev.internal");
	assert.equal(policy.resolve("/hello"), "http://127.0.0.1:8100/hello");
	assert.equal(policy.check("https://a.dev.internal/").hostname, "a.dev.internal");
	for (const url of ["http://dev.internal", "http://evildev.internal", "http://a.dev.internal.evil", "file:///etc/passwd", "data:text/html,hello", "http://user:pass@127.0.0.1", "http://localhost", "//localhost/path"]) {
		assert.throws(() => policy.resolve(url));
	}
});

test("proxy refuses CONNECT before opening a target and forwards allowed tunnels", async t => {
	const fixture = await appFixture();
	const refused: string[] = [];
	const proxy = await startAppProxy(appTargetPolicy(fixture.baseUrl), url => refused.push(url));
	t.after(async () => { await proxy.close(); await fixture.close(); });
	const target = new URL(fixture.baseUrl);
	for (const allowed of [false, true]) {
		const response = await new Promise<string>((resolve, reject) => {
			const socket = net.connect(Number(new URL(proxy.url).port), "127.0.0.1");
			socket.on("error", reject);
			socket.on("connect", () => socket.write(`CONNECT ${allowed ? target.host : "localhost:1"} HTTP/1.1\r\nHost: fixture\r\n\r\n`));
			let received = "";
			let requested = false;
			socket.on("data", data => {
				received += data.toString();
				if (!allowed) { resolve(received); socket.destroy(); }
				else if (!requested && received.includes("200 Connection Established")) {
					requested = true;
					socket.write(`GET / HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\n\r\n`);
				}
			});
			socket.on("end", () => resolve(received));
		});
		assert.match(response, allowed ? /Fixture app/ : /403 Forbidden/);
	}
	assert.equal(refused.length, 1);
});

test("real desktop/mobile contexts isolate storage, ownership, artifacts and cleanup", { timeout: 90_000 }, async t => {
	const { dir, fixture, call, run } = await setup(t);
	const desktop = await call({ action: "create" });
	const id = desktop.contextId as string;
	assert.equal(desktop.device, "desktop");
	assert.equal((await run(id, [{ action: "goto", value: "/seed" }, { action: "assert_text", selector: "#storage", value: "secret" }, { action: "assert_text", selector: "#mobile", value: "false" }])).ok, true);
	await assert.rejects(call({ action: "snapshot", contextId: id }, "session-b"), /foreign/);
	const mobile = await call({ action: "create", device: "mobile" });
	const mobileId = mobile.contextId as string;
	assert.equal((await run(mobileId, [
		{ action: "goto", value: "/" }, { action: "assert_text", selector: "#storage", value: "empty" },
		{ action: "assert_text", selector: "#cookie", value: "empty" }, { action: "assert_text", selector: "#mobile", value: "true" },
		{ action: "assert_text", selector: "#width", value: "390" },
	])).ok, true);
	await call({ action: "configure", contextId: mobileId, width: 430, height: 900 });
	assert.equal((await run(mobileId, [{ action: "goto", value: "/" }, { action: "assert_text", selector: "#width", value: "430" }])).ok, true);
	await assert.rejects(call({ action: "configure", contextId: mobileId, device: "desktop" }), /fixed at create/);
	const snapshot = await call({ action: "snapshot", contextId: mobileId });
	assert.match(snapshot.snapshot as string, /heading "Fixture app"/);
	assert.match(snapshot.snapshot as string, /textbox "Name"/);
	assert.equal((await run(id, [{ action: "goto", value: "/redirect" }, { action: "assert_url", value: "/" }])).ok, true);
	const failure = await run(id, [{ action: "fill", selector: "#name", value: "Ada" }, { action: "click", selector: "#save" },
		{ action: "assert_text", selector: "#count", value: "2" }, { action: "click", selector: "#save" }]);
	assert.equal(failure.ok, false); assert.equal(failure.failedStep, 3); assert.equal(failure.skipped, 1);
	assert.equal((await run(id, [{ action: "assert_text", selector: "#count", value: "1" }])).ok, true);
	assert.equal(fixture.mutations, 1, "failed run must not retry or execute remaining mutations");
	const artifacts = failure.artifacts as { kind: string; path: string; bytes: number }[];
	assert.deepEqual(artifacts.map(a => a.kind), ["console", "network", "screenshot"]);
	for (const artifact of artifacts) {
		assert.equal((await stat(artifact.path)).mode & 0o777, 0o600);
		assert.equal((await stat(dirname(artifact.path))).mode & 0o777, 0o700);
		assert.ok(artifact.bytes > 0);
	}
	assert.match(await readFile(artifacts[0].path, "utf8"), /fixture console evidence/);
	assert.match(await readFile(artifacts[1].path, "utf8"), /200 GET/);
	assert.equal((await readFile(artifacts[2].path)).subarray(1, 4).toString(), "PNG");
	assert.ok(artifacts[2].bytes <= LIMITS.screenshotBytes);
	await call({ action: "close", contextId: id });
	await assert.rejects(stat(artifacts[0].path), /ENOENT/);
	await assert.rejects(call({ action: "snapshot", contextId: id }), /Unknown/);
	await call({ action: "close", contextId: mobileId });
	const root = join(dir, "app-test", (await readdir(join(dir, "app-test")))[0]);
	assert.deepEqual(await readdir(root), []);
});

test("isolated runner never reads or copies the authenticated persistent profile", { timeout: 30_000 }, async t => {
	const { dir, fixture } = await setup(t);
	const profileDir = join(dir, "authenticated-profile");
	const persistent = await persistentChromium.launchPersistentContext(profileDir, { headless: true });
	t.after(() => persistent.close());
	const page = await persistent.newPage();
	await page.goto(fixture.baseUrl + "/seed");
	assert.equal(await page.locator("#storage").innerText(), "secret");
	const runtime = new AppTestRuntime({ BROWSER_MCP_APP_BASE_URL: fixture.baseUrl, BROWSER_MCP_APP_ARTIFACT_DIR: dir, BROWSER_MCP_APP_PROFILE_DIR: profileDir });
	t.after(() => runtime.dispose());
	const id = (await runtime.execute("owner", { action: "create" })).contextId as string;
	const result = await runtime.execute("owner", { action: "run", contextId: id, steps: [
		{ action: "goto", value: "/" }, { action: "assert_text", selector: "#cookie", value: "empty" },
		{ action: "assert_text", selector: "#storage", value: "empty" },
	] });
	assert.equal(result.ok, true);
	assert.match(await page.locator("#cookie").innerText(), /fixture=secret/);
	await runtime.dispose();
	await persistent.close();
});

test("real browser blocks chained redirects and subrequests without hitting forbidden local server", { timeout: 60_000 }, async t => {
	const { fixture, call, run } = await setup(t);
	const id = (await call({ action: "create" })).contextId as string;
	for (const value of [fixture.forbidden, "file:///etc/passwd", "http://x:y@127.0.0.1/"]) {
		await assert.rejects(run(id, [{ action: "goto", value }]), /refused|uncredentialed/);
	}
	const escape = await run(id, [{ action: "goto", value: "/escape" }, { action: "goto", value: "/mutate" }]);
	assert.equal(escape.ok, false); assert.equal(escape.skipped, 1); assert.equal(fixture.mutations, 0);
	assert.equal((await run(id, [{ action: "goto", value: "/" }, { action: "click", selector: "#leak" }, { action: "wait_visible", selector: "#network-done" }])).ok, true);
	const failure = await run(id, [{ action: "assert_text", selector: "h1", value: "not present" }]);
	const network = (failure.artifacts as any[]).find(a => a.kind === "network");
	assert.match(await readFile(network.path, "utf8"), /REFUSED http:\/\/localhost/);
	assert.equal(fixture.refusedHits, 0);
});

test("validation happens before mutation; bounds, cancellation, explicit traces and output retention", { timeout: 90_000 }, async t => {
	const { call, run } = await setup(t);
	await assert.rejects(call({ action: "create", width: 9000 }), /Viewport/);
	const id = (await call({ action: "create" })).contextId as string;
	await run(id, [{ action: "goto", value: "/" }]);
	await assert.rejects(run(id, [{ action: "click", selector: "#save" }, { action: "fill" }]), /selector/);
	assert.equal((await run(id, [{ action: "assert_text", selector: "#count", value: "0" }])).ok, true);
	await assert.rejects(run(id, Array.from({ length: 31 }, () => ({ action: "click", selector: "#save" }))), /1–30/);
	await assert.rejects(run(id, [{ action: "click", selector: "#save", timeoutMs: 99999 }]), /bounds/);
	assert.deepEqual((await call({ action: "trace_stop", contextId: id })).trace, { tracing: false, reason: "No active trace" });
	await call({ action: "trace_start", contextId: id });
	await assert.rejects(call({ action: "trace_start", contextId: id }), /already active/);
	await run(id, [{ action: "click", selector: "#save" }]);
	const trace = (await call({ action: "trace_stop", contextId: id })).trace as any;
	assert.equal(trace.saved, true); assert.equal((await readFile(trace.artifact.path)).subarray(0, 2).toString(), "PK");
	assert.equal((await stat(trace.artifact.path)).mode & 0o777, 0o600);
	assert.ok(trace.artifact.bytes <= LIMITS.traceBytes);
	assert.match(execFileSync("unzip", ["-l", trace.artifact.path], { encoding: "utf8" }), /trace\.trace/);
	await call({ action: "trace_start", contextId: id });
	await run(id, [{ action: "goto", value: "/" }]);
	assert.equal(((await call({ action: "trace_stop", contextId: id })).trace as any).saved, true);
	for (let i = 0; i < 7; i++) await run(id, [{ action: "assert_text", selector: "h1", value: "wrong" }]);
	const capped = await run(id, [{ action: "assert_text", selector: "h1", value: "wrong" }]);
	assert.ok((capped.artifacts as any[]).every(a => !a.path && /retention limit/.test(a.error)));
	const abort = new AbortController();
	const pending = call({ action: "run", contextId: id, steps: [{ action: "wait_visible", selector: "#never" }, { action: "click", selector: "#save" }] }, "session-a", abort.signal);
	setTimeout(() => abort.abort(), 100);
	const canceled = await pending;
	assert.equal(canceled.ok, false); assert.equal(canceled.contextClosed, true);
});

test("context cap, bounded accessibility and console evidence", { timeout: 30_000 }, async t => {
	const { call, run } = await setup(t);
	const contexts = await Promise.all(Array.from({ length: 4 }, () => call({ action: "create" })));
	await assert.rejects(call({ action: "create" }), /context limit/);
	const id = contexts[0].contextId as string;
	await run(id, [{ action: "goto", value: "/" }, { action: "click", selector: "#noise" }]);
	const snapshot = await call({ action: "snapshot", contextId: id });
	assert.equal(snapshot.truncated, true);
	assert.equal((snapshot.snapshot as string).length, LIMITS.snapshotChars);
	const failure = await run(id, [{ action: "assert_text", selector: "h1", value: "wrong" }]);
	const consoleArtifact = (failure.artifacts as any[]).find(a => a.kind === "console");
	const logs = JSON.parse(await readFile(consoleArtifact.path, "utf8"));
	assert.equal(logs.length, LIMITS.entries);
	assert.ok(logs.every((line: string) => line.length <= LIMITS.entryChars));
});

test("opt-in trace automatically stops after real 60-second lifetime", { timeout: 90_000 }, async t => {
	const { call, run } = await setup(t);
	const id = (await call({ action: "create" })).contextId as string;
	await call({ action: "trace_start", contextId: id });
	await run(id, [{ action: "goto", value: "/" }]);
	await new Promise(resolve => setTimeout(resolve, LIMITS.traceMs + 1500));
	const trace = (await call({ action: "trace_stop", contextId: id })).trace as any;
	assert.equal(trace.saved, true); assert.equal(trace.reason, "duration limit");
	await call({ action: "close", contextId: id });
	await assert.rejects(stat(trace.artifact.path), /ENOENT/);
});
