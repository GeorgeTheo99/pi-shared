import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import commandJobs from "../extensions/command-jobs/index.ts";
import waitFor from "../extensions/wait-for/index.ts";

async function waitUntil(predicate: () => boolean, ms = 8000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for SDK session");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function message(model: any, content: any[], stopReason = content.some((block) => block.type === "toolCall") ? "toolUse" : "stop") {
	return {
		role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason, content,
	};
}
function completion(model: any, content: any[]) {
	const stream = createAssistantMessageEventStream();
	const done: any = message(model, content);
	stream.push({ type: "done", reason: done.stopReason, message: done });
	stream.end();
	return stream;
}
/** A turn that stays busy until released (or aborted). */
function held(model: any, signal: AbortSignal) {
	const stream = createAssistantMessageEventStream();
	let finished = false;
	const finish = (event: any) => { if (!finished) { finished = true; stream.push(event); stream.end(); } };
	signal.addEventListener("abort", () => finish({ type: "error", reason: "aborted", error: message(model, [], "aborted") }));
	return { stream, release: () => { const done: any = message(model, [{ type: "text", text: "Other work done." }]); finish({ type: "done", reason: "stop", message: done }); } };
}

const start = (extra: Record<string, unknown> = {}) => ({ type: "toolCall", id: `start-${Math.random()}`, name: "command_start",
	arguments: { command: "sh", args: ["-c", "sleep 0.2"], timeout_seconds: 10, label: "fixture build", ...extra } });
const wakes = (session: any) => session.sessionManager.getEntries().filter((entry: any) => entry.customType === "pi-job-wake");

// Interactive (TUI/RPC) sessions bind a UI; print/json sessions do not.
const ui: any = Object.fromEntries(["notify", "onTerminalInput", "setStatus", "setWorkingMessage", "setWorkingVisible", "setWorkingIndicator", "setHiddenThinkingLabel",
	"setWidget", "setFooter", "setHeader", "setTitle", "pasteToEditor", "setEditorText", "addAutocompleteProvider", "setEditorComponent", "setToolsExpanded"].map((name) => [name, () => undefined]));
Object.assign(ui, { select: async () => undefined, confirm: async () => false, input: async () => undefined, custom: async () => undefined, editor: async () => undefined,
	getEditorText: () => "", getEditorComponent: () => undefined, getAllThemes: () => [], getTheme: () => undefined, getToolsExpanded: () => false,
	setTheme: () => ({ success: false, error: "fixture" }) });

async function fixture(run: (session: any) => Promise<void>, env: Record<string, string> = {}, interactive = true) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-command-wake-sdk-")));
	const variables = ["PI_COMMAND_STATE_DIR", "PI_SUBAGENT_STATE_DIR", "PI_SUBAGENT_DEPTH"];
	const previous = variables.map((key) => process.env[key]);
	Object.assign(process.env, { PI_COMMAND_STATE_DIR: join(dir, "commands"), PI_SUBAGENT_STATE_DIR: join(dir, "subagents"), PI_SUBAGENT_DEPTH: "0" }, env);
	const fetch = globalThis.fetch;
	globalThis.fetch = async () => { throw new Error("Network forbidden in this fixture"); };
	let session: any;
	const errors: any[] = [];
	try {
		const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: join(dir, "models.json"), modelsStorePath: join(dir, "models-store.json"), allowModelNetwork: false });
		const model = runtime.getModel("openai", "gpt-4o");
		assert(model);
		await runtime.setRuntimeApiKey("openai", "local-fixture-not-a-real-key");
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }, { projectTrusted: true });
		const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [commandJobs, waitFor] });
		await loader.reload();
		({ session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, modelRuntime: runtime, model, settingsManager, sessionManager: SessionManager.create(dir, join(dir, "sessions")) }));
		await session.bindExtensions({ ...(interactive ? { uiContext: ui } : {}), onError: (error: any) => errors.push(error) });
		await run(session);
		assert.deepEqual(errors, []);
	} finally {
		if (session) {
			await session.abort();
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
			session.dispose();
		}
		globalThis.fetch = fetch;
		variables.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
		rmSync(dir, { recursive: true, force: true });
	}
}

