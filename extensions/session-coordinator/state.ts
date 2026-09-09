import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteJson, readJsonFile, withInterprocessLock } from "../_shared/file-lock.ts";

export const COORDINATOR_VERSION = 1;
export const DEFAULT_HEARTBEAT_MS = 5_000;
export const DEFAULT_POLL_MS = 1_000;
export const DEFAULT_LEASE_MS = 20_000;
export const DEFAULT_MESSAGE_TTL_MS = 24 * 60 * 60 * 1_000;
export const MAX_MESSAGE_BYTES = 8 * 1_024;
export const MAX_INBOX_MESSAGES = 100;
export const MAX_STATUS_CHARS = 200;
export const MAX_WORKSPACE_CHANGES = 10;
export const MAX_OUTGOING_STATUS_RECORDS = 100;
export const MAX_SESSION_RECEIPTS = 100;
export const MAX_RESPONSE_REQUESTS = 100;
const STALE_RETENTION_MS = 24 * 60 * 60 * 1_000;
const RUNTIME_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROOM_ID_RE = /^(?:git|cwd)-[0-9a-f]{32}$/;
const RECEIPT_KEY_RE = /^session-[0-9a-f]{64}$/;

export type PeerActivity = "busy" | "idle";

export interface RepositoryScope {
	roomId: string;
	kind: "git" | "cwd";
	identityPath: string;
	cwd: string;
	worktreeRoot: string;
	branch?: string;
	workspaceChanges?: string[];
	workspaceChangesOmitted?: number;
}

export interface PeerPresence {
	version: 1;
	roomId: string;
	runtimeId: string;
	pid: number;
	sessionId: string;
	sessionName?: string;
	cwd: string;
	worktreeRoot: string;
	branch?: string;
	activity: PeerActivity;
	status?: string;
	startedAt: number;
	heartbeatAt: number;
	leaseExpiresAt: number;
	capabilities: ["messages"];
	protocolVersion?: 2;
	requestResponseVersion?: 1;
	workspaceChanges?: string[];
	workspaceChangesOmitted?: number;
}

export interface PeerMessageSender {
	runtimeId: string;
	sessionId: string;
	sessionName?: string;
	worktreeRoot: string;
}

export interface PeerMessageEnvelope {
	version: 1;
	id: string;
	roomId: string;
	targetRuntimeId: string;
	targetSessionId?: string;
	sender: PeerMessageSender;
	message: string;
	inReplyTo?: string;
	requestAcknowledgment?: boolean;
	requestResponse?: boolean;
	hops: 0 | 1;
	createdAt: number;
	expiresAt: number;
	untrusted: true;
}

export interface InboxItem {
	path: string;
	envelope: PeerMessageEnvelope;
}

export type PersistedMessageStatus = "pending" | "queued" | "delivered" | "surfaced" | "acknowledged" | "replied";
export type MessageStatus = PersistedMessageStatus | "expired" | "unread_session_ended";

export interface PeerMessageStatusRecord {
	version: 1;
	messageId: string;
	senderSessionId: string;
	targetRoomId: string;
	targetRuntimeId: string;
	targetSessionId?: string;
	targetSessionName?: string;
	trackingSupported: boolean;
	acknowledgmentRequested: boolean;
	responseRequested?: boolean;
	responseAnsweredAt?: number;
	status: PersistedMessageStatus;
	createdAt: number;
	updatedAt: number;
	expiresAt: number;
	deliveredAt?: number;
	surfacedAt?: number;
	acknowledgedAt?: number;
	repliedAt?: number;
}

export interface PeerMessageStatusView extends PeerMessageStatusRecord {
	effectiveStatus: MessageStatus;
	responseStatus?: "pending" | "answered" | "unanswered" | "expired";
}

export interface ResponseRequestBinding {
	messageId: string;
	senderSessionId: string;
	recipientSessionId: string;
	expiresAt: number;
}

function parsePositiveInteger(value: string | undefined, fallback: number, minimum: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

export function coordinatorConfig() {
	const heartbeatMs = parsePositiveInteger(
		process.env.PI_SESSION_COORDINATOR_HEARTBEAT_MS,
		DEFAULT_HEARTBEAT_MS,
		100,
	);
	return {
		stateDir: resolveStateDir(
			process.env.PI_SESSION_COORDINATOR_DIR ?? path.join(os.homedir(), ".pi", "session-coordinator"),
		),
		heartbeatMs,
		pollMs: parsePositiveInteger(process.env.PI_SESSION_COORDINATOR_POLL_MS, DEFAULT_POLL_MS, 50),
		leaseMs: Math.max(
			parsePositiveInteger(process.env.PI_SESSION_COORDINATOR_LEASE_MS, DEFAULT_LEASE_MS, 1_000),
			heartbeatMs * 3,
		),
	};
}

function resolveStateDir(value: string): string {
	const expanded = value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
	return path.resolve(expanded);
}

function canonicalPath(value: string): string {
	const resolved = path.resolve(value);
	try {
		return fs.realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}

function gitRaw(cwd: string, args: string[]): string | undefined {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2_000,
			maxBuffer: 64 * 1_024,
		});
	} catch {
		return undefined;
	}
}

function git(cwd: string, args: string[]): string | undefined {
	return gitRaw(cwd, args)?.trim() || undefined;
}

function gitWorkspaceChanges(cwd: string): { files?: string[]; omitted?: number } {
	const raw = gitRaw(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]);
	if (!raw) return {};
	const entries = raw.split("\0").filter(Boolean);
	const files: string[] = [];
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (entry.length < 4) continue;
		const status = entry.slice(0, 2);
		const file = entry
			.slice(3)
			.replace(/[\u0000-\u001f\u007f]/g, " ")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 512);
		if (file) files.push(file);
		if (status.includes("R") || status.includes("C")) index += 1;
	}
	const visible = files.slice(0, MAX_WORKSPACE_CHANGES);
	return {
		files: visible.length > 0 ? visible : undefined,
		omitted: files.length > visible.length ? files.length - visible.length : undefined,
	};
}

