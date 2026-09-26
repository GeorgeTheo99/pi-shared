import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	DEFAULT_LOCAL_MCP,
	isLoopbackEndpoint,
	mcpRequestHeaders,
	mcpResultText,
	mcpToolCall,
	resolveConfiguredMcpUrls,
	WEB_FETCH_TIMEOUT_MS,
	WEB_SEARCH_TIMEOUT_MS,
} from "../extensions/websearch/mcp-client.ts";

test("broker errors redact known endpoint and header credentials and are bounded", async () => {
	const endpoint = "https://search.example/mcp?token=private%20token";
	const fetchImpl = (async () => new Response(JSON.stringify({ result: { isError: true, content: [{ type: "text", text: `denied ${endpoint}; private token; header-secret; ${"x".repeat(5000)}` }] } }))) as typeof fetch;
	const result = await mcpToolCall([endpoint], "web_search", { query: "q" }, { fetchImpl, env: { PI_WEBSEARCH_MCP_API_KEY: "header-secret" } });
	assert.ok(!result.error?.includes("private"));
	assert.ok(!result.error?.includes("header-secret"));
	assert.match(result.error ?? "", /redacted/);
	assert.ok(result.error!.length <= 2048);
});

test("web fetch allows the broker fallback chain without slowing search", () => {
	assert.equal(WEB_SEARCH_TIMEOUT_MS, 20_000);
	assert.equal(WEB_FETCH_TIMEOUT_MS, 65_000);
});

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

