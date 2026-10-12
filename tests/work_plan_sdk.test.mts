import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import workPlan from "../extensions/work-plan/index.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(predicate: () => boolean, ms = 8000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for SDK session");
		await sleep(20);
	}
}

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
function held(model: any, signal: AbortSignal) {
	const stream = createAssistantMessageEventStream();
	signal.addEventListener("abort", () => { stream.push({ type: "error", reason: "aborted", error: message(model, [], "aborted") as any }); stream.end(); });
	return stream;
}

const plan = (args: Record<string, unknown>) => ({ type: "toolCall", id: `plan-${Math.random()}`, name: "work_plan", arguments: args });
const text = (value: string) => ({ type: "text", text: value });
const threeItems = plan({ action: "set", items: [{ title: "Build", status: "active" }, { title: "Test", blockedBy: [1] }, { title: "Ship", blockedBy: [2] }] });
const reconciles = (session: any) => session.sessionManager.getEntries().filter((entry: any) => entry.customType === "work-plan-reconcile");
const planState = (session: any) => session.sessionManager.getEntries().filter((entry: any) => entry.customType === "pi-work-plan-state").at(-1)?.data;

const ui: any = Object.fromEntries(["notify", "onTerminalInput", "setStatus", "setWorkingMessage", "setWorkingVisible", "setWorkingIndicator", "setHiddenThinkingLabel",
	"setWidget", "setFooter", "setHeader", "setTitle", "pasteToEditor", "setEditorText", "addAutocompleteProvider", "setEditorComponent", "setToolsExpanded"].map((name) => [name, () => undefined]));
Object.assign(ui, { select: async () => undefined, confirm: async () => false, input: async () => undefined, custom: async () => undefined, editor: async () => undefined,
	getEditorText: () => "", getEditorComponent: () => undefined, getAllThemes: () => [], getTheme: () => undefined, getToolsExpanded: () => false,
	setTheme: () => ({ success: false, error: "fixture" }) });

async function fixture(run: (session: any) => Promise<void>, interactive = true) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-work-plan-sdk-")));
	const previousDepth = process.env.PI_SUBAGENT_DEPTH;
	process.env.PI_SUBAGENT_DEPTH = "0";
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
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [workPlan] });
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
		if (previousDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
		else process.env.PI_SUBAGENT_DEPTH = previousDepth;
		rmSync(dir, { recursive: true, force: true });
	}
}