function roomId(kind: RepositoryScope["kind"], identityPath: string): string {
	return `${kind}-${crypto.createHash("sha256").update(identityPath).digest("hex").slice(0, 32)}`;
}

export function discoverRepository(cwd: string): RepositoryScope {
	const canonicalCwd = canonicalPath(cwd);
	const commonDirRaw = git(canonicalCwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	const worktreeRaw = git(canonicalCwd, ["rev-parse", "--path-format=absolute", "--show-toplevel"]);
	if (!commonDirRaw || !worktreeRaw) {
		return {
			roomId: roomId("cwd", canonicalCwd),
			kind: "cwd",
			identityPath: canonicalCwd,
			cwd: canonicalCwd,
			worktreeRoot: canonicalCwd,
		};
	}

	const identityPath = canonicalPath(path.isAbsolute(commonDirRaw) ? commonDirRaw : path.resolve(canonicalCwd, commonDirRaw));
	const worktreeRoot = canonicalPath(path.isAbsolute(worktreeRaw) ? worktreeRaw : path.resolve(canonicalCwd, worktreeRaw));
	const symbolicBranch = git(canonicalCwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	const detachedCommit = symbolicBranch ? undefined : git(canonicalCwd, ["rev-parse", "--short", "HEAD"]);
	const changes = gitWorkspaceChanges(canonicalCwd);
	return {
		roomId: roomId("git", identityPath),
		kind: "git",
		identityPath,
		cwd: canonicalCwd,
		worktreeRoot,
		branch: symbolicBranch ?? (detachedCommit ? `detached@${detachedCommit}` : undefined),
		workspaceChanges: changes.files,
		workspaceChangesOmitted: changes.omitted,
	};
}

function ensurePrivateDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		fs.chmodSync(dir, 0o700);
	} catch {
		// Best effort on filesystems that do not support POSIX modes.
	}
}

function assertRoomId(value: string): void {
	if (!ROOM_ID_RE.test(value)) throw new Error("Invalid session-coordinator room id");
}

function assertRuntimeId(value: string): void {
	if (!RUNTIME_ID_RE.test(value)) throw new Error("Invalid session-coordinator runtime id");
}

function roomsRoot(): string {
	return path.join(coordinatorConfig().stateDir, "rooms");
}

function listRoomIds(): string[] {
	try {
		return fs
			.readdirSync(roomsRoot(), { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && ROOM_ID_RE.test(entry.name))
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

function roomDir(room: string): string {
	assertRoomId(room);
	return path.join(roomsRoot(), room);
}

function presenceDir(room: string): string {
	return path.join(roomDir(room), "presence");
}

function inboxRoot(room: string): string {
	return path.join(roomDir(room), "inbox");
}

function receiptRoot(): string {
	return path.join(coordinatorConfig().stateDir, "receipts");
}

function outgoingStatusRoot(): string {
	return path.join(coordinatorConfig().stateDir, "outgoing-status");
}

function receiptKey(sessionId: string): string {
	if (!sessionId || sessionId.length > 1_024) throw new Error("Invalid Pi session id for peer receipts");
	return `session-${crypto.createHash("sha256").update(sessionId).digest("hex")}`;
}

function receiptDir(sessionId: string): string {
	return path.join(receiptRoot(), receiptKey(sessionId));
}

function outgoingStatusDir(sessionId: string): string {
	return path.join(outgoingStatusRoot(), receiptKey(sessionId));
}

function outgoingStatusPath(sessionId: string, messageId: string): string {
	assertRuntimeId(messageId);
	return path.join(outgoingStatusDir(sessionId), `${messageId}.json`);
}

function outgoingStatusRecordsLockPath(sessionId: string): string {
	return path.join(outgoingStatusDir(sessionId), ".records.lock");
}

function receiptLockPath(sessionId: string): string {
	return path.join(receiptDir(sessionId), ".receipts.lock");
}

function ensureRoomDirs(room: string): void {
	const stateDir = coordinatorConfig().stateDir;
	ensurePrivateDir(stateDir);
	ensurePrivateDir(path.join(stateDir, "rooms"));
	ensurePrivateDir(roomDir(room));
	ensurePrivateDir(presenceDir(room));
	ensurePrivateDir(inboxRoot(room));
}

function ensureReceiptDirs(sessionId: string): void {
	const stateDir = coordinatorConfig().stateDir;
	ensurePrivateDir(stateDir);
	ensurePrivateDir(receiptRoot());
	ensurePrivateDir(receiptDir(sessionId));
}

function ensureOutgoingStatusDirs(sessionId: string): void {
	const stateDir = coordinatorConfig().stateDir;
	ensurePrivateDir(stateDir);
	ensurePrivateDir(outgoingStatusRoot());
	ensurePrivateDir(outgoingStatusDir(sessionId));
}

export function inboxDir(room: string, runtimeId: string): string {
	assertRuntimeId(runtimeId);
	return path.join(inboxRoot(room), runtimeId);
}

function presencePath(room: string, runtimeId: string): string {
	assertRuntimeId(runtimeId);
	return path.join(presenceDir(room), `${runtimeId}.json`);
}

function inboxLockPath(room: string, runtimeId: string): string {
	assertRuntimeId(runtimeId);
	return path.join(inboxRoot(room), `${runtimeId}.lock`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

export function sanitizeStatus(value: string | undefined): string | undefined {
	const normalized = value
		?.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_STATUS_CHARS);
	return normalized || undefined;
}

export function sanitizeMessage(value: string): string {
	return value
		.replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
		.trim();
}

function normalizeWorkspaceChanges(value: unknown): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > MAX_WORKSPACE_CHANGES) return undefined;
	const files = value.map((item) => boundedString(item, 512));
	return files.every((item): item is string => Boolean(item)) ? files : undefined;
}

export function normalizePresence(value: unknown): PeerPresence | undefined {
	if (!isRecord(value)) return undefined;
	const runtimeId = boundedString(value.runtimeId, 64);
	const room = boundedString(value.roomId, 64);
	const sessionId = boundedString(value.sessionId, 1_024);
	const cwd = boundedString(value.cwd, 8_192);
	const worktreeRoot = boundedString(value.worktreeRoot, 8_192);
	if (
		value.version !== COORDINATOR_VERSION ||
		!runtimeId ||
		!RUNTIME_ID_RE.test(runtimeId) ||
		!room ||
		!ROOM_ID_RE.test(room) ||
		!sessionId ||
		!cwd ||
		!worktreeRoot ||
		!Number.isInteger(value.pid) ||
		Number(value.pid) <= 0 ||
		(value.activity !== "busy" && value.activity !== "idle") ||
		typeof value.startedAt !== "number" ||
		typeof value.heartbeatAt !== "number" ||
		typeof value.leaseExpiresAt !== "number" ||
		!Number.isFinite(value.startedAt) ||
		!Number.isFinite(value.heartbeatAt) ||
		!Number.isFinite(value.leaseExpiresAt) ||
		!Array.isArray(value.capabilities) ||
		value.capabilities.length !== 1 ||
		value.capabilities[0] !== "messages" ||
		(value.protocolVersion !== undefined && value.protocolVersion !== 2) ||
		(value.requestResponseVersion !== undefined && value.requestResponseVersion !== 1) ||
		(value.workspaceChangesOmitted !== undefined &&
			(!Number.isInteger(value.workspaceChangesOmitted) || Number(value.workspaceChangesOmitted) < 0))
	) {
		return undefined;
	}
	return {
		version: 1,
		roomId: room,
		runtimeId,
		pid: Number(value.pid),
		sessionId,
		sessionName: boundedString(value.sessionName, 200),
		cwd,
		worktreeRoot,
		branch: boundedString(value.branch, 256),
		activity: value.activity,
		status: sanitizeStatus(typeof value.status === "string" ? value.status : undefined),
		startedAt: value.startedAt,
		heartbeatAt: value.heartbeatAt,
		leaseExpiresAt: value.leaseExpiresAt,
		capabilities: ["messages"],
		protocolVersion: value.protocolVersion === 2 ? 2 : undefined,
		requestResponseVersion: value.requestResponseVersion === 1 ? 1 : undefined,
		workspaceChanges: normalizeWorkspaceChanges(value.workspaceChanges),
		workspaceChangesOmitted:
			typeof value.workspaceChangesOmitted === "number" ? value.workspaceChangesOmitted : undefined,
	};
}

export function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: any) {
		return error?.code === "EPERM";
	}
}

