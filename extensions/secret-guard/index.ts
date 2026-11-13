import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type * as sdk from "@earendil-works/pi-coding-agent";

/**
 * Secret guard: redacts credentials from every tool result before Pi stores it in the session or
 * sends it to the model. Two layers:
 *   1. Exact values from local secret stores (`~/.config/<tool>/secrets/<name>` and
 *      PI_SECRET_DIRS), whatever their format, labelled with the file name.
 *   2. Well-known token formats (API keys, JWTs, private keys, passwords in URLs).
 * Images cannot be redacted. PI_SECRET_GUARD=off disables the guard for a session.
 */

/** Values shorter than this are not treated as secrets (too likely to match ordinary text). */
const MIN_SECRET_LENGTH = 12;
const MAX_SECRET_FILE_BYTES = 16 * 1024;
const RELOAD_INTERVAL_MS = 2_000;
const MAX_DEPTH = 24;

export interface KnownSecret {
	value: string;
	label: string;
}

/** Token formats, most specific first. Each match becomes `[REDACTED <kind>]`. */
export const SECRET_PATTERNS: ReadonlyArray<readonly [kind: string, pattern: RegExp]> = [
	["private key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g],
	["neon api key", /\bnapi_[A-Za-z0-9]{32,}\b/g],
	["stripe/clerk secret key", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g],
	["webhook secret", /\bwhsec_[A-Za-z0-9+/=]{16,}/g],
	["anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
	["api key", /\bsk-(?:proj-|or-v1-|svcacct-)?[A-Za-z0-9_-]{20,}/g],
	["github token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g],
	["gitlab token", /\bglpat-[A-Za-z0-9_-]{16,}/g],
	["npm token", /\bnpm_[A-Za-z0-9]{20,}/g],
	["slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
	["aws access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
	["google api key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
	["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
];

/** `scheme://user:password@` — the password part, unless it is an obvious placeholder. */
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@'"`]+:)([^\s@/'"`]+)(@)/gi;
const PLACEHOLDER = /^(?:[<[{$*].*|\.\.\.|x+|password|passwd|pass|secret|redacted|changeme)$/i;

export function defaultSecretDirs(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
	const dirs = new Set<string>();
	const config = join(home, ".config");
	try {
		for (const entry of readdirSync(config, { withFileTypes: true })) {
			if (entry.isDirectory()) dirs.add(join(config, entry.name, "secrets"));
		}
	} catch {
		// No ~/.config: only PI_SECRET_DIRS.
	}
	for (const dir of (env.PI_SECRET_DIRS ?? "").split(":")) if (dir.trim()) dirs.add(dir.trim());
	return [...dirs];
}

/** The values a secret file holds: the whole value, each line, KEY=VALUE values, URL passwords. */
export function valuesOf(text: string): string[] {
	const values = new Set<string>();
	const add = (value: string | undefined) => {
		const trimmed = value?.trim().replace(/^["']|["']$/g, "");
		if (trimmed && trimmed.length >= MIN_SECRET_LENGTH) values.add(trimmed);
	};
	add(text);
	for (const line of text.split(/\r?\n/)) {
		add(line);
		const assignment = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.+)$/.exec(line);
		if (assignment) add(assignment[1]);
	}
	// JSON stores (OAuth tokens and the like): every string value.
	try {
		const visit = (node: unknown, depth: number): void => {
			if (typeof node === "string") add(node);
			else if (node && typeof node === "object" && depth < MAX_DEPTH) for (const item of Object.values(node)) visit(item, depth + 1);
		};
		visit(JSON.parse(text), 0);
	} catch {
		// Not JSON.
	}
	for (const value of [...values]) {
		if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) continue;
		try {
			const password = new URL(value).password;
			if (password) {
				add(password);
				add(decodeURIComponent(password));
			}
		} catch {
			// Not a parseable URL.
		}
	}
	return [...values];
}

/** Secret values from the stores, reloaded when a directory or file changes. */
export class SecretIndex {
	private known: KnownSecret[] = [];
	private matcher: RegExp | null = null;
	private signature = "";
	private checkedAt = 0;

	private readonly dirs: () => string[];

	constructor(dirs: () => string[] = () => defaultSecretDirs()) {
		this.dirs = dirs;
	}

	secrets(now = Date.now()): KnownSecret[] {
		this.refresh(now);
		return this.known;
	}

	pattern(now = Date.now()): RegExp | null {
		this.refresh(now);
		return this.matcher;
	}

	private refresh(now: number): void {
		if (now - this.checkedAt < RELOAD_INTERVAL_MS && this.checkedAt !== 0) return;
		this.checkedAt = now;
		const files: { path: string; label: string; stamp: string }[] = [];
		for (const dir of this.dirs()) {
			let entries;
			try {
				entries = readdirSync(dir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (!entry.isFile() || entry.name.startsWith(".")) continue;
				const path = join(dir, entry.name);
				try {
					const info = statSync(path);
					if (info.size > MAX_SECRET_FILE_BYTES) continue;
					files.push({ path, label: entry.name, stamp: `${path}:${info.size}:${info.mtimeMs}` });
				} catch {
					// Vanished between readdir and stat.
				}
			}
		}
		const signature = files.map((file) => file.stamp).sort().join("\n");
		if (signature === this.signature) return;
		this.signature = signature;
		const known = new Map<string, string>();
		for (const file of files) {
			try {
				for (const value of valuesOf(readFileSync(file.path, "utf8"))) known.set(value, file.label);
			} catch {
				// Unreadable: nothing to redact from it.
			}
		}
		this.known = [...known].map(([value, label]) => ({ value, label })).sort((a, b) => b.value.length - a.value.length);
		this.matcher = this.known.length
			? new RegExp(this.known.map(({ value }) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g")
			: null;
	}
}

/** Redact known values first (they carry the store's name), then token formats. */
export function redactText(text: string, index: Pick<SecretIndex, "secrets" | "pattern">): { text: string; count: number } {
	let count = 0;
	let result = text;
	const matcher = index.pattern();
	if (matcher) {
		const labels = new Map(index.secrets().map(({ value, label }) => [value, label]));
		result = result.replace(matcher, (match) => {
			count++;
			return `[REDACTED secret:${labels.get(match) ?? "store"}]`;
		});
	}
	for (const [kind, pattern] of SECRET_PATTERNS) {
		result = result.replace(pattern, () => {
			count++;
			return `[REDACTED ${kind}]`;
		});
	}
	result = result.replace(URL_PASSWORD, (match, head: string, password: string, at: string) => {
		if (PLACEHOLDER.test(password) || password.startsWith("[REDACTED")) return match;
		count++;
		return `${head}[REDACTED password]${at}`;
	});
	return { text: result, count };
}

const BASE64 = /^[A-Za-z0-9+/=\r\n_-]+$/;

/** Redact the text parts of a tool result's content; images pass through unchanged. */
export function redactContent(
	content: (TextContent | ImageContent)[],
	index: Pick<SecretIndex, "secrets" | "pattern">,
): { value: (TextContent | ImageContent)[]; count: number } {
	let total = 0;
	const next = content.map((part) => {
		if (part.type !== "text") return part;
		const { text, count } = redactText(part.text, index);
		total += count;
		return count ? { ...part, text } : part;
	});
	return { value: total ? next : content, count: total };
}

/** Redact every string inside a JSON-like value; returns the same reference when nothing changed. */
export function redactDeep<T>(value: T, index: Pick<SecretIndex, "secrets" | "pattern">, depth = 0): { value: T; count: number } {
	if (typeof value === "string") {
		// Base64 payloads (images, files) are not text; a token pattern inside one would corrupt it.
		if (value.length > 4096 && BASE64.test(value)) return { value, count: 0 };
		const { text, count } = redactText(value, index);
		return { value: (count ? text : value) as T, count };
	}
	if (depth >= MAX_DEPTH || value === null || typeof value !== "object" || ArrayBuffer.isView(value)) return { value, count: 0 };
	if (Array.isArray(value)) {
		let total = 0;
		const next = value.map((item) => {
			const { value: redacted, count } = redactDeep(item, index, depth + 1);
			total += count;
			return redacted;
		});
		return { value: (total ? next : value) as T, count: total };
	}
	if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return { value, count: 0 };
	let total = 0;
	const next: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		const { value: redacted, count } = redactDeep(item, index, depth + 1);
		total += count;
		next[key] = redacted;
	}
	return { value: (total ? next : value) as T, count: total };
}

export default function secretGuard(pi: sdk.ExtensionAPI, index = new SecretIndex()) {
	if (process.env.PI_SECRET_GUARD === "off") return;
	pi.on("tool_result", (event) => {
		const content = redactContent(event.content, index);
		const details = redactDeep((event as { details?: unknown }).details, index);
		const structured = redactDeep(event.structuredContent, index);
		if (!content.count && !details.count && !structured.count) return undefined;
		return {
			content: content.value,
			details: details.value,
			// Returning content without structuredContent would drop it; keep its redacted form.
			...(event.structuredContent === undefined ? {} : { structuredContent: structured.value }),
		};
	});
}
