# pi-shared

Shared pi instructions and explicitly shareable pi resources.

**Source of truth rule:** any shared Pi extension, skill, prompt, or theme placed in this repo should be treated as the canonical source of truth. Do not maintain parallel copies under `~/.pi/agent/...` on individual machines, or the resources will drift.

## Contents

- `AGENTS.md` — shared global pi instructions; symlink to `~/.pi/agent/AGENTS.md`.
- `extensions/` — shared pi extensions, including oversized tool-result summarization (`tool_result_recall`, `/tool-summary`), project memory (`memory_read`, `memory_write`, `/memory`), native subagents (`spawn_subagent`, `/subagents`), workflow orchestration (`workflow`, `/workflows`), same-process fresh-session handoff (`/self-handoff`), machine-local peer coordination (`peer_sessions`, `peer_send`, `peer_message_status`, `peer_acknowledge`), model-panel second opinions (`/panel`, `panel_models`, `panel_select`), local-search MCP-backed web search/fetch (`web_search`, `web_fetch`), `software-kb` tools (`kb_search`, `kb_read`, `kb_sources`), and commands (`/kb-search`, `/kb-sources`).
- `knowledge/software-engineering/` — shared source catalog/editorial cards plus optional private, page-cited PDF search. `kb_sources` distinguishes catalog availability from locally indexed content. Book originals/extracted text stay ignored and are not distributed; see [KB ingestion and verification](knowledge/software-engineering/README.md).
- `skills/` — shared skills only; local-only skills should live outside this repo, preferably under `~/local_code/pi-databricks/skills`.
- `prompts/` — shared prompt templates.
- `workflows/` — saved JavaScript workflows for the `workflow` tool (`<name>.js` invocable as `workflow({ name })`). Shared, committed; project workflows live under `.pi/workflows/`.
- `themes/` — shared themes.
- [Development tooling roadmap](docs/plans/development-tooling-roadmap.md) — proposed implementation sequence, tool contracts, acceptance criteria, and first delivery slice.
- `bin/pi-vanilla` — recovery launcher for a vanilla Pi session when shared/local harness resources break normal startup.
- `bin/pi-omlx-repair` — repair/wiring script for the dedicated `~/.pi-omlx/agent` Pi profile used by local oMLX/cloud model launchers.
- `bin/pi-catalog` — render Pi CLI artifacts (`models.json` + `pi-launchers.zsh`) from a `model-aliases.json` catalog (the model-gateway public contract). The Pi-side of the model-gateway/Pi separation: the gateway owns the generic catalog, pi-catalog owns Pi-specific rendering. Install per-machine via a `~/.local/bin` symlink.
- `bin/pi-shared-install` / `install.sh` — portable installer that symlinks shared helper scripts into `~/.local/bin`, wires this repo into `~/.pi/agent/settings.json`, and optionally renders initial Pi catalog artifacts.
- `lib/pi_catalog.py` — the importable module behind `bin/pi-catalog` (render functions + CLI).
- `tests/test_pi_catalog.py` — tests for the catalog renderer (`python3 -m pytest tests/`).

## Development tools

The [implementation guide](docs/plans/development-tooling-implementation.md) covers setup,
verification, and activation prerequisites for the development-tooling roadmap.

| Tool | Purpose |
|---|---|
| `command_job` + `wait_for` | Bounded local commands, readiness, logs, and explicit process outcomes |
| `verify` | Reviewed project checks with TAP/JUnit/exit evidence and source freshness |
| `code_intel` | Read-only TypeScript/JavaScript navigation and diagnostics |
| `dev_doctor` / `bin/pi-doctor` | Static environment inspection with explicitly selected probes |
| `tool_result_recall` | Exact text recall and lossless JSON Pointer selection |
| `app_test` | Isolated local/private browser contexts, assertions and failure evidence |
| `spawn_subagent` with `isolation:"worktree"` | Retained, committed-base single-worker Git isolation |
| `enterprise_list_bundles` | Bounded discovery without overriding user tool exclusions |
| `safe_edit` | Exact single-file preview/apply with stale-input rejection |

Existing `bash`, `read`, `edit`, persistent `app_*`, and public browser-worker tools
remain available. Reload/restart is a user action; verification trust and language-
server configuration are not granted automatically. None of these tools is an OS
sandbox, and process completion is not the same as test success or service readiness.

## Pi launcher profiles

Current launcher/profile split:

| Launcher | Profile | `pi-shared` behavior |
|---|---|---|
| `pi` | `~/.pi/agent` | Loads `pi-shared` through `settings.json`; `~/.pi/agent/AGENTS.md` should symlink to `pi-shared/AGENTS.md`. |
| generated `pi-*` model functions | `~/.pi-omlx/agent` | Must call `bin/pi-omlx-repair` before launch/reload so the profile loads `pi-shared`, local extensions, shared `AGENTS.md`, and the zero-usage context fallback. |
| `pi-vanilla` | `~/.pi/vanilla-agent` | Intentionally bypasses packages, extensions, skills, prompts, themes, and context files for recovery. Do not wire `pi-shared` into it. |

