import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	claimRequestReply, createEnvelope, markRequestReplyQueued, MAX_OUTGOING_STATUS_RECORDS, readOutgoingMessageStatuses,
	persistOutgoingMessageStatus, persistSessionReceipt, removeSessionReceipt, updateOutgoingMessageStatus,
} from "../extensions/session-coordinator/state.ts";
import { inspectPeerRequests, peerRequestWarning } from "../extensions/self-handoff/peer-requests.ts";
import { buildKickoffPrompt } from "../extensions/self-handoff/state.ts";

const parentId = "parent-session";
const senderId = "peer-session";
const room = `cwd-${"a".repeat(32)}`;
const runtimeId = randomUUID();
const peerRuntimeId = randomUUID();
function envelope(overrides: Record<string, unknown> = {}) {
	return createEnvelope({ roomId: room, targetRuntimeId: runtimeId, targetSessionId: parentId,
		sender: { runtimeId: peerRuntimeId, sessionId: senderId, worktreeRoot: "/tmp/peer" },
		message: "UNTRUSTED_BODY_MUST_NOT_APPEAR", requestResponse: true, ...overrides });
}
function surfaced(message: ReturnType<typeof envelope>) {
	return { type: "custom_message", customType: "pi-peer-message", details: {
		messageId: message.id, senderSessionId: message.sender.sessionId,
		recipientSessionId: message.targetSessionId, requestResponse: message.requestResponse,
		hops: message.hops, inReplyTo: message.inReplyTo, expiresAt: message.expiresAt,
	} };
}
function binding(message: ReturnType<typeof envelope>) {
	return { messageId: message.id, senderSessionId: message.sender.sessionId,
		recipientSessionId: message.targetSessionId!, expiresAt: message.expiresAt };
}
function statePath(directory: string, kind: string, sessionId = parentId) {
	return join(directory, kind, `session-${createHash("sha256").update(sessionId).digest("hex")}`);
}
async function isolated(run: (directory: string) => Promise<void> | void) {
	const previous = process.env.PI_SESSION_COORDINATOR_DIR;
	const directory = mkdtempSync(join(tmpdir(), "handoff-peer-test-"));
	process.env.PI_SESSION_COORDINATOR_DIR = directory;
	try { await run(directory); } finally {
		if (previous === undefined) delete process.env.PI_SESSION_COORDINATOR_DIR;
		else process.env.PI_SESSION_COORDINATOR_DIR = previous;
		rmSync(directory, { recursive: true, force: true });
	}
}

test("peer handoff inspection dedupes receipts and surfaced transcript; ignores forks, expiry and FYIs", async () => isolated(async () => {
	const request = envelope();
	await persistSessionReceipt(parentId, request);
	const transcriptOnly = envelope();
	const receipt = await persistSessionReceipt(parentId, transcriptOnly);
	await removeSessionReceipt(receipt);
	const notification = envelope({ requestResponse: false });
	await persistSessionReceipt(parentId, notification);
	const wrongSession = envelope({ targetSessionId: "other-session" });
	await persistSessionReceipt(parentId, wrongSession);
	const expired = { ...envelope(), expiresAt: Date.now() - 1 };
	const expiredReceipt = await persistSessionReceipt(parentId, expired);
	const expiredBefore = readFileSync(expiredReceipt.path, "utf8");
	const outgoing = envelope({ targetSessionId: senderId, sender: { runtimeId, sessionId: parentId, worktreeRoot: "/tmp/parent" } });
	await persistOutgoingMessageStatus({ envelope: outgoing, trackingSupported: true });
	await persistOutgoingMessageStatus({ envelope: { ...outgoing, id: randomUUID(), expiresAt: Date.now() - 1 }, trackingSupported: true });
	await persistOutgoingMessageStatus({ envelope: { ...outgoing, id: randomUUID(), requestResponse: false }, trackingSupported: true });
	const entries = [surfaced(request), surfaced(request), surfaced(transcriptOnly), surfaced(notification), surfaced(wrongSession), surfaced(expired)];
	const result = inspectPeerRequests(parentId, () => entries);
	assert.equal(result.status, "available");
	if (result.status !== "available") return;
	assert.deepEqual(result.outgoing, [binding(outgoing)]);
	assert.equal(result.incoming.length, 2);
	assert.deepEqual(new Set(result.incoming.map((item) => item.messageId)), new Set([request.id, transcriptOnly.id]));
	assert.equal(readFileSync(expiredReceipt.path, "utf8"), expiredBefore, "inspection must not prune receipts");
	assert.deepEqual(inspectPeerRequests("fork-session", () => entries), { status: "available", incoming: [], outgoing: [] });
	assert.doesNotMatch(peerRequestWarning(result)!, /UNTRUSTED_BODY/);
}));

