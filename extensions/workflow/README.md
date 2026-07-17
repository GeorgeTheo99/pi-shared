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
| `agent` | `(prompt, opts?) => Promise<string>` | Run one Pi subagent. `opts.agent` picks a shared agent (`scout`, `planner`, `reviewer`, `worker`, `panelist`; default `worker`). `opts.model` / `opts.cwd` are optional. `opts.onProgress(text)` receives each streamed assistant update **while the subagent is still running**, so the orchestrator can observe in-progress findings. Returns the subagent's final assistant text. Throws on failure. |
| `parallel` | `(thunks) => Promise<any[]>` | Run zero-arg async lanes concurrently. Default max 16 agent calls; actual children share the host-wide 8-slot scheduler with `spawn_subagent`. Returns results in input order. |
| `phase` | `(title) => void` | Mark a status grouping boundary (shown in progress + result). |
| `log` | `(message) => void` | Emit a progress note (shown in progress + result). |
| `cache` | `(key, producer) => Promise<T>` | Resume-by-replay primitive. When journaling is enabled (`args._journal`), a completed `key`'s result is replayed from disk instead of re-running `producer`; otherwise it degrades to `await producer()`. See [Resume-by-replay](#resume-by-replay-journaling). |
| `args` | `object` | The `args` object passed to the tool (or `{}`). The reserved key `args._journal` enables journaling. |
| `cwd` | `string` | The session working directory. |

## Live observability & steering

Each `agent(...)` call streams the subagent's `--mode json` events. Two things surface that live activity:

- **TUI progress** shows a per-agent line with a `[N↑]` counter of streamed updates so a long-running subagent visibly advances rather than looking frozen. Aborting the workflow (Esc/Ctrl-C) propagates to every running subagent (SIGTERM → SIGKILL after 5s).
- **`opts.onProgress(text)`** hands each streamed update to your workflow JS. This is the *orchestrator-visible* channel — use it to log, trip an early-exit, or feed a supervisor decision. Workflow `agent()` calls are one-shot, so workflow steering remains between bounded calls (see `supervisor`). For proactive mid-turn coordination, use an interactive background `spawn_subagent` job with `jobAction:"steer"` or `jobAction:"followup"`.

```js
await agent("Do the long thing", {
  agent: "worker",
  onProgress: (text) => log(`worker streamed ${text.length} chars`),
});
```

## Resume-by-replay (journaling)

Wrap expensive steps in `cache(key, () => agent(...))` and run with a stable `args._journal` id. Successful results are persisted under `~/.pi/workflow-journal/` using a readable prefix plus a hash of the exact id. Only successful steps are journaled, so re-invoking with the same id replays completed steps and resumes a failed run from the first incomplete step instead of restarting from scratch.

Journal replay is bound to the workflow code, arguments, working directory, parent model, and discovered agent prompts/configuration. Reusing an id with a different execution contract fails closed instead of replaying stale results. Entries are exact JSON values, size-bounded without truncation, merged under an interprocess lock, and published atomically; corrupt or older journal formats also fail closed.

```js
workflow({ name: "my-pipeline", args: { _journal: "nightly-2026-06-22" } })
// first run: computes step1, step2, crashes in step3
// re-run same id: replays step1+step2 from disk, resumes at step3
```

Inside the workflow:

```js
const recon = await cache("recon", () => agent("Map the module", { agent: "scout" }));
const plan  = await cache("plan",  () => agent(`Plan from:\n${recon}`, { agent: "planner" }));
const impl  = await cache("impl",  () => agent(`Implement:\n${plan}`,  { agent: "worker" }));
```

The result footer reports `journal: <id> (replayed N, computed M)`.

## Sources

- **`script`** — inline JS string, treated as an async function body. Max 20,000 chars; always requires explicit interactive approval and is blocked without a UI. Use a committed saved workflow for repeatable code.
- **`name`** — resolved from the **shared** workflows dir first (`pi-shared/workflows/<name>.js`), then the nearest **project** dir (`.pi/workflows/<name>.js`). Project workflows require project trust or an interactive confirmation.
- **`scriptPath`** — explicit `.js` file (absolute or relative to `cwd`). Shared files and trusted-project files run directly; untrusted project or external files require interactive approval. Noninteractive external paths must be under `PI_WORKFLOW_ALLOWED_SCRIPT_DIRS`.

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

