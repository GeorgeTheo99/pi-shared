# Guided capability setup

User-invoked `/setup` opens an optional-capability menu. Direct subcommands and tab completion are available for every entry. This is a TUI-only setup hub, not an LLM-callable installer, automatic repair tool, or second settings manager.

## Capabilities

| Command | Guided flow | What can change here |
| --- | --- | --- |
| `/setup search` | Local Brave search (private key-file path), existing compatible endpoint, or owning guided setup | Prepares a terminal command; the owning installer displays its full plan and asks for approval |
| `/setup browser` | Public browser-worker provisioning **or** separate private-app browser dependencies | Terminal handoff, never browser actions or automatic service restarts |
| `/setup mcp` | Profile-scoped adapter installation and existing `/mcp setup` onboarding | Terminal install handoff; slash command can be placed in the editor, never auto-submitted |
| `/setup development` | TypeScript/JavaScript intelligence or an explicitly entered verification command, argv and source paths | Exact-plan approval creates a **missing** project config; never executes checks, overwrites files, or grants trust |
| `/setup documents` | LibreOffice and Poppler prerequisites for PowerPoint/document previews | Dependency checks and explicit installation commands, not a renderer smoke test |
| `/setup apple` | Full Xcode, selected developer directory and simulator prerequisites | Explicit prerequisite probes only; no builds, simulator boots, signing, uploads or license acceptance |
| `/setup knowledge` | Initialize a private metadata layout or prepare local-book indexing | Approval creates a new external layout; indexing is a separate terminal handoff, with no downloads or uploads |
| `/setup models` | Native `/login` and `/model`, guided connections, local gateway or oMLX guidance | Existing provider/setup flows; never reads credentials, calls inference or downloads model weights |
| `/setup diagnostics` | Static-first environment diagnostics using the existing doctor | Explicit read-only check; no imports, installs or automatic repairs |
| `/setup peekaboo` | Compatible Peekaboo installation/configuration and CLI/permission checks | Existing exact-plan installation/configuration approval; OS permissions remain manual |

Each report distinguishes **not installed**, **needs configuration**, **configured but untested**, **verified for a specific check**, or **unknown**. File/dependency presence does not establish working authentication, current-session activation, or end-to-end readiness. A registered MCP tool is reported separately from installed package declarations and tested connections.

## Ownership and prerequisites

