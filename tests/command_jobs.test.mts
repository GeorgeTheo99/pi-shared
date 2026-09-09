import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import test from "node:test";
import { CommandJobStore, COMMAND_TERMINAL, type CommandRecord } from "../extensions/_shared/command-job-store.ts";
import { CommandJobRunner, commandLogs } from "../extensions/_shared/command-job-runner.ts";
import { withInterprocessLock } from "../extensions/_shared/file-lock.ts";

function fixture(t: any) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-command-test-"));
	const cwd = fs.realpathSync(dir);
	const store = new CommandJobStore(path.join(dir, "state"));
	const runner = new CommandJobRunner(store);
	t.after(async () => { await runner.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
	const start = (code: string, extra = {}) => runner.start({ command: process.execPath, args: ["-e", code], cwd, timeoutSeconds: 5, ...extra });
	return { dir, cwd, store, runner, start };
}
async function eventually(check: () => boolean, timeout = 4000) {
	const deadline = Date.now() + timeout;
	while (!check()) { if (Date.now() > deadline) throw new Error("fixture timed out"); await new Promise(r => setTimeout(r, 20)); }
}

test("empty success and exact nonzero exit with separate logs", async t => {
	const f = fixture(t);
	const empty = await f.start("");
	const a = await f.runner.completion(empty.id);
	assert.equal(a?.status, "succeeded"); assert.equal(a?.exitCode, 0);
	const failing = await f.start("process.stdout.write('out'); process.stderr.write('err'); process.exitCode=7");
	const b = await f.runner.completion(failing.id);
	assert.equal(b?.status, "failed"); assert.equal(b?.exitCode, 7);
	assert.equal(commandLogs(f.store, b!.id, f.cwd, "stdout").text, "out");
	assert.equal(commandLogs(f.store, b!.id, f.cwd, "stderr").text, "err");
	assert.equal(fs.statSync(path.join(f.store.jobDir(b!.id), "stdout.log")).mode & 0o777, 0o600);
	assert.equal(fs.statSync(f.store.dir).mode & 0o777, 0o700);
});

test("spawn failure and required finite timeout", async t => {
	const f = fixture(t);
	const job = await f.runner.start({ command: path.join(f.dir, "absent"), cwd: f.cwd, timeoutSeconds: 1 });
	const r = await f.runner.completion(job.id);
	assert.equal(r?.status, "failed"); assert.equal(r?.reason, "spawn_error");
	assert.equal(r?.cleanup, "confirmed");
	await assert.rejects(f.start("", { timeoutSeconds: NaN }), /timeoutSeconds/);
});

test("timeout and cancellation are distinct, remote request does not pretend completion", async t => {
	const f = fixture(t);
	const timed = await f.start("setInterval(()=>{},1000)", { timeoutSeconds: 0.15 });
	assert.equal((await f.runner.completion(timed.id))?.status, "timed_out");
	const job = await f.start("setInterval(()=>{},1000)");
	const remote = new CommandJobStore(f.store.dir);
	const request = await remote.cancel(job.id, f.cwd);
	assert.equal(request.cancelRequested, true);
	assert.equal(COMMAND_TERMINAL.has(request.status), false);
	const final = await f.runner.completion(job.id);
	assert.equal(final?.status, "canceled");
	assert.notEqual(final?.exitCode, 0);
	await assert.rejects(remote.cancel(job.id, "/wrong-project"), /another project/);
});

test("bounded stdout flood drains and cursors recover retained bytes exactly", async t => {
	const f = fixture(t);
	const job = await f.start("process.stdout.write('x'.repeat(3*1024*1024)); process.stderr.write('done')");
	const r = (await f.runner.completion(job.id))!;
	assert.equal(r.status, "succeeded"); assert.equal(r.stdoutBytes, 2*1024*1024); assert.equal(r.stdoutOmitted, 1024*1024);
	let cursor: string | undefined; const chunks: Buffer[] = [];
	for (;;) {
		const log = commandLogs(f.store, job.id, f.cwd, "stdout", cursor, 65536);
		chunks.push(Buffer.from(log.base64!, "base64")); cursor = log.cursor;
		if (!log.hasMore) break;
	}
	assert.equal(Buffer.concat(chunks).length, r.stdoutBytes);
	assert.equal(Buffer.concat(chunks).toString(), "x".repeat(r.stdoutBytes));
	assert.throws(() => commandLogs(f.store, job.id, f.cwd, "stderr", cursor), /mismatched/);
	assert.throws(() => commandLogs(f.store, job.id, "/other", "stdout"), /Unknown/);
	assert.throws(() => f.store.read("../../bad"), /Invalid/);
});

test("readiness is separate from eventual failure", async t => {
	const f = fixture(t);
	const portServer = net.createServer(); await new Promise<void>(r => portServer.listen(0, "127.0.0.1", r));
	const port = (portServer.address() as net.AddressInfo).port;
	await new Promise<void>(r => portServer.close(() => r()));
	const job = await f.start(`require('node:http').createServer((q,s)=>s.end('ok')).listen(${port},'127.0.0.1'); setTimeout(()=>process.exit(9),1800)`, { readiness: { kind: "http", port, timeoutSeconds: 2 } });
	await eventually(() => f.store.read(job.id)?.readiness === "ready");
	assert.equal(f.store.read(job.id)?.status, "running");
	const final = await f.runner.completion(job.id);
	assert.equal(final?.status, "failed"); assert.equal(final?.exitCode, 9); assert.equal(final?.readiness, "ready");
});

test("failed readiness does not rewrite a successful process outcome", async t => {
	const f = fixture(t);
	const job = await f.start("setTimeout(()=>{},300)", { readiness: { kind: "tcp", port: 1, timeoutSeconds: 0.1 } });
	const final = await f.runner.completion(job.id);
	assert.equal(final?.status, "succeeded"); assert.equal(final?.readiness, "failed");
});

test("concurrent reservation respects capacity and does not overwrite records", async t => {
	const f = fixture(t);
	const now = Date.now();
	const record = (): CommandRecord => ({ version: 1, id: `cmd_${crypto.randomUUID()}`, owner: "test", ownerPid: process.pid, project: f.cwd, label: "test", createdAt: now, updatedAt: now, status: "running", readiness: "not_requested", stdoutBytes: 0, stderrBytes: 0, stdoutOmitted: 0, stderrOmitted: 0 });
	const results = await Promise.allSettled(Array.from({ length: 10 }, () => f.store.reserve(record(), 3)));
	assert.equal(results.filter(r => r.status === "fulfilled").length, 3);
	assert.equal(f.store.list().length, 3);
	const first = f.store.list()[0];
	await f.store.update(first.id, first.owner, r => ({ ...r, updatedAt: Date.now()-60_000 }));
	assert.equal(f.store.read(first.id)?.status, "lost");
	assert.equal(f.store.read(first.id)?.cleanup, "unconfirmed");
});

test("shutdown cancels all live jobs and refuses future starts", async t => {
	const f = fixture(t);
	const jobs = await Promise.all([f.start("setInterval(()=>{},1000)"), f.start("setInterval(()=>{},1000)")]);
	await f.runner.shutdown();
	for (const job of jobs) assert.equal(f.store.read(job.id)?.status, "canceled");
	await assert.rejects(f.start(""), /shutting down/);
});

test("shutdown racing reservation still drains the started process", async t => {
	const f = fixture(t);
	const starting = f.start("setInterval(()=>{},1000)");
	const shuttingDown = f.runner.shutdown();
	const job = await starting; await shuttingDown;
	assert.equal(f.store.read(job.id)?.status, "canceled");
});

test("log setup failure cannot create successful evidence", async t => {
	const f = fixture(t);
	const reserve = f.store.reserve.bind(f.store);
	f.store.reserve = async (r, ...limits) => {
		await reserve(r, ...limits);
		fs.mkdirSync(path.join(f.store.jobDir(r.id), "stdout.log"));
	};
	const job = await f.start("process.exit(0)");
	const result = await f.runner.completion(job.id);
	assert.equal(result?.status, "failed"); assert.equal(result?.exitCode, undefined);
});

test("escaped pipe-holding descendant forces explicit unconfirmed cleanup", { skip: process.platform === "win32" }, async t => {
	const f = fixture(t);
	let childPid: number | undefined;
	t.after(() => { if (childPid) { try { process.kill(childPid, "SIGKILL"); } catch {} } });
	const job = await f.start(`const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','inherit','inherit']}); console.log(c.pid); c.unref(); process.exit(0)`, { timeoutSeconds: 0.5 });
	await eventually(() => { const file=path.join(f.store.jobDir(job.id), 'stdout.log'); return fs.existsSync(file) && fs.statSync(file).size>0; });
	childPid = Number(fs.readFileSync(path.join(f.store.jobDir(job.id), "stdout.log"), "utf8").trim());
	assert.ok(Number.isInteger(childPid) && childPid! > 0);
	const result = await f.runner.completion(job.id);
	assert.equal(result?.status, "succeeded"); assert.equal(result?.cleanup, "unconfirmed");
	assert.equal(result?.exitCode, 0);
	process.kill(childPid!, 0); // Test owns and cleans the known escaped child, not a stale PID.
});

test("natural leader exit cleans non-detached ignored-stdio descendants", { skip: process.platform === "win32" }, async t => {
	const f = fixture(t); let childPid: number | undefined;
	t.after(() => { if (childPid) { try { process.kill(childPid, "SIGKILL"); } catch {} } });
	const job = await f.start(`const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(c.pid); c.unref(); process.exit(0)`);
	const result = await f.runner.completion(job.id);
	childPid = Number(commandLogs(f.store,job.id,f.cwd,"stdout").text.trim());
	assert.equal(result?.status,"succeeded"); assert.equal(result?.exitCode,0);
	assert.ok(Number.isInteger(childPid) && childPid! > 0);
	await eventually(() => { try { process.kill(childPid!,0); return false; } catch (e: any) { return e.code === "ESRCH"; } });
	await f.runner.shutdown();
});

test("SIGTERM teardown output is retained on both streams", async t => {
	const f = fixture(t);
	const job = await f.start(`process.on('SIGTERM',()=>{process.stdout.write('shutdown-out');process.stderr.write('shutdown-err');process.exit(0)});console.log('ready');setInterval(()=>{},1000)`);
	await eventually(() => { const p=path.join(f.store.jobDir(job.id),'stdout.log'); return fs.existsSync(p) && fs.statSync(p).size>0; });
	await f.store.cancel(job.id,f.cwd); await f.runner.completion(job.id);
	assert.match(commandLogs(f.store,job.id,f.cwd,"stdout").text,/shutdown-out/);
	assert.match(commandLogs(f.store,job.id,f.cwd,"stderr").text,/shutdown-err/);
});

test("startup aborted behind the store lock never executes", async t => {
	const f=fixture(t);
	let release!: () => void, entered!: () => void;
	const ready=new Promise<void>(r=>{entered=r});
	const held=withInterprocessLock(path.join(f.store.dir,'.lock'),async()=>{entered();await new Promise<void>(r=>{release=r})});
	await ready;
	const abort=new AbortController();
	const pending=f.runner.start({command:process.execPath,args:['-e',`require('node:fs').writeFileSync('must-not-exist','bad')`],cwd:f.cwd,timeoutSeconds:2},abort.signal);
	abort.abort();
	try { await assert.rejects(pending,/abort/i); }
	finally { release(); await held; }
	assert.equal(fs.existsSync(path.join(f.cwd,'must-not-exist')),false);
	assert.equal(f.store.list().length,0);
});

test("forced cleanup preserves observed leader signal separately from escalation", { skip: process.platform === "win32" }, async t => {
	const f=fixture(t); let childPid:number|undefined;
	t.after(()=>{if(childPid){try{process.kill(childPid,'SIGKILL')}catch{}}});
	const job=await f.start(`const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','inherit','inherit']});process.on('SIGTERM',()=>process.exit(0));console.log(c.pid);setInterval(()=>{},1000)`);
	await eventually(()=>{const p=path.join(f.store.jobDir(job.id),'stdout.log');return fs.existsSync(p)&&fs.statSync(p).size>0});
	childPid=Number(commandLogs(f.store,job.id,f.cwd,'stdout').text.trim());
	await f.store.cancel(job.id,f.cwd);
	const result=await f.runner.completion(job.id);
	assert.equal(result?.status,'canceled'); assert.equal(result?.cleanup,'unconfirmed');
	assert.equal(result?.exitCode,0); assert.equal(result?.exitSignal,null);
});
