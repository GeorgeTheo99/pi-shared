# Development tooling roadmap

Status: implementation plan; see [delivered MVPs and activation prerequisites](development-tooling-implementation.md).
This document alone does not authorize runtime activation.
Baseline: pi-shared `37cf3c1`, locally installed Pi `0.85.1`, inspected 2026-09-08.

## Outcome

Make development actions easier to execute, inspect, and verify without expanding
agent authority or duplicating Pi's core. Prioritize managed commands, trustworthy
verification evidence, and precise code navigation over more orchestration modes.

This plan records recommended defaults. Each numbered change is an independently
reviewable implementation unit, not a promise to complete the entire roadmap in
one session. Estimates are omitted until the first slice establishes actual cost.
No deployments, public issue creation, pushes, profile changes, or upstream patches
are included in the planning task.

## Sequence and dependencies

| ID | Deliverable | Depends on | Release criterion |
|---|---|---|---|
| 01 | Managed command jobs + job-aware waiting | — | Success/failure/cancellation/log bounds proven with real processes |
| 02 | Structured verification and source identity | 01 | Known failing fixtures can never produce a passing verdict |
| 03 | Read-only code intelligence, TypeScript first | —; scheduled after 02 | Definitions/references/diagnostics reflect current source |
| 04 | Unified environment doctor | — | Reports distinguish availability from actual execution evidence |
| 05 | Lossless structured result recall | — | Exact JSON selection preserves large numbers and provenance |
| 06 | Reproducible local/private app testing | 01 useful, not required | Isolated desktop/mobile runs produce bounded failure evidence |
| 07 | Opt-in subagent worktrees | Existing subagent runtime | Parallel workers leave the parent checkout untouched |
| 08 | Correct tool activation, then broader discovery | — | No silent un-hiding, false load success, or cap miscounts |
| 09 | Previewed, stale-protected edits | 03 useful, not required | Stale inputs cause zero intended writes |
| 10 | Deduplicate identical context resources | — | Same canonical file appears once; distinct instructions survive |

Execute 01–03 first, then 04–10 in order unless observed usage changes priorities.
Small independent tasks (04, 05, 10) may run in separate worktrees once scope is
agreed. Avoid concurrent changes to shared process code, package scripts, or the
same extension entrypoint. Treat 08's correctness work as a prerequisite to its
feature expansion, not a prerequisite to the whole roadmap.

## Shared design rules

- Keep `bash`, `read`, `edit`, and existing tools compatible; add focused tools
  rather than silently replacing built-ins.
- Version persisted/result schemas. Return machine-readable `details` plus a
  bounded human-readable summary, exact status, and evidence references.
- Job completion, process exit zero, tests passing, and service readiness are
  separate facts. Unknown, missing, truncated, and stale evidence stay explicit.
- Local/private artifacts: owner-only files/directories, bounded disk retention,
  no credential/environment dumps, no automatic uploads. Redaction is best effort;
  raw command logs and browser traces remain potentially sensitive.
- Trust project configuration before executing commands or language servers.
  Tool availability is not permission for deployment, destructive changes, or
  external actions; retain existing approval boundaries.
- Reuse small proven primitives, not subagent-specific semantics. Worktrees and
  tool allowlists are not security sandboxes.
- Add regression tests and root `package.json` test wiring with each feature.
  Keep new extensions disableable independently for rollback.

## 01 — Managed command jobs and waiting

### Scope and proposed interface

New `command_job` tool, with action-specific validation:

- `start`: executable, argv, cwd, required run timeout; optional explicit shell
  mode and bounded readiness probe. Prefer executable/argv over shell strings.
- `status`, `list`: identity, owner, timestamps, lifecycle, readiness, exit code,
  termination reason, log/artifact metadata. Default list scope is current project.
- `logs`: opaque cursor and byte limit; return next cursor and truncation notices.
- `cancel`: request termination of the owned process tree; idempotent.

`start` returns a `cmd_…` ID promptly. Integrate it into `wait_for({jobs:[...]})`
without changing existing subagent IDs or the meaning of `condition`.
Mixed command/subagent waits use a small normalized snapshot adapter.

