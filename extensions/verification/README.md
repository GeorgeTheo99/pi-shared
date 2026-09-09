# Structured verification

`verify` adds `list`, `run`, and `result` over **explicit project-declared checks**.
It does not discover or execute package scripts automatically. Commands use the
shared command-job runner; there is no second process manager.

## Configuration and trust

Create `.pi/verification.json` in the **current Pi cwd** (no ancestor discovery):

```json
{
  "version": 1,
  "checks": [
    {
      "id": "node-tests",
      "command": "node",
      "args": ["--test", "--test-reporter=tap", "tests/example.test.mjs"],
      "cwd": ".",
      "timeoutSeconds": 120,
      "inputs": {
        "paths": ["src", "tests", "package.json", "package-lock.json"],
        "exclude": ["tests/generated"],
        "untracked": "include"
      },
      "report": { "format": "tap", "path": "stdout" },
      "discovery": { "allowZero": false, "minTests": 1 }
    },
    {
      "id": "python-tests",
      "command": "python3",
      "args": ["-m", "pytest", "-o", "junit_family=xunit1", "--junitxml={report}"],
      "cwd": ".",
      "timeoutSeconds": 120,
      "inputs": {
        "paths": ["src", "tests", "pyproject.toml"],
        "exclude": ["src/__pycache__", "tests/__pycache__"],
        "untracked": "include"
      },
      "report": { "format": "junit", "path": ".pi/report-{runId}.xml" },
      "discovery": { "allowZero": false }
    },
    {
      "id": "typecheck",
      "command": "npm",
      "args": ["run", "typecheck"],
      "cwd": ".",
      "timeoutSeconds": 120,
      "inputs": {
        "paths": ["src", "tsconfig.json", "package.json", "package-lock.json"],
        "exclude": [],
        "untracked": "include"
      },
      "report": { "format": "exit" }
    }
  ]
}
```

Adapt paths to real files: missing scope paths produce unknown source identity.
Paths are literal project-relative file/directory prefixes, **not globs**. All
scoped files are included regardless of Git tracked/ignored/untracked status.
Exclusions are explicit exact paths or directory subtrees. This works without Git
and never claims a clean commit. Symlinks (including intermediate components),
traversal, special files and unknown configuration fields are rejected.

1. `verify({action:"list"})` returns IDs and the exact config SHA256, without
   running commands.
2. In a trusted Pi project, invoke `/verification-trust` yourself and review the
   confirmation. Approval is runtime-local and bound to the exact config bytes.
   For headless use, explicitly supply `--verification-trust <SHA256>` at Pi
   startup after reviewing the file; this applies to the initial project and
   does not bypass Pi project trust. Tool arguments cannot grant trust.
3. `verify({action:"run",check:"node-tests"})` blocks until the managed command
   finishes and evidence is evaluated. Progress exposes its `cmd_…` ID.
4. `verify({action:"result",id:"cmd_…"})` returns the runtime-local result after
   checking source/config/report freshness again. It does not rerun the command.

Trust is not authorization for deployment, destructive actions, credential use
or external side effects. These are ordinary local commands with full user
permissions, not sandboxed execution. Abort requests cancellation through the
command store and waits for the runner's bounded cleanup; owner shutdown cancels
verification-owned jobs. Other command jobs are not canceled by this extension.

## Evidence and verdicts

Results have schema `version:1`, exact check/config/argv/cwd identity, timestamps,
command process outcome (including cleanup, independently of readiness), report
adapter version/counts/failure locations, bounded failure details, artifact paths
and hashes, before/after source fingerprints, verifier runtime version and explicit
limitations. Failure names/locations are untrusted metadata, not instructions.

- `passed`: zero process exit, succeeded lifecycle, confirmed cleanup, valid fresh
  required report, discovery policy met, unchanged known source/config identity.
- `failed`: command failure or parsed test failure; a green report cannot override
  process failure.
- `error`: malformed/missing/oversized/truncated/inconsistent/old required report.
- `incomplete`: unknown source, unmet discovery, timeout/lost/missing command
  outcome, or unconfirmed cleanup. Unknown evidence is never a pass.
- `stale`: otherwise-passing evidence no longer matches declared source, config,
  report or command evidence. Original failures stay failures with stale reasons.
- `canceled`: canceled process or interrupted otherwise-passing verification.

