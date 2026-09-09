# Managed command jobs

`command_job` starts bounded local commands without ad-hoc PID files or shell
completion markers. It does not replace `bash`, grant approval for external actions,
or provide an OS sandbox. Requires a trusted caller workspace.

```javascript
command_job({action:"start", command:"npm", args:["test"], timeout_seconds:600})
// => cmd_<uuid>; do independent work, then:
wait_for({jobs:["cmd_<uuid>"], timeout:660})
command_job({action:"status", id:"cmd_<uuid>"})
command_job({action:"logs", id:"cmd_<uuid>", stream:"stderr", max_bytes:8192})
command_job({action:"cancel", id:"cmd_<uuid>"})
```

Actions: `start`, `status`, `list`, `logs`, `cancel`. Fields not applicable to the
action are rejected. `start` requires `command` and `timeout_seconds` (up to 24h).
Optional `args`, `cwd` relative to caller workspace, non-sensitive `label`, and
`readiness` are supported. For explicitly intended shell syntax use `command:"sh"`
and `args:["-c", script]`; there is no implicit shell expansion. Commands inherit
the owner's environment; argv and environment values are not stored in metadata.
Workspace scope is the canonical caller cwd, independently of the command cwd.

## Readiness and completion

A probe is optional and limited to literal `127.0.0.1`, TCP or HTTP GET (2xx only,
no redirects/response capture). Example `readiness:{kind:"http",port:8100,
path:"/health",timeout_seconds:30}`. Supply only endpoints safe to probe. A probe
proves an endpoint responded, not that this command owns that endpoint.

`wait_for({jobs:[id],readiness:true,timeout:40})` waits for configured probes on all
listed command jobs; only `job_mode:"all"` is supported for readiness. A ready
server remains running and may later fail. Probe failure does not rewrite its
process exit status. Status exposes lifecycle, readiness, observed exit code,
termination reason, and cleanup evidence independently. Completion waits may mix
command IDs and existing subagent IDs. Unknown IDs and impossible success/failure
wait modes fail promptly. Aborting a wait never cancels its jobs.

## Ownership, limits, and sensitive evidence

- Owner-lifetime execution only. Normal Pi shutdown/reload cancels owned groups.
  Hard crashes cannot run cleanup; records become `lost` on missing owner or a
  30-second lease expiry. Execution is not resumed. Stale PIDs are never killed.
- `cancel` publishes a request; the owner processes it within its 500ms heartbeat.
  Request publication is not termination. Cancellation/timeout can carry
  `cleanup:"unconfirmed"`; process-group signaling does not prove every child
  exited. Escaped descendants are outside the cleanup guarantee. No claim of
  Windows Job Object containment is made.
- Store: `~/.pi/command-jobs`, overridden by `PI_COMMAND_STATE_DIR`. Files are private
  (0600), directories 0700. Maximum 8 active commands, 100 retained records, and
  2 MiB per stdout/stderr file (at most 400 MiB of retained logs). Old terminal
  records are evicted on reservation when the count cap is reached. Lost jobs are
  retained for inspection rather than deleting potentially live-process evidence.
- Output is drained after capture fills; metadata reports omitted bytes. Log write
  errors terminate the job and cannot count as successful evidence capture.
- `logs` returns up to 64 KiB, an opaque cursor bound to job/stream, `base64` of
  retained bytes, and a UTF-8 text view. Text can split a multibyte character at a
  cursor boundary; concatenate decoded base64 for exact retained bytes. stdout
  was decoded by the shared process runner, so this is not an arbitrary-binary
  transport. Logs are untrusted and may contain secrets; no automatic uploads.
- Another session in the same caller workspace can inspect/request cancellation;
  only the live owner signals the process tree. Same-user metadata is advisory,
  not authentication against another local process running as that user.

## Verification

`npm run test:command-jobs` covers real process outcomes, bounded logs, cursors,
readiness, cancellation, ownership, capacity, tool validation, and wait integration.
`npm run test:subagents` guards shared process and existing wait behavior.
