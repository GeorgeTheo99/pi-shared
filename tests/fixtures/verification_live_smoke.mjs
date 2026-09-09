// Optional live smoke over unchanged copies of real pi-shared Node/Python checks.
// VERIFICATION_PYTHON must point to a Python interpreter with pytest already installed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VerificationEngine } from "../../extensions/verification/engine.ts";
import { CommandJobRunner } from "../../extensions/_shared/command-job-runner.ts";
import { CommandJobStore } from "../../extensions/_shared/command-job-store.ts";
import { loadConfig } from "../../extensions/verification/config.ts";

if (!process.env.VERIFICATION_PYTHON) throw new Error("Set VERIFICATION_PYTHON to an existing pytest-capable Python executable");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "verification-live-")));
const project = path.join(dir, "project");
const runner = new CommandJobRunner(new CommandJobStore(path.join(dir, "jobs")));
const engine = new VerificationEngine(runner);
try {
	const files = ["tests/verification_parsers.test.mts", "tests/test_pi_catalog.py", "lib/pi_catalog.py", "extensions/verification/types.ts", "extensions/verification/parsers/tap.ts", "extensions/verification/parsers/junit.ts", "extensions/verification/package.json", "extensions/verification/package-lock.json"];
	for (const file of files) { fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true }); fs.copyFileSync(path.join(root, file), path.join(project, file)); }
	fs.cpSync(path.join(root, "extensions/verification/node_modules"), path.join(project, "extensions/verification/node_modules"), { recursive: true });
	fs.mkdirSync(path.join(project, ".pi"));
	const common = { cwd: ".", timeoutSeconds: 60, inputs: { paths: files, exclude: [], untracked: "include" }, discovery: { allowZero: false } };
	fs.writeFileSync(path.join(project, ".pi/verification.json"), JSON.stringify({ version: 1, checks: [
		{ ...common, id: "node-real", command: process.execPath, args: ["--no-warnings", "--test", "--test-reporter=tap", "tests/verification_parsers.test.mts"], report: { format: "tap", path: "stdout" } },
		{ ...common, id: "python-real", command: process.env.VERIFICATION_PYTHON, args: ["-m", "pytest", "-q", "-o", "junit_family=xunit1", "--junitxml={report}", "tests/test_pi_catalog.py::test_local_qwen_gets_qwen_chat_template", "tests/test_pi_catalog.py::test_explicit_false_vision_overrides_local_name_heuristic"], report: { format: "junit", path: ".pi/python-{runId}.xml" } },
	] }));
	const hash = (await loadConfig(project)).sha256;
	for (const id of ["node-real", "python-real"]) {
		const result = await engine.run(project, id, hash);
		console.log(JSON.stringify({ check: id, verdict: result.verdict, process: result.process?.status, counts: result.report?.counts, source: result.source.status, reasons: result.reasons }));
		assert.equal(result.verdict, "passed");
	}
} finally { await engine.close(); await runner.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
