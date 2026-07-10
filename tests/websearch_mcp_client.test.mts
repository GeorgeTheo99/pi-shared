import assert from "node:assert/strict";
import test from "node:test";

import {
	DEFAULT_LOCAL_MCP,
	isLoopbackEndpoint,
	mcpRequestHeaders,
	mcpResultText,
	mcpToolCall,
	resolveConfiguredMcpUrls,
} from "../extensions/websearch/mcp-client.ts";

test("explicit MCP URLs are authoritative and deduplicated", () => {
	assert.deepEqual(resolveConfiguredMcpUrls({}, {}), DEFAULT_LOCAL_MCP);
	assert.deepEqual(
		resolveConfiguredMcpUrls(
			{
				PI_WEBSEARCH_MCP_URL: " https://search.example/mcp/ ",
				SEARCH_MCP_URL: "https://search.example/mcp",
			},
			{ mcpUrl: "https://backup.example/mcp/" },
		),
		["https://search.example/mcp", "https://backup.example/mcp"],
	);
});

test("broker and Tavily credentials remain separate", () => {
	const env = {
		PI_WEBSEARCH_MCP_API_KEY: "broker-token",
		PI_WEBSEARCH_TAVILY_API_KEY: "tavily-token",
	};
	assert.deepEqual(mcpRequestHeaders("http://127.0.0.1:8889/mcp", env), {
		Accept: "application/json",
		"Content-Type": "application/json",
		Authorization: "Bearer broker-token",
		"X-Tavily-Key": "tavily-token",
	});
	assert.deepEqual(mcpRequestHeaders("https://search.example/mcp", env), {
		Accept: "application/json",
		"Content-Type": "application/json",
		Authorization: "Bearer broker-token",
	});
	assert.deepEqual(mcpRequestHeaders("http://search.example/mcp", env), {
		Accept: "application/json",
		"Content-Type": "application/json",
	});
	assert.equal(mcpRequestHeaders("http://127.0.0.1:8889/mcp", env, false)["X-Tavily-Key"], undefined);
});

test("loopback detection covers local names and rejects remote hosts", () => {
	assert.equal(isLoopbackEndpoint("http://localhost:8889/mcp"), true);
	assert.equal(isLoopbackEndpoint("http://127.42.0.1:8889/mcp"), true);
	assert.equal(isLoopbackEndpoint("http://[::1]:8889/mcp"), true);
	assert.equal(isLoopbackEndpoint("https://search.example/mcp"), false);
	assert.equal(isLoopbackEndpoint("not a URL"), false);
});

test("MCP content extraction supports text and structured content", () => {
	assert.equal(
		mcpResultText({ content: [{ text: "one" }, { text: "two" }] }),
		"one\ntwo",
	);
	assert.equal(mcpResultText({ structuredContent: { ok: true } }), '{"ok":true}');
});

test("MCP calls reject redirects and share one endpoint deadline", async () => {
	const seen: Array<{ url: string; redirect?: RequestRedirect }> = [];
	const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
		seen.push({ url: String(input), redirect: init?.redirect });
		if (String(input).includes("first")) {
			return new Response("unavailable", { status: 503, statusText: "Unavailable" });
		}
		return new Response(
			JSON.stringify({ result: { content: [{ type: "text", text: '{"results":[]}' }] } }),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	}) as typeof fetch;
	const result = await mcpToolCall(
		["https://first.example/mcp", "https://second.example/mcp"],
		"web_search",
		{ query: "q" },
		{ timeoutMs: 1000, fetchImpl },
	);
	assert.equal(result.endpointUrl, "https://second.example/mcp");
	assert.deepEqual(result.checked, ["https://first.example/mcp", "https://second.example/mcp"]);
	assert.equal(result.text, '{"results":[]}');
	assert.deepEqual(seen.map((call) => call.redirect), ["error", "error"]);
});

test("MCP calls reject embedded URL credentials and redact diagnostics", async () => {
	let called = false;
	const fetchImpl = (async () => {
		called = true;
		return new Response();
	}) as typeof fetch;
	const result = await mcpToolCall(
		["https://user:password@search.example/mcp?api_key=secret"],
		"web_search",
		{ query: "q" },
		{ fetchImpl },
	);
	assert.equal(called, false);
	assert.match(result.error ?? "", /credentials are not supported/);
	assert.equal(result.checked.some((value) => value.includes("password") || value.includes("secret")), false);
	assert.match(result.checked[0], /redacted/i);
});

test("web_fetch does not forward Tavily credentials", async () => {
	let headers: HeadersInit | undefined;
	const fetchImpl = (async (_input: URL | RequestInfo, init?: RequestInit) => {
		headers = init?.headers;
		return new Response(
			JSON.stringify({ result: { content: [{ type: "text", text: "body" }] } }),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	}) as typeof fetch;
	await mcpToolCall(
		["http://127.0.0.1:8889/mcp"],
		"web_fetch",
		{ url: "https://example.com" },
		{ env: { PI_WEBSEARCH_TAVILY_API_KEY: "tavily-token" }, fetchImpl },
	);
	assert.equal((headers as Record<string, string>)["X-Tavily-Key"], undefined);
});

test("MCP deadline stops endpoint iteration", async () => {
	const fetchImpl = (async (_input: URL | RequestInfo, init?: RequestInit) =>
		await new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
		})) as typeof fetch;
	const started = Date.now();
	const result = await mcpToolCall(
		["https://first.example/mcp", "https://second.example/mcp"],
		"web_search",
		{ query: "q" },
		{ timeoutMs: 25, fetchImpl },
	);
	assert.deepEqual(result.checked, ["https://first.example/mcp"]);
	assert.match(result.error ?? "", /deadline exceeded/);
	assert.ok(Date.now() - started < 500);
});

test("caller cancellation is rethrown rather than converted to a broker error", async () => {
	const fetchImpl = (async (_input: URL | RequestInfo, init?: RequestInit) =>
		await new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
		})) as typeof fetch;
	const controller = new AbortController();
	const reason = new Error("cancelled by caller");
	const pending = mcpToolCall(
		["https://search.example/mcp"],
		"web_search",
		{ query: "q" },
		{ signal: controller.signal, timeoutMs: 1000, fetchImpl },
	);
	controller.abort(reason);
	await assert.rejects(pending, (error) => error === reason);
});
