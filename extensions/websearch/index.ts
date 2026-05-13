/**
 * Web Search & Fetch Tools — native pi wrappers around a local/private SearXNG JSON API.
 *
 * SearXNG is configured per machine; this shared extension discovers the endpoint
 * from environment variables, ~/.pi/research/config.json, or localhost defaults.
 */

import { Type } from "@mariozechner/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	truncateHead,
	formatSize,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
} from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONFIG_PATH = join(homedir(), ".pi", "research", "config.json");
const DEFAULT_LOCAL_SEARXNG = ["http://127.0.0.1:8888", "http://localhost:8888"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SearchResult {
	rank: number;
	title: string;
	url: string;
	domain: string;
	snippet: string;
	engine: string | null;
}

function parseDomain(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return "";
	}
}

function normalizeBaseUrl(url: string): string {
	return url.replace(/\/+$/, "");
}

function readConfiguredBaseUrls(): string[] {
	const envValues = [
		process.env.SEARXNG_BASE_URL,
		process.env.SEARXNG_URL,
		process.env.PI_SEARXNG_BASE_URL,
		process.env.PI_RESEARCH_SEARXNG_URL,
	].filter(Boolean) as string[];

	const configValues: string[] = [];
	if (existsSync(CONFIG_PATH)) {
		try {
			const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as {
				searxngBaseUrl?: string;
				searxngUrl?: string;
			};
			if (config.searxngBaseUrl) configValues.push(config.searxngBaseUrl);
			if (config.searxngUrl) configValues.push(config.searxngUrl);
		} catch {
			// Ignore malformed config; the search error reports the checked endpoints.
		}
	}

	return [...new Set([...envValues, ...configValues, ...DEFAULT_LOCAL_SEARXNG].map(normalizeBaseUrl))];
}

async function searxngRequest(
	path: string,
	params: Record<string, string>,
	timeout = 15_000,
): Promise<{ baseUrl?: string; checked: string[]; data?: Record<string, unknown> }> {
	const qs = new URLSearchParams(params).toString();
	const checked: string[] = [];

	for (const baseUrl of readConfiguredBaseUrls()) {
		checked.push(baseUrl);
		try {
			const resp = await fetch(`${baseUrl}${path}?${qs}`, {
				headers: { Accept: "application/json" },
				signal: AbortSignal.timeout(timeout),
			});
			if (!resp.ok) continue;
			return { baseUrl, checked, data: (await resp.json()) as Record<string, unknown> };
		} catch {
			// Try the next configured SearXNG endpoint.
		}
	}

	return { checked };
}

function formatResults(
	query: string,
	results: SearchResult[],
	suggestions: string[],
): string {
	if (!results.length) {
		let msg = `No results found for: ${query}`;
		if (suggestions.length) msg += `\nRelated: ${suggestions.join(", ")}`;
		return msg;
	}
	const lines: string[] = [`## Search: ${query}\n`];
	for (const r of results) {
		lines.push(`${r.rank}. **${r.title}** — ${r.domain}`);
		if (r.snippet) lines.push(`   ${r.snippet}`);
		lines.push(`   ${r.url}`);
		lines.push("");
	}
	if (suggestions.length) lines.push(`Related: ${suggestions.join(", ")}`);
	return lines.join("\n");
}

