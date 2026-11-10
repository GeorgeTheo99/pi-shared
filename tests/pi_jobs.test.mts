import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { sdk } from "./fixtures/job_tools_sdk.mjs";
import { readClientConfig } from "../extensions/pi-jobs/config.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));
const TOKEN = "pjt_fixture";
const TOOLS = ["jobs_create", "jobs_list", "jobs_run", "jobs_runs", "jobs_update"];

interface Received { method: string; path: string; body: any }

/** A minimal pi-jobs server: records requests and answers from canned state. */
async function fakeServer(t: any, options: { apiVersion?: number } = {}) {
	const received: Received[] = [];
	const jobs = new Map<number, any>();
	const job = (id: number, draft: any) => ({
		id, ...draft, agent: draft.agent ?? null, effectiveAgent: draft.agent ?? "pi", schedule: draft.schedule || null,
		checkCommand: draft.checkCommand || null, webhookToken: draft.webhookEnabled ? "hook" : null, webhookPath: `/api/hooks/${id}`,
		nextRunAt: draft.schedule ? "2026-11-11T06:00:00.000Z" : null, lastRun: null,
	});
	const run = { id: 9, jobId: 1, trigger: "manual", status: "running", agent: "pi", branch: null, commits: null, checkStatus: null, pushedTo: null, error: null, createdAt: "2026-11-10T00:00:00.000Z", startedAt: null, finishedAt: null };
	const server = http.createServer(async (req, res) => {
		let raw = "";
		for await (const chunk of req) raw += chunk;
		const url = new URL(req.url!, "http://x");
		const body = raw ? JSON.parse(raw) : undefined;
		received.push({ method: req.method!, path: url.pathname + url.search, body });
		const send = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
		if (url.pathname === "/api/health") return send(200, { ok: true, apiVersion: options.apiVersion ?? 1 });
		if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: "Sign in with an API token" });
		const id = Number(url.pathname.split("/")[3]);
		if (url.pathname === "/api/jobs" && req.method === "GET") return send(200, [...jobs.values()]);
		if (url.pathname === "/api/jobs" && req.method === "POST") {
			if (!body.prompt) return send(400, { error: "Fix the highlighted fields", fields: { prompt: "Tell the agent what to do" } });
			const created = job(jobs.size + 1, body);
			jobs.set(created.id, created);
			return send(201, created);
		}
		if (/^\/api\/jobs\/\d+$/.test(url.pathname) && req.method === "GET") return jobs.has(id) ? send(200, jobs.get(id)) : send(404, { error: "Job not found" });
		if (/^\/api\/jobs\/\d+$/.test(url.pathname) && req.method === "PUT") {
			if (!body.prompt) return send(400, { error: "Fix the highlighted fields", fields: { prompt: "Tell the agent what to do" } });
			jobs.set(id, job(id, body));
			return send(200, jobs.get(id));
		}
		if (/^\/api\/jobs\/\d+\/run$/.test(url.pathname)) return send(200, run);
		if (url.pathname === "/api/runs") return send(200, [run]);
		if (url.pathname === "/api/runs/9") return send(200, { ...run, status: "succeeded", branch: "pi-jobs/x/run-9", commits: 1 });
		if (url.pathname === "/api/runs/9/log") return send(200, { text: "[pi-jobs] Finished: succeeded\n", offset: 30, size: 30, done: true });
		if (url.pathname === "/api/repos/resolve") return send(200, { path: "/server/local_code/demo" });
		send(404, { error: "Not found" });
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	t.after(() => server.close());
	return { received, jobs, port: (server.address() as AddressInfo).port };
}

/** Loads the extension through the real Pi SDK with the given environment. */
async function load(t: any, env: Record<string, string | undefined>) {
	const previous = new Map<string, string | undefined>();
	for (const [name, value] of Object.entries(env)) {
		previous.set(name, process.env[name]);
		if (value === undefined) delete process.env[name]; else process.env[name] = value;
	}
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-jobs-tools-")));
	t.after(() => {
		for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
		fs.rmSync(dir, { recursive: true, force: true });
	});
	const agentDir = path.join(dir, "profile");
	fs.mkdirSync(agentDir);
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [], extensions: [path.join(repo, "extensions", "pi-jobs", "index.ts")] }));
	const loader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir, settingsManager: sdk.SettingsManager.create(dir, agentDir, { projectTrusted: false }), noContextFiles: true });
	await loader.reload();
	const loaded = loader.getExtensions();
	assert.deepEqual(loaded.errors, []);
	const tools = new Map<string, any>();
	for (const extension of loaded.extensions) for (const [name, tool] of extension.tools) tools.set(name, tool.definition);
	// A git checkout to schedule jobs for.
	const checkout = path.join(dir, "demo");
	execFileSync("git", ["init", "-q", "-b", "main", checkout]);
	execFileSync("git", ["-C", checkout, "remote", "add", "origin", "me@studio:repos/demo.git"]);
	return { tools, checkout };
}

