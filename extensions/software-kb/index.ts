import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface SourceRecord {
	id: string;
	title: string;
	authors?: string[];
	canonical_url?: string;
	access?: string;
	license_status?: string;
	ingest_policy?: string;
	tags?: string[];
	searxng_queries?: string[];
}

interface SourceManifest {
	version: number;
	name: string;
	selection_method?: string;
	runtime_policy?: string;
	sources: SourceRecord[];
}

interface Chunk {
	id: string;
	sourceId: string;
	sourceTitle: string;
	title: string;
	text: string;
	path?: string;
	url?: string;
	access?: string;
	tags: string[];
	licenseStatus?: string;
	ingestPolicy?: string;
}

const STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"by",
	"for",
	"from",
	"how",
	"in",
	"is",
	"it",
	"of",
	"on",
	"or",
	"that",
	"the",
	"to",
	"use",
	"what",
	"when",
	"with",
]);

function currentFileDir() {
	try {
		return dirname(fileURLToPath(import.meta.url));
	} catch {
		return typeof __dirname !== "undefined" ? __dirname : process.cwd();
	}
}

const extensionDir = currentFileDir();
const packageRoot = resolve(extensionDir, "../..");
const kbRoot = join(packageRoot, "knowledge/software-engineering");
const corpusRoot = join(kbRoot, "corpus");
const sourcesPath = join(kbRoot, "sources.json");

let cachedManifest: SourceManifest | undefined;
let cachedChunks: Chunk[] | undefined;

function readManifest(): SourceManifest {
	if (cachedManifest) return cachedManifest;
	const parsed = JSON.parse(readFileSync(sourcesPath, "utf8")) as SourceManifest;
	cachedManifest = parsed;
	return parsed;
}

function walkMarkdown(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const fullPath = join(dir, name);
		const stat = statSync(fullPath);
		if (stat.isDirectory()) out.push(...walkMarkdown(fullPath));
		else if (stat.isFile() && (name.endsWith(".md") || name.endsWith(".pdf"))) out.push(fullPath);
	}
	return out.sort();
}

