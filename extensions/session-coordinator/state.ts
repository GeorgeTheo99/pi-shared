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
	sender: PeerMessageSender;
	message: string;
	inReplyTo?: string;
	hops: 0 | 1;
	createdAt: number;
	expiresAt: number;
	untrusted: true;
}

export interface InboxItem {
	path: string;
	envelope: PeerMessageEnvelope;
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

function git(cwd: string, args: string[]): string | undefined {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2_000,
			maxBuffer: 64 * 1_024,
		}).trim() || undefined;
	} catch {
		return undefined;
	}
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
	return {
		roomId: roomId("git", identityPath),
		kind: "git",
		identityPath,
		cwd: canonicalCwd,
		worktreeRoot,
		branch: symbolicBranch ?? (detachedCommit ? `detached@${detachedCommit}` : undefined),
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

function roomDir(room: string): string {
	assertRoomId(room);
	return path.join(coordinatorConfig().stateDir, "rooms", room);
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

function receiptKey(sessionId: string): string {
	if (!sessionId || sessionId.length > 1_024) throw new Error("Invalid Pi session id for peer receipts");
	return `session-${crypto.createHash("sha256").update(sessionId).digest("hex")}`;
}

function receiptDir(sessionId: string): string {
	return path.join(receiptRoot(), receiptKey(sessionId));
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
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		.trim();
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
		value.capabilities[0] !== "messages"
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
			if (onMessage) {
				for (const item of readInbox(room, runtimeId)) await onMessage(item.envelope);
			}
			await fs.promises.rm(presencePath(room, runtimeId), { force: true });
			await fs.promises.rm(inboxDir(room, runtimeId), { recursive: true, force: true });
		},
		{ timeoutMs: 10_000, staleMs: 30_000, retryMs: 25 },
	);
}

export function listActivePeers(room: string, selfRuntimeId?: string, now = Date.now()): PeerPresence[] {
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
		.filter((peer) => peer.roomId === room && peer.runtimeId !== selfRuntimeId && isPresenceActive(peer, now))
		.sort((left, right) => left.startedAt - right.startedAt || left.runtimeId.localeCompare(right.runtimeId));
}

export function normalizeEnvelope(value: unknown): PeerMessageEnvelope | undefined {
	if (!isRecord(value) || !isRecord(value.sender)) return undefined;
	const id = boundedString(value.id, 64);
	const room = boundedString(value.roomId, 64);
	const targetRuntimeId = boundedString(value.targetRuntimeId, 64);
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
		(value.inReplyTo !== undefined &&
			(typeof value.inReplyTo !== "string" || !RUNTIME_ID_RE.test(value.inReplyTo))) ||
		value.untrusted !== true
	) {
		return undefined;
	}
	return {
		version: 1,
		id,
		roomId: room,
		targetRuntimeId,
		sender: {
			runtimeId: senderRuntimeId,
			sessionId: senderSessionId,
			sessionName: boundedString(value.sender.sessionName, 200),
			worktreeRoot: senderWorktree,
		},
		message,
		inReplyTo: boundedString(value.inReplyTo, 64),
		hops: value.hops,
		createdAt: value.createdAt,
		expiresAt: value.expiresAt,
		untrusted: true,
	};
}

export function createEnvelope(input: {
	roomId: string;
	targetRuntimeId: string;
	sender: PeerMessageSender;
	message: string;
	inReplyTo?: string;
	hops?: 0 | 1;
	now?: number;
}): PeerMessageEnvelope {
	const now = input.now ?? Date.now();
	const envelope: PeerMessageEnvelope = {
		version: 1,
		id: crypto.randomUUID(),
		roomId: input.roomId,
		targetRuntimeId: input.targetRuntimeId,
		sender: input.sender,
		message: sanitizeMessage(input.message),
		inReplyTo: input.inReplyTo,
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
	await atomicWriteJson(filePath, normalized);
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
	await fs.promises.rm(item.path, { force: true });
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
		try {
			const remaining = await fs.promises.readdir(dir);
			const age = now - (await fs.promises.stat(dir)).mtimeMs;
			if (remaining.length === 0 && age > STALE_RETENTION_MS) {
				await fs.promises.rm(dir, { recursive: true, force: true });
			}
		} catch {
			// Already removed.
		}
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
