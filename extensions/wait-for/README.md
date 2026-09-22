# Wait tools

Three focused tools block the agent loop — **without burning tokens while waiting**:

- `wait_for_condition`: wait for a shell predicate.
- `wait_for_jobs`: wait for command/subagent terminal outcomes or an interactive question.
- `wait_for_ready`: wait for all command readiness probes while processes remain running.

There is no legacy `wait_for` registration. Each public schema rejects unrelated fields, including the old `readiness` switch. Arguments are validated with Pi's stock validator even for direct execution; validation errors do not echo submitted values.

## Why

Pi's agent loop is strictly `LLM → tool → LLM → tool`. There is no native "block until an external event, then resume" step, so waiting usually means **polling** — emitting a tool call to check state on every iteration, which re-sends the whole conversation context (cache reads) each turn. During a 22‑minute download that produced ~11 explicit polls and ~1.4M cache‑read tokens in one session, even though the per‑poll work was tiny.

Each wait tool turns the wait itself into a single blocking tool call. While it runs, **no LLM call happens, so the wait costs zero tokens**. The loop resumes the instant the condition is met or the timeout fires. Optional `progress` output streams to the TUI, and the call is fully abortable (Esc/Ctrl‑C).

## Usage

Gate a dependent step behind a detached long‑running task (download, build, deploy, training) **after** any parallel prep work is done.

