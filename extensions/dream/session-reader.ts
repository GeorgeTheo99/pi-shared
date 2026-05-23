import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CondensedSession, SessionContentBlock, SessionEvent, SessionMessage } from "./types.js";

const SESSIONS_ROOT = join(homedir(), ".pi", "agent", "sessions");
const DEFAULT_SESSION_LIMIT = 15;
const DEFAULT_MAX_CHARS_PER_SESSION = 4000;
const META_MAX_CHARS_PER_SESSION = 2000;
const MAX_PROJECTS_FOR_META = 8;
const USER_TEXT_LIMIT = 300;
const ASSISTANT_TEXT_LIMIT = 500;
const TOOL_ARGS_LIMIT = 220;
const TOOL_RESULT_LIMIT = 260;
const SESSION_HEAD_RATIO = 0.55;

export function encodeCwd(cwd: string): string {
	return `--${cwd.slice(1).replaceAll("/", "-")}--`;
}

function decodeCwd(dirName: string): string {
	if (!dirName.startsWith("--") || !dirName.endsWith("--")) return dirName;
	return `/${dirName.slice(2, -2).replaceAll("-", "/")}`;
}

export function getSessionDir(cwd: string): string {
	return join(SESSIONS_ROOT, encodeCwd(cwd));
}

export function listSessionFiles(sessionDir: string, limit = DEFAULT_SESSION_LIMIT): string[] {
	if (!existsSync(sessionDir)) return [];
	try {
		return readdirSync(sessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.sort()
			.reverse()
			.slice(0, limit);
	} catch {
		return [];
	}
}

export function parseSessionEvents(filePath: string): SessionEvent[] {
	try {
		const content = readFileSync(filePath, "utf8");
		const events: SessionEvent[] = [];
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				events.push(JSON.parse(line) as SessionEvent);
			} catch {
				// skip malformed lines
			}
		}
		return events;
	} catch {
		return [];
	}
}

