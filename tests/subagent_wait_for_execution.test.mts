import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import waitFor from "../extensions/wait-for/index.ts";
import { runShellProcess } from "../extensions/_shared/shell-process.ts";

function setup(t: any) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-execution-"));
	let tool: any;
	waitFor({ registerTool: (definition: any) => { tool = definition; } } as any);
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return { dir, tool, call: (args: any, signal?: AbortSignal) => tool.execute("test", args, signal, undefined, { cwd: dir }) };
}

const theme = { fg: (color: string, text: string) => `[${color}]${text}`, bold: (text: string) => text };

test("condition waits accept redundant all and explain incompatible job modes", async t => {
	const f = setup(t);
	for (const job_mode of [undefined, "all"]) {
		const result = await f.call({ condition: "true", job_mode, timeout: 1 });
		assert.equal(result.details.met, true);
	}
	for (const job_mode of ["any", "any_success", "any_failure"]) {
		await assert.rejects(f.call({ condition: "true", job_mode, timeout: 1 }), /omit `job_mode`/);
	}
	await assert.rejects(f.call({ condition: "true", job_mode: "invalid", timeout: 1 }), /Invalid job_mode/);
	await assert.rejects(f.call({ condition: "true", jobs: [], timeout: 1 }), /omit jobs/);
	await assert.rejects(f.call({ condition: "true", jobs: ["sub_fixture"], timeout: 1 }), /mutually exclusive/);
	assert.match(f.tool.renderCall({ condition: "true", job_mode: "any" }, theme).text, /job_mode: any.*omit/);
	assert.match(f.tool.renderCall({ condition: "true", job_mode: "all" }, theme).text, /all.*ignored/);
});

test("condition failures stop promptly only for configured fatal exit codes", async t => {
	const f = setup(t);
	await assert.rejects(f.call({ condition: "pi_wait_for_missing_test_executable", timeout: 5 }), /exit 127/);
	await assert.rejects(f.call({ condition: "exit 126", timeout: 5 }), /exit 126/);
	await assert.rejects(f.call({ condition: "printf fatal-detail >&2; exit 2", failure_exit_codes: [2, 126, 127], timeout: 5 }), /exit 2.*\n.*fatal-detail/);
	await assert.rejects(f.call({ condition: "exit 127", failure_exit_codes: [], timeout: 1 }), /Timed out/);
	for (const codes of [[0], [-1], [256], [1.5], Array(256).fill(2)]) {
		await assert.rejects(f.call({ condition: "true", failure_exit_codes: codes, timeout: 1 }), /integer exit codes/);
	}
	await assert.rejects(f.call({ jobs: ["sub_fixture"], failure_exit_codes: [], timeout: 1 }), /Omit it when using jobs/);
});

test("deadline does not launch an extra condition and preserves diagnostic output", async t => {
	const f = setup(t);
	await assert.rejects(f.call({ condition: "printf x >> checks; printf detail-out; printf detail-err >&2; exit 1", timeout: 1, poll_interval: 1 }), (error: Error) => {
		assert.match(error.message, /Timed out.*1 check/);
		assert.match(error.message, /last nonempty stdout: detail-out/);
		assert.match(error.message, /last nonempty stderr: detail-err/);
		return true;
	});
	assert.equal(fs.readFileSync(path.join(f.dir, "checks"), "utf8"), "x");
});

test("later empty checks do not erase the last nonempty diagnostics or progress", async t => {
	const f = setup(t);
	await assert.rejects(f.call({ condition: "if [ ! -f seen ]; then touch seen; printf earlier-out; printf earlier-err >&2; fi; exit 2", progress: "if [ ! -f progress-seen ]; then touch progress-seen; printf earlier-progress; fi", timeout: 2, poll_interval: 1 }), (error: Error) => {
		assert.match(error.message, /2 checks/);
		assert.match(error.message, /last nonempty stdout: earlier-out/);
		assert.match(error.message, /last nonempty stderr: earlier-err/);
		assert.match(error.message, /last progress: earlier-progress/);
		return true;
	});
});

test("shell timeout cannot become success when a TERM handler exits zero", { skip: process.platform === "win32" }, async () => {
	const result = await runShellProcess("trap 'exit 0' TERM; while :; do sleep 1; done", process.cwd(), 500);
	assert.notEqual(result.code, 0);
	assert.equal(result.terminationReason, "timeout");
	assert.equal(result.aborted, false);
	assert.match(result.stderr, /Shell evaluation timed out/);
});

test("per-check timeout cannot satisfy a longer overall wait", { skip: process.platform === "win32", timeout: 40000 }, async t => {
	const f = setup(t);
	await assert.rejects(f.call({ condition: "trap 'exit 0' TERM; while :; do sleep 1; done", timeout: 31, poll_interval: 1 }), /Timed out[\s\S]*Shell evaluation timed out/);
});

test("natural shell exit reaps background children in its original group", { skip: process.platform === "win32" }, async () => {
	const result = await runShellProcess("sleep 15 </dev/null >/dev/null 2>&1 & echo $!", process.cwd(), 2000);
	const pid = Number(result.stdout.trim());
	assert.ok(Number.isInteger(pid) && pid > 0, "fixture must report a child PID");
	try {
		assert.equal(result.code, 0);
		let state = "";
		try { state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim(); }
		catch (error: any) { if (error.status !== 1) throw error; }
		// Linux may retain a zombie briefly until init reaps it; it is no longer running.
		assert.ok(!state || state.startsWith("Z"), `child survived: ${state}`);
	} finally {
		try { process.kill(pid, "SIGKILL"); } catch {}
	}
});

test("aborting shell evaluation remains distinct from success", async t => {
	const f = setup(t);
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), 100);
	try {
		const result = await f.call({ condition: "sleep 5", timeout: 10 }, abort.signal);
		assert.equal(result.details.aborted, true);
		assert.equal(result.details.met, false);
		assert.match(result.content[0].text, /Termination was requested/);
	} finally { clearTimeout(timer); }
});

test("job failures and pending questions render as warnings, not success", t => {
	const f = setup(t);
	for (const details of [{ met: true, failedJobs: 1 }, { met: true, awaitingJobs: 1 }]) {
		const rendered = f.tool.renderResult({ details, content: [{ type: "text", text: "outcome" }] }, {}, theme);
		assert.match(rendered.text, /^\[warning\]/);
	}
});
