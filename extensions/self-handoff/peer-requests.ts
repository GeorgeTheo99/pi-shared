import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	coordinatorConfig,
	normalizeEnvelope,
	normalizeMessageStatusRecord,
	readResponseRequestStatus,
	type ResponseRequestBinding,
} from "../session-coordinator/state.ts";

type Entry = { type: string; customType?: string; details?: unknown; data?: unknown; message?: unknown };
export type PeerRequestSnapshot =
	| { status: "available"; outgoing: ResponseRequestBinding[]; incoming: ResponseRequestBinding[] }
	| { status: "unavailable" };

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown> : undefined;
}

// The coordinator's ordinary receipt reader prunes expired files and its status
// reader suppresses I/O errors. Handoff inspection must do neither. Keep this
// small read-only adapter aligned with coordinator v1's session-keyed layout.
function readRecords(kind: "receipts" | "outgoing-status", sessionId: string): unknown[] {
	const key = `session-${createHash("sha256").update(sessionId).digest("hex")}`;
	const directory = join(coordinatorConfig().stateDir, kind, key);
	let names: string[];
	try {
		names = readdirSync(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return names.filter((name) => name.endsWith(".json"))
		.map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")));
}

/** Advisory snapshot only: no receipt pruning, reply claims, forwarding or wake. */
export function inspectPeerRequests(
	sessionId: string,
	getEntries: () => readonly Entry[],
	now = Date.now(),
): PeerRequestSnapshot {
	try {
		if (!sessionId || sessionId.length > 1_024) throw new Error("Invalid session identity");
		const outgoing = new Map<string, ResponseRequestBinding>();
		const answeredOutgoing = new Set<string>();
		const incoming = new Map<string, ResponseRequestBinding>();
		const add = (target: Map<string, ResponseRequestBinding>, binding: ResponseRequestBinding) => {
			const previous = target.get(binding.messageId);
			if (previous && JSON.stringify(previous) !== JSON.stringify(binding)) {
				throw new Error("Conflicting peer request identity");
			}
			target.set(binding.messageId, binding);
		};
		for (const value of readRecords("outgoing-status", sessionId)) {
			const status = normalizeMessageStatusRecord(value);
			if (!status) throw new Error("Invalid outgoing peer status");
			if (status.senderSessionId !== sessionId || !status.responseRequested || status.expiresAt <= now) continue;
			const binding = { messageId: status.messageId, senderSessionId: sessionId,
				recipientSessionId: status.targetSessionId!, expiresAt: status.expiresAt };
			add(outgoing, binding);
			if (status.responseAnsweredAt !== undefined) answeredOutgoing.add(binding.messageId);
		}
		for (const value of readRecords("receipts", sessionId)) {
			const envelope = normalizeEnvelope(value);
			if (!envelope) throw new Error("Invalid incoming peer receipt");
			if (!envelope.requestResponse || envelope.targetSessionId !== sessionId || envelope.expiresAt <= now) continue;
			add(incoming, { messageId: envelope.id, senderSessionId: envelope.sender.sessionId,
				recipientSessionId: sessionId, expiresAt: envelope.expiresAt });
		}
		// Surfaced receipts are removed from disk; scan the entire exact session,
		// not just its active branch. Copied/forked transcript bindings are ignored.
		for (const entry of getEntries()) {
			// Status history is capped independently of request TTL. Sent cards
			// (or successful tool results if card persistence failed) survive eviction.
			const message = entry.type === "message" ? record(entry.message) : undefined;
			const sent = entry.type === "custom" && entry.customType === "pi-peer-message-sent"
				? record(entry.data)?.message
				: message?.role === "toolResult" && message.toolName === "peer_send" && message.isError !== true
					? record(message.details)?.message : undefined;
			if (sent !== undefined) {
				const envelope = normalizeEnvelope(sent);
				if (!envelope) throw new Error("Invalid sent peer request");
				if (envelope.requestResponse && envelope.sender.sessionId === sessionId && envelope.expiresAt > now) {
					add(outgoing, { messageId: envelope.id, senderSessionId: sessionId,
						recipientSessionId: envelope.targetSessionId!, expiresAt: envelope.expiresAt });
				}
			}
			if (entry.type !== "custom_message" || entry.customType !== "pi-peer-message") continue;
			const details = record(entry.details);
			if (details?.requestResponse !== true || details.recipientSessionId !== sessionId) continue;
			if (typeof details.expiresAt !== "number" || !Number.isFinite(details.expiresAt)
				|| typeof details.messageId !== "string" || typeof details.senderSessionId !== "string"
				|| details.hops !== 0 || details.inReplyTo !== undefined) throw new Error("Invalid surfaced peer request");
			if (details.expiresAt <= now) continue;
			add(incoming, { messageId: details.messageId, senderSessionId: details.senderSessionId,
				recipientSessionId: sessionId, expiresAt: details.expiresAt });
		}
		const sorted = (values: Iterable<ResponseRequestBinding>) => [...values].sort((a, b) => a.messageId.localeCompare(b.messageId));
		return { status: "available", outgoing: sorted(outgoing.values())
			.filter((binding) => !answeredOutgoing.has(binding.messageId) && readResponseRequestStatus(binding, now) !== "answered"), incoming: sorted(incoming.values())
			.filter((binding) => readResponseRequestStatus(binding, now) !== "answered") };
	} catch {
		// Never render a misleading zero count, exception text or peer-supplied body.
		return { status: "unavailable" };
	}
}

export function peerRequestWarning(snapshot: PeerRequestSnapshot): string | undefined {
	if (snapshot.status === "available" && snapshot.outgoing.length === 0 && snapshot.incoming.length === 0) return undefined;
	const summary = snapshot.status === "unavailable"
		? "Peer-request inspection unavailable; outstanding requests could not be determined."
		: `Outstanding peer response requests at review: ${snapshot.outgoing.length} outgoing, ${snapshot.incoming.length} incoming (unexpired and unanswered).`;
	return `## Peer requests stay with the parent\n${summary}\nPeer response requests and replies remain bound to the exact parent session; they do not transfer or forward to this child or a fork. Resume the original parent to inspect/respond. No peer is automatically woken. The child must still wait for the user's next explicit message before beginning work.`;
}
