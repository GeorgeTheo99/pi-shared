# Web Search

Shared Pi extension that provides `web_search` and `web_fetch` through the local-search MCP broker.

- `web_search` calls the broker tool `web_search(query, num_results)`.
- `web_fetch` calls the broker tool `web_fetch(url, max_chars)`.
- The broker is the stable entry point. It owns backend strategy: loopback/self-hosted SearXNG first, then policy-controlled Tavily fallback or supplementation.
- Pi clients do **not** fall back directly to SearXNG. If the broker is down, the tool reports a broker error so reliability issues are fixed at the shared entry point instead of bypassed.
- For low-risk, reversible local actions, treat strong `web_search` results as execution hints: try the most plausible fix or workflow quickly, verify it directly, and only escalate to deeper research if that concrete path fails.

## MCP broker requirement

This extension does **not** install or run local-search. Each machine that loads `pi-shared` must have a reachable MCP broker exposing these JSON-RPC tools:

- `web_search(query: str, num_results: int = 8)`
- `web_fetch(url: str, max_chars: int = 20000)`

Recommended local URL: `http://127.0.0.1:8889/mcp`.

The broker handles SearXNG configuration internally. The shared local-search broker uses loopback `http://127.0.0.1:8888` and supports explicit Tavily `disabled`, `fallback`, and `supplement` policies.

## MCP URL resolution

Configured URLs are collected in this order:

1. `PI_WEBSEARCH_MCP_URL`
2. `SEARCH_MCP_URL`
3. `WEBSEARCH_MCP_URL`
4. `~/.pi/research/config.json`

If any URL is explicitly configured, only those configured URLs are tried; Pi does not silently fall back to a local endpoint. With no configuration, the sole default is `http://127.0.0.1:8889/mcp`.

Config file example:

```json
{
  "websearchMcpUrl": "http://127.0.0.1:8889/mcp"
}
```

`mcpUrl` is also accepted for compatibility with other local-search clients.

## Credentials and transport safety

Broker authentication and Tavily forwarding use separate credentials:

- Broker token (`Authorization: Bearer ...`): `PI_WEBSEARCH_MCP_API_KEY`, then `SEARCH_MCP_API_KEY`.
- Tavily key (`X-Tavily-Key`): `PI_WEBSEARCH_TAVILY_API_KEY`, then `TAVILY_API_KEY`.

Pi forwards a Tavily key only for `web_search` calls to a loopback broker (`localhost`, `127.0.0.0/8`, or `::1`); `web_fetch` never receives it. Broker authentication may be sent to loopback HTTP or any HTTPS endpoint. No credential headers are sent to a non-loopback plain-HTTP endpoint, MCP redirects are rejected, embedded URL credentials are refused, and sensitive endpoint query parameters are redacted from diagnostics.

Each `web_search` or `web_fetch` call has one total deadline across all configured endpoint attempts (20 seconds for search, 30 seconds for fetch). Cancelling the Pi tool call aborts the in-flight broker request and remains a cancellation rather than a broker error.

## Search details

When supplied by the broker, `web_search` preserves `status`, `backend`, `attempted`, `fallback_reason`, `timings_ms`, and `provider_states` in the tool result details alongside the existing fields.

## Why broker-first instead of direct SearXNG?

Pros:

- One stable client contract for Pi and product apps.
- Centralized fallback, dedupe, circuit breaking, SSRF guards, provider policy, and observability.
- Easier to add or swap providers without changing every client.

Cons versus pure direct SearXNG:

- One extra local HTTP/JSON-RPC hop.
- The broker becomes the required availability boundary.
- SearXNG-specific knobs/results must be exposed by the broker before clients can use them.
- Structured SearXNG JSON may be normalized or wrapped by the broker, so clients needing raw fields should add broker support for those fields.

## Verification

Run the client contract tests from `pi-shared`:

```bash
npm run test:websearch
```

Then verify the live broker on the target machine:

```bash
curl -fsS http://127.0.0.1:8889/health | python3 -m json.tool
curl -fsS -H 'Accept: application/json' -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"check","method":"tools/call","params":{"name":"web_search","arguments":{"query":"pi websearch health check","num_results":3}}}' \
  http://127.0.0.1:8889/mcp | python3 -m json.tool
```

Then restart Pi or run:

```text
/reload
```
