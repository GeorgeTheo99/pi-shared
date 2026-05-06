# pi-shared

Shared pi instructions and explicitly shareable pi resources.

## Contents

- `AGENTS.md` — shared global pi instructions; symlink to `~/.pi/agent/AGENTS.md`.
- `extensions/` — shared pi extensions.
- `skills/` — pi-specific shared skills only. General cross-harness skills live in `~/local_code/agent_skills`.
- `prompts/` — shared prompt templates.
- `themes/` — shared themes.

## Machine setup

```bash
git clone ssh://localserver99/Users/localserver99/repos/pi-shared.git ~/local_code/pi-shared
mkdir -p ~/.pi/agent
ln -sfn ~/local_code/pi-shared/AGENTS.md ~/.pi/agent/AGENTS.md
pi install ~/local_code/pi-shared
```

After pulling updates, restart pi or run `/reload`.
