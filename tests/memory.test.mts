import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

const projectDirs: string[] = [];
function newProject() {
	const dir = mkdtempSync(join(tmpdir(), "pi-memory-project-"));
	projectDirs.push(dir);
	return dir;
}

const projectDir = newProject();
const call = (name: string, params: any, cwd = projectDir, signal?: AbortSignal) =>
	tools.get(name).execute("memory-test", params, signal, () => undefined, { cwd });
const promptFor = async (cwd: string) =>
	(await handlers.get("before_agent_start")({ systemPrompt: "BASE", systemPromptOptions: { cwd } })).systemPrompt as string;

async function storePathFor(cwd: string) {
	return (await call("memory_write", { action: "add", text: "seed" }, cwd)).details.path as string;
}

function writeStoreFile(path: string, memories: unknown[], extra: Record<string, unknown> = {}) {
	writeFileSync(path, JSON.stringify({ version: 1, project: { firstSeenAt: "2026-01-01T00:00:00.000Z" }, memories, ...extra }));
}

function memoryFixture(index: number, text: string) {
	const at = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
	return { id: `mem_fixture_${index}`, text, tags: ["fixture"], source: `source ${index}`, confidence: "medium", status: "active", createdAt: at, updatedAt: at };
}

test.after(() => {
	rmSync(memoryDir, { recursive: true, force: true });
	for (const dir of projectDirs) rmSync(dir, { recursive: true, force: true });
});

test("memory_write stores text at the limit without truncation", async () => {
	const text = "a".repeat(2_000);
	const added = await call("memory_write", { action: "add", text, source: "s".repeat(2_000) });
	assert.equal(added.details.memory.text, text);
	assert.equal(added.details.memory.source.length, 2_000);
});

test("memory_write measures length after whitespace normalization", async () => {
	const added = await call("memory_write", { action: "add", text: `  ${"word   ".repeat(400)}  ` });
	assert.equal(added.details.memory.text, Array(400).fill("word").join(" "));
});

test("memory_write rejects over-limit fields instead of truncating", async () => {
	const before = (await call("memory_read", { mode: "all" })).details.memories.length;
	await assert.rejects(call("memory_write", { action: "add", text: "a".repeat(2_001) }), /text is 2001 characters; the limit is 2000/);
	await assert.rejects(call("memory_write", { action: "add", text: "ok", source: "s".repeat(2_001) }), /source is 2001 characters/);

	const added = await call("memory_write", { action: "add", text: "original" });
	const id = added.details.memory.id;
	await assert.rejects(call("memory_write", { action: "update", id, text: "b".repeat(2_001) }), /text is 2001 characters/);
	await assert.rejects(call("memory_write", { action: "archive", id, reason: "r".repeat(2_001) }), /reason is 2001 characters/);

	const memories = (await call("memory_read", { mode: "all" })).details.memories;
	assert.equal(memories.length, before + 1);
	const stored = memories.find((memory: any) => memory.id === id);
	assert.equal(stored.text, "original");
	assert.equal(stored.status, "active");
});