function normalizeText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}...`;
}

function truncateHeadTail(text: string, limit: number): string {
	if (text.length <= limit) return text;
	if (limit <= 20) return truncate(text, limit);
	const headLength = Math.floor(limit * SESSION_HEAD_RATIO);
	const tailLength = limit - headLength - 20;
	return `${text.slice(0, headLength)}\n... [truncated] ...\n${text.slice(-tailLength)}`;
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function summarizeString(value: unknown, limit = TOOL_ARGS_LIMIT): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	return `"${truncate(normalizeText(value), limit)}"`;
}

function summarizeToolArgs(name: string, args: unknown): string {
	const data = asRecord(args);
	if (Object.keys(data).length === 0) return "";

	switch (name) {
		case "read": {
			const bits = [data.path && `path=${summarizeString(data.path, 140)}`];
			if (data.offset) bits.push(`offset=${data.offset}`);
			if (data.limit) bits.push(`limit=${data.limit}`);
			return bits.filter(Boolean).join(" ");
		}
		case "bash": {
			const bits = [data.command && `command=${summarizeString(data.command, 180)}`];
			if (data.timeout) bits.push(`timeout=${data.timeout}`);
			return bits.filter(Boolean).join(" ");
		}
		case "edit": {
			const editCount = Array.isArray(data.edits) ? data.edits.length : undefined;
			const bits = [data.path && `path=${summarizeString(data.path, 140)}`, editCount !== undefined && `edits=${editCount}`];
			return bits.filter(Boolean).join(" ");
		}
		case "write": {
			const content = typeof data.content === "string" ? data.content : undefined;
			const bits = [data.path && `path=${summarizeString(data.path, 140)}`];
			if (content) bits.push(`chars=${content.length}`);
			return bits.filter(Boolean).join(" ");
		}
		case "work_plan": {
			const bits = [data.action && `action=${data.action}`, data.id && `id=${data.id}`, data.title && `title=${summarizeString(data.title, 100)}`];
			if (Array.isArray(data.items)) bits.push(`items=${data.items.length}`);
			return bits.filter(Boolean).join(" ");
		}
		case "web_search":
			return [data.query && `query=${summarizeString(data.query, 180)}`, data.num_results && `num_results=${data.num_results}`]
				.filter(Boolean)
				.join(" ");
		case "web_fetch":
			return [data.url && `url=${summarizeString(data.url, 180)}`, data.max_chars && `max_chars=${data.max_chars}`]
				.filter(Boolean)
				.join(" ");
		case "spawn_subagent":
			return summarizeSubagentArgs(data);
		default:
			return truncate(safeJson(data), TOOL_ARGS_LIMIT);
	}
}

function summarizeSubagentArgs(data: Record<string, unknown>): string {
	if (data.jobAction) {
		const bits = [`jobAction=${data.jobAction}`];
		if (data.jobId) bits.push(`jobId=${data.jobId}`);
		return bits.join(" ");
	}
	const prefix = data.background ? "background=true " : "";
	if (Array.isArray(data.tasks)) {
		const agents = data.tasks
			.map((task) => asRecord(task).agent)
			.filter(Boolean)
			.join(",");
		return `${prefix}mode=parallel tasks=${data.tasks.length}${agents ? ` agents=${agents}` : ""}`;
	}
	if (Array.isArray(data.chain)) {
		const agents = data.chain
			.map((task) => asRecord(task).agent)
			.filter(Boolean)
			.join("→");
		return `${prefix}mode=chain steps=${data.chain.length}${agents ? ` agents=${agents}` : ""}`;
	}
	const bits = [`${prefix}mode=single`, data.agent && `agent=${data.agent}`, data.task && `task=${summarizeString(data.task, 160)}`];
	return bits.filter(Boolean).join(" ");
}

function extractTextContent(msg: SessionMessage): string[] {
	return msg.content
		.filter((b) => b.type === "text" && b.text)
		.map((b) => normalizeText(b.text!))
		.filter(Boolean);
}

function summarizeToolResult(result?: SessionMessage): string {
	if (!result) return "no result recorded";
	const textParts = extractTextContent(result);
	const summary = textParts.length ? textParts.join(" ") : "no output";
	return truncateHeadTail(summary, TOOL_RESULT_LIMIT);
}

function isSubagentTool(name: string): boolean {
	const lower = name.toLowerCase();
	return lower === "spawn_subagent" || lower === "task" || lower.includes("subagent");
}

function formatToolOperation(block: SessionContentBlock, resultsById: Map<string, SessionMessage>): string | null {
	if (block.type !== "toolCall" || !block.name) return null;
	const result = block.id ? resultsById.get(block.id) : undefined;
	const kind = isSubagentTool(block.name) ? "SUBAGENT" : "TOOL";
	const args = summarizeToolArgs(block.name, block.arguments);
	const status = result?.isError ? "ERROR" : "ok";
	const output = summarizeToolResult(result);
	return `${kind} ${block.name}${args ? ` ${args}` : ""} → ${status}: ${output}`;
}

function formatTextBlock(block: SessionContentBlock, role: string): string | null {
	if (block.type === "thinking") return null; // encrypted, not useful
	if (block.type === "text" && block.text) {
		const limit = role === "user" ? USER_TEXT_LIMIT : ASSISTANT_TEXT_LIMIT;
		return truncate(normalizeText(block.text), limit);
	}
	return null;
}

function indexToolResults(events: SessionEvent[]): Map<string, SessionMessage> {
	const results = new Map<string, SessionMessage>();
	for (const event of events) {
		const msg = event.message;
		if (event.type !== "message" || !msg || msg.role !== "toolResult" || !msg.toolCallId) continue;
		results.set(msg.toolCallId, msg);
	}
	return results;
}

function formatMessage(event: SessionEvent, resultsById: Map<string, SessionMessage>): string | null {
	const msg = event.message;
	if (!msg) return null;

	if (msg.role === "user") {
		const parts = msg.content.map((b) => formatTextBlock(b, "user")).filter(Boolean);
		return parts.length ? `USER: ${parts.join(" ")}` : null;
	}

	if (msg.role === "assistant") {
		const lines: string[] = [];
		const textParts = msg.content.map((b) => formatTextBlock(b, "assistant")).filter(Boolean);
		if (textParts.length) {
			const errFlag = msg.stopReason === "error" ? " [ERROR]" : "";
			lines.push(`ASSISTANT:${errFlag} ${textParts.join("\n  ")}`);
		}
		for (const block of msg.content) {
			const formatted = formatToolOperation(block, resultsById);
			if (formatted) lines.push(formatted);
		}
		return lines.length ? lines.join("\n") : null;
	}

	if (msg.role === "toolResult" && !msg.toolCallId) {
		const errFlag = msg.isError ? " [ERROR]" : "";
		return `RESULT(${msg.toolName || "unknown"})${errFlag}: ${summarizeToolResult(msg)}`;
	}

	return null;
}

export function condenseSession(events: SessionEvent[], maxChars = DEFAULT_MAX_CHARS_PER_SESSION): CondensedSession {
	// Extract header
	const header = events.find((e) => e.type === "session");
	const sessionId = header?.id ?? "unknown";
	const timestamp = header?.timestamp ?? "unknown";
	const cwd = header?.cwd ?? "unknown";

	// Find model from model_change events (use latest)
	let model: string | undefined;
	for (const event of events) {
		if (event.type === "model_change" && event.modelId) {
			model = event.modelId;
		}
	}

	// Sum cost and count messages
	let totalCost = 0;
	let messageCount = 0;
	for (const event of events) {
		if (event.type !== "message" || !event.message) continue;
		if (event.message.role === "user" || event.message.role === "assistant") messageCount++;
		if (event.message.role === "assistant" && event.message.usage?.cost?.total) {
			totalCost += event.message.usage.cost.total;
		}
	}

	// Build condensed transcript as operations: user/assistant text plus paired tool calls/results.
	const resultsById = indexToolResults(events);
	const lines: string[] = [];
	for (const event of events) {
		if (event.type !== "message") continue;
		const formatted = formatMessage(event, resultsById);
		if (formatted) lines.push(formatted);
	}

	let condensed = lines.join("\n");
	if (condensed.length > maxChars) {
		condensed = truncateHeadTail(condensed, maxChars);
	}

	return { id: sessionId, timestamp, cwd, model, totalCost, messageCount, condensed };
}

export function getProjectSessions(cwd: string, limit = DEFAULT_SESSION_LIMIT): CondensedSession[] {
	const dir = getSessionDir(cwd);
	const files = listSessionFiles(dir, limit);
	const sessions: CondensedSession[] = [];

	for (const file of files) {
		const events = parseSessionEvents(join(dir, file));
		if (events.length === 0) continue;
		sessions.push(condenseSession(events));
	}

	return sessions;
}

function latestSessionMtime(sessionDir: string): number {
	try {
		const files = listSessionFiles(sessionDir, Number.POSITIVE_INFINITY);
		return files.reduce((latest, file) => Math.max(latest, statSync(join(sessionDir, file)).mtimeMs), 0);
	} catch {
		return 0;
	}
}

export function getAllProjectSessions(limitPerProject = 5): Map<string, CondensedSession[]> {
	const result = new Map<string, CondensedSession[]>();
	if (!existsSync(SESSIONS_ROOT)) return result;

	let dirs: string[];
	try {
		dirs = readdirSync(SESSIONS_ROOT).filter((d) => d.startsWith("--") && d.endsWith("--"));
	} catch {
		return result;
	}

	// Sort by latest session-file modification time (most recently active first), take top N.
	dirs.sort((a, b) => latestSessionMtime(join(SESSIONS_ROOT, b)) - latestSessionMtime(join(SESSIONS_ROOT, a)));
	dirs = dirs.slice(0, MAX_PROJECTS_FOR_META);

	for (const dir of dirs) {
		const files = listSessionFiles(join(SESSIONS_ROOT, dir), limitPerProject);
		if (files.length === 0) continue;

		const sessions: CondensedSession[] = [];
		for (const file of files) {
			const events = parseSessionEvents(join(SESSIONS_ROOT, dir, file));
			if (events.length === 0) continue;
			sessions.push(condenseSession(events, META_MAX_CHARS_PER_SESSION));
		}
		if (sessions.length > 0) {
			const cwd = sessions.find((s) => s.cwd !== "unknown")?.cwd ?? decodeCwd(dir);
			result.set(cwd, sessions);
		}
	}

	return result;
}

export function formatSessionsForPrompt(sessions: CondensedSession[]): string {
	return sessions
		.map((s) => {
			const header = `### Session ${s.timestamp}${s.model ? ` (${s.model})` : ""} — $${s.totalCost.toFixed(4)} — ${s.messageCount} messages`;
			return `${header}\n${s.condensed}`;
		})
		.join("\n\n");
}
