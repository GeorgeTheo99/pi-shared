import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import coordinator from "../extensions/session-coordinator/index.ts";
import * as state from "../extensions/session-coordinator/state.ts";

async function waitUntil(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 8000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for SDK peer delivery");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function completion(model: any, content: any[]) {
	const message: any = {
		role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop", content,
	};
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "done", reason: message.stopReason, message });
	stream.end();
	return stream;
}

async function fixture(run: (f: { makeSession: (before?: ExtensionFactory[]) => Promise<any>; stats: { work: number } }) => Promise<void>) {
	const dir = mkdtempSync(join(tmpdir(), "pi-coordinator-sdk-"));
	const variables = ["PI_SESSION_COORDINATOR_DIR", "PI_SESSION_COORDINATOR_POLL_MS", "PI_SESSION_COORDINATOR_HEARTBEAT_MS"];
	const previous = variables.map((key) => process.env[key]);
	process.env.PI_SESSION_COORDINATOR_DIR = join(dir, "state");
	process.env.PI_SESSION_COORDINATOR_POLL_MS = "50";
	process.env.PI_SESSION_COORDINATOR_HEARTBEAT_MS = "100";
	const fetch = globalThis.fetch;
	let networkAttempts = 0;
	globalThis.fetch = async () => { networkAttempts++; throw new Error("Network forbidden in this fixture"); };
	const sessions: any[] = [];
	const errors: any[] = [];
	const stats = { work: 0 };
	try {
		const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: join(dir, "models.json"), modelsStorePath: join(dir, "models-store.json"), allowModelNetwork: false });
		const model = runtime.getModel("openai", "gpt-4o");
		assert(model);
		await runtime.setRuntimeApiKey("openai", "local-fixture-not-a-real-key");
		async function makeSession(before: ExtensionFactory[] = []) {
			const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
			const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
				noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				extensionFactories: [...before, coordinator, (pi) => {
					pi.registerTool({ name: "fixture_work", label: "Normal work", description: "Normal user work must remain available", parameters: Type.Object({}),
						async execute() { stats.work++; return { content: [{ type: "text", text: "work completed" }], details: {} }; } });
				}],
			});
			await loader.reload();
			const { session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, modelRuntime: runtime, model, settingsManager, sessionManager: SessionManager.inMemory(dir) });
			sessions.push(session);
			await session.bindExtensions({ onError: (error: any) => errors.push(error) });
			assert(session.getActiveToolNames().includes("peer_send"));
			return session;
		}
		await run({ makeSession, stats });
		assert.equal(networkAttempts, 0);
		assert.deepEqual(errors, []);
	} finally {
		for (const session of sessions.reverse()) {
			await session.abort();
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
			session.dispose();
		}
		globalThis.fetch = fetch;
		variables.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
		rmSync(dir, { recursive: true, force: true });
	}
}

function peer(session: any) {
	return state.listAllActivePeers().find((item) => item.sessionId === session.sessionManager.getSessionId())!;
}

async function request(sender: any, recipient: any) {
	return sender.extensionRunner.getToolDefinition("peer_send").execute("request", {
		target: peer(recipient).runtimeId, message: "Which files changed?", requestResponse: true,
	}, undefined, undefined, sender.extensionRunner.createContext());
}

const status = (sender: any) => state.readOutgoingMessageStatuses(sender.sessionManager.getSessionId())[0];

test("real SDK: request waits for a normal turn; one reply updates status without terminating normal work", { timeout: 20000 }, async () => {
	await fixture(async ({ makeSession, stats }) => {
		const sender = await makeSession();
		const recipient = await makeSession();
		let senderCalls = 0;
		let recipientCalls = 0;
		sender.agent.streamFunction = (selected: any) => { senderCalls++; return completion(selected, [{ type: "text", text: "Unexpected wake" }]); };
		recipient.agent.streamFunction = (selected: any, context: any) => {
			assert(JSON.stringify(context.messages).includes("next normal turn"));
			const turn = ++recipientCalls;
			return completion(selected, turn === 1
				? [{ type: "toolCall", id: "reply-1", name: "peer_send", arguments: { target: peer(sender).runtimeId, inReplyTo: status(sender).messageId, message: "No files changed." } }]
				: turn === 2 ? [{ type: "toolCall", id: "work-1", name: "fixture_work", arguments: {} }]
				: [{ type: "text", text: "Normal work complete." }]);
		};
		await request(sender, recipient);
		await waitUntil(() => status(sender)?.effectiveStatus === "surfaced");
		assert.equal(recipientCalls, 0);
		assert.equal(status(sender).responseStatus, "pending");
		await recipient.prompt("Continue my normal work and answer the pending coordination request.");
		await waitUntil(() => sender.sessionManager.getEntries().some((entry: any) => entry.customType === "pi-peer-message" && entry.details?.inReplyTo));
		assert.equal(status(sender).responseStatus, "answered");
		assert.equal(recipientCalls, 3);
		assert.equal(stats.work, 1, "the reply must not terminate the normal task or restrict its tools");
		assert.equal(senderCalls, 0, "a reply never wakes the sender");
	});
});

for (const hook of ["input", "before_agent_start"] as const) {
	test(`real SDK: requests do not race a user prompt held in an earlier ${hook} handler`, { timeout: 20000 }, async () => {
		await fixture(async ({ makeSession }) => {
			let enter!: () => void;
			let release!: () => void;
			const entered = new Promise<void>((resolve) => { enter = resolve; });
			const held = new Promise<void>((resolve) => { release = resolve; });
			const sender = await makeSession();
			const recipient = await makeSession([(pi) => {
				const block = async () => { enter(); await held; };
				if (hook === "input") pi.on("input", block);
				else pi.on("before_agent_start", block);
			}]);
			let calls = 0;
			recipient.agent.streamFunction = (selected: any) => { calls++; return completion(selected, [{ type: "text", text: "User task completed." }]); };
			const userTurn = recipient.prompt("User preflight");
			await entered;
			try {
				assert.equal(recipient.isIdle, true);
				await request(sender, recipient);
				await waitUntil(() => status(sender)?.effectiveStatus === "surfaced");
				assert.equal(calls, 0, "no model call may start ahead of the held user input");
			} finally { release(); }
			await userTurn;
			assert.equal(calls, 1);
			assert.equal(status(sender).responseStatus, "pending", "an ordinary turn without a reply is not an answer");
		});
	});
}