test("unreadable stores are refused and never overwritten", async () => {
	for (const [content, reason] of [
		["{not json", /unreadable \(invalid JSON\)/],
		[JSON.stringify({ version: 2, memories: [] }), /unsupported version 2/],
		[JSON.stringify({ version: 1, memories: {} }), /memories is not an array/],
		["[]", /not a JSON object/],
	] as const) {
		const cwd = newProject();
		const path = await storePathFor(cwd);
		await call("memory_write", { action: "add", text: "creates a backup" }, cwd);
		const backup = readFileSync(`${path}.bak`, "utf8");
		writeFileSync(path, content);
		await assert.rejects(call("memory_write", { action: "add", text: "new fact" }, cwd), reason);
		await assert.rejects(call("memory_read", {}, cwd), reason);
		assert.equal(readFileSync(path, "utf8"), content);
		assert.equal(readFileSync(`${path}.bak`, "utf8"), backup);
		assert.equal(existsSync(`${path}.lock`), false);
		const prompt = await promptFor(cwd);
		assert.match(prompt, /## Project Memory \(unavailable\)/);
		assert.match(prompt, reason);
	}
});

test("malformed entries are preserved when other memories are written", async () => {
	const cwd = newProject();
	const path = await storePathFor(cwd);
	const malformed = { id: 42, note: "keep me" };
	writeStoreFile(path, [memoryFixture(1, "valid"), malformed]);
	await call("memory_write", { action: "add", text: "another" }, cwd);
	const stored = JSON.parse(readFileSync(path, "utf8"));
	assert.deepEqual(stored.memories.map((memory: any) => memory.text ?? memory.note), ["valid", "another", "keep me"]);
	assert.equal((await call("memory_read", { mode: "all" }, cwd)).details.memories.length, 2);
});

test("writes keep a private rolling backup of the previous version", async () => {
	const cwd = newProject();
	const path = await storePathFor(cwd);
	const previous = readFileSync(path, "utf8");
	await call("memory_write", { action: "add", text: "second" }, cwd);
	assert.equal(readFileSync(`${path}.bak`, "utf8"), previous);
	assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.equal(statSync(`${path}.bak`).mode & 0o777, 0o600);
});

test("mark_reviewed records its reason without replacing source", async () => {
	const cwd = newProject();
	const { id } = (await call("memory_write", { action: "add", text: "fact", source: "original evidence" }, cwd)).details.memory;
	const reviewed = (await call("memory_write", { action: "mark_reviewed", id, reason: "re-verified today" }, cwd)).details.memory;
	assert.equal(reviewed.source, "original evidence");
	assert.equal(reviewed.reviewReason, "re-verified today");
	assert.match((await call("memory_read", {}, cwd)).content[0].text, /\(source: original evidence\) \(reviewed: re-verified today\)/);
});

test("prompt puts policy first and fits whole memories newest first", async () => {
	const cwd = newProject();
	const path = await storePathFor(cwd);
	const memories = Array.from({ length: 40 }, (_, index) => memoryFixture(index, `memory-${index} ${"x".repeat(1_500)}`));
	writeStoreFile(path, memories);

	const prompt = await promptFor(cwd);
	const section = prompt.slice("BASE\n\n".length);
	assert.ok(section.length <= 12_000, `section is ${section.length} chars`);
	assert.ok(section.indexOf("Project memory policy:") < section.indexOf("- [mem_fixture_"));
	assert.match(section, /Active memories: 40 \(review-due: 0\)/);
	assert.doesNotMatch(section, /source 39/);

	const entries = section.split("\n").filter((line) => line.startsWith("- [mem_fixture_"));
	assert.equal(entries[0], `- [mem_fixture_39] ${memories[39].text} #fixture`);
	const fullEntries = entries.filter((line) => !line.includes("\u2026"));
	assert.ok(fullEntries.length >= 3);
	for (const [offset, line] of fullEntries.entries()) assert.equal(line, `- [mem_fixture_${39 - offset}] ${memories[39 - offset].text} #fixture`);
	assert.match(section, /Older memories \(previews; use memory_read for full text\):/);
	const previews = entries.slice(fullEntries.length);
	assert.ok(previews.length >= 10);
	for (const [offset, line] of previews.entries()) {
		const index = 39 - fullEntries.length - offset;
		assert.equal(line, `- [mem_fixture_${index}] ${memories[index].text.slice(0, 120)}\u2026 #fixture`);
	}
	const shown = entries.length;
	assert.match(section, new RegExp(`- ${40 - shown} more active memories not shown; use memory_read to list them\\.$`));
});

test("prompt orders by updatedAt, falling back to createdAt when it is invalid", async () => {
	const cwd = newProject();
	const path = await storePathFor(cwd);
	const invalidUpdate = { ...memoryFixture(5, "invalid update, created at minute 5"), updatedAt: "garbage" };
	writeStoreFile(path, [memoryFixture(1, "minute 1"), invalidUpdate, memoryFixture(9, "minute 9"), memoryFixture(3, "minute 3")]);
	const ids = (await promptFor(cwd)).split("\n").filter((line) => line.startsWith("- [mem_fixture_")).map((line) => line.slice(3, line.indexOf("]")));
	assert.deepEqual(ids, ["mem_fixture_9", "mem_fixture_5", "mem_fixture_3", "mem_fixture_1"]);
});

test("an aborted write does not modify the store", async () => {
	const cwd = newProject();
	const path = await storePathFor(cwd);
	const before = readFileSync(path, "utf8");
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(call("memory_write", { action: "add", text: "aborted" }, cwd, controller.signal), /abort/i);
	assert.equal(readFileSync(path, "utf8"), before);
	assert.equal(existsSync(`${path}.lock`), false);
});

test("prompt shows every memory in full when all fit", async () => {
	const cwd = newProject();
	const path = await storePathFor(cwd);
	const memories = Array.from({ length: 30 }, (_, index) => memoryFixture(index, `short memory ${index}`));
	writeStoreFile(path, memories);
	const prompt = await promptFor(cwd);
	assert.equal(prompt.split("\n").filter((line) => line.startsWith("- [mem_fixture_")).length, 30);
	assert.doesNotMatch(prompt, /Older memories|more active memories not shown/);
});

test("prompt reports an empty store", async () => {
	const cwd = newProject();
	const path = await storePathFor(cwd);
	writeStoreFile(path, []);
	assert.match(await promptFor(cwd), /Active memories: 0[\s\S]*- No active project memories yet\.$/);
});

test("concurrent writers in separate processes do not lose updates", { timeout: 60_000 }, async () => {
	const cwd = newProject();
	const path = await storePathFor(cwd);
	const writers = 4;
	const writesPerProcess = 8;
	const script = `
		const { default: memoryExtension } = await import(${JSON.stringify(extensionUrl)});
		let write;
		memoryExtension({ on() {}, registerCommand() {}, registerTool(tool) { if (tool.name === "memory_write") write = tool; } });
		for (let i = 0; i < ${writesPerProcess}; i++) {
			await write.execute("child", { action: "add", text: \`writer \${process.argv[1]} item \${i}\` }, undefined, () => undefined, { cwd: ${JSON.stringify(cwd)} });
		}`;
	await Promise.all(Array.from({ length: writers }, (_, writer) =>
		promisify(execFile)(process.execPath, ["--no-warnings", "--experimental-loader", loaderUrl, "--input-type=module", "-e", script, String(writer)], {
			env: { ...process.env, PI_MEMORY_DIR: memoryDir },
		})));
	const texts = JSON.parse(readFileSync(path, "utf8")).memories.map((memory: any) => memory.text);
	assert.equal(texts.length, 1 + writers * writesPerProcess);
	assert.equal(new Set(texts).size, texts.length);
});
