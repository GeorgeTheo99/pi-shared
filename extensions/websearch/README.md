# Web Search

Shared pi extension that provides `web_search` and `web_fetch`.

- `web_search` calls a local/private SearXNG JSON API.
- `web_fetch` fetches a URL directly and returns extracted text.

## SearXNG requirement

This extension does **not** install or run SearXNG. Each machine that loads `pi-shared` must have a reachable SearXNG instance with JSON output enabled.

Minimum requirements:

- SearXNG reachable from the Pi process.
- `/search?...&format=json` returns JSON.
- Recommended local URL: `http://127.0.0.1:8888`.
- SearXNG `settings.yml` includes JSON in `search.formats`:

```yaml
search:
  formats:
    - html
    - json

server:
  bind_address: "127.0.0.1"
  port: 8888
  limiter: false
```

Use `bind_address: "0.0.0.0"` only if the machine/network is intentionally exposing SearXNG and access is protected.

## SearXNG URL resolution

The tool checks, in order:

1. `SEARXNG_BASE_URL`
2. `SEARXNG_URL`
3. `PI_SEARXNG_BASE_URL`
4. `PI_RESEARCH_SEARXNG_URL`
5. `~/.pi/research/config.json`
6. local defaults:
   - `http://127.0.0.1:8888`
   - `http://localhost:8888`

Config file example:

```json
{
  "searxngBaseUrl": "http://127.0.0.1:8888"
}
```

## Verification

Run this on the target machine:

```bash
curl -fsS 'http://127.0.0.1:8888/search?q=pi%20searxng%20health%20check&format=json' | python3 -m json.tool >/dev/null
```

Then restart Pi or run:

```text
/reload
```
