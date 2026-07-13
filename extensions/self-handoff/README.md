# Self Handoff

A user-invoked extension command for moving the current task into a fresh session **inside the same running Pi process**. It targets the unmodified Earendil Pi `0.80.6` extension API and requires interactive TUI mode plus an existing persisted session file (complete at least one turn first; `--no-session` is unsupported).

## Usage

```text
/self-handoff
/self-handoff focus the continuation on the failing integration test
```

The optional text is a focus for the generated continuation, not a command to execute directly.

## Behavior

1. `/self-handoff` opens a temporary gate so an active `/goal` does not start another continuation turn.
2. The command waits for the current agent run to settle.
3. The selected model generates a concise, self-contained continuation prompt from a best-effort-redacted transcript, optional focus, active goal, and work plan. Hidden reasoning, raw tool arguments, and shell output marked `excludeFromContext` are excluded. Heuristic redaction cannot guarantee removal of every secret, so do not hand off a transcript known to contain sensitive values.
4. Pi opens the generated continuation in an editor. Review/edit it, then submit the editor to proceed or cancel it to keep the parent session.
5. Pi verifies that the parent did not change during generation/review, then creates a fresh session through the stock `ctx.newSession({ setup, withSession })` API.
6. `setup` validates and copies the latest active `pi-goal-state` and latest non-empty `pi-work-plan-state` into the child. The work plan is a copied checklist; its parent copy remains historical session state rather than an exclusive owner.
7. Child setup first binds the exact parent/child session IDs and paths in the parent audit record under an exclusive goal-ownership lock. It also persists the full redacted kickoff plus its SHA-256 identity for exact crash/retry recovery. Only after that ownership write succeeds does `withSession` submit the orientation kickoff automatically.
8. The child's first turn may only show a concise handoff summary and numbered proposed next steps. Tool calls, goal/work-plan mutations, and work-plan timing are held; active-goal autopilot is suppressed; and the orientation does not consume a goal turn.
9. Once a successful, correctly formatted orientation run is fully settled, the child records durable `awaiting_user` state and the parent goal is marked terminal `transferred`. The child keeps the same goal identity, progress log, and remaining turn budget, then waits idle.
10. The user's next explicit message—`Proceed` or adjustments—verifies parent and child durable state and becomes a one-shot release candidate. The child audit changes to `transferred` only in `before_agent_start`, after that exact message has passed input middleware and been admitted. Work and goal turn accounting begin with that message.

This is deliberately a **user-invoked command**, not an LLM tool. Stock Pi does not expose session replacement to tool or event contexts, and extension-injected slash text is treated as model input rather than command dispatch.

## Cancellation and recovery

- Cancelling prompt generation or a `session_before_switch` guard leaves the parent active and releases any held goal continuation.
- If automatic child kickoff fails after ownership is secured, a manual retry authorization is persisted and the exact orientation kickoff is placed in the new session's editor.
- Initial kickoff admission requires the extension source and exact persisted hash. Interactive/RPC submission is accepted only after a persisted retry authorization.
- If orientation is aborted, empty, provider-failed, or missing its required summary/numbered-next-steps format, the parent remains recoverable and the exact kickoff is restored for retry.
- User input submitted while orientation is streaming is not queued behind it; text is restored to the editor so it can become a genuinely post-orientation message.
- If child lineage, audit identity, or transferred-goal identity validation fails, automatic goal follow-up is cancelled and the exact child goal is forced to `paused` before failure audit persistence is attempted.
- If parent finalization fails after durable `awaiting_user` state is written, work remains gated and the next explicit user reply retries finalization before it can run.
- A parent goal remains `transferring` until ownership finalization succeeds. If replacement was interrupted and the child is unusable, reopen the exact original parent and run `/goal reclaim`; forked/imported copies cannot reclaim it.
- A child with an unresolved `received`/`awaiting_user`/`failed` handoff cannot start another handoff, reactivate/replace its transferred goal, or start a new durable goal. Selecting a historical `/tree` branch does not bypass this session-wide check.
- Child audit state is checked during setup, again after extension rebinding, at orientation settlement, and before the first explicit post-orientation message. Per-request reduction validates immutable request/child identity and monotonic state transitions; malformed or competing records fail closed without releasing work.
- The post-orientation release also requires the active branch to contain the exact successful kickoff/summary exchange. Navigating `/tree` to a branch before that exchange keeps work gated and directs the user back to the settled orientation branch.
- Parent reclaim and child finalization share an exclusive sidecar lock, reduce the complete persisted audit, and anchor writes/goal validation to the handoff transition's source branch. Historical child `received`/`awaiting_user` branches cannot regress a completed transfer, and unrelated newer parent branches cannot redirect finalization.
- A parent goal marked `transferred` cannot be resumed there; continue in its child session instead.

## Stock Pi limits

This implementation uses only public Earendil Pi `0.80.6` extension APIs and is portable as a normal Pi package for that distribution. It is not a compatibility claim for older upstream `@mariozechner` releases. The summarization call follows Pi's documented handoff example and uses the selected model directly; custom session request hooks/transports should be checked before rollout.

Stock session replacement is not transactional:

- child setup entries are not atomically committed with parent state and kickoff;
- a crash after parent teardown can leave a partial or orphan child;
- child custom state is not guaranteed durable on disk until the child writes its orientation response;
- failure after stock Pi has invalidated the parent cannot be rolled back through extension APIs;
- `--no-session` and fresh not-yet-created session files are rejected because exact recoverable ownership requires readable persisted parent and child files;
- a process crash while holding the short-lived `<session>.self-handoff.lock` sidecar can leave a stale lock; remove it only after confirming no Pi process is still updating that handoff.