- `pi-setup` owns provisioning, configuration writes, and the versioned JSON backend. New entries call `pi-shared capability <id> plan|apply|check`; Peekaboo keeps `pi-shared peekaboo plan|status|apply|check`. The new capability entries require owning CLI/Homebrew **0.1.22+** (Peekaboo alone needs 0.1.21+). An old CLI returns an upgrade instruction; the extension never silently updates or guesses a fallback command. See the [capability backend contract](https://github.com/GeorgeTheo99/pi-setup/blob/main/docs/capabilities.md).
- Search/browser/model service changes remain owned by the existing `pi-shared setup` flow. These can affect **all saved selections**, profiles and shared services. The hub shows a command to run in a separate terminal rather than hiding those effects inside a narrow approval. No `--yes` is added.
- Terminal handoffs are displayed, not executed or submitted through Pi's captured `!` shell: interactive setup needs a real terminal. Dependency-install and indexing commands may mutate immediately when the user runs them. Review their displayed scope first.
- Pi-command handoffs ask before replacing an editor draft and never submit it. Existing commands such as `/login`, `/model`, `/mcp setup` and `/verification-trust` retain their own interaction/approval behavior.
- Installer discovery uses `/opt/homebrew/bin/pi-shared`, then `/usr/local/bin/pi-shared`. A trusted source/test installation can explicitly set an absolute `PI_SHARED_SETUP_BIN`. The extension resolves package symlinks and checks file/ancestor ownership and writability; it never searches cwd or PATH. On macOS, the standard admin-group-writable Homebrew prefix/Cellar is accepted only for this exact package layout and an admin-group caller. Non-sticky world-writable directories, arbitrary group-writable checkouts, and writable executables remain refused. This follows Homebrew's trust in other local admin-group members who can replace content in its shared directories.
- Headless/RPC callers receive CLI guidance without execution. `pi-shared setup --plan` is an offline general preview; `pi-shared capability --help` describes explicit context arguments for individual previews.

## Configuration and privacy

Project development setup requires Pi project trust before collecting options and rechecks it before applying. The backend previews exact proposed bytes and refuses existing targets or changed plans. Code intelligence uses installed, locked shared-module dependencies and an absolute Node executable. Verification accepts an explicit argv array and existing project-relative input paths; it creates an **exit-code check**, not a test-discovery claim. `/verification-trust` remains a separate user action bound to the config digest. No package scripts are inferred or executed.

Knowledge setup keeps the complete layout outside managed installations. It copies public catalog/mapping/source-card metadata into a new private root, never bundled PDFs or extracted texts. Existing layouts are not overwritten. Users can place their own books in the local corpus and run the separately displayed ingestion command. A custom root requires matching `PI_SOFTWARE_KB_ROOT` configuration and reload. Metadata presence is not a successfully indexed collection. See [private storage and ingestion](../../knowledge/software-engineering/README.md).

Search prompts request a **private file path**, never an API-key value. Credentialed/query-token URLs are rejected. Reports and diagnostics do not dump credential files. Setup UI text and terminal history still merit normal privacy care; do not paste secrets into path fields.

## Peekaboo flow

1. Read a static plan: selected binary, configuration status, proposed actions, warnings and manual next steps. Planning does not launch Peekaboo, install software, capture the desktop or request OS permissions.
2. Choose an existing executable, preview an explicit compatibility installation, configure MCP, or run a separate CLI/permission check.
3. Installation/configuration requires confirmation of that exact plan. The backend receives `--yes --expected-plan <digest>` and rejects stale configuration. Canceling any choice ends the workflow; it never chooses a default on the user's behalf.
4. Show installation/configuration separately from executable, MCP and permission evidence. Desktop interaction always remains **not tested** by this wizard.
5. After configuration, reload/restart Pi to load the changed MCP registry, then verify permissions from the actual adapter. Setup-process permission evidence does not establish the later Pi process's TCC identity.

Peekaboo uses the existing MCP adapter; `/setup mcp` provides its separate onboarding handoff. The full Peekaboo catalog is configured, including foreground-capable operations. There is no custom tool allowlist/denylist or per-tool approval policy. Tool availability is not authorization for sensitive/external actions; existing user/global policies still apply.

The 4.5.0 compatibility install is explicitly labeled and warned, not represented as the newest or fully certified build. See the [skill setup reference](../../skills/macos-computer-use/references/setup.md) for the 4.6.0 CLI startup defect, older-version input-safety limitations and permission boundaries. No silent downgrade, app-Bridge fallback, TCC modification, provider credential copying, or system-library patching is performed.

## Lifecycle and limits

Only one wizard can run in a Pi session. It refuses to start while the agent is busy. Each backend command has a bounded lifetime/output and uses the shared managed-process runner; Esc and session shutdown request cancellation, and the progress dialog waits for bounded process-group cleanup. Cancellation may leave completed installation/configuration changes; it is not rollback and does not trigger an automatic retry. Escaped descendants and hard runtime crashes are outside the original process-group cleanup guarantee.

Reports are capped at 64 KiB and validated for exact component/action/schema identity, bounded fields, known evidence states, and matching process exit status. Backend text is treated as evidence, not agent instructions or terminal controls. Plans do not automatically run checks. Check results are scoped to named probes, not a blanket readiness verdict.

The backend owns configuration locking and stale-plan checks. The wizard is not a cross-session desktop lock, sandbox, semantic permission engine or artifact-retention service. It does not execute screenshots, clicks, typing, browser rendering or provider inference as a setup test.

## Tests

`npm run test:setup` covers all menu entries, completions, input/cancellation/trust gates, exact approval, safe handoffs, protocol validation, installer resolution, bounded subprocess output and shutdown cleanup. `tests/fixtures/setup_sdk_smoke.mjs` accepts an installed Pi SDK bundle path and verifies the real extension loader/SDK with a disposable offline backend. Backend behavior has separate tests in `pi-setup`. Passing setup checks does not certify end-to-end capabilities.
