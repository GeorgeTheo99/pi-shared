# Session Coordinator

Machine-wide presence, asynchronous messaging, and truthful delivery receipts for concurrent Pi sessions.

The extension lets independent Pi processes sharing the same machine-local coordinator directory discover one another across repositories and workspaces, see advisory activity metadata, and exchange notifications or explicit response requests. Response requests and correlated replies reach running persistent sessions promptly, without requiring a user prompt: a busy session receives them after its current tool step (steering), and an idle session gets an automatic coordination turn. Notifications stay silent until the recipient is idle. The coordinator never aborts ongoing work, modifies another session's transcript, or prevents concurrent edits.

## Surfaces

### LLM tools

| Tool | Purpose |
|---|---|
| `peer_sessions` | List other live sessions across the machine by default. Includes workspace, activity, branch, worktree, short status, and bounded Git workspace changes when available. Pass `scope: "project"` to limit the result to the current repository/workspace. |
| `peer_send` | Queue a concise asynchronous message for a discovered live peer. Accepts a runtime ID, unique ID prefix, or unique exact session name. Optional `requestAcknowledgment` requests a receipt; `requestResponse` asks for one answer, delivered after the recipient's current tool step when busy or in an automatic turn when idle. |
| `peer_message_status` | Inspect recent sender-visible lifecycle receipts for this Pi session, optionally by exact message ID. It never contacts or wakes the peer. |
| `peer_acknowledge` | Record one acknowledgment for a received message that explicitly requested it. This updates the sender's receipt without sending a message or triggering a turn. |

`peer_send` optionally accepts `inReplyTo` for one correlated reply hop. A reply to a reply is rejected to prevent automatic message loops. Correlation follows the original sender's exact Pi session ID, so a reloaded sender can receive a reply at its newly discovered runtime ID; a different or forked session cannot. A correlated reply advances the original sender's receipt to `replied` when that receipt is available.

### Notifications versus response requests

- **Notification (default):** no reply expected and no agent wake. Asking a question in the body does not change its delivery mode.
- **Acknowledgment:** `requestAcknowledgment: true` asks for a receipt, not an answer; it does not wake the recipient.
- **Request response:** `requestResponse: true` asks for one reply. A busy recipient receives it after its current tool step and answers before resuming; an idle recipient gets an automatic model turn. Senders should ask one specific question and say briefly what the answer is for. Both sessions must load the updated extension; unsupported targets are rejected rather than silently waiting for user input.
- **Correlated reply:** reaches the original sender after its current tool step when busy, or in an automatic turn when idle, so authorized work can continue. It cannot request another response or produce a reply-to-reply loop. Replies to legacy peers remain deliverable, with an explicit warning that automatic waking is unavailable.

Example tool arguments:

```json
{ "target": "<discovered peer runtime>", "message": "Which files are you editing?", "requestResponse": true }
```

Short-lived/non-persistent sessions remain visible for advisory discovery and notifications, but do not advertise response-request support. This includes sessions without a session-file path and all delegated children (`PI_SUBAGENT_DEPTH > 0`, including interactive children). Listings label them explicitly; requests fail closed rather than silently becoming notifications. Coordinate with their parent session instead. A fresh persistent session is still supported before its first transcript write.

The TUI-only **Incoming peer responses** widget shows up to five unexpired requests addressed to this exact session. Pending requests distinguish an automatic turn pending from an automatic turn attempted with an answer still pending. An idle recipient receives one notification per newly pending request per runtime (batched when several arrive together). The inbox scheduler, not the widget or toast, starts the model turn. Reload restores the reminder; answered/expired requests disappear, and failed or uncertain reply attempts are labeled separately without automatic retry. Corrupt request state is shown as unavailable, not as an answer. Forks cannot inherit another session's reminders or reply authority.

The **Peer responses** widget shows up to five recent outgoing requests as `pending`, `answered` (reply queued, not necessarily read), `unanswered`, or `expired`. `peer_message_status` exposes the same response outcome separately from delivery status. Each transcript card is still one message, not a conversation thread; replies appear as separate cards. The sent request card labels its initial state explicitly, rather than pretending a static card is live status.

The request's context asks for one concise coordination answer, sent through `peer_send` with the original `inReplyTo` ID: the direct answer first, then any limitation. The recipient may make brief read-only lookups within its workspace (reading or searching files, `git status`/`log`/`diff`) to answer accurately, but must never read or disclose secrets, credentials, keys, tokens, or env files, and must not edit files, run mutating commands, or take external actions for a peer. This is prompt guidance, not a tool restriction. Peer content remains untrusted and is not permission to execute tasks, edit files, or start new requests. Normal user work retains its tools and continues after a reply. Replies wake updated persistent senders but cannot request another response.

