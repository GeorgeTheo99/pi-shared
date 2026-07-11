import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
	approveWorkflowSource,
	pathIsWithin,
	resolveWorkflowSource,
} from "../extensions/workflow/source.ts";

function fixture(t: TestContext) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-trust-test-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const sharedDir = path.join(root, "shared");
	const projectRoot = path.join(root, "project");
	const projectDir = path.join(projectRoot, ".pi", "workflows");
	const externalDir = path.join(root, "external");
	fs.mkdirSync(sharedDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });
	fs.mkdirSync(externalDir, { recursive: true });
	return { root, sharedDir, projectRoot, projectDir, externalDir };
}

test("shared workflows resolve immediately", (t) => {
	const dirs = fixture(t);
	fs.writeFileSync(path.join(dirs.sharedDir, "safe.js"), 'return "safe";');
	const resolved = resolveWorkflowSource({
		params: { name: "safe" },
		cwd: dirs.projectRoot,
		sharedDir: dirs.sharedDir,
		projectDir: dirs.projectDir,
		projectTrusted: false,
	});
	assert.equal(resolved.kind, "ready");
	if (resolved.kind === "ready") assert.equal(resolved.code, 'return "safe";');
});

test("project workflow code is not read until approval", (t) => {
	const dirs = fixture(t);
	const filePath = path.join(dirs.projectDir, "project-task.js");
	fs.writeFileSync(filePath, 'return "before";');
	const resolved = resolveWorkflowSource({
		params: { name: "project-task" },
		cwd: dirs.projectRoot,
		sharedDir: dirs.sharedDir,
		projectDir: dirs.projectDir,
		projectTrusted: false,
	});
	assert.equal(resolved.kind, "approval");
	if (resolved.kind !== "approval") return;
	assert.equal(resolved.reason, "project");
	assert.equal("code" in resolved, false);
	fs.writeFileSync(filePath, 'return "after";');
	const approved = approveWorkflowSource(resolved);
	assert.equal(approved.kind, "ready");
	if (approved.kind === "ready") assert.equal(approved.code, 'return "after";');
});

test("approval is invalidated if the workflow path is swapped to a different target", (t) => {
	const dirs = fixture(t);
	const filePath = path.join(dirs.projectDir, "swap.js");
	const movedPath = path.join(dirs.projectDir, "swap-original.js");
	const externalFile = path.join(dirs.externalDir, "replacement.js");
	fs.writeFileSync(filePath, "return 1;");
	fs.writeFileSync(externalFile, "return 2;");
	const resolved = resolveWorkflowSource({
		params: { name: "swap" },
		cwd: dirs.projectRoot,
		sharedDir: dirs.sharedDir,
		projectDir: dirs.projectDir,
		projectTrusted: false,
	});
	assert.equal(resolved.kind, "approval");
	if (resolved.kind !== "approval") return;
	fs.renameSync(filePath, movedPath);
	fs.symlinkSync(externalFile, filePath);
	const approved = approveWorkflowSource(resolved);
	assert.equal(approved.kind, "error");
	if (approved.kind === "error") assert.match(approved.error, /target changed/);
});

test("trusted projects may execute their own workflow files", (t) => {
	const dirs = fixture(t);
	const filePath = path.join(dirs.projectDir, "trusted.js");
	fs.writeFileSync(filePath, "return 1;");
	const resolved = resolveWorkflowSource({
		params: { scriptPath: filePath },
		cwd: dirs.projectRoot,
		sharedDir: dirs.sharedDir,
		projectDir: dirs.projectDir,
		projectTrusted: true,
	});
	assert.equal(resolved.kind, "ready");
});

test("symlink escapes are classified by their canonical external target", (t) => {
	const dirs = fixture(t);
	const externalFile = path.join(dirs.externalDir, "outside.js");
	const link = path.join(dirs.projectRoot, "linked.js");
	fs.writeFileSync(externalFile, "return 2;");
	fs.symlinkSync(externalFile, link);
	const resolved = resolveWorkflowSource({
		params: { scriptPath: link },
		cwd: dirs.projectRoot,
		sharedDir: dirs.sharedDir,
		projectDir: dirs.projectDir,
		projectTrusted: true,
	});
	assert.equal(resolved.kind, "approval");
	if (resolved.kind === "approval") assert.equal(resolved.reason, "external");
});

test("explicitly allowlisted external directories resolve without a prompt", (t) => {
	const dirs = fixture(t);
	const externalFile = path.join(dirs.externalDir, "allowed.js");
	fs.writeFileSync(externalFile, "return 3;");
	const resolved = resolveWorkflowSource({
		params: { scriptPath: externalFile },
		cwd: dirs.projectRoot,
		sharedDir: dirs.sharedDir,
		projectDir: dirs.projectDir,
		projectTrusted: false,
		allowedScriptDirs: [dirs.externalDir],
	});
	assert.equal(resolved.kind, "ready");
});

test("workflow names reject traversal instead of silently rewriting it", (t) => {
	const dirs = fixture(t);
	const resolved = resolveWorkflowSource({
		params: { name: "../unsafe" },
		cwd: dirs.projectRoot,
		sharedDir: dirs.sharedDir,
		projectDir: dirs.projectDir,
		projectTrusted: true,
	});
	assert.equal(resolved.kind, "error");
	if (resolved.kind === "error") assert.match(resolved.error, /Invalid workflow name/);
});

test("path containment rejects sibling-prefix tricks", () => {
	assert.equal(pathIsWithin("/tmp/project-two/file.js", "/tmp/project"), false);
	assert.equal(pathIsWithin("/tmp/project/nested/file.js", "/tmp/project"), true);
});
