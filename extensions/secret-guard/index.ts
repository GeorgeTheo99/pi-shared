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
 *   2. Well-known token formats (API keys, JWTs, private keys, passwords in URLs) and values held
 *      under credential-named fields (JSON keys, Keeper typed fields, dotenv lines).
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
	// The body stops at the next five-dash run, so an unterminated header cannot make the scan quadratic.
	["private key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:[^-]|-{1,4}(?!-))*-----END [A-Z0-9 ]*PRIVATE KEY-----/g],
	["neon api key", /\bnapi_[A-Za-z0-9]{32,}\b/g],
	["neon role password", /\bnpg_[A-Za-z0-9]{10,}\b/g],
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
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/@?#'"`]*:)([^\s@/?#'"`]+)(@)/gi;
/** Templates, references and masks (`<key>`, `${TOKEN}`, `$(cmd)`, `$ENV_NAME`, `***`), not values that merely start with a symbol. */
const PLACEHOLDER =
	/^(?:<[^<>]*>|\[[^[\]]*\]|\{\{?[^{}]*\}\}?|\$\{[^{}]*\}|\$\{\{.*\}\}|\$\(.*\)|\$[A-Z_][A-Z0-9_]*|\.\.\.|[*x.…•]+|password|passwd|pass|secret|redacted|changeme)$/i;

/** A field name that holds a credential: it ends in password, secret, token, API key and the like. */
const SECRET_KEY = String.raw`[A-Za-z0-9_.-]*(?:password|passwd|passphrase|secret|secret[_-]?key(?:[_-]?base)?|encryption[_-]?key|token|api[_-]?key|private[_-]?key|access[_-]?key)`;
/** Pagination cursors end in "token" but are not credentials. */
const CURSOR_KEY = /(?:next|page|continuation|sync)[a-z_-]*token\\?"\s*:/i;
/** A bare object key that names a credential, and the pagination-cursor exception. */
const SECRET_KEY_NAME = new RegExp(`^${SECRET_KEY}$`, "i");
const CURSOR_KEY_NAME = /(?:next|page|continuation|sync)[a-z_-]*token$/i;
const TYPED_SECRET = /^(?:password|secret|pinCode|oneTimeCode)$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;
const JSON_STRING = String.raw`"(?:[^"\\\n]|\\.)*"`;
/** A JSON string inside a JSON string: `\"...\"`, with its escapes doubled. */
const ESCAPED_STRING = String.raw`\\"(?:[^"\\\n]|\\\\(?:\\\\|\\"|[^\\"\n]))*\\"`;
/** `"<secret key>": "value"` in JSON output. */
const JSON_FIELD = new RegExp(String.raw`("${SECRET_KEY}"\s*:\s*")((?:[^"\\\n]|\\.)*)(")`, "gi");
/** The same inside a JSON string: `\"<secret key>\": \"value\"`. */
const ESCAPED_JSON_FIELD = new RegExp(String.raw`(\\"${SECRET_KEY}\\"\s*:\s*\\")([^"\\\s]+)(\\")`, "gi");

/**
 * Keeper-style typed fields, `{"type": "password", "value": ["..."]}`, in either key order, plain or
 * inside a JSON string (`q` is the quote, `string` a string literal, `ws` whitespace). The value array
 * is matched string by string (a `]` inside a password must not end it) and the gap between the two
 * keys is bounded, which keeps the match linear on large output.
 */
function typedField(q: string, string: string, ws: string): RegExp {
	const type = String.raw`${q}type${q}${ws}:${ws}${q}(?:password|secret|pinCode|oneTimeCode)${q}`;
	const array = String.raw`\[${ws}(?:${string}${ws}(?:,${ws})?)*\]`;
	const siblings = String.raw`(?:[^{}[\]]|\{[^{}[\]]{0,300}\}){0,400}?`;
	const value = String.raw`${q}value${q}${ws}:${ws}`;
	return new RegExp(String.raw`(${type}${siblings}${value})(${array})()|(${value})(${array})(${siblings}${type})`, "g");
}
const TYPED_FIELDS = [
	{ pattern: typedField('"', JSON_STRING, String.raw`\s*`), literal: new RegExp(JSON_STRING, "g"), quote: '"' },
	{ pattern: typedField(String.raw`\\"`, ESCAPED_STRING, String.raw`(?:\s|\\[nrt])*`), literal: new RegExp(ESCAPED_STRING, "g"), quote: '\\"' },
];
/** Keeper's text output: a title-case `Password: value` line. */
const LABEL_FIELD = /^([ \t]*(?:Password|Passphrase|Secret|One-Time Code):[ \t]+)(\S+)([ \t]*)$/gm;
/**
 * Dotenv and container-environment lines: `[export ]NAME_PASSWORD=value`, `- PASSWORD=value`,
 * `"TOKEN=value"`. Upper-case names without spaces, so source code is left alone.
 */
const DOTENV_FIELD =
	/^([ \t]*(?:export[ \t]+|-[ \t]+)?["']?(?:[A-Z][A-Z0-9_]*)?(?:PASSWORD|PASSWD|PASSPHRASE|SECRET|SECRET_KEY(?:_BASE)?|ENCRYPTION_KEY|TOKEN|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY)=)("[^"\n]*"|'[^'\n]*'|\S+?(?=["'],?[ \t]*$|\s|$))/gm;

/**
 * Words, env-var names, paths and selectors: readable identifiers rather than generated credentials.
 * Any run of letters counts as a word, so letters-only values are kept too.
 */
