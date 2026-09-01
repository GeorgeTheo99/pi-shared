import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { PeerPresence } from "../extensions/session-coordinator/state.ts";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-coordinator-test-"));
process.env.PI_SESSION_COORDINATOR_DIR = stateDir;
const coordinator = await import("../extensions/session-coordinator/state.ts");
after(() => fs.rmSync(stateDir, { recursive: true, force: true }));

function git(cwd: string, args: string[]) {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function presence(overrides: Partial<PeerPresence> = {}): PeerPresence {
	const now = Date.now();
	return {
		version: 1,
		roomId: `cwd-${"a".repeat(32)}`,
		runtimeId: crypto.randomUUID(),
		pid: process.pid,
		sessionId: crypto.randomUUID(),
		cwd: process.cwd(),
		worktreeRoot: process.cwd(),
		activity: "idle",
		status: "Idle",
		startedAt: now,
		heartbeatAt: now,
		leaseExpiresAt: now + 20_000,
		capabilities: ["messages"],
		protocolVersion: 2,
		...overrides,
	};
}

test("repository identity groups linked worktrees while preserving worktree paths", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-peer-repo-"));
	const linked = `${root}-linked`;
	const symlink = `${root}-symlink`;
	try {
		git(root, ["init", "-b", "main"]);
		git(root, ["config", "user.email", "pi@example.invalid"]);
		git(root, ["config", "user.name", "Pi Test"]);
		fs.writeFileSync(path.join(root, "README.md"), "test\n");
		git(root, ["add", "README.md"]);
		git(root, ["commit", "-m", "initial"]);
		git(root, ["worktree", "add", "-b", "peer", linked]);
		fs.symlinkSync(root, symlink);

		const mainScope = coordinator.discoverRepository(root);
		const linkedScope = coordinator.discoverRepository(linked);
		const symlinkScope = coordinator.discoverRepository(symlink);
		assert.equal(mainScope.kind, "git");
		assert.equal(mainScope.roomId, linkedScope.roomId);
		assert.equal(mainScope.roomId, symlinkScope.roomId);
		assert.notEqual(mainScope.worktreeRoot, linkedScope.worktreeRoot);
		assert.equal(mainScope.branch, "main");
		assert.equal(linkedScope.branch, "peer");
		fs.writeFileSync(path.join(root, "README.md"), "modified tracked file\n");
		fs.writeFileSync(path.join(root, "changed.txt"), "workspace evidence\n");
		assert.deepEqual(coordinator.discoverRepository(root).workspaceChanges, ["README.md", "changed.txt"]);
	} finally {
		try {
			git(root, ["worktree", "remove", "--force", linked]);
		} catch {}
		try {
			fs.unlinkSync(symlink);
		} catch {}
		fs.rmSync(linked, { recursive: true, force: true });
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("presence lists only fresh live peers and excludes the caller", async () => {
	const roomId = `cwd-${"b".repeat(32)}`;
	const self = presence({ roomId });
	const live = presence({ roomId, sessionName: "Live peer", activity: "busy", status: "Running tests" });
	const expired = presence({ roomId, leaseExpiresAt: Date.now() - 1 });
	const dead = presence({ roomId, pid: 99_999_999 });
	await Promise.all([self, live, expired, dead].map(coordinator.writePresence));

	const peers = coordinator.listActivePeers(roomId, self.runtimeId);
	assert.deepEqual(peers.map((peer) => peer.runtimeId), [live.runtimeId]);
	assert.equal(peers[0].status, "Running tests");
});

test("machine-wide presence discovery spans rooms while excluding self, expired, and dead sessions", async () => {
	const now = Date.now();
	const roomA = `git-${"4".repeat(32)}`;
	const roomB = `cwd-${"5".repeat(32)}`;
	const self = presence({ roomId: roomA, startedAt: now });
	const sameRoom = presence({ roomId: roomA, startedAt: now + 1, sessionName: "Same room" });
	const otherRoom = presence({ roomId: roomB, startedAt: now + 2, sessionName: "Other room" });
	const expired = presence({ roomId: roomB, startedAt: now + 3, leaseExpiresAt: now - 1 });
	const dead = presence({ roomId: roomB, startedAt: now + 4, pid: 99_999_999 });
	await Promise.all([self, sameRoom, otherRoom, expired, dead].map(coordinator.writePresence));

	const peers = coordinator
		.listAllActivePeers(self.runtimeId, now)
		.filter((peer: PeerPresence) => peer.roomId === roomA || peer.roomId === roomB);
	assert.deepEqual(peers.map((peer: PeerPresence) => peer.runtimeId), [sameRoom.runtimeId, otherRoom.runtimeId]);
});

test("cross-room messages are routed only through the target room", async () => {
	const senderRoom = `git-${"6".repeat(32)}`;
	const targetRoom = `cwd-${"7".repeat(32)}`;
	const target = presence({ roomId: targetRoom });
	await coordinator.writePresence(target);
	const envelope = coordinator.createEnvelope({
		roomId: target.roomId,
		targetRuntimeId: target.runtimeId,
		sender: {
			runtimeId: crypto.randomUUID(),
			sessionId: crypto.randomUUID(),
			worktreeRoot: process.cwd(),
		},
		message: "cross-room coordination",
	});

	await coordinator.enqueueMessage(envelope);
	assert.equal(coordinator.readInbox(senderRoom, target.runtimeId).length, 0);
	assert.deepEqual(
		coordinator.readInbox(targetRoom, target.runtimeId).map((item: { envelope: { id: string } }) => item.envelope.id),
		[envelope.id],
	);
});

test("message envelopes are bounded, delivered, and expired messages are removed", async () => {
	const roomId = `cwd-${"c".repeat(32)}`;
	const targetRuntimeId = crypto.randomUUID();
	const senderRuntimeId = crypto.randomUUID();
	await coordinator.writePresence(presence({ roomId, runtimeId: targetRuntimeId }));
	const base = {
		roomId,
		targetRuntimeId,
		sender: {
			runtimeId: senderRuntimeId,
			sessionId: crypto.randomUUID(),
			worktreeRoot: process.cwd(),
		},
	};
	const envelope = coordinator.createEnvelope({ ...base, message: "coordinate this change" });
	await coordinator.enqueueMessage(envelope);
	assert.deepEqual(coordinator.readInbox(roomId, targetRuntimeId).map((item) => item.envelope.id), [envelope.id]);

	const item = coordinator.readInbox(roomId, targetRuntimeId)[0];
	await coordinator.removeInboxItem(item);
	assert.equal(coordinator.readInbox(roomId, targetRuntimeId).length, 0);

	const expired = coordinator.createEnvelope({ ...base, message: "old", now: 0 });
	await coordinator.enqueueMessage(expired);
	assert.equal(coordinator.readInbox(roomId, targetRuntimeId).length, 0);
	assert.throws(
		() => coordinator.createEnvelope({ ...base, message: "x".repeat(coordinator.MAX_MESSAGE_BYTES + 1) }),
		/at most/,
	);
});

function runWriter(roomId: string, targetRuntimeId: string, prefix: string, count: number): Promise<void> {
	const fixture = path.join(import.meta.dirname, "fixtures", "session_coordinator_writer.mjs");
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [fixture, stateDir, roomId, targetRuntimeId, prefix, String(count)], {
			cwd: path.resolve(import.meta.dirname, ".."),
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("error", reject);
		child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${prefix} exited ${code}: ${stderr}`))));
	});
}

test("independent processes preserve concurrent inbox messages", async () => {
	const roomId = `cwd-${"d".repeat(32)}`;
	const targetRuntimeId = crypto.randomUUID();
	await coordinator.writePresence(presence({ roomId, runtimeId: targetRuntimeId }));
	await Promise.all([
		runWriter(roomId, targetRuntimeId, "aaaaaaaa", 15),
		runWriter(roomId, targetRuntimeId, "bbbbbbbb", 15),
		runWriter(roomId, targetRuntimeId, "cccccccc", 15),
		runWriter(roomId, targetRuntimeId, "dddddddd", 15),
	]);
	const messages = coordinator.readInbox(roomId, targetRuntimeId).map((item) => item.envelope.message);
	assert.equal(messages.length, 60);
	for (const prefix of ["aaaaaaaa", "bbbbbbbb", "cccccccc", "dddddddd"]) {
		assert.equal(messages.filter((message) => message.startsWith(prefix)).length, 15);
	}
});

test("concurrent writers cannot exceed the transactional inbox cap", async () => {
	const roomId = `cwd-${"e".repeat(32)}`;
	const targetRuntimeId = crypto.randomUUID();
	const sender = {
		runtimeId: crypto.randomUUID(),
		sessionId: crypto.randomUUID(),
		worktreeRoot: process.cwd(),
	};
	await coordinator.writePresence(presence({ roomId, runtimeId: targetRuntimeId }));
	for (let index = 0; index < coordinator.MAX_INBOX_MESSAGES - 1; index++) {
		await coordinator.enqueueMessage(
			coordinator.createEnvelope({ roomId, targetRuntimeId, sender, message: `seed-${index}` }),
		);
	}
	const attempts = await Promise.allSettled(
		Array.from({ length: 20 }, (_, index) =>
			coordinator.enqueueMessage(
				coordinator.createEnvelope({ roomId, targetRuntimeId, sender, message: `race-${index}` }),
			),
		),
	);
	assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
	assert.equal(coordinator.readInbox(roomId, targetRuntimeId).length, coordinator.MAX_INBOX_MESSAGES);
});

test("runtime cleanup drains racing messages and rejects delivery after presence removal", async () => {
	const roomId = `cwd-${"1".repeat(32)}`;
	const targetRuntimeId = crypto.randomUUID();
	const sender = {
		runtimeId: crypto.randomUUID(),
		sessionId: crypto.randomUUID(),
		worktreeRoot: process.cwd(),
	};
	await coordinator.writePresence(presence({ roomId, runtimeId: targetRuntimeId }));
	const envelope = coordinator.createEnvelope({ roomId, targetRuntimeId, sender, message: "drain me" });
	await coordinator.enqueueMessage(envelope);
	const racing = Array.from({ length: 20 }, (_, index) =>
		coordinator.createEnvelope({ roomId, targetRuntimeId, sender, message: `race-cleanup-${index}` }),
	);
	const enqueueAttempts = racing.map((message) => coordinator.enqueueMessage(message));
	const drained: string[] = [];
	const cleanup = coordinator.removeRuntimeState(roomId, targetRuntimeId, (message) => drained.push(message.id));
	const results = await Promise.allSettled([...enqueueAttempts, cleanup]);
	assert.equal(results.at(-1)?.status, "fulfilled");
	const deliveredBeforeCleanup = racing
		.filter((_message, index) => results[index]?.status === "fulfilled")
		.map((message) => message.id);
	assert.deepEqual(new Set(drained), new Set([envelope.id, ...deliveredBeforeCleanup]));
	assert.equal(fs.existsSync(coordinator.inboxDir(roomId, targetRuntimeId)), false);
	assert.equal(coordinator.listActivePeers(roomId).some((peer) => peer.runtimeId === targetRuntimeId), false);
	await assert.rejects(
		coordinator.enqueueMessage(
			coordinator.createEnvelope({ roomId, targetRuntimeId, sender, message: "too late" }),
		),
		/no longer live/,
	);
});

test("coordinator-wide pruning removes stale dead presence across rooms", async () => {
	const roomId = `git-${"8".repeat(32)}`;
	const stale = presence({ roomId, pid: 99_999_999, leaseExpiresAt: 0 });
	await coordinator.writePresence(stale);
	const presencePath = path.join(stateDir, "rooms", roomId, "presence", `${stale.runtimeId}.json`);
	assert.equal(fs.existsSync(presencePath), true);

	await coordinator.pruneCoordinatorState(Date.now() + 25 * 60 * 60 * 1_000);
	assert.equal(fs.existsSync(presencePath), false);
});

test("coordinator-wide pruning preserves live targets during concurrent delivery", async () => {
	const now = Date.now();
	const roomId = `git-${"9".repeat(32)}`;
	const target = presence({ roomId, leaseExpiresAt: now + 20_000 });
	await coordinator.writePresence(target);
	const envelope = coordinator.createEnvelope({
		roomId,
		targetRuntimeId: target.runtimeId,
		sender: {
			runtimeId: crypto.randomUUID(),
			sessionId: crypto.randomUUID(),
			worktreeRoot: process.cwd(),
		},
		message: "deliver while pruning",
	});

	await Promise.all([coordinator.pruneCoordinatorState(now + 25 * 60 * 60 * 1_000), coordinator.enqueueMessage(envelope)]);
	assert.equal(coordinator.listAllActivePeers(undefined, now).some((peer: PeerPresence) => peer.runtimeId === target.runtimeId), true);
	assert.equal(coordinator.readInbox(roomId, target.runtimeId).some((item: { envelope: { id: string } }) => item.envelope.id === envelope.id), true);
});

test("orphan inbox directories are pruned independently of presence files", async () => {
	const roomId = `cwd-${"2".repeat(32)}`;
	const runtimeId = crypto.randomUUID();
	const dir = coordinator.inboxDir(roomId, runtimeId);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const old = new Date(0);
	fs.utimesSync(dir, old, old);
	await coordinator.pruneRoom(roomId, 2 * 24 * 60 * 60 * 1_000);
	assert.equal(fs.existsSync(dir), false);
});

test("legacy presence and envelopes remain valid without protocol-v2 fields", () => {
	const legacyPresence = { ...presence(), protocolVersion: undefined };
	assert.equal(coordinator.normalizePresence(legacyPresence)?.protocolVersion, undefined);
	const legacyEnvelope = coordinator.createEnvelope({
		roomId: legacyPresence.roomId,
		targetRuntimeId: legacyPresence.runtimeId,
		sender: {
			runtimeId: crypto.randomUUID(),
			sessionId: crypto.randomUUID(),
			worktreeRoot: process.cwd(),
		},
		message: "legacy-compatible",
	});
	assert.equal(coordinator.normalizeEnvelope(legacyEnvelope)?.targetSessionId, undefined);
	assert.equal(coordinator.normalizeEnvelope(legacyEnvelope)?.requestAcknowledgment, undefined);
});

test("outgoing lifecycle records are private, monotonic, and expose truthful terminal warnings", async () => {
	const now = Date.now();
	const roomId = `cwd-${"0".repeat(32)}`;
	const senderSessionId = "sender-session-status";
	const target = presence({ roomId, sessionId: "target-session-status" });
	await coordinator.writePresence(target);
	const envelope = coordinator.createEnvelope({
		roomId,
		targetRuntimeId: target.runtimeId,
		targetSessionId: target.sessionId,
		sender: {
			runtimeId: crypto.randomUUID(),
			sessionId: senderSessionId,
			worktreeRoot: process.cwd(),
		},
		message: "track me",
		requestAcknowledgment: true,
		now,
	});
	await coordinator.persistOutgoingMessageStatus({ envelope, targetSessionName: "Tracked peer", trackingSupported: true });
	assert.equal(coordinator.readOutgoingMessageStatuses(senderSessionId, envelope.id, now)[0].effectiveStatus, "pending");
	await coordinator.updateOutgoingMessageStatus(senderSessionId, envelope.id, "queued", now + 1);
	const statusPath = path.join(
		stateDir,
		"outgoing-status",
		`session-${crypto.createHash("sha256").update(senderSessionId).digest("hex")}`,
		`${envelope.id}.json`,
	);
	assert.equal(fs.statSync(statusPath).mode & 0o777, 0o600);

	await coordinator.updateOutgoingMessageStatus(senderSessionId, envelope.id, "delivered", now + 1);
	await coordinator.updateOutgoingMessageStatus(senderSessionId, envelope.id, "surfaced", now + 2);
	await coordinator.updateOutgoingMessageStatus(senderSessionId, envelope.id, "acknowledged", now + 3);
	await coordinator.updateOutgoingMessageStatus(senderSessionId, envelope.id, "delivered", now + 4);
	let status = coordinator.readOutgoingMessageStatuses(senderSessionId, envelope.id, now + 4)[0];
	assert.equal(status.effectiveStatus, "acknowledged", "later lower-ranked writes must not regress status");
	await coordinator.updateOutgoingMessageStatus(senderSessionId, envelope.id, "replied", now + 5);
	status = coordinator.readOutgoingMessageStatuses(senderSessionId, envelope.id, now + 5)[0];
	assert.equal(status.effectiveStatus, "replied");
	assert.equal(status.acknowledgmentRequested, true);

	const unread = coordinator.createEnvelope({
		roomId,
		targetRuntimeId: target.runtimeId,
		targetSessionId: target.sessionId,
		sender: { runtimeId: crypto.randomUUID(), sessionId: senderSessionId, worktreeRoot: process.cwd() },
		message: "runtime exits first",
		now,
	});
	await coordinator.persistOutgoingMessageStatus({ envelope: unread, trackingSupported: true });
	await coordinator.updateOutgoingMessageStatus(senderSessionId, unread.id, "queued", now + 1);
	await coordinator.writePresence({ ...target, sessionId: "target-switched-sessions" });
	assert.equal(
		coordinator.readOutgoingMessageStatuses(senderSessionId, unread.id, now + 5)[0].effectiveStatus,
		"unread_session_ended",
		"a reused runtime must not count as the originally targeted Pi session",
	);
	await coordinator.removeRuntimeState(roomId, target.runtimeId);
	assert.equal(
		coordinator.readOutgoingMessageStatuses(senderSessionId, unread.id, now + 10)[0].effectiveStatus,
		"unread_session_ended",
	);

	const expired = coordinator.createEnvelope({
		roomId,
		targetRuntimeId: crypto.randomUUID(),
		targetSessionId: "expired-target",
		sender: { runtimeId: crypto.randomUUID(), sessionId: senderSessionId, worktreeRoot: process.cwd() },
		message: "expire me",
		now: 0,
	});
	await coordinator.persistOutgoingMessageStatus({ envelope: expired, trackingSupported: true });
	assert.equal(
		coordinator.readOutgoingMessageStatuses(senderSessionId, expired.id, expired.expiresAt + 1)[0].effectiveStatus,
		"expired",
	);

	const legacyUntracked = coordinator.createEnvelope({
		roomId,
		targetRuntimeId: crypto.randomUUID(),
		sender: { runtimeId: crypto.randomUUID(), sessionId: senderSessionId, worktreeRoot: process.cwd() },
		message: "legacy status remains unknown",
		now: 0,
	});
	await coordinator.persistOutgoingMessageStatus({ envelope: legacyUntracked, trackingSupported: false });
	await coordinator.updateOutgoingMessageStatus(senderSessionId, legacyUntracked.id, "queued", 1);
	assert.equal(
		coordinator.readOutgoingMessageStatuses(senderSessionId, legacyUntracked.id, legacyUntracked.expiresAt + 1)[0]
			.effectiveStatus,
		"queued",
		"legacy peers must not produce false unread or expired claims",
	);
});

test("outgoing lifecycle storage is capped and pruned after retention", async () => {
	const senderSessionId = "bounded-status-sender";
	const sender = { runtimeId: crypto.randomUUID(), sessionId: senderSessionId, worktreeRoot: process.cwd() };
	const ids: string[] = [];
	for (let index = 0; index < coordinator.MAX_OUTGOING_STATUS_RECORDS + 5; index++) {
		const envelope = coordinator.createEnvelope({
			roomId: `cwd-${"f".repeat(32)}`,
			targetRuntimeId: crypto.randomUUID(),
			targetSessionId: "bounded-target",
			sender,
			message: `bounded-${index}`,
			now: index,
		});
		ids.push(envelope.id);
		await coordinator.persistOutgoingMessageStatus({ envelope, trackingSupported: true });
	}
	const statuses = coordinator.readOutgoingMessageStatuses(senderSessionId, undefined, 1_000);
	assert.equal(statuses.length, coordinator.MAX_OUTGOING_STATUS_RECORDS);
	assert.equal(statuses.some((status: { messageId: string }) => status.messageId === ids[0]), false);
	assert.equal(statuses.some((status: { messageId: string }) => status.messageId === ids.at(-1)), true);
	const racingEnvelope = coordinator.createEnvelope({
		roomId: `cwd-${"f".repeat(32)}`,
		targetRuntimeId: crypto.randomUUID(),
		targetSessionId: "bounded-target",
		sender,
		message: "racing-cap-write",
		now: coordinator.MAX_OUTGOING_STATUS_RECORDS + 10,
	});
	await Promise.all([
		coordinator.persistOutgoingMessageStatus({ envelope: racingEnvelope, trackingSupported: true }),
		coordinator.updateOutgoingMessageStatus(senderSessionId, ids.at(-1)!, "queued"),
	]);
	assert.equal(
		coordinator.readOutgoingMessageStatuses(senderSessionId, undefined, 1_000).length,
		coordinator.MAX_OUTGOING_STATUS_RECORDS,
	);
	await coordinator.pruneOutgoingMessageStatuses(
		coordinator.DEFAULT_MESSAGE_TTL_MS + 25 * 60 * 60 * 1_000,
	);
	assert.equal(coordinator.readOutgoingMessageStatuses(senderSessionId).length, 0);
});

test("a same-room successor adopts only messages bound to its exact Pi session id", async () => {
	const roomId = `cwd-${"a".repeat(32)}`;
	const predecessor = presence({ roomId, sessionId: "stable-target-session" });
	await coordinator.writePresence(predecessor);
	const sender = { runtimeId: crypto.randomUUID(), sessionId: "sender", worktreeRoot: process.cwd() };
	const matching = coordinator.createEnvelope({
		roomId,
		targetRuntimeId: predecessor.runtimeId,
		targetSessionId: predecessor.sessionId,
		sender,
		message: "adopt me",
	});
	const mismatched = coordinator.createEnvelope({
		roomId,
		targetRuntimeId: predecessor.runtimeId,
		targetSessionId: "different-session",
		sender,
		message: "do not adopt me",
	});
	const legacy = coordinator.createEnvelope({
		roomId,
		targetRuntimeId: predecessor.runtimeId,
		sender,
		message: "legacy message fails closed",
	});
	await coordinator.enqueueMessage(matching);
	await coordinator.enqueueMessage(legacy);
	await assert.rejects(coordinator.enqueueMessage(mismatched), /changed Pi sessions/);
	await coordinator.writePresence({ ...predecessor, sessionId: "different-session" });
	await coordinator.enqueueMessage(mismatched);
	await coordinator.writePresence({ ...predecessor, sessionId: "different-session", pid: 99_999_999 });

	const adopted: string[] = [];
	const count = await coordinator.adoptSessionInboxMessages(
		roomId,
		crypto.randomUUID(),
		predecessor.sessionId,
		(envelope: { id: string }) => adopted.push(envelope.id),
	);
	assert.equal(count, 1);
	assert.deepEqual(adopted, [matching.id]);
	assert.deepEqual(
		new Set(
			coordinator.readInbox(roomId, predecessor.runtimeId).map((item: { envelope: { id: string } }) => item.envelope.id),
		),
		new Set([mismatched.id, legacy.id]),
	);
});

test("recipient session receipts enforce transactional backpressure", async () => {
	const now = Date.now();
	const sessionId = "bounded-recipient-session";
	const sender = { runtimeId: crypto.randomUUID(), sessionId: "receipt-sender", worktreeRoot: process.cwd() };
	const receipts: Array<{ path: string; envelope: { id: string } }> = [];
	for (let index = 0; index < coordinator.MAX_SESSION_RECEIPTS; index++) {
		const envelope = coordinator.createEnvelope({
			roomId: `cwd-${"7".repeat(32)}`,
			targetRuntimeId: crypto.randomUUID(),
			targetSessionId: sessionId,
			sender,
			message: `receipt-${index}`,
			now: now + index,
		});
		receipts.push(await coordinator.persistSessionReceipt(sessionId, envelope));
	}
	const overflow = coordinator.createEnvelope({
		roomId: `cwd-${"7".repeat(32)}`,
		targetRuntimeId: crypto.randomUUID(),
		targetSessionId: sessionId,
		sender,
		message: "overflow",
	});
	await assert.rejects(coordinator.persistSessionReceipt(sessionId, overflow), /receipt inbox is full/);
	await coordinator.removeSessionReceipt(receipts[0]);
	await coordinator.persistSessionReceipt(sessionId, overflow);
	assert.equal(coordinator.readSessionReceipts(sessionId).length, coordinator.MAX_SESSION_RECEIPTS);
});

test("session receipts remain durable independently of Pi session-file creation", async () => {
	const sessionId = "custom.session-1";
	const envelope = coordinator.createEnvelope({
		roomId: `cwd-${"3".repeat(32)}`,
		targetRuntimeId: crypto.randomUUID(),
		sender: {
			runtimeId: crypto.randomUUID(),
			sessionId: crypto.randomUUID(),
			worktreeRoot: process.cwd(),
		},
		message: "durable receipt",
	});
	const receipt = await coordinator.persistSessionReceipt(sessionId, envelope);
	assert.match(path.basename(path.dirname(receipt.path)), /^session-[0-9a-f]{64}$/);
	assert.doesNotMatch(receipt.path, /custom\.session-1/);
	assert.equal(fs.existsSync(receipt.path), true);
	assert.equal(fs.statSync(receipt.path).mode & 0o777, 0o600);
	assert.deepEqual(coordinator.readSessionReceipts(sessionId).map((item) => item.envelope.id), [envelope.id]);
	await coordinator.removeSessionReceipt(receipt);
	assert.equal(coordinator.readSessionReceipts(sessionId).length, 0);
});
