# Deep Research

Shared Pi extension for brokered multi-source research through the local-search MCP broker.

## Command

```text
/research [options] <question>
```

## Modes

```text
/research <question>                  # general web/docs research
/research --sources <topic>           # authoritative source discovery
/research --data <question>           # datasets, APIs, catalogs, CSV/JSON, specs, benchmarks
```

## Options

```text
--mode <general|data|sources>
--depth <quick|normal|deep>
--max-sources <N>
--fetch <N>
--no-save
--no-synthesize
```

## MCP broker configuration

The local-search MCP broker is the required entry point for research calls and owns provider strategy. The standalone `local_web_search` service uses Brave Search and bounded direct/Decodo/Jina page retrieval; SearXNG is retired there. Provision the service's private Brave key before its first started install. Alternative brokers/overlays may implement the same contract.

This native extension orchestrates MCP calls directly; it is not a server registration in `pi-mcp-adapter`. Use `/mcp-connections` or `dev_doctor` to see both integration paths. Missing search makes research unavailable, not unrelated Pi features.

Configured URLs are collected in this order:

1. `PI_WEBSEARCH_MCP_URL`
2. `SEARCH_MCP_URL`
3. `WEBSEARCH_MCP_URL`
4. `~/.pi/research/config.json`

If any URL is explicitly configured, only those configured URLs are tried. With no configuration, the sole default is `http://127.0.0.1:8889/mcp`.

Config file example:

```json
{
  "websearchMcpUrl": "http://127.0.0.1:8889/mcp"
}
```

`mcpUrl` is also accepted for compatibility with other local-search clients.

## Credentials and request safety

Broker authentication and legacy Tavily forwarding are separate. Tavily forwarding is retained for compatible alternative brokers, not required by the Brave-only standalone service:

- Broker token (`Authorization: Bearer ...`): `PI_WEBSEARCH_MCP_API_KEY`, then `SEARCH_MCP_API_KEY`.
- Tavily key (`X-Tavily-Key`): `PI_WEBSEARCH_TAVILY_API_KEY`, then `TAVILY_API_KEY`.

A Tavily key is forwarded only for broker `web_search` calls on loopback; page-fetch calls never receive it. Broker authentication may be sent to loopback HTTP or any HTTPS endpoint; no credentials are sent to non-loopback plain HTTP. MCP redirects and embedded URL credentials are rejected, and sensitive endpoint query parameters are redacted from diagnostics.

Cancellation propagates through queued searches, fetches, and follow-up work rather than becoming empty results. `/research` also forwards the command context's signal when Pi supplies one (idle commands may have no signal). There is no synthetic health-check search: real queries use the configured endpoint list directly. Only redacted broker labels are persisted, never reusable broker credentials.

## Research pipeline and bounds

| Depth | Initial queries (general / data / sources) | Source cap | Total fetch attempts | Follow-up |
|---|---|---|---|---|
| quick | 1 / 2 / 1 | 8 | 3 | None |
| normal | up to 3 / 4 / 3 | 14 | 6 | At most one round, two queries |
| deep | up to 5 / 5 / 4 | 24 | 10 | At most one round, two queries |

- CLI and tool enforce the same limits: source cap **1–50**, fetch attempts **0–30**, question **1–2000 characters**. Fetch attempts are also capped by the source cap. Invalid values fail instead of being silently clipped. Counts include failed fetches across both rounds.
- Search and fetch worker pools each allow at most **three concurrent requests per invocation**. Each search uses the shared 20-second deadline; each fetch uses the shared **65-second** deadline so broker fallbacks can finish. Concurrent tool invocations have separate budgets; there is no global rate limiter or whole-run deadline.
- Queries remain deterministic, with explicit subquestion splitting for general research. Every derived query, including follow-ups, fits the broker's **512-character** limit. Long question bodies retain a bounded head and tail plus the query-intent suffix; the full original question remains in the bundle. Ranking combines reciprocal ranks across queries, deduplicates normalized URLs, and balances query coverage and actual URL hosts. Host diversity is **not** proof of independent publishers or authoritative evidence.
- Normal/deep reserve part of the fetch budget for later selection. One optional follow-up round addresses insufficient sources/hosts, queries with no usable results, failed initial fetches, or missing dataset metadata. Already attempted pages remain in the final bundle and are not fetched again. This is bounded heuristic iteration, **not** autonomous semantic contradiction detection or an exhaustive research agent. No extra model calls are made.
- Retrieved text is capped at **20,000 characters per page**, with up to four lexically relevant located windows instead of only a page prefix. Source records retain the retrieved text, SHA-256, retrieval time, truncation flag, and exact UTF-16 character offsets/line ranges. Locations refer to the stored broker text, not original HTML. Important evidence beyond the retrieval cap can still be missed.
- Data profiles separate supporting quotations from heuristic conclusions. The collector always leaves `authRequired: "unknown"` (unverified) and returns the original authentication quotations, including negation and line-wrapped qualifiers, rather than guessing a global yes/no requirement from prose. Bearer-token/password/OAuth mentions are collected as evidence too. Follow-up searches seek missing quotations, not automatic authentication verification. License/freshness mentions do not establish permission, endpoint usability, or a guaranteed update cadence. Snippet-derived profiles are explicitly labeled.

## Outcome semantics

- `complete`: planned collection requests completed without recorded search/fetch failures; **not** a guarantee of factual completeness, authority, or corroboration. Zero-fetch discovery can complete with snippet-only warnings.
- `partial`: usable sources exist, but some search/fetch requests failed. Gaps remain visible.
- `empty`: successful searches found no usable sources.
- `failed`: no usable sources and at least one search failed. The tool saves diagnostics, then **throws**, allowing Pi to persist native `isError: true`; `/research` does not start synthesis.

Every bundle records individual search outcomes, durations, safe endpoint labels, fetch failures, follow-up reasons, and gaps. Standard MCP tool errors and empty/malformed MCP result envelopes are not fetched evidence. Provider retry strategy and destination-network/access enforcement remain broker responsibilities.

## Output

The extension saves bundles in unique private directories under `~/.pi/research/` (directory mode `0700`, files `0600`). Concurrent identical questions cannot overwrite each other. The LLM tool always saves; `/research --no-save` does not. No automatic retention/deletion policy is applied.

- `sources.json`: complete bounded evidence, located passages, retrieved text, metadata quotations and request diagnostics.
- `excerpts.md`: selected source evidence, status and gaps (bounded to 60,000 characters).
- `prompt.md`: synthesis guidance with an explicit untrusted-evidence boundary, citation instructions and the trusted output path.
- `report.md`: written only when Pi has file tools and follows the generated synthesis instruction; not created by the collector itself.

The tool returns a bounded 24,000-character evidence view with paths to fuller evidence. `/research` prompts synthesis unless `--no-synthesize` is set. Neither path treats source instructions as authority; consumers must distinguish fetched passages from snippets and examine uncertainty/conflicts.

## Verification

From the `pi-shared` root:

```sh
npm run test:research
npm run test:websearch
```

The dedicated research suite covers input limits, CLI parity, ranking/diversity, failure states, concurrency, cancellation, bounded follow-up, passage provenance, metadata uncertainty and collision-free storage. Installed-SDK and loopback-MCP integration tests verify real tool error finalization, broker credential handling and the command/tool paths without external providers or model calls. Both suites are included in `npm test`.

## Examples

```text
/research best local-first smart home architectures for Mac mini hubs
/research --data residential electricity price datasets by ZIP code
/research --sources SwitchBot BLE protocol documentation
/research --data --depth deep --max-sources 24 open smart-home energy benchmark datasets
```
