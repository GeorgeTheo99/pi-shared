# pi-jobs tools

Schedule and inspect unattended coding-agent jobs on a [pi-jobs](https://github.com/GeorgeTheo99/pi-jobs)
server from any Pi session: "every weekday at 7, check model-gateway for new models and add them
with tests" becomes a job without leaving the conversation.

This extension is only a client. pi-jobs is a separate install that owns jobs, schedules, runs,
worktrees and its web UI; these tools call its HTTP API with an API token. Runs happen on the
server, in a fresh git worktree from the pushed tip of the base branch, and leave changes on a
branch. They never merge or deploy.

```javascript
jobs_create({name:"Gateway model check", prompt:"…self-contained instructions…",
             schedule:"0 7 * * 1-5", checkCommand:"uv run pytest"})
jobs_run({jobId:3})            // try it once now
jobs_runs({runId:41})          // status, branch and the end of the log
jobs_update({jobId:3, enabled:false})
jobs_list({})
```

| Tool | Required fields | Optional fields |
| --- | --- | --- |
| `jobs_list` | None | `jobId` (one job, with its full instructions) |
| `jobs_create` | `name`, `prompt` | `schedule`, `agent`, `baseRef`, `checkCommand`, `timeoutMinutes`, `webhook`, `pushBranch`, `enabled`, `repo`, `serverRepoPath` |
| `jobs_update` | `jobId` | Same as `jobs_create`; only given fields change |
| `jobs_run` | `jobId` | None |
| `jobs_runs` | None | `jobId`, `runId`, `limit`, `logChars` |

Deleting jobs, managing tokens and webhook tokens stay in the pi-jobs UI.

## Configuration

The tools are registered only when a server is configured:

| Source | Contents |
| --- | --- |
| `~/.config/pi-jobs/client.json` (mode `0600`) | `{"url": "…", "token": "pjt_…"}`, written by `pi-jobs client-config <url> <token>`, or by `pi-jobs token create <name> --client-config` on the server itself |
| `PI_JOBS_URL`, `PI_JOBS_TOKEN` | Override the file |

Start a new session after configuring. Every call first checks the server's `/api/health`
`apiVersion` (currently `1`) and stops with an update hint if the server speaks another version.

## Which repository a job is for

`repo` (default: the session's working directory) is a local checkout.

- **Loopback server** (`127.0.0.1`, `localhost`): the job uses the checkout's own path.
- **Remote server** (for example over Tailscale): the tools send the checkout's remote URLs, and
  the server picks its own checkout of the same repository under `PI_JOBS_REPO_ROOTS`. An SSH
  remote such as `me@studio:repos/app.git` matches the server's checkout whose `origin` is
  `~/repos/app.git`. When the server finds none or several, pass `serverRepoPath`.

## Safeguards

- **Confirmation:** in interactive sessions `jobs_create` and `jobs_update` show the job and save
  only after the user confirms. A non-interactive session's prompt is its approval.
- **No recursion:** nothing is registered inside a pi-jobs run (`PI_JOBS_RUN_ID` set), so a
  scheduled agent cannot schedule more jobs.
- **Subagents:** delegated subagents (`PI_SUBAGENT_DEPTH > 0`) can list jobs and runs but not
  create, change or start them.
- **Untrusted output:** job instructions and run logs are returned as data, not instructions.
- **Token scope:** a pi-jobs token can run agents as the server's owner. Keep `client.json`
  private and revoke tokens in the pi-jobs UI when a machine no longer needs one.
