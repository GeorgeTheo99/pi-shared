# Web Search

Shared Pi extension that provides `web_search` and `web_fetch` through the local-search MCP broker.

- `web_search` calls the broker tool `web_search(query, num_results)`.
- `web_fetch` calls the broker tool `web_fetch(url, max_chars)`.
- The broker is the stable entry point and owns backend strategy. The standalone `local_web_search` service uses Brave Search and direct-first page retrieval with optional Decodo/Jina recovery; SearXNG is retired there.
- Pi clients do **not** fall back directly to search providers. If the broker is down, the tool reports a broker error so reliability issues are fixed at the shared entry point instead of bypassed.
- For low-risk, reversible local actions, treat strong `web_search` results as execution hints: try the most plausible fix or workflow quickly, verify it directly, and only escalate to deeper research if that concrete path fails.

## MCP broker requirement

This extension does **not** install or run local-search. Using these tools requires a reachable MCP broker exposing the following JSON-RPC tools; unrelated Pi features remain usable without it:

- `web_search(query: str, num_results: int = 8)`
- `web_fetch(url: str, max_chars: int = 20000)`

Recommended local URL: `http://127.0.0.1:8889/mcp`.

Provision the standalone broker's owner-only Brave key before its first started install, following the `local_web_search` README. Provider credentials belong to the service, not Pi settings. Alternative brokers/overlays may implement the same tool contract.

These are native Pi wrappers that contact MCP directly, not registrations in `pi-mcp-adapter`. Consequently `/mcp` does not list them. Use `/mcp-connections` or `dev_doctor` for both integration paths; registered tools are not proof of service readiness.

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

Broker authentication and legacy Tavily forwarding use separate credentials. Tavily forwarding remains client compatibility for other brokers; it is **not** a requirement or search-provider choice for the Brave-only `local_web_search` service:

- Broker token (`Authorization: Bearer ...`): `PI_WEBSEARCH_MCP_API_KEY`, then `SEARCH_MCP_API_KEY`.
- Tavily key (`X-Tavily-Key`): `PI_WEBSEARCH_TAVILY_API_KEY`, then `TAVILY_API_KEY`.

Pi forwards a Tavily key only for `web_search` calls to a loopback broker (`localhost`, `127.0.0.0/8`, or `::1`); `web_fetch` never receives it. Broker authentication may be sent to loopback HTTP or any HTTPS endpoint. No credential headers are sent to a non-loopback plain-HTTP endpoint, MCP redirects are rejected, embedded URL credentials are refused, and sensitive endpoint query parameters are redacted from diagnostics.

Each `web_search` or `web_fetch` call has one total deadline across all configured endpoint attempts (20 seconds for search, 65 seconds for fetch). Cancelling the Pi tool call aborts the in-flight broker request and remains a cancellation rather than a broker error. The longer fetch deadline lets the broker finish its own 60-second fallback chain.

The shared transport treats standard MCP `result.isError: true` as a failed endpoint attempt, never successful text. Non-OK HTTP bodies are canceled before fallback; cleanup waits share the request deadline and cancellation signal. Error diagnostics are bounded and redact known configured endpoint/header secrets, including echoed values (not an arbitrary-secret scanner).

For internal callers, `endpointUrl` is a **redacted diagnostic label only**. A successful result's zero-based `endpointIndex` identifies its original configured URL without returning the private URL in diagnostics. Never reuse a diagnostic label as a request URL.

## Search details

When supplied by the broker, `web_search` preserves `status`, `backend`, `attempted`, `fallback_reason`, `timings_ms`, and `provider_states` in the tool result details alongside the existing fields.

## Why broker-first instead of direct provider calls?

Pros:

- One stable client contract for Pi and product apps.
- Centralized fallback, dedupe, circuit breaking, SSRF guards, provider policy, and observability.
- Easier to add or swap providers without changing every client.

Tradeoffs:

- One extra HTTP/JSON-RPC hop.
- The broker becomes the availability boundary for search/fetch calls.
- Provider-specific options/results must be exposed by the broker before clients can use them.

## Verification

Run the client contract tests from `pi-shared`:

```bash
npm run test:websearch
```

For the standalone broker, verify health and MCP inventory on the target machine:

```bash
local-search verify
```

This is not a provider search smoke. A real `web_search` call additionally exercises Brave and may incur provider charges.

Then restart Pi or run:

```text
/reload
```