MVP lifecycle: `starting → running → succeeded|failed|canceled|timed_out|lost`;
`canceling` stays nonterminal during bounded cleanup. Record process outcome and
`cleanup: confirmed|unconfirmed` separately; if the grace deadline expires without
proof, return an explicit cleanup-incomplete reason instead of claiming all children
exited. Process-group signaling is not proof of termination, and escaped descendants
are outside the cleanup guarantee. Readiness is a separate
`not_requested|pending|ready|failed` field. Limit initial readiness to local TCP or
HTTP probes with explicit target, deadline, and bounded responses. A ready server
is still running; waiting for readiness must be an explicit option, never implied
by waiting for completion.

Owner-lifetime execution only in MVP: normal shutdown/reload terminates owned
process groups. Records survive; execution is not resumable after owner death.
A dead owner becomes `lost`, not success. Do not kill a possibly reused PID from a
stale record. State this limitation in tool help and tests. Reboot/crash-surviving
execution requires a separately reviewed supervisor and is deferred.

### File boundaries

- New `extensions/command-jobs/{index.ts,README.md}`.
- New `extensions/_shared/command-job-{runner,store}.ts` and `job-snapshots.ts`.
- Reuse `_shared/managed-process.ts`, `file-lock.ts`, and text bounds where suitable.
- Update `extensions/wait-for/{index.ts,README.md}`; preserve subagent store schema.
- New `tests/command_jobs*.test.mts`; extend wait tests and root test scripts.

Do not use `pi-agent-runner.ts`: successful commands may produce no output, while
Pi children require a nonempty final assistant answer. Do not reuse the provider
scheduler for command jobs. Set bounded independent concurrency/capture/storage
limits; test disk-full and output floods. Drain pipes even after retained output
reaches its cap, and explicitly mark omitted output rather than promising full logs.

### Acceptance

- Real fixtures: exit 0 with no output, exit 7 with stderr, spawn failure, timeout,
  cancellation with grandchildren, readiness then later failure, and stdout flood.
  Include a controlled escaped-descendant fixture with test-owned cleanup; prove
  unconfirmed cleanup is exposed rather than converted to successful cancellation.
- Cursor reads do not duplicate/skip retained bytes; invalid/expired cursors and
  artifact access outside the job's scope fail clearly.
- Concurrent writers do not lose records; cross-session cancellation is routed
  through the live owner and never treats a request as completed termination.
- Abort a wait without canceling its jobs. Wake on failure, unknown IDs, or an
  impossible `any_success`/`any_failure` outcome instead of waiting to timeout.
- Honor the overall wait deadline, including individual probe execution; verify
  sequential gating explicitly in registration/runtime rather than documentation.
- Existing subagent wait/interactive semantics remain green.

Suggested split: **01a** bounded runner/store and fixtures; **01b** public tool,
wait integration, live smoke, documentation. Neither requires a supervisor.

## 02 — Structured verification

New `verify` tool: `list`, `run`, `result` over trusted project-declared checks.
Suggested config: `.pi/verification.json`, versioned, with explicit argv/cwd,
timeout, input scope, report format/path, and expected test-discovery policy.
Discovery may suggest commands from package metadata, but never executes them
merely by inspecting a repository. User-directed check execution uses command jobs.

Start with TAP and JUnit report adapters plus a generic exit-code check for lint,
build, and typecheck. Do not invent test counts from console prose. Parse JUnit
without DTD/entity expansion. Missing, malformed, oversized, or inconsistent
required reports yield `error`/`incomplete`, never `passed`; nonzero process exit
cannot be overridden by a green report. Zero discovered tests require explicit
project policy to count as success.

Result includes check/config identity, argv/cwd, start/end time, process outcome,
counts/failure locations when available, adapter version, artifact references,
and source identity. Fingerprint declared inputs before and after the run,
including tracked modifications and declared untracked inputs; omit generated
outputs via explicit rules. Mark changed inputs `stale`. Missing scope or inability
to fingerprint yields `source_identity: unknown`, not a clean-commit claim.
Record toolchain versions and the scope/limitations; do not claim hermetic proof.

Paths: new `extensions/verification/{index.ts,types.ts,README.md,parsers/}` and
`tests/verification*.test.mts`. Use command-job artifacts rather than starting a
second process manager. Evidence must describe this run: allocate a fresh report
destination or detect and reject unchanged reports from an earlier run.

