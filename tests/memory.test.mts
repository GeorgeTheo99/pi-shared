import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const memoryDir = mkdtempSync(join(tmpdir(), "pi-memory-test-"));
process.env.PI_MEMORY_DIR = memoryDir;
const extensionUrl = new URL("../extensions/memory/index.ts", import.meta.url).href;
const loaderUrl = new URL("./fixtures/research_test_loader.mjs", import.meta.url).href;
const { default: memoryExtension } = await import(extensionUrl);

const tools = new Map<string, any>();
const handlers = new Map<string, any>();
memoryExtension({
	on(event: string, handler: any) {
		handlers.set(event, handler);
	},
	registerCommand() {},
	registerTool(tool: any) {
		tools.set(tool.name, tool);
	},
} as any);

const run = promisify(execFile);
const projectDirs: string[] = [];
function newProject() {
	const dir = mkdtempSync(join(tmpdir(), "pi-memory-project-"));
	projectDirs.push(dir);
	return dir;
}

const call = (name: string, params: any, cwd: string, signal?: AbortSignal) =>
	tools.get(name).execute("memory-test", params, signal, () => undefined, { cwd });
const read = async (cwd: string, path?: string) => (await call("memory_read", path ? { path } : {}, cwd)).details;
const setSection = (cwd: string, section: string, content: string, extra: any = {}) =>
	call("memory_write", { action: "set_section", section, content, ...extra }, cwd);
const promptFor = async (cwd: string) =>
	(await handlers.get("before_agent_start")({ systemPrompt: "BASE", systemPromptOptions: { cwd } })).systemPrompt as string;
const newSession = () => handlers.get("session_start")({});
const today = new Date().toISOString().slice(0, 10);

test.after(() => {
	rmSync(memoryDir, { recursive: true, force: true });
	for (const dir of projectDirs) rmSync(dir, { recursive: true, force: true });
});

test("set_section adds, replaces and removes dated sections", async () => {
	const cwd = newProject();
	await setSection(cwd, "Deploy", "- Push to staging first.");
	await setSection(cwd, "## Ports", "- API on 8121.");
	await setSection(cwd, "deploy", "- Push to `staging`, then promote.");
	const { document, path } = await read(cwd);
	assert.equal(document, `## Deploy\n<!-- updated: ${today} -->\n- Push to \`staging\`, then promote.\n\n## Ports\n<!-- updated: ${today} -->\n- API on 8121.\n`);
	assert.match(path, /\.md$/);
	assert.equal(statSync(path).mode & 0o777, 0o600);

	await setSection(cwd, "Ports", "");
	assert.doesNotMatch((await read(cwd)).document, /Ports/);
	await assert.rejects(setSection(cwd, "Missing", ""), /section not found/);
});