export function isPresenceActive(peer: PeerPresence, now = Date.now()): boolean {
	return peer.leaseExpiresAt > now && isProcessAlive(peer.pid);
}

export async function writePresence(peer: PeerPresence): Promise<void> {
	const normalized = normalizePresence(peer);
	if (!normalized) throw new Error("Invalid session-coordinator presence record");
	ensureRoomDirs(peer.roomId);
	ensurePrivateDir(inboxDir(peer.roomId, peer.runtimeId));
	await atomicWriteJson(presencePath(peer.roomId, peer.runtimeId), normalized);
}

export async function removeRuntimeState(
	room: string,
	runtimeId: string,
	onMessage?: (envelope: PeerMessageEnvelope) => Promise<void> | void,
): Promise<void> {
	ensureRoomDirs(room);
	await withInterprocessLock(
		inboxLockPath(room, runtimeId),
		async () => {
			// Stop publication even if receipt backpressure prevents a complete drain.
			// With no presence, an exact-session successor can adopt the unread remainder.
			await fs.promises.rm(presencePath(room, runtimeId), { force: true });
			if (onMessage) {
				for (const item of readInbox(room, runtimeId)) {
					await onMessage(item.envelope);
					await removeInboxItem(item);
				}
			}
			await fs.promises.rm(inboxDir(room, runtimeId), { recursive: true, force: true });
		},
		{ timeoutMs: 10_000, staleMs: 30_000, retryMs: 25 },
	);
}

function readRoomPeers(room: string): PeerPresence[] {
	let names: string[];
	try {
		names = fs.readdirSync(presenceDir(room));
	} catch {
		return [];
	}
	return names
		.filter((name) => name.endsWith(".json"))
		.map((name) => normalizePresence(readJsonFile<unknown>(path.join(presenceDir(room), name), undefined)))
		.filter((peer): peer is PeerPresence => Boolean(peer))
		.filter((peer) => peer.roomId === room);
}

export function listActivePeers(room: string, selfRuntimeId?: string, now = Date.now()): PeerPresence[] {
	return readRoomPeers(room)
		.filter((peer) => peer.runtimeId !== selfRuntimeId && isPresenceActive(peer, now))
		.sort((left, right) => left.startedAt - right.startedAt || left.runtimeId.localeCompare(right.runtimeId));
}

export function listAllActivePeers(selfRuntimeId?: string, now = Date.now()): PeerPresence[] {
	return listRoomIds()
		.flatMap((room) => listActivePeers(room, selfRuntimeId, now))
		.sort((left, right) => left.startedAt - right.startedAt || left.runtimeId.localeCompare(right.runtimeId));
}

interface ResponseRequestRecord extends ResponseRequestBinding {
	replyAttempted?: true;
	replyQueued?: true;
}

interface ResponseRequestLedger {
	version: 1;
	recipientSessionId: string;
	requests: ResponseRequestRecord[];
}

function responseLedgerPath(sessionId: string): string {
	return path.join(coordinatorConfig().stateDir, "response-requests", `${receiptKey(sessionId)}.json`);
}

