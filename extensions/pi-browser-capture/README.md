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
The worker and token are **not provisioned by pi-setup**. Obtain an endpoint/token
from the browser-worker service operator. At startup an authenticated, read-only
`tools/list` check must identify exactly these two browser tools; otherwise they
remain disabled and Pi reports an actionable warning. `app_*` is unaffected.
After configuring the worker, check it and restart Pi or run `/reload`:

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
Omitting the setting, or setting it to `true`, preserves the generic default. URLs must be canonical,
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

## Reproducible isolated app tests

`src/app-test.ts` adds one private router, `app_test`. The persistent/authenticated
`app_*` tools above remain the default and are unchanged. `app_test` never reads,
copies, or writes `BROWSER_MCP_APP_PROFILE_DIR`, storage state, or credentials.
It uses installed Playwright Chromium; existing persistent tools still use Patchright.

Actions:

- `create` — fresh session-owned context/browser, `device: "desktop"` (1440×1000)
  or `"mobile"` (iPhone 13 touch/mobile emulation at 390×844, pixel ratio 1).
- `configure` — resize with `width`/`height` (240–1920). Device emulation is fixed
  at creation: create a new context to change desktop/mobile.
- `snapshot` — bounded ARIA snapshot of the body, depth 20; not an accessibility
  compliance audit and not a DOM dump.
- `run` — 1–30 explicit `steps`. Each step has `action`, optional `selector`,
  `value`, and `timeoutMs`. Actions: `goto`, `click`, `fill`, `press`,
  `wait_visible`, `assert_visible`, `assert_text`, `assert_url`.
  Text/URL assertions use exact equality. Use explicit `wait_visible` for readiness.
  The entire sequence is validated before execution; execution stops at the first
  failure and reports its 1-based step, skipped count, and failure artifacts.
  There is no wrapper retry, mutation replay, forced click, or selector repair.
  Playwright's normal pre-action actionability waiting remains enabled.
- `trace_start` / `trace_stop` — opt-in screenshot/DOM/network trace; sources off.
  Explicit trace stop returns a ZIP path; a timer also requests stop after 60s.
- `close` — close browser/proxy and delete context artifacts, including trace
  staging files. Session switch/fork/shutdown also closes contexts. Context IDs
  are bound to the exact Pi session, not accepted from another session/runtime.

Example calls (use the returned context ID, never a persistent app tab ID):

```json
{"action":"create","device":"mobile"}
{"action":"run","contextId":"<returned-id>","steps":[{"action":"goto","value":"/"},{"action":"wait_visible","selector":"h1"},{"action":"assert_text","selector":"h1","value":"My app"}]}
{"action":"snapshot","contextId":"<returned-id>"}
{"action":"close","contextId":"<returned-id>"}
```

### Target and artifact boundaries

The runner honors `BROWSER_MCP_APP_BASE_URL` (default `http://127.0.0.1:8100`)
and `BROWSER_MCP_APP_ALLOWED_HOSTS`, including `*.subdomain` rules. An explicitly
empty base URL disables the default target; absolute URLs then require allowed hosts.
It rejects credentialed and non-HTTP(S) explicit URLs. A per-context loopback proxy
checks every HTTP request and HTTPS CONNECT destination, including browser redirects
and subresources: Playwright routing alone only intercepts the first URL of a redirect
chain. TLS is not intercepted; normal certificate validation remains enabled.
HTTP forwarding does not replay/retry requests or copy authentication state.
This is a hostname policy for trusted local/private apps, not a DNS/IP firewall,
untrusted-code sandbox, or public-worker bypass. Allowed hostnames permit any port;
DNS rebinding and arbitrary non-HTTP browser facilities are not a hardened sandbox.
WebSockets, service workers, downloads, and extra tabs are unsupported. The runner
closes popups; any initial popup network requests still pass through the target policy.
Headless mode and the documented presets are fixed for reproducibility; persistent
app browser executable, user-agent, timeout, and HTTPS-error overrides are not inherited.

Private files live in generated 0700 runtime/context directories under
`BROWSER_MCP_APP_ARTIFACT_DIR/app-test` (otherwise the existing storage root's
`artifacts/app/app-test`). Exported files are 0600; callers cannot set artifact paths.
Failure evidence includes a viewport-only PNG and bounded console/network JSON tails.
Network tails omit headers/bodies and strip URL queries/fragments. Console text,
screenshots, page content, and opt-in traces **can contain secrets** from the app;
private filesystem permissions are not redaction or protection from other same-user
processes. Do not upload evidence without reviewing it.

| Limit | Value |
| --- | --- |
| Contexts per runtime / context lifetime | 4 / 15 minutes |
| Steps per run / run execution deadline | 30 / 60 seconds |
| Per-step timeout | 1–10,000 ms (default 10,000) |
| Console/network tails | 100 entries each, 512 characters per entry |
| Snapshot output | 16,000 characters, truncated flag |
| Failure screenshot | Viewport only, retained only if ≤2 MiB |
| Trace starts / stop timer | 5 per context / 60 seconds per recording |
| Trace export | Retained only if ≤16 MiB |
| Retained exports per context | 20 files / 32 MiB |

These are **retention/output limits, not hard disk or browser memory quotas**.
Playwright buffers snapshots/screenshots and writes raw trace staging data before
export checks; staging remains private until context close. A trace ZIP can exceed
its limit while being written and is then deleted. Trace stop/export and browser
cleanup are asynchronous; timers/deadlines are best effort under event-loop or
browser stalls. Failure capture can add up to its 3-second screenshot timeout after
the run deadline. Context expiry starts after creation. Artifacts disappear on normal
close/expiry/session cleanup; copy needed evidence beforehand. Crashes/forced kills
can leave private directories: there is no crash-proof janitor or cross-run quota.

### Verification

From the repository root (browser dependencies and Chromium must already be installed):

```bash
node --no-warnings --test tests/app_test_runtime.test.mts tests/browser_tool_inventory.test.mts
node --no-warnings --experimental-loader ./tests/fixtures/app_test_loader.mjs --test tests/app_test_tool.test.mts
```

The runtime suite uses only local fixture servers and real Chromium, including a
real 60-second automatic trace-stop check. `npm run test:app-test` runs both suites
and is included in root `npm test`; these commands do not activate a Pi profile.

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
