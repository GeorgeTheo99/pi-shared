/**
 * Web Search & Fetch Tools — native Pi wrappers around the local-search MCP broker.
 *
 * The MCP broker is the stable entry point for product/Pi search. It owns the
 * backend strategy (local/private SearXNG first, Tavily fallback when configured)
 * so clients do not bypass broker-level reliability, policy, and observability.
 */

import { Type } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONFIG_PATH = join(homedir(), ".pi", "research", "config.json");
const DEFAULT_LOCAL_MCP = ["http://127.0.0.1:8889/mcp", "http://localhost:8889/mcp"];

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

interface McpToolCallResult {
	endpointUrl?: string;
	checked: string[];
	text?: string;
	result?: unknown;
	error?: string;
}

interface McpSearchPayload {
	query?: string;
	results?: SearchResult[];
	suggestions?: string[];
	text?: string;
	error?: string;
}

function normalizeBaseUrl(url: string): string {
	return url.replace(/\/+$/, "");
}

function readSearchConfig(): Record<string, unknown> {
	if (!existsSync(CONFIG_PATH)) return {};
	try {
		return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
	} catch {
		// Ignore malformed config; the tool error reports the checked endpoints.
		return {};
	}
}

function readConfiguredMcpUrls(): string[] {
	const envValues = [
		process.env.PI_WEBSEARCH_MCP_URL,
		process.env.SEARCH_MCP_URL,
		process.env.WEBSEARCH_MCP_URL,
	].filter(Boolean) as string[];

	const config = readSearchConfig();
	const configValues = [config.websearchMcpUrl, config.mcpUrl].filter(
		(value): value is string => typeof value === "string" && value.length > 0,
	);

	return [...new Set([...envValues, ...configValues, ...DEFAULT_LOCAL_MCP].map(normalizeBaseUrl))];
}

function readMcpApiKey(): string | undefined {
	return [
		process.env.PI_WEBSEARCH_MCP_API_KEY,
		process.env.SEARCH_MCP_API_KEY,
		process.env.TAVILY_API_KEY,
	]
		.find((value) => typeof value === "string" && value.trim().length > 0)
		?.trim();
}

function mcpResultText(result: unknown): string | undefined {
	if (result && typeof result === "object") {
		const content = (result as { content?: unknown }).content;
		if (Array.isArray(content)) {
			const parts = content
				.map((item) =>
					item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
						? (item as { text: string }).text
						: undefined,
				)
				.filter((part): part is string => Boolean(part));
			if (parts.length) return parts.join("\n");
		}

		const structured = (result as { structuredContent?: unknown }).structuredContent;
		if (structured && typeof structured === "object") return JSON.stringify(structured);
	}
	return result === undefined ? undefined : JSON.stringify(result);
}

async function mcpToolCall(
	toolName: string,
	args: Record<string, unknown>,
	timeout = 20_000,
): Promise<McpToolCallResult> {
	const checked: string[] = [];
	const apiKey = readMcpApiKey();
	const headers: Record<string, string> = {
		Accept: "application/json",
		"Content-Type": "application/json",
	};
	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
		headers["X-Tavily-Key"] = apiKey;
	}

	const payload = {
		jsonrpc: "2.0",
		id: "pi-websearch",
		method: "tools/call",
		params: { name: toolName, arguments: args },
	};

	let lastError: string | undefined;
	for (const endpointUrl of readConfiguredMcpUrls()) {
		checked.push(endpointUrl);
		try {
			const resp = await fetch(endpointUrl, {
				method: "POST",
				headers,
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(timeout),
			});
			if (!resp.ok) {
				lastError = `HTTP ${resp.status} ${resp.statusText}`;
				continue;
			}

			const data = (await resp.json()) as { result?: unknown; error?: unknown };
			if (data.error !== undefined) {
				lastError = typeof data.error === "string" ? data.error : JSON.stringify(data.error);
				continue;
			}
			if (!("result" in data)) {
				lastError = "Malformed MCP response: missing result";
				continue;
			}

			const text = mcpResultText(data.result);
			if (!text) {
				lastError = "Malformed MCP response: empty result content";
				continue;
			}
			return { endpointUrl, checked, result: data.result, text };
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
		}
	}

	return { checked, error: lastError ?? "MCP broker unavailable" };
}

function parseMcpSearchPayload(text: string): McpSearchPayload | undefined {
	try {
		const parsed = JSON.parse(text) as McpSearchPayload;
		return parsed && typeof parsed === "object" ? parsed : undefined;
	} catch {
		return undefined;
	}
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
		"Search the web via the local-search MCP broker, which uses local/private SearXNG with broker-managed fallback. Use this for ANY question about current events, news, facts, people, places, or any topic that requires up-to-date information. Returns ranked results with titles, URLs, and snippets.",
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

	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const numResults = params.num_results ?? 8;
		const mcp = await mcpToolCall("web_search", {
			query: params.query,
			num_results: numResults,
		});

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
		const text = payload?.text ?? mcp.text;
		return {
			content: [{ type: "text" as const, text }],
			details: {
				provider: "mcp",
				query: params.query,
				endpointUrl: mcp.endpointUrl,
				checked: mcp.checked,
				results: payload?.results,
				suggestions: payload?.suggestions,
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

	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const maxChars = params.max_chars ?? 20000;
		const mcp = await mcpToolCall(
			"web_fetch",
			{ url: params.url, max_chars: maxChars },
			30_000,
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
		return {
			content: [{ type: "text" as const, text: mcp.text }],
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
