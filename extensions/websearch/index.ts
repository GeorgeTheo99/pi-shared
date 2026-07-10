/**
 * Web Search & Fetch Tools — native Pi wrappers around the local-search MCP broker.
 *
 * The MCP broker is the stable entry point for product/Pi search. It owns the
 * backend strategy (local SearXNG first, policy-controlled Tavily egress)
 * so clients do not bypass broker-level reliability, policy, and observability.
 */

import { Type } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	CONFIG_PATH,
	mcpToolCall,
	readConfiguredMcpUrls,
	type McpToolCallResult,
} from "./mcp-client.js";
import { normalizeCount, normalizeToolText, TOOL_OUTPUT_CHAR_LIMIT } from "./text.ts";

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

interface McpSearchPayload {
	query?: string;
	results?: SearchResult[];
	suggestions?: string[];
	text?: string;
	error?: string;
	status?: string;
	backend?: string | null;
	attempted?: string[];
	fallback_reason?: string | null;
	timings_ms?: Record<string, number | null>;
	provider_states?: Record<string, string>;
}

function parseMcpSearchPayload(text: string): McpSearchPayload | undefined {
	try {
		const parsed = JSON.parse(text) as McpSearchPayload;
		return parsed && typeof parsed === "object" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function formatSearchResults(results: SearchResult[], numResults: number): string {
	return results
		.slice(0, Math.max(0, Math.floor(numResults)))
		.map((result, index) => {
			const rank = Number.isFinite(result.rank) ? result.rank : index + 1;
			const title = normalizeToolText(String(result.title ?? "Untitled"), 1_000);
			const url = normalizeToolText(String(result.url ?? ""), 4_000);
			const snippet = normalizeToolText(String(result.snippet ?? ""), 4_000);
			return [`${rank}. ${title}`, url, snippet].filter(Boolean).join("\n");
		})
		.join("\n\n");
}

function mcpErrorText(action: "Search" | "Fetch", result: McpToolCallResult): string {
	return [
		`${action} error: Could not reach the local-search MCP broker.`,
		`Checked: ${result.checked.join(", ")}`,
		result.error ? `MCP error: ${result.error}` : undefined,
		`Configure PI_WEBSEARCH_MCP_URL, SEARCH_MCP_URL, WEBSEARCH_MCP_URL, websearchMcpUrl/mcpUrl in ${CONFIG_PATH}, or start the local-search MCP service.`,
	]
		.filter(Boolean)
		.join("\n");
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const webSearch = defineTool({
	name: "web_search",
	label: "Web Search",
	description:
		"Search the web via the local-search MCP broker, which uses loopback SearXNG with policy-controlled Tavily fallback or supplementation. Use this for ANY question about current events, news, facts, people, places, or any topic that requires up-to-date information. Returns ranked results with titles, URLs, and snippets.",
	promptSnippet: "web_search for quick web lookups via the local-search MCP broker",
	promptGuidelines: [
		"Use web_search for quick facts, current information, or single-page lookups. Use web_fetch to read a specific URL found via web_search.",
		"Do NOT use web_search for deep multi-source research — use deep_research instead.",
		"Do NOT make 3+ sequential web_search + web_fetch calls for the same topic — use deep_research once instead.",
		"For low-risk, reversible local actions, treat strong web_search results as execution hints: try the most plausible fix quickly, verify it directly, and escalate to deep_research only if that path fails.",
	],
	parameters: Type.Object({
		query: Type.String({ description: "Search query" }),
		num_results: Type.Optional(
			Type.Number({ description: "Max results to return", default: 8 }),
		),
	}),

	async execute(_id, params, signal, _onUpdate, _ctx) {
		const numResults = normalizeCount(params.num_results ?? 8, 8);
		const mcp = await mcpToolCall(
			readConfiguredMcpUrls(),
			"web_search",
			{
				query: params.query,
				num_results: numResults,
			},
			{ signal, timeoutMs: 20_000, requestId: "pi-websearch" },
		);

		if (!mcp.text) {
			return {
				content: [{ type: "text" as const, text: mcpErrorText("Search", mcp) }],
				details: {
					provider: "mcp",
					query: params.query,
					error: true,
					checked: mcp.checked,
					mcpError: mcp.error,
				},
			};
		}

		const payload = parseMcpSearchPayload(mcp.text);
		const structuredText = payload?.results?.length
			? formatSearchResults(payload.results, numResults)
			: undefined;
		const text = normalizeToolText(structuredText ?? payload?.text ?? mcp.text);
		return {
			content: [{ type: "text" as const, text }],
			details: {
				provider: "mcp",
				query: params.query,
				endpointUrl: mcp.endpointUrl,
				checked: mcp.checked,
				results: payload?.results,
				suggestions: payload?.suggestions,
				status: payload?.status,
				backend: payload?.backend,
				attempted: payload?.attempted,
				fallback_reason: payload?.fallback_reason,
				timings_ms: payload?.timings_ms,
				provider_states: payload?.provider_states,
				error: Boolean(payload?.error),
				mcpError: payload?.error,
			},
		};
	},
});

const webFetch = defineTool({
	name: "web_fetch",
	label: "Web Fetch",
	description:
		"Fetch a URL via the local-search MCP broker and return its text content. Use this to read the full content of a web page found via web_search, or any URL the user provides.",
	promptSnippet: "web_fetch to retrieve full page content through the local-search MCP broker",
	promptGuidelines: [
		"Use web_fetch to read a specific URL's content — typically a URL found via web_search.",
		"Do NOT use web_fetch for research questions — use web_search or deep_research instead.",
	],
	parameters: Type.Object({
		url: Type.String({ description: "URL to fetch" }),
		max_chars: Type.Optional(
			Type.Number({
				description: "Maximum characters to return",
				default: 20000,
			}),
		),
	}),

	async execute(_id, params, signal, _onUpdate, _ctx) {
		const maxChars = normalizeCount(params.max_chars ?? 20_000, 20_000);
		const mcp = await mcpToolCall(
			readConfiguredMcpUrls(),
			"web_fetch",
			{ url: params.url, max_chars: maxChars },
			{ signal, timeoutMs: 30_000, requestId: "pi-websearch" },
		);

		if (!mcp.text) {
			return {
				content: [{ type: "text" as const, text: mcpErrorText("Fetch", mcp) }],
				details: {
					provider: "mcp",
					url: params.url,
					error: true,
					checked: mcp.checked,
					mcpError: mcp.error,
				},
			};
		}

		const isError = mcp.text.startsWith("Fetch error:");
		const text = normalizeToolText(mcp.text, Math.min(maxChars, TOOL_OUTPUT_CHAR_LIMIT));
		return {
			content: [{ type: "text" as const, text }],
			details: {
				provider: "mcp",
				url: params.url,
				endpointUrl: mcp.endpointUrl,
				checked: mcp.checked,
				error: isError,
			},
		};
	},
});

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerTool(webSearch);
	pi.registerTool(webFetch);
}
