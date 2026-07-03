# Web Search

Shared Pi extension that provides `web_search` and `web_fetch` through the local-search MCP broker.

- `web_search` calls the broker tool `web_search(query, num_results)`.
- `web_fetch` calls the broker tool `web_fetch(url, max_chars)`.
- The broker is the stable entry point. It owns backend strategy: local/private SearXNG first, then broker-managed fallback such as Tavily when available.
- Pi clients do **not** fall back directly to SearXNG. If the broker is down, the tool reports a broker error so reliability issues are fixed at the shared entry point instead of bypassed.
- For low-risk, reversible local actions, treat strong `web_search` results as execution hints: try the most plausible fix or workflow quickly, verify it directly, and only escalate to deeper research if that concrete path fails.

## MCP broker requirement

This extension does **not** install or run local-search. Each machine that loads `pi-shared` must have a reachable MCP broker exposing these JSON-RPC tools:

- `web_search(query: str, num_results: int = 8)`
- `web_fetch(url: str, max_chars: int = 20000)`

Recommended local URL: `http://127.0.0.1:8889/mcp`.

The broker should handle local/private SearXNG configuration internally. The current shared local-search broker uses `http://localhost:8888` for SearXNG and can use Tavily fallback when SearXNG is empty/errors.

## MCP URL resolution

The tool checks, in order:

1. `PI_WEBSEARCH_MCP_URL`
2. `SEARCH_MCP_URL`
3. `WEBSEARCH_MCP_URL`
4. `~/.pi/research/config.json`
5. local defaults:
   - `http://127.0.0.1:8889/mcp`
   - `http://localhost:8889/mcp`

Config file example:

```json
{
  "websearchMcpUrl": "http://127.0.0.1:8889/mcp"
}
```

`mcpUrl` is also accepted for compatibility with other local-search clients.

Optional API/key forwarding:

- `PI_WEBSEARCH_MCP_API_KEY`
- `SEARCH_MCP_API_KEY`
- `TAVILY_API_KEY`

When one is set, Pi sends both `Authorization: Bearer <key>` and `X-Tavily-Key: <key>` to the broker so the transport and/or broker fallback can use it.

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

Run this on the target machine:

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
