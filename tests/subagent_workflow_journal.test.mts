import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	exactJournalValue,
	openWorkflowJournal,
	persistWorkflowJournalEntry,
} from "../extensions/workflow/journal.ts";

function tempJournalDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-journal-test-"));
}

test("journal ids that sanitize to the same prefix remain distinct", (t) => {
	const directory = tempJournalDir();
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const first = openWorkflowJournal({ id: "run/a", context: { code: "same" }, directory });
	const second = openWorkflowJournal({ id: "run_a", context: { code: "same" }, directory });
	assert.notEqual(first.filePath, second.filePath);
});

test("journal replay is bound to its complete execution context", async (t) => {
	const directory = tempJournalDir();
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const original = openWorkflowJournal({
		id: "stable-run",
		context: { codeSha: "one", args: { target: "a" }, model: "m1" },
		directory,
	});
	await persistWorkflowJournalEntry(original, {
		key: "recon",
		value: { exact: ["result"] },
		completedAt: new Date().toISOString(),
	});
	const replay = openWorkflowJournal({
		id: "stable-run",
		context: { model: "m1", args: { target: "a" }, codeSha: "one" },
		directory,
	});
	assert.deepEqual(replay.entries.get("recon")?.value, { exact: ["result"] });
	assert.throws(
		() =>
			openWorkflowJournal({
				id: "stable-run",
				context: { codeSha: "changed", args: { target: "a" }, model: "m1" },
				directory,
			}),
		/different workflow code, arguments, model, agents, or working directory/,
	);
});

test("journal persistence merges concurrent keys under an interprocess-safe lock", async (t) => {
	const directory = tempJournalDir();
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const first = openWorkflowJournal({ id: "concurrent", context: { code: "same" }, directory });
	const second = openWorkflowJournal({ id: "concurrent", context: { code: "same" }, directory });
	await Promise.all([
		persistWorkflowJournalEntry(first, { key: "one", value: 1, completedAt: new Date().toISOString() }),
		persistWorkflowJournalEntry(second, { key: "two", value: 2, completedAt: new Date().toISOString() }),
	]);
	const replay = openWorkflowJournal({ id: "concurrent", context: { code: "same" }, directory });
	assert.equal(replay.entries.get("one")?.value, 1);
	assert.equal(replay.entries.get("two")?.value, 2);
});

test("journal values fail instead of truncating or changing type", () => {
	assert.deepEqual(exactJournalValue({ nested: ["value"] }, 1024), { nested: ["value"] });
	assert.throws(() => exactJournalValue("x".repeat(2048), 1024), /exact replay limit/);
	assert.throws(() => exactJournalValue(undefined, 1024), /JSON-serializable/);
});

test("corrupt journals fail closed", (t) => {
	const directory = tempJournalDir();
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const journal = openWorkflowJournal({ id: "corrupt", context: { code: "same" }, directory });
	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(journal.filePath, "{not-json", "utf8");
	assert.throws(
		() => openWorkflowJournal({ id: "corrupt", context: { code: "same" }, directory }),
		/corrupt or uses an unsupported schema/,
	);
});