function validResponseBinding(value: unknown): value is ResponseRequestBinding {
	return isRecord(value) && typeof value.messageId === "string" && RUNTIME_ID_RE.test(value.messageId)
		&& Boolean(boundedString(value.senderSessionId, 1_024))
		&& Boolean(boundedString(value.recipientSessionId, 1_024))
		&& typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt) && value.expiresAt > 0;
}

function readResponseLedger(sessionId: string): ResponseRequestLedger {
	let value: unknown;
	try {
		// Unlike readJsonFile's fallback, only absence is safe to initialize. A
		// malformed ledger must never erase an already-consumed attempt.
		value = JSON.parse(fs.readFileSync(responseLedgerPath(sessionId), "utf8"));
	} catch (error: any) {
		if (error?.code === "ENOENT") return { version: 1, recipientSessionId: sessionId, requests: [] };
		throw new Error("Unreadable or corrupt response request ledger", { cause: error });
	}
	const corrupt = () => new Error("Corrupt response request ledger");
	if (!isRecord(value) || value.version !== 1 || value.recipientSessionId !== sessionId
		|| !Array.isArray(value.requests) || value.requests.length > MAX_RESPONSE_REQUESTS) throw corrupt();
	const ids = new Set<string>();
	const requests: ResponseRequestRecord[] = [];
	for (const item of value.requests) {
		if (!validResponseBinding(item) || !isRecord(item) || item.recipientSessionId !== sessionId
			|| ids.has(item.messageId)
			|| (item.replyAttempted !== undefined && item.replyAttempted !== true)
			|| (item.replyQueued !== undefined && item.replyQueued !== true)
			|| (item.replyQueued === true && item.replyAttempted !== true)) throw corrupt();
		if (!item.replyAttempted) throw corrupt();
		ids.add(item.messageId);
		// Explicit projection keeps the durable ledger body-free.
		requests.push({ messageId: item.messageId, senderSessionId: item.senderSessionId,
			recipientSessionId: sessionId, expiresAt: item.expiresAt,
			replyAttempted: item.replyAttempted as true | undefined, replyQueued: item.replyQueued as true | undefined });
	}
	return { version: 1, recipientSessionId: sessionId, requests };
}

function boundResponseRequest(ledger: ResponseRequestLedger, binding: ResponseRequestBinding): ResponseRequestRecord | undefined {
	const record = ledger.requests.find((item) => item.messageId === binding.messageId);
	if (record && (record.senderSessionId !== binding.senderSessionId || record.expiresAt !== binding.expiresAt
		|| record.recipientSessionId !== binding.recipientSessionId)) throw new Error("Response request binding mismatch");
	return record;
}

function addResponseRequest(ledger: ResponseRequestLedger, binding: ResponseRequestBinding): ResponseRequestRecord {
	// Retain every unexpired reply-attempt guard; never evict one to make room.
	ledger.requests = ledger.requests.filter((item) => item.expiresAt > Date.now());
	if (ledger.requests.length >= MAX_RESPONSE_REQUESTS) {
		throw new Error(`Response request ledger is full (${MAX_RESPONSE_REQUESTS} requests).`);
	}
	const record = { messageId: binding.messageId, senderSessionId: binding.senderSessionId,
		recipientSessionId: binding.recipientSessionId, expiresAt: binding.expiresAt };
	ledger.requests.push(record);
	return record;
}

async function withResponseLedger<T>(binding: ResponseRequestBinding, mutate: (ledger: ResponseRequestLedger) => T): Promise<T> {
	if (!validResponseBinding(binding)) throw new Error("Invalid response request binding");
	const filePath = responseLedgerPath(binding.recipientSessionId);
	ensurePrivateDir(coordinatorConfig().stateDir);
	ensurePrivateDir(path.dirname(filePath));
	return withInterprocessLock(`${filePath}.lock`, async () => {
		const ledger = readResponseLedger(binding.recipientSessionId);
		const result = mutate(ledger);
		await atomicWriteJson(filePath, ledger);
		return result;
	}, { timeoutMs: 10_000, staleMs: 30_000, retryMs: 25 });
}

/** Claim before publication; uncertain enqueue failures deliberately consume it. */
export async function claimRequestReply(binding: ResponseRequestBinding): Promise<boolean> {
	return withResponseLedger(binding, (ledger) => {
		let record = boundResponseRequest(ledger, binding);
		if (record?.replyAttempted || binding.expiresAt <= Date.now()) return false;
		record ??= addResponseRequest(ledger, binding);
		record.replyAttempted = true;
		return true;
	});
}

/** Only call after reply enqueue has resolved successfully. Delivery rank is not proof. */
export async function markRequestReplyQueued(binding: ResponseRequestBinding): Promise<void> {
	await withResponseLedger(binding, (ledger) => {
		const record = boundResponseRequest(ledger, binding);
		if (!record?.replyAttempted) throw new Error("Response reply was not claimed before enqueue");
		record.replyQueued = true;
	});
	// Preserve the confirmed outcome for the sender's full receipt-retention
	// window even after an expired recipient replay guard is pruned.
	ensureOutgoingStatusDirs(binding.senderSessionId);
	await withInterprocessLock(outgoingStatusRecordsLockPath(binding.senderSessionId), async () => {
		const filePath = outgoingStatusPath(binding.senderSessionId, binding.messageId);
		const record = normalizeMessageStatusRecord(readJsonFile<unknown>(filePath, undefined));
		if (!record || !record.responseRequested || record.senderSessionId !== binding.senderSessionId
			|| record.targetSessionId !== binding.recipientSessionId || record.expiresAt !== binding.expiresAt) return;
		if (record.responseAnsweredAt === undefined) await atomicWriteJson(filePath, { ...record, responseAnsweredAt: Date.now() });
	}, { timeoutMs: 10_000, staleMs: 30_000, retryMs: 25 });
}

