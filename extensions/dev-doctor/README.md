# Environment doctor

`bin/pi-doctor` and `dev_doctor` aggregate evidence; **neither returns a readiness
verdict**. The tool is a sequential, abortable wrapper around the CLI, plus a read-only current-runtime MCP inventory.
Disable this extension independently through Pi's normal resource configuration.
Nothing needs to be installed or reloaded merely to use the CLI.

## Defaults and opt-ins

```sh
bin/pi-doctor                         # static inspection only
bin/pi-doctor --json                  # versioned structured report
bin/pi-doctor --agent-dir ~/.pi-omlx/agent
bin/pi-doctor --probe-deps            # resolve modules / inspect declared bin-only files
bin/pi-doctor --probe-browser         # authenticated loopback tools/list only
bin/pi-doctor --probe-imports          # execute trusted extension initializers
bin/pi-doctor --timeout 5             # hard deadline per checker (maximum 60s)
```

Tool parameters: `agentDir`, `probeDeps`, `probeBrowser`, `probeImports`,
`timeoutSeconds`. All probes default to false. The CLI uses
`PI_CODING_AGENT_DIR` or `~/.pi/agent`; the tool uses Pi's current agent directory.
CLI `--extensions-dir DIR` (repeatable) overrides the default dependency scope
of this checkout's `extensions/`. It does not discover or execute project commands.

The existing `pi-profile-check`, `pi-browser-check`, and `pi-shared-check-deps`
accept `--json` and `--static`. Without those flags they retain their human CLI
and exit conventions (profile/dependencies: 0/1; optional browser: 0/2).
**Their existing defaults still execute their checks.** Only the doctor defaults
to static inspection. No human checker messages are parsed by the doctor.

| Evidence | Meaning / limit |
|---|---|
| `available` | Executable found on PATH; not executed or version-verified |
| `inspected` | Profile JSON shape inspected; not full Pi settings validation |
| `not_checked` | No execution evidence; unknown must not become success |
| `not_exercised` | Model declarations counted; no auth, reachability, or inference checks |
| `resolved` | Locked modules resolve, or bin-only packages have readable in-package declared executables; nothing imported/executed |
| `imported` | `imported_count` registered in a disposable offline SDK loader; not this session |
| `no_extensions_imported` | Loader returned no extensions; not positive load evidence |
| `inventory_verified` | Authenticated inventory has exactly `browser_fetch` and `browser_inspect`; browser execution **not tested** |
| `disabled` | Optional worker explicitly unselected in `~/.pi/research/config.json` |
| Failures | `missing`, `invalid_config`, `missing_token`, `missing_dependency`, `auth_failed`, `http_error`, `unavailable`, `timeout`, `output_limit`, `import_failed`, `invalid_report`, `spawn_error`, `canceled` stay distinct |

Reports have `schema_version: 1`, a bounded `capabilities` array, and per-capability
`installed`, `loaded`, `active`, `configured` (`yes|no|unknown`), `verified_at`,
`probe_type`, `outcome`, and repair `guidance`. Capability probe outcomes and
`checker_exit_code` are separate. Top-level `inspection_complete` means only that
no issue was detected in the requested inspection; **not** that unknown or
unexercised capabilities are healthy. `issues_found` gives exit 1. Browser service
installation/load/activation cannot be inferred from authenticated inventory.

## MCP connection visibility

Run `/mcp-connections` inside Pi for a quick inventory, or call `dev_doctor` to
include it with environment diagnostics. No new model-callable tool is added.

- **Adapter-managed:** the last bounded `pi-mcp-adapter/status/v1` event reports
  server names, statuses and tool counts. This uses the adapter's public event
  contract, not its config files/private code, and never requests a connection.
  Absent/unsupported/malformed reports stay unknown; `cached` is not an outage
  or a reachability test. At most 50 servers are displayed, with truncation noted.
- **Extension-managed:** the browser, search and deep-research wrappers are shown
  separately because they call their MCP backends directly and do not appear in
  `/mcp`. Tool names are matched to this checkout's canonical extension source
  paths. Registered and active tools are reported separately; neither proves
  the service is installed or working. `app_*` is explicitly not MCP.
- The section is always scoped to the **current Pi runtime**, even when
  `agentDir` selects another profile for static/import checks. The CLI runs
  outside Pi and cannot observe this section. No URLs, commands, credentials,
  arbitrary event fields or source paths are included in the MCP report.
- Adapter events are same-process advisory evidence, not authentication or a
  security boundary. Server names are bounded printable identifiers; invalid
  snapshots discard previous observations. No snapshots are persisted.

For actual checks, explicitly run `pi-browser-check` (authenticated inventory,
not browser execution) and `local-search verify` (standalone search health and
inventory, not a paid provider search). Keep the existing native wrappers;
do not create duplicate adapter registrations merely for visibility.

## Safety and limits

- No automatic repair, install, profile writes, model calls, browser actions,
  authentication commands, credential dumps, or uploads. Static mode does not read
  `auth.json` or token contents. Models output only counts, never provider/model
  names, endpoints, headers, API keys, or credential command values.
- Import probes execute trusted code with full user permissions and may have
  initializer side effects. This is **not a sandbox**. The offline SDK loader
  disables package installation/update and ignores project configuration; extensions
  themselves can still perform I/O. Review them before opting in. Loader results
  do not prove every configured package loaded: Pi may skip unavailable offline
  packages. `imported_count` states only what this probe observed.
- Browser selection always uses `~/.pi/research/config.json`, independently of the
  chosen profile. Static token-file presence is not valid credentials. The network
  probe reads a bounded token and contacts only the checker's strictly validated
  loopback endpoint, with no redirects or proxies; it never opens a browser.
- Each checker has its own hard deadline (default 10s; maximum 60s); three checkers
  run serially. The wrapper also has an overall deadline and bounded capture.
  Process pipes and JSON/configuration reads are capped at 256 KiB; tool reports
  from the CLI at 32 KiB, plus the bounded current-runtime MCP section; token reads at 16 KiB. Dependency scans cap at 512 declarations / 4096
  manifests. Missing, malformed, oversized, timed-out, and failed reports are not
  treated as completed verification. Raw subprocess stdout/stderr and import error
  strings are not included in structured output or retained as log artifacts.
- On timeout/cancellation, owned POSIX process groups receive termination and
  in-group nested probes are cleaned up. Cancellation does not start remaining
  probes. Escaped descendants are outside this guarantee; no confirmed-cleanup
  or OS-sandbox claim is made. This CLI targets the repository's POSIX environment.

## Tests

```sh
pytest tests/test_pi_doctor.py tests/test_pi_profile_check.py tests/test_pi_browser_check.py tests/test_pi_shared_install_deps.py -q
node --no-warnings --experimental-loader ./tests/fixtures/dev_doctor_test_loader.mjs --test tests/dev_doctor.test.mts
# Optional offline smoke against an explicitly selected installed Pi SDK:
node tests/fixtures/mcp_inventory_sdk_smoke.mjs /path/to/installed/pi-sdk-entry.js
```

Fixtures use temporary profiles, fake loopback services, deliberately broken SDKs,
and real Node resolution/imports where available. They never call real models,
install dependencies, change live profiles, or reload an active session.