test("real SDK: an idle session wakes once when an opted-in command finishes", { timeout: 20000 }, async () => {
	await fixture(async (session) => {
		const contexts: string[] = [];
		session.agent.streamFunction = (model: any, context: any) => {
			contexts.push(JSON.stringify(context.messages));
			return completion(model, contexts.length === 1 ? [start({ notify_on_complete: true })] : [{ type: "text", text: contexts.length === 2 ? "Started; ask me anything." : "Build finished." }]);
		};
		await session.prompt("Run the build in the background.");
		assert.equal(contexts.length, 2);
		await waitUntil(() => contexts.length === 3 && session.isIdle);
		assert.match(contexts[2], /Automatic background job update/);
		assert.match(contexts[2], /command cmd_[0-9a-f-]+ succeeded: \\"fixture build \(exit 0/);
		assert.equal(wakes(session).length, 1);
		await sleep(1500);
		assert.equal(contexts.length, 3, "exactly one wake");
	});
});

test("real SDK: commands without opt-in, or observed by wait_for_jobs, never wake", { timeout: 20000 }, async () => {
	await fixture(async (session) => {
		let calls = 0;
		session.agent.streamFunction = (model: any, context: any) => {
			calls++;
			if (calls === 1) return completion(model, [start(), start({ notify_on_complete: true })]);
			if (calls === 2) {
				const ids = [...new Set(JSON.stringify(context.messages).match(/cmd_[0-9a-f-]{36}/g))];
				return completion(model, [{ type: "toolCall", id: "wait", name: "wait_for_jobs", arguments: { jobs: ids, timeout: 10, poll_interval: 1 } }]);
			}
			return completion(model, [{ type: "text", text: "Both done." }]);
		};
		await session.prompt("Build and wait.");
		assert.equal(calls, 3);
		await sleep(2000);
		assert.equal(calls, 3);
		assert.equal(wakes(session).length, 0);
	});
});

test("real SDK: a command finishing mid-run is reported after that run, never interrupting it", { timeout: 20000 }, async () => {
	await fixture(async (session) => {
		const contexts: string[] = [];
		let hold!: ReturnType<typeof held>;
		session.agent.streamFunction = (model: any, context: any, options: any) => {
			contexts.push(JSON.stringify(context.messages));
			if (contexts.length === 1) return completion(model, [start({ notify_on_complete: true })]);
			if (contexts.length === 2) { hold = held(model, options.signal); return hold.stream; }
			return completion(model, [{ type: "text", text: "Reported." }]);
		};
		const work = session.prompt("Build, then keep working.");
		await waitUntil(() => contexts.length === 2);
		await sleep(1500); // the command finishes while this turn is still streaming
		assert.equal(contexts.length, 2);
		hold.release();
		await work;
		await waitUntil(() => contexts.length === 3 && session.isIdle);
		assert.match(contexts[2], /Other work done\..*Automatic background job update/s);
		assert.equal(wakes(session).length, 1);
	});
});

test("real SDK: an interrupted run is not resumed; the update joins the next prompt", { timeout: 20000 }, async () => {
	await fixture(async (session) => {
		const contexts: string[] = [];
		session.agent.streamFunction = (model: any, context: any, options: any) => {
			contexts.push(JSON.stringify(context.messages));
			if (contexts.length === 1) return completion(model, [start({ notify_on_complete: true })]);
			if (contexts.length === 2) return held(model, options.signal).stream;
			return completion(model, [{ type: "text", text: "It succeeded." }]);
		};
		const work = session.prompt("Build.");
		await waitUntil(() => contexts.length === 2);
		await sleep(1500);
		await session.abort();
		await work;
		await sleep(1500);
		assert.equal(contexts.length, 2, "the interrupt is respected");
		await session.prompt("Did the build finish?");
		assert.equal(contexts.length, 3);
		assert.match(contexts[2], /Automatic background job update.*succeeded/s);
	});
});

test("real SDK: a status check during the run counts as observed", { timeout: 20000 }, async () => {
	await fixture(async (session) => {
		const contexts: string[] = [];
		session.agent.streamFunction = (model: any, context: any) => {
			contexts.push(JSON.stringify(context.messages));
			if (contexts.length === 1) return completion(model, [start({ args: ["-c", "true"], notify_on_complete: true })]);
			if (contexts.length === 2) {
				// Let the command finish before the model inspects it in this same run.
				const stream = createAssistantMessageEventStream();
				const id = contexts[1].match(/cmd_[0-9a-f-]{36}/)![0];
				setTimeout(() => {
					const done: any = message(model, [{ type: "toolCall", id: "status", name: "command_status", arguments: { id } }]);
					stream.push({ type: "done", reason: "toolUse", message: done });
					stream.end();
				}, 800);
				return stream;
			}
			return completion(model, [{ type: "text", text: "It succeeded." }]);
		};
		await session.prompt("Build and check.");
		assert.equal(contexts.length, 3);
		assert.match(contexts[2], /"status\\?":\s*\\?"succeeded/);
		await sleep(1500);
		assert.equal(contexts.length, 3);
		assert.equal(wakes(session).length, 0);
	});
});

test("real SDK: outcomes shown by a timed-out wait_for_jobs are not re-announced", { timeout: 20000 }, async () => {
	await fixture(async (session) => {
		const contexts: string[] = [];
		session.agent.streamFunction = (model: any, context: any) => {
			contexts.push(JSON.stringify(context.messages));
			if (contexts.length === 1) return completion(model, [start({ args: ["-c", "true"], label: "quick", notify_on_complete: true }), start({ args: ["-c", "sleep 3.5"], label: "slow", notify_on_complete: true })]);
			if (contexts.length === 2) {
				const ids = [...new Set(contexts[1].match(/cmd_[0-9a-f-]{36}/g))];
				return completion(model, [{ type: "toolCall", id: "wait", name: "wait_for_jobs", arguments: { jobs: ids, timeout: 2, poll_interval: 1 } }]);
			}
			return completion(model, [{ type: "text", text: contexts.length === 3 ? "Quick done; slow still running." : "Slow done." }]);
		};
		await session.prompt("Run both.");
		assert.equal(contexts.length, 3);
		assert.match(contexts[2], /Timed out/);
		await waitUntil(() => contexts.length === 4 && session.isIdle);
		const wake = wakes(session);
		assert.equal(wake.length, 1);
		assert.match(JSON.stringify(wake[0].content), /slow/);
		assert.doesNotMatch(JSON.stringify(wake[0].content), /quick/);
	});
});

test("real SDK: print-mode sessions are told wake-ups are unavailable", { timeout: 20000 }, async () => {
	await fixture(async (session) => {
		const contexts: string[] = [];
		session.agent.streamFunction = (model: any, context: any) => {
			contexts.push(JSON.stringify(context.messages));
			return completion(model, contexts.length === 1 ? [start({ notify_on_complete: true })] : [{ type: "text", text: "Started." }]);
		};
		await session.prompt("Build.");
		assert.match(contexts[1], /notify_on_complete is unavailable in this session/);
		await sleep(1500);
		assert.equal(contexts.length, 2);
		assert.equal(wakes(session).length, 0);
	}, {}, false);
});

test("real SDK: delegated child sessions never auto-continue", { timeout: 20000 }, async () => {
	await fixture(async (session) => {
		let calls = 0;
		session.agent.streamFunction = (model: any) => {
			calls++;
			return completion(model, calls === 1 ? [start({ notify_on_complete: true })] : [{ type: "text", text: "Started." }]);
		};
		await session.prompt("Build.");
		await sleep(2000);
		assert.equal(calls, 2);
		assert.equal(wakes(session).length, 0);
	}, { PI_SUBAGENT_DEPTH: "1" });
});
