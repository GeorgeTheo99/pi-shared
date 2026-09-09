import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CommandJobRunner } from "../extensions/_shared/command-job-runner.ts";
import { CommandJobStore } from "../extensions/_shared/command-job-store.ts";
import { VerificationEngine } from "../extensions/verification/engine.ts";
import { loadConfig } from "../extensions/verification/config.ts";
import { fingerprint } from "../extensions/verification/files.ts";
import type { Check } from "../extensions/verification/types.ts";
import { withInterprocessLock } from "../extensions/_shared/file-lock.ts";

function setup(t: any) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "verification-")));
	const project = path.join(dir, "project"); fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(project, "source.js"), "original");
	const runner = new CommandJobRunner(new CommandJobStore(path.join(dir, "jobs")));
	const engine = new VerificationEngine(runner);
	const configPath = path.join(project, ".pi", "verification.json");
	const check: Check = { id: "check", command: process.execPath, args: ["-e", ""], cwd: ".", timeoutSeconds: 3, inputs: { paths: ["source.js"], exclude: [], untracked: "include" }, report: { format: "exit" } };
	const configure = async (patch: Partial<Check> = {}, script = "") => {
		const value = { ...check, args: ["-e", script], ...patch };
		fs.writeFileSync(configPath, JSON.stringify({ version: 1, checks: [value] }));
		return (await loadConfig(project)).sha256;
	};
	const run = async (patch: Partial<Check> = {}, script = "") => engine.run(project, "check", await configure(patch, script));
	t.after(async () => { await engine.close(); await runner.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
	return { dir, project, engine, runner, configPath, configure, run, check };
}
const tap = { report: { format: "tap", path: "stdout" }, discovery: { allowZero: false } } as const;
const junit = { report: { format: "junit", path: "stdout" }, discovery: { allowZero: false } } as const;
const output = (s: string, exit = 0) => `process.stdout.write(${JSON.stringify(s)}); process.exitCode=${exit};`;

test("non-Git generic exit records scoped identity, exact process facts, and no invented counts", async t => {
	const f = setup(t); const r = await f.run();
	assert.equal(r.verdict, "passed"); assert.equal(r.source.status, "unchanged"); assert.equal(r.source.before.files, 1);
	assert.equal(r.process?.exitCode, 0); assert.equal(r.process?.cleanup, "confirmed"); assert.equal(r.report, undefined);
	assert.match(r.id, /^cmd_/); assert.equal(r.toolchain.verifierNode, process.version);
	assert.equal((await f.engine.result(f.project, r.id)).verdict, "passed");
	assert.equal(fs.statSync(r.artifacts.stdout!).mode & 0o777, 0o600);
});
for (const [name, patch, script, verdict] of [
	["TAP pass", tap, output("ok 1\n1..1\n"), "passed"],
	["TAP fail with zero exit", tap, output("not ok 1\n1..1\n"), "failed"],
	["green report nonzero exit", tap, output("ok 1\n1..1\n", 7), "failed"],
	["zero tests rejected", tap, output("1..0\n"), "incomplete"],
	["zero tests explicit policy", { ...tap, discovery: { allowZero: true } }, output("1..0\n"), "passed"],
	["minimum discovery enforced", { ...tap, discovery: { allowZero: true, minTests: 2 } }, output("ok 1\n1..1\n"), "incomplete"],
	["missing stdout report", tap, "", "error"],
	["malformed TAP", tap, output("All tests passed"), "error"],
	["JUnit pass", junit, output('<testsuite tests="1"><testcase/></testsuite>'), "passed"],
	["JUnit fail", junit, output('<testsuite><testcase/><testcase><failure/></testcase></testsuite>'), "failed"],
	["malicious XML", junit, output('<!DOCTYPE testsuite [<!ENTITY x SYSTEM "file:///etc/passwd">]><testsuite/>'), "error"],
	["generic failure", {}, "process.exit(7)", "failed"],
	["missing source scope", { inputs: undefined }, "", "incomplete"],
	["source mutation", {}, "require('fs').writeFileSync('source.js','changed')", "stale"],
] as const) test(name, async t => {
	const f = setup(t); const r = await f.run(patch as Partial<Check>, script);
	assert.equal(r.verdict, verdict, JSON.stringify(r.reasons));
	if (verdict === "failed") assert.notEqual(r.verdict, "passed");
});

test("fixed stale report is rejected; fresh per-run report destination and hashes are recorded", async t => {
	const f = setup(t); const content = '<testsuite tests="1"><testcase/></testsuite>';
	fs.writeFileSync(path.join(f.project, "report.xml"), content);
	const base = { ...junit, report: { format: "junit", path: "report.xml" }, args: ["-e", "", "{report}"] } as Partial<Check>;
	const old = await f.run(base); assert.equal(old.verdict, "error"); assert.match(old.reasons.join(), /pre-existing/);
	const script = `require('fs').writeFileSync(process.argv[1], ${JSON.stringify(content)})`;
	const fresh = await f.run({ ...base, report: { format: "junit", path: "report-{runId}.xml" }, args: ["-e", script, "{report}"] });
	assert.equal(fresh.verdict, "passed"); assert.match(fresh.artifacts.report!, /report-[0-9a-f-]+\.xml$/);
	assert.equal((await f.engine.result(f.project, fresh.id)).verdict, "passed");
	fs.writeFileSync(fresh.artifacts.report!, '<testsuite tests="0"/>');
	assert.equal((await f.engine.result(f.project, fresh.id)).verdict, "stale");
});

test("missing, oversized and symlink reports never pass", async t => {
	const f = setup(t);
	const missing = await f.run({ ...junit, report: { format: "junit", path: "missing.xml" }, args: ["-e", "", "{report}"] });
	assert.equal(missing.verdict, "error");
	const flood = await f.run(tap, "process.stdout.write('x'.repeat(3*1024*1024))");
	assert.equal(flood.verdict, "error"); assert.ok(flood.process!.stdoutOmitted > 0);
	const symlink = await f.run({ ...junit, report: { format: "junit", path: "link.xml" }, args: ["-e", "require('fs').symlinkSync('source.js',process.argv[1])", "{report}"] });
	assert.equal(symlink.verdict, "error");
});

test("result lookup revalidates source, config and command artifact retention", async t => {
	const f = setup(t); const r = await f.run();
	fs.writeFileSync(path.join(f.project, "source.js"), "modified");
	assert.equal((await f.engine.result(f.project, r.id)).source.status, "stale");
	fs.writeFileSync(path.join(f.project, "source.js"), "original");
	fs.appendFileSync(f.configPath, " ");
	assert.equal((await f.engine.result(f.project, r.id)).verdict, "stale");
	await f.configure();
	fs.unlinkSync(path.join(f.runner.store.jobDir(r.id), "job.json"));
	assert.equal((await f.engine.result(f.project, r.id)).verdict, "stale");
	await assert.rejects(f.engine.result(f.dir, r.id), /Unknown/);
});

test("config and declared untracked file mutations during execution invalidate success", async t => {
	const f = setup(t);
	const patch = { inputs: { paths: ["."], exclude: [".pi"], untracked: "include" } } as Partial<Check>;
	const untracked = await f.run(patch, "require('fs').writeFileSync('new-input.js','added')");
	assert.equal(untracked.verdict, "stale");
	const config = await f.run({}, "require('fs').appendFileSync('.pi/verification.json',' ')");
	assert.equal(config.verdict, "stale");
});

test("cancel and timeout are not passing results; abort before start executes nothing", async t => {
	const f = setup(t); const hash = await f.configure({}, "setInterval(()=>{},1000)");
	const cancel = new AbortController();
	const r = await f.engine.run(f.project, "check", hash, cancel.signal, () => cancel.abort());
	assert.equal(r.verdict, "canceled"); assert.equal(r.process?.status, "canceled");
	assert.equal(r.process?.cleanup, "confirmed");
	const timeout = await f.run({ timeoutSeconds: 0.05 }, "setInterval(()=>{},1000)");
	assert.equal(timeout.verdict, "incomplete"); assert.equal(timeout.process?.status, "timed_out");
	const count = f.runner.store.list().length;
	await assert.rejects(f.engine.run(f.project, "check", await f.configure(), cancel.signal), /canceled/);
	assert.equal(f.runner.store.list().length, count);
});

for (const mode of ["abort", "shutdown"]) test(`verification ${mode} during command reservation cannot execute`, async t => {
	const f=setup(t);
	const hash=await f.configure({}, "require('fs').writeFileSync('must-not-run','bad')");
	let release!:()=>void, entered!:()=>void, reserving!:()=>void;
	const locked=new Promise<void>(r=>{entered=r});
	const reservation=new Promise<void>(r=>{reserving=r});
	const held=withInterprocessLock(path.join(f.runner.store.dir,'.lock'),async()=>{entered();await new Promise<void>(r=>{release=r})});
	await locked;
	const original=f.runner.store.reserve.bind(f.runner.store);
	f.runner.store.reserve=(...args)=>{reserving();return original(...args)};
	const abort=new AbortController();
	const running=f.engine.run(f.project,'check',hash,abort.signal);
	await reservation;
	let closing:Promise<void>|undefined;
	if(mode==='abort') abort.abort(); else closing=f.engine.close();
	try { await assert.rejects(running,/abort|cancel/i); await closing; }
	finally { release(); await held; }
	assert.equal(fs.existsSync(path.join(f.project,'must-not-run')),false);
	assert.equal(f.runner.store.list().length,0);
});

test("untrusted/changed config never executes and list only inspects declarations", async t => {
	const f = setup(t); const hash = await f.configure();
	assert.equal((await f.engine.list(f.project)).checks.length, 1);
	await assert.rejects(f.engine.run(f.project, "check", undefined), /not trusted/);
	fs.appendFileSync(f.configPath, " "); await assert.rejects(f.engine.run(f.project, "check", hash), /not trusted/);
	assert.equal(f.runner.store.list().length, 0);
});

test("fingerprint includes ignored/untracked files, explicit exclusions and rejects symlinks/limits", async t => {
	const f = setup(t);
	const scope = { paths: ["."], exclude: [".pi", "output"], untracked: "include" } as const;
	const take = () => fingerprint(f.project, structuredClone(scope) as any);
	const before = await take();
	fs.mkdirSync(path.join(f.project, "output")); fs.writeFileSync(path.join(f.project, "output", "generated"), "excluded");
	assert.equal((await take()).sha256, before.sha256);
	fs.writeFileSync(path.join(f.project, ".gitignore"), "ignored\n"); fs.writeFileSync(path.join(f.project, "ignored"), "included");
	assert.notEqual((await take()).sha256, before.sha256);
	fs.symlinkSync("source.js", path.join(f.project, "symlink")); assert.equal((await take()).status, "unknown");
	fs.unlinkSync(path.join(f.project, "symlink"));
	fs.writeFileSync(path.join(f.project, "oversize"), Buffer.alloc(8 * 1024 * 1024 + 1));
	assert.equal((await take()).status, "unknown");
	assert.equal((await fingerprint(f.project, { paths: ["missing"], exclude: [], untracked: "include" })).status, "unknown");
});

test("spawn failure and unconfirmed cleanup cannot pass", async t => {
	const f = setup(t);
	const absent = await f.run({ command: path.join(f.project, "no-such-executable") });
	assert.equal(absent.verdict, "failed");
	const completion = f.runner.completion.bind(f.runner);
	f.runner.completion = async id => { const r = await completion(id); return r ? { ...r, cleanup: "unconfirmed" } : r; };
	const uncertain = await f.run(); assert.equal(uncertain.verdict, "incomplete");
});

test("expanded argv and final structured failure details are bounded", async t => {
	const f = setup(t);
	await assert.rejects(f.run({ ...junit, report: { format: "junit", path: "report-{runId}.xml" }, args: ["-e", "", "{report}".repeat(500)] }), /Expanded/);
	assert.equal(f.runner.store.list().length, 0);
	const xml = '<testsuite>' + Array.from({ length: 30 }, () => `<testcase name="${"界".repeat(300)}" file="${"界".repeat(300)}"><failure/></testcase>`).join("") + '</testsuite>';
	const reportPath = path.join(f.project, "input-report.xml"); fs.writeFileSync(reportPath, xml);
	const r = await f.run(junit, "process.stdout.write(require('fs').readFileSync('input-report.xml'))");
	assert.equal(r.verdict, "failed"); assert.equal(r.report?.counts.failed, 30);
	assert.ok(Buffer.byteLength(JSON.stringify(r)) <= 40 * 1024);
	assert.ok(r.report!.failuresOmitted >= 10);
});

test("configuration rejects traversal, unsupported version, duplicate IDs and oversize", async t => {
	const f = setup(t);
	for (const patch of [{ cwd: "../other" }, { inputs: { paths: ["source.js"], exclude: [], untracked: "ignore" } }, { ...tap, discovery: undefined }, { surprise: true }]) {
		fs.writeFileSync(f.configPath, JSON.stringify({ version: 1, checks: [{ ...f.check, ...patch }] }));
		await assert.rejects(loadConfig(f.project));
	}
	fs.writeFileSync(f.configPath, JSON.stringify({ version: 2, checks: [f.check] })); await assert.rejects(loadConfig(f.project));
	fs.writeFileSync(f.configPath, JSON.stringify({ version: 1, checks: [f.check, f.check] })); await assert.rejects(loadConfig(f.project));
	fs.writeFileSync(f.configPath, " ".repeat(65537)); await assert.rejects(loadConfig(f.project), /limit/);
});