test("queued replies are answered; claimed but failed replies and delivery-only replied rank remain outstanding", async () => isolated(async () => {
	const answered = envelope();
	const failed = envelope();
	const outgoingAnswered = envelope({ targetSessionId: senderId, sender: { runtimeId, sessionId: parentId, worktreeRoot: "/tmp/parent" } });
	const deliveryOnly = envelope({ targetSessionId: senderId, sender: { runtimeId, sessionId: parentId, worktreeRoot: "/tmp/parent" } });
	for (const message of [answered, failed, outgoingAnswered, deliveryOnly]) {
		await persistOutgoingMessageStatus({ envelope: message, trackingSupported: true });
	}
	for (const message of [answered, outgoingAnswered]) {
		assert.equal(await claimRequestReply(binding(message)), true);
		await markRequestReplyQueued(binding(message));
	}
	assert.equal(await claimRequestReply(binding(failed)), true);
	await updateOutgoingMessageStatus(parentId, deliveryOnly.id, "replied");
	const result = inspectPeerRequests(parentId, () => [surfaced(answered), surfaced(failed)]);
	assert.equal(result.status, "available");
	if (result.status !== "available") return;
	assert.deepEqual(result.incoming, [binding(failed)]);
	assert.deepEqual(result.outgoing, [binding(deliveryOnly)]);
}));

test("evicted outgoing requests are recovered from sent cards and tool results without inheriting fork authority", async () => isolated(async () => {
	const request = envelope({ targetSessionId: senderId, sender: { runtimeId, sessionId: parentId, worktreeRoot: "/tmp/parent" },
		now: Date.now() - 60_000 });
	await persistOutgoingMessageStatus({ envelope: request, trackingSupported: true });
	const entries = [
		{ type: "custom", customType: "pi-peer-message-sent", data: { message: request } },
		{ type: "message", message: { role: "toolResult", toolName: "peer_send", isError: false, details: { message: request } } },
	];
	for (let i = 0; i < MAX_OUTGOING_STATUS_RECORDS; i++) {
		const notification = { ...request, id: randomUUID(), requestResponse: undefined, createdAt: Date.now() + i };
		await persistOutgoingMessageStatus({ envelope: notification, trackingSupported: true });
	}
	assert.equal(readOutgoingMessageStatuses(parentId, request.id).length, 0, "fixture must really evict the request status");
	const snapshot = inspectPeerRequests(parentId, () => entries);
	assert.equal(snapshot.status, "available");
	if (snapshot.status !== "available") return;
	assert.deepEqual(snapshot.outgoing, [binding(request)], "transcript duplicates must count once");
	assert.match(peerRequestWarning(snapshot)!, /1 outgoing/);
	assert.deepEqual(inspectPeerRequests(parentId, () => entries.slice(1)), snapshot, "tool result is a fallback for a failed sent-card append");
	assert.deepEqual(inspectPeerRequests("fork-session", () => entries), { status: "available", incoming: [], outgoing: [] });
	await claimRequestReply(binding(request));
	await markRequestReplyQueued(binding(request));
	assert.deepEqual(inspectPeerRequests(parentId, () => entries), { status: "available", incoming: [], outgoing: [] }, "ledger evidence excludes answered evicted requests");
	assert.equal(inspectPeerRequests(parentId, () => [entries[0], {
		...entries[0], data: { message: { ...request, targetSessionId: "different-recipient" } },
	}]).status, "unavailable", "conflicting transcript bindings must fail closed");
}));

test("expired, notification-only and failed tool-result sends do not create handoff warnings", async () => isolated(async () => {
	const request = envelope({ targetSessionId: senderId, sender: { runtimeId, sessionId: parentId, worktreeRoot: "/tmp/parent" } });
	const entries = [
		{ type: "custom", customType: "pi-peer-message-sent", data: { message: { ...request, expiresAt: Date.now() - 1 } } },
		{ type: "custom", customType: "pi-peer-message-sent", data: { message: { ...request, requestResponse: undefined } } },
		{ type: "message", message: { role: "toolResult", toolName: "peer_send", isError: true, details: { message: request } } },
	];
	assert.equal(peerRequestWarning(inspectPeerRequests(parentId, () => entries)), undefined);
}));

