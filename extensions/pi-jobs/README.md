# pi-jobs tools

Schedule and inspect unattended coding-agent jobs on a [pi-jobs](https://github.com/GeorgeTheo99/pi-jobs)
server from any Pi session: "every weekday at 7, check model-gateway for new models and add them
with tests" becomes a job without leaving the conversation.

This extension is only a client. pi-jobs is a separate install that owns jobs, schedules, runs,
worktrees and its web UI; these tools call its HTTP API with an API token. Runs happen on the
server, in a fresh git worktree from the pushed tip of the base branch, and leave changes on a
branch, like a pull request. They never merge or deploy by themselves: a finished item is
released only when the user approves it (`jobs_ship` or **Approve & release** in the UI), by the
job's agent following its `releaseInstructions` or by its `shipCommand` script, unless the job
has `autoRelease`.

```javascript
jobs_create({name:"Gateway model check", prompt:"…self-contained instructions…",
             schedule:"0 7 * * 1-5", checkCommand:"uv run pytest"})
jobs_run({jobId:3})            // try it once now
jobs_runs({runId:41})          // status, branch and the end of the log
jobs_update({jobId:3, enabled:false})
jobs_list({})
jobs_approve({runId:42, decision:"approve"})   // or "dismiss"
jobs_ship({runId:41})          // release that item's result (releaseInstructions or shipCommand)
```

| Tool | Required fields | Optional fields |
| --- | --- | --- |
| `jobs_list` | None | `jobId` (one job, with its full instructions) |
| `jobs_create` | `name`, `prompt` | `schedule`, `agent`, `baseRef`, `checkCommand`, `timeoutMinutes`, `webhook`, `pushBranch`, `watchCommand`, `approveRuns`, `shipCommand`, `releaseInstructions`, `autoRelease`, `enabled`, `repo`, `serverRepoPath` |
| `jobs_update` | `jobId` | Same as `jobs_create`; only given fields change |
| `jobs_run` | `jobId` | None |
| `jobs_runs` | None | `jobId`, `runId`, `limit`, `logChars` |
| `jobs_approve` | `runId`, `decision` (`approve` or `dismiss`) | None |
| `jobs_ship` | `runId` (any run of the item) | None |

`watchCommand` makes each scheduled time run a command instead of the agent; every JSON line it
prints with a new `id` starts one run with that line as the payload. With `approveRuns`, runs from
the schedule, webhook or watch wait as `awaiting_approval` until `jobs_approve` or the UI decides.
Both need pi-jobs 0.3.0 or later; older servers ignore them.

`shipCommand` (pi-jobs 0.6.0) adds Ship: `jobs_ship` or the UI runs it in a checkout of a finished
item's result, with `PI_JOBS_SHIP_COMMIT`, `PI_JOBS_SHIP_BRANCH`, `PI_JOBS_BASE_REF` and
`PI_JOBS_REPO` set. It is never retried; when it fails, the item's next follow-up gives the agent
its output. See pi-jobs' README, Release.

`releaseInstructions` (pi-jobs 0.8.0, instead of `shipCommand`) has the job's agent release the
item: it continues the item's conversation and, in that run only, may merge, push, deploy and
publish. `autoRelease` releases every run that succeeds with changes without asking. `agent` takes
`pi`, `claude`, `codex` or any agent added in the server's Settings, such as a Pi launcher with its
own model (`pi-claude`). Older servers ignore the new fields.

With pi-jobs 0.9.0, `jobs_ship` shows what the release would release (commit, size, how far the
base branch moved and whether it merges cleanly, the check) in its confirmation and pins the
release to that commit, so a follow-up that lands meanwhile makes it refuse. `verifyCommand` runs
after a release and must pass; `autoRelease` then also needs a `checkCommand`, and releases only
runs whose check passed and whose report says implemented or fixed.

Deleting jobs, managing tokens and webhook tokens stay in the pi-jobs UI.

## Configuration

The tools are registered only when a server is configured:

| Source | Contents |
| --- | --- |
| `~/.config/pi-jobs/client.json` (mode `0600`) | `{"url": "…", "token": "pjt_…"}`, written by `pi-jobs client-config <url>` (which reads the token from stdin), or by `pi-jobs token create <name> --client-config` on the server itself |
| `PI_JOBS_URL` and `PI_JOBS_TOKEN` | Used instead of the file; set both or neither, so a token is never sent to a URL it wasn't saved with |

Plain `http://` is accepted only for loopback and tailnet hosts; anything else needs `https://`.
An incomplete or unsafe configuration disables the tools with a warning at session start.
Start a new session after configuring. Every call first checks the server's `/api/health`
`apiVersion` (currently `1`) and stops with an update hint if the server speaks another version.

## Which repository a job is for

`repo` (default: the session's working directory) is a local checkout. A linked worktree stands
for its main checkout.

- **Loopback server** (`127.0.0.1`, `localhost`): the job uses the checkout's own path.
- **Remote server** (for example over Tailscale): the tools send the checkout's remote URLs, and
  the server picks its own checkout of the same repository under `PI_JOBS_REPO_ROOTS`. An SSH
  remote such as `me@studio:repos/app.git` matches the server's checkout whose `origin` is
  `~/repos/app.git`. When the server finds none or several, pass `serverRepoPath`.

## Safeguards

- **Confirmation:** in interactive sessions `jobs_create`, `jobs_update`, `jobs_run` and `jobs_approve` show the
  job and act only after the user confirms. Non-interactive sessions (print mode, scripts) change
  nothing unless `PI_JOBS_AUTO_APPROVE=1` declares their prompt trusted. `jobs_ship` always asks
  the user in an interactive session, and is refused without one, auto-approve or not: a ship may
  not be undoable. Confirmations stay dialog-sized (at most 12 lines, 800 characters): `jobs_update`
  lists only the fields it changes, and instructions and release instructions appear as a one-line
  excerpt with their size; the full text is saved and shown by `jobs_list`.
- **Not offered inside runs:** nothing is registered inside a pi-jobs run (`PI_JOBS_RUN_ID` set).
  This keeps scheduled agents from reaching for these tools; it is not a sandbox, since an
  unsandboxed agent runs as the owner and could read a token file.
- **Subagents:** delegated subagents (`PI_SUBAGENT_DEPTH > 0`) can list jobs and runs but not
  create, change or start them.
- **Untrusted output:** job settings, instructions and run logs are returned inside nonce-tagged
  `<pi-jobs-data …>` markers as data, not instructions.
- **Token scope:** a pi-jobs token can run agents as the server's owner. Keep `client.json`
  private and revoke tokens in the pi-jobs UI when a machine no longer needs one.
