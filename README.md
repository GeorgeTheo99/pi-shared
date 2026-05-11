# pi-shared

Shared pi instructions and explicitly shareable pi resources.

**Source of truth rule:** any shared Pi extension, skill, prompt, or theme placed in this repo should be treated as the canonical source of truth. Do not maintain parallel copies under `~/.pi/agent/...` on individual machines, or the resources will drift.

## Contents

- `AGENTS.md` — shared global pi instructions; symlink to `~/.pi/agent/AGENTS.md`.
- `extensions/` — shared pi extensions, including SearXNG-backed web search/fetch (`web_search`, `web_fetch`), `software-kb` tools (`kb_search`, `kb_sources`), and commands (`/kb-search`, `/kb-sources`).
- `knowledge/software-engineering/` — curated software engineering classics source catalog and local searchable corpus. Future state: ingest public/open texts and user-supplied lawful private copies for copyrighted books; metadata-only until then.
- `skills/` — shared skills only; local-only skills should live outside this repo, preferably under `~/local_code/pi-local/skills`.
- `prompts/` — shared prompt templates.
- `themes/` — shared themes.

## Included shared extensions

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

## Included shared skills

- `skills/archon` — guidance for running, creating, configuring, and troubleshooting Archon CLI workflows
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
```

When you `git add`, `git commit`, and `git push` from `pi-shared`, those resources become available to other machines after they `git pull` and run `/reload` in Pi.

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
7. Run `/reload`.

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