// Simple HTML → text extractor
function htmlToText(html: string): string {
	return html
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
		.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n")
		.replace(/<\/div>/gi, "\n")
		.replace(/<\/li>/gi, "\n")
		.replace(/<h[1-6][^>]*>/gi, "\n## ")
		.replace(/<\/h[1-6]>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const webSearch = defineTool({
	name: "web_search",
	label: "Web Search",
	description:
		"Search the web via local SearXNG. Use this for ANY question about current events, news, facts, people, places, or any topic that requires up-to-date information. Returns ranked results with titles, URLs, and snippets.",
	promptSnippet: "web_search to search the web via SearXNG",
	promptGuidelines: [
		"Use web_search when you need current information, facts, news, or any topic requiring up-to-date data.",
		"Use web_fetch to retrieve the full text content of a specific URL found via web_search.",
		"For low-risk, reversible local actions, treat strong web_search results as execution hints: try the most plausible fix or workflow quickly, verify it directly, and only escalate to deeper research if that concrete path fails.",
	],
	parameters: Type.Object({
		query: Type.String({ description: "Search query" }),
		num_results: Type.Optional(
			Type.Number({ description: "Max results to return", default: 8 }),
		),
	}),

	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const numResults = params.num_results ?? 8;
		const search = await searxngRequest("/search", {
			q: params.query,
			format: "json",
			categories: "general",
		});

		if (!search.data) {
			return {
				content: [
					{
						type: "text" as const,
						text: [
							"Search error: Could not reach a local/private SearXNG JSON API.",
							`Checked: ${search.checked.join(", ")}`,
							`Configure SEARXNG_BASE_URL, SEARXNG_URL, PI_SEARXNG_BASE_URL, PI_RESEARCH_SEARXNG_URL, or ${CONFIG_PATH}.`,
						].join("\n"),
					},
				],
				details: { query: params.query, error: true, checked: search.checked },
			};
		}

		const data = search.data;
		const raw = (data.results as Record<string, unknown>[]) ?? [];
		const suggestions = ((data.suggestions as string[]) ?? []).slice(0, 5);
		const unresponsive =
			(data.unresponsive_engines as Record<string, unknown>[]) ?? [];

		const results: SearchResult[] = raw.slice(0, numResults).map((r, i) => ({
			rank: i + 1,
			title: (r.title as string) ?? "Untitled",
			url: (r.url as string) ?? "",
			domain: parseDomain((r.url as string) ?? ""),
			snippet: ((r.content as string) ?? "").trim(),
			engine: typeof r.engine === "string" ? r.engine : null,
		}));

		let text = formatResults(params.query, results, suggestions);

		if (!results.length && unresponsive.length) {
			const names = unresponsive.map((e) =>
				typeof e === "object" && e !== null && "name" in e
					? String(e.name)
					: String(e),
			);
			text += ` (unresponsive engines: ${names.join(", ")})`;
		}

		return {
			content: [{ type: "text" as const, text }],
			details: { query: params.query, baseUrl: search.baseUrl, results, suggestions },
		};
	},
});

const webFetch = defineTool({
	name: "web_fetch",
	label: "Web Fetch",
	description:
		"Fetch a URL and return its text content. Use this to read the full content of a web page found via web_search, or any URL the user provides.",
	promptSnippet: "web_fetch to retrieve full page content from a URL",
	parameters: Type.Object({
		url: Type.String({ description: "URL to fetch" }),
		max_chars: Type.Optional(
			Type.Number({
				description: "Maximum characters to return",
				default: 20000,
			}),
		),
	}),

	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const maxChars = params.max_chars ?? 20000;
		try {
			const resp = await fetch(params.url, {
				headers: {
					"User-Agent":
						"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
					Accept:
						"text/html,application/xhtml+xml,application/json,text/plain,*/*",
				},
				signal: AbortSignal.timeout(30_000),
				redirect: "follow",
			});
			if (!resp.ok) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Fetch error: HTTP ${resp.status} ${resp.statusText}`,
						},
					],
					details: { url: params.url, error: true, status: resp.status },
				};
			}
			const contentType = resp.headers.get("content-type") ?? "";
			const body = await resp.text();

			let text: string;
			if (contentType.includes("html")) {
				text = htmlToText(body);
			} else {
				text = body;
			}

			// Truncate if too large for LLM context
			const truncation = truncateHead(text, {
				maxBytes: DEFAULT_MAX_BYTES,
				maxLines: DEFAULT_MAX_LINES,
			});

			let result = truncation.content;
			if (truncation.truncated) {
				result += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
			}

			return {
				content: [{ type: "text" as const, text: result }],
				details: {
					url: params.url,
					contentType,
					truncated: truncation.truncated,
				},
			};
		} catch (err) {
			return {
				content: [
					{
						type: "text" as const,
						text: `Fetch error: ${err instanceof Error ? err.message : String(err)}`,
					},
				],
				details: { url: params.url, error: true },
			};
		}
	},
});

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerTool(webSearch);
	pi.registerTool(webFetch);
}
