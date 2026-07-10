# pi-shared

Shared pi instructions and explicitly shareable pi resources.

**Source of truth rule:** any shared Pi extension, skill, prompt, or theme placed in this repo should be treated as the canonical source of truth. Do not maintain parallel copies under `~/.pi/agent/...` on individual machines, or the resources will drift.

## Contents

- `AGENTS.md` — shared global pi instructions; symlink to `~/.pi/agent/AGENTS.md`.
- `extensions/` — shared pi extensions, including project memory (`memory_read`, `memory_write`, `/memory`), native subagents (`spawn_subagent`, `/subagents`), workflow orchestration (`workflow`, `/workflows`), model-panel second opinions (`/panel`, `panel_models`, `panel_select`), local-search MCP-backed web search/fetch (`web_search`, `web_fetch`), `software-kb` tools (`kb_search`, `kb_sources`), and commands (`/kb-search`, `/kb-sources`).
- `knowledge/software-engineering/` — curated software engineering classics source catalog and local searchable corpus. Future state: ingest public/open texts and user-supplied lawful private copies for copyrighted books; metadata-only until then.
- `skills/` — shared skills only; local-only skills should live outside this repo, preferably under `~/local_code/pi-databricks/skills`.
- `prompts/` — shared prompt templates.
- `workflows/` — saved JavaScript workflows for the `workflow` tool (`<name>.js` invocable as `workflow({ name })`). Shared, committed; project workflows live under `.pi/workflows/`.
- `themes/` — shared themes.
- `bin/pi-vanilla` — recovery launcher for a vanilla Pi session when shared/local harness resources break normal startup.
- `bin/pi-omlx-repair` — repair/wiring script for the dedicated `~/.pi-omlx/agent` Pi profile used by local oMLX/cloud model launchers.
- `bin/pi-catalog` — render Pi CLI artifacts (`models.json` + `pi-launchers.zsh`) from a `model-aliases.json` catalog (the model-gateway public contract). The Pi-side of the model-gateway/Pi separation: the gateway owns the generic catalog, pi-catalog owns Pi-specific rendering. Install per-machine via a `~/.local/bin` symlink.
- `bin/pi-shared-install` / `install.sh` — portable installer that symlinks shared helper scripts into `~/.local/bin`, wires this repo into `~/.pi/agent/settings.json`, and optionally renders initial Pi catalog artifacts.
- `lib/pi_catalog.py` — the importable module behind `bin/pi-catalog` (render functions + CLI).
- `tests/test_pi_catalog.py` — tests for the catalog renderer (`python3 -m pytest tests/`).

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
- if `~/.claude/model-aliases.json` exists, renders `~/.pi-omlx/agent/models.json` and `~/.pi/model-gateway/pi-launchers.zsh`

Useful options:

```bash
./install.sh --no-catalog
./install.sh --force
./install.sh --aliases ~/.claude/model-aliases.json \
  --models-out ~/.pi-omlx/agent/models.json \
  --launchers-out ~/.pi/model-gateway/pi-launchers.zsh
```

After catalog generation, source the launcher from your shell, for example:

```bash
[ -f ~/.pi/model-gateway/pi-launchers.zsh ] && source ~/.pi/model-gateway/pi-launchers.zsh
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
- includes `~/.codex/skills` and a local extensions directory only if one exists
- symlinks `~/.pi-omlx/agent/AGENTS.md` to this repo's `AGENTS.md`
- patches the installed Pi compaction code to ignore all-zero provider usage and fall back to token estimation for context percentage

Run manually if needed:

```bash
~/local_code/pi-shared/bin/pi-omlx-repair
```

Current generated `pi-*` shell launchers call this automatically before writing models or launching Pi. Future launchers that set `PI_CODING_AGENT_DIR=~/.pi-omlx/agent` should do the same.

## Pi catalog rendering (model-gateway separation)

`bin/pi-catalog` renders Pi-specific artifacts from a `model-aliases.json` catalog — the public contract emitted by `model-gateway`. This keeps the gateway generic (no Pi config-schema knowledge) and Pi rendering in `pi-shared` (where the `models.json` schema lives). Either service can be installed without the other.

It reads the alias file and emits:

- `models.json` — a Pi provider/models config with full reasoning/thinkingFormat compat knowledge (local-qwen/glm/deepseek, fireworks-messages, zai, openrouter, openai-responses, anthropic), api_type selection, vision heuristics, and anthropic baseUrl overrides.
- `pi-launchers.zsh` — `pi-<alias>()` + `pi-list` + `pi-restart` (+ optional `pi-default`/`pi-openai` via `--ls99-extras`). No `claude-*`/`codex-*` — standardize on `pi`.

The model id in the launcher always matches the id in `models.json` (local = alias key / omlx_id, cloud = provider_model_id), so the two can never drift.

Install per-machine:

```bash
mkdir -p ~/.local/bin
ln -sfn ~/local_code/pi-shared/bin/pi-catalog ~/.local/bin/pi-catalog
```

Generate for the oMLX profile (ls99):

```bash
pi-catalog --aliases ~/.claude/model-aliases.json \
  --models-out ~/.pi-omlx/agent/models.json \
  --launchers-out ~/local_code/model-gateway-runtime/pi-launchers.zsh \
  --pi-agent-dir ~/.pi-omlx/agent --ls99-extras
