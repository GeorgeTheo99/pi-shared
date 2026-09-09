# Development tooling implementation

Companion to [the roadmap](development-tooling-roadmap.md). This records delivered
MVP boundaries, not permission to activate profiles, deploy, push, or submit upstream.

## Implemented locally

| Roadmap | Delivery | Entry point / documentation |
|---|---|---|
| 01 | Bounded owner-lifetime commands, logs, readiness, cancellation; mixed job waits | [`command_job`](../../extensions/command-jobs/README.md) and `wait_for` |
| 02 | Config/digest-trusted checks, TAP/JUnit/exit adapters, source/report freshness | [`verify`](../../extensions/verification/README.md) |
| 03 | Read-only TS/JS definition/reference/hover/diagnostics via fresh LSP process | [`code_intel`](../../extensions/code-intel/README.md) |
| 04 | Static-first environment evidence with opt-in probes | [`dev_doctor`](../../extensions/dev-doctor/README.md), `bin/pi-doctor` |
| 05 | Lossless JSON Pointer selection with explicit source and provenance | [`tool_result_recall`](../../extensions/tool-summary/README.md) |
| 06 | Isolated private app contexts, viewport presets, assertions, snapshots/traces | [`app_test`](../../extensions/pi-browser-capture/README.md) |
| 07 | Explicit committed-base, retained one-shot worker worktrees | [`spawn_subagent`](../../extensions/spawn-subagent/README.md) |
| 08 | Conservative eligibility, correct union budgets, bounded discovery | [`enterprise_list_bundles`](../../extensions/integration-bundles/README.md) and load/unload |
| 09 | Exact single-file preview/apply with hash and identity rechecks | [`safe_edit`](../../extensions/safe-edit/README.md) |
| 10 | Pinned upstream patch prepared locally; not installed/submitted | [Context deduplication patch](../upstream/context-dedup/README.md) and [boundary](context-dedup-boundary.md) |

These are intentionally bounded first versions. Command execution is not crash-
supervised; worktree isolation is foreground/single/one-shot only and retains work;
LSP queries restart the server rather than keeping potentially stale state; JSON
recall supports JSON Pointer, not JSONPath; safe edits are not multi-file transactions.
Doctor inventory is not execution readiness. Browser retention limits are not hard
runtime disk quotas. See each extension README for exact limits and supported scope.

## Activation prerequisites

No live profile settings, project trust grants, app credentials, or model selections
were changed during implementation. This working copy has prepared, Git-ignored
`.pi/verification.json` (`node-suite` / `python-suite`) and `.pi/code-intel.json`.
Their schemas, declared source scope, and executable accessibility were checked
without granting trust or starting a language server.

1. Review the changes and use the user-facing `/reload` (or restart Pi) to load the
   updated extension code. Current sessions keep their already-loaded tool inventory.
2. `command_job`, `safe_edit` apply, and `code_intel` require Pi project trust.
3. For `verify`, review the prepared `.pi/verification.json` (or create one in
   another project), then explicitly invoke `/verification-trust`; approval binds
   to that exact config digest and runtime.
4. For `code_intel`, review the prepared `.pi/code-intel.json` or create one with explicit installed executable,
   language-server args, workspace, and optional tsserver path. The extension does
   not run installers or choose an arbitrary project executable automatically.
5. For app testing, select the intended `BROWSER_MCP_APP_BASE_URL` / allowed hosts.
   Isolated contexts do not copy authentication from the existing persistent browser.
6. Broader lazy groups are discoverable but only configured eligible bundles can be
   activated; the discovery router does not override user/core tool exclusions.

Pinned local dependencies for code intelligence and JUnit were installed only under
those extension directories with install scripts disabled. They remain ignored
runtime artifacts; package manifests and lockfiles are the shareable source of truth.

## Verification commands

Root `npm test` includes command jobs, verification, code intelligence, doctor,
JSON recall, isolated app testing, integration-bundle regression tests, and all
previous root Node suites. Real installed-Pi compatibility tests use synthetic
model streams/disposable profiles, not paid provider calls. The browser suite uses
local fixture servers and real Chromium, including a real trace-expiry timer.

- `npm test`
- `pytest tests/ -q` (the machine's existing pytest entry point; its default
  `python3` does not currently have pytest installed)