function requestResponseStatus(record: PeerMessageStatusRecord, now: number): PeerMessageStatusView["responseStatus"] {
	if (record.responseAnsweredAt !== undefined) return "answered";
	const binding: ResponseRequestBinding = { messageId: record.messageId, senderSessionId: record.senderSessionId,
		recipientSessionId: record.targetSessionId!, expiresAt: record.expiresAt };
	const request = boundResponseRequest(readResponseLedger(binding.recipientSessionId), binding);
	if (request?.replyQueued) return "answered";
	if (binding.expiresAt <= now) return "expired";
	if (request?.replyAttempted) return "unanswered";
	return "pending";
}

const MESSAGE_STATUS_RANK: Record<PersistedMessageStatus, number> = {
	pending: 0,
	queued: 1,
	delivered: 2,
	surfaced: 3,
	acknowledged: 4,
	replied: 5,
};

export function normalizeMessageStatusRecord(value: unknown): PeerMessageStatusRecord | undefined {
	if (!isRecord(value)) return undefined;
	const messageId = boundedString(value.messageId, 64);
	const senderSessionId = boundedString(value.senderSessionId, 1_024);
	const targetRoomId = boundedString(value.targetRoomId, 64);
	const targetRuntimeId = boundedString(value.targetRuntimeId, 64);
	const targetSessionId = boundedString(value.targetSessionId, 1_024);
	const validStatus =
		typeof value.status === "string" && Object.hasOwn(MESSAGE_STATUS_RANK, value.status)
			? (value.status as PersistedMessageStatus)
			: undefined;
	if (
		value.version !== 1 ||
		!messageId ||
		!RUNTIME_ID_RE.test(messageId) ||
		!senderSessionId ||
		!targetRoomId ||
		!ROOM_ID_RE.test(targetRoomId) ||
		!targetRuntimeId ||
		!RUNTIME_ID_RE.test(targetRuntimeId) ||
		(value.targetSessionId !== undefined && !targetSessionId) ||
		typeof value.trackingSupported !== "boolean" ||
		typeof value.acknowledgmentRequested !== "boolean" ||
		(value.responseRequested !== undefined && typeof value.responseRequested !== "boolean") ||
		(value.responseRequested === true && !targetSessionId) ||
		!validStatus ||
		![value.createdAt, value.updatedAt, value.expiresAt].every(
			(item) => typeof item === "number" && Number.isFinite(item),
		)
	) {
		return undefined;
	}
	const optionalTimestamp = (name: string): number | undefined => {
		const item = value[name];
		return typeof item === "number" && Number.isFinite(item) ? item : undefined;
	};
	return {
		version: 1,
		messageId,
		senderSessionId,
		targetRoomId,
		targetRuntimeId,
		targetSessionId,
		targetSessionName: boundedString(value.targetSessionName, 200),
		trackingSupported: value.trackingSupported,
		acknowledgmentRequested: value.acknowledgmentRequested,
		responseRequested: value.responseRequested as boolean | undefined,
		status: validStatus,
		createdAt: value.createdAt as number,
		updatedAt: value.updatedAt as number,
		expiresAt: value.expiresAt as number,
		deliveredAt: optionalTimestamp("deliveredAt"),
		surfacedAt: optionalTimestamp("surfacedAt"),
		acknowledgedAt: optionalTimestamp("acknowledgedAt"),
		repliedAt: optionalTimestamp("repliedAt"),
		responseAnsweredAt: value.responseRequested === true ? optionalTimestamp("responseAnsweredAt") : undefined,
	};
}

function readOutgoingStatusRecords(sessionId: string): PeerMessageStatusRecord[] {
	let names: string[];
	try {
		names = fs.readdirSync(outgoingStatusDir(sessionId)).filter((name) => name.endsWith(".json"));
	} catch {
		return [];
	}
	return names
		.map((name) => normalizeMessageStatusRecord(readJsonFile<unknown>(path.join(outgoingStatusDir(sessionId), name), undefined)))
		.filter((record): record is PeerMessageStatusRecord => Boolean(record))
		.filter((record) => record.senderSessionId === sessionId)
		.sort((left, right) => right.createdAt - left.createdAt || left.messageId.localeCompare(right.messageId));
}

function targetOrSuccessorAlive(record: PeerMessageStatusRecord): boolean {
	// Heartbeat freshness controls discovery, not proof of termination. A busy or
	// suspended process can miss its lease while still owning this exact session.
	return readRoomPeers(record.targetRoomId).some(
		(peer) =>
			isProcessAlive(peer.pid) &&
			(record.targetSessionId
				? peer.sessionId === record.targetSessionId
				: peer.runtimeId === record.targetRuntimeId),
	);
}

function statusView(record: PeerMessageStatusRecord, now: number): PeerMessageStatusView {
	let effectiveStatus: MessageStatus = record.status;
	const responseStatus = record.responseRequested ? requestResponseStatus(record, now) : undefined;
	if (!record.trackingSupported) return { ...record, effectiveStatus, responseStatus };
	if (MESSAGE_STATUS_RANK[record.status] < MESSAGE_STATUS_RANK.surfaced && record.expiresAt <= now) {
		effectiveStatus = "expired";
	} else if (record.status === "queued" && !targetOrSuccessorAlive(record)) {
		effectiveStatus = "unread_session_ended";
	}
	return { ...record, effectiveStatus, responseStatus };
}

export function readOutgoingMessageStatuses(
	senderSessionId: string,
	messageId?: string,
	now = Date.now(),
): PeerMessageStatusView[] {
	const records = readOutgoingStatusRecords(senderSessionId);
	return records
		.filter((record) => !messageId || record.messageId === messageId)
		.map((record) => statusView(record, now));
}

