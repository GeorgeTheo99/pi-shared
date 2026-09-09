import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createSubagentWorktree, finishSubagentWorktree, validateWorktreeRequest } from "../extensions/_shared/subagent-worktree.ts";

function git(cwd: string, ...args: string[]) {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }).trim();
}
function repo(t: TestContext) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-test-")));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	git(root, "init");
	git(root, "config", "user.email", "fixture@example.invalid");
	git(root, "config", "user.name", "Fixture");
	git(root, "config", "commit.gpgsign", "false");
	fs.writeFileSync(path.join(root, "file.txt"), "base\n");
	fs.writeFileSync(path.join(root, "binary.bin"), Buffer.from([0, 1, 2]));
	fs.writeFileSync(path.join(root, ".gitignore"), "ignored/\n");
	git(root, "add", ".");
	git(root, "commit", "-m", "base");
	return root;
}

test("dirty parents require explicit committed base and never copy parent changes", async (t) => {
	const root = repo(t);
	fs.writeFileSync(path.join(root, "file.txt"), "dirty parent\n");
	fs.writeFileSync(path.join(root, "secret.env"), "ARBITRARY_PRIVATE_CONTENT");
	await assert.rejects(createSubagentWorktree({ cwd: root }), /Parent checkout is dirty.*baseRevision/);
	const workspace = await createSubagentWorktree({ cwd: root, baseRevision: "HEAD" });
	assert.equal(workspace.parentDirty, true);
	assert.equal(fs.readFileSync(path.join(workspace.path, "file.txt"), "utf8"), "base\n");
	assert.equal(fs.existsSync(path.join(workspace.path, "secret.env")), false);
	assert.equal(git(workspace.path, "rev-parse", "HEAD"), workspace.base);
	assert.equal(git(root, "status", "--porcelain"), "M file.txt\n?? secret.env");
	assert.equal(fs.statSync(workspace.artifactDirectory).mode & 0o777, 0o700);
});

