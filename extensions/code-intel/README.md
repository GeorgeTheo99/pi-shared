# code_intel — read-only TypeScript/JavaScript intelligence

Registers one independently disableable tool: `status`, `definition`, `references`,
`hover`, and `diagnostics`. No rename, edits, arbitrary commands, installation,
network lookup, or server startup at extension registration. Servers start only
for navigation/diagnostic calls and are shut down after each call and on session
shutdown/reload. Loading this source does not configure a project.

## Explicit setup and trust

Install a TypeScript language server and TypeScript yourself, or use the optional
pinned dependencies in this directory:

```sh
cd extensions/code-intel
npm ci --ignore-scripts --no-audit --no-fund
```

There are **no runtime installs** or `npx` calls. Dependencies are local, not global.
This is an optional dependency package, not a second Pi profile/package install.

In an explicitly Pi-trusted project, create `.pi/code-intel.json`:

```json
{
  "version": 1,
  "adapter": "typescript-language-server",
  "workspace": ".",
  "executable": "/absolute/path/to/node",
  "args": ["/absolute/path/to/typescript-language-server/lib/cli.mjs", "--stdio"],
  "tsserverPath": "/absolute/path/to/typescript/lib/tsserver.js",
  "timeoutMs": 15000
}
```

`tsserverPath` is optional when the installed language server can find TypeScript.
`executable` must be absolute and executable; args are an explicit array, never
shell-expanded. `workspace` resolves inside the canonical current project/cwd,
not an ancestor project discovered implicitly. The config is read only after
`ctx.isProjectTrusted()` succeeds; Pi versions without this API fail closed.
A project boolean claiming `trusted: true` has no effect. No automatic trust grants.

The language server and project config are trusted executable inputs: they retain
normal OS permissions and environment. Workspace bounds are operational scope,
**not a sandbox**. Servers may read dependencies/external project references or
run plugins. The client rejects every server-initiated request, including edits.
Do not configure a shell, package installer, or unreviewed server as the executable.

## Interface and coordinates

```json
{"action":"status"}
{"action":"definition","path":"src/main.ts","line":4,"column":12}
{"action":"references","path":"src/main.ts","line":4,"column":12}
{"action":"hover","path":"src/main.ts","line":4,"column":12}
{"action":"diagnostics","path":"src/main.ts"}
```

- Paths are relative to the configured workspace (absolute paths within it also
  work). TS/TSX/JS/JSX/MTS/CTS/MJS/CJS source is supported.
- Input and output coordinates are **1-based Unicode code points**, not bytes,
  UTF-16 units, grapheme clusters, or visual/tab columns. Range ends are exclusive.
  Combining characters count separately. CRLF, LF and CR lines are supported.
- The client negotiates LSP UTF-8/UTF-16/UTF-32, falling back to standard UTF-16.
  Returned ranges are converted against fingerprinted source; invalid/split
  code-point positions fail rather than inventing a location.
- `references` includes declarations. LocationLinks use `targetSelectionRange`.
- `status` checks trust, config, workspace and executable accessibility. It does
  **not** initialize a server or establish readiness: `execution: not_started`,
  `freshness: not_checked`. Missing config/executable is an explicit error.
- Results carry `schemaVersion: 1`, config digest, workspace, server identity,
  per-process instance ID, negotiated encoding, document version/SHA-256, source
  scope/digest, result and cleanup outcome. Server text is untrusted source data.
  Errors throw to Pi's native `isError` handling with stable error-code prefixes.

## Freshness and diagnostics

Each query starts a **fresh semantic server** and opens the current requested
on-disk document. Version starts at 1 within each server instance. The transport
also supports `didChange` with incrementing versions and full replacements, plus
`didClose`; it never updates disk. Fresh processes deliberately avoid stale
unopened dependencies and project configuration in a persistent server cache.
This trades startup latency for a smaller, more reliable MVP. Editor-only unsaved
buffers are not read. TypeScript's separate automatic syntax-server routing is
disabled: it can return an import alias before semantic project loading completes.

Before/after SHA-256 inventories cover every TS/JS/JSON file under the workspace,
excluding `node_modules` and `.git`. Source/config changes discard the result with
`stale_source`. Evidence says **matched_before_after**, not atomic/hermetic/current
forever. Intermediate edits restored before the second scan, external dependencies,
compiler binaries, plugins, and outside project references are not fingerprinted.
Concurrent editors are not locked. Returned locations outside the fingerprinted
workspace (including standard libraries/dependencies) fail explicitly instead of
returning unverifiable ranges. Workspace symlinks are rejected, not followed;
the canonical workspace root itself may have an alias such as macOS `/var`.

TLS push diagnostics are unversioned and can be partial. The client ignores them:
an empty/old push is **never** treated as a clean fresh result. Diagnostics use
only TLS's advertised `typescript.tsserverRequest` command (TLS 4.4+), internally
allowlisting `syntacticDiagnosticsSync` and `semanticDiagnosticsSync` against the
opened document. Both must return successful, well-formed synchronous results.
The action covers syntax and semantic diagnostics for the requested file, not
suggestions, build output, or project-wide errors. Unsupported/malformed/missing
responses fail explicitly. No arbitrary execute-command interface is exposed.

## Bounds and lifecycle

- One operation per extension instance; concurrent calls fail `busy`.
- Config: 16 KiB. Workspace: 20,000 entries, 4,096 source files, 1 MiB per file,
  32 MiB aggregate source. Exceeding bounds or encountering symlinks fails before
  launch. `node_modules`/`.git` are excluded before traversal.
- JSON-RPC: Content-Length framing, fatal UTF-8 decoding, 8 KiB headers, 2 MiB
  messages, 32 MiB received per connection, 10,000 messages, 8 pending requests,
  bounded stdin buffering. Bad framing, floods, and malformed responses fail.
  Stderr is continuously drained and counted but not retained or exposed.
- Navigation/diagnostic deadline: configured 1–60 seconds after config validation,
  including source inventories and startup; each RPC also has a 15-second ceiling.
  Filesystem operations are cooperative, not forcibly interruptible. Abort/timeout
  sends `$/cancelRequest`, then performs bounded cleanup.
- Graceful `didClose` → `shutdown` (500 ms) → `exit`, followed by bounded escalation
  (up to another 1.1 seconds). POSIX owned process groups receive TERM/KILL; Windows
  cleanup targets the direct process. Normal shutdown confirms direct server exit;
  descendants remain explicitly `unverified`, especially escaped descendants.
  Hard owner crashes are not supervised and can leave processes. No PID records
  are persisted or reused for later killing.
- Results: at most 1,000 locations/diagnostics and 48 KiB JSON; overflow is an
  explicit `result_limit`, never silent truncation or false completeness.

## Verification and root wiring

From the repository root:

```sh
node --no-warnings --test tests/code_intel*.test.mts
```

Tests include fake framing/Unicode/sync/crash/timeout/cancel/shutdown/flood servers,
trust gating and read-only registration, and a real local TLS fixture covering
cross-file definition/references, unrelated same-name scopes, Unicode ranges,
dependency edit → hover, clean diagnostics → type error → fixed diagnostics.
The real smoke is explicitly skipped when optional dependencies are absent; fake
protocol tests still run. Fixture files are temporary and removed after each test.

`npm run test:code-intel` runs this suite and is included in root `npm test`.
Test execution does not configure or activate the tools in a live profile.