## Example: supervisor (checkpoint steering)

A `worker` performs a task; a `reviewer` judges each attempt against a rubric and replies with exactly `ACCEPT` and no other text, or `REVISE: <instruction>`. A `REVISE` redirects the worker's next attempt. The loop is bounded by `maxRounds`; malformed or decorated accept verdicts do not pass. This is checkpoint steering between bounded steps.

```
workflow({
  name: "supervisor",
  args: {
    task: "Implement X in file Y and report the diff",
    rubric: "Must edit the real file, run a verification command, and show the diff",
    maxRounds: 3,
  },
})
```

Returns `{ rounds, accepted, finalOutput, history }` where `history` is the per-round verdict trail.

## How subagents run

Each `agent(...)` call spawns an isolated `pi --mode json -p --no-session` subprocess, exactly like `spawn_subagent` single mode:

- **Shared agents only** in v1 (`scout`, `planner`, `reviewer`, `worker`, `panelist`). No `agentScope` / project-agent selection inside workflows.
- **Model precedence**: `opts.model` → agent frontmatter `model` → parent session model. Inheriting the parent model avoids children falling back to a default provider with no credentials.
- **Profile/model routing**: no per-call `agentDir` override. The shared runner preserves parent/profile inheritance and routes GPT-family models through the trusted OpenAI Codex subscription profile when available, matching `spawn_subagent`.
- **Scheduling**: every `agent()` call—including calls made through direct `Promise.all`, not only `parallel()`—acquires the host-wide lease. Default request limit is 16 and host concurrency is 8.
- **Aborts/timeouts**: workflow abort/failure/session shutdown cancels queued work and terminates running process trees (SIGTERM, then SIGKILL after the configured grace). Queue/run deadlines and output bounds match `spawn_subagent`.
- **Nesting**: child sessions cannot delegate again by default (`PI_SUBAGENT_MAX_DEPTH=1`).

## Constraints

- Pi-backed subagents only — **no external Codex/Claude backends**.
- **Resume-by-replay is opt-in** via `cache()` + `args._journal`. Without a journal id, a failed workflow re-runs from the start.
- **No structured output schema validation.** Return whatever you want; it's serialized to JSON in the result.
- **No per-call `agentDir` / `agentScope`.**
- **At most 16 agent calls per workflow by default.** Change shared limits with the `PI_SUBAGENT_*` variables documented in [`../spawn-subagent/README.md`](../spawn-subagent/README.md).
- **Workflow steering is between steps, not mid-step.** Use the `supervisor` pattern for checkpoint course-correction. The separate interactive `spawn_subagent` mode provides acknowledged `steer` and `followup` controls when proactive coordination is required.

These are deliberate v1 scope cuts. Each can become a v2 feature once the reuse need is proven.

## Trust model

Workflow scripts run **in-process** via the `AsyncFunction` constructor — equivalent trust to `bash`. Only run workflows you trust:

- Shared workflows committed to `pi-shared/workflows/` — trusted by convention (they travel by git under your control).
- Project workflows under `.pi/workflows/` — repo-controlled; their code is not read until project trust or explicit interactive approval.
- Explicit `scriptPath` files are canonicalized with `realpath`; symlink escapes and external paths require approval unless their directory is allowlisted with `PI_WORKFLOW_ALLOWED_SCRIPT_DIRS`.
- Inline `script` — agent-authored and always gated by an interactive confirmation that shows a source preview and SHA-256 digest. It is blocked in noninteractive contexts.

There is no vm sandbox. This matches the existing trust level of `bash` and `spawn_subagent` in Pi. A sandbox can be added in v2 if workflow sources become less trusted.

## Routing

When `workflow` is an active tool, a routing note is injected into the system prompt steering the model to use `workflow` for repeatable multi-phase orchestration and `spawn_subagent` for ordinary one-off delegation. See `WORKFLOW_ROUTING` in `index.ts`.