Acceptance: passing/failing TAP/JUnit fixtures, malformed XML, stale reports,
zero tests, mixed pass/fail, process failure after a green report, missing report,
source mutation during execution, non-Git repository, and canceled run. Live smoke
runs actual pi-shared Node and Python checks; generic exit checks may cover Python
until a configured JUnit report is available. Report adapter limitations honestly.

## 03 — Read-only code intelligence

New `code_intel` tool: `status`, `definition`, `references`, `hover`, `diagnostics`.
Start with one TypeScript/JavaScript language-server adapter and fixture project;
add Python only after that contract works. Run configured installed servers, never
silently download executables or invoke `npx` installation. Explicitly report
missing executable, unsupported method, startup failure, and timeout.

Paths: new `extensions/code-intel/{index.ts,client.ts,README.md}` plus protocol and
fixture tests. Manage bounded JSON-RPC transport, cancellation, workspace identity,
server shutdown, and document synchronization. Specify tool coordinates as
1-based lines/columns and convert correctly to negotiated LSP position encoding.
Honor configuration trust; scope server workspace access to the intended project
operationally, without claiming an OS sandbox.

Acceptance: cross-file definition/reference lookup, symbols with same name in
unrelated scopes, Unicode positions, edit-then-query freshness, server crash, and
clean shutdown. Return paths/ranges, server identity, and document version/digest.
Read-only MVP: rename and other edits are deferred to 09's preview/apply boundary.

## 04 — Environment doctor

Add `bin/pi-doctor` and a thin `dev_doctor` tool wrapper. Compose the existing
`bin/pi-profile-check`, `pi-browser-check`, `pi-shared-check-deps`, and
`lib/probe_extensions.mjs`; add structured output to those checkers where needed
instead of parsing their human messages or duplicating their behavior.

Report each capability's installed/loaded/active/configured state independently,
with `verified_at`, probe type, outcome, and actionable repair guidance.
An authenticated inventory probe is not a browser execution test. Extension import
executes trusted code and may have initialization effects: distinguish static
inspection from opt-in import/network/execution probes, with per-probe deadlines.
Never auto-repair profiles, install dependencies, read secret values into output,
or invoke paid models just to mark them healthy.

Acceptance: missing dependency, disabled optional browser, bad endpoint, auth
failure, timeout, configured-but-unexercised model, import failure, and known-good
profile fixtures. Existing checker CLIs/exit contracts remain compatible. Tests:
existing `tests/test_pi_*check*.py` plus new doctor aggregation tests.

## 05 — Lossless structured recall

Extend `tool_result_recall`, not a new tool. MVP: JSON Pointer over a selected
original text-content part or serializable tool `details`, with explicit source
selection. JSONPath is deferred until there is demonstrated need.

Paths: extract `extensions/tool-summary/recall.ts` and add `json-query.ts`; extend
`tests/tool_summary_{policy,extension}.test.mts` and new selector tests.

Read originals from the active session branch, retaining exact call-ID matching,
hashes, provenance, and untrusted-data wrappers. For JSON text, select original
source spans or use a lossless parser: ordinary parse/stringify must not round
large integers. For `details`, report that fidelity is limited to the already
stored JavaScript value. Never imply recall can recover upstream-truncated data.

Acceptance: escaped pointer tokens, array indices, null vs missing, large integers,
invalid JSON, oversized selection, wrong branch, ambiguous call ID, and explicit
truncation. Keep authoritative exit codes/counts/artifact IDs in deterministic
summaries when present, but never reconstruct absent fields with an LLM.

## 06 — Reproducible app testing

Extend `extensions/pi-browser-capture/src/app-testing.ts`; keep every current
`app_*` call compatible and leave the public browser-worker boundary untouched.

Add a small `app_test` action router for isolated context create/close/configure,
viewport/device settings, accessibility snapshot, trace start/stop, and a bounded
step sequence with assertions. Use the pinned Playwright-compatible accessibility
API available at implementation time. Sequences stop on first failed assertion;
no implicit retries of clicks, form submissions, or other mutating actions.

