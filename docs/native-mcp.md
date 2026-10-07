# Official MCP migration

Pi 0.99+ includes its own MCP client, `/mcp` manager, `codemode`, and `tool_search`.
Keep external applications such as FreeCAD, Blender and Peekaboo as MCP servers;
this migration replaces the client adapter, not those applications or their
bridges. It does not replace pi-shared's search, research or browser wrappers.

## New installations

No `pi-mcp-adapter` package is required. Configure servers in
`<agent-dir>/mcp.json` (normally `~/.pi/agent/mcp.json`) or trusted project
`.pi/mcp.json`. Use `pi mcp add`, `pi mcp list`, and `/mcp`. Server executables,
credentials and OS permissions are separate prerequisites. Do not copy browser
or search wrapper endpoints into this registry merely for visibility.

`exposure: "codemode"` keeps server tools out of direct model declarations while
allowing scripts to call them; native MCP activates codemode when needed.
`tool_search` can also discover and declare these tools. This is context selection,
not a permission boundary. Use `hidden` exposure and explicit `toolExposure`
allowlists when tools must be unavailable. Discovery and registration are not
proof of connection health or successful operations.

## Existing adapter installations

Homebrew pi-shared **0.1.30+** supplies explicit migration in `/setup mcp`:

1. Choose **Preview migration from the existing MCP adapter**.
2. Read the exact profile, source, actions and compatibility warnings.
3. Approve only that plan. The backend refuses stale approvals and conflicting
   native configuration. It retains the original adapter config and private
   backups, and disables the adapter's profile selection without deleting npm files.
4. Restart the affected profile. Do not use a mixture of old and new clients to
   control the same desktop concurrently.
5. Run the explicit `pi mcp list` handoff and bounded read-only calls. Preserve
   allowlist restrictions before trying any mutation.

For headless use, the owning backend exposes
`pi-shared capability mcp plan|apply|check`, with canonical project/profile/shared
module/Node context arguments. Migration uses `--options '{"mode":"migrate"}'`;
apply also requires `--yes --expected-plan <digest>`. Check without migration
options is static; it does not start servers or sign in. See the
[complete backend CLI and rollback contract](https://github.com/GeorgeTheo99/pi-setup/blob/main/docs/mcp.md).

Each profile is migrated separately. The ordinary managed update does **not**
automatically migrate profiles, remove packages, or change credentials. Existing
native files, unsupported policy, other conflicting config layers, and untranslatable
filters require explicit resolution; never discard them to make a migration pass.
Adapter OAuth tokens are not imported; some HTTP services may require new native
sign-in with user approval.

## Behavioral differences

- Native MCP connects enabled servers at startup, unlike adapter lazy-start and
  idle-timeout behavior. It owns stdio shutdown; no shared desktop lock is added.
- Tool names become `mcp__SERVER__TOOL`; old proxy calls and `mcpScript` are not
  retained as duplicate routes. Use codemode or direct/deferred tool discovery.
- Tool restrictions and request deadlines need translation. Unsupported approval,
  alias/filter, transport, or credential-interpolation policies fail closed.
- Native codemode returns an MCP `CallToolResult` envelope: inspect `isError`,
  `content`, and optional server `structuredContent`. A successful transport call
  is not necessarily successful application execution. Image content must be
  forwarded explicitly with `image(...)` when needed.
- Pi-shared's structured native-tool results have a separate versioned contract;
  do not treat them as MCP envelopes. See [structured results](structured-results.md).
- Codemode can compose deterministic accessibility actions; interpreting a new
  screenshot still requires a model turn or an explicitly authorized vision tool.
  Never batch speculative desktop mutations or blindly replay uncertain outcomes.

## Diagnostics and rollback

`/mcp` owns connection state. `dev_doctor` lists source-checked
native MCP tool registrations, any legacy adapter report, and separate wrapper
integrations without connecting. Native servers with no visible registered tools
may be pending, disabled, failed, empty, or hidden; their absence is not a diagnosis.

Migration backs up original source/settings bytes privately under the selected
profile's `.mcp-migration/<planId>/` and writes a manifest with before/after hashes.
This is not an atomic multi-file transaction. For rollback, stop affected sessions,
inspect that manifest, and restore only files whose current bytes match the recorded
post-migration hashes. Remove only a matching file recorded as newly created.
Later edits or partial failures require manual inspection, not blind overwrite.
Restoring original profile selection re-enables the retained adapter without npm
reinstallation. Protect the backups: they may contain credentials.