export async function persistOutgoingMessageStatus(input: {
	envelope: PeerMessageEnvelope;
	targetSessionName?: string;
	trackingSupported: boolean;
}): Promise<PeerMessageStatusRecord> {
	const { envelope } = input;
	ensureOutgoingStatusDirs(envelope.sender.sessionId);
	const record: PeerMessageStatusRecord = {
		version: 1,
		messageId: envelope.id,
		senderSessionId: envelope.sender.sessionId,
		targetRoomId: envelope.roomId,
		targetRuntimeId: envelope.targetRuntimeId,
		targetSessionId: envelope.targetSessionId,
		targetSessionName: boundedString(input.targetSessionName, 200),
		trackingSupported: input.trackingSupported,
		acknowledgmentRequested: envelope.requestAcknowledgment === true,
		responseRequested: envelope.requestResponse === true ? true : undefined,
		status: "pending",
		createdAt: envelope.createdAt,
		updatedAt: envelope.createdAt,
		expiresAt: envelope.expiresAt,
	};
	await withInterprocessLock(
		outgoingStatusRecordsLockPath(envelope.sender.sessionId),
		async () => {
			const existingRecord = normalizeMessageStatusRecord(
				readJsonFile<unknown>(outgoingStatusPath(envelope.sender.sessionId, envelope.id), undefined),
			);
			if (existingRecord) return;
			const existing = readOutgoingStatusRecords(envelope.sender.sessionId);
			for (const stale of existing.slice(MAX_OUTGOING_STATUS_RECORDS - 1)) {
				await fs.promises.rm(outgoingStatusPath(envelope.sender.sessionId, stale.messageId), { force: true });
			}
			await atomicWriteJson(outgoingStatusPath(envelope.sender.sessionId, envelope.id), record);
		},
		{ timeoutMs: 10_000, staleMs: 30_000, retryMs: 25 },
	);
	return record;
}

export async function removeOutgoingMessageStatus(senderSessionId: string, messageId: string): Promise<void> {
	ensureOutgoingStatusDirs(senderSessionId);
	await withInterprocessLock(
		outgoingStatusRecordsLockPath(senderSessionId),
		() => fs.promises.rm(outgoingStatusPath(senderSessionId, messageId), { force: true }),
		{ timeoutMs: 10_000, staleMs: 30_000, retryMs: 25 },
	);
}

export async function updateOutgoingMessageStatus(
	senderSessionId: string,
	messageId: string,
	status: Exclude<PersistedMessageStatus, "pending">,
	now = Date.now(),
): Promise<PeerMessageStatusRecord | undefined> {
	const filePath = outgoingStatusPath(senderSessionId, messageId);
	ensureOutgoingStatusDirs(senderSessionId);
	return withInterprocessLock(
		outgoingStatusRecordsLockPath(senderSessionId),
		async () => {
			const current = normalizeMessageStatusRecord(readJsonFile<unknown>(filePath, undefined));
			if (!current || current.senderSessionId !== senderSessionId) return undefined;
			if (MESSAGE_STATUS_RANK[status] <= MESSAGE_STATUS_RANK[current.status]) return current;
			const next: PeerMessageStatusRecord = { ...current, status, updatedAt: now };
			if (status === "delivered") next.deliveredAt = now;
			if (status === "surfaced") next.surfacedAt = now;
			if (status === "acknowledged") next.acknowledgedAt = now;
			if (status === "replied") next.repliedAt = now;
			await atomicWriteJson(filePath, next);
			return next;
		},
		{ timeoutMs: 10_000, staleMs: 30_000, retryMs: 25 },
	);
}

export function normalizeEnvelope(value: unknown): PeerMessageEnvelope | undefined {
	if (!isRecord(value) || !isRecord(value.sender)) return undefined;
	const id = boundedString(value.id, 64);
	const room = boundedString(value.roomId, 64);
	const targetRuntimeId = boundedString(value.targetRuntimeId, 64);
	const targetSessionId = boundedString(value.targetSessionId, 1_024);
	const senderRuntimeId = boundedString(value.sender.runtimeId, 64);
	const senderSessionId = boundedString(value.sender.sessionId, 1_024);
	const senderWorktree = boundedString(value.sender.worktreeRoot, 8_192);
	const message = typeof value.message === "string" ? sanitizeMessage(value.message) : "";
	if (
		value.version !== COORDINATOR_VERSION ||
		!id ||
		!RUNTIME_ID_RE.test(id) ||
		!room ||
		!ROOM_ID_RE.test(room) ||
		!targetRuntimeId ||
		!RUNTIME_ID_RE.test(targetRuntimeId) ||
		!senderRuntimeId ||
		!RUNTIME_ID_RE.test(senderRuntimeId) ||
		!senderSessionId ||
		!senderWorktree ||
		!message ||
		Buffer.byteLength(message, "utf8") > MAX_MESSAGE_BYTES ||
		(value.hops !== 0 && value.hops !== 1) ||
		typeof value.createdAt !== "number" ||
		typeof value.expiresAt !== "number" ||
		!Number.isFinite(value.createdAt) ||
		!Number.isFinite(value.expiresAt) ||
		(value.targetSessionId !== undefined && !targetSessionId) ||
		(value.inReplyTo !== undefined &&
			(typeof value.inReplyTo !== "string" || !RUNTIME_ID_RE.test(value.inReplyTo))) ||
		(value.requestAcknowledgment !== undefined && typeof value.requestAcknowledgment !== "boolean") ||
		(value.requestResponse !== undefined && typeof value.requestResponse !== "boolean") ||
		(value.requestResponse === true && (!targetSessionId || value.hops !== 0 || value.inReplyTo !== undefined)) ||
		value.untrusted !== true
	) {
		return undefined;
	}
	return {
		version: 1,
		id,
		roomId: room,
		targetRuntimeId,
		targetSessionId,
		sender: {
			runtimeId: senderRuntimeId,
			sessionId: senderSessionId,
			sessionName: boundedString(value.sender.sessionName, 200),
			worktreeRoot: senderWorktree,
		},
		message,
		inReplyTo: boundedString(value.inReplyTo, 64),
		requestAcknowledgment: value.requestAcknowledgment === true ? true : undefined,
		requestResponse: value.requestResponse === true ? true : undefined,
		hops: value.hops,
		createdAt: value.createdAt,
		expiresAt: value.expiresAt,
		untrusted: true,
	};
}