test("real SDK: complete closes several ids, releases dependents, and reports ids", { timeout: 20000 }, async () => {
	await fixture(async (session) => {
		const contexts: string[] = [];
		session.agent.streamFunction = (model: any, context: any) => {
			contexts.push(JSON.stringify(context.messages));
			if (contexts.length === 1) return completion(model, [threeItems]);
			if (contexts.length === 2) return completion(model, [plan({ action: "complete", ids: [1, 2] })]);
			return completion(model, [text("Built and tested.")]);
		};
		await session.prompt("Build and test.");
		const items = planState(session).items;
		assert.deepEqual(items.map((item: any) => [item.id, item.status, item.blockedBy]), [[1, "done", []], [2, "done", []], [3, "active", []]]);
		assert.match(contexts[2], /#3 Ship/, "model-facing output carries ids");
	});
});

test("real SDK: complete defaults to the active item and rejects unknown ids", { timeout: 20000 }, async () => {
	await fixture(async (session) => {
		const contexts: string[] = [];
		session.agent.streamFunction = (model: any, context: any) => {
			contexts.push(JSON.stringify(context.messages));
			if (contexts.length === 1) return completion(model, [threeItems]);
			if (contexts.length === 2) return completion(model, [plan({ action: "complete" })]);
			if (contexts.length === 3) return completion(model, [plan({ action: "complete", ids: [2, 9] })]);
			if (contexts.length === 4) return completion(model, [plan({ action: "clear" })]);
			return completion(model, [text("Cleared.")]);
		};
		await session.prompt("Build.");
		assert.match(contexts[2], /✔ #1 Build/);
		assert.match(contexts[2], /◼ #2 Test/, "the released dependent becomes active");
		assert.match(contexts[3], /valid id, ids, or an active item is required/);
	});
});

test("real SDK: a finished run with open items gets one reconcile that a plan-only reply ends", { timeout: 20000 }, async () => {
	await fixture(async (session) => {
		const contexts: string[] = [];
		session.agent.streamFunction = (model: any, context: any) => {
			contexts.push(JSON.stringify(context.messages));
			if (contexts.length === 1) return completion(model, [threeItems]);
			if (contexts.length === 2) return completion(model, [text("All shipped.")]);
			if (contexts.length === 3) return completion(model, [plan({ action: "complete", ids: [1, 2] })]);
			return completion(model, [text("Answer.")]);
		};
		await session.prompt("Build, test, ship.");
		await waitUntil(() => contexts.length === 3 && session.isIdle);
		assert.match(contexts[2], /Work plan check: the run ended with 3 open item\(s\).*#1 Build.*#3 Ship › blocked by #2/s);
		await sleep(300);
		assert.equal(contexts.length, 3, "the plan-only reconcile reply terminates the run");
		assert.equal(planState(session).items[2].status, "active");
		// Reviewer repro: the reconcile run changed the plan; an unrelated prompt must neither re-nudge nor re-inject.
		await session.prompt("Unrelated question?");
		await sleep(300);
		assert.equal(contexts.length, 4);
		assert.doesNotMatch(contexts[3], /The work plan has/);
		assert.equal(reconciles(session).length, 1);
	});
});

test("real SDK: work steered into the reconcile run is not cut off", { timeout: 20000 }, async () => {
	await fixture(async (session) => {
		const contexts: string[] = [];
		session.agent.streamFunction = (model: any, context: any) => {
			contexts.push(JSON.stringify(context.messages));
			if (contexts.length === 1) return completion(model, [threeItems]);
			if (contexts.length === 2) return completion(model, [text("All shipped.")]);
			if (contexts.length === 3) {
				void session.steer("New task: refactor the parser.");
				return completion(model, [plan({ action: "complete", ids: [1, 2, 3] })]);
			}
			if (contexts.length === 4) return completion(model, [plan({ action: "set", items: [{ title: "Refactor parser", status: "active" }] })]);
			return completion(model, [text("Parser refactored.")]);
		};
		await session.prompt("Build, test, ship.");
		await waitUntil(() => contexts.length === 5 && session.isIdle);
		assert.match(contexts[3], /New task: refactor the parser/);
		await sleep(300);
		assert.equal(contexts.length, 5, "the steered task ran to its final answer");
	});
});

test("real SDK: an unchanged open plan is not re-nudged", { timeout: 20000 }, async () => {
	await fixture(async (session) => {
		const contexts: string[] = [];
		session.agent.streamFunction = (model: any, context: any) => {
			contexts.push(JSON.stringify(context.messages));
			if (contexts.length === 1) return completion(model, [threeItems]);
			return completion(model, [text("Waiting on you.")]);
		};
		await session.prompt("Plan it.");
		await waitUntil(() => contexts.length === 3 && session.isIdle);
		await session.prompt("Unrelated question?");
		await sleep(300);
		assert.equal(contexts.length, 4);
		assert.doesNotMatch(contexts[3], /The work plan has/, "the model already saw this plan state");
		assert.equal(reconciles(session).length, 1);
	});
});

test("real SDK: the next prompt lists only open items, once per plan state", { timeout: 20000 }, async () => {
	await fixture(async (session) => {
		const contexts: string[] = [];
		session.agent.streamFunction = (model: any, context: any, options: any) => {
			contexts.push(JSON.stringify(context.messages));
			if (contexts.length === 1) return completion(model, [plan({ action: "set", items: [{ title: "Build", status: "done" }, { title: "Test", status: "active" }] })]);
			if (contexts.length === 2) return held(model, options.signal);
			return completion(model, [text("Answer.")]);
		};
		const work = session.prompt("Start.");
		await waitUntil(() => contexts.length === 2);
		await session.abort();
		await work;
		await session.prompt("Next?");
		assert.match(contexts[2], /The work plan has 1 open item\(s\):\\n◼ #2 Test\\n/);
		await session.prompt("And then?");
		assert.equal(contexts.length, 4);
		assert.equal(contexts[3].match(/The work plan has/g)?.length, 1, "no second reminder for the same plan state");
		assert.equal(reconciles(session).length, 0);
	});
});

test("real SDK: no reconcile when items are closed or externally blocked, after an interrupt, during a goal, or without UI", { timeout: 30000 }, async () => {
	const closed = async (session: any) => {
		let calls = 0;
		session.agent.streamFunction = (model: any) => {
			calls++;
			if (calls === 1) return completion(model, [plan({ action: "set", items: [{ title: "Only", status: "active" }] })]);
			if (calls === 2) return completion(model, [plan({ action: "complete" })]);
			return completion(model, [text("Done.")]);
		};
		await session.prompt("Do it.");
		await sleep(500);
		assert.equal(calls, 3);
	};
	const interrupted = async (session: any) => {
		let calls = 0;
		session.agent.streamFunction = (model: any, _context: any, options: any) => {
			calls++;
			return calls === 1 ? completion(model, [threeItems]) : held(model, options.signal);
		};
		const work = session.prompt("Start.");
		await waitUntil(() => calls === 2);
		await session.abort();
		await work;
		await sleep(500);
		assert.equal(calls, 2);
	};
	const externallyBlocked = async (session: any) => {
		let calls = 0;
		session.agent.streamFunction = (model: any) => {
			calls++;
			if (calls === 1) return completion(model, [plan({ action: "set", items: [{ title: "Code", status: "done" }, { title: "Deploy", status: "active" }] })]);
			if (calls === 2) return completion(model, [plan({ action: "block", id: 2, note: "needs credentials" })]);
			return completion(model, [text("Blocked on credentials.")]);
		};
		await session.prompt("Deploy.");
		await sleep(500);
		assert.equal(calls, 3);
	};
	const duringGoal = async (session: any) => {
		session.sessionManager.appendCustomEntry("pi-goal-state", { status: "active" });
		let calls = 0;
		session.agent.streamFunction = (model: any) => (++calls === 1 ? completion(model, [threeItems]) : completion(model, [text("Progress.")]));
		await session.prompt("Work on the goal.");
		await sleep(500);
		assert.equal(calls, 2);
	};
	for (const scenario of [closed, externallyBlocked, interrupted, duringGoal]) {
		await fixture(async (session) => {
			await scenario(session);
			assert.equal(reconciles(session).length, 0);
		});
	}
	await fixture(async (session) => {
		let calls = 0;
		session.agent.streamFunction = (model: any) => (++calls === 1 ? completion(model, [threeItems]) : completion(model, [text("Printed.")]));
		await session.prompt("Print mode.");
		await sleep(500);
		assert.equal(calls, 2);
		assert.equal(reconciles(session).length, 0);
	}, false);
});
