# pi-shared

Shared pi instructions and explicitly shareable pi resources.

**Source of truth rule:** any shared Pi extension, skill, prompt, or theme placed in this repo should be treated as the canonical source of truth. Do not maintain parallel copies under `~/.pi/agent/...` on individual machines, or the resources will drift.

## Contents

- `AGENTS.md` — shared global pi instructions; symlink to `~/.pi/agent/AGENTS.md`.
- `extensions/` — shared pi extensions, including `software-kb` tools (`kb_search`, `kb_sources`) and commands (`/kb-search`, `/kb-sources`).
- `knowledge/software-engineering/` — curated software engineering classics source catalog and local searchable corpus. Future state: ingest public/open texts and user-supplied lawful private copies for copyrighted books; metadata-only until then.
- `skills/` — pi-specific shared skills only. General cross-harness skills live in `~/local_code/agent_skills`.
- `prompts/` — shared prompt templates.
- `themes/` — shared themes.

## Included shared extensions

- `extensions/pi-browser-capture` — Playwright-powered browser tools:
  - `browser_open`
  - `browser_navigate`
  - `browser_click`
  - `browser_type`
  - `browser_wait_for`
  - `browser_screenshot`
  - `browser_export_pdf`
  - `browser_close`

## Included shared skills

- `skills/frontend-design` — high-quality frontend/UI design skill for building polished, distinctive web interfaces
- `skills/handoff` — writes a structured continuation handoff for a fresh pi, Claude Code, or Codex CLI session

## This machine setup

This repo is now loaded by the project via:

```json
{
  "packages": ["./pi-shared"]
}
```

in `/Users/george.theodosopoulos/local_code/.pi/settings.json`.

That means Pi will load shared extensions/skills from this repo for this workspace. After editing shared Pi resources in the repo, run `/reload` in Pi.

## Setup on another machine

1. Clone or pull this repo to the same workspace location, or adjust the path in `.pi/settings.json`.
2. Point that machine's Pi `AGENTS.md` at this repo.
3. Ensure project settings include `./pi-shared` as a package.
4. Install package dependencies once.
5. Run `/reload`.

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
