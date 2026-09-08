# Pi Browser Capture

Shared Pi package entrypoints for the standalone public browser worker and the unchanged in-process local/private app-testing runtime.

## Public browser tools

The production public-browser inventory is exactly:

- `browser_fetch` — render one public page in an isolated one-shot browser and return visible text, optional links, or an owner-bound screenshot handle.
- `browser_inspect` — create and operate a short-lived caller-owned browser session through one explicit action.

The retired granular public-browser entrypoint (`src/index.ts`) remains in source only for whole-revision rollback and is not loaded. It must never be loaded at the same time as `src/browser-worker.ts`.

Browser-worker defaults:

```bash
BROWSER_WORKER_MCP_URL=http://127.0.0.1:8890/mcp
BROWSER_WORKER_MCP_TOKEN_FILE=~/srv/browser-worker/shared/tokens/pi-production
```

The token value is read from the owner-only file for each call and is never stored in Pi settings.
The recommended `browser-worker` module in pi-setup provisions a local browser,
service and distinct owner-only `pi-production` token automatically. No external
API key is required, and credentials are never copied from another machine.
At startup an authenticated, read-only `tools/list` check must identify exactly
these two browser tools; otherwise they remain disabled and Pi reports an
actionable warning. `app_*` is unaffected. After setup, check the worker and
restart Pi or run `/reload`:

```bash
python3 ~/local_code/pi-shared/bin/pi-browser-check
```

Exit `0` with `READY:` means authenticated inventory is ready (not a browser-execution test).
Exit `2` with `WARN:` means a selected optional capability is unavailable.

Distributions that select a separate web-research backend can explicitly set
`"browserWorkerEnabled": false` in `~/.pi/research/config.json`. Then these two
standalone browser tools are not loaded or probed, there is no unconfigured-worker
startup warning, and the checker reports `DISABLED:` (exit `0`), not `READY:`.
This does not disable `web_search`/`web_fetch` or `app_*`, and does not imply that
the alternative backend supports screenshots or interactive browser sessions.
Omitting the setting, or setting it to `true`, preserves the generic default.

The installer persists `browserWorkerMcpUrl` and `browserWorkerTokenFile` alongside
that selection so custom ports/data directories work in a new shell. Environment
variables shown above take precedence over these file values. The token **value**
is only in the service's private token file. Research routing keys
(`websearchMcpUrl`, `mcpUrl`) are independent and are not changed by worker setup. URLs must be canonical,
uncredentialed loopback HTTP `/mcp` endpoints with an explicit port; proxies and
redirects are not used. The Databricks websearch-shim uses port `8891` and is **not**
a substitute browser backend.

## App testing tools

`app_*` remains loaded from the existing `src/app-testing.ts` entrypoint for local/private app testing:

- `app_open`
- `app_open_tab`
- `app_list_tabs`
- `app_switch_tab`
- `app_close_tab`
- `app_click`
- `app_type_text`
- `app_wait_for`
- `app_extract_text`
- `app_evaluate`
- `app_screenshot`
- `app_console_logs`
- `app_network_log`
- `app_api_request`
- `app_page_state`

Default app target: `http://127.0.0.1:8100`.

Configure with:

```bash
export BROWSER_MCP_APP_BASE_URL='http://127.0.0.1:8100'
# Optional comma-separated host allowlist for absolute app URLs:
export BROWSER_MCP_APP_ALLOWED_HOSTS='127.0.0.1,localhost,dev.internal'
```

## Intended use

- Use `browser_fetch` / `browser_inspect` for actual interaction with public web pages.
- Use `web_search` / `web_fetch` for informational research and current-facts lookup. Their configured backend is independent: generic Pi defaults to `local_web_search`; the Databricks overlay selects its own shim.
- Use `app_*` for local/private app UI and API testing.
- Use the privileged `browser_inspect` actions only when the authenticated caller has the matching server-side capability.

## Safety boundary

Browser-worker authenticates every MCP call, binds sessions/artifacts to the caller, and enforces public-network-only browser egress. Callers do not control profile or artifact paths. Do not add a compatibility shim, a fallback through `local_web_search`, or a dual-registration window with the retired public browser family.

## Local app setup

```bash
cd ~/local_code/pi-shared/extensions/pi-browser-capture
npm ci --ignore-scripts
npx playwright install chromium
```

The Playwright/Patchright dependencies above are for the separate `app_*` runtime. Public browser execution belongs to the standalone browser-worker service.

## App environment variables

- `BROWSER_MCP_APP_BASE_URL` — default `http://127.0.0.1:8100`
- `BROWSER_MCP_APP_ALLOWED_HOSTS` — comma-separated allowed hosts for absolute app URLs
- `BROWSER_MCP_APP_PROFILE_DIR` — app browser profile directory
- `BROWSER_MCP_APP_ARTIFACT_DIR` — app screenshot output directory
- `BROWSER_MCP_NETWORK_LOG_LIMIT` — default `400`
- `BROWSER_MCP_HEADLESS` — app runtime default `true`
- `BROWSER_MCP_DEFAULT_TIMEOUT_MS` — default `15000`
- `BROWSER_MCP_VIEWPORT_WIDTH` — default `1440`
- `BROWSER_MCP_VIEWPORT_HEIGHT` — app default `1000`
