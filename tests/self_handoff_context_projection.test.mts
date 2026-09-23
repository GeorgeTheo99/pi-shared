import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { candidateForToolResult } from "../extensions/tool-summary/policy.ts";
import { defaultToolSummaryConfig, makeCompletedSummaryRecord, TOOL_SUMMARY_COMPLETE_TYPE } from "../extensions/tool-summary/state.ts";

// Run this fixture once per installed SDK, without touching either runtime/profile:
// PI_TEST_SDK_DIR=<pi-coding-agent package> PI_INSTALL_DIR=<same> node --test tests/self_handoff_context_projection.test.mts
const sdkDir = process.env.PI_TEST_SDK_DIR || process.env.PI_INSTALL_DIR;

test("handoff and summary status use canonical context, with stock old-SDK fallback", { timeout: 30_000 }, async (t) => {
	if (!sdkDir) return t.skip("Set PI_TEST_SDK_DIR or PI_INSTALL_DIR to an installed pi-coding-agent package");
	const manifest = JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8"));
	const sdkUrl = pathToFileURL(join(sdkDir, manifest.main || "dist/index.js")).href;
	const sdk = await import(sdkUrl);
	const directory = mkdtempSync(join(tmpdir(), "pi-context-projection-"));
	const previousCoordinator = process.env.PI_SESSION_COORDINATOR_DIR;
	process.env.PI_SESSION_COORDINATOR_DIR = join(directory, "coordinator");
	t.after(() => {
		if (previousCoordinator === undefined) delete process.env.PI_SESSION_COORDINATOR_DIR;
		else process.env.PI_SESSION_COORDINATOR_DIR = previousCoordinator;
		rmSync(directory, { recursive: true, force: true });
	});

	// Also prove the actual SDK can load both production entry points unmodified.
	const loader = new sdk.DefaultResourceLoader({
		cwd: directory, agentDir: join(directory, "profile"),
		settingsManager: sdk.SettingsManager.inMemory({ packages: [] }),
		additionalExtensionPaths: ["self-handoff", "tool-summary"].map((name) => resolve("extensions", name, "index.ts")),
		noContextFiles: true,
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	assert.equal(loader.getExtensions().extensions.length, 2);

	// Only model generation and terminal rendering are doubled. Session projection,
	// compaction, branch navigation and entry conversion come from the selected SDK.
	let generationInput = "";
	const captureKey = "__selfHandoffProjectionCapture";
	(globalThis as any)[captureKey] = (context: any) => {
		generationInput = context.messages[0].content[0].text;
		return { stopReason: "stop", content: [{ type: "text", text: "Fixture continuation" }] };
	};
	const hooks = registerHooks({
		resolve(specifier, context, nextResolve) {
			if (specifier === "@mariozechner/pi-coding-agent" || specifier === "@mariozechner/pi-ai") {
				return { url: `context-projection:${specifier}`, shortCircuit: true };
			}
			if (specifier === "@earendil-works/pi-ai/compat" || specifier === "typebox") {
				return nextResolve(specifier, { ...context, parentURL: sdkUrl });
			}
			return nextResolve(specifier, context);
		},
		load(url, context, nextLoad) {
			if (url === "context-projection:@mariozechner/pi-coding-agent") return {
				format: "module", shortCircuit: true,
				source: `export { SessionManager, sessionEntryToContextMessages } from ${JSON.stringify(sdkUrl)};
					export class BorderedLoader { signal = new AbortController().signal; }`,
			};
			if (url === "context-projection:@mariozechner/pi-ai") return {
				format: "module", shortCircuit: true,
				source: `export async function complete(model, context) { return globalThis.${captureKey}(context); }`,
			};
			return nextLoad(url, context);
		},
	});
	t.after(() => { hooks.deregister(); delete (globalThis as any)[captureKey]; });
	const handoff = (await import("../extensions/self-handoff/index.ts")).default;
	const toolSummary = (await import("../extensions/tool-summary/index.ts")).default;

	function manager() {
		const session = sdk.SessionManager.create(directory, join(directory, "sessions"));
		session.appendMessage({ role: "user", content: "fixture root", timestamp: 1 });
		// A completed assistant response flushes the fixture to its session file.
		session.appendMessage({ role: "assistant", content: [{ type: "text", text: "fixture response" }],
			api: "openai-responses", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: 2,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
		return session;
	}
	async function handoffInput(session: any) {
		let command: any;
		generationInput = "";
		const notifications: string[] = [];
		handoff({ on() {}, events: { emit() {} }, registerCommand(_name: string, value: any) { command = value; },
			appendEntry() { assert.fail("Cancelled review must not write handoff state"); } } as any);
		await command.handler("Inspect this fixture", {
			mode: "tui", hasUI: true, model: {}, sessionManager: session, waitForIdle: async () => {},
			modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true }) },
			ui: { notify: (message: string) => notifications.push(message),
				custom: (render: any) => new Promise((done) => render({}, {}, {}, done)),
				editor: async () => undefined }, // Stop after capturing generation; never replace sessions.
			newSession() { assert.fail("Review was cancelled"); },
		});
		assert.ok(generationInput, notifications.join("\n"));
		return generationInput;
	}
	function toolMessage(call: string, text: string) {
		return { role: "toolResult", toolName: "bash", toolCallId: call,
			content: [{ type: "text", text }], isError: false, timestamp: 3 };
	}
	function storeSummary(session: any, message: any) {
		const candidate = candidateForToolResult(message);
		assert.ok(candidate);
		session.appendCustomEntry(TOOL_SUMMARY_COMPLETE_TYPE, makeCompletedSummaryRecord(defaultToolSummaryConfig(), {
			...candidate, replacement: "Stored concise summary", source: "deterministic",
		}));
	}
	async function summaryHarness(session: any) {
		const handlers = new Map<string, any>();
		const commands = new Map<string, any>();
		const tools = new Map<string, any>();
		const notifications: string[] = [];
		toolSummary({ on: (name: string, handler: any) => handlers.set(name, handler),
			registerCommand: (name: string, command: any) => commands.set(name, command),
			registerTool: (tool: any) => tools.set(tool.name, tool),
			appendEntry: (type: string, data: any) => session.appendCustomEntry(type, data),
		} as any);
		const ctx = { hasUI: true, sessionManager: session,
			ui: { setStatus() {}, notify: (message: string) => notifications.push(message) } };
		await handlers.get("session_start")({ reason: "startup" }, ctx);
		return {
			async status(action = "status") {
				await commands.get("tool-summary").handler(action, ctx);
				return notifications.at(-1)!;
			},
			async recall(call: string) {
				return tools.get("tool_result_recall").execute("fixture", { toolCallId: call, operation: "head", lineCount: 1 }, undefined, undefined, ctx);
			},
		};
	}

	await t.test(`stock ${manifest.version}: compaction-aware fallback preserves ordinary context`, async () => {
		const session = manager();
		const old = session.appendMessage({ role: "user", content: "BEFORE_COMPACTION", timestamp: 3 });
		const raw = toolMessage("kept", `KEPT_RAW\n${"line\n".repeat(4_000)}`);
		const kept = session.appendMessage(raw);
		session.appendCompaction("COMPACTED_SUMMARY", kept, 10_000);
		storeSummary(session, raw);
		assert.ok(session.getEntry(old));
		const legacy = Object.create(session);
		legacy.buildSessionProjection = undefined;
		const input = await handoffInput(legacy);
		assert.match(input, /COMPACTED_SUMMARY/);
		assert.match(input, /KEPT_RAW/);
		assert.doesNotMatch(input, /BEFORE_COMPACTION/);
		assert.match(await (await summaryHarness(legacy)).status(), /summaries: 1;/);
		// Exercise the selected SDK's native capability path as well.
		const normalize = (text: string) => text.replace(/HANDOFF-INPUT-[a-f0-9-]+/g, "HANDOFF-INPUT-fixture");
		assert.equal(normalize(await handoffInput(session)), normalize(input));
		assert.match(await (await summaryHarness(session)).status(), /summaries: 1;/);
	});

	await t.test("canonical empty projection never falls back to raw entries", async () => {
		const session = manager();
		const raw = toolMessage("hidden", `HIDDEN_RAW\n${"line\n".repeat(4_000)}`);
		session.appendMessage(raw);
		storeSummary(session, raw);
		const projected = Object.create(session);
		projected.buildSessionProjection = () => ({ messages: [] });
		projected.buildContextEntries = () => { assert.fail("Must not fall back from an empty projection"); };
		assert.doesNotMatch(await handoffInput(projected), /HIDDEN_RAW|fixture root/);
		const harness = await summaryHarness(projected);
		assert.match(await harness.status(), /summaries: 0;/);
		assert.match(await harness.status("off"), /growth is 0 chars/);
		assert.match((await harness.recall("hidden")).content[0].text, /HIDDEN_RAW/);
	});

	await t.test("real context edits honor omission, latest replacement, branching and compaction", async (t) => {
		const session = manager();
		if (typeof session.appendContextEdit !== "function") return t.skip("Selected old SDK has no context edits");
		const user = session.appendMessage({ role: "user", content: "ORIGINAL_USER", timestamp: 3 });
		const custom = session.appendCustomMessageEntry("fixture", "OMITTED_CUSTOM", true);
		const omitted = session.appendMessage(toolMessage("omitted", "OMITTED_TOOL"));
		const replaced = session.appendMessage(toolMessage("replaced", "ORIGINAL_TOOL"));
		const beforeEdits = session.getLeafId();
		session.appendContextEdit(user, { content: "REPLACED_USER" });
		session.appendContextEdit(custom, null);
		session.appendContextEdit(omitted, null);
		session.appendContextEdit(replaced, { content: "SUPERSEDED_TOOL" });
		session.appendContextEdit(replaced, { content: "REPLACED_TOOL" });
		const editedLeaf = session.getLeafId();
		const assertEdited = async () => {
			const input = await handoffInput(session);
			assert.match(input, /REPLACED_USER/);
			assert.match(input, /REPLACED_TOOL/);
			assert.doesNotMatch(input, /ORIGINAL_USER|ORIGINAL_TOOL|OMITTED_CUSTOM|OMITTED_TOOL|SUPERSEDED_TOOL/);
		};
		await assertEdited();
		session.branch(beforeEdits);
		assert.match(await handoffInput(session), /ORIGINAL_USER/);
		assert.match(await handoffInput(session), /OMITTED_TOOL/);
		session.branch(editedLeaf);
		session.appendCompaction("EDITED_COMPACTION", user, 10_000);
		await assertEdited();
		assert.match(await handoffInput(session), /EDITED_COMPACTION/);
		assert.equal(session.getEntry(replaced).message.content[0].text, "ORIGINAL_TOOL");
	});

	await t.test("real edits remove stale summary savings but never change exact raw recall", async (t) => {
		const session = manager();
		if (typeof session.appendContextEdit !== "function") return t.skip("Selected old SDK has no context edits");
		const raw = toolMessage("summary-edit", `ORIGINAL_RESULT\n${"line\n".repeat(4_000)}`);
		const id = session.appendMessage(raw);
		storeSummary(session, raw);
		const beforeEdits = session.getLeafId();
		assert.match(await (await summaryHarness(session)).status(), /summaries: 1;/);
		session.appendContextEdit(id, { content: "SHORT_REPLACEMENT" });
		assert.match(await (await summaryHarness(session)).status(), /summaries: 0;/);
		const replacement = toolMessage("summary-edit", `REPLACED_RESULT\n${"new line\n".repeat(4_000)}`);
		session.appendContextEdit(id, { content: replacement.content });
		assert.match(await (await summaryHarness(session)).status(), /summaries: 0;/, "Old content hash must not match");
		storeSummary(session, replacement);
		assert.match(await (await summaryHarness(session)).status(), /summaries: 1;/, "Only the projected content hash counts");
		session.appendContextEdit(id, null);
		const omitted = await summaryHarness(session);
		assert.match(await omitted.status(), /summaries: 0;/);
		assert.match(await omitted.status("off"), /growth is 0 chars/);
		assert.match((await omitted.recall("summary-edit")).content[0].text, /ORIGINAL_RESULT/);
		assert.equal(session.getEntry(id).message.content[0].text, raw.content[0].text);
		session.branch(beforeEdits);
		assert.match(await (await summaryHarness(session)).status(), /summaries: 1;/);
	});
});
