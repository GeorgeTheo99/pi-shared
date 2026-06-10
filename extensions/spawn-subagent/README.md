# Spawn Subagent

Shared Pi extension that provides a native `spawn_subagent` tool for delegating work to isolated Pi subprocesses.

## Tool

```text
spawn_subagent
```

Modes:

- Single: `{ "agent": "scout", "task": "find auth entry points" }`
- Parallel: `{ "tasks": [{ "agent": "scout", "task": "find models" }, { "agent": "scout", "task": "find routes" }] }`
- Chain: `{ "chain": [{ "agent": "scout", "task": "inspect X" }, { "agent": "planner", "task": "plan from this: {previous}" }] }`
- Background start: `{ "background": true, "tasks": [{ "agent": "scout", "task": "find models" }, { "agent": "scout", "task": "find routes" }] }`
- Background status/list/cancel: `{ "jobAction": "status", "jobId": "sub_..." }`, `{ "jobAction": "list" }`, `{ "jobAction": "cancel", "jobId": "sub_..." }`

## Agents

Bundled shared agents live in `extensions/spawn-subagent/agents/`:

- `scout` — read-only explore/scout reconnaissance for mapping unfamiliar code, tracing behavior, and finding implementation points
- `planner` — read-only implementation planning
- `reviewer` — read-only review
- `worker` — focused implementation with standard coding tools

Additional agent scopes:

- `shared` — bundled pi-shared agents; default
- `user` — `~/.pi/agent/agents/*.md`
- `project` — nearest `.pi/agents/*.md`; requires UI confirmation by default
- `all` — merge shared, user, then project agents; later sources override by name

Agent files are Markdown with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent is good at
tools: read, grep, find, ls
model: optional-model-pattern
---

System prompt for the agent.
```

## Command

```text
/subagents [shared|user|project|all]
```

Lists available agents for the selected scope.

## Behavior

- Spawns a separate `pi --mode json -p --no-session` process per task.
- Model precedence per spawn: explicit `model` call param > agent frontmatter `model:` > parent session model (`ctx.model.provider/ctx.model.id`). The parent's provider-qualified model is inherited automatically so subagents don't fall back to a default provider with no usable credentials (e.g. Databricks-routed parents where `OPENAI_API_KEY` is a sentinel value).
- Streams live partial updates back into the tool result for foreground jobs, including queued/running/completed status, active child tool, last event, and output preview for each subagent.
- Renders custom TUI rows for `spawn_subagent` calls so the visible tool card shows mode, agent/task summary, per-agent progress, active tools, and final output previews instead of only the generic tool name.
- Background jobs return a job id immediately and keep running in the current Pi extension process; poll with `jobAction=status`, list with `jobAction=list`, and cancel with `jobAction=cancel`.
- Background job status polling includes the latest live partial result while the job is still running.
- Background jobs emit a visible completion message when they transition to `completed`, `failed`, or `canceled`; the message includes the job id, mode/label, success count, and a truncated preview.
- Background job metadata and truncated/redacted result summaries persist to `~/.pi/agent/spawn-subagent/jobs.json` by default (`PI_SPAWN_SUBAGENT_DIR` overrides the directory), capped to the most recent 100 jobs and jobs updated in the last 30 days.
- Persisted `running` jobs from a previous Pi process are marked `failed` on reload/restart because child process state cannot be restored.
- Propagates aborts to child Pi processes; background jobs can be canceled by job id and the canceled state is persisted.
- Limits parallel mode to 8 tasks with max concurrency 4.
- Does not create git worktrees or branches; use normal git/worktree workflows explicitly when needed.

## Delegation Gates

Use subagents when isolation, parallelism, or specialist perspective adds value:

- **Recon gate** — unfamiliar code area that would likely need 5+ sequential read/grep/find calls; delegate read-only reconnaissance to `scout` before editing.
- **Parallel gate** — 2+ independent investigation paths can run concurrently; use parallel mode with focused scout/reviewer tasks.
- **Specialist gate** — planning or review would materially improve correctness after non-trivial diffs, risky changes, or broad refactors.

Do not use subagents for single-file reads, quick greps, obvious edits, or normal linear test/fix loops. Keep routine execution in the main agent so context and responsibility stay visible.

## Orchestration

This extension injects a task routing table and agent roster into every system prompt via `before_agent_start` when `spawn_subagent` is an active tool. This is the single orchestration point that steers the LLM toward the right tool for each kind of work.

### How it works

1. The `ROUTING_TABLE` constant maps task categories to the most specific tool/agent.
2. The `before_agent_start` hook dynamically discovers available agents via `discoverAgents()` and appends the roster + routing table to the system prompt.
3. Each tool's `promptGuidelines` handles its own "when to use / when not to use" — the routing table just routes to the right category.

### Maintenance guide

| Change | What to update | Auto-discovered? |
|--------|----------------|-------------------|
| New agent (existing category, e.g. a second reviewer) | Add `.md` file in `agents/` | ✅ Hook picks it up automatically |
| New tool (with `promptGuidelines`) | Add tool — write `promptGuidelines` in place | ✅ Pi loads it |
| New **category** of work | Add 1 line to `ROUTING_TABLE` below + the tool/agent | ❌ Manual |
| Remove a tool/agent | Delete it | ✅ Routing table line becomes inert (LLM skips unavailable tools) |
| Change routing priority | Edit `ROUTING_TABLE` | ❌ Manual |

The `ROUTING_TABLE` is the only manual coordination point. It lives in this file as the `ROUTING_TABLE` constant near the top of the extension. Add a line when you introduce a new *category* of work — not when you add a new agent that fits an existing category. Broad requests to explore, map, understand, trace, or investigate unfamiliar code should route to `scout` before planning or implementation. Prompts should also ask subagents for structured output: files inspected, key findings, recommended edit points, verification commands, and risks/blockers.

### Adding a new routing category

1. Add the tool/agent with its own `promptGuidelines`.
2. Add a line to `ROUTING_TABLE` in the format: `- <task description> → <tool or agent>`
3. Place it in specificity order: most specific matches first, most general last.
4. Test that the LLM routes correctly by asking a question that matches the new category.

### Integration with other extensions

- **goal**: The goal continuation prompt (in `extensions/goal/index.ts`) references `spawn_subagent` for parallel items and specialist delegation. If you rename or remove an agent, update the goal prompt too.
- **deep-research**: Registered as both a `/research` command and a `deep_research` tool. The routing table routes deep research questions to it instead of repeated `web_search`+`web_fetch` calls.
- **websearch**: `web_search` and `web_fetch` `promptGuidelines` explicitly redirect to `deep_research` for deep tasks.

Run `/reload` or restart Pi after changing this extension.
