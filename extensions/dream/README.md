# Dream Extension

Session analysis and memory improvement proposals, inspired by Anthropic's managed-agents "Dreams" feature.

## What It Does

Dreams reviews batches of past session transcripts alongside existing project memory to identify patterns, stale information, missing knowledge, and redundancies. It spawns an isolated subagent for analysis and produces structured proposals that you can review, apply, or dismiss.

Two modes:

- **Project dreams** — analyze sessions for the current project, propose memory improvements (add/update/archive/merge)
- **Meta dreams** — analyze sessions across all projects, propose pi-shared improvements (code/docs/skill/prompt/config)

## Usage

### Commands

```
/dream                  Run project dream (last 15 sessions)
/dream project 20       Run project dream with custom session count
/dream meta             Run meta dream across all projects
/dream review           Show pending proposals from latest project run
/dream review meta      Show pending proposals from latest meta run
/dream apply <id>       Apply a project dream proposal to memory
/dream dismiss <id>     Dismiss a proposal (project or meta)
/dream history          Show past project dream runs
/dream history meta     Show past meta dream runs
/dream help             Show help
```

### Tool

The `dream` tool is also available for LLM-initiated use with the same actions.

## Design Principles

- **Input is never modified** — dreams produce a separate store of proposals; existing memory is untouched until you explicitly apply
- **Proposals require explicit action** — nothing is auto-applied; you review and decide
- **Meta-dream changes are manual** — pi-shared improvement proposals are informational; they should be implemented through normal code review, not auto-applied

## Storage

```
~/.pi/memory/dreams/
  projects/
    <project-name>-<id>.json    # Project dream runs + proposals
  meta/
    store.json                  # Meta dream runs + proposals
```

Dream stores cap at 20 runs. Older runs are pruned on each new run.

## How It Works

1. Reads recent session JSONL files from `~/.pi/agent/sessions/`
2. Condenses sessions into operation summaries (strips encrypted thinking blocks, pairs tool calls with results, labels subagent calls, preserves errors/outcomes with bounded truncation)
3. Reads current project memory for context
4. Spawns an isolated Pi subagent with a dream-specific system prompt
5. Parses the agent's structured JSON output into typed proposals
6. Stores proposals alongside memory for review

## Proposal Types

### Project Dream Proposals

| Action | Description |
|--------|-------------|
| `add` | New memory entry based on cross-session patterns |
| `update` | Modify an existing memory that's stale or inaccurate |
| `archive` | Archive a memory that's no longer relevant |
| `merge` | Combine redundant memories into one |

### Meta Dream Proposals

| Field | Description |
|-------|-------------|
| `changeType` | code, docs, skill, prompt, or config |
| `riskLevel` | low, medium, or high |
| `affectedResource` | Relative path in pi-shared |
| `proposedFix` | What should change and how |
