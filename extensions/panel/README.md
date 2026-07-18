# Panel

Shared Pi extension for user-invoked alternate-model second opinions.

## Command

```text
/panel                       # second opinion on current conversation
/panel <task>                # second opinion on an explicit task
/panel <model-pattern> <task> # prefer a specific model
/panel --compare [task]      # compare multiple model families
/panel --list [search]       # list available runtime models
```

The command forwards normal opinion requests into the `panel` skill workflow. The skill then uses `panel_select` and `spawn_subagent` with the shared `panelist` agent.

## Tools

- `panel_models` — lists currently available Pi models grouped by detected family, including configured alternate Pi profiles.
- `panel_select` — selects one or more alternate models from the current session and configured alternate Pi profiles.

## Configuration

Optional config files are merged in this order:

1. `~/.pi/panel-config.json`
2. nearest `.pi/panel-config.json` in the current project tree

Example:

```json
{
  "preferredModels": ["claude", "gemini", "qwen"],
  "compareModels": ["claude", "gpt", "gemini"],
  "excludeModels": ["*mini*", "*flash*"],
  "defaultCompareCount": 3,
  "modelProfileDirs": ["~/.pi-omlx/agent"]
}
```

Config values are model patterns, not hardcoded shared defaults. They are resolved against the active machine's runtime model registries. `modelProfileDirs` defaults to `["~/.pi-omlx/agent", "~/.pi/agent"]` when omitted and is honored only from `~/.pi/panel-config.json`, not project `.pi/panel-config.json`, because profile directories are a trust boundary. GPT-family panel choices prefer `openai-codex` subscription models over API-routed GPT entries.

## Notes

- Model discovery uses Pi's extension-facing `ctx.modelRegistry` for the active profile and async `ModelRuntime` instances for configured alternate profiles rather than shelling out to `pi --list-models` (with the legacy registry factory retained for Pi 0.80.7).
- Compare mode depends on `spawn_subagent` task-level `model` and `agentDir` overrides (`tasks[].model`, `tasks[].agentDir`).
- Alternate profiles load Pi settings/extensions from that profile; only use trusted profile directories.
- The `panelist` agent omits `tools:` frontmatter, so spawned panelists get a full Pi session; its prompt tells them to default to read-only unless implementation is explicitly requested.