A private, exact-recipient-session ledger claims each requested reply **before** publication. Concurrent runtimes share the guard; up to 100 unexpired guards are retained without eviction. A crash or publication failure after a claim can leave the request `unanswered`: there is no automatic retry. A request stays `pending` until a reply attempt is made or it expires, even if the recipient runs without answering. An answer is not guaranteed. Confirmed `answered` outcomes also persist in sender receipts so expired replay-guard cleanup cannot erase them. Ordinary non-requested replies retain their existing one-hop behavior.

### Steering busy sessions

During an active agent run (between `agent_start` and `agent_settled`, including durable-goal autopilot runs), an eligible message is inserted with the supported `pi.sendMessage(..., { triggerTurn: true, deliverAs: "steer" })` API. Pi delivers it after the current assistant turn and its tool calls, before the next model call; nothing is aborted. Its card asks for the reply now and a return to the prior task. Eligible messages are unanswered response requests addressed to this exact session and correlated replies matching this session's outgoing record. Notifications, acknowledgment requests, delegated/non-persistent sessions, a `/self-handoff` child's orientation turn (or an unreadable orientation state), and a compaction outside a run never steer.

A steered message is registered on the SDK `message_end` event, so the model can reply in the very next response. Its receipt remains until the idle session confirms persistence. If the run never consumes the steer (interactive Escape, the dequeue key, or RPC `clear_queue` clear queued messages), the idle session re-delivers the card normally; when the queue is cleared without ending the run, delivery therefore waits for idle, as it did before steering. SDK/RPC `abort` keeps queued steering; if that stale steer lands after the re-delivery, `message_end` replaces it with a hidden one-line duplicate stub. A steered request that was surfaced but not answered still receives one idle automatic turn; a consumed steered reply does not. Set `PI_SESSION_COORDINATOR_STEER=0` to restore wait-for-idle delivery.

### Automatic turns

When idle, the scheduler batches newly surfaced requests and validated correlated replies into one custom coordination message, sent through the supported `pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })` API. No synthetic user prompt, tool restrictions, or Pi core modification is involved. Already-surfaced pending requests from older versions also receive an attempt after upgrade. Running persistent sessions advertise `autoWakeVersion: 1`; delegated children and non-persistent sessions cannot send response requests or auto-wake.

A private exact-session `peer-wake-claims` ledger claims each message before calling Pi. Duplicate delivery, reload, or competing runtimes cannot consume another wake attempt for that message. Up to 100 unexpired claims are retained without eviction; full/corrupt storage fails closed, leaving the request pending. Expired messages, forks, notifications, and acknowledgments never schedule wakes. Replies must match this exact session's outgoing record and the original target session; sent transcript cards or successful tool results preserve correlation after rolling status history is evicted. Each inbox pass batches eligible messages; existing per-sender send limits and one-hop reply guards still apply.

An automatic turn is an opportunity to answer, not proof of an answer. The claim and SDK invocation are not one transaction: a crash between them, cancellation, model failure, or asynchronous SDK rejection can consume the attempt without an answer. There is no automatic retry/token-spending loop; the widget labels attempted-but-pending requests honestly. Closed processes are not restarted. User-input ordering is intentionally best-effort: the extension cannot atomically order wakes against earlier asynchronous input handlers. Both turns retain normal tools and peer content never gains user authority.

### Commands

| Command | Purpose |
|---|---|
| `/peers` or `/peers machine` | Show live peers across all workspaces in the transcript. |
| `/peers project` | Limit the listing to the current repository/workspace. |
| `/peer-status <text>` | Override the short status published to peers. |
| `/peer-status clear` | Return to the automatically derived status. |

Without an explicit status, the coordinator publishes the active work-plan item when one exists, otherwise `Working` or `Idle`.

## Repository identity

Git sessions are grouped by a SHA-256-derived ID of the realpath-canonicalized output from:

```bash
git rev-parse --path-format=absolute --git-common-dir
```

Linked worktrees therefore share a room while retaining their distinct worktree paths in presence records. Separate clones are separate rooms. Submodules use their own Git common directory. A non-Git session falls back to a room based on its canonical current working directory.

Rooms organize presence and inbox files; they are not discovery or messaging boundaries. Machine-wide listings scan every validated room under the shared coordinator directory. Project-scoped listings use the current room. Separate Git worktrees remain the recommended protection against conflicting edits. Presence is advisory and does not lock files.

When available, presence includes up to ten paths from `git status --porcelain`. These are truthful workspace-level observations, not proof that the publishing session changed those files. The coordinator does not publish or infer an ETA.