- `bin/pi-shared-check-deps`
- `bin/pi-doctor --json` (static only; not an execution-readiness claim)
- `git diff --check`

## Release audit — 2026-09-08

| Check | Result |
|---|---|
| Root `npm test` | 446 passed, 1 platform-dependent filename skip; zero failures |
| `pytest tests/ -q` | 188 passed, 1 optional alias-fixture skip; 17 subtests passed |
| Installed Pi SDK smoke | Finalized wait/subagent failures have native `isError:true`; real safe-edit APIs work |
| Disposable package import | 25 extensions imported without errors; no live-profile activation |
| Dependency checker | All six declared module/bin-only dependencies resolve |
| Doctor static smoke | `inspection_complete`; models/extensions/browser execution correctly remain unexercised |
| Local staged configurations | Both verification scopes known (284 source files); LSP status configured, execution not started |
| Independent review | Lifecycle, queued cancellation, FIFO and native error-propagation findings fixed; scoped follow-ups passed |
| Repository/artifact audit | Diff whitespace and local documentation links pass; no retained test worktrees or task language-server processes |

The SDK fixture additionally passed with an inherited subagent depth of 1 after
isolating its own depth/state, without spawning a child or making a model call.
Test skip details were checked separately. No core patch was installed for unit 10.

At the initial audit, changes were intentionally left uncommitted for user review.
The user subsequently authorized committing and publishing the complete tooling
changes. Local `.pi` configs and extension `node_modules` remain ignored runtime
setup, not shareable machine configuration. The upstream core patch is still only
a prepared artifact; publishing this repository does not install or submit it upstream.

## Live activation follow-up

After the user's reload/resume, native tool calls confirmed:

- `code_intel` resolved `commandStateDir()` from its call site to line 31, with
  unchanged before/after fingerprints over 188 TS/JS/JSON files and server exit.
- `command_job` and `wait_for` preserved an intentionally failing command's exit
  code 7, confirmed cleanup, and exact stderr. Audit job:
  `cmd_44872c04-7384-428d-9203-091bda5fd469` (subject to normal history retention).
- `safe_edit` preview/apply produced the expected content/hash; its temporary
  `.pi/tool-activation-smoke.txt` was verified and removed.
- `dev_doctor` reported successful dependency resolution without claiming model,
  browser, or extension-execution readiness. Discovery found active `code_intel`;
  no master bundle list is configured, so activation management remains disabled.

After the user's verification approval, both native `verify run` calls passed for
configuration digest `4ac01ddb04a8c2fcc7e5f5afbe7e2131a60235672df88c3a91dcfcd6c8dc08ab`:

| Check | Live job | Result |
|---|---|---|
| `node-suite` | `cmd_704d25b2-1fba-40d6-be82-2bac07bf280a` | Passed; exit 0; 446 Node tests passed, 1 skipped |
| `python-suite` | `cmd_51fc901c-e953-4921-9f30-5d04f5825b3c` | Passed; exit 0; 188 Python tests passed, 1 skipped; 17 subtests passed |

Both jobs have confirmed cleanup and untruncated stdout. Subsequent `verify result`
queries still returned passed with unchanged source/report/config evidence. The
configured verifier checks use exit-code evidence; counts above were separately
read from the retained test logs, not inferred by the verifier. Approval was not
bypassed; reload or a changed configuration would require a fresh approval.

## Upstream patch handover

The remaining core change is prepared in
[`docs/upstream/context-dedup/`](../upstream/context-dedup/README.md), pinned to
upstream commit `b2602be77cb7b0de45dd616407fd210daa48aa75`. Parent-run validation
(`cmd_0d8295c4-59a5-45d1-ac27-28a8390eef3b`) passed 24 extracted-loader regression
checks, source/patch/output hashes, and forward/reverse patch applicability, with
exit 0 and confirmed process cleanup. An independent reviewer reran those checks
and found no material issues for a **prepared-not-installed patch**.

This does not establish native upstream Vitest/full-suite/typecheck compatibility.
Those gates must run in a proper upstream checkout before any submission or
installation. No Pi-core installation, live prompt rewrite, or external submission
has occurred. The user's remaining decision is whether to pursue that separate
core change or retain the currently installed Pi while using the completed tooling.