Keep existing persistent authenticated context behavior as the default. Tests
opt into isolated contexts; never copy credentials/cookies without explicit scope.
Serialize configuration/actions per context; session-owned IDs prevent accidental
cross-session reuse. Trace capture is opt-in and sensitive, with private local
artifacts, retention limits, and no automatic publishing. Failure bundles include
bounded console/network evidence and screenshot only when supported.

Acceptance: local fixture app at desktop/mobile widths, simultaneous isolated
contexts without state leakage, keyboard/accessibility assertions, deterministic
failure bundle, allowed-target enforcement, and cleanup on error/shutdown. Update
browser inventory tests and add real local app-runtime integration tests; existing
public-worker inventory must remain exactly its two current tools.

## 07 — Subagent worktree isolation

Add opt-in `isolation: "worktree"` for Git-backed worker runs. Implement ownership
in new `_shared/subagent-worktree.ts`, called by `spawn-subagent/index.ts`, passing
the resulting cwd to existing runners. Start with one-shot workers; expand to
interactive mode only with equivalent lifecycle coverage.

Use a unique detached worktree at an explicitly resolved base commit; do not
silently include parent uncommitted changes. A dirty parent requires explicit
committed-base selection or rejection with guidance. The child must receive its
actual workspace path and the difference from parent state.

Return base/head IDs, complete changed-file inventory including untracked files,
and a bounded patch/artifact reference. Preserve dirty worktrees on failure or
cancellation. Cleanup only explicitly owned clean worktrees after preserving any
new commits through a durable owned Git ref or verified bundle. Clean status alone
is insufficient: retain a worktree with unpreserved detached-HEAD commits. Never
auto-merge, push, discard changes, or delete arbitrary paths. Worktree isolation does not
isolate ports, databases, credentials, package caches, or other external effects.

Acceptance: parallel workers touching the same relative file, dirty parent,
ignored/untracked outputs, binary changes, cancellation, worker-created commits
leaving clean status, and cleanup refusal for unowned/dirty paths or unpreserved
commits. Existing nonisolated calls stay unchanged. Reuse Git-common-dir
identity patterns from `session-coordinator/state.ts` where useful.

## 08 — Tool activation correctness and discovery

First add dedicated `tests/integration_bundles*.test.mts` against current behavior.
Investigate/fix scout-identified risks before expanding the surface:

- Unique-union tool counts for overlapping bundles and router/base tools.
- A truthful failure when requested tools cannot fit, rather than success after
  immediate eviction; define behavior when pinned tools alone exceed budget.
- Preserve explicit user/core tool exclusions and manual selections instead of
  unconditionally enabling every non-bundle tool.
- Make recency semantics accurate: either track actual use or call it load-recency.

Then extend current list/load/unload machinery with bounded search over registered
names/descriptions and pi-shared capability groups. Extract `catalog.ts`/`policy.ts`
only as needed. Retain enterprise names as compatibility entrypoints if a neutral
router is introduced; do not add a second competing active-set controller.

Pi 0.85.1 supports `getAllTools`, `setActiveTools`, and additive tool discovery.
Use those APIs; extension/schema activation is not lazy module import or deferred
service startup. Check whether the SDK exposes enough provenance to distinguish
user exclusions from extension hiding; if not, conservatively preserve the initial
allowed set and defer expansion rather than overriding user choices.

Acceptance: overlapping groups, explicit exclusions, budget overflow, repeated
loads, unload/reload, provider change, and a real session where newly enabled tools
are callable next turn. Preserve the MCP gateway's independent discovery boundary.

## 09 — Safer edit previews

Prefer a separate opt-in `safe_edit` extension or an upstream proposal, not an
unannounced override of `edit`. First support expected file hashes, exact-match
replacements, preview diffs, and single-file apply with stale-input rejection.
Reuse Pi's exported file mutation queue and existing edit semantics where supported;
feature-detect availability instead of patching installed dependencies.

Acceptance: changed-since-preview content, symlink aliases, nonunique matches,
Unicode/newlines, concurrent edits through cooperating Pi tools, and unchanged
built-in behavior. Cross-process editors are not covered by an in-process queue;
state that limitation and recheck immediately before replacement.