export function createEnvelope(input: {
	roomId: string;
	targetRuntimeId: string;
	targetSessionId?: string;
	sender: PeerMessageSender;
	message: string;
	inReplyTo?: string;
	requestAcknowledgment?: boolean;
	requestResponse?: boolean;
	hops?: 0 | 1;
	now?: number;
}): PeerMessageEnvelope {
	if (input.requestResponse === true && (!boundedString(input.targetSessionId, 1_024)
		|| (input.hops ?? 0) !== 0 || input.inReplyTo !== undefined)) {
		throw new Error("Response requests require an exact target session, hops 0, and no inReplyTo.");
	}
	const now = input.now ?? Date.now();
	const envelope: PeerMessageEnvelope = {
		version: 1,
		id: crypto.randomUUID(),
		roomId: input.roomId,
		targetRuntimeId: input.targetRuntimeId,
		targetSessionId: input.targetSessionId,
		sender: input.sender,
		message: sanitizeMessage(input.message),
		inReplyTo: input.inReplyTo,
		requestAcknowledgment: input.requestAcknowledgment === true ? true : undefined,
		requestResponse: input.requestResponse,
		hops: input.hops ?? 0,
		createdAt: now,
		expiresAt: now + DEFAULT_MESSAGE_TTL_MS,
		untrusted: true,
	};
	const normalized = normalizeEnvelope(envelope);
	if (!normalized) throw new Error(`Peer message must be non-empty and at most ${MAX_MESSAGE_BYTES} UTF-8 bytes.`);
	return normalized;
}

export async function enqueueMessage(envelope: PeerMessageEnvelope): Promise<void> {
	const normalized = normalizeEnvelope(envelope);
	if (!normalized) throw new Error("Invalid peer message envelope");
	ensureRoomDirs(envelope.roomId);
	await withInterprocessLock(
		inboxLockPath(envelope.roomId, envelope.targetRuntimeId),
		async () => {
			const target = normalizePresence(
				readJsonFile<unknown>(presencePath(envelope.roomId, envelope.targetRuntimeId), undefined),
			);
			if (!target || target.roomId !== envelope.roomId || !isPresenceActive(target)) {
				throw new Error("Peer session is no longer live; refresh peer_sessions before retrying.");
			}
			if (envelope.targetSessionId && target.sessionId !== envelope.targetSessionId) {
				throw new Error("Peer runtime changed Pi sessions before delivery; refresh peer_sessions before retrying.");
			}
			if (normalized.requestResponse && target.requestResponseVersion !== 1) {
				throw new Error("Peer session does not support response requests; refresh peer_sessions before retrying.");
			}
			const dir = inboxDir(envelope.roomId, envelope.targetRuntimeId);
			ensurePrivateDir(dir);
			const queued = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).length;
			if (queued >= MAX_INBOX_MESSAGES) throw new Error(`Peer inbox is full (${MAX_INBOX_MESSAGES} messages).`);
			await atomicWriteJson(path.join(dir, `${envelope.createdAt}-${envelope.id}.json`), normalized);
		},
		{ timeoutMs: 10_000, staleMs: 30_000, retryMs: 25 },
	);
}

export function readInbox(room: string, runtimeId: string, now = Date.now()): InboxItem[] {
	const dir = inboxDir(room, runtimeId);
	let names: string[];
	try {
		names = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
	} catch {
		return [];
	}
	const items: InboxItem[] = [];
	for (const name of names.slice(0, MAX_INBOX_MESSAGES)) {
		const filePath = path.join(dir, name);
		const envelope = normalizeEnvelope(readJsonFile<unknown>(filePath, undefined));
		if (!envelope || envelope.roomId !== room || envelope.targetRuntimeId !== runtimeId || envelope.expiresAt <= now) {
			fs.rmSync(filePath, { force: true });
			continue;
		}
		items.push({ path: filePath, envelope });
	}
	return items;
}

export async function adoptSessionInboxMessages(
	room: string,
	successorRuntimeId: string,
	targetSessionId: string,
	onMessage: (envelope: PeerMessageEnvelope) => Promise<void> | void,
): Promise<number> {
	ensureRoomDirs(room);
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(inboxRoot(room), { withFileTypes: true });
	} catch {
		return 0;
	}
	let adopted = 0;
	for (const entry of entries) {
		if (!entry.isDirectory() || !RUNTIME_ID_RE.test(entry.name) || entry.name === successorRuntimeId) continue;
		const predecessor = normalizePresence(readJsonFile<unknown>(presencePath(room, entry.name), undefined));
		if (predecessor && isProcessAlive(predecessor.pid)) continue;
		await withInterprocessLock(
			inboxLockPath(room, entry.name),
			async () => {
				const refreshed = normalizePresence(readJsonFile<unknown>(presencePath(room, entry.name), undefined));
				if (refreshed && isProcessAlive(refreshed.pid)) return;
				for (const item of readInbox(room, entry.name)) {
					if (item.envelope.targetSessionId !== targetSessionId) continue;
					await onMessage(item.envelope);
					await removeInboxItem(item);
					adopted += 1;
				}
			},
			{ timeoutMs: 10_000, staleMs: 30_000, retryMs: 25 },
		);
	}
	return adopted;
}

export async function removeInboxItem(item: InboxItem): Promise<void> {
	await fs.promises.rm(item.path, { force: true });
}

