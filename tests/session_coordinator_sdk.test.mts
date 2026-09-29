import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import coordinator from "../extensions/session-coordinator/index.ts";
import * as state from "../extensions/_shared/coordinator-state.ts";

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

async function fixture(run: (f: { makeSession: (before?: ExtensionFactory[], ephemeral?: boolean) => Promise<any>; stats: { work: number } }) => Promise<void>) {
	const dir = mkdtempSync(join(tmpdir(), "pi-coordinator-sdk-"));
	const variables = ["PI_SESSION_COORDINATOR_DIR", "PI_SESSION_COORDINATOR_POLL_MS", "PI_SESSION_COORDINATOR_HEARTBEAT_MS", "PI_SUBAGENT_DEPTH"];
	const previous = variables.map((key) => process.env[key]);
	process.env.PI_SESSION_COORDINATOR_DIR = join(dir, "state");
	process.env.PI_SESSION_COORDINATOR_POLL_MS = "50";
	process.env.PI_SESSION_COORDINATOR_HEARTBEAT_MS = "100";
	process.env.PI_SUBAGENT_DEPTH = "0";
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
		async function makeSession(before: ExtensionFactory[] = [], ephemeral = false) {
			const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
			const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
				noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				extensionFactories: [...before, coordinator, (pi) => {
					pi.registerTool({ name: "fixture_work", label: "Normal work", description: "Normal user work must remain available", parameters: Type.Object({}),
						async execute() { stats.work++; return { content: [{ type: "text", text: "work completed" }], details: {} }; } });
				}],
			});
			await loader.reload();
			const { session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, modelRuntime: runtime, model, settingsManager, sessionManager: ephemeral ? SessionManager.inMemory(dir) : SessionManager.create(dir, join(dir, "sessions")) });
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

test("real SDK: a busy recipient finishes its task before automatically answering", { timeout: 20000 }, async () => {
	await fixture(async ({ makeSession }) => {
		const sender = await makeSession();
		const recipient = await makeSession();
		let calls = 0;
		let senderCalls = 0;
		let finish!: () => void;
		sender.agent.streamFunction = (model: any) => { senderCalls++; return completion(model, [{ type: "text", text: "Received." }]); };
		recipient.agent.streamFunction = (model: any) => {
			calls++;
			if (calls === 1) {
				const stream = createAssistantMessageEventStream();
				finish = () => {
					void (async () => {
						for await (const event of completion(model, [{ type: "text", text: "Original task finished." }])) stream.push(event);
						stream.end();
					})();
				};
				return stream;
			}
			return completion(model, calls === 2
				? [{ type: "toolCall", id: "busy-reply", name: "peer_send", arguments: { target: peer(sender).runtimeId, inReplyTo: status(sender).messageId, message: "Done with my files." } }]
				: [{ type: "text", text: "Answered." }]);
		};
		const work = recipient.prompt("Do my existing work.");
		await waitUntil(() => calls === 1);
		try {
			await request(sender, recipient);
			await waitUntil(() => status(sender)?.effectiveStatus === "delivered");
			assert.equal(calls, 1);
			assert.equal(recipient.isIdle, false);
			assert.equal(recipient.sessionManager.getEntries().some((entry: any) => entry.customType === "pi-peer-wake"), false);
		} finally { finish(); }
		await work;
		await waitUntil(() => senderCalls === 1 && recipient.isIdle && sender.isIdle);
		assert.equal(calls, 3);
		assert.equal(status(sender).responseStatus, "answered");
	});
});

