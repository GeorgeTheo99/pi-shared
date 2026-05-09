# Deep Research

Shared pi extension for local/private SearXNG-backed research.

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

## SearXNG configuration

No public SearXNG instance is used implicitly. Resolution order:

1. `SEARXNG_BASE_URL`
2. `SEARXNG_URL`
3. `PI_SEARXNG_BASE_URL`
4. `PI_RESEARCH_SEARXNG_URL`
5. `~/.pi/research/config.json`
6. local-only defaults if reachable:
   - `http://127.0.0.1:8888`
   - `http://localhost:8888`

Config file example:

```json
{
  "searxngBaseUrl": "http://127.0.0.1:8888"
}
```

## Output

The extension gathers sources, fetches excerpts, saves a bundle under `~/.pi/research/`, then prompts pi to synthesize a cited answer. Bundles include:

- `sources.json`
- `excerpts.md`
- `prompt.md`
- `report.md` when pi has file tools and follows the generated instruction

## Examples

```text
/research best local-first smart home architectures for Mac mini hubs
/research --data residential electricity price datasets by ZIP code
/research --sources SwitchBot BLE protocol documentation
/research --data --depth deep --max-sources 24 open smart-home energy benchmark datasets
```