const WORD = String.raw`(?:[A-Z]?[a-z]+(?:[A-Z][a-z]+)*|\d{1,4})`;
const READABLE = new RegExp(String.raw`^(?:[A-Z]+(?:_[A-Z0-9]+)+|(?:[A-Za-z]:)?[#./\\]*${WORD}(?:[-_.:/\\]+${WORD})*)$`);

/** Decode a JSON string body (`a\"b` → `a"b`) so escapes do not hide a value's shape. */
function unescapeJson(value: string): string {
	try {
		return JSON.parse(`"${value}"`) as string;
	} catch {
		return value;
	}
}

/**
 * True for a value under a credential-named key that looks generated: at least 12 printable ASCII
 * characters, not a placeholder, reference or readable identifier, not already redacted. Fixture
 * values such as `test-api-key` stay readable, so edits to test files still match.
 */
function isSecretValue(value: string): boolean {
	const bare = value.replace(/^["']|["']$/g, "");
	return (
		bare.length >= MIN_SECRET_LENGTH &&
		/^[\x21-\x7e]+$/.test(bare) &&
		!bare.includes("REDACTED") &&
		!PLACEHOLDER.test(bare) &&
		!READABLE.test(bare)
	);
}

/** The field type already says it is a credential: only length, masks and earlier redaction are checked. */
function isTypedSecret(value: string, minLength = 1): boolean {
	return value.length >= minLength && !value.includes("REDACTED") && !/^[*x.…•]*$/i.test(value);
}

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
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		// Not JSON.
	}
	if (json !== null && typeof json === "object") {
		// JSON stores (OAuth tokens and the like) also hold metadata (email, issuer URL, scopes): take
		// values under credential-named keys and generated-looking values, never the store's lines.
		const visit = (node: unknown, key: string, depth: number): void => {
			if (typeof node === "string") {
				if ((SECRET_KEY_NAME.test(key) && !CURSOR_KEY_NAME.test(key)) || (isSecretValue(node) && !EMAIL.test(node))) add(node);
			} else if (Array.isArray(node) && depth < MAX_DEPTH) {
				for (const item of node) visit(item, key, depth + 1);
			} else if (node && typeof node === "object" && depth < MAX_DEPTH) {
				for (const [name, item] of Object.entries(node)) visit(item, name, depth + 1);
			}
		};
		visit(json, "", 0);
	} else {
		for (const line of text.split(/\r?\n/)) {
			if (/^\s*#/.test(line)) continue;
			add(line);
			const assignment = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.+)$/.exec(line);
			if (assignment) add(assignment[1]);
		}
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
	for (const pattern of [JSON_FIELD, ESCAPED_JSON_FIELD]) {
		result = result.replace(pattern, (match, head: string, value: string, tail: string) => {
			if (CURSOR_KEY.test(head) || !isSecretValue(unescapeJson(value))) return match;
			count++;
			return `${head}[REDACTED field]${tail}`;
		});
	}
	for (const { pattern, literal, quote } of TYPED_FIELDS) {
		result = result.replace(pattern, (match, ...groups: (string | undefined)[]) => {
			const [head, values, tail] = groups[0] !== undefined ? groups.slice(0, 3) : groups.slice(3, 6);
			let changed = false;
			const redacted = values!.replace(literal, (string) => {
				if (!isTypedSecret(string.slice(quote.length, -quote.length))) return string;
				count++;
				changed = true;
				return `${quote}[REDACTED field]${quote}`;
			});
			return changed ? `${head}${redacted}${tail}` : match;
		});
	}
	result = result.replace(LABEL_FIELD, (match, head: string, value: string, tail: string) => {
		// Prose such as "Password: required" also has this shape, so short values are kept.
		if (!isTypedSecret(value, 6)) return match;
		count++;
		return `${head}[REDACTED field]${tail}`;
	});
	result = result.replace(DOTENV_FIELD, (match, head: string, value: string) => {
		if (!isSecretValue(value)) return match;
		count++;
		return `${head}[REDACTED field]`;
	});
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

/**
 * Redact every string inside a JSON-like value; returns the same reference when nothing changed.
 * `key` is the property holding `value`: a credential-named key or a Keeper typed field marks its
 * strings as secrets, as the text rules do for serialized JSON.
 */
export function redactDeep<T>(
	value: T,
	index: Pick<SecretIndex, "secrets" | "pattern">,
	depth = 0,
	key = "",
	typed = false,
): { value: T; count: number } {
	if (typeof value === "string") {
		if (typed ? isTypedSecret(value) : SECRET_KEY_NAME.test(key) && !CURSOR_KEY_NAME.test(key) && isSecretValue(value)) {
			return { value: "[REDACTED field]" as T, count: 1 };
		}
		// Base64 payloads (images, files) are not text; a token pattern inside one would corrupt it.
		if (value.length > 4096 && BASE64.test(value)) return { value, count: 0 };
		const { text, count } = redactText(value, index);
		return { value: (count ? text : value) as T, count };
	}
	if (depth >= MAX_DEPTH || value === null || typeof value !== "object" || ArrayBuffer.isView(value)) return { value, count: 0 };
	if (Array.isArray(value)) {
		let total = 0;
		const next = value.map((item) => {
			const { value: redacted, count } = redactDeep(item, index, depth + 1, key, typed);
			total += count;
			return redacted;
		});
		return { value: (total ? next : value) as T, count: total };
	}
	if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return { value, count: 0 };
	let total = 0;
	const next: Record<string, unknown> = {};
	const record = value as Record<string, unknown>;
	const typedRecord = typeof record.type === "string" && TYPED_SECRET.test(record.type);
	for (const [name, item] of Object.entries(record)) {
		const { value: redacted, count } = redactDeep(item, index, depth + 1, name, typedRecord && name === "value");
		total += count;
		next[name] = redacted;
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