test("real SDK: notifications and acknowledgment requests stay silent", { timeout: 20000 }, async () => {
	await fixture(async ({ makeSession }) => {
		const sender = await makeSession();
		const recipient = await makeSession();
		let calls = 0;
		for (const session of [sender, recipient]) session.agent.streamFunction = (model: any) => {
			calls++; return completion(model, [{ type: "text", text: "Unexpected wake" }]);
		};
		const sent = await sender.extensionRunner.getToolDefinition("peer_send").execute("notice", {
			target: peer(recipient).runtimeId, message: "Please wake up! (still only notification content)", requestAcknowledgment: true,
		}, undefined, undefined, sender.extensionRunner.createContext());
		await waitUntil(() => status(sender)?.effectiveStatus === "surfaced");
		await recipient.extensionRunner.getToolDefinition("peer_acknowledge").execute("ack", { messageId: sent.details.message.id }, undefined, undefined, recipient.extensionRunner.createContext());
		await recipient.extensionRunner.emit({ type: "agent_settled" });
		await sender.extensionRunner.emit({ type: "agent_settled" });
		assert.equal(calls, 0);
		assert.equal(status(sender).effectiveStatus, "acknowledged");
	});
});

test("real SDK: idle request and reply wake both sessions without any user prompt", { timeout: 20000 }, async () => {
	await fixture(async ({ makeSession, stats }) => {
		const sender = await makeSession();
		const recipient = await makeSession();
		let senderCalls = 0;
		let recipientCalls = 0;
		sender.agent.streamFunction = (selected: any, context: any) => {
			senderCalls++;
			assert(JSON.stringify(context.messages).includes("No files changed."));
			return completion(selected, [{ type: "text", text: "Reply received." }]);
		};
		recipient.agent.streamFunction = (selected: any, context: any) => {
			assert(JSON.stringify(context.messages).includes("Automatic peer coordination turn"));
			const turn = ++recipientCalls;
			return completion(selected, turn === 1
				? [{ type: "toolCall", id: "reply-1", name: "peer_send", arguments: { target: peer(sender).runtimeId, inReplyTo: status(sender).messageId, message: "No files changed." } }]
				: turn === 2 ? [{ type: "toolCall", id: "work-1", name: "fixture_work", arguments: {} }]
				: [{ type: "text", text: "Normal work complete." }]);
		};
		await request(sender, recipient);
		await waitUntil(() => senderCalls === 1 && sender.isIdle && recipient.isIdle);
		assert.equal(status(sender).responseStatus, "answered");
		assert.equal(recipientCalls, 3);
		assert.equal(stats.work, 1, "the reply must not terminate the normal task or restrict its tools");
		assert.equal(senderCalls, 1, "a correlated reply wakes the sender without a user prompt");
		await sender.extensionRunner.emit({ type: "agent_settled" });
		await recipient.extensionRunner.emit({ type: "agent_settled" });
		assert.equal(senderCalls, 1);
		assert.equal(recipientCalls, 3, "no automatic wake/reply loop");
	});
});

test("real SDK: non-persistent sessions remain discoverable but reject response requests", { timeout: 20000 }, async () => {
	await fixture(async ({ makeSession }) => {
		const sender = await makeSession();
		const recipient = await makeSession([], true);
		assert.equal(peer(recipient).ephemeral, true);
		assert.equal(peer(recipient).requestResponseVersion, undefined);
		assert.equal(peer(sender).requestResponseVersion, 1, "fresh persistent sessions are supported before their first turn");
		await assert.rejects(request(sender, recipient), /short-lived\/non-persistent/);
		assert.equal(state.readOutgoingMessageStatuses(sender.sessionManager.getSessionId()).length, 0);
	});
});

for (const hook of ["input", "before_agent_start"] as const) {
	test(`real SDK: a peer wake may precede user input held in ${hook}, without restricting either turn`, { timeout: 20000 }, async () => {
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
				await waitUntil(() => calls === 1 && recipient.isIdle);
				assert.equal(calls, 1, "automatic scheduling is not gated on atomic user-input admission");
			} finally { release(); }
			await userTurn;
			assert.equal(calls, 2);
			assert.equal(status(sender).responseStatus, "pending", "a wake without a reply is not an answer");
		});
	});
}