test("section content cannot smuggle in new sections, but fenced comments are fine", async () => {
	const cwd = newProject();
	await assert.rejects(setSection(cwd, "A", "text\n## B\nmore"), /cannot contain "## " headings/);
	await setSection(cwd, "Setup", "```sh\n## not a heading\nmake\n```");
	await assert.rejects(setSection(cwd, "not a heading", ""), /section not found/);
	assert.match((await read(cwd)).document, /## not a heading\nmake\n```\n$/);
});

test("replace edits exactly one occurrence and re-dates its section", async () => {
	const cwd = newProject();
	const { path } = await read(cwd);
	writeFileSync(path, "Preamble kept.\n\n## Services\n<!-- updated: 2020-01-01 -->\n- Gateway on 9111.\n- Worker on 8890.\n\n## Other\n<!-- updated: 2020-01-01 -->\n- Worker restarts nightly.\n");
	await call("memory_write", { action: "replace", old_text: "9111", new_text: "9112" }, cwd);
	const document = (await read(cwd)).document;
	assert.match(document, /^Preamble kept\.\n\n## Services\n<!-- updated: \d{4}-\d{2}-\d{2} -->\n- Gateway on 9112\./);
	assert.match(document, new RegExp(`## Services\\n<!-- updated: ${today} -->`));
	assert.match(document, /## Other\n<!-- updated: 2020-01-01 -->/);

	await assert.rejects(call("memory_write", { action: "replace", old_text: "Worker", new_text: "x" }, cwd), /more than once/);
	await assert.rejects(call("memory_write", { action: "replace", old_text: "absent", new_text: "x" }, cwd), /not found/);
	await call("memory_write", { action: "replace", old_text: "- Worker on 8890.\n", new_text: "" }, cwd);
	assert.doesNotMatch((await read(cwd)).document, /8890/);
});

test("growth past the limit is refused, shrinking an oversized file is allowed", async () => {
	const cwd = newProject();
	await setSection(cwd, "Big", "x".repeat(11_900));
	const before = (await read(cwd)).document;
	await assert.rejects(setSection(cwd, "More", "y".repeat(200)), /limit is 12000/);
	assert.equal((await read(cwd)).document, before);

	const { path } = await read(cwd);
	writeFileSync(path, `## Big\n${"x".repeat(13_000)}\n`);
	await setSection(cwd, "Big", "x".repeat(12_500));
	await assert.rejects(setSection(cwd, "Big", "x".repeat(12_600)), /limit is 12000/);
});

test("memory_write rejects common credential formats", async () => {
	const cwd = newProject();
	const jwtPart = "eyJhbGciOiJIUzI1NiJ9";
	for (const secret of [
		`ghp_${"a".repeat(36)}`,
		`github_pat_${"A1".repeat(20)}`,
		"AKIAIOSFODNN7EXAMPLE",
		`${jwtPart}.${jwtPart.replace("hbGci", "zdWIi")}.signature_abc123`,
		`Authorization: Bearer ${"x".repeat(32)}`,
		"postgres://app:hunter2@db.internal/app",
		"api_key = abc",
	]) {
		await assert.rejects(setSection(cwd, "Auth", `uses ${secret}`), /looks like a secret/, secret);
	}
	await setSection(cwd, "Auth", "Token is stored in the Keychain item pi-gh; see https://example.com/docs");
	await assert.rejects(call("memory_write", { action: "replace", old_text: "pi-gh", new_text: `ghp_${"b".repeat(36)}` }, cwd), /looks like a secret/);
});

test("writes keep a private rolling backup of the previous version", async () => {
	const cwd = newProject();
	await setSection(cwd, "A", "first");
	const { path } = await read(cwd);
	const previous = readFileSync(path, "utf8");
	await setSection(cwd, "B", "second");
	assert.equal(readFileSync(`${path}.bak`, "utf8"), previous);
	assert.equal(statSync(`${path}.bak`).mode & 0o777, 0o600);
});

test("an aborted write does not modify the memory", async () => {
	const cwd = newProject();
	await setSection(cwd, "A", "kept");
	const before = (await read(cwd)).document;
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(call("memory_write", { action: "set_section", section: "B", content: "dropped" }, cwd, controller.signal), /abort/i);
	assert.equal((await read(cwd)).document, before);
});

test("path targets the repository a fact is about", async () => {
	const workspace = newProject();
	const repo = join(workspace, "repo");
	mkdirSync(join(repo, "src"), { recursive: true });
	await run("git", ["-C", repo, "init", "-q"]);
	await setSection(workspace, "Gateway", "- Runs on 9111.", { path: "repo/src" });
	assert.match((await read(repo)).document, /Runs on 9111/);
	assert.equal((await read(workspace)).document, "");
	assert.match((await read(workspace, "repo")).document, /Runs on 9111/);
	await assert.rejects(read(workspace, "missing"), /does not exist/);
	assert.match(await promptFor(workspace), /not a git repository[^\n]*pass `path`/);
	assert.doesNotMatch(await promptFor(repo), /not a git repository/);
});

test("linked worktrees share the main checkout's memory", async () => {
	const repo = newProject();
	const worktree = join(newProject(), "wt");
	await run("git", ["-C", repo, "init", "-q"]);
	await run("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
	await run("git", ["-C", repo, "worktree", "add", "-q", "--detach", worktree]);
	assert.equal((await read(worktree)).path, (await read(repo)).path);
});

test("the prompt is a per-session snapshot with policy, size and contents", async () => {
	const cwd = newProject();
	await newSession();
	assert.match(await promptFor(cwd), /^BASE\n\n## Project memory \(machine-local, untrusted\)[\s\S]*curated reference, not a log[\s\S]*Memory \(0\/12000 characters\):\n\n\(empty\)$/);

	await setSection(cwd, "Deploy", "- Staging first.");
	assert.match(await promptFor(cwd), /\(empty\)$/, "mid-session writes do not change the prompt");
	await newSession();
	const prompt = await promptFor(cwd);
	assert.match(prompt, /## Deploy\n<!-- updated: [\d-]+ -->\n- Staging first\.$/);
	await handlers.get("session_compact")({});
	await setSection(cwd, "Deploy", "- Staging, then production.");
	assert.match(await promptFor(cwd), /then production\.$/, "compaction refreshes the snapshot");
});

test("the prompt flags a legacy JSON store and truncates hand-edited oversized files", async () => {
	const cwd = newProject();
	await newSession();
	const { path } = await read(cwd);
	writeFileSync(path.replace(/\.md$/, ".json"), "{}");
	writeFileSync(path, `## Big\n${"x".repeat(13_000)}\n`);
	const prompt = await promptFor(cwd);
	assert.match(prompt, /legacy JSON memory store at .*\.json is not loaded/);
	assert.match(prompt, /\[Truncated: the file is 13008 characters; the limit is 12000\./);
	assert.equal(existsSync(`${path}.lock`), false);
});

test("concurrent writers in separate processes do not lose updates", { timeout: 60_000 }, async () => {
	const cwd = newProject();
	const writers = 4;
	const writesPerProcess = 6;
	const script = `
		const { default: memoryExtension } = await import(${JSON.stringify(extensionUrl)});
		let write;
		memoryExtension({ on() {}, registerCommand() {}, registerTool(tool) { if (tool.name === "memory_write") write = tool; } });
		for (let i = 0; i < ${writesPerProcess}; i++) {
			await write.execute("child", { action: "set_section", section: \`writer \${process.argv[1]} item \${i}\`, content: "fact" }, undefined, () => undefined, { cwd: ${JSON.stringify(cwd)} });
		}`;
	await Promise.all(Array.from({ length: writers }, (_, writer) =>
		run(process.execPath, ["--no-warnings", "--experimental-loader", loaderUrl, "--input-type=module", "-e", script, String(writer)], {
			env: { ...process.env, PI_MEMORY_DIR: memoryDir },
		})));
	assert.equal((await read(cwd)).document.match(/^## writer /gm)?.length, writers * writesPerProcess);
});

test("unclosed code fences are refused so later sections cannot be swallowed", async () => {
	const cwd = newProject();
	await setSection(cwd, "A", "first");
	await setSection(cwd, "B", "second");
	await assert.rejects(setSection(cwd, "A", "```sh\nmake"), /unclosed code fence/);
	await assert.rejects(call("memory_write", { action: "replace", old_text: "first", new_text: "```sh\nmake" }, cwd), /unclosed code fence/);
	await setSection(cwd, "A", "```md\n~~~\n## inner\n~~~\n```");
	assert.deepEqual([...(await read(cwd)).document.matchAll(/^## (.+)$/gm)].map((m) => m[1]), ["A", "inner", "B"]);
	await setSection(cwd, "B", "still separate");
	assert.match((await read(cwd)).document, /## B\n<!-- updated: [\d-]+ -->\nstill separate\n$/);

	const { path } = await read(cwd);
	writeFileSync(path, "## A\n```\nopen\n\n## B\nx\n");
	await assert.rejects(setSection(cwd, "C", "new"), /unclosed code fence; close it with replace/);
	await call("memory_write", { action: "replace", old_text: "open\n", new_text: "open\n```\n" }, cwd);
	await setSection(cwd, "C", "new");
});

test("replace re-dates the section holding the edit by position", async () => {
	const cwd = newProject();
	const { path } = await read(cwd);
	writeFileSync(path, "## Dup\n<!-- updated: 2020-01-01 -->\none\n\n## Dup\n<!-- updated: 2020-01-01 -->\ntwo\n\n## S\n<!-- updated: 2020-01-01 -->\nthree\n");
	await call("memory_write", { action: "replace", old_text: "two", new_text: "2" }, cwd);
	await call("memory_write", { action: "replace", old_text: "## S\n", new_text: "## Renamed\n" }, cwd);
	assert.equal((await read(cwd)).document, `## Dup\n<!-- updated: 2020-01-01 -->\none\n\n## Dup\n<!-- updated: ${today} -->\n2\n\n## Renamed\n<!-- updated: ${today} -->\nthree\n`);
});

test("unrelated writes preserve hand-written formatting", async () => {
	const cwd = newProject();
	const { path } = await read(cwd);
	writeFileSync(path, "Intro\r\n\r\n## Code\r\n    indented block\r\nline with break  \r\nend\r\n");
	await setSection(cwd, "Other", "x");
	assert.equal((await read(cwd)).document, `Intro\n\n## Code\n    indented block\nline with break  \nend\n\n## Other\n<!-- updated: ${today} -->\nx\n`);
});

test("path accepts files and ~, and symlinked memory files stay symlinks", async () => {
	const repo = newProject();
	writeFileSync(join(repo, "file.txt"), "");
	await setSection(newProject(), "Via file", "x", { path: join(repo, "file.txt") });
	assert.match((await read(repo)).document, /Via file/);
	assert.equal((await read(repo, "~")).path, (await read(homedir())).path);

	const linked = newProject();
	const original = (await read(linked)).path;
	const target = join(newProject(), "real.md");
	writeFileSync(target, "## Kept\nx\n");
	symlinkSync(target, original);
	await setSection(linked, "New", "y");
	assert.equal(lstatSync(original).isSymbolicLink(), true);
	assert.match(readFileSync(target, "utf8"), /## Kept\nx\n\n## New/);
});

test("same-length edits to an oversized file are allowed", async () => {
	const cwd = newProject();
	const { path } = await read(cwd);
	writeFileSync(path, `## Big\n<!-- updated: 2020-01-01 -->\nfoo ${"x".repeat(12_100)}\n`);
	await call("memory_write", { action: "replace", old_text: "foo", new_text: "bar" }, cwd);
	assert.match((await read(cwd)).document, /bar x/);
});

test("a secret cannot be assembled across a replace boundary", async () => {
	const cwd = newProject();
	await setSection(cwd, "Auth", "token here");
	await assert.rejects(call("memory_write", { action: "replace", old_text: " here", new_text: "=abc" }, cwd), /looks like a secret/);
});

test("follow-up edge cases: dangling links, inline fences, nearby text, section deletes, CRLF", async () => {
	const dangling = newProject();
	const link = (await read(dangling)).path;
	symlinkSync(join(newProject(), "missing.md"), link);
	await assert.rejects(read(dangling), /dangling symlink/);
	await assert.rejects(setSection(dangling, "A", "x"), /dangling symlink/);
	assert.equal(lstatSync(link).isSymbolicLink(), true);
	assert.match(await promptFor(dangling), /Project memory \(unavailable\)[\s\S]*dangling symlink/);

	const cwd = newProject();
	const { path } = await read(cwd);
	writeFileSync(path, "## A\n<!-- updated: 2020-01-01 -->\n```js``` is inline\nThe token: lives in Keychain. Port 1\n\n## B\n<!-- updated: 2020-01-01 -->\nb\n");
	await setSection(cwd, "C", "cee");
	await call("memory_write", { action: "replace", old_text: "Port 1", new_text: "Port 2" }, cwd);
	await call("memory_write", { action: "replace", old_text: "## B\n<!-- updated: 2020-01-01 -->\nb\n\n", new_text: "" }, cwd);
	await call("memory_write", { action: "replace", old_text: "cee", new_text: "cee\r\nd" }, cwd);
	assert.equal((await read(cwd)).document, `## A\n<!-- updated: ${today} -->\n\`\`\`js\`\`\` is inline\nThe token: lives in Keychain. Port 2\n\n## C\n<!-- updated: ${today} -->\ncee\nd\n`);
});

test("re-dating never blocks shrinking an oversized file", async () => {
	const cwd = newProject();
	const { path } = await read(cwd);
	writeFileSync(path, `## Big\nshrink me ${"x".repeat(12_100)}\n`);
	await call("memory_write", { action: "replace", old_text: "shrink me ", new_text: "" }, cwd);
	assert.equal((await read(cwd)).document, `## Big\n${"x".repeat(12_100)}\n`);
});