function parseFrontmatter(text: string): { attrs: Record<string, string>; body: string } {
	if (!text.startsWith("---\n")) return { attrs: {}, body: text };
	const end = text.indexOf("\n---\n", 4);
	if (end === -1) return { attrs: {}, body: text };
	const raw = text.slice(4, end).trim();
	const attrs: Record<string, string> = {};
	for (const line of raw.split(/\r?\n/)) {
		const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (match) attrs[match[1]] = match[2].replace(/^['\"]|['\"]$/g, "");
	}
	return { attrs, body: text.slice(end + 5) };
}

function slugify(value: string) {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
}

function tokenize(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^a-z0-9+#.]+/g)
		.map((token) => token.trim())
		.filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function sectionChunks(markdown: string): Array<{ title: string; text: string }> {
	const chunks: Array<{ title: string; text: string }> = [];
	let currentTitle = basename("document");
	let currentLines: string[] = [];

	function flush() {
		const text = currentLines.join("\n").trim();
		if (text.length > 80) chunks.push({ title: currentTitle, text });
		currentLines = [];
	}

	for (const line of markdown.split(/\r?\n/)) {
		const heading = line.match(/^(#{1,4})\s+(.+)$/);
		if (heading) {
			flush();
			currentTitle = heading[2].trim();
		} else {
			currentLines.push(line);
		}
	}
	flush();
	return chunks;
}

function sourceToChunk(source: SourceRecord): Chunk {
	const text = [
		`${source.title}`,
		`Authors: ${(source.authors ?? []).join(", ")}`,
		`Access: ${source.access ?? "unknown"}`,
		`License: ${source.license_status ?? "unknown"}`,
		`Ingest policy: ${source.ingest_policy ?? "unknown"}`,
		`Tags: ${(source.tags ?? []).join(", ")}`,
		`SearXNG queries: ${(source.searxng_queries ?? []).join("; ")}`,
		`URL: ${source.canonical_url ?? ""}`,
	].join("\n");

	return {
		id: `source:${source.id}`,
		sourceId: source.id,
		sourceTitle: source.title,
		title: `${source.title} source metadata`,
		text,
		url: source.canonical_url,
		access: source.access,
		tags: source.tags ?? [],
		licenseStatus: source.license_status,
		ingestPolicy: source.ingest_policy,
	};
}

function buildChunks(): Chunk[] {
	if (cachedChunks) return cachedChunks;
	const manifest = readManifest();
	const sourcesById = new Map(manifest.sources.map((source) => [source.id, source]));
	const chunks: Chunk[] = manifest.sources.map(sourceToChunk);

	for (const file of walkMarkdown(corpusRoot)) {
		const raw = readFileSync(file, "utf8");
		const { attrs, body } = parseFrontmatter(raw);
		const sourceId = attrs.source_id || slugify(basename(file, ".md"));
		const source = sourcesById.get(sourceId);
		let index = 0;
		for (const section of sectionChunks(body)) {
			chunks.push({
				id: `${sourceId}:${slugify(section.title) || index}:${index}`,
				sourceId,
				sourceTitle: source?.title ?? sourceId,
				title: section.title,
				text: section.text,
				path: relative(packageRoot, file),
				url: source?.canonical_url,
				access: source?.access,
				tags: source?.tags ?? [],
				licenseStatus: source?.license_status,
				ingestPolicy: source?.ingest_policy,
			});
			index++;
		}
	}
	cachedChunks = chunks;
	return chunks;
}

function scoreChunk(chunk: Chunk, query: string, mode: "auto" | "keyword" | "exact") {
	const haystack = `${chunk.sourceTitle}\n${chunk.title}\n${chunk.tags.join(" ")}\n${chunk.text}`.toLowerCase();
	const phrase = query.toLowerCase().trim();
	if (!phrase) return 0;

	const exactHit = haystack.includes(phrase);
	if (mode === "exact") return exactHit ? 100 : 0;

	const terms = [...new Set(tokenize(query))];
	if (terms.length === 0) return exactHit ? 100 : 0;

	let score = exactHit ? 30 : 0;
	let covered = 0;
	const titleHaystack = `${chunk.sourceTitle} ${chunk.title}`.toLowerCase();
	const tagHaystack = chunk.tags.join(" ").toLowerCase();
	for (const term of terms) {
		const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
		const matches = haystack.match(re)?.length ?? 0;
		if (matches > 0) covered++;
		score += Math.min(matches, 8);
		if (titleHaystack.includes(term)) score += 6;
		if (tagHaystack.includes(term)) score += 4;
	}
	score += (covered / terms.length) * 20;
	return score;
}

function makeSnippet(text: string, query: string, maxLength: number) {
	const terms = tokenize(query);
	const lower = text.toLowerCase();
	let pos = -1;
	for (const term of terms) {
		pos = lower.indexOf(term.toLowerCase());
		if (pos !== -1) break;
	}
	if (pos === -1) pos = 0;
	const start = Math.max(0, pos - Math.floor(maxLength / 3));
	const end = Math.min(text.length, start + maxLength);
	const prefix = start > 0 ? "…" : "";
	const suffix = end < text.length ? "…" : "";
	return `${prefix}${text.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}

function formatSearchResults(results: Array<{ chunk: Chunk; score: number }>, query: string) {
	if (results.length === 0) {
		return `No local software KB results for ${JSON.stringify(query)}. Try broader terms, /kb-sources, or add text to ${relative(process.cwd(), corpusRoot)}.`;
	}
	return results
		.map(({ chunk, score }, index) => {
			const fields = [
				`${index + 1}. ${chunk.sourceTitle} — ${chunk.title}`,
				`   score: ${score.toFixed(1)} | source_id: ${chunk.sourceId} | access: ${chunk.access ?? "unknown"}`,
				chunk.path ? `   path: ${chunk.path}` : undefined,
				chunk.url ? `   url: ${chunk.url}` : undefined,
				chunk.licenseStatus ? `   license: ${chunk.licenseStatus}` : undefined,
				`   snippet: ${makeSnippet(chunk.text, query, 700)}`,
			];
			return fields.filter(Boolean).join("\n");
		})
		.join("\n\n");
}

export default function softwareKnowledgeBase(pi: ExtensionAPI) {
	pi.registerTool({
		name: "kb_search",
		label: "Software KB Search",
		description: "Search the local curated software-engineering classics corpus and source catalog. Returns cited passages/metadata for RAG-style answers.",
		promptSnippet: "Search curated software-engineering classic texts, source cards, and metadata.",
		promptGuidelines: [
			"Use kb_search when answering questions about classic software engineering texts, design principles, reliability, architecture, refactoring, testing, delivery, or software project practice.",
			"When kb_search returns metadata-only sources, cite them as pointers and do not imply the local corpus contains the copyrighted book text.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query, concept, phrase, or question." }),
			limit: Type.Optional(Type.Number({ description: "Maximum results to return. Default 5, max 20." })),
			mode: Type.Optional(
				Type.Union([Type.Literal("auto"), Type.Literal("keyword"), Type.Literal("exact")], {
					description: "Search mode. exact requires an exact phrase match; keyword/auto use lexical scoring.",
				}),
			),
			source_id: Type.Optional(Type.String({ description: "Optional source id filter, e.g. sicp or sre-book." })),
		}),
		async execute(_toolCallId, params) {
			const limit = Math.max(1, Math.min(Number(params.limit ?? 5), 20));
			const mode = (params.mode ?? "auto") as "auto" | "keyword" | "exact";
			const sourceId = params.source_id?.trim();
			const chunks = buildChunks().filter((chunk) => !sourceId || chunk.sourceId === sourceId);
			const results = chunks
				.map((chunk) => ({ chunk, score: scoreChunk(chunk, params.query, mode) }))
				.filter((result) => result.score > 0)
				.sort((a, b) => b.score - a.score)
				.slice(0, limit);

			return {
				content: [{ type: "text", text: formatSearchResults(results, params.query) }],
				details: {
					query: params.query,
					mode,
					source_id: sourceId,
					count: results.length,
					results: results.map(({ chunk, score }) => ({
						score,
						source_id: chunk.sourceId,
						source_title: chunk.sourceTitle,
						title: chunk.title,
						path: chunk.path,
						url: chunk.url,
						access: chunk.access,
						license_status: chunk.licenseStatus,
						ingest_policy: chunk.ingestPolicy,
						snippet: makeSnippet(chunk.text, params.query, 500),
					})),
				},
			};
		},
	});

	pi.registerTool({
		name: "kb_sources",
		label: "Software KB Sources",
		description: "List curated software-engineering classics sources and their access/ingest status.",
		promptSnippet: "List software KB source catalog and access status.",
		promptGuidelines: ["Use kb_sources to inspect which software-engineering classics are full-text/public-web versus metadata-only."],
		parameters: Type.Object({
			access: Type.Optional(Type.String({ description: "Optional access filter, e.g. metadata_only, full_text_public_web, public_web." })),
			tag: Type.Optional(Type.String({ description: "Optional tag filter, e.g. architecture, testing, sre." })),
		}),
		async execute(_toolCallId, params) {
			const manifest = readManifest();
			const access = params.access?.trim().toLowerCase();
			const tag = params.tag?.trim().toLowerCase();
			const sources = manifest.sources.filter((source) => {
				if (access && source.access?.toLowerCase() !== access) return false;
				if (tag && !(source.tags ?? []).some((value) => value.toLowerCase() === tag)) return false;
				return true;
			});
			const text = [
				`Software KB sources (${sources.length}/${manifest.sources.length})`,
				manifest.selection_method ? `Selection: ${manifest.selection_method}` : undefined,
				manifest.runtime_policy ? `Policy: ${manifest.runtime_policy}` : undefined,
				"",
				...sources.map((source, index) =>
					[
						`${index + 1}. ${source.title} (${source.id})`,
						`   authors: ${(source.authors ?? []).join(", ")}`,
						`   access: ${source.access ?? "unknown"}`,
						`   ingest: ${source.ingest_policy ?? "unknown"}`,
						`   license: ${source.license_status ?? "unknown"}`,
						`   tags: ${(source.tags ?? []).join(", ")}`,
						source.canonical_url ? `   url: ${source.canonical_url}` : undefined,
					]
						.filter(Boolean)
						.join("\n"),
				),
			]
				.filter((line) => line !== undefined)
				.join("\n");

			return {
				content: [{ type: "text", text }],
				details: { sources },
			};
		},
	});

	pi.registerCommand("kb-search", {
		description: "Ask pi to search the software engineering classics KB",
		handler: async (args, ctx) => {
			const query = args.trim();
			if (!query) {
				ctx.ui.notify("Usage: /kb-search <query>", "info");
				return;
			}
			pi.sendUserMessage(`Search the software engineering classics KB for: ${query}\n\nUse kb_search first. Cite source ids, access status, and URLs/paths. If a source is metadata-only, say so.`);
		},
	});

	pi.registerCommand("kb-sources", {
		description: "Ask pi to list the software engineering classics KB source catalog",
		handler: async (args) => {
			const filter = args.trim();
			pi.sendUserMessage(`List the software engineering classics KB sources${filter ? ` filtered by ${filter}` : ""}. Use kb_sources and include access/ingest status.`);
		},
	});
}
