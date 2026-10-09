import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const memoryDir = mkdtempSync(join(tmpdir(), "pi-memory-test-"));
process.env.PI_MEMORY_DIR = memoryDir;
const { default: memoryExtension } = await import("../extensions/memory/index.ts");

const tools = new Map<string, any>();
memoryExtension({
	on() {},
	registerCommand() {},
	registerTool(tool: any) {
		tools.set(tool.name, tool);
	},
} as any);

const projectDir = mkdtempSync(join(tmpdir(), "pi-memory-project-"));
const call = (name: string, params: any) => tools.get(name).execute("memory-test", params, undefined, () => undefined, { cwd: projectDir });

test.after(() => {
	rmSync(memoryDir, { recursive: true, force: true });
	rmSync(projectDir, { recursive: true, force: true });
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