test("concurrent independent workers have unique detached paths and leave parent untouched", async (t) => {
	const root = repo(t);
	const [a, b] = await Promise.all([createSubagentWorktree({ cwd: root }), createSubagentWorktree({ cwd: root })]);
	assert.notEqual(a.path, b.path);
	for (const [workspace, text] of [[a, "first"], [b, "second"]] as const) {
		assert.equal(git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD");
		fs.writeFileSync(path.join(workspace.path, "file.txt"), text);
	}
	assert.equal(fs.readFileSync(path.join(a.path, "file.txt"), "utf8"), "first");
	assert.equal(fs.readFileSync(path.join(b.path, "file.txt"), "utf8"), "second");
	assert.equal(git(root, "status", "--porcelain"), "");
});

test("inventory includes tracked, staged-only, untracked, ignored, binary and unusual filenames without copying secrets", async (t) => {
	const root = repo(t);
	const workspace = await createSubagentWorktree({ cwd: root });
	fs.writeFileSync(path.join(workspace.path, "file.txt"), "staged-only\n");
	git(workspace.path, "add", "file.txt");
	fs.writeFileSync(path.join(workspace.path, "file.txt"), "base\n");
	fs.writeFileSync(path.join(workspace.path, "binary.bin"), Buffer.from([0, 3, 4]));
	fs.writeFileSync(path.join(workspace.path, "untracked\n\tfile"), "ARBITRARY_PRIVATE_CONTENT");
	fs.mkdirSync(path.join(workspace.path, "ignored"));
	fs.writeFileSync(path.join(workspace.path, "ignored", "token"), "IGNORED_PRIVATE_CONTENT");
	const report = await finishSubagentWorktree(workspace);
	assert.equal(report.inventory.status, "complete");
	assert.deepEqual(report.inventory.tracked, ["binary.bin", "file.txt"]);
	assert.deepEqual(report.inventory.untracked, ["untracked\n\tfile"]);
	assert.deepEqual(report.inventory.ignored, ["ignored/token"]);
	assert.deepEqual(report.inventory.binaryTracked, ["binary.bin"]);
	assert.equal(report.patch.status, "available");
	const patch = fs.readFileSync(report.patch.path!, "utf8");
	assert.match(patch, /Binary files/);
	assert.doesNotMatch(patch + JSON.stringify(report), /ARBITRARY_PRIVATE_CONTENT|IGNORED_PRIVATE_CONTENT|GIT binary patch/);
	assert.equal(fs.statSync(report.patch.path!).mode & 0o777, 0o600);
	assert.equal(fs.statSync(report.inventory.artifact!).mode & 0o777, 0o600);
	assert.equal(report.retained, true);
	assert.equal(fs.existsSync(workspace.path), true);
});

test("clean worker commits and even reset detached history are retained, never cleaned up", async (t) => {
	const root = repo(t);
	const workspace = await createSubagentWorktree({ cwd: root });
	fs.writeFileSync(path.join(workspace.path, "file.txt"), "worker commit\n");
	git(workspace.path, "commit", "-am", "worker");
	const head = git(workspace.path, "rev-parse", "HEAD");
	assert.equal(git(workspace.path, "status", "--porcelain"), "");
	const report = await finishSubagentWorktree(workspace);
	assert.equal(report.head, head);
	assert.notEqual(head, report.base);
	assert.deepEqual(report.inventory.tracked, ["file.txt"]);
	assert.equal(report.retained, true);
	assert.match(report.retentionReason, /Automatic cleanup is disabled/);
	assert.equal(git(workspace.path, "rev-parse", "HEAD"), head);
	assert.equal(git(root, "rev-parse", "HEAD"), report.base);
	git(workspace.path, "reset", "--hard", report.base);
	assert.ok(git(workspace.path, "reflog").includes("worker"));
	assert.equal((await finishSubagentWorktree(workspace)).retained, true);
	assert.equal(fs.existsSync(workspace.path), true);
});

test("unowned paths and replaced workspace identities fail closed with zero deletion", async (t) => {
	const root = repo(t);
	const workspace = await createSubagentWorktree({ cwd: root });
	await assert.rejects(finishSubagentWorktree({ ...workspace, path: root }), /Refusing unowned/);
	const moved = `${workspace.path}-moved`;
	fs.renameSync(workspace.path, moved);
	fs.symlinkSync(root, workspace.path);
	const report = await finishSubagentWorktree(workspace);
	assert.equal(report.inventory.status, "incomplete");
	assert.equal(report.head, undefined);
	assert.equal(report.patch.status, "omitted");
	assert.ok(fs.existsSync(moved));
	assert.equal(fs.readFileSync(path.join(root, "file.txt"), "utf8"), "base\n");
});

test("patch floods are omitted, inline inventory is bounded with complete artifact", async (t) => {
	const root = repo(t);
	const workspace = await createSubagentWorktree({ cwd: root });
	fs.writeFileSync(path.join(workspace.path, "file.txt"), "x".repeat(300_000));
	for (let i = 0; i < 110; i++) fs.writeFileSync(path.join(workspace.path, `new-${i}`), "private");
	const report = await finishSubagentWorktree(workspace);
	assert.equal(report.patch.status, "omitted");
	assert.equal(report.patch.path, undefined);
	assert.equal(fs.existsSync(path.join(workspace.artifactDirectory, "tracked.patch")), false);
	assert.equal(report.inventory.inlineTruncated, true);
	assert.equal(report.inventory.untracked.length, 100);
	assert.equal(JSON.parse(fs.readFileSync(report.inventory.artifact!, "utf8")).untracked.length, 110);
});

test("bad revisions, unborn/non-Git repos, and pre-aborted requests never fall back to HEAD", async (t) => {
	const root = repo(t);
	await assert.rejects(createSubagentWorktree({ cwd: root, baseRevision: "missing-ref" }), /Git operation failed/);
	await assert.rejects(createSubagentWorktree({ cwd: root, baseRevision: "--help" }), /Git operation failed/);
	const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-nongit-"));
	t.after(() => fs.rmSync(nonGit, { recursive: true, force: true }));
	await assert.rejects(createSubagentWorktree({ cwd: nonGit }));
	git(nonGit, "init");
	await assert.rejects(createSubagentWorktree({ cwd: nonGit }));
	await assert.rejects(createSubagentWorktree({ cwd: root, signal: AbortSignal.abort() }));
	assert.equal(git(root, "worktree", "list", "--porcelain").match(/worktree /g)?.length, 1);
});

test("explicit older bases and linked-parent common-directory identity are honored", async (t) => {
	const root = repo(t);
	const base = git(root, "rev-parse", "HEAD");
	fs.writeFileSync(path.join(root, "file.txt"), "newer parent commit\n");
	git(root, "commit", "-am", "newer parent");
	const linkedParent = path.join(root, ".git", "fixture-linked-parent");
	git(root, "worktree", "add", "--detach", linkedParent, "HEAD");
	fs.writeFileSync(path.join(linkedParent, "file.txt"), "dirty linked parent\n");
	const workspace = await createSubagentWorktree({ cwd: linkedParent, baseRevision: base });
	assert.equal(workspace.base, base);
	assert.ok(workspace.artifactDirectory.startsWith(path.join(root, ".git", "pi-subagent-worktree-")));
	assert.equal(workspace.parentPath, linkedParent);
	assert.equal(fs.readFileSync(path.join(workspace.path, "file.txt"), "utf8"), "base\n");
	assert.equal((await finishSubagentWorktree(workspace)).inventory.status, "complete");
	assert.equal(fs.readFileSync(path.join(linkedParent, "file.txt"), "utf8"), "dirty linked parent\n");
});

test("tracked patch content stays in private artifacts, never in returned metadata", async (t) => {
	const root = repo(t);
	const workspace = await createSubagentWorktree({ cwd: root });
	fs.writeFileSync(path.join(workspace.path, "file.txt"), "PRIVATE_SOURCE_SENTINEL\n");
	const report = await finishSubagentWorktree(workspace);
	assert.equal(report.patch.status, "available");
	assert.doesNotMatch(JSON.stringify(report), /PRIVATE_SOURCE_SENTINEL/);
	assert.match(fs.readFileSync(report.patch.path!, "utf8"), /PRIVATE_SOURCE_SENTINEL/);
});

test("non-UTF-8 filenames are incomplete evidence, not silently corrupted paths", async (t) => {
	const root = repo(t);
	const workspace = await createSubagentWorktree({ cwd: root });
	try {
		fs.writeFileSync(Buffer.concat([Buffer.from(`${workspace.path}/bad-`), Buffer.from([0xff])]), "private");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EILSEQ") { t.skip("Filesystem rejects non-UTF-8 filenames"); return; }
		throw error;
	}
	const report = await finishSubagentWorktree(workspace);
	assert.equal(report.inventory.status, "incomplete");
	assert.equal(report.patch.status, "omitted");
	assert.equal(report.retained, true);
});

test("inherited Git index redirection is refused before starting a worker", async (t) => {
	const root = repo(t);
	const previous = process.env.GIT_INDEX_FILE;
	try {
		process.env.GIT_INDEX_FILE = path.join(root, ".git", "index");
		await assert.rejects(createSubagentWorktree({ cwd: root }), /override environment variables/);
	} finally {
		if (previous === undefined) delete process.env.GIT_INDEX_FILE;
		else process.env.GIT_INDEX_FILE = previous;
	}
	assert.equal(git(root, "status", "--porcelain"), "");
	assert.equal(git(root, "worktree", "list", "--porcelain").match(/worktree /g)?.length, 1);
});

test("worktree arguments reject every unsupported mode rather than silently ignoring isolation", () => {
	const valid = { isolation: "worktree", agent: "worker", task: "edit" };
	validateWorktreeRequest(valid);
	validateWorktreeRequest({ agent: "scout" });
	for (const overrides of [{ interactive: true }, { background: true }, { tasks: [] }, { chain: [] }, { jobAction: "status" }, { agent: "scout" }]) {
		assert.throws(() => validateWorktreeRequest({ ...valid, ...overrides }), /supports only/);
	}
	assert.throws(() => validateWorktreeRequest({ baseRevision: "HEAD" }), /requires isolation/);
	assert.throws(() => validateWorktreeRequest({ ...valid, isolation: "sandbox" }), /Unsupported isolation/);
	assert.throws(() => validateWorktreeRequest({ ...valid, baseRevision: " " }), /committed Git revision/);
});
