# Peekaboo setup through Pi's MCP adapter

This is an opt-in local integration, not an automatically installed pi-shared service. Use one adapter-managed server, not a parallel native wrapper. No Pi runtime patch is needed.

For guided setup, the user can run `/setup peekaboo` (or select Peekaboo from `/setup`). It uses the owning `pi-setup` backend for a static preview, explicit installation/configuration approval, and a separate CLI/permission check (not an MCP connection or desktop test). An old backend needs a normal managed update first; the command does not update itself or grant macOS permissions. See the [wizard contract](../extensions/setup/README.md). Agents must not inject slash-command text to invoke this user-facing workflow automatically.

## Install and check compatibility

Use the official [Peekaboo releases](https://github.com/openclaw/Peekaboo/releases) or its documented Homebrew distribution. Pin and test a compatible release; verify the published checksum and Developer ID signature before execution.

Known installation caveats:

- The 4.6.0 CLI failed before startup on macOS 26.2 with `Symbol not found: _swift_initBorrow`; [upstream #831](https://github.com/openclaw/Peekaboo/issues/831) reports the same problem and identifies 4.5.0 as unaffected. The signed 4.5.0 CLI was verified to start on that machine.
- 4.5.0's explicit app-Bridge MCP startup fails with `unavailable` when the `browser` tool is enabled, even with all app permissions granted. This is not a general native-Bridge failure: disabling only `browser` allows initialization and advertises the remaining 25 tools. [Upstream #787](https://github.com/openclaw/Peekaboo/pull/787) fixes the CLI's browser transport capability check for GUI hosts; 4.6.0 includes it but has the separate launch defect above.
- As checked on September 27, 2026, the Swift compatibility fix [#832](https://github.com/openclaw/Peekaboo/pull/832) is merged but the latest published release remains 4.6.0, with assets predating the fix. Recheck official release assets before upgrading; a merged fix is not a released binary.
- 4.6.0 also contains input-safety fixes, including modifier cleanup. An older CLI starting successfully is not proof of equivalent safety or full desktop reliability. Re-evaluate a fixed published release before relying on complex keyboard/foreground workflows. Do not patch system Swift libraries to work around startup errors.

Check both CLI and app versions before configuring MCP. They are complementary components, not interchangeable permission identities. With an explicit app Bridge, the CLI is the MCP transport and the desktop app performs permission-bound operations. In direct mode (`--no-remote`), the CLI process owns its runtime. Check permissions using the exact binary and routing mode; for direct mode:

```sh
/absolute/path/to/pinned/peekaboo permissions status --no-remote --json
```

Accessibility, Screen Recording, and Event Synthesizing are separate reported capabilities. Request the needed permissions with `permissions request accessibility`, `permissions request screen-recording`, and `permissions request event-synthesizing`, each with `--no-remote`. These requests can display macOS dialogs; they do not grant permission automatically. The user must approve through macOS.

macOS attributes permissions to a responsible process/application identity. Grants to Peekaboo.app do not prove a CLI launched by Pi has access. Verify again from the actual Pi adapter process after user approval. A terminal/host restart may be required; do not terminate the user's terminal or agent automatically. Never modify TCC databases or request Full Disk Access to solve this.

Do not run a direct MCP capture host concurrently with an app-Bridge MCP host. A direct MCP process can reserve capture ownership even when its permissions are denied, preventing explicit Bridge startup with an owner-socket-unavailable error. Stop only the identified session-owned direct MCP process before switching; never kill unrelated sessions or daemons. Direct stdio is process-owned, not a shared app Bridge.

## Desktop app Bridge (4.5.0 compatibility)

Prefer one permission-owning desktop app for this configuration. The user must approve the temporary omission of Peekaboo's browser tool; Pi's `browser_fetch`/`browser_inspect` and `app_*` tools remain unchanged. This is a narrow compatibility workaround, not a security boundary or permission bypass.

1. Start the trusted Peekaboo.app and have the user grant its required macOS permissions. Do not request new CLI permissions when the app Bridge is the selected owner.
2. Discover and verify the app's socket with `peekaboo bridge status --json` and `peekaboo permissions status --bridge-socket <absolute-socket-path> --json`. A bridge handshake alone does not establish MCP readiness.
3. Configure the existing adapter entry with the verified CLI and socket paths:

```json
{
  "mcpServers": {
    "peekaboo": {
      "command": "/absolute/path/to/pinned/peekaboo",
      "args": ["mcp", "--bridge-socket", "/absolute/path/to/Peekaboo/bridge.sock", "--allow-foreground"],
      "env": { "PEEKABOO_DISABLE_TOOLS": "browser" },
      "lifecycle": "lazy-keep-alive",
      "requestTimeoutMs": 30000,
      "directTools": false
    }
  }
}
```

The usual app socket is `~/Library/Application Support/Peekaboo/bridge.sock`; expand it to an absolute path and verify it rather than assuming availability. Do not add `--no-remote` to this configuration. Keep the app running; an unavailable explicit host must be reported, not silently replaced by a permission-less local runtime.

4. Reload/restart Pi and verify **through the actual adapter**: 25 advertised tools without `browser`, permission status, one scoped disposable native-window observation, and one reversible action followed by fresh state verification. Configuration and CLI initialization are not end-to-end proof.
5. Remove `PEEKABOO_DISABLE_TOOLS` only after a published, signature/checksum-verified compatible release passes full 26-tool app-Bridge initialization and native smoke testing on the target Mac. Do not patch system Swift libraries or silently install an unsigned development build.

The route-aware `/setup peekaboo` flow requires the owning backend's **Peekaboo schema v2** (Homebrew **0.1.23+**). It offers explicit desktop-Bridge and direct-CLI selection, previews the browser-only exclusion before approval, and preserves recognized existing configurations when no route is selected. Older backends fail with an upgrade instruction; they are not silently used for Bridge setup. Selecting a different route for an existing entry reports a conflict rather than overwriting it. Backend checks use the selected socket and reject permission evidence from the wrong route; they still do not perform desktop actions.

Verified on September 27, 2026 with the signed 4.5.0 CLI and desktop app: the actual reloaded Pi adapter exposed 25 tools, reported all three permissions granted, inspected a disposable TextEdit window, changed a canary through `set_value`, and returned fresh AX and screenshot evidence of the change. This is scoped native-operation evidence, not certification of every tool. A locked desktop initially prevented AX reads and activation despite granted permissions; unlocking manually resolved that failure. A close-window request returned indeterminate evidence; a fresh observation followed by a normal quit of the test-only app completed cleanup. Never blindly retry ambiguous mutations.

## Direct-mode alternative

Use this only when direct CLI ownership is intended and permissions have been approved for its actual responsible process. In System Settings' file picker, **Shift–Command–G** can navigate to the exact binary directory shown by the adapter configuration; Peekaboo.app is not that binary. Shell aliases/symlinks do not establish which identity macOS grants. A tmux-launched session must be checked independently rather than assuming grants to a terminal apply.

Merge an entry into the existing `mcpServers` object in `~/.config/mcp/mcp.json` (shared user configuration), or `<agentDir>/mcp.json` for a Pi-profile-only override. Preserve other servers and settings. Substitute a real absolute path; do not assume shell expansion inside JSON arguments.

```json
{
  "mcpServers": {
    "peekaboo": {
      "command": "/absolute/path/to/pinned/peekaboo",
      "args": ["mcp", "--no-remote", "--allow-foreground"],
      "lifecycle": "lazy-keep-alive",
      "requestTimeoutMs": 30000,
      "directTools": false
    }
  }
}
```

This direct-mode configuration exposes the full advertised Peekaboo catalog: no `includeTools` or `excludeTools` filter, and no added per-tool approval policy. The app-Bridge compatibility configuration above instead disables just `browser` upstream and advertises 25 tools. `directTools:false` routes all calls through the adapter's `mcp` tool rather than adding every tool to Pi's top-level inventory; it does not hide them. Validate the live catalog after installation; adapter-prefixed names are discovered, not hardcoded in the documentation. Existing global adapter policies still apply. Sensitive/external actions still require user authorization under normal agent guidance; do not describe that guidance as an enforced semantic security boundary.

The optional agent/analysis tools may need separately configured model providers. Exposing a tool does not prove its credentials or other prerequisites exist. Do not copy Pi credentials into Peekaboo or configure a second model provider automatically.

`lazy-keep-alive` retains one MCP process per Pi session after first use, avoiding ordinary idle teardown while snapshot references are in use. It does not share a controller or lock the desktop across Pi sessions. Do not operate the same desktop concurrently.

This full-capability configuration explicitly passes `--allow-foreground`; applicable actions must still select foreground behavior deliberately. Prefer background delivery where it works and do not silently take over the user's keyboard, pointer, or focus. Omit the flag if the user chooses background-only operation. Changing this startup policy requires restarting the MCP server.

Restart Pi or run `/reload` after changing configuration. Then use `mcp({connect:"peekaboo"})` and inspect the catalog. A reconnect refreshes an already known server; it is not a substitute for loading newly changed config. Do not claim the current session loaded the new configuration without evidence.

## Verification and limits

1. CLI startup and code signature/checksum validation.
2. MCP initialize/list-tools, permissions response, and clean close.
3. Adapter-mediated discovery of the complete backend catalog; verify any separately configured approval policy without mutation dispatch.
4. After permissions are reported granted from the actual adapter: a disposable test window, scoped accessibility observation and screenshot; confirm image content reaches Pi rather than becoming a text-only path.
5. With explicit test authorization: one benign action followed by application-owned state verification. Check stale targets, cancellation, unknown outcomes, and changed focus before claiming reliability.

The guidance and MCP adapter are not a sandbox, semantic authorization engine, cross-session lease, or artifact-retention service. The backend and Pi can retain captures/transcripts. For sensitive tasks, use a separate test account or isolated desktop and avoid unrelated logged-in apps. Published test coverage and successful permissions checks do not prove every application or delivery mode works.

References: [MCP contract](https://github.com/openclaw/Peekaboo/blob/main/docs/MCP.md), [automation targeting](https://github.com/openclaw/Peekaboo/blob/main/docs/automation.md), [permissions](https://github.com/openclaw/Peekaboo/blob/main/docs/permissions.md). Consult the documentation for the installed version when contracts differ.
