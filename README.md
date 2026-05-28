# pi-shared

Shared pi instructions and explicitly shareable pi resources.

**Source of truth rule:** any shared Pi extension, skill, prompt, or theme placed in this repo should be treated as the canonical source of truth. Do not maintain parallel copies under `~/.pi/agent/...` on individual machines, or the resources will drift.

## Contents

- `AGENTS.md` — shared global pi instructions; symlink to `~/.pi/agent/AGENTS.md`.
- `extensions/` — shared pi extensions, including project memory (`memory_read`, `memory_write`, `/memory`), native subagents (`spawn_subagent`, `/subagents`), SearXNG-backed web search/fetch (`web_search`, `web_fetch`), `software-kb` tools (`kb_search`, `kb_sources`), and commands (`/kb-search`, `/kb-sources`).
- `knowledge/software-engineering/` — curated software engineering classics source catalog and local searchable corpus. Future state: ingest public/open texts and user-supplied lawful private copies for copyrighted books; metadata-only until then.
- `skills/` — shared skills only; local-only skills should live outside this repo, preferably under `~/local_code/pi-local/skills`.
- `prompts/` — shared prompt templates.
- `themes/` — shared themes.
- `bin/pi-vanilla` — recovery launcher for a vanilla Pi session when shared/local harness resources break normal startup.
- `bin/pi-omlx-repair` — repair/wiring script for the dedicated `~/.pi-omlx/agent` Pi profile used by local oMLX/cloud model launchers.

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

`bin/pi-omlx-repair` repairs the dedicated `~/.pi-omlx/agent` profile used by generated `pi-*` model launchers. It:

- writes `settings.json` so `../../local_code/pi-shared` is loaded as a package
- includes `../../local_code/pi-local/extensions` and `~/.codex/skills`
- symlinks `~/.pi-omlx/agent/AGENTS.md` to `~/local_code/pi-shared/AGENTS.md`
- patches the installed Pi compaction code to ignore all-zero provider usage and fall back to token estimation for context percentage

Run manually if needed:

```bash
~/local_code/pi-shared/bin/pi-omlx-repair
```

Current generated `pi-*` shell launchers call this automatically before writing models or launching Pi. Future launchers that set `PI_CODING_AGENT_DIR=~/.pi-omlx/agent` should do the same.

## Included shared extensions

- `extensions/memory` — machine-local, project-only memory:
  - stores canonical JSON in `~/.pi/memory/projects/`
  - injects active memories into the prompt as untrusted project context
  - provides `memory_read` and `memory_write` tools plus `/memory [active|all|review|path|help]`
  - global memory is intentionally not implemented; store only durable project-specific facts and never secrets
- `extensions/websearch` — local/private SearXNG-backed web tools:
  - `web_search` searches SearXNG via `/search?format=json`
  - `web_fetch` fetches a URL directly and returns extracted text
  - SearXNG is not bundled; each machine must run or configure its own SearXNG endpoint. See `extensions/websearch/README.md`.
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
  - bundled shared agents: `scout`, `planner`, `reviewer`, `worker`
  - `/subagents [shared|user|project|all]` lists available agents
  - project-local `.pi/agents` are disabled by default unless `agentScope` is `project` or `all` and confirmed in UI
- `extensions/integration-bundles` — lazy enterprise tool-bundle loader driven by `master_integration_list.yaml`:
  - keeps GPT / o-series safely under OpenAI's 128-tool API limit by exposing only a router toolset by default and loading bundles (jira, slack, glean, salesforce, google-workspace, databricks-aidk, ...) on demand
  - injects an `<available_bundles>` block into the system prompt with NL `description` text so the model can self-discover when to load each bundle
  - regex `triggers` auto-load high-confidence bundles (e.g. `ES-12345` → `jira`) before the first turn
  - LRU-evicts non-default bundles when a new load would exceed the per-model cap; Claude / Sonnet / Opus / Gemini have `max_tools: null` and load everything eagerly
  - exposes `enterprise_load_bundle`, `enterprise_unload_bundle`, `enterprise_list_bundles` tools and a `/bundles` slash command
  - skill-driven loading: any skill `SKILL.md` whose YAML front-matter declares `requires_bundles: [...]` will pre-load those bundles when the skill name is mentioned in the user message
  - configuration lives in [`master_integration_list.yaml`](./master_integration_list.yaml) at the repo root — single source of truth

## Included shared skills

- `skills/frontend-design` — high-quality frontend/UI design skill for building polished, distinctive web interfaces
- `skills/handoff` — writes a structured continuation handoff for a fresh pi, Claude Code, or Codex CLI session
- `skills/resume-handoff` — resumes from the most recent handoff file and verifies current repo state before continuing

## Shared vs local-only setup

Use this simple mental model:

```text
~/local_code/pi-shared/  = shared by git across machines
~/local_code/pi-local/   = private to this machine
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

### What goes in `pi-local`

Put machine-specific resources here. Do not commit this directory to `pi-shared`.

```text
~/local_code/pi-local/AGENTS.md       # local-only project instructions
~/local_code/pi-local/skills/         # local-only skill source
~/local_code/pi-local/extensions/     # local-only tools/extensions
~/local_code/pi-local/prompts/        # local-only prompt templates, if needed
~/local_code/pi-local/themes/         # local-only themes, if needed
```

Recommended local-only skill pattern:

```bash
mkdir -p ~/local_code/pi-local/skills/my-private-skill
cat > ~/local_code/pi-local/skills/my-private-skill/SKILL.md <<'MD'
---
name: my-private-skill
description: What this private machine-local skill does and when to use it.
---

# My Private Skill

Instructions go here.
MD

mkdir -p ~/.pi/agent/skills
ln -sfn ~/local_code/pi-local/skills/my-private-skill ~/.pi/agent/skills/my-private-skill
```

Recommended local-only extension pattern:

```bash
mkdir -p ~/local_code/pi-local/extensions
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
5. For `web_search`, run/configure SearXNG on that machine. Recommended endpoint: `http://127.0.0.1:8888`; JSON output must be enabled. Override with `SEARXNG_BASE_URL`, `SEARXNG_URL`, `PI_SEARXNG_BASE_URL`, `PI_RESEARCH_SEARXNG_URL`, or `~/.pi/research/config.json`.
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

# Optional web_search endpoint config if SearXNG is not on 127.0.0.1:8888
mkdir -p ~/.pi/research
cat > ~/.pi/research/config.json <<'JSON'
{
  "searxngBaseUrl": "http://127.0.0.1:8888"
}
JSON

# Optional app_* target config if the app is not on 127.0.0.1:8100
export BROWSER_MCP_APP_BASE_URL='http://127.0.0.1:8100'

# Verify SearXNG JSON API
curl -fsS 'http://127.0.0.1:8888/search?q=pi%20searxng%20health%20check&format=json' | python3 -m json.tool >/dev/null
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