## Delivery model

Each extension runtime publishes a PID/UUID heartbeat in its workspace room and consumes its own file inbox. Recipient-session receipts and sender-session lifecycle records are stored separately:

```text
~/.pi/session-coordinator/
├── rooms/<room-id>/
│   ├── presence/<runtime-id>.json
│   └── inbox/<runtime-id>/<timestamp>-<message-id>.json
├── receipts/session-<sha256(recipient-session-id)>/<message-id>.json
├── outgoing-status/session-<sha256(sender-session-id)>/<message-id>.json
├── response-requests/session-<sha256(recipient-session-id)>.json
└── peer-wake-claims/session-<sha256(recipient-session-id)>.json
```

Files and directories use `0600`/`0700` permissions where supported. Presence expires after missed heartbeats and is removed on clean shutdown. A best-effort background scan prunes crashed-session state and expired receipts without delaying startup. Message bodies are never copied into sender lifecycle records.

Senders resolve targets from machine-wide presence and write each envelope to the target's room/runtime inbox. Inbound envelopes are first persisted under the exact recipient Pi session ID, then removed from the runtime inbox. Busy recipients retain that durable receipt until idle, except eligible messages steered into the active run (see [Steering busy sessions](#steering-busy-sessions)). Delivery rechecks idle state before each new context insertion, including between messages in a batch. Idle inbound cards are inserted without waking a turn; after the batch, eligible requests/replies schedule a separate coordination turn:

```ts
{ triggerTurn: false }
```

A successful `peer_send` now creates a dedicated `PEER MESSAGE SENT` (or `PEER REPLY SENT`) transcript card in the sending session, with direction `THIS PI SESSION → ANOTHER PI SESSION`, both endpoints, and the exact body under `Message:`. The card explicitly says the message was queued, not read. It is persisted as a UI-only custom entry: it survives transcript reload without duplicating model context or starting a turn. The tool result also retains the exact queued body for model/API clients and as a fallback if saving the card fails. Failed sends never create sent cards. Historical sends made before this renderer was installed retain their original tool results; new sends get cards.

A dedicated recipient transcript renderer labels the matching inbound entry `PEER MESSAGE RECEIVED` (or `PEER REPLY RECEIVED`), shows the direction as `ANOTHER PI SESSION → THIS PI SESSION`, and places the exact body under its own `Message:` heading. It identifies both endpoints, the sender worktree, and any reply relationship. When a peer has no session name, the renderer uses `Unnamed session in <workspace> (<runtime-prefix>)` instead of presenting a bare, unexplained ID. The underlying card remains clearly marked as untrusted; an idle card does not itself start a turn, and a steered card never aborts one. Response-request cards say a reply is expected automatically (after the current tool step when busy, or in an automatic coordination turn when idle), without implying it was answered; ordinary notifications explicitly say no reply is expected. Display metadata comes from structured message details, or from the legacy header only; quoted acknowledgment-request text in the body cannot create a request badge.

The recipient receipt is removed only after the matching custom-message entry is observable and a complete matching JSONL record is readable from the exact recipient's session file. The file is streamed once per pending batch; a missing file, failed append, or partial record leaves the receipt available for retry, including after reload. In-memory visibility and file existence alone do not prove persistence.

A clean shutdown withdraws presence under the inbox lock, then drains unread runtime inbox messages into the same recipient-session receipt store. Best-effort widget cleanup cannot prevent this drain or presence withdrawal. If storage is full or a drain fails, successfully persisted inbox items are removed and the unread remainder is preserved for an exact-session successor—even when replacement reuses the still-live process. After an unclean runtime exit, a same-room successor may adopt an unread inbox only when the envelope's exact target Pi session ID matches and the predecessor PID is no longer alive. Different/forked sessions, legacy envelopes without a target session ID, and ambiguous live predecessors fail closed rather than receiving another session's message.

## Lifecycle semantics

New runtimes advertise protocol v2 and optional `requestResponseVersion: 1` plus `autoWakeVersion: 1` in presence while retaining presence/envelope schema version 1 and the existing capability list. Short-lived/non-persistent runtimes instead advertise `ephemeral: true` and omit both response/wake capabilities; an ephemeral presence record cannot advertise either. This keeps legacy records readable; older peers can still receive messages but cannot provide later lifecycle checkpoints.