test("missing state is empty; corrupt/unreadable state or transcript failures report unavailable without writes", async () => isolated(async (directory) => {
	const empty = inspectPeerRequests(parentId, () => []);
	assert.equal(peerRequestWarning(empty), undefined);
	assert.deepEqual(readdirSync(directory), []);
	assert.equal(inspectPeerRequests(parentId, () => { throw new Error("private error"); }).status, "unavailable");
	const receipts = statePath(directory, "receipts");
	mkdirSync(receipts, { recursive: true });
	writeFileSync(join(receipts, "bad.json"), "{");
	const unavailable = inspectPeerRequests(parentId, () => []);
	assert.equal(unavailable.status, "unavailable");
	assert.match(peerRequestWarning(unavailable)!, /inspection unavailable/);
	assert.doesNotMatch(peerRequestWarning(unavailable)!, /0 outgoing|private error/);
	assert.equal(readFileSync(join(receipts, "bad.json"), "utf8"), "{");
	rmSync(receipts, { recursive: true });
	writeFileSync(receipts, "not a directory");
	assert.equal(inspectPeerRequests(parentId, () => []).status, "unavailable");
	rmSync(receipts);
	const statuses = statePath(directory, "outgoing-status");
	mkdirSync(statuses, { recursive: true });
	writeFileSync(join(statuses, "broken.json"), "{}");
	assert.equal(inspectPeerRequests(parentId, () => []).status, "unavailable");
}));

test("conflicting exact bindings and corrupt response ledgers never claim zero", async () => isolated(async (directory) => {
	const message = envelope();
	const entry = surfaced(message);
	assert.equal(inspectPeerRequests(parentId, () => [entry,
		{ ...entry, details: { ...entry.details, senderSessionId: "different-sender" } }]).status, "unavailable");
	await claimRequestReply(binding(message));
	writeFileSync(`${statePath(directory, "response-requests")}.json`, "{}");
	assert.equal(inspectPeerRequests(parentId, () => [entry]).status, "unavailable");
}));

test("kickoff preserves fixed warning outside editable context and requires its summary without releasing work", () => {
	const warning = peerRequestWarning({ status: "unavailable" })!;
	const kickoff = buildKickoffPrompt("User removed all warnings from their edited context.", {
		version: 1, id: "handoff", createdAt: 1, originSessionId: parentId,
		originSessionFile: "/tmp/parent.jsonl", contextNonce: "nonce-1234567890abcdef",
		goalTransferred: false, workPlanTransferred: false,
	}, warning);
	assert.ok(kickoff.indexOf(warning) > kickoff.indexOf("--- END SELF-HANDOFF-"));
	assert.match(kickoff, /Include the peer-request warning above in the handoff summary/);
	assert.match(kickoff, /No peer is automatically woken/);
	assert.match(kickoff, /wait.*new explicit user message/);
});

// Exercise the actual registered command with inert SDK/model doubles. All disk
// files and coordinator writes below are fixtures inside isolated temporary roots.
const sessions = new Map<string, any>();
(globalThis as any).__handoffPeerTestSessions = sessions;
const hooks = registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@mariozechner/pi-ai" || specifier === "@mariozechner/pi-coding-agent") {
			return { url: `handoff-peer-test:${specifier}`, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
	load(url, context, nextLoad) {
		if (url === "handoff-peer-test:@mariozechner/pi-ai") return { format: "module", shortCircuit: true,
			source: 'export async function complete() { return { stopReason: "stop", content: [{type: "text", text: "Generated continuation"}] }; }' };
		if (url === "handoff-peer-test:@mariozechner/pi-coding-agent") return { format: "module", shortCircuit: true,
			source: `export class BorderedLoader { signal = new AbortController().signal; }
				export const SessionManager = { open(path) { return globalThis.__handoffPeerTestSessions.get(path); } };
				export function sessionEntryToContextMessages(entry) { return entry.type === "message" ? [entry.message] : []; }` };
		return nextLoad(url, context);
	},
});
const { default: selfHandoffExtension } = await import("../extensions/self-handoff/index.ts");
hooks.deregister();
test.after(() => {
	delete (globalThis as any).__handoffPeerTestSessions;
	sessions.clear();
});

