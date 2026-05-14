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

- `scout` — fast read-only reconnaissance
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
- Streams partial updates back into the tool result.
- Propagates aborts to child Pi processes.
- Limits parallel mode to 8 tasks with max concurrency 4.
- Does not create git worktrees or branches; use normal git/worktree workflows explicitly when needed.

Run `/reload` or restart Pi after changing this extension.