Future Pi launchers should follow one of two rules:

1. If they are normal/enhanced Pi sessions, load `pi-shared` as a package and use the shared `AGENTS.md`.
2. If they are recovery/minimal launchers, explicitly bypass shared resources and document that exception.

## Portable install

On a fresh Mac after cloning this repo:

```bash
cd ~/local_code/pi-shared
./install.sh
```

The installer is idempotent and safe to rerun. It:

- symlinks `pi-catalog`, `pi-omlx-repair`, and `pi-vanilla` into `~/.local/bin`
- ensures `~/.pi/agent/settings.json` includes this repo in `packages`
- symlinks `~/.pi/agent/AGENTS.md` to this repo's shared `AGENTS.md` unless a real file already exists
- if `~/.pi/model-aliases.json` exists, renders `~/.pi-omlx/agent/models.json` and `~/.pi/generated/pi-launchers.zsh`

Useful options:

```bash
./install.sh --no-catalog
./install.sh --force
./install.sh --aliases ~/.pi/model-aliases.json \
  --models-out ~/.pi-omlx/agent/models.json \
  --launchers-out ~/.pi/generated/pi-launchers.zsh
```

After catalog generation, source the launcher from your shell, for example:

```bash
[ -f ~/.pi/generated/pi-launchers.zsh ] && source ~/.pi/generated/pi-launchers.zsh
```

## Vanilla recovery launcher

`bin/pi-vanilla` starts Pi with an isolated config/session directory and disables all packages, extensions, skills, prompt templates, themes, and context files. It is meant as a safe recovery path when the normal Pi harness is broken.

Local install:

```bash
mkdir -p ~/.local/bin
ln -sfn ~/local_code/pi-shared/bin/pi-vanilla ~/.local/bin/pi-vanilla
```

Requirements and behavior:

- `pi` must be installed separately and available on `PATH`, or set `PI_VANILLA_PI_BIN=/path/to/pi`.
- It uses `~/.pi/vanilla-agent` and `~/.pi/vanilla-sessions` by default.
- If `~/.pi/vanilla-agent/auth.json` does not exist, it symlinks `~/.pi/agent/auth.json` so existing Pi login/auth can be reused without copying secrets.
- Defaults are `PI_VANILLA_PROVIDER=openai-codex`, `PI_VANILLA_MODEL=gpt-5.5`, and `PI_VANILLA_THINKING=high`; override those environment variables per machine if needed.
- Existing shell aliases/functions for `pi` do not affect `pi-vanilla`; if a machine already has a `pi-vanilla` alias/function, remove it or point it at this script.

## oMLX/cloud profile repair

`bin/pi-omlx-repair` repairs the dedicated `~/.pi-omlx/agent` profile used by generated `pi-*` model launchers. It resolves the pi-shared repo from its own script/symlink location, so it works outside `~/local_code`. It:

- writes `settings.json` so this `pi-shared` repo is loaded as a package
- includes the optional sibling `pi-databricks` package when present and removes its obsolete standalone resource entries
- symlinks `~/.pi-omlx/agent/AGENTS.md` to this repo's `AGENTS.md`
- preserves the installed Pi zero-usage context fallback and the local DSML output filter across Pi updates
- keeps superseded auto-retry failures out of restored model context and the visible transcript while preserving append-only audit/cost records, and uses protocol-neutral premature-stream wording

Run manually if needed:

```bash
~/local_code/pi-shared/bin/pi-omlx-repair
```

Current generated `pi-*` shell launchers call this automatically before writing models or launching Pi. Future launchers that set `PI_CODING_AGENT_DIR=~/.pi-omlx/agent` should do the same.

## Pi catalog rendering (model-gateway separation)

`bin/pi-catalog` renders Pi-specific artifacts from a `model-aliases.json` catalog — the public contract emitted by `model-gateway`. This keeps the gateway generic (no Pi config-schema knowledge) and Pi rendering in `pi-shared` (where the `models.json` schema lives). Either service can be installed without the other.

It reads the alias file and emits:

- `models.json` — a Pi provider/models config with capability-aware reasoning controls, protocol/tool/replay compatibility, api_type selection, vision heuristics, and anthropic baseUrl overrides.
- `pi-launchers.zsh` — `pi-<alias>()` + `pi-list` + `pi-restart` (+ optional `pi-default`/`pi-openai` via `--direct-launchers`). `pi-list` groups catalog launchers into local and cloud sections from the catalog's canonical `cloud:` key namespace, with direct Pi and management commands shown separately. No `claude-*`/`codex-*` — standardize on `pi`.

The model id in the launcher always matches the id in `models.json` (local = alias key / omlx_id, cloud = provider_model_id), so the two can never drift.

Prompt caching uses Pi's default short retention. The generated launchers do not
select provider-specific long retention or send session-affinity identifiers for
gateway analytics.