Multi-file prevalidation can be a follow-up, but do not label sequential renames
as crash-safe atomicity. A real multi-file transaction requires a separate recovery
journal/locking design and explicit support guarantees. Defer crash-safe multi-file
transactions and LSP rename application until that design is reviewed.

## 10 — Context deduplication

Confirmed locally: `~/.pi/agent/AGENTS.md` and this repository's `AGENTS.md` resolve
to the same file. Pi 0.85.1's `loadProjectContextFiles()` deduplicates lexical paths,
so these aliases survive as separate context entries.

Preferred permanent fix: upstream canonical-path deduplication in the resource
loader with ordering/precedence tests. Do not edit global `node_modules` as the
source of truth. If needed, prototype a disableable pi-shared extension using
`before_agent_start.systemPromptOptions.contextFiles` and documented prompt
rebuilding APIs; validate compatibility first and preserve custom prompts and
other extensions' additions.

Only deduplicate the same canonical resource with unchanged content, preserving
its most-specific occurrence and reporting aliases locally. Do not remove separate
files just because their prose is similar or identical: their scopes may differ.
Retain distinct ancestor rules. Avoid logging prompt bodies.

Acceptance: symlink duplicate, distinct identical-content files, ancestor ordering,
linked worktrees, custom system prompt, other prompt-modifying extensions, reload,
and unavailable SDK hook. Upstream submission requires separate user approval.
This is independent of broader editorial reduction of repeated routing guidance.

## Validation and rollout

For each unit:

1. Capture failing/characterization fixtures before behavior changes.
2. Implement only the unit; wire targeted tests and document defaults/limitations.
3. Run targeted tests, `npm test`, and relevant Python tests. Run
   `python3 -m pytest tests/` at each release gate affecting install/checker/catalog
   behavior; record baseline failures separately rather than silently fixing them.
4. One independent reviewer checks lifecycle, authority, compatibility, evidence
   correctness, and regression coverage. Follow-up review only for material changes.
5. Run a disposable-profile/local-fixture smoke; do not change live profiles or
   `/reload` the user's session automatically. Explicit activation follows approval.
6. Inspect `git diff --check` and `git status --short`; remove generated fixtures and
   report intentional changes. Commit/push only within the user's authorization.

Feature-specific measurable outcomes: bounded output/disk use under flood fixtures;
no in-group descendants after confirmed normal cancellation, explicit uncertainty
otherwise; no false verification passes;
fresh code navigation after edits; reproducible browser failure evidence; reduced
active-schema/context size without losing needed tools or instructions. Establish
before/after measurements rather than claiming speculative percentage gains.

## First implementation brief

**Start with 01a/01b only.** Deliver `command_job`, command IDs in `wait_for`, bounded
private logs, process outcome/readiness separation, owner-loss reporting, README,
and automated/live-process tests. Preserve current tools and subagent schemas.

Not in the first slice: reboot persistence, autonomous resume, tool bundling,
verification adapters, language servers, edits, worktrees, or browser changes.

Completion demonstration: launch a passing command, a failing command, and a local
ready-then-failing server; wait without LLM polling; inspect exact outcomes and
bounded logs; cancel a process tree; confirm no normal-shutdown leaks and no
regressions in existing subagent/wait tests. Document hard-crash limitations.

## Evidence inspected

Existing paths (new paths above are proposals):

- `extensions/_shared/{managed-process,shell-process,job-store,file-lock,pi-agent-runner,subagent-scheduler,structured-output}.ts`
- `extensions/{spawn-subagent,wait-for}/index.ts` and their READMEs
- `extensions/tool-summary/{index,policy,state}.ts`
- `extensions/integration-bundles/index.ts`
- `extensions/pi-browser-capture/src/app-testing.ts` and package README
- `extensions/session-coordinator/state.ts`
- `bin/pi-profile-check`, `bin/pi-browser-check`, `bin/pi-shared-check-deps`
- `lib/probe_extensions.mjs`, root `package.json`, existing test inventory
- Installed Pi `docs/extensions.md`, `docs/packages.md`,
  `examples/extensions/prompt-customizer.ts`, and
  `dist/core/resource-loader.js:loadProjectContextFiles()`

Reconnaissance is not proof that proposed features work. Scout-identified edge
cases require reproduction tests in their implementation unit.