test("empty or malformed MCP envelopes cannot become successful evidence", async () => {
	for (const envelope of [null, {}, { content: [] }, { content: [{ type: "text", text: "" }] }, { content: [{ type: "text", text: "  \n" }] }, { structuredContent: {} }, { content: [{ type: "image", text: "not page text" }] }]) {
		assert.equal(mcpResultText(envelope), undefined);
		const fetchImpl = (async () => new Response(JSON.stringify({ result: envelope }))) as typeof fetch;
		const result = await mcpToolCall(["https://example.com/mcp"], "web_fetch", { url: "https://page.example" }, { fetchImpl });
		assert.equal(result.text, undefined);
		assert.match(result.error ?? "", /empty result content/);
	}
	assert.equal(mcpResultText({ content: [], structuredContent: { results: [] } }), '{"results":[]}');
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
	assert.equal(result.endpointIndex, 1);
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

test("endpoint identity preserves the original index without returning query credentials", async () => {
	const endpoints = [
		"not a URL",
		"https://search.example/mcp?token=first-secret",
		"https://search.example/mcp?token=second-secret",
	];
	const seen: string[] = [];
	const fetchImpl = (async (input: URL | RequestInfo) => {
		seen.push(String(input));
		if (String(input) === endpoints[1]) return new Response(null, { status: 503 });
		return Response.json({ result: { content: [{ type: "text", text: "ok" }] } });
	}) as typeof fetch;
	const result = await mcpToolCall(endpoints, "web_search", {}, { fetchImpl });
	assert.equal(result.endpointIndex, 2);
	assert.equal(result.checked[1], result.checked[2]);
	assert.equal(result.endpointUrl, result.checked[2]);
	assert.match(result.endpointUrl ?? "", /redacted/i);
	assert.equal(JSON.stringify(result).includes("first-secret"), false);
	assert.equal(JSON.stringify(result).includes("second-secret"), false);

	// Reuse the private URL by index, never the redacted diagnostic label.
	await mcpToolCall([endpoints[result.endpointIndex!]], "web_search", {}, { fetchImpl });
	assert.deepEqual(seen, [endpoints[1], endpoints[2], endpoints[2]]);
});

test("MCP isError text is a failure, not successful tool output", async () => {
	const fetchImpl = (async () => Response.json({
		result: { isError: true, content: [{ type: "text", text: "tool failed" }] },
	})) as typeof fetch;
	const result = await mcpToolCall(["https://search.example/mcp"], "web_search", {}, { fetchImpl });
	assert.equal(result.error, "tool failed");
	assert.equal(result.text, undefined);
	assert.equal(result.result, undefined);
	assert.equal(result.endpointIndex, undefined);
});

test("MCP isError falls back while an explicit false remains successful", async () => {
	const fetchImpl = (async (input: URL | RequestInfo) => Response.json({
		result: {
			isError: String(input).includes("first"),
			content: [{ type: "text", text: String(input).includes("first") ? "failed" : "ok" }],
		},
	})) as typeof fetch;
	const result = await mcpToolCall(
		["https://first.example/mcp", "https://second.example/mcp"],
		"web_search", {}, { fetchImpl },
	);
	assert.equal(result.endpointIndex, 1);
	assert.equal(result.text, "ok");
	assert.equal(result.error, undefined);
});

test("HTTP failure bodies are cancelled before trying the next endpoint", async () => {
	const events: string[] = [];
	const fetchImpl = (async (input: URL | RequestInfo) => {
		if (String(input).includes("first")) {
			return new Response(new ReadableStream({
				async cancel() {
					await Promise.resolve();
					events.push("cancelled");
				},
			}), { status: 503 });
		}
		events.push("fallback");
		return Response.json({ result: { content: [{ type: "text", text: "ok" }] } });
	}) as typeof fetch;
	const result = await mcpToolCall(
		["https://first.example/mcp", "https://second.example/mcp"],
		"web_search", {}, { fetchImpl },
	);
	assert.deepEqual(events, ["cancelled", "fallback"]);
	assert.equal(result.text, "ok");
});

test("HTTP body cleanup failures preserve the HTTP error", async () => {
	const fetchImpl = (async () => new Response(new ReadableStream({
		cancel() { throw new Error("cleanup failed"); },
	}), { status: 503, statusText: "Unavailable" })) as typeof fetch;
	const result = await mcpToolCall(["https://search.example/mcp"], "web_search", {}, { fetchImpl });
	assert.equal(result.error, "HTTP 503 Unavailable");
});

test("HTTP body cleanup cannot delay the shared deadline", async () => {
	let cancelled = false;
	const fetchImpl = (async () => new Response(new ReadableStream({
		cancel() {
			cancelled = true;
			return new Promise<void>(() => {});
		},
	}), { status: 503 })) as typeof fetch;
	const result = await mcpToolCall(
		["https://first.example/mcp", "https://second.example/mcp"],
		"web_search", {}, { timeoutMs: 25, fetchImpl },
	);
	assert.equal(cancelled, true);
	assert.deepEqual(result.checked, ["https://first.example/mcp"]);
	assert.match(result.error ?? "", /deadline exceeded/);
});

test("caller cancellation interrupts HTTP body cleanup even on the last endpoint", async () => {
	const controller = new AbortController();
	const reason = new Error("cancelled during cleanup");
	const fetchImpl = (async () => new Response(new ReadableStream({
		cancel() {
			controller.abort(reason);
			return new Promise<void>(() => {});
		},
	}), { status: 503 })) as typeof fetch;
	await assert.rejects(mcpToolCall(
		["https://search.example/mcp"], "web_search", {},
		{ signal: controller.signal, timeoutMs: 1000, fetchImpl },
	), (error) => error === reason);
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

test("caller cancellation during body reading is rethrown without fallback", async () => {
	const controller = new AbortController();
	const reason = new Error("cancelled during body read");
	let calls = 0;
	const fetchImpl = (async (_input: URL | RequestInfo, init?: RequestInit) => {
		calls++;
		return new Response(new ReadableStream({
			start(stream) {
				init?.signal?.addEventListener("abort", () => stream.error(init.signal?.reason), { once: true });
			},
			pull() {
				// Response.json() has acquired the reader before this scheduled abort.
				setTimeout(() => controller.abort(reason), 0);
			},
		}));
	}) as typeof fetch;
	await assert.rejects(mcpToolCall(
		["https://first.example/mcp", "https://second.example/mcp"],
		"web_search", {}, { signal: controller.signal, timeoutMs: 1000, fetchImpl },
	), (error) => error === reason);
	assert.equal(calls, 1);
});

test("the shared deadline also covers body reading", async () => {
	const fetchImpl = (async (_input: URL | RequestInfo, init?: RequestInit) =>
		new Response(new ReadableStream({
			start(stream) {
				init?.signal?.addEventListener("abort", () => stream.error(init.signal?.reason), { once: true });
			},
		}))) as typeof fetch;
	const result = await mcpToolCall(
		["https://first.example/mcp", "https://second.example/mcp"],
		"web_search", {}, { timeoutMs: 25, fetchImpl },
	);
	assert.deepEqual(result.checked, ["https://first.example/mcp"]);
	assert.match(result.error ?? "", /deadline exceeded/);
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


test("saved broker token is private, endpoint-scoped, and redacted on errors", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-search-token-")));
	try {
		const path = join(dir, "token");
		writeFileSync(path, "private-file-token\n", { mode: 0o600 });
		const config = { websearchMcpKeyFile: path, websearchMcpKeyUrl: "https://search.example/mcp" };
		const seen: Array<string | undefined> = [];
		const fetchImpl = (async (_input: URL | RequestInfo, init?: RequestInit) => {
			seen.push((init?.headers as Record<string, string>).Authorization);
			return Response.json({ result: { isError: true, content: [{ text: "denied private-file-token" }] } });
		}) as typeof fetch;
		const result = await mcpToolCall(["https://other.example/mcp", config.websearchMcpKeyUrl], "web_search", {}, { config, env: {}, fetchImpl });
		assert.deepEqual(seen, [undefined, "Bearer private-file-token"]);
		assert.ok(!result.error?.includes("private-file-token"));
		assert.match(result.error!, /redacted/);
		seen.length = 0;
		await mcpToolCall([config.websearchMcpKeyUrl], "web_fetch", {}, { config, env: { SEARCH_MCP_API_KEY: "environment-token" }, fetchImpl });
		assert.deepEqual(seen, ["Bearer environment-token"]);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unsafe or missing broker key files fail closed before fetch", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-search-token-")));
	try {
		const path = join(dir, "token");
		const config = { websearchMcpKeyFile: path, websearchMcpKeyUrl: "https://search.example/mcp" };
		let called = false;
		const fetchImpl = (async () => { called = true; return new Response(); }) as typeof fetch;
		const rejected = async (value = config) => {
			const result = await mcpToolCall([config.websearchMcpKeyUrl], "web_search", {}, { config: value, env: {}, fetchImpl });
			assert.match(result.error!, /bearer-token/);
			assert.equal(called, false);
		};
		await rejected();
		writeFileSync(path, "secret", { mode: 0o644 });
		await rejected();
		chmodSync(path, 0o600);
		await rejected({ ...config, websearchMcpKeyUrl: "http://remote.example/mcp" });
		await rejected({ ...config, websearchMcpKeyUrl: "https://user:secret@remote.example/mcp" });
		const link = join(dir, "link");
		symlinkSync(path, link);
		await rejected({ ...config, websearchMcpKeyFile: link });
		writeFileSync(path, "secret\nInjected-Header: bad");
		await rejected();
	} finally { rmSync(dir, { recursive: true, force: true }); }
});


test("fresh client process loads wizard config and token reference from isolated HOME", () => {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "pi-search-home-")));
	try {
		const research = join(home, ".pi", "research");
		mkdirSync(research, { recursive: true, mode: 0o700 });
		const key = join(research, "key");
		writeFileSync(key, "wizard-token\n", { mode: 0o600 });
		writeFileSync(join(research, "config.json"), JSON.stringify({
			websearchMcpUrl: "https://search.example/mcp", websearchMcpKeyFile: key,
			websearchMcpKeyUrl: "https://search.example/mcp", browserWorkerEnabled: true,
		}), { mode: 0o600 });
		const source = new URL("../extensions/websearch/mcp-client.ts", import.meta.url).href;
		const script = `
			import { readConfiguredMcpUrls, mcpToolCall } from ${JSON.stringify(source)};
			const result = await mcpToolCall(readConfiguredMcpUrls(), "web_search", {}, {
				env: {}, fetchImpl: async (url, init) => {
					if (url !== "https://search.example/mcp" || init.headers.Authorization !== "Bearer wizard-token") throw Error("routing/auth mismatch");
					return Response.json({result:{content:[{text:"ok"}]}});
				}
			});
			if (result.text !== "ok") throw Error(result.error);
		`;
		const env: Record<string, string | undefined> = { ...process.env, HOME: home };
		for (const name of ["PI_WEBSEARCH_MCP_URL", "SEARCH_MCP_URL", "WEBSEARCH_MCP_URL"]) delete env[name];
		const result = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], { env, encoding: "utf8", timeout: 10000 });
		assert.equal(result.status, 0, result.stderr);
	} finally { rmSync(home, { recursive: true, force: true }); }
});
