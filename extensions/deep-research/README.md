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

Direct SearXNG is not used by this client. The local-search MCP broker is the required entry point and owns backend strategy, including local/private SearXNG and provider fallback.

Resolution order:

1. `PI_WEBSEARCH_MCP_URL`
2. `SEARCH_MCP_URL`
3. `WEBSEARCH_MCP_URL`
4. `~/.pi/research/config.json`
5. local-only defaults if reachable:
   - `http://127.0.0.1:8889/mcp`
   - `http://localhost:8889/mcp`

Config file example:

```json
{
  "websearchMcpUrl": "http://127.0.0.1:8889/mcp"
}
```

`mcpUrl` is also accepted for compatibility with other local-search clients.

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
