# pi-shared workflows

Saved JavaScript workflows for the `workflow` tool. Each `<name>.js` file here is invocable as:

```
workflow({ name: "<name>", args: { ... } })
```

The workflow body is an async function with globals `agent`, `parallel`, `phase`, `log`, `args`, and `cwd` in scope. See [`../extensions/workflow/README.md`](../extensions/workflow/README.md) for the full guide.

## Shared vs project

- `pi-shared/workflows/` — shared, committed, travels by git. Trusted by convention.
- `.pi/workflows/` — project-local, repo-controlled. Requires project trust or an interactive confirmation.

List available workflows with the `/workflows` command.

## Included

- `research-fanout` — fan out N independent read-only questions to `scout` subagents in parallel, then have a `planner` synthesize them into an implementation plan.
- `supervisor` — bounded worker↔reviewer checkpoint loop: a `worker` attempts the task, a `reviewer` judges it against a rubric and replies with exactly `ACCEPT` and no other text, or `REVISE: <instruction>`, and each `REVISE` redirects the worker's next attempt (capped by `maxRounds`). Malformed or decorated accept verdicts fail closed.
- `implement` — composite coding pipeline: parallel `scout` recon (optional) → `planner` → `worker`↔`reviewer` loop (capped by `maxRounds`). Each stage takes an optional `<stage>Model` (`scoutModel`/`plannerModel`/`reviewerModel`/`workerModel`) to route that phase to a specific `provider/model`; unset stages inherit the parent session model so a resident local model stays resident. The worker defaults to the OpenAI Codex subscription model `openai-codex/gpt-5.6-sol` (auto-routed through `~/.pi/agent`). Each phase is `cache()`-wrapped for resume-by-replay.
