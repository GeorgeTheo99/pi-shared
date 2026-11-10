import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	FooterComponent,
	initTheme,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";
import footer, { layoutStats } from "../extensions/footer/index.ts";

initTheme("dark", false);
const theme = (globalThis as any)[Symbol.for("@earendil-works/pi-coding-agent:theme")];
const plain = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

const footerData = {
	providers: 2,
	statuses: new Map([["work-plan", "plan 2/5"], ["goal", "goal 1/60"]]),
	getGitBranch: () => "main",
	getExtensionStatuses() { return this.statuses; },
	getAvailableProviderCount() { return this.providers; },
	onBranchChange: () => () => undefined,
};

function reply(model: any, input: number, cost: number) {
	const stream = createAssistantMessageEventStream();
	const message: any = {
		role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop",
		usage: { input, output: 25_000, cacheRead: 30_000, cacheWrite: 2_000, totalTokens: input + 57_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } },
		content: [{ type: "text", text: "Done." }],
	};
	stream.push({ type: "done", reason: "stop", message });
	stream.end();
	return stream;
}

async function fixture(run: (session: any, runtime: any, render: (width: number) => string[]) => Promise<void>) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-footer-sdk-")));
	const fetch = globalThis.fetch;
	globalThis.fetch = async () => { throw new Error("Network forbidden in this fixture"); };
	let session: any;
	footerData.providers = 2;
	try {
		const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: join(dir, "models.json"),
			modelsStorePath: join(dir, "models-store.json"), allowModelNetwork: false });
		const model = runtime.getModel("anthropic", "claude-opus-4-5");
		assert(model);
		await runtime.setRuntimeApiKey("anthropic", "local-fixture-not-a-real-key");
		await runtime.setRuntimeApiKey("openai", "local-fixture-not-a-real-key");
		const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } }, { projectTrusted: true });
		const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [footer] });
		await loader.reload();
		({ session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, modelRuntime: runtime, model, settingsManager,
			sessionManager: SessionManager.create(dir, join(dir, "sessions")) }));
		let component: any;
		const ui: any = Object.fromEntries(["notify", "onTerminalInput", "setStatus", "setWorkingMessage", "setWorkingVisible", "setWorkingIndicator",
			"setHiddenThinkingLabel", "setWidget", "setHeader", "setTitle", "pasteToEditor", "setEditorText", "addAutocompleteProvider", "setEditorComponent",
			"setToolsExpanded"].map((name) => [name, () => undefined]));
		ui.setFooter = (factory: any) => { component = factory({ requestRender() {} }, theme, footerData); };
		await session.bindExtensions({ uiContext: ui, onError: (error: unknown) => { throw error; } });
		assert(component, "footer installed on session_start");
		session.agent.streamFunction = (streamModel: any) => reply(streamModel, 64, 0);
		await session.prompt("Hi");
		await run(session, runtime, (width) => component.render(width));
	} finally {
		if (session) {
			await session.abort();
			session.dispose();
		}
		globalThis.fetch = fetch;
		rmSync(dir, { recursive: true, force: true });
	}
}

function builtIn(session: any, width: number): string[] {
	const component = new FooterComponent(session, footerData as any);
	component.setAutoCompactEnabled(session.autoCompactionEnabled);
	return component.render(width);
}

test("real SDK: matches Pi's built-in footer whenever the model fits, across session changes", { timeout: 20000 }, async () => {
	await fixture(async (session, runtime, render) => {
		const same = (step: string) => {
			for (const width of [160, 90]) assert.deepEqual(render(width), builtIn(session, width), `${step} at ${width} columns`);
		};
		same("reasoning model, two providers, unsorted statuses");
		session.setThinkingLevel("off");
		same("thinking off");
		session.setAutoCompactionEnabled(false);
		same("auto-compaction off");
		session.setSessionName("mobile");
		same("session name");
		footerData.providers = 1;
		same("one provider");
		await session.setModel(runtime.getModel("openai", "gpt-4o"));
		same("non-reasoning model with another context window");
		session.agent.streamFunction = (model: any) => reply(model, 100_000, 0.5);
		await session.prompt("Again");
		same("cost and context above 70%");
		await session.setModel({ ...session.model, contextWindow: 0 });
		same("model without a context window");
	});
});

test("real SDK: a narrow terminal moves the model to its own line instead of cutting it", { timeout: 20000 }, async () => {
	await fixture(async (session, _runtime, render) => {
		const [, wide] = plain(builtIn(session, 200));
		const stats = wide.slice(0, wide.search(/ {2,}\S/));
		const model = `(${session.model.provider}) ${session.model.id} • ${session.thinkingLevel}`;
		assert.ok(wide.endsWith(model));

		// Room for the stats, the padding, and one letter of the model.
		const width = visibleWidth(stats) + 3;
		assert.equal(plain(builtIn(session, width))[1], `${stats}  ${session.model.id[0]}`, "the built-in footer cuts the model to one letter");

		const lines = plain(render(width));
		assert.equal(lines.length, 4);
		assert.equal(lines[1], stats);
		assert.equal(lines[2], model.padStart(width), "model line is complete and right-aligned");
		assert.equal(lines[3], "goal 1/60 plan 2/5");
	});
});

test("layoutStats drops the provider before wrapping and truncates only a model wider than the terminal", () => {
	assert.deepEqual(layoutStats("stats", "model", "(p) model", 16), { stats: "stats", model: "  (p) model", wrapped: false });
	assert.deepEqual(layoutStats("stats", "model", "(p) model", 12), { stats: "stats", model: "  model", wrapped: false });
	assert.deepEqual(layoutStats("stats", "model", "(p) model", 10), { stats: "stats", model: " (p) model", wrapped: true });
	const truncated = layoutStats("stats", "a-long-model", undefined, 8);
	assert.deepEqual(plain([truncated.model]), ["a-long-m"]);
	assert.equal(truncated.wrapped, true);
});