| Status | Truthful meaning |
|---|---|
| `pending` | The sender prepared lifecycle state but did not confirm runtime-inbox publication, usually because the sender stopped mid-send. Delivery may still advance this record if publication completed. |
| `queued` | The sender confirmed the envelope was durably written to the target runtime inbox. |
| `delivered` | The recipient persisted the envelope under the exact target Pi session ID. |
| `surfaced` | The matching custom-message entry became observable in recipient context. This does **not** mean read by a human or agent. |
| `acknowledged` | The recipient explicitly called `peer_acknowledge` for a message that requested acknowledgment. |
| `replied` | The recipient successfully queued one correlated reply. |
| `unread_session_ended` | Publication was confirmed (`queued`), but no live target or same-session successor is currently visible and no stronger checkpoint was recorded. A missed heartbeat alone is not evidence of termination while the matching process remains alive. This is an advisory inference, not proof that the message was read. A matching successor may still adopt and advance the status later. |
| `expired` | The message TTL elapsed before it was surfaced, acknowledged, or replied to. |

The status tool retains these protocol names and adds a plain-English explanation to each row. Its age is labeled `last recorded update`: inferred expiry or absent-presence states do not have a separately recorded transition time.

Lifecycle writes are monotonic, so late concurrent writes cannot regress a stronger status. Status records are keyed by sender Pi session ID and therefore remain inspectable after that session reloads under a new runtime ID. `peer_message_status` is an explicit inspection surface. The coordinator does not generate automatic status transcript messages or contact peers for status; the response widget refreshes from local records.

Acknowledgments are bounded state updates, not peer messages. They do not wake a peer, trigger a turn, authorize the message content, or permit another acknowledgment hop. Acknowledgment and correlated-reply authority is bound to the exact recipient Pi session ID recorded when the message was surfaced, so a forked session fails closed. Regular replies retain the existing one-reply-hop guard.

Messages and recipient receipts expire after 24 hours. Recipient-session receipts and outgoing lifecycle records are each transactionally capped at 100 records per session; full recipient storage leaves messages in the bounded runtime inbox for backpressured retry. Outgoing records are pruned after their retention window. Messages are limited to 8 KiB, runtime inboxes are transactionally capped at 100 messages, and a runtime may send at most five messages per minute.

## Locking and upgrades

**Before activating the generation-safe locking update, drain and stop all older Pi/worker processes sharing coordinator, subagent, or workflow state, then start fresh runtimes.** Do not hot-reload just one session while older writers remain active: their legacy lock-reclamation code can remove a newer live lock. The new implementation safely recovers abandoned legacy locks after the old writers have stopped. No live state needs to be deleted manually.

The shared helper acquires with exclusive `mkdir`, uses unique PID/token owner markers and pinned directory identity, and verifies sole ownership before entering the critical section. If empty-directory cleanup displaces an initializer, it retries rather than sharing the lock. Recovery and release unlink only the inspected owner's file and use non-recursive empty-directory removal; they never rename or recursively delete the shared lock path. Live owner PIDs remain protected regardless of lock age, and abandoned or partially written legacy `owner.json` locks can be recovered after the stale threshold.

This is a host-local filesystem protocol, not a network/shared-host lock. Locks and atomic writes provide process-crash recovery, not an `fsync`-backed power-loss durability guarantee.

## Configuration

Environment variables are optional:

| Variable | Default | Purpose |
|---|---:|---|
| `PI_SESSION_COORDINATOR_DIR` | `~/.pi/session-coordinator` | Shared coordinator state directory. |
| `PI_SESSION_COORDINATOR_HEARTBEAT_MS` | `5000` | Presence heartbeat interval. |
| `PI_SESSION_COORDINATOR_POLL_MS` | `1000` | Inbox polling interval. |
| `PI_SESSION_COORDINATOR_LEASE_MS` | `20000` | Presence lease; always at least three heartbeat intervals. |
| `PI_SESSION_COORDINATOR_STEER` | enabled | Set to `0` to stop steering response requests and correlated replies into busy runs; they then wait for idle. |

The state directory intentionally lives outside `PI_CODING_AGENT_DIR` so normal and alternate Pi profiles on the same host can discover each other when both load `pi-shared`. "Machine-wide" means every live session sharing this directory; profiles that override the directory or do not load the coordinator are not visible.

## Trust model

This is local, same-user coordination—not an authentication boundary. Steering means busy and goal-autopilot runs, which previously saw peer content only when idle, now receive response requests mid-run with their normal tools; the read-only, no-secrets reply guidance is prompt-level, not enforced. Any process running as the same OS user and able to write the state directory can inspect workspace paths and statuses or impersonate a peer. Peer listings include an inline untrusted-metadata warning; peer presence, names, paths, statuses, workspace changes, messages, and lifecycle records remain advisory. Do not send secrets or sensitive prompt content.