```

The generated launcher bakes in a `pi-regen()` function (the same invocation) so it can refresh itself + `models.json` after a catalog change. `pi-restart model-gw` auto-calls `pi-regen` — it delegates to the portable `model-gateway restart` command when available, falls back to `server-ci restart --model-gw` on ls99/dev-server installs, then refreshes the Pi artifacts. No launchd watcher needed.

For a machine that does NOT use the local model-gateway (e.g. Pi hitting Databricks directly), point `--gateway-url` at the endpoint and `--provider-name` at the Pi provider, and feed a catalog alias file from whatever source is appropriate.

## Included shared extensions

- `extensions/memory` — machine-local, project-only memory:
  - stores canonical JSON in `~/.pi/memory/projects/`
  - injects active memories into the prompt as untrusted project context
  - provides `memory_read` and `memory_write` tools plus `/memory [active|all|review|path|help]`
  - memory hygiene happens during normal session work: read relevant memories before relying on prior state, write/update verified durable facts while evidence is fresh, and archive stale entries before finishing substantive work
  - global memory is intentionally not implemented; store only evidence-backed durable project-specific facts and never secrets, global/user-wide preferences, transient task state, todos, guesses, or raw logs
- `extensions/websearch` — local-search MCP-backed web tools:
  - `web_search` calls the MCP broker tool `web_search(query, num_results)`
  - `web_fetch` calls the MCP broker tool `web_fetch(url, max_chars)`
  - the broker is the stable entry point and owns loopback/self-hosted SearXNG plus policy-controlled Tavily behavior; Pi does not bypass it with direct SearXNG fallback. See `extensions/websearch/README.md`.
- `extensions/goal` — durable `/goal` loop for long-running work:
  - `/goal <objective> [--max-turns N]` starts a user-requested goal
  - `/goal status`, `/goal pause`, `/goal resume`, `/goal clear` control it
  - `start_goal` lets the agent create a durable goal from a normal session when the user explicitly requests or strongly implies multi-turn/autonomous tracking
  - `update_goal` lets the agent log progress, mark completion after evidence audit, or stop when blocked
- `extensions/pi-browser-capture` — shared Playwright runtimes for browser work and local app testing:
  - canonical `browser_*` tools for actual public web browsing: `browser_open`, `browser_navigate`, `browser_open_tab`, `browser_list_tabs`, `browser_switch_tab`, `browser_close_tab`, `browser_click`, `browser_type`, `browser_wait_for`, `browser_extract_text`, `browser_screenshot`, `browser_export_pdf`, `browser_console_logs`, `browser_page_state`, `browser_close`
  - `app_*` tools for local/private web app testing: `app_open`, `app_click`, `app_type_text`, `app_wait_for`, `app_extract_text`, `app_screenshot`, `app_console_logs`, `app_network_log`, `app_api_request`, `app_page_state`, and tab helpers
  - `browser_*` private hosts are blocked by default; use `app_*` tools for local app testing or set `BROWSER_MCP_WEB_ALLOW_PRIVATE_HOSTS=true`
- `extensions/spawn-subagent` — native subagent delegation:
  - `spawn_subagent` spawns isolated `pi --mode json -p --no-session` subprocesses for single, parallel, or chained specialist work
  - parallel tasks and chain steps may specify task-level `model` and `agentDir` overrides for multi-model/multi-profile workflows
  - bundled shared agents: `scout`, `planner`, `reviewer`, `worker`, `panelist`
  - background job completion is a UI notification in interactive/RPC sessions, never an injected LLM-context message; fetch/list jobs with `jobAction: "status"` / `"list"`
  - `/subagents [shared|user|project|all]` lists available agents
  - project-local `.pi/agents` are disabled by default unless `agentScope` is `project` or `all` and confirmed in UI
- `extensions/panel` — user-invoked alternate-model second opinions:
  - `/panel` asks a runtime-selected alternate model for a second opinion on the current conversation or an explicit task
  - `/panel --compare` runs multiple model families through `spawn_subagent` in parallel and asks the main session to synthesize
  - `/panel --list [search]`, `panel_models`, and `panel_select` use Pi model registries for portable runtime model discovery, including the alternate `~/.pi-omlx/agent` profile by default
  - optional model preferences/exclusions live in `~/.pi/panel-config.json` or project `.pi/panel-config.json`; trusted `modelProfileDirs` overrides are honored only from `~/.pi/panel-config.json`
- `extensions/workflow` — trusted JS workflow runner on top of Pi subagents:
  - `workflow` runs a JavaScript workflow body (inline `script`, saved `name`, or `scriptPath`) whose primitives are Pi subagent calls
  - workflow globals: `agent(prompt, opts?)`, `parallel(thunks)`, `phase(title)`, `log(message)`, `args`, `cwd`
  - shared agents only in v1 (`scout`, `planner`, `reviewer`, `worker`, `panelist`); each `agent()` call spawns an isolated `pi --mode json -p --no-session` subprocess, mirroring `spawn_subagent` single mode
  - saved workflows: `pi-shared/workflows/<name>.js` (shared, committed) or `.pi/workflows/<name>.js` (project, requires trust); `/workflows` lists them
  - use for repeatable, multi-phase, scriptable orchestration; use `spawn_subagent` for ordinary one-off single/parallel/chain delegation
  - v1 scope: Pi-backed subagents only, no external backends, no resume-by-replay, no schema validation
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
- `skills/handoff` — writes a structured continuation handoff for a fresh pi, Claude Code, or Codex CLI session
- `skills/panel` — orchestrates `/panel` second-opinion and multi-model compare workflows using `panel_select` plus `spawn_subagent panelist`
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

Project-local setups can instead use `./pi-shared` from `~/local_code/.pi/settings.json`. After editing shared Pi resources in the repo, run `/reload` in Pi.

## Setup on another machine

1. Clone or pull this repo to the same workspace location, or adjust the path in `.pi/settings.json`.
2. Point that machine's Pi `AGENTS.md` at this repo.
3. Ensure project settings include `./pi-shared` as a package.
4. Install package dependencies once.
5. For `web_search` / `deep_research`, run/configure the local-search MCP broker on that machine. Recommended endpoint: `http://127.0.0.1:8889/mcp`; the broker owns loopback/self-hosted SearXNG and explicit Tavily disabled/fallback/supplement policy. Override with `PI_WEBSEARCH_MCP_URL`, `SEARCH_MCP_URL`, `WEBSEARCH_MCP_URL`, or `~/.pi/research/config.json`.
6. For `app_*`, set `BROWSER_MCP_APP_BASE_URL` when the target app is not `http://127.0.0.1:8100`; optionally add `BROWSER_MCP_APP_ALLOWED_HOSTS` for additional private hosts.
7. Install the optional `pi-vanilla` recovery launcher if desired.
8. Run `~/local_code/pi-shared/bin/pi-omlx-repair` on machines that use generated `pi-*` oMLX/cloud launchers.
9. Run `/reload`.