function manager(path: string, sessionId: string, parentSession?: string) {
	const entries: any[] = [];
	const session = {
		getSessionFile: () => path, getSessionId: () => sessionId,
		getEntries: () => entries, getBranch: () => entries, buildContextEntries: () => entries,
		getLeafId: () => entries.at(-1)?.id, getHeader: () => ({ parentSession }), branch: () => {},
		appendCustomEntry(customType: string, data: unknown) {
			entries.push({ type: "custom", id: randomUUID(), customType, data });
			return entries.at(-1).id;
		},
	};
	writeFileSync(path, "fixture");
	sessions.set(path, session);
	return session;
}

async function commandScenario(directory: string, onReview: () => Promise<void>, cancel = false, failChildNotification = false) {
	const parent = manager(join(directory, "parent.jsonl"), parentId);
	const order: string[] = [];
	let handler: any;
	let switched = false;
	let kickoff = "";
	let reviewText = "";
	let childWarning = "";
	const ctx: any = {
		mode: "tui", hasUI: true, model: {}, sessionManager: parent, waitForIdle: async () => {},
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true }) },
		ui: {
			notify: (message: string) => order.push(message),
			custom: (render: any) => new Promise((resolve) => render({}, {}, {}, resolve)),
			editor: async (_title: string, text: string) => {
				reviewText = text;
				order.push("review");
				await onReview();
				return cancel ? undefined : "User-edited continuation without warning";
			},
		},
		newSession: async (options: any) => {
			switched = true;
			const child = manager(join(directory, "child.jsonl"), "child-session", parent.getSessionFile());
			await options.setup(child);
			await options.withSession({ sessionManager: child,
				ui: { notify: (message: string) => {
					childWarning = message;
					if (failChildNotification) throw new Error("Child UI unavailable");
				} },
				sendUserMessage: async (message: string) => { kickoff = message; },
			});
			return { cancelled: false };
		},
	};
	selfHandoffExtension({ on: () => {}, events: { emit: () => {} },
		registerCommand: (_name: string, options: any) => { handler = options.handler; },
		appendEntry: (type: string, data: unknown) => parent.appendCustomEntry(type, data),
	} as any);
	await handler("Continue the task", ctx);
	return { order, switched, kickoff, reviewText, childWarning, parent };
}

test("actual handoff command warns before review and in child even when edited away", async () => isolated(async (directory) => {
	await persistSessionReceipt(parentId, envelope());
	const result = await commandScenario(directory, async () => {});
	assert.equal(result.switched, true);
	assert.match(result.order[0], /0 outgoing, 1 incoming/);
	assert.equal(result.order[1], "review");
	assert.match(result.reviewText, /Peer requests stay with the parent/);
	assert.match(result.childWarning, /0 outgoing, 1 incoming/);
	assert.match(result.kickoff, /Peer requests stay with the parent/);
	assert.match(result.kickoff, /User-edited continuation without warning/);
}));

test("child warning notification failure cannot prevent the orientation kickoff", async () => isolated(async (directory) => {
	await persistSessionReceipt(parentId, envelope());
	const result = await commandScenario(directory, async () => {}, false, true);
	assert.equal(result.switched, true);
	assert.match(result.kickoff, /Peer requests stay with the parent/);
	assert.match(result.kickoff, /Orientation checkpoint/);
}));

test("actual handoff command cancels replacement on changed peer identities, not merely counts", async () => isolated(async (directory) => {
	const receipt = await persistSessionReceipt(parentId, envelope());
	const result = await commandScenario(directory, async () => {
		await removeSessionReceipt(receipt);
		await persistSessionReceipt(parentId, envelope());
	});
	assert.equal(result.switched, false);
	assert.match(result.order.at(-1)!, /Peer requests changed during review/);
	assert.equal(result.parent.getEntries().length, 0, "no prepared transfer may be persisted");
}));

test("actual handoff warning does not bypass cancellation; unavailable inspection is visible", async () => isolated(async (directory) => {
	const receipts = statePath(directory, "receipts");
	mkdirSync(receipts, { recursive: true });
	writeFileSync(join(receipts, "broken.json"), "{}");
	const result = await commandScenario(directory, async () => {}, true);
	assert.equal(result.switched, false);
	assert.match(result.reviewText, /inspection unavailable/);
	assert.equal(result.parent.getEntries().length, 0);
}));
