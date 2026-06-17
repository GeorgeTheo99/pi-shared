# wait_for

A "pause and wait" tool for Pi. Blocks the agent loop until a shell condition is true, then resumes — **without burning tokens while waiting**.

## Why

Pi's agent loop is strictly `LLM → tool → LLM → tool`. There is no native "block until an external event, then resume" step, so waiting usually means **polling** — emitting a tool call to check state on every iteration, which re-sends the whole conversation context (cache reads) each turn. During a 22‑minute download that produced ~11 explicit polls and ~1.4M cache‑read tokens in one session, even though the per‑poll work was tiny.

`wait_for` turns the wait itself into a single blocking tool call. While it runs, **no LLM call happens, so the wait costs zero tokens**. The loop resumes the instant the condition is met or the timeout fires. Optional `progress` output streams to the TUI, and the call is fully abortable (Esc/Ctrl‑C).

## Usage

Gate a dependent step behind a detached long‑running task (download, build, deploy, training) **after** any parallel prep work is done.

```
wait_for({
  // exit 0 = met. Watch a DONE marker the download script already writes:
  condition: "grep -q '^DONE ' ~/models/mlx/GLM-5.2-mxfp4.download.log 2>/dev/null",
  // or invert a process check:
  // condition: "! pgrep -f aria2c >/dev/null 2>&1",
  // or a file:
  // condition: "test -f /path/to/done.flag",
  timeout: 3600,
  poll_interval: 15,
  progress: "du -sh ~/models/mlx/GLM-5.2-mxfp4.partial 2>/dev/null | cut -f1",
})
```

## Parameters

| param | type | description |
|-------|------|-------------|
| `condition` | string (required) | Shell command run with `sh -c` in the session cwd. Exit 0 = met (resume); non‑zero = not yet. |
| `timeout` | number (required) | Max seconds to wait. Hard cap 86400 (24h). For longer tasks, chain calls or use launchd + handoff. |
| `poll_interval` | number (optional) | Seconds between checks. Default 10, clamped to [1, 3600]. |
| `progress` | string (optional) | Shell command whose stdout shows as live progress on each poll. |

## Behavior

- Evaluates `condition` immediately; returns at once if already met.
- Otherwise loops: run condition → (optional) run `progress` → stream a TUI update → sleep `poll_interval` → repeat.
- Returns success when the condition exits 0, an error result on timeout, and a clean "aborted" result if the user interrupts.
- Each condition/progress eval is itself capped at 30s so a hung command can't stall the wait.
- Runs in `executionMode: "sequential"` so it gates the turn.

## Choosing the condition

`pgrep -f aria2c` is **true while the process is running**, so to wait for *completion* either invert it (`! pgrep -f aria2c >/dev/null 2>&1`) or — preferably — watch a completion marker your long task writes (e.g. `grep -q '^DONE ' file.download.log`).

## For multi‑hour / multi‑day tasks

`wait_for` blocks the TUI for up to 24h. For genuinely long tasks where even a blocking call is undesirable, prefer the launchd + handoff event‑driven resume pattern: write a handoff note + durable goal, exit, and let a launchd watcher relaunch Pi when the completion signal fires.
