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

Direct SearXNG is not used by this client. The local-search MCP broker is the required entry point and owns backend strategy, including loopback/self-hosted SearXNG and policy-controlled provider fallback or supplementation.

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

Broker authentication and Tavily forwarding are separate:

- Broker token (`Authorization: Bearer ...`): `PI_WEBSEARCH_MCP_API_KEY`, then `SEARCH_MCP_API_KEY`.
- Tavily key (`X-Tavily-Key`): `PI_WEBSEARCH_TAVILY_API_KEY`, then `TAVILY_API_KEY`.

A Tavily key is forwarded only for broker `web_search` calls on loopback; page-fetch calls never receive it. Broker authentication may be sent to loopback HTTP or any HTTPS endpoint; no credentials are sent to non-loopback plain HTTP. MCP redirects and embedded URL credentials are rejected, and sensitive endpoint query parameters are redacted from diagnostics.

Cancellation of the LLM-callable `deep_research` tool propagates through endpoint resolution, parallel searches, and fetch fan-out instead of being converted into empty results or fetch failures. The `/research` command retains its existing no-signal behavior. Shared MCP transport behavior is covered by `npm run test:websearch` from the `pi-shared` root.

## Output

The extension gathers sources, fetches excerpts through the broker, saves a bundle under `~/.pi/research/`, then prompts Pi to synthesize a cited answer. Bundles include:

- `sources.json`
- `excerpts.md`
- `prompt.md`
- `report.md` when Pi has file tools and follows the generated instruction

## Examples

```text
/research best local-first smart home architectures for Mac mini hubs
/research --data residential electricity price datasets by ZIP code
/research --sources SwitchBot BLE protocol documentation
/research --data --depth deep --max-sources 24 open smart-home energy benchmark datasets
```
