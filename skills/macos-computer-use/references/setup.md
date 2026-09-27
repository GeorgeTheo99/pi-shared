# Peekaboo setup through Pi's MCP adapter

This is an opt-in local integration, not an automatically installed pi-shared service. Use one adapter-managed server, not a parallel native wrapper. No Pi runtime patch is needed.

## Install and check compatibility

Use the official [Peekaboo releases](https://github.com/openclaw/Peekaboo/releases) or its documented Homebrew distribution. Pin and test a compatible release; verify the published checksum and Developer ID signature before execution.

Known installation caveats:

- The 4.6.0 CLI failed before startup on macOS 26.2 with `Symbol not found: _swift_initBorrow`; [upstream #831](https://github.com/openclaw/Peekaboo/issues/831) reports the same problem and identifies 4.5.0 as unaffected. The signed 4.5.0 CLI was verified to start on that machine.
- 4.5.0's explicitly selected app-Bridge MCP route failed at startup even after app permissions were granted. The [4.6.0 release notes](https://github.com/openclaw/Peekaboo/releases/tag/v4.6.0) describe a GUI Bridge startup fix, but that CLI has the separate launch defect above. Use the direct stdio route below rather than assuming app-Bridge readiness.
- 4.6.0 also contains input-safety fixes, including modifier cleanup. An older CLI starting successfully is not proof of equivalent safety or full desktop reliability. Re-evaluate a fixed published release before relying on complex keyboard/foreground workflows. Do not patch system Swift libraries to work around startup errors.

Check `peekaboo --version` before configuring MCP. In direct mode the CLI process owns its runtime. Check permissions using that exact binary and routing mode:

```sh
/absolute/path/to/pinned/peekaboo permissions status --no-remote --json
```

Accessibility, Screen Recording, and Event Synthesizing are separate reported capabilities. Request the needed permissions with `permissions request accessibility`, `permissions request screen-recording`, and `permissions request event-synthesizing`, each with `--no-remote`. These requests can display macOS dialogs; they do not grant permission automatically. The user must approve through macOS.

macOS attributes permissions to a responsible process/application identity. Grants to Peekaboo.app do not prove a CLI launched by Pi has access. Verify again from the actual Pi adapter process after user approval. A terminal/host restart may be required; do not terminate the user's terminal or agent automatically. Never modify TCC databases or request Full Disk Access to solve this.

Do not run a second Peekaboo app/daemon capture host concurrently with the direct MCP runtime. Direct stdio is process-owned, not a shared app Bridge; future app-host adoption requires explicit configuration and separate verification.

## Adapter configuration

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

This configuration exposes the full advertised Peekaboo catalog: no `includeTools` or `excludeTools` filter, and no added per-tool approval policy. `directTools:false` routes all calls through the adapter's `mcp` tool rather than adding every tool to Pi's top-level inventory; it does not hide them. Validate the live catalog after installation; adapter-prefixed names are discovered, not hardcoded in the skill. Existing global adapter policies still apply. Sensitive/external actions still require user authorization under normal agent guidance; do not describe that guidance as an enforced semantic security boundary.

The optional agent/analysis tools may need separately configured model providers. Exposing a tool does not prove its credentials or other prerequisites exist. Do not copy Pi credentials into Peekaboo or configure a second model provider automatically.

`lazy-keep-alive` retains one MCP process per Pi session after first use, avoiding ordinary idle teardown while snapshot references are in use. It does not share a controller or lock the desktop across Pi sessions. Do not operate the same desktop concurrently.

This full-capability configuration explicitly passes `--allow-foreground`; applicable actions must still select foreground behavior deliberately. Prefer background delivery where it works and do not silently take over the user's keyboard, pointer, or focus. Omit the flag if the user chooses background-only operation. Changing this startup policy requires restarting the MCP server.

Restart Pi or run `/reload` after changing configuration or installing the skill. Then use `mcp({connect:"peekaboo"})` and inspect the catalog. A reconnect refreshes an already known server; it is not a substitute for loading newly changed config. Do not claim the current session loaded the new configuration without evidence.

## Verification and limits

1. CLI startup and code signature/checksum validation.
2. MCP initialize/list-tools, permissions response, and clean close.
3. Adapter-mediated discovery of the complete backend catalog; verify any separately configured approval policy without mutation dispatch.
4. After permissions are reported granted from the actual adapter: a disposable test window, scoped accessibility observation and screenshot; confirm image content reaches Pi rather than becoming a text-only path.
5. With explicit test authorization: one benign action followed by application-owned state verification. Check stale targets, cancellation, unknown outcomes, and changed focus before claiming reliability.

The skill and MCP adapter are not a sandbox, semantic authorization engine, cross-session lease, or artifact-retention service. The backend and Pi can retain captures/transcripts. For sensitive tasks, use a separate test account or isolated desktop and avoid unrelated logged-in apps. Published test coverage and successful permissions checks do not prove every application or delivery mode works.

References: [MCP contract](https://github.com/openclaw/Peekaboo/blob/main/docs/MCP.md), [automation targeting](https://github.com/openclaw/Peekaboo/blob/main/docs/automation.md), [permissions](https://github.com/openclaw/Peekaboo/blob/main/docs/permissions.md). Consult the documentation for the installed version when contracts differ.