```
wait_for_condition({
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
| `condition` | string (required for `wait_for_condition`) | Nonempty read-only predicate run with `sh -c` in the session cwd. Exit 0 = met; configured `failure_exit_codes` = fatal; other nonzero = not yet. |
| `jobs` | string[] (required for `wait_for_jobs` / `wait_for_ready`) | 1–64 nonempty job IDs. `wait_for_ready` accepts only `cmd_…` IDs with configured probes. |
| `job_mode` | enum (optional, `wait_for_jobs` only) | `all` (default), `any`, `any_success`, `any_failure`. |
| `failure_exit_codes` | integer[] (optional, `wait_for_condition` only) | Up to 255 fatal exit codes, each 1–255. Default `[126,127]` (not executable/not found). Overrides the default; `[]` retries all nonzero exits. |
| `timeout` | number (required) | Max seconds to wait. Hard cap 86400 (24h). For longer tasks, chain calls or use launchd + handoff. |
| `poll_interval` | number (optional) | Seconds between checks. Default 10, clamped to [1, 3600]. |
| `progress` | string (optional, `wait_for_condition` only) | Read-only shell command whose stdout shows as live progress on each pending check. Job waits show per-job status automatically. |

`timeout` and `poll_interval` apply to all three tools. `timeout` must be positive and is rounded down and clamped to [1, 86400] seconds. `wait_for_ready` always waits for **all** probes; it accepts neither `job_mode` nor `readiness`.

## Behavior

- Evaluates `condition` immediately; returns at once if already met.
- Otherwise loops: run condition → (optional) run `progress` → stream a TUI update → sleep `poll_interval` → repeat.
- Returns success only when the condition exits 0 without forced termination before the overall deadline; fatal exit codes or shell startup errors fail promptly. Timeout is an error; interruption returns an explicit "aborted" result.
- Each condition/progress eval is capped at 30s and the remaining overall deadline. No new evaluation starts after the deadline; termination/cleanup adds bounded grace. A timed-out shell cannot signal success even if its TERM handler exits 0.
- Condition/progress process groups are cleaned up even after a natural shell exit. Do not launch background work from a predicate; start it separately as a managed command job. Descendants that escape the original process group are outside cleanup coverage.
- Timeout errors retain bounded excerpts of the last **nonempty** stdout/stderr and progress, which may come from an earlier check. Empty checks do not erase useful diagnostics.
- Runs in `executionMode: "sequential"` so it gates the turn.

## Choosing the condition

`pgrep -f aria2c` is **true while the process is running**, so to wait for *completion* either invert it (`! pgrep -f aria2c >/dev/null 2>&1`) or — preferably — watch a completion marker your long task writes (e.g. `grep -q '^DONE ' file.download.log`).

### Remote deployment predicates

A successful status query means the query worked, **not** that deployment succeeded. Query the exact deployment and inspect its structured status. Use an explicit predicate contract, for example:

```
wait_for_condition({
  condition: "./scripts/check-deployment.sh", // your own read-only status predicate
  failure_exit_codes: [2, 126, 127],
  timeout: 600,
  poll_interval: 10,
})
```

That script should exit **0** only on verified success, **1** while pending, and **2** on terminal deployment failure or unrecoverable authentication/configuration errors (write the reason to stderr). Choose which transport errors are retryable deliberately. `failure_exit_codes` replaces the default list, so retain 126/127 if desired. A pipeline can mask an upstream CLI failure: capture/check the query's exit status before parsing its JSON; do not rely on the last pipeline command alone. `wait_for_condition` cannot infer remote state or authentication failure from arbitrary CLI output.

## Waiting for background subagent jobs

`wait_for_jobs` blocks for background jobs launched with `subagent_run` (single), `subagent_parallel`, or `subagent_chain`, or an interactive child reaching `awaiting_answer`. Do independent work first, then use one blocking wait instead of repeated `subagent_status` calls:

```js
// Launch single jobs with subagent_run({ agent: "worker", task: "…", background: true }).
// After independent work, use the returned job IDs:
wait_for_jobs({
  jobs: ["sub_abc", "sub_def"],
  job_mode: "all",   // both terminal, not necessarily successful
  timeout: 1800,
  poll_interval: 10,
})
subagent_status({ jobId: "sub_abc" })
```

`job_mode` options:

| mode | resume when |
|------|-------------|
| `all` (default) | every listed job reaches a terminal status |
| `any` | the first job reaches any terminal status |
| `any_success` | the first job reaches `completed` |
| `any_failure` | the first job reaches `failed` or `canceled` |

Any watched job reaching `awaiting_answer` wakes immediately regardless of `job_mode`, because continuing to wait would deadlock the parent that must answer it. Fetch the question with `subagent_status({jobId})`, then resume the same child with `subagent_answer({jobId,questionId,answer})` using the exact current question ID, and call `wait_for_jobs` again.

Terminal statuses are `completed`, `failed`, `canceled`; `awaiting_answer` is actionable but nonterminal, and `canceling` remains nonterminal until the owner has actually stopped and reaped its child processes. While waiting, the TUI shows terminal and awaiting-answer counts plus a per-job status block. `wait_for_jobs` reads the same owner-leased, atomically written job store (`~/.pi/agent/spawn-subagent/jobs.json`, overridable via `PI_SUBAGENT_STATE_DIR` or legacy `PI_SPAWN_SUBAGENT_DIR`) that `subagent_status` uses, so it works across sessions/processes and treats expired owner leases as failed instead of hanging indefinitely.

## Managed command jobs

`wait_for_jobs` also accepts managed `cmd_…` command IDs, alone or mixed with subagent
IDs. Completion means terminal, not necessarily successful: inspect the returned
command status and exact exit code. The result headline counts unsuccessful jobs and pending questions; those outcomes render as warnings rather than a green "Jobs ready" success. Unknown IDs and impossible `any_success` or
`any_failure` outcomes fail promptly. Wait interruption leaves jobs running.

For configured local server probes use:

```js
wait_for_ready({ jobs: ["cmd_server"], timeout: 60, poll_interval: 1 })
command_status({ id: "cmd_server" })
```

It waits for every probe to be ready while its command is still running; readiness is not completion. Missing or failed probes and stopped commands fail promptly. Abort does not cancel jobs: use `command_cancel({id})` or `subagent_cancel({jobId})` explicitly. See [command jobs](../command-jobs/README.md).
Shell evaluations respect the remaining overall deadline, plus bounded process
cleanup grace, and retain at most 1 MiB stdout instead of unbounded capture.

## Beyond blocking waits: event‑driven resume (documented pattern, not built)

Blocking waits keep the full conversation in memory and resume **in place, zero‑token, zero re‑read** — so for any task that fits in the 24h cap while Pi can stay open (a `tmux`/`nohup` session survives logout on an always‑on server), a wait tool is the right choice and there is nothing to gain from killing the process. The patterns below only earn their keep when a task **exceeds 24h** or must **survive a reboot / Pi process death**, and they cost more than a blocking wait (a fresh‑session re‑read at resume, plus launchd moving parts). They are documented here as the known escalation path; they are **not** built tooling yet.

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
  <array><string>/Users/<user>/models/mlx/GLM-5.2-mxfp4.download.log</string></array>
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
launchctl kickstart -k gui/$(id -u)/com.local.model-gateway
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

1. Before exiting, Pi writes a handoff note (`handoff` skill → `~/.pi/handoffs/handoff‑<ts>.md`) describing the in‑flight task, the completion signal to expect, and exactly what to do once it fires. Keep the durable goal active.
2. A `WatchPaths`‑triggered launchd job fires when the completion marker appears and relaunches Pi pointed at that handoff:
   ```
   PI_CODING_AGENT_DIR=~/.pi-omlx/agent pi @~/.pi/handoffs/handoff-<ts>.md \
     "The download finished. Read the handoff and continue the post-download steps autonomously."
   ```
3. The resumed session re‑grounds from the handoff note + `git status`/repo state, then continues.

**Honest caveats (why this is the fallback, not the default):**
- Resume is a **fresh session**: it re‑reads the handoff + repo to rebuild context (a real token cost the wait tools avoid entirely), and the standard `resume‑handoff` skill pauses to ask the user before proceeding — a truly fire‑and‑forget resume needs a non‑interactive resume path that doesn't exist yet.
- No continuity of in‑memory state; anything not written to the handoff or disk is lost.
- Launchd minimal‑env + WatchPaths double‑fire + success/failure‑marker + TTL/collision concerns from Pattern A all apply, plus now a Pi process to launch and a goal to reconcile.
- On an always‑on server, leaving Pi open in `tmux` with a blocking wait call is almost always simpler and strictly cheaper.

### When to escalate

- **Don't escalate** if the task ≤ 24h and Pi can stay open — a blocking wait is strictly better.
- **Pattern A** if the post‑wait step is fixed shell AND the task must survive reboot / >24h / run with no Pi open.
- **Pattern B** if the post‑wait step needs agent judgment AND the task must survive reboot / >24h / run with no Pi open. Rare.
