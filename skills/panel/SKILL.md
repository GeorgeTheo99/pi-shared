---
name: panel
description: Run a user-invoked second-opinion panel in Pi using alternate runtime-discovered models. Use when the user invokes /panel or asks for an independent model opinion, critique, or multi-model compare.
---

# Panel

Run an independent second-opinion Pi session with `spawn_subagent` and the shared `panelist` agent.

## Entrypoints

- `/panel` is registered by `extensions/panel` and forwards into this workflow.
- `/skill:panel ...` can be used directly if the command alias is unavailable.

## Modes

- `/panel` — second opinion on the current conversation/latest topic.
- `/panel <task>` — second opinion on an explicit task or question.
- `/panel <model-pattern> <task>` — use a specific model if the first argument looks like a model/provider/family.
- `/panel --compare [task]` — ask 2-3 different model families in parallel, then synthesize.
- `/panel --list [search]` — list available panel models. The extension command handles this directly; otherwise call `panel_models`.

## Workflow

1. Identify the panel target:
   - If the user supplied a task/question, use it.
   - If no task is supplied, summarize the current conversation into a self-contained prompt. Include the user request, current plan/decision, important files/commands/results, and the specific question for the panelist.
2. Select models:
   - Call `panel_select` with `mode: "single"` or `mode: "compare"`.
   - Pass explicit model patterns via `models` if the user supplied them.
   - Prefer the selected model(s) from `panel_select`; do not hardcode shared model IDs.
   - If a selected model has `agentDir` in tool details, preserve it when spawning the panelist. This lets `/panel` use models from another Pi profile, such as `~/.pi-omlx/agent`, even when the parent session was launched with a narrow model profile.
3. Spawn panelist(s):
   - Single mode: call `spawn_subagent` with `agent: "panelist"`, the self-contained task, the selected `model`, and selected `agentDir` when present.
   - Compare mode: call `spawn_subagent` with `tasks`, each `{ agent: "panelist", task, model, agentDir }`, so different models/profiles run in parallel.
4. Synthesize for the user:
   - Start with the bottom-line answer.
   - Call out agreement/disagreement, important risks, and the recommended decision.
   - Do not dump all panelist output unless it is short and useful.

## Prompt Template

Use a prompt like this for each panelist:

```text
You are providing an independent second opinion for a Pi session.

Context:
- User goal: ...
- Current proposed answer/plan/code: ...
- Relevant files/commands/results: ...
- Constraints: ...

Question:
...

Please critique the approach, identify missing assumptions or edge cases, and recommend the best next action.
```

## Guardrails

- Panelists have a full Pi session because the `panelist` agent intentionally omits a restrictive `tools:` list. Still instruct them to stay read-only unless implementation was explicitly requested.
- `agentDir` loads another Pi profile's settings/extensions. Use only `agentDir` values returned by `panel_select` or explicitly trusted by the user.
- Child Pi sessions do not inherit the parent conversation; always include enough context in the task.
- Do not use `pi --list-models --json`; use `panel_models`/`panel_select`, which read the current Pi model registry plus configured model profile dirs.
- Do not ask the user routine follow-up questions. If the panel target is ambiguous, panel the current/latest topic and state the assumption.
