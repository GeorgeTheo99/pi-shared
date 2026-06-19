# workflow

A trusted JavaScript workflow runner built on top of Pi subagents.

Pi already has `spawn_subagent` for one-off single / parallel / chain delegation. `workflow` is the next level up: **repeatable, scriptable, multi-phase orchestration** expressed as a small JavaScript program whose primitives are Pi subagent calls.

## When to use it

| Situation | Use |
|---|---|
| One-off fan-out: "run scout on these 3 things in parallel" | `spawn_subagent` (parallel) |
| Sequential pipeline: scout → planner → worker | `spawn_subagent` (chain) |
| Repeatable pattern worth saving/reusing | `workflow` (by `name`) |
| Interleaved phases, conditional lanes, gathered results fed into later steps | `workflow` |
| Multi-phase orchestration that doesn't fit a flat task list | `workflow` |

Rule of thumb: if you'd want to save it and run it again, or it needs real control flow, use `workflow`. If a declarative task list is enough, use `spawn_subagent`.

## The `workflow` tool

```
workflow({
  script?:     string,   // inline JS workflow body (async function body)
  name?:       string,   // saved workflow name
  scriptPath?: string,   // explicit .js file path
  args?:       object,   // optional object passed to the workflow as `args`
})
```

Provide **exactly one** of `script` / `name` / `scriptPath`.

## Workflow globals

The workflow body is an **async function body** (top-level `await` and `return` both work) with these in scope:

| Global | Signature | Description |
|---|---|---|
| `agent` | `(prompt, opts?) => Promise<string>` | Run one Pi subagent. `opts.agent` picks a shared agent (`scout`, `planner`, `reviewer`, `worker`, `panelist`; default `worker`). `opts.model` / `opts.cwd` are optional. Returns the subagent's final assistant text. Throws on failure. |
| `parallel` | `(thunks) => Promise<any[]>` | Run an array of zero-arg async functions concurrently. Max 8 lanes, concurrency capped at 4. Returns results in input order. |
| `phase` | `(title) => void` | Mark a status grouping boundary (shown in progress + result). |
| `log` | `(message) => void` | Emit a progress note (shown in progress + result). |
| `args` | `object` | The `args` object passed to the tool (or `{}`). |
| `cwd` | `string` | The session working directory. |

## Sources

- **`script`** — inline JS string, treated as an async function body. Max 20,000 chars; use a file for larger workflows.
- **`name`** — resolved from the **shared** workflows dir first (`pi-shared/workflows/<name>.js`), then the nearest **project** dir (`.pi/workflows/<name>.js`). Project workflows require project trust or an interactive confirmation.
- **`scriptPath`** — explicit path to a `.js` workflow file (absolute or relative to `cwd`).

## Saved workflows

```
pi-shared/workflows/<name>.js   # shared, committed, travels by git
.pi/workflows/<name>.js         # project-local, requires trust
```

List saved workflows with the `/workflows` command.

## Example: inline

```
workflow({
  script: `
    phase("recon");
    const a = await agent("Find the auth module", { agent: "scout" });
    const b = await agent("Find the test runner", { agent: "scout" });
    phase("review");
    const review = await agent(\`Review these findings:\\n\${a}\\n\${b}\`, { agent: "reviewer" });
    return { review };
  `,
})
```

## Example: saved (`research-fanout`)

See [`../../workflows/research-fanout.js`](../../workflows/research-fanout.js):

```
workflow({
  name: "research-fanout",
  args: { questions: [
    "How does spawn_subagent route tasks?",
    "Where is the job store persisted?",
  ] },
})
```

## How subagents run

Each `agent(...)` call spawns an isolated `pi --mode json -p --no-session` subprocess, exactly like `spawn_subagent` single mode:

- **Shared agents only** in v1 (`scout`, `planner`, `reviewer`, `worker`, `panelist`). No `agentScope` / project-agent selection inside workflows.
- **Model precedence**: `opts.model` → agent frontmatter `model` → parent session model. Inheriting the parent model avoids children falling back to a default provider with no credentials.
- **Profile**: subagents inherit the parent's `PI_CODING_AGENT_DIR`. No per-call `agentDir` override, so there is no separate trust-boundary surface.
- **Aborts**: the workflow's abort signal propagates to every running subagent (SIGTERM → SIGKILL after 5s).

## v1 constraints (intentionally boring)

- Pi-backed subagents only — **no external Codex/Claude backends**.
- **No resume-by-replay / journaling.** A failed workflow re-runs from the start.
- **No structured output schema validation.** Return whatever you want; it's serialized to JSON in the result.
- **No per-call `agentDir` / `agentScope`.**

These are deliberate v1 scope cuts. Each can become a v2 feature once the reuse need is proven.

## Trust model

Workflow scripts run **in-process** via the `AsyncFunction` constructor — equivalent trust to `bash`. Only run workflows you trust:

- Shared workflows committed to `pi-shared/workflows/` — trusted by convention (they travel by git under your control).
- Project workflows under `.pi/workflows/` — repo-controlled; require project trust or an interactive confirmation.
- Inline `script` — agent-authored; treat with the same scrutiny as any agent-issued `bash` command.

There is no vm sandbox. This matches the existing trust level of `bash` and `spawn_subagent` in Pi. A sandbox can be added in v2 if workflow sources become less trusted.

## Routing

When `workflow` is an active tool, a routing note is injected into the system prompt steering the model to use `workflow` for repeatable multi-phase orchestration and `spawn_subagent` for ordinary one-off delegation. See `WORKFLOW_ROUTING` in `index.ts`.