export async function persistSessionReceipt(
	sessionId: string,
	envelope: PeerMessageEnvelope,
): Promise<InboxItem> {
	const normalized = normalizeEnvelope(envelope);
	if (!normalized) throw new Error("Invalid peer message receipt");
	ensureReceiptDirs(sessionId);
	const filePath = path.join(receiptDir(sessionId), `${envelope.id}.json`);
	await withInterprocessLock(
		receiptLockPath(sessionId),
		async () => {
			if (fs.existsSync(filePath)) return;
			const count = fs.readdirSync(receiptDir(sessionId)).filter((name) => name.endsWith(".json")).length;
			if (count >= MAX_SESSION_RECEIPTS) {
				throw new Error(`Peer session receipt inbox is full (${MAX_SESSION_RECEIPTS} messages).`);
			}
			await atomicWriteJson(filePath, normalized);
		},
		{ timeoutMs: 10_000, staleMs: 30_000, retryMs: 25 },
	);
	return { path: filePath, envelope: normalized };
}

function readReceiptDirectory(dir: string, now: number): InboxItem[] {
	let names: string[];
	try {
		names = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
	} catch {
		return [];
	}
	const items: InboxItem[] = [];
	for (const name of names) {
		const filePath = path.join(dir, name);
		const envelope = normalizeEnvelope(readJsonFile<unknown>(filePath, undefined));
		if (!envelope || envelope.expiresAt <= now) {
			fs.rmSync(filePath, { force: true });
			continue;
		}
		items.push({ path: filePath, envelope });
	}
	return items;
}

export function readSessionReceipts(sessionId: string, now = Date.now()): InboxItem[] {
	return readReceiptDirectory(receiptDir(sessionId), now);
}

export async function removeSessionReceipt(item: InboxItem): Promise<void> {
	const sessionDir = path.dirname(item.path);
	await withInterprocessLock(
		path.join(sessionDir, ".receipts.lock"),
		() => fs.promises.rm(item.path, { force: true }),
		{ timeoutMs: 10_000, staleMs: 30_000, retryMs: 25 },
	);
}

export async function pruneSessionReceipts(now = Date.now()): Promise<void> {
	let sessionDirs: fs.Dirent[] = [];
	try {
		sessionDirs = await fs.promises.readdir(receiptRoot(), { withFileTypes: true });
	} catch {
		return;
	}
	for (const sessionDir of sessionDirs) {
		if (!sessionDir.isDirectory() || !RECEIPT_KEY_RE.test(sessionDir.name)) continue;
		const dir = path.join(receiptRoot(), sessionDir.name);
		readReceiptDirectory(dir, now);
	}
}

export async function pruneRoom(room: string, now = Date.now()): Promise<void> {
	ensureRoomDirs(room);
	let names: string[] = [];
	try {
		names = await fs.promises.readdir(presenceDir(room));
	} catch {
		// The room may not have published presence yet.
	}
	for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
		const filePath = path.join(presenceDir(room), name);
		const peer = normalizePresence(readJsonFile<unknown>(filePath, undefined));
		let stale = Boolean(peer && peer.leaseExpiresAt < now - STALE_RETENTION_MS && !isProcessAlive(peer.pid));
		if (!peer) {
			try {
				stale = now - (await fs.promises.stat(filePath)).mtimeMs > STALE_RETENTION_MS;
			} catch {
				stale = false;
			}
		}
		if (!stale) continue;
		const runtimeId = name.slice(0, -".json".length);
		if (RUNTIME_ID_RE.test(runtimeId)) await removeRuntimeState(room, runtimeId);
		else await fs.promises.rm(filePath, { force: true });
	}

	let inboxEntries: fs.Dirent[] = [];
	try {
		inboxEntries = await fs.promises.readdir(inboxRoot(room), { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of inboxEntries) {
		if (!entry.isDirectory() || !RUNTIME_ID_RE.test(entry.name)) continue;
		if (fs.existsSync(presencePath(room, entry.name))) continue;
		const dir = inboxDir(room, entry.name);
		try {
			if (now - (await fs.promises.stat(dir)).mtimeMs <= STALE_RETENTION_MS) continue;
		} catch {
			continue;
		}
		await withInterprocessLock(
			inboxLockPath(room, entry.name),
			async () => {
				if (fs.existsSync(presencePath(room, entry.name))) return;
				try {
					if (now - (await fs.promises.stat(dir)).mtimeMs > STALE_RETENTION_MS) {
						await fs.promises.rm(dir, { recursive: true, force: true });
					}
				} catch {
					// Already removed.
				}
			},
			{ timeoutMs: 10_000, staleMs: 30_000, retryMs: 25 },
		);
	}
}

export async function pruneOutgoingMessageStatuses(now = Date.now()): Promise<void> {
	let sessionDirs: fs.Dirent[] = [];
	try {
		sessionDirs = await fs.promises.readdir(outgoingStatusRoot(), { withFileTypes: true });
	} catch {
		return;
	}
	for (const sessionDir of sessionDirs) {
		if (!sessionDir.isDirectory() || !RECEIPT_KEY_RE.test(sessionDir.name)) continue;
		const dir = path.join(outgoingStatusRoot(), sessionDir.name);
		await withInterprocessLock(
			path.join(dir, ".records.lock"),
			async () => {
				let names: string[] = [];
				try {
					names = await fs.promises.readdir(dir);
				} catch {
					return;
				}
				for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
					const filePath = path.join(dir, name);
					const record = normalizeMessageStatusRecord(readJsonFile<unknown>(filePath, undefined));
					if (!record || record.expiresAt < now - STALE_RETENTION_MS) {
						await fs.promises.rm(filePath, { force: true });
					}
				}
			},
			{ timeoutMs: 10_000, staleMs: 30_000, retryMs: 25 },
		).catch(() => undefined);
	}
}

export async function pruneCoordinatorState(now = Date.now()): Promise<void> {
	for (const room of listRoomIds()) await pruneRoom(room, now).catch(() => undefined);
	await pruneOutgoingMessageStatuses(now).catch(() => undefined);
}
