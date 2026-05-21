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
- Model precedence per spawn: explicit `model` call param > agent frontmatter `model:` > parent session model (`ctx.model.id`). The parent's model is inherited automatically so subagents don't fall back to a default provider with no usable credentials (e.g. Databricks-routed parents where `OPENAI_API_KEY` is a sentinel value).
- Streams partial updates back into the tool result.
- Propagates aborts to child Pi processes.
- Limits parallel mode to 8 tasks with max concurrency 4.
- Does not create git worktrees or branches; use normal git/worktree workflows explicitly when needed.

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

The `ROUTING_TABLE` is the only manual coordination point. It lives in this file as the `ROUTING_TABLE` constant near the top of the extension. Add a line when you introduce a new *category* of work — not when you add a new agent that fits an existing category. Broad requests to explore, map, understand, trace, or investigate unfamiliar code should route to `scout` before planning or implementation.

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
