// Additional offline integration/fault-injection checks. Copied into the owned
// validation tree beside generated loader.mjs; do not run directly from this dir.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createLoader } from "./loader.mjs";
import { createLoader as createBaselineLoader } from "./baseline-loader.mjs";

let root;
let agentDir;
let cwd;
beforeEach(() => {
	root = fs.mkdtempSync(join(tmpdir(), "pi-context-fixture-"));
	agentDir = join(root, "agent");
	cwd = join(root, "project", "child");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const put = (path, content) => {
	fs.mkdirSync(dirname(path), { recursive: true });
	fs.writeFileSync(path, content);
	return path;
};
const load = (overrides = {}, factory = createLoader) => factory(overrides)({ agentDir, cwd })
	.filter((file) => file.path.startsWith(`${root}${sep}`));
const contents = (overrides) => load(overrides).map((file) => file.content);
function git(dir, ...args) {
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
	Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "no-global-config") });
	return execFileSync("git", ["-c", `core.hooksPath=${join(root, "no-hooks")}`,
		"-c", "commit.gpgSign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
	{ cwd: dir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function repo() {
	const main = join(root, "main");
	fs.mkdirSync(main);
	git(main, "init", "--template=", "--initial-branch=main");
	put(join(root, "AGENTS.md"), "above-main");
	put(join(main, "AGENTS.md"), "main");
	git(main, "add", "AGENTS.md");
	git(main, "commit", "-m", "Local fixture");
	return main;
}
function worktree(main, target) {
	git(main, "worktree", "add", "--detach", target, "HEAD");
	cwd = join(target, "child");
	fs.mkdirSync(cwd, { recursive: true });
	put(join(cwd, "AGENTS.md"), "child");
	return target;
}

test("negative control: pinned upstream retains duplicate aliases; patch does not", () => {
	const target = put(join(root, "shared.md"), "shared");
	fs.symlinkSync(target, join(agentDir, "AGENTS.md"));
	fs.symlinkSync(target, join(cwd, "AGENTS.md"));
	assert.equal(load({}, createBaselineLoader).length, 2);
	assert.deepEqual(load(), [{ path: join(cwd, "AGENTS.md"), content: "shared" }]);
});

test("negative control: pinned upstream loses changed content at the same lexical path", () => {
	agentDir = cwd;
	const target = join(cwd, "AGENTS.md");
	function changingRead() {
		put(target, "before");
		let reads = 0;
		return { readFileSync: (path, ...args) => {
			const content = fs.readFileSync(path, ...args);
			if (path === target && ++reads === 1) put(target, "after");
			return content;
		} };
	}
	assert.deepEqual(load(changingRead(), createBaselineLoader).map((file) => file.content), ["before"]);
	assert.deepEqual(contents(changingRead()), ["before", "after"]);
});

test("three aliases retain the leaf occurrence, not the first ancestor", () => {
	const shared = put(join(root, "shared.md"), "shared");
	for (const dir of [agentDir, join(root, "project"), cwd]) fs.symlinkSync(shared, join(dir, "AGENTS.md"));
	assert.deepEqual(load(), [{ path: join(cwd, "AGENTS.md"), content: "shared" }]);
});

test("dedup key includes loaded content and keeps the last occurrence of each version", () => {
	const shared = put(join(root, "shared.md"), "A");
	const parent = join(root, "project", "AGENTS.md");
	const leaf = join(cwd, "AGENTS.md");
	for (const path of [join(agentDir, "AGENTS.md"), parent, leaf]) fs.symlinkSync(shared, path);
	const result = load({ readFileSync: (path, ...args) => {
		const value = fs.readFileSync(path, ...args);
		if (path === join(agentDir, "AGENTS.md")) put(shared, "B");
		if (path === leaf) put(shared, "A");
		return value;
	} });
	// Reads: global A, leaf B, parent A. Output order is global, parent, leaf.
	assert.deepEqual(result, [{ path: parent, content: "A" }, { path: leaf, content: "B" }]);
});

test("BOM differences collapse when the actual loaded strings are identical", () => {
	agentDir = cwd;
	const target = put(join(cwd, "AGENTS.md"), "\uFEFFsame");
	const result = load({ readFileSync: (path, ...args) => {
		const value = fs.readFileSync(path, ...args);
		if (path === target) put(target, "same");
		return value;
	} });
	assert.deepEqual(result, [{ path: target, content: "same" }]);
});

test("distinct hardlinked paths are not collapsed by inode or content", () => {
	const source = put(join(agentDir, "AGENTS.md"), "same");
	const target = join(cwd, "AGENTS.md");
	fs.linkSync(source, target);
	assert.deepEqual(load().map((file) => file.path), [source, target]);
});

test("directory candidates and dangling links still fall through in priority order", () => {
	fs.mkdirSync(join(cwd, "AGENTS.override.md"));
	fs.symlinkSync(join(root, "missing"), join(cwd, "AGENTS.md"));
	put(join(cwd, "AGENTS.MD"), "fallback");
	assert.deepEqual(contents(), ["fallback"]);
});

test("unreadable candidate warns and falls back, without changing ancestors", () => {
	const unreadable = put(join(cwd, "AGENTS.override.md"), "not readable");
	put(join(cwd, "AGENTS.md"), "fallback");
	put(join(root, "AGENTS.md"), "ancestor");
	const warnings = [];
	const result = contents({
		readFileSync: (path, ...args) => {
			if (path === unreadable) throw Object.assign(new Error("fixture permission denied"), { code: "EACCES" });
			return fs.readFileSync(path, ...args);
		},
		console: { error: (value) => warnings.push(value) },
	});
	assert.deepEqual(result, ["ancestor", "fallback"]);
	assert.equal(warnings.length, 1);
	assert.ok(warnings[0].includes(`Could not read ${unreadable}`));
});

test("realpath failure falls back to lexical identity without dropping readable aliases", () => {
	const shared = put(join(root, "shared.md"), "shared");
	fs.symlinkSync(shared, join(agentDir, "AGENTS.md"));
	fs.symlinkSync(shared, join(cwd, "AGENTS.md"));
	assert.equal(load({ realpathSync: () => { throw new Error("fixture resolution failure"); } }).length, 2);
});

test("nested Git worktree same-name shadowing and ancestor order are unchanged", () => {
	const main = repo();
	worktree(main, join(main, "nested"));
	put(join(agentDir, "AGENTS.md"), "global");
	assert.deepEqual(contents(), ["global", "above-main", "main", "child"]);
	assert.ok(!load().some((file) => file.path === join(main, "AGENTS.md")));
});

test("nested Git worktree with no root context retains main-repo rules", () => {
	const main = repo();
	const tree = worktree(main, join(main, "nested"));
	fs.unlinkSync(join(tree, "AGENTS.md"));
	assert.deepEqual(contents(), ["above-main", "main", "child"]);
	assert.ok(load().some((file) => file.path === join(main, "AGENTS.md")));
});

test("nested Git worktree different-name context does not shadow main-repo rules", () => {
	const main = repo();
	const tree = worktree(main, join(main, "nested"));
	put(join(tree, "AGENTS.override.md"), "override");
	assert.deepEqual(contents(), ["above-main", "main", "override", "child"]);
});

test("symlinked cwd retains existing nested-worktree shadowing", () => {
	const main = repo();
	const tree = worktree(main, join(main, "nested"));
	const alias = join(root, "main-alias");
	fs.symlinkSync(main, alias, "junction");
	cwd = join(alias, "nested", "child");
	assert.deepEqual(contents(), ["above-main", "main", "child"]);
	assert.ok(load().some((file) => file.path === join(alias, "nested", "AGENTS.md")));
	assert.ok(fs.existsSync(join(tree, ".git")));
});

test("sibling Git worktree keeps its own normal ancestry", () => {
	const main = repo();
	worktree(main, join(root, "sibling"));
	assert.deepEqual(contents(), ["above-main", "main", "child"]);
	assert.ok(!load().some((file) => file.path === join(main, "AGENTS.md")));
});

test("ordinary Git repository still inherits ancestor context", () => {
	const main = repo();
	cwd = join(main, "child");
	fs.mkdirSync(cwd);
	put(join(cwd, "AGENTS.md"), "child");
	assert.deepEqual(contents(), ["above-main", "main", "child"]);
});

test("bare Git worktree container rules are not treated as main-repo rules", () => {
	const main = repo();
	const container = join(root, "container");
	fs.mkdirSync(container);
	const bare = join(container, ".bare");
	git(root, "clone", "--bare", "--no-hardlinks", main, bare);
	put(join(container, "AGENTS.md"), "container");
	worktree(bare, join(container, "tree"));
	assert.deepEqual(contents(), ["above-main", "container", "main", "child"]);
});

test("local Git submodule does not shadow superproject context", () => {
	const main = repo();
	const superproject = join(root, "superproject");
	fs.mkdirSync(superproject);
	git(superproject, "init", "--template=", "--initial-branch=main");
	put(join(superproject, "AGENTS.md"), "superproject");
	git(superproject, "add", "AGENTS.md");
	git(superproject, "commit", "-m", "Local superproject fixture");
	git(superproject, "-c", "protocol.file.allow=always", "submodule", "add", main, "sub");
	cwd = join(superproject, "sub", "child");
	fs.mkdirSync(cwd);
	put(join(cwd, "AGENTS.md"), "child");
	assert.deepEqual(contents(), ["above-main", "superproject", "main", "child"]);
});

test("invalid gitdir retains ordinary filesystem ancestor discovery", () => {
	put(join(cwd, ".git"), "gitdir: ../nonexistent\n");
	put(join(root, "AGENTS.md"), "ancestor");
	put(join(cwd, "AGENTS.md"), "child");
	assert.deepEqual(contents(), ["ancestor", "child"]);
});