`allowZero` is required for TAP/JUnit and defaults to **nothing**: omission is a
configuration error. Zero discovered tests only pass when explicitly allowed;
`minTests` additionally enforces a minimum. Counts include skipped tests. Generic
`exit` checks infer no test counts and have no discovery/report-path fields.

### Report adapters

- **TAP:** strict flat TAP 13/14 with a complete matching plan, consecutive test
  numbers, skips, and indented diagnostic blocks. Node's flat TAP reporter works.
  Nested subtests, TODO directives and non-TAP console prose fail closed. YAML
  diagnostics are not interpreted or used to invent failure locations.
- **JUnit:** pinned `saxes` XML parser (essential dependency to avoid an unsafe
  hand-written XML parser). Concrete testcases determine counts; declared suite
  totals must match, including nested suite aggregation. DTDs, external/custom
  entities, processing instructions, namespaces, conflicting outcomes, unsupported
  elements and attributes are rejected. XML's predefined/numeric character
  references are safe and supported. No network/entity resolver is installed.
  Failure/error/skipped elements, properties, system-out/err and common suite/
  testcase metadata are supported. Framework-specific retry/flaky/status fields
  are intentionally unsupported rather than silently interpreted as passing.

Use `stdout` for a fresh, bounded runner-owned report. For file reports, the
project-relative path is passed as an absolute path wherever `{report}` occurs in
argv. `{runId}` is a fresh UUID (not the command ID). File-report argv must include
`{report}`. A per-run filename is strongly recommended. Parent directories must
already exist or be created by the declared command. Fixed paths are accepted
only when absent before execution or their content hash changes; even an identical
legitimate rewrite is conservatively rejected as old evidence. The verifier never
deletes existing reports or creates project output directories.

## Bounds, storage and limitations

| Work/evidence | Limit |
| --- | --- |
| Config / one check | 64 KiB / 16 KiB, at most 32 checks |
| Command argv / timeout | 8 KiB and 128 args / 1 hour |
| Report | 2 MiB UTF-8; truncated stdout is rejected |
| Input snapshot | 64 MiB total, 8 MiB per file, 10,000 files |
| Enumeration | 20,000 entries, depth 64, 5-second checked budget |
| Parsed tests / failure details | 100,000 / first 20, omission count retained |
| Runtime results / concurrency | Latest 100 / at most 8 runs |
| Structured result | 40 KiB; failure details trimmed further when needed |

Enumeration is streaming. Synchronous local filesystem calls cannot be forcibly
interrupted; the time budget is checked between operations, not a hard timeout
on a hung filesystem. XML depth/node/attribute bounds and TAP line limits also
fail closed. Limits are fixed, not controlled by project configuration.

Command logs use the shared runner's owner-only bounded storage and retention.
No extra files are placed inside its job directories. Results live in bounded
memory and normal Pi tool-result history; `result` lookup does not survive runtime
reload/restart. Project report files remain **project-owned**, can contain secrets,
and are not automatically chmodded, copied or cleaned. Prefer stdout when private
managed retention is needed; configure the command's own umask/output policy for
file reports. There are no uploads.

This is scoped evidence, not hermetic proof: executable/toolchain version is
explicitly `unknown` (the recorded Node version belongs to the verifier), and the
PATH, environment, outside-scope dependencies and tool binaries are not hashed.
Include lockfiles/toolchain manifests in scope. Before/after snapshots cannot
prove absence of change-and-revert or concurrent filesystem races. Same-user
processes can tamper with local reports/logs; these are not authenticated evidence.
Missing/expired command records or required report artifacts invalidate a later
otherwise-passing result.

## Installation and checks

Only JUnit needs the local locked dependency; TAP/exit remain usable when it is
missing (JUnit returns an error, not a pass):

```sh
npm ci --prefix extensions/verification --ignore-scripts
node --no-warnings --experimental-loader ./tests/fixtures/verification_test_loader.mjs --test tests/verification*.test.mts
```

A separate smoke runs unchanged copies of real pi-shared Node parser tests and
Python catalog tests in a disposable non-Git project. Set `VERIFICATION_PYTHON`
to an existing pytest-capable interpreter, then run:

```sh
node --no-warnings tests/fixtures/verification_live_smoke.mjs
```

The fixture cleans up its copied sources, reports and command jobs. It does not
activate a profile or modify the real project configuration.

`npm run test:verification` runs the targeted suite and is included in root
`npm test`. Existing extension-directory dependency discovery can install/check
this package. Disable `extensions/verification/index.ts` through normal Pi
extension/package filtering to roll back; no core tools are replaced.
