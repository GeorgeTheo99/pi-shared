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
| `condition` | string (optional) | Shell command run with `sh -c` in the session cwd. Exit 0 = met (resume); non‑zero = not yet. Mutually exclusive with `jobs`. |
| `jobs` | string[] (optional) | Background subagent job ids (from `spawn_subagent` with `background:true`) to wait for. Mutually exclusive with `condition`. Polls the spawn‑subagent job store. |
| `job_mode` | string (optional) | With `jobs`: `all` (default), `any`, `any_success`, `any_failure`. Only valid with `jobs`. |
| `timeout` | number (required) | Max seconds to wait. Hard cap 86400 (24h). For longer tasks, chain calls or use launchd + handoff. |
| `poll_interval` | number (optional) | Seconds between checks. Default 10, clamped to [1, 3600]. |
| `progress` | string (optional) | Shell command whose stdout shows as live progress on each poll. Ignored in `jobs` mode (which shows per‑job status). |

## Behavior

- Evaluates `condition` immediately; returns at once if already met.
- Otherwise loops: run condition → (optional) run `progress` → stream a TUI update → sleep `poll_interval` → repeat.
- Returns success when the condition exits 0, an error result on timeout, and a clean "aborted" result if the user interrupts.
- Each condition/progress eval is itself capped at 30s so a hung command can't stall the wait.
- Runs in `executionMode: "sequential"` so it gates the turn.

## Choosing the condition

`pgrep -f aria2c` is **true while the process is running**, so to wait for *completion* either invert it (`! pgrep -f aria2c >/dev/null 2>&1`) or — preferably — watch a completion marker your long task writes (e.g. `grep -q '^DONE ' file.download.log`).

## Waiting for background subagent jobs

`wait_for` can also block until fanned‑out `spawn_subagent({..., background:true})` jobs finish or an interactive child reaches `awaiting_answer`, instead of polling `jobAction: "status"` yourself (which burns tokens on every poll). Fan out the jobs, keep orchestrating in the main session, then gate the dependent step behind a single `wait_for`:

```
# fan out
spawn_subagent({ agent: "worker",   task: "…", background: true })  → bg_abc
spawn_subagent({ agent: "reviewer", task: "…", background: true })  → bg_def
# …main session keeps working…
wait_for({
  jobs: ["bg_abc", "bg_def"],
  job_mode: "all",   // resume when both are terminal (completed/failed/canceled)
  timeout: 1800,
  poll_interval: 10,
})
# resumes with a per‑job status summary + a pointer to fetch full output:
# spawn_subagent({ jobAction: "status", jobId: "bg_abc" })
```

`job_mode` options:

| mode | resume when |
|------|-------------|
| `all` (default) | every listed job reaches a terminal status |
| `any` | the first job reaches any terminal status |
| `any_success` | the first job reaches `completed` |
| `any_failure` | the first job reaches `failed` or `canceled` |

Any watched job reaching `awaiting_answer` wakes immediately regardless of `job_mode`, because continuing to wait would deadlock the parent that must answer it. Fetch the question with `spawn_subagent({jobAction:"status",jobId})`, then resume the same child with `spawn_subagent({jobAction:"answer",jobId,questionId,answer})`.

Terminal statuses are `completed`, `failed`, `canceled`; `awaiting_answer` is actionable but nonterminal, and `canceling` remains nonterminal until the owner has actually stopped and reaped its child processes. While waiting, the TUI shows terminal and awaiting-answer counts plus a per-job status block. `wait_for` reads the same owner-leased, atomically written job store (`~/.pi/agent/spawn-subagent/jobs.json`, overridable via `PI_SUBAGENT_STATE_DIR` or legacy `PI_SPAWN_SUBAGENT_DIR`) that `jobAction: "status"` uses, so it works across sessions/processes and treats expired owner leases as failed instead of hanging indefinitely.

## Beyond `wait_for`: event‑driven resume (documented pattern, not built)

`wait_for` keeps the full conversation in memory and resumes **in place, zero‑token, zero re‑read** — so for any task that fits in its 24h cap while Pi can stay open (a `tmux`/`nohup` session survives logout on an always‑on server), `wait_for` is the right tool and there is nothing to gain from killing the process. The patterns below only earn their keep when a task **exceeds 24h** or must **survive a reboot / Pi process death**, and they cost more than `wait_for` (a fresh‑session re‑read at resume, plus launchd moving parts). They are documented here as the known escalation path; they are **not** built tooling yet.

The decisive question is what the post‑wait step is:

| Post‑wait step | Pattern | Pi involved at resume? |
|---|---|---|
| Fixed shell command (e.g. `mv .partial final && fan_out && restart gateway`) | Thin launchd shell‑tail | No — launchd runs the shell directly |
| Needs agent judgment / multi‑step reasoning | Full handoff + launchd resume | Yes — relaunches Pi via `resume‑handoff` |