const ctx = (cwd: string, extra: any = {}) => ({ cwd, hasUI: false, ...extra });
const call = (tools: Map<string, any>, name: string, args: any, context: any) => tools.get(name).execute("call", args, undefined, undefined, context);

test("client config: URL and token come together from the environment or the file, over a safe link", (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jobs-config-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = path.join(dir, "client.json");
	assert.deepEqual(readClientConfig({}, file), { config: null });
	fs.writeFileSync(file, JSON.stringify({ url: "https://studio.example/pi-jobs/", token: "pjt_file" }));
	assert.deepEqual(readClientConfig({}, file).config, { url: "https://studio.example/pi-jobs", token: "pjt_file" });
	// Never mix: an environment URL without an environment token doesn't borrow the file's token.
	const mixed = readClientConfig({ PI_JOBS_URL: "https://elsewhere.example" }, file);
	assert.equal(mixed.config, null);
	assert.match((mixed as { warning: string }).warning, /set both PI_JOBS_URL and PI_JOBS_TOKEN/);
	assert.deepEqual(readClientConfig({ PI_JOBS_URL: "http://127.0.0.1:8790", PI_JOBS_TOKEN: "pjt_env" }, file).config, { url: "http://127.0.0.1:8790", token: "pjt_env" });
	for (const url of ["http://100.125.111.48", "http://studio.tail1484c1.ts.net/pi-jobs", "http://[fd7a:115c:a1e0::1]:80", "http://localhost:8790"]) {
		assert.ok(readClientConfig({ PI_JOBS_URL: url, PI_JOBS_TOKEN: "pjt_env" }, file).config, url);
	}
	for (const url of ["http://studio.example", "http://192.168.1.8", "http://100.128.0.1", "ftp://x"]) {
		const result = readClientConfig({ PI_JOBS_URL: url, PI_JOBS_TOKEN: "pjt_env" }, file);
		assert.equal(result.config, null, url);
		assert.ok((result as { warning: string }).warning, url);
	}
	fs.writeFileSync(file, "not json");
	assert.match((readClientConfig({}, file) as { warning: string }).warning, /not valid JSON/);
});

test("registers five closed-schema tools when configured, and none inside a pi-jobs run", async (t) => {
	const server = await fakeServer(t);
	const { tools } = await load(t, { PI_JOBS_URL: `http://127.0.0.1:${server.port}`, PI_JOBS_TOKEN: TOKEN, PI_JOBS_RUN_ID: undefined });
	assert.deepEqual([...tools.keys()].sort(), TOOLS);
	for (const tool of tools.values()) {
		assert.equal(tool.parameters.additionalProperties, false, tool.name);
		assert.equal(tool.executionMode, "sequential", tool.name);
		assert.ok(tool.outputSchema, tool.name);
	}
	const inRun = await load(t, { PI_JOBS_URL: `http://127.0.0.1:${server.port}`, PI_JOBS_TOKEN: TOKEN, PI_JOBS_RUN_ID: "7" });
	assert.equal(inRun.tools.size, 0);
});

