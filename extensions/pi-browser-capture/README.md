# Pi Browser Capture

Shared Playwright extension for actual public web browsing, local/private web app testing, screenshots, PDF export, console/network inspection, tab management, and visible-text extraction.

## Browser tools

Prefer `browser_*` for actual interaction with public web pages:

- `browser_open`
- `browser_navigate`
- `browser_open_tab`
- `browser_list_tabs`
- `browser_switch_tab`
- `browser_close_tab`
- `browser_click`
- `browser_type`
- `browser_wait_for`
- `browser_extract_text`
- `browser_screenshot`
- `browser_export_pdf`
- `browser_console_logs`
- `browser_page_state`
- `browser_close`

## App testing tools

Use `app_*` for local/private web app testing:

- `app_open`
- `app_open_tab`
- `app_list_tabs`
- `app_switch_tab`
- `app_close_tab`
- `app_click`
- `app_type_text`
- `app_wait_for`
- `app_extract_text`
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

- Use `browser_*` for actual browser interaction with public web pages.
- Use `web_search` / `web_fetch` for informational research and current-facts lookup.
- Use `app_*` for local/private app UI and API testing.

## Safety and private hosts

`browser_*` blocks private hosts by default, including `localhost`, `.local`, `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, and private IPv6 ranges.

If a machine intentionally needs browser tools to access private hosts, set:

```bash
export BROWSER_MCP_WEB_ALLOW_PRIVATE_HOSTS=true
```

Prefer `app_*` tools for local app testing instead of enabling private-host access for general browsing.

## Setup on a new machine

```bash
cd ~/local_code/pi-shared/extensions/pi-browser-capture
npm install
npx playwright install chromium
```

## Environment variables

Shared:

- `BROWSER_MCP_HEADLESS` — default `true`
- `BROWSER_MCP_STORAGE_ROOT` — browser/app storage root
- `BROWSER_MCP_DEFAULT_TIMEOUT_MS` — default `15000`
- `BROWSER_MCP_VIEWPORT_WIDTH` — default `1440`
- `BROWSER_MCP_VIEWPORT_HEIGHT` — browser default `900`, app default `1000`
- `BROWSER_MCP_IGNORE_HTTPS_ERRORS` — default `false`
- `BROWSER_MCP_BROWSER_CHANNEL` — optional Chromium channel
- `BROWSER_MCP_BROWSER_EXECUTABLE_PATH` — optional browser executable path
- `BROWSER_MCP_USER_AGENT` — optional user agent
- `BROWSER_MCP_CONSOLE_LOG_LIMIT` — default `200`

Browser-specific:

- `BROWSER_MCP_WEB_PROFILE_DIR` — public-browser profile directory
- `BROWSER_MCP_WEB_ARTIFACT_DIR` — screenshots/PDF output directory, default `~/.pi/browser-capture`
- `BROWSER_MCP_WEB_ALLOW_PRIVATE_HOSTS` — default `false`

App-specific:

- `BROWSER_MCP_APP_BASE_URL` — default `http://127.0.0.1:8100`
- `BROWSER_MCP_APP_ALLOWED_HOSTS` — comma-separated allowed hosts for absolute app URLs
- `BROWSER_MCP_APP_PROFILE_DIR` — app browser profile directory
- `BROWSER_MCP_APP_ARTIFACT_DIR` — app screenshot output directory
- `BROWSER_MCP_NETWORK_LOG_LIMIT` — default `400`
