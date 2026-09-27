# Guided capability setup

User-invoked `/setup` opens an optional-capability menu. `/setup peekaboo` goes directly to Mac computer-use setup. This first version supports only Peekaboo; it is not a generic installer or an LLM-callable tool.

## Ownership and prerequisites

- `pi-setup` owns `pi-shared peekaboo plan|status|apply|check` and the version-1 JSON contract. The extension only presents that backend's plan, approval, and evidence. The initial check probes CLI startup and permissions, not MCP connectivity.
- Requires an owning CLI release that implements that contract. An older CLI produces an upgrade instruction, not an automatic update, guessed install command, or fallback to another program.
- Installer discovery uses `/opt/homebrew/bin/pi-shared`, then `/usr/local/bin/pi-shared`. A trusted source/test installation can explicitly set an absolute `PI_SHARED_SETUP_BIN`. The extension resolves package symlinks and checks file/ancestor ownership and writability; it never searches cwd or PATH.
- Pi's existing MCP adapter is a separate prerequisite. This wizard does not install it or register duplicate native computer-use tools.
- TUI-only. Headless/RPC callers receive CLI preview guidance without execution. Use `pi-shared peekaboo plan --json` for a terminal preview.

## Flow

1. Read a static plan: selected binary, configuration status, proposed actions, warnings and manual next steps. Planning does not launch Peekaboo, install software, capture the desktop or request OS permissions.
2. Choose an existing executable, preview an explicit compatibility installation, configure MCP, or run a separate CLI/permission check.
3. Installation/configuration requires confirmation of that exact plan. The backend receives `--yes --expected-plan <digest>` and must reject stale configuration. Canceling any choice ends the workflow; it never chooses a default on the user's behalf.
4. Show installation/configuration separately from executable, MCP and permission evidence. Desktop interaction always remains **not tested** by this wizard.
5. After configuration, reload/restart Pi to load the changed MCP registry, then verify permissions from the actual adapter. Setup-process permission evidence does not establish the later Pi process's TCC identity.

The full Peekaboo catalog is configured, including foreground-capable operations. There is no custom tool allowlist/denylist or per-tool approval policy. Tool availability is not authorization for sensitive/external actions; existing user/global policies still apply.

The 4.5.0 compatibility install is explicitly labeled and warned, not represented as the newest or fully certified build. See the [skill setup reference](../../skills/macos-computer-use/references/setup.md) for the 4.6.0 CLI startup defect, older-version input-safety limitations and permission boundaries. No silent downgrade, app-Bridge fallback, TCC modification, provider credential copying, or system-library patching is performed.

## Lifecycle and limits

Only one wizard can run in a Pi session. It refuses to start while the agent is busy. Each backend command has a bounded lifetime/output and uses the shared managed-process runner; Esc and session shutdown request cancellation, and the progress dialog waits for bounded process-group cleanup. Cancellation may leave completed installation/configuration changes; it is not rollback and does not trigger an automatic retry. Escaped descendants and hard runtime crashes are outside the original process-group cleanup guarantee.

The backend owns configuration locking and merge checks. The wizard is not a cross-session desktop lock, sandbox, semantic permission engine or artifact-retention service. It does not execute screenshots, clicks, typing, or provider inference as a setup test.

## Tests

`npm run test:setup` covers command discovery guards, plan approval/cancellation, full-catalog presentation, protocol validation, executable resolution, argument handling, bounded output and real subprocess cancellation. Backend behavior has separate tests in `pi-setup`. A passing setup check does not certify arbitrary desktop interaction.