Most long‑task tails (download→stage→deploy, build→test→publish) are deterministic shell. For those, Pi doesn't need to resume at all — a `launchd` watcher runs the tail when the completion signal fires. Zero Pi, zero tokens, fully event‑driven, reboot‑safe. **Prefer this over full handoff resume whenever the tail is fixed shell.**

### Pattern A — thin launchd shell‑tail (recommended for deterministic tails)

A `WatchPaths`‑triggered launchd job that runs the fixed shell tail when the long task's completion marker appears.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.local.glm52-download-tail</string>
  <key>WatchPaths</key>
  <array><string>/Users/localserver99/models/mlx/GLM-5.2-mxfp4.download.log</string></array>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string><string>-lc</string>
    <string>set -euo pipefail
# Idempotent: only act once, on the SUCCESS marker, not on every log write.
LOG="$HOME/models/mlx/GLM-5.2-mxfp4.download.log"
grep -q '^DONE ' "$LOG" || exit 0
[ -f "$HOME/models/mlx/GLM-5.2-mxfp4" ] || { echo "DONE but final missing" >&2; exit 1; }
mv "$HOME/models/mlx/GLM-5.2-mxfp4.partial"/* "$HOME/models/mlx/GLM-5.2-mxfp4/" 2>/dev/null || true
cd "$HOME/local_code/server/omlx-config" && python3 fan_out_settings.py
cd "$HOME/local_code/server" && scripts/update-home-server.sh --deploy-current
launchctl kickstart -k gui/$(id -u)/com.local.claude-proxy
launchctl unload "$HOME/Library/LaunchAgents/com.local.glm52-download-tail.plist"  # one‑shot, clean up
</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StandardOutPath</key><string>/tmp/glm52-tail.out.log</string>
  <key>StandardErrorPath</key><string>/tmp/glm52-tail.err.log</string>
</dict>
</plist>
```

Load with `launchctl load ~/Library/LaunchAgents/com.local.glm52-download-tail.plist`. This can be driven through the `macos-scheduler` integration bundle (`enterprise_macos_scheduler` tool), which already covers file‑change watchers.

**Gotchas to design for when this becomes a real helper:**
- `WatchPaths` fires on **any** write to the watched path, including appends — the tail script must be idempotent (guard on a success marker like `^DONE `, exit 0 otherwise) and self‑unload after one real run.
- Distinguish success vs failure markers (the house convention logs `^DONE ` on success; add a `^FAILED ` marker and refuse to run on it).
- Minimal environment: launchd has no shell `PATH`/profile — set `PATH` and any `PI_*`/provider env explicitly.
- TTL / litter: if the long task never completes (download failed), the watcher sits forever — add a calendar‑based expiry or a cleanup step.
- Collision: don't also re‑enter Pi manually on the same goal while a watcher is armed.

### Pattern B — full handoff + launchd resume (only when the tail needs agent judgment)

For tails that genuinely require the agent to inspect output, decide, and branch:

1. Before exiting, Pi writes a handoff note (`handoff` skill → `~/.claude/handoffs/handoff‑<ts>.md`) describing the in‑flight task, the completion signal to expect, and exactly what to do once it fires. Keep the durable goal active.
2. A `WatchPaths`‑triggered launchd job fires when the completion marker appears and relaunches Pi pointed at that handoff:
   ```
   PI_CODING_AGENT_DIR=~/.pi-omlx/agent pi @~/.claude/handoffs/handoff-<ts>.md \
     "The download finished. Read the handoff and continue the post-download steps autonomously."
   ```
3. The resumed session re‑grounds from the handoff note + `git status`/repo state, then continues.

**Honest caveats (why this is the fallback, not the default):**
- Resume is a **fresh session**: it re‑reads the handoff + repo to rebuild context (a real token cost `wait_for` avoids entirely), and the standard `resume‑handoff` skill pauses to ask the user before proceeding — a truly fire‑and‑forget resume needs a non‑interactive resume path that doesn't exist yet.
- No continuity of in‑memory state; anything not written to the handoff or disk is lost.
- Launchd minimal‑env + WatchPaths double‑fire + success/failure‑marker + TTL/collision concerns from Pattern A all apply, plus now a Pi process to launch and a goal to reconcile.
- On an always‑on server, leaving Pi open in `tmux` with a `wait_for` call is almost always simpler and strictly cheaper.

### When to escalate

- **Don't escalate** if the task ≤ 24h and Pi can stay open — `wait_for` is strictly better.
- **Pattern A** if the post‑wait step is fixed shell AND the task must survive reboot / >24h / run with no Pi open.
- **Pattern B** if the post‑wait step needs agent judgment AND the task must survive reboot / >24h / run with no Pi open. Rare.