Example:

```bash
git clone <your-pi-shared-repo-url> ~/local_code/pi-shared
mkdir -p ~/.pi/agent
ln -sfn ~/local_code/pi-shared/AGENTS.md ~/.pi/agent/AGENTS.md
mkdir -p ~/local_code/.pi
cat > ~/local_code/.pi/settings.json <<'JSON'
{
  "packages": ["./pi-shared"]
}
JSON
cd ~/local_code/pi-shared/extensions/pi-browser-capture && npm install
cd ~/local_code/pi-shared/extensions/integration-bundles && npm install

# Optional recovery launcher that bypasses shared/local Pi resources
mkdir -p ~/.local/bin
ln -sfn ~/local_code/pi-shared/bin/pi-vanilla ~/.local/bin/pi-vanilla
# Ensure ~/.local/bin is in PATH, then verify:
pi-vanilla --list-models gpt-5.5

# Optional web_search / deep_research MCP endpoint config if not on 127.0.0.1:8889/mcp
mkdir -p ~/.pi/research
cat > ~/.pi/research/config.json <<'JSON'
{
  "websearchMcpUrl": "http://127.0.0.1:8889/mcp"
}
JSON

# Optional app_* target config if the app is not on 127.0.0.1:8100
export BROWSER_MCP_APP_BASE_URL='http://127.0.0.1:8100'

# Verify local-search MCP broker
curl -fsS http://127.0.0.1:8889/health | python3 -m json.tool
curl -fsS -H 'Accept: application/json' -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"check","method":"tools/call","params":{"name":"web_search","arguments":{"query":"pi websearch health check","num_results":3}}}' \
  http://127.0.0.1:8889/mcp | python3 -m json.tool >/dev/null
```

Then start Pi from `~/local_code` and run:

```text
/reload
```

## Updating on either machine

If shared skills/extensions change on either machine, make the change in this repo, commit it here, push it, pull it on the other machine, and then run `/reload`.

If shared skills/extensions change on either machine:

```bash
cd ~/local_code/pi-shared
git pull
```

If `package.json` dependencies changed for an extension, reinstall in that extension directory, then run `/reload` in Pi.

For the browser extension specifically:

```bash
cd ~/local_code/pi-shared/extensions/pi-browser-capture
npm install
npx playwright install chromium
```

After pulling updates, restart Pi or run `/reload`.