When a catalog entry includes `thinking_levels`, it is the authoritative ordered subset of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. `pi-catalog` nulls every unsupported Pi level, sends supported levels canonically to the gateway (`off` becomes `none` only where Pi's API encoding requires it), preserves strict `thinking: always` and optional-Off behavior, and renders an empty list as `reasoning: false`. Provider-specific effort translation remains in `model-gateway`. An explicit `pi.thinkingLevelMap` is the machine override; catalogs that omit `thinking_levels` retain the legacy generated maps.

Native image support remains authoritative through `vision: true`. A gateway alias export may declare `pi.image_input: gateway-assisted` when validated locality-scoped `extract_then_answer` policy gives a text-only route effective image handling; `model-gateway` derives this automatically for stable matching routes. `pi-catalog` preserves image blocks and labels those routes `assisted vision`, while `pi.image_input: disabled` remains an explicit per-route opt-out. Pi itself never guesses from a model name or silently enables image transport without the gateway contract.

Install per-machine:

```bash
mkdir -p ~/.local/bin
ln -sfn ~/local_code/pi-shared/bin/pi-catalog ~/.local/bin/pi-catalog
```

Generate for a dedicated gateway profile on any machine:

```bash
pi-catalog --aliases ~/.pi/model-aliases.json \
  --models-out ~/.pi-omlx/agent/models.json \
  --launchers-out ~/.pi/generated/pi-launchers.zsh \
  --pi-agent-dir ~/.pi-omlx/agent --direct-launchers
```

`--direct-launchers` adds `pi-default` and `pi-openai` independently of the
machine name or gateway catalog. `pi-openai` uses the **current machine's**
default Pi profile and ChatGPT subscription login (`/login` → OpenAI Codex),
not the gateway or an OpenAI API key. It does not sign in or copy credentials.

- Enable on an existing installation: `pi-regen --direct-launchers`.
- Disable: `pi-regen --no-direct-launchers`. New generated `pi-regen` functions
  validate and reload their launcher in the current shell after success.
- Both flags work with `pi-catalog` and `./install.sh`. When neither is given,
  generation preserves the selection in the existing recognized launcher;
  a fresh installation defaults to off. The installer also accepts
  `PI_SHARED_DIRECT_LAUNCHERS=1` or `0`; explicit CLI flags take precedence.
- `--ls99-extras` and `PI_SHARED_LS99_EXTRAS` remain deprecated compatibility
  aliases. The canonical environment variable takes precedence over the old
  one. Regenerated `pi-regen` commands always use the portable spelling.
- New model configs use the provider label `model-gateway`. Existing single-provider
  model outputs keep their label (including `ls99-models`) unless
  `--provider-name` explicitly overrides it. Multi-provider outputs require an
  explicit provider name. Launcher-only generation without `--models-out`
  cannot infer an existing model provider; pass `--provider-name` in that case.

### Commands before model configuration

```bash
./install.sh --bootstrap-launchers --direct-launchers
source ~/.pi/generated/pi-launchers.zsh
pi-list
```

`--bootstrap-launchers` (`PI_SHARED_BOOTSTRAP_LAUNCHERS=1`) opts into management-only
launchers when the alias catalog is missing or `{}`. It provides `pi-list`,
`pi-regen`, `pi-shared-update`, and `pi-restart`, plus the two direct launchers
when enabled. No placeholder alias file or models.json is created, and existing
models.json files/symlinks are preserved. A missing catalog cannot replace an
existing configured/custom launcher. Invalid catalogs still fail closed.
`--no-catalog` remains an explicit generation opt-out; older installer clients
keep their original missing-catalog behavior unless they request bootstrap.

The renderer flag is `pi-catalog --allow-empty-catalog`. Generated `pi-regen`
preserves that option, but refuses to erase configured launchers if a catalog
later disappears. Once a real gateway alias export is configured at the shown
path, `pi-regen` writes the models and reloads the model shortcuts. The installer
prepares their profile in advance. Direct `/login` configuration alone does not
create a gateway alias export. `pi-list` reports this unconfigured state without
claiming gateway models are ready.

Generated launchers append `~/.local/bin` to PATH once, preserving existing
precedence, so module-owned operator commands are available. `pi-restart omlx`
uses server-ci on managed hosts, otherwise the installed oMLX app/Homebrew CLI;
it does not install or adopt a service.

Keep each machine's alias input, gateway URL, profile/output paths, and login
local. Generate independently on each host; do not copy generated launchers or
credentials between machines. Provider labels are just Pi identifiers, not
hostnames: a legacy `ls99-models` label can still point at this machine's local
gateway. There is no automatic renaming of saved Pi sessions or settings.

The generated launcher bakes in a `pi-regen()` function so it can refresh itself + `models.json` after a catalog change. In a managed pi-setup installation, `pi-shared-update` delegates to `pi-shared update`, which uses the saved selection and updates the owning CLI/runtime, selected modules and dependencies before checking and refreshing commands. Without that coordinator/receipt, it explicitly reports a resource-only update and retains the legacy fast-forward/regenerate/reload behavior. `pi-restart model-gw` auto-calls `pi-regen` — it delegates to the portable `model-gateway restart` command when available, falls back to `server-ci restart --model-gw` on ls99/dev-server installs, then refreshes the Pi artifacts. No Git or launchd watcher is needed.

### Automatic prompt refresh

Interactive generated launchers register one idempotent zsh `precmd` hook. The
trusted `bin/pi-launchers-refresh` helper fingerprints bounded local inputs;
unchanged inputs do not regenerate. The first prompt establishes the baseline.
Changed catalog/launcher data regenerates and reloads commands, retiring only
previously registered generated model functions. `pi-shared` is a reserved alias
so a model shortcut cannot shadow the updater.

The helper parses generated JSON argument metadata rather than evaluating old
shell text. Only recognized options, matching installation/output identities and
owned, non-shared-writable files/directories are accepted. It sends arguments to
`pi-catalog --args-stdin` to avoid exposing stored gateway keys in process argv.
Generated outputs are mode 0600. Automatic refresh is offline; minimal cached
previously observed context/output/thinking hints are retained, not re-probed.
`pi-catalog --offline` is also available explicitly.

A generated model-output digest prevents automatic overwriting of manual model
edits. Inspect/reconcile configuration before explicit regeneration in that case.
Unchanged failures warn once, not at every prompt, and do not exit an errexit
shell. Prompt refresh skips while a managed setup/update holds its lock. There
are no background upgrades, Git fetches, service restarts, model downloads or
provider/model calls. Source the new launcher or open a new shell once to load
the hook into an older session. See pi-setup's `docs/updates.md` for the complete
update and migration contract.

For a machine that does NOT use the local model-gateway (e.g. Pi hitting Databricks directly), point `--gateway-url` at the endpoint and `--provider-name` at the Pi provider, and feed a catalog alias file from whatever source is appropriate.

## Included shared extensions

- `extensions/tool-summary` — raw-first oversized tool-result summaries:
  - leaves exact originals intact in session JSONL/history and substitutes only through Pi's ephemeral `context` hook after one raw provider exposure
  - runs active-session-model summaries in the background through `@earendil-works/pi-ai/compat` with low summarizer reasoning where supported; unfinished or cooling-down work leaves provider context raw and never changes the main session thinking level
  - freezes the first valid model/deterministic summary by tool-call ID, raw SHA-256, and policy version; model failures leave raw context and persist exponential retry cooldowns instead of terminal deterministic fallbacks; stale branch/session completions are rejected
  - defaults to 16K standard and 24K high-fidelity thresholds; exempts `memory_read`; deterministic reductions reserve every recognized non-2xx HTTP status and diff file header or keep the result raw when they cannot fit; retains a 3K target, 4K hard cap, and 40% minimum savings requirement
  - provides exact bounded `tool_result_recall` search/head/tail/line-range retrieval plus live `/tool-summary on|pause|off|status|threshold|reset` controls; see `extensions/tool-summary/README.md`
- `extensions/memory` — machine-local, project-only memory:
  - stores canonical JSON in `~/.pi/memory/projects/`
  - injects active memories into the prompt as untrusted project context
  - provides `memory_read` and `memory_write` tools plus `/memory [active|all|review|path|help]`
  - memory hygiene happens during normal session work: read relevant memories before relying on prior state, write/update verified durable facts while evidence is fresh, and archive stale entries before finishing substantive work
  - global memory is intentionally not implemented; store only evidence-backed durable project-specific facts and never secrets, global/user-wide preferences, transient task state, todos, guesses, or raw logs
- `extensions/websearch` — local-search MCP-backed web tools:
  - `web_search` calls the MCP broker tool `web_search(query, num_results)`
  - `web_fetch` calls the MCP broker tool `web_fetch(url, max_chars)`
  - the broker is the stable entry point and owns provider policy. The standalone `local_web_search` service uses Brave Search and its own bounded fetch fallbacks; Pi does not bypass the broker. See `extensions/websearch/README.md`.
- `extensions/goal` — durable `/goal` loop for long-running work:
  - `/goal <objective> [--max-turns N]` starts a user-requested goal
  - `/goal status`, `/goal pause`, `/goal resume`, `/goal reclaim`, `/goal clear` control it
  - pressing Escape while an active goal's agent turn is running pauses autopilot without consuming the interrupted turn; run `/goal resume` to continue
  - `start_goal` lets the agent create a durable goal from a normal session when the user explicitly requests or strongly implies multi-turn/autonomous tracking
  - `update_goal` lets the agent log progress, mark completion after evidence audit, or stop when blocked
- `extensions/self-handoff` — user-invoked stock-Pi fresh-session continuation:
  - `/self-handoff [focus]` in interactive TUI mode with an existing persisted session file waits for idle, generates a best-effort-redacted continuation for user review, then creates a fresh session in the same Pi process
  - the fresh child uses an orientation-only first turn to show a concise handoff summary and numbered proposed next steps, then waits for the user's next explicit message before beginning work
  - transfers the latest active goal while preserving its identity and remaining turn budget without charging the orientation turn, and copies the latest non-empty work plan into the child; exact parent/child IDs and paths, session-wide audit checks, and an exclusive ownership lock gate goal finalization/reclaim
  - intentionally is not an LLM tool: stock Pi exposes session replacement only to user command contexts
  - see `extensions/self-handoff/README.md` for cancellation, `/goal reclaim`, and stock Pi's non-transactional replacement limits
- `extensions/session-coordinator` — machine-local presence and asynchronous peer coordination:
  - `peer_sessions` lists live sessions machine-wide or project-scoped with advisory branch/worktree/activity metadata and bounded Git workspace changes
  - `peer_send` defaults to notifications; opt-in `requestResponse: true` asks for one reply on the recipient's next normal turn, with pending/answered status and durable duplicate-reply protection. No message wakes or interrupts a peer
  - `peer_message_status` exposes truthful `pending`, `queued`, `delivered`, `surfaced`, `acknowledged`, `replied`, `expired`, and `unread_session_ended` checkpoints; `surfaced` never claims read
  - exact same-session successors can safely adopt unread dead-runtime inboxes; ambiguous, different-session, and legacy ownership fails closed
  - see `extensions/session-coordinator/README.md` for storage, compatibility, lifecycle, and trust semantics
- `extensions/pi-browser-capture` — standalone public-browser wrappers plus unchanged local app testing:
  - exactly two public browser tools backed by browser-worker: `browser_fetch` for one-shot rendered retrieval and `browser_inspect` for short-lived sessions/actions
  - `app_*` tools for local/private web app testing remain in-process and unchanged: `app_open`, `app_click`, `app_type_text`, `app_wait_for`, `app_extract_text`, `app_screenshot`, `app_console_logs`, `app_network_log`, `app_api_request`, `app_page_state`, and tab helpers
  - browser-worker enforces authenticated public-network-only egress; the retired granular public `browser_*` family must never be loaded with the two worker tools
- `extensions/spawn-subagent` — native subagent delegation:
  - `spawn_subagent` keeps existing isolated `pi --mode json -p --no-session` behavior for non-interactive single, parallel, or chained specialist work
  - opt-in single-mode `interactive:true` uses one persistent RPC child for 10 correlated `ask_parent` exchanges by default (20 maximum); resume with `jobAction:"answer"`, the current `jobId`, and exact `questionId`
  - live owner-session interactive jobs accept acknowledged `jobAction:"steer"` and `"followup"` controls; coordination messages are bounded and explicitly untrusted
  - questions/answers are bounded and explicitly untrusted tool-result data; parked children release the scheduler lease and reacquire it before an answer resumes work
  - optional bounded `outputSchema` contracts validate exact JSON for one-shot single, parallel, and chain runs; chain handoffs isolate prior output in an untrusted JSON envelope
  - parallel tasks and chain steps may specify task-level `model`, `thinking`, `agentDir`, and `outputSchema` overrides; child thinking defaults explicitly to `high`
  - bundled shared agents: `scout`, `planner`, `reviewer`, `worker`, `panelist`
  - default fan-out is 16 tasks with a host-wide 8-child concurrency lease shared by `spawn_subagent`, `workflow`, background jobs, and independent Pi processes; foreground priority, starvation aging, and optional provider pools keep the queue responsive
  - background job completion is a UI notification in interactive/RPC sessions, never an injected LLM-context message; fetch/list/cancel jobs with `jobAction: "status"` / `"list"` / `"cancel"`
  - `wait_for({jobs:[...]})` wakes on `awaiting_answer` as well as terminal completion, preventing parent/child wait deadlocks
  - background records use locked, atomic, owner-leased persistence so one Pi process cannot falsely fail or overwrite another process's live jobs
  - `/subagents [shared|user|project|all]` lists available agents
  - project-local `.pi/agents` are not read unless the project is trusted or the user grants explicit interactive approval
- `extensions/panel` — user-invoked alternate-model second opinions:
  - `/panel` asks a runtime-selected alternate model for a second opinion on the current conversation or an explicit task
  - `/panel --compare` runs multiple model families through `spawn_subagent` in parallel and asks the main session to synthesize
  - `/panel --list [search]`, `panel_models`, and `panel_select` use Pi model registries for portable runtime model discovery, including the alternate `~/.pi-omlx/agent` profile by default; lists disclose `vision`/`text-only` capability and `panel_select({requiresImages:true})` fails closed to vision-capable choices
  - when a text-only model omits an image, the agent can delegate the accessible local path to a vision-capable panelist and consume bounded textual observations without putting image bytes in the parent request history
  - optional model preferences/exclusions live in `~/.pi/panel-config.json` or project `.pi/panel-config.json`; trusted `modelProfileDirs` overrides are honored only from `~/.pi/panel-config.json`
- `extensions/workflow` — trusted JS workflow runner on top of Pi subagents:
  - `workflow` runs a JavaScript workflow body (inline `script`, saved `name`, or `scriptPath`) whose primitives are Pi subagent calls
  - workflow globals: `agent(prompt, opts?)`, `parallel(thunks)`, `phase(title)`, `log(message)`, `args`, `cwd`; workflow-level and per-agent `thinking` overrides default to `high`
  - shared agents only in v1 (`scout`, `planner`, `reviewer`, `worker`, `panelist`); each `agent()` call uses the same scheduler, managed process lifecycle, model/profile routing, and bounds as `spawn_subagent`
  - saved workflows: `pi-shared/workflows/<name>.js` (shared, committed) or `.pi/workflows/<name>.js` (project, requires trust); `/workflows` lists them
  - inline JavaScript always requires explicit interactive approval; noninteractive workflow use must resolve to a trusted or allowlisted file
  - use for repeatable, multi-phase, scriptable orchestration; use `spawn_subagent` for ordinary one-off single/parallel/chain delegation
  - resume-by-replay journals are context-bound, exact, locked, and atomic; stale, corrupt, colliding, or oversized replay data fails closed
  - v1 scope: Pi-backed subagents only and no workflow-level structured-output schema validation
- `extensions/integration-bundles` — lazy enterprise tool-bundle loader driven by a machine-local `master_integration_list.yaml`:
  - keeps GPT / o-series safely under OpenAI's 128-tool API limit by exposing only a router toolset by default and loading bundles (jira, slack, glean, salesforce, google-workspace, databricks-aidk, ...) on demand
  - injects an `<available_bundles>` block into the system prompt with NL `description` text so the model can self-discover when to load each bundle
  - regex `triggers` auto-load high-confidence bundles (e.g. `ES-12345` → `jira`) before the first turn
  - LRU-evicts non-default bundles when a new load would exceed the per-model cap; Claude / Sonnet / Opus / Gemini have `max_tools: null` and load everything eagerly
  - exposes `enterprise_load_bundle`, `enterprise_unload_bundle`, `enterprise_list_bundles` tools and a `/bundles` slash command
  - skill-driven loading: any skill `SKILL.md` whose YAML front-matter declares `requires_bundles: [...]` will pre-load those bundles when the skill name is mentioned in the user message
  - configuration is machine-local (not in this repo): resolved from `$PI_INTEGRATION_LIST` or `~/.pi/agent/master_integration_list.yaml` (on Databricks machines this is a symlink into the local Databricks-specific package). Domain-specific bundle definitions do not belong in pi-shared.

## Included shared skills

- `skills/frontend-design` — high-quality frontend/UI design skill for building polished, distinctive web interfaces
- `skills/handoff` — writes a structured continuation handoff for a fresh Pi session
- `skills/panel` — orchestrates `/panel` second-opinion, image-capable delegation, and multi-model compare workflows using `panel_select` plus `spawn_subagent panelist`
- `skills/resume-handoff` — resumes from the most recent handoff file and verifies current repo state before continuing

## Shared vs local-only setup

Use this simple mental model:

```text
~/local_code/pi-shared/  = shared by git across machines
~/local_code/pi-databricks/   = private to this machine
```

### What goes in `pi-shared`

Put resources here only when they should travel to every machine that installs this repo:

```text
~/local_code/pi-shared/AGENTS.md      # shared Pi instructions
~/local_code/pi-shared/skills/        # shared skills
~/local_code/pi-shared/extensions/    # shared tools/extensions
~/local_code/pi-shared/prompts/       # shared prompt templates
~/local_code/pi-shared/themes/        # shared themes
~/local_code/pi-shared/bin/           # shared helper launchers/scripts, including pi-vanilla and pi-omlx-repair
```

When you `git add`, `git commit`, and `git push` from `pi-shared`, those resources become available to other machines after they `git pull` and run `/reload` in Pi. Helper launchers in `bin/` also need a local symlink or PATH entry on each machine.

### Maintainer Git topology

On the maintainer server, the local bare repository is the authoritative Git remote for day-to-day work:

```text
~/local_code/pi-shared   --push origin-->   ~/repos/pi-shared.git
                                      \
                                       --manual publish--> GitHub
```

The checkout keeps two remotes:

- `origin` — `~/repos/pi-shared.git`, the authoritative local bare repository
- `github` — the public GitHub mirror used for distribution to other machines

GitHub publishing is intentionally **not automatic**. Update the local source of truth first, then publish the same commit explicitly:

```bash
git push origin main
git push github main
```

Confirm both refs match with `git rev-parse origin/main github/main`. Consumer machines may clone or pull the GitHub repository normally; this maintainer-only topology does not apply to them.

Secret scanning is enforced in three layers: tracked pre-commit/pre-push hooks,
the local bare repository's pre-receive hook, and the pinned GitHub Gitleaks
workflow. Install Gitleaks and activate the tracked worktree hooks once per
clone:

```bash
brew install gitleaks
git config core.hooksPath .githooks
```

Do not bypass a failed scan. `.gitleaksignore` contains only exact fingerprints
for synthetic test credentials; never allowlist an entire file or credential
pattern.

### What goes in `pi-databricks`

Put machine-specific resources here. Do not commit this directory to `pi-shared`.

```text
~/local_code/pi-databricks/AGENTS.md       # local-only project instructions
~/local_code/pi-databricks/skills/         # local-only skill source
~/local_code/pi-databricks/extensions/     # local-only tools/extensions
~/local_code/pi-databricks/prompts/        # local-only prompt templates, if needed
~/local_code/pi-databricks/themes/         # local-only themes, if needed
```

Recommended local-only skill pattern:

```bash
mkdir -p ~/local_code/pi-databricks/skills/my-private-skill
cat > ~/local_code/pi-databricks/skills/my-private-skill/SKILL.md <<'MD'
---
name: my-private-skill
description: What this private machine-local skill does and when to use it.
---

# My Private Skill

Instructions go here.
MD

mkdir -p ~/.pi/agent/skills
ln -sfn ~/local_code/pi-databricks/skills/my-private-skill ~/.pi/agent/skills/my-private-skill
```

Recommended local-only extension pattern:

```bash
mkdir -p ~/local_code/pi-databricks/extensions
# Add local extension files here, then include this path in local Pi settings if needed.
```

Recommended shared-skill pattern:

```bash
mkdir -p ~/local_code/pi-shared/skills/my-shared-skill
$EDITOR ~/local_code/pi-shared/skills/my-shared-skill/SKILL.md
cd ~/local_code/pi-shared
git add skills/my-shared-skill/SKILL.md README.md
git commit -m "Add shared my-shared-skill skill"
git push
```

After adding or changing skills/extensions, run `/reload` in Pi.

Avoid using the same skill `name` in both local-only and shared locations. Pi warns on duplicate skill names and keeps the first discovered copy, which can be confusing.

## This machine setup

This repo is loaded by Pi through the `packages` setting. On this machine it is configured globally in `~/.pi/agent/settings.json` as:

```json
{
  "packages": ["../../local_code/pi-shared"]
}
```

Project-local setups can instead use `../pi-shared` from `~/local_code/.pi/settings.json`: Pi resolves package paths against the settings file's directory, not the shell's working directory. The installer already registers the package globally, so a second project entry is normally unnecessary. After editing shared Pi resources in the repo, run `/reload` in Pi.

## MCP discovery

There are two intentional connection paths; `/mcp` is not a complete inventory of all MCP-backed capabilities:

| Capability | Connection owner | Discovery |
|---|---|---|
| Configured servers such as Blender/FreeCAD | Optional `pi-mcp-adapter` package | `/mcp` |
| `browser_fetch`, `browser_inspect` | Native `pi-browser-capture` wrapper → independent browser-worker MCP | `/mcp-connections` or `dev_doctor` |
| `web_search`, `web_fetch`, `deep_research` | Native wrappers → independent search MCP broker | `/mcp-connections` or `dev_doctor` |
| `app_*` | In-process private-app browser runtime, not MCP | Pi tool inventory |

`/mcp-connections` is a read-only command provided by `extensions/dev-doctor`. It combines adapter-reported metadata with current-runtime, source-checked wrapper tool registration, without opening connections, reading credentials, or launching servers. Cached metadata, registered tools and active tools are **not service-readiness checks**. If the adapter is absent or has not published a snapshot, its status remains unknown. `dev_doctor` includes the same section; the standalone `bin/pi-doctor` cannot observe the active Pi runtime.

Keep the wrappers and servers separate. Do not also register the browser/search servers in the adapter merely to make them appear in `/mcp`; that can create duplicate tool routes and bypass wrapper-specific behavior. Repository folders under `local_code` are not scanned to discover servers.

## Installation verification

`bin/pi-shared-install --aliases PATH --overlay /path/to/overlay` wires the
shared and overlay packages into both the default profile and the generated
model profile. This does not depend on `~/.local/bin` being in a later shell's
`PATH`. Generated launchers call the repair helper by absolute path only when
launching Pi; sourcing the launcher no longer runs repair or patches Pi.

```bash
bin/pi-profile-check --agent-dir ~/.pi-omlx/agent --require-models \
  --expect-package "$PWD"
python3 bin/pi-browser-check
```

The profile check loads extensions through the installed Pi SDK, inspects its
error list, and fails on process errors, missing reports, or timeouts. It does
not call a model or source shell startup files. Optional browser readiness has
separate `READY`/`WARN` results, or `DISABLED` when a distribution explicitly
sets `browserWorkerEnabled=false`; see the browser extension README. Successful
local checks are not proof that remote credentials, model calls, or browser
execution work.

## Setup on another machine

1. Install Pi separately, plus Python 3 and Node/npm. Clone this repo anywhere; use a reviewed release/revision for reproducibility. `~/local_code` is only a suggested location.
2. Run `./install.sh --no-catalog` for shared tools without a model-gateway catalog. The installer preserves existing settings, registers this checkout globally, wires helper/context symlinks, and runs locked `npm ci --ignore-scripts` in extensions with lockfiles. Use the catalog options above when needed. Plain `pi install git:…` alone does not install these nested extension dependencies.
3. For search/research, separately install/configure `local_web_search` (Brave Search). Provision its private Brave key **before** starting its installer, following that repository's README. Override the default `http://127.0.0.1:8889/mcp` with `PI_WEBSEARCH_MCP_URL`, `SEARCH_MCP_URL`, `WEBSEARCH_MCP_URL`, or the research config. Missing search affects search/research calls, not unrelated Pi tools.
4. For public browser tools, use pi-setup's recommended `browser-worker` module (automatic local service/token provisioning), or install it independently as documented in [Pi Browser Capture](extensions/pi-browser-capture/README.md). Its persisted client URL/token path are honored by the native wrapper and checker; environment overrides still take precedence. If not using it, merge `"browserWorkerEnabled": false` into `~/.pi/research/config.json`; this suppresses optional-worker warnings, not search or `app_*`.
5. For private `app_*` tests, install Chromium explicitly (see below) and set `BROWSER_MCP_APP_BASE_URL` / `BROWSER_MCP_APP_ALLOWED_HOSTS` for the intended app. These tools do not use browser-worker.
6. Run the static doctor, then explicitly chosen dependency/import/service checks. Restart Pi or run `/reload`, then `/mcp-connections` to see both MCP integration paths. Failed optional services must remain clearly reported as unavailable, not mistaken for successful full setup.

Example:

```bash
git clone https://github.com/GeorgeTheo99/pi-shared.git ~/local_code/pi-shared
~/local_code/pi-shared/install.sh --no-catalog   # safe settings/context wiring + locked extension deps
python3 ~/local_code/pi-shared/bin/pi-doctor     # static evidence; not service readiness
~/local_code/pi-shared/bin/pi-shared-check-deps   # verify: yaml, patchright, playwright resolve

# Optional recovery launcher that bypasses shared/local Pi resources
mkdir -p ~/.local/bin
ln -sfn ~/local_code/pi-shared/bin/pi-vanilla ~/.local/bin/pi-vanilla
# Ensure ~/.local/bin is in PATH, then verify:
pi-vanilla --list-models gpt-5.5

# Optional endpoint selection: merge websearchMcpUrl into ~/.pi/research/config.json
# rather than overwriting existing research/browser settings.

# Optional app_* target config if the app is not on 127.0.0.1:8100
export BROWSER_MCP_APP_BASE_URL='http://127.0.0.1:8100'

# If the optional services were installed, run their explicit checks:
local-search verify
python3 ~/local_code/pi-shared/bin/pi-browser-check  # inventory only, not browser execution
```

Then restart Pi from any working directory, or run in an existing session:

```text
/reload
/mcp-connections
```

## Updating on either machine

If shared skills/extensions change on either machine, make the change in this repo, commit it here, push it, pull it on the other machine, and then run `/reload`.

Use the generated updater on either machine:

```bash
pi-shared-update
```

It requires a clean checkout on a branch with an upstream, runs `git pull --ff-only`, regenerates the configured Pi artifacts with that machine's existing catalog settings, validates the launcher with `zsh -n`, and sources it into the current shell. Run `/reload` in any Pi sessions that were already open.

After first pulling the release that introduces `pi-shared-update`, bootstrap the current shell once:

```bash
cd ~/local_code/pi-shared
git pull --ff-only
pi-regen
source ~/.pi/generated/pi-launchers.zsh
```

If `package.json` dependencies changed for an extension, re-run `./install.sh` (or `npm ci --ignore-scripts` in that extension directory), then run `/reload` in Pi.

The browser extension's JavaScript packages are installed by `./install.sh`; the Chromium binary is a separate, explicit step (hundreds of MB) for the in-process `app_*` tools. Public browser binaries are managed separately by browser-worker:

```bash
cd ~/local_code/pi-shared/extensions/pi-browser-capture
npx playwright install chromium
```

After pulling updates, restart Pi or run `/reload`.

## Troubleshooting

### Literal key sequences and repeated aborts in tmux

If a busy or long-running Pi session prints fragments such as `[27;5;106~`, reports repeated `Operation aborted`, and then continues working, check tmux's extended-key format. The fragment is the tail of an xterm `modifyOtherKeys` sequence. Under load, a delayed or split leading Escape byte can be interpreted by Pi as `app.interrupt`, while the remaining bytes are inserted literally.

Configure tmux to use CSI-u instead:

```tmux
# ~/.config/tmux/tmux.conf (or ~/.tmux.conf)
set -g extended-keys on
set -g extended-keys-format csi-u
```

Apply and verify the setting:

```bash
tmux source-file ~/.config/tmux/tmux.conf
tmux show-options -g extended-keys
tmux show-options -g extended-keys-format
```

The expected format is `extended-keys-format csi-u`. This is a terminal/tmux input-encoding quirk, not a `pi-shared` extension failure.