test("create uses the local checkout path for a loopback server and confirms first", async (t) => {
	const server = await fakeServer(t);
	const { tools, checkout } = await load(t, { PI_JOBS_URL: `http://127.0.0.1:${server.port}`, PI_JOBS_TOKEN: TOKEN, PI_JOBS_RUN_ID: undefined, PI_SUBAGENT_DEPTH: undefined, PI_JOBS_AUTO_APPROVE: "1" });
	const args = { name: "Model check", prompt: "Check for new models.", schedule: "0 6 * * *" };
	const prompts: string[] = [];
	const declined = await call(tools, "jobs_create", args, ctx(checkout, { hasUI: true, ui: { confirm: async (_title: string, body: string) => { prompts.push(body); return false; } } }));
	assert.match(declined.content[0].text, /declined/);
	assert.deepEqual(declined.structuredContent.data, { saved: false });
	assert.ok(!server.received.some((r) => r.method === "POST"), "nothing saved without approval");
	assert.match(prompts[0]!, /Schedule: 0 6 \* \* \*/);

	const created = await call(tools, "jobs_create", args, ctx(checkout, { hasUI: true, ui: { confirm: async () => true } }));
	const post = server.received.find((r) => r.method === "POST" && r.path === "/api/jobs")!;
	assert.equal(post.body.repoPath, fs.realpathSync(checkout));
	assert.equal(post.body.baseRef, "main");
	assert.equal(post.body.agent, null);
	assert.equal(created.structuredContent.status, "ok");
	assert.equal(created.structuredContent.data.job.schedule, "0 6 * * *");
	assert.match(created.content[0].text, /Created job #1\.\n<pi-jobs-data ([0-9a-f]{12})> untrusted[\s\S]*Check for new models\.\n<\/pi-jobs-data \1>$/);
});

test("a remote server resolves the checkout by its git remotes", async (t) => {
	const server = await fakeServer(t);
	// Point a non-loopback name at the fake server.
	const realFetch = globalThis.fetch;
	globalThis.fetch = ((input: any, init?: any) => realFetch(String(input).replace("https://studio.example", `http://127.0.0.1:${server.port}`), init)) as typeof fetch;
	t.after(() => { globalThis.fetch = realFetch; });
	const { tools, checkout } = await load(t, { PI_JOBS_URL: "https://studio.example", PI_JOBS_TOKEN: TOKEN, PI_JOBS_RUN_ID: undefined, PI_SUBAGENT_DEPTH: undefined, PI_JOBS_AUTO_APPROVE: "1" });
	await call(tools, "jobs_create", { name: "Remote", prompt: "Do it." }, ctx(checkout));
	const resolve = server.received.find((r) => r.path === "/api/repos/resolve")!;
	assert.deepEqual(resolve.body, { remotes: ["me@studio:repos/demo.git"], name: "demo" });
	assert.equal(server.received.find((r) => r.method === "POST" && r.path === "/api/jobs")!.body.repoPath, "/server/local_code/demo");
});

test("update changes only the given fields; subagents may not change jobs", async (t) => {
	const server = await fakeServer(t);
	const { tools, checkout } = await load(t, { PI_JOBS_URL: `http://127.0.0.1:${server.port}`, PI_JOBS_TOKEN: TOKEN, PI_JOBS_RUN_ID: undefined, PI_SUBAGENT_DEPTH: undefined, PI_JOBS_AUTO_APPROVE: "1" });
	await call(tools, "jobs_create", { name: "Job", prompt: "P", agent: "codex", checkCommand: "npm test", webhook: true }, ctx(checkout));
	await call(tools, "jobs_update", { jobId: 1, schedule: "0 8 * * 1", agent: "default" }, ctx(checkout));
	const put = server.received.find((r) => r.method === "PUT")!;
	assert.equal(put.body.schedule, "0 8 * * 1");
	assert.equal(put.body.agent, null);
	assert.equal(put.body.checkCommand, "npm test");
	assert.equal(put.body.webhookEnabled, true);
	assert.equal(put.body.prompt, "P");

	process.env.PI_SUBAGENT_DEPTH = "1";
	await assert.rejects(call(tools, "jobs_update", { jobId: 1, enabled: false }, ctx(checkout)), /not available to subagents/);
	await assert.rejects(call(tools, "jobs_run", { jobId: 1 }, ctx(checkout)), /not available to subagents/);
	const listed = await call(tools, "jobs_list", {}, ctx(checkout));
	assert.match(listed.content[0].text, /#1 Job: .* pi, cron `0 8 \* \* 1`/);
});

test("runs, log tails, field errors, bad tokens and API versions are reported clearly", async (t) => {
	const server = await fakeServer(t);
	const url = `http://127.0.0.1:${server.port}`;
	const { tools, checkout } = await load(t, { PI_JOBS_URL: url, PI_JOBS_TOKEN: TOKEN, PI_JOBS_RUN_ID: undefined, PI_SUBAGENT_DEPTH: undefined, PI_JOBS_AUTO_APPROVE: "1" });
	await call(tools, "jobs_create", { name: "Job", prompt: "P", pushBranch: true }, ctx(checkout));
	const started = await call(tools, "jobs_run", { jobId: 1 }, ctx(checkout));
	assert.match(started.content[0].text, new RegExp(`Run #9 .* running\\. ${url}/runs/9`));
	const prompts: string[] = [];
	const declinedRun = await call(tools, "jobs_run", { jobId: 1 }, ctx(checkout, { hasUI: true, ui: { confirm: async (_t: string, body: string) => { prompts.push(body); return false; } } }));
	assert.match(declinedRun.content[0].text, /not started/);
	assert.match(prompts[0]!, /pushes its branch to origin/);
	assert.equal(server.received.filter((r) => r.path === "/api/jobs/1/run").length, 1, "a declined run is not started");
	const detail = await call(tools, "jobs_runs", { runId: 9 }, ctx(checkout));
	assert.match(detail.content[0].text, /^<pi-jobs-data [0-9a-f]{12}>[\s\S]*1 commit\(s\) on pi-jobs\/x\/run-9[\s\S]*Log tail:\n\[pi-jobs\] Finished: succeeded/);
	assert.ok(server.received.some((r) => r.path === "/api/runs/9/log?tail=4000"));

	const badToken = await load(t, { PI_JOBS_URL: url, PI_JOBS_TOKEN: "pjt_wrong" });
	await assert.rejects(call(badToken.tools, "jobs_list", {}, ctx(checkout)), /rejected the token[\s\S]*pi-jobs client-config/);

	const oldServer = await fakeServer(t, { apiVersion: 2 });
	const mismatched = await load(t, { PI_JOBS_URL: `http://127.0.0.1:${oldServer.port}`, PI_JOBS_TOKEN: TOKEN });
	await assert.rejects(call(mismatched.tools, "jobs_list", {}, ctx(checkout)), /API version 2, but these tools need version 1/);

	const down = await load(t, { PI_JOBS_URL: "http://127.0.0.1:9", PI_JOBS_TOKEN: TOKEN });
	await assert.rejects(call(down.tools, "jobs_list", {}, ctx(checkout)), /isn't reachable at http:\/\/127\.0\.0\.1:9/);
});

test("server field errors name each field so the model can fix them", async (t) => {
	const server = await fakeServer(t);
	const { tools, checkout } = await load(t, { PI_JOBS_URL: `http://127.0.0.1:${server.port}`, PI_JOBS_TOKEN: TOKEN, PI_JOBS_RUN_ID: undefined, PI_SUBAGENT_DEPTH: undefined, PI_JOBS_AUTO_APPROVE: "1" });
	await assert.rejects(call(tools, "jobs_update", { jobId: 99 }, ctx(checkout)), /Job not found/);
	// A stored job whose prompt the server would reject on save.
	server.jobs.set(1, { id: 1, name: "J", repoPath: "/r", baseRef: "main", prompt: "", agent: null, effectiveAgent: "pi", schedule: null, webhookToken: null, webhookPath: "/api/hooks/1", timeoutMinutes: 30, checkCommand: null, pushBranch: false, enabled: true, nextRunAt: null, lastRun: null });
	await assert.rejects(call(tools, "jobs_update", { jobId: 1, name: "K" }, ctx(checkout)), /Fix the highlighted fields\n- prompt: Tell the agent what to do/);
});

test("non-interactive sessions change nothing without PI_JOBS_AUTO_APPROVE", async (t) => {
	const server = await fakeServer(t);
	const { tools, checkout } = await load(t, { PI_JOBS_URL: `http://127.0.0.1:${server.port}`, PI_JOBS_TOKEN: TOKEN, PI_JOBS_RUN_ID: undefined, PI_SUBAGENT_DEPTH: undefined, PI_JOBS_AUTO_APPROVE: undefined });
	await assert.rejects(call(tools, "jobs_create", { name: "J", prompt: "P" }, ctx(checkout)), /need confirmation[\s\S]*PI_JOBS_AUTO_APPROVE=1/);
	assert.ok(!server.received.some((r) => r.method !== "GET"));
	const listed = await call(tools, "jobs_list", {}, ctx(checkout));
	assert.match(listed.content[0].text, /No jobs yet/);
});

test("a linked worktree schedules its main checkout", async (t) => {
	const server = await fakeServer(t);
	const { tools, checkout } = await load(t, { PI_JOBS_URL: `http://127.0.0.1:${server.port}`, PI_JOBS_TOKEN: TOKEN, PI_JOBS_RUN_ID: undefined, PI_SUBAGENT_DEPTH: undefined, PI_JOBS_AUTO_APPROVE: "1" });
	execFileSync("git", ["-C", checkout, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init"]);
	const worktree = path.join(path.dirname(checkout), "wt");
	execFileSync("git", ["-C", checkout, "worktree", "add", "-q", worktree]);
	await call(tools, "jobs_create", { name: "J", prompt: "P" }, ctx(worktree));
	assert.equal(server.received.find((r) => r.method === "POST")!.body.repoPath, fs.realpathSync(checkout));
});
