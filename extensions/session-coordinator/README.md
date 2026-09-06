# Session Coordinator

Machine-wide presence, asynchronous messaging, and truthful delivery receipts for concurrent Pi sessions.

The extension lets independent Pi processes sharing the same machine-local coordinator directory discover one another across repositories and workspaces, see advisory activity metadata, and exchange notification-only messages. It does not wake peer agents, modify another session file, or prevent concurrent edits.

## Surfaces

### LLM tools

| Tool | Purpose |
|---|---|
| `peer_sessions` | List other live sessions across the machine by default. Includes workspace, activity, branch, worktree, short status, and bounded Git workspace changes when available. Pass `scope: "project"` to limit the result to the current repository/workspace. |
| `peer_send` | Queue a concise asynchronous message for a discovered live peer. Accepts a runtime ID, unique ID prefix, or unique exact session name, and can optionally request one acknowledgment. |
| `peer_message_status` | Inspect recent sender-visible lifecycle receipts for this Pi session, optionally by exact message ID. It never contacts or wakes the peer. |
| `peer_acknowledge` | Record one acknowledgment for a received message that explicitly requested it. This updates the sender's receipt without sending a message or triggering a turn. |

`peer_send` optionally accepts `inReplyTo` for one correlated reply hop. A reply to a reply is rejected to prevent automatic message loops. Correlation follows the original sender's exact Pi session ID, so a reloaded sender can receive a reply at its newly discovered runtime ID; a different or forked session cannot. A correlated reply advances the original sender's receipt to `replied` when that receipt is available.

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
└── outgoing-status/session-<sha256(sender-session-id)>/<message-id>.json
```

Files and directories use `0600`/`0700` permissions where supported. Presence expires after missed heartbeats and is removed on clean shutdown. A best-effort background scan prunes crashed-session state and expired receipts without delaying startup. Message bodies are never copied into sender lifecycle records.

Senders resolve targets from machine-wide presence and write each envelope to the target's room/runtime inbox. Inbound envelopes are first persisted under the exact recipient Pi session ID, then removed from the runtime inbox. Busy recipients retain that durable receipt until idle. Idle recipients receive a custom message with:

```ts
{ triggerTurn: false }
```

The `peer_send` result shows the exact queued message under a `Message:` heading in the sending session. A dedicated recipient transcript renderer labels the matching inbound entry `PEER MESSAGE RECEIVED` (or `PEER REPLY RECEIVED`), shows the direction as `ANOTHER PI SESSION → THIS PI SESSION`, and places the exact body under its own `Message:` heading. It identifies both endpoints, the sender worktree, and any reply relationship. When a peer has no session name, the renderer uses `Unnamed session in <workspace> (<runtime-prefix>)` instead of presenting a bare, unexplained ID. The underlying context remains clearly marked as untrusted and never starts or interrupts an agent turn.

The recipient receipt is removed only after the matching custom-message entry is observable and a complete matching JSONL record is readable from the exact recipient's session file. The file is streamed once per pending batch; a missing file, failed append, or partial record leaves the receipt available for retry, including after reload. In-memory visibility and file existence alone do not prove persistence.

A clean shutdown drains unread runtime inbox messages into the same recipient-session receipt store. After an unclean runtime exit, a same-room successor may adopt an unread inbox only when the envelope's exact target Pi session ID matches and the predecessor PID is no longer alive. Different/forked sessions, legacy envelopes without a target session ID, and ambiguous live predecessors fail closed rather than receiving another session's message.

## Lifecycle semantics

New runtimes advertise protocol v2 in an optional presence field while retaining presence/envelope schema version 1. This keeps legacy records readable; older peers can still receive messages but cannot provide later lifecycle checkpoints.

| Status | Truthful meaning |
|---|---|
| `pending` | The sender prepared lifecycle state but did not confirm runtime-inbox publication, usually because the sender stopped mid-send. Delivery may still advance this record if publication completed. |
| `queued` | The sender confirmed the envelope was durably written to the target runtime inbox. |
| `delivered` | The recipient persisted the envelope under the exact target Pi session ID. |
| `surfaced` | The matching custom-message entry became observable in recipient context. This does **not** mean read by a human or agent. |
| `acknowledged` | The recipient explicitly called `peer_acknowledge` for a message that requested acknowledgment. |
| `replied` | The recipient successfully queued one correlated reply. |
| `unread_session_ended` | The targeted runtime ended before any stronger checkpoint was recorded and no live same-session successor is visible. A missed heartbeat alone is not evidence of termination while the matching process remains alive. A matching successor may still adopt and advance the status later. |
| `expired` | The message TTL elapsed before it was surfaced, acknowledged, or replied to. |

Lifecycle writes are monotonic, so late concurrent writes cannot regress a stronger status. Status records are keyed by sender Pi session ID and therefore remain inspectable after that session reloads under a new runtime ID. `peer_message_status` is an explicit inspection surface; the coordinator does not generate noisy automatic status messages or poll peers.

Acknowledgments are bounded state updates, not peer messages. They do not wake a peer, trigger a turn, authorize the message content, or permit another acknowledgment hop. Acknowledgment and correlated-reply authority is bound to the exact recipient Pi session ID recorded when the message was surfaced, so a forked session fails closed. Regular replies retain the existing one-reply-hop guard.

Messages and recipient receipts expire after 24 hours. Recipient-session receipts and outgoing lifecycle records are each transactionally capped at 100 records per session; full recipient storage leaves messages in the bounded runtime inbox for backpressured retry. Outgoing records are pruned after their retention window. Messages are limited to 8 KiB, runtime inboxes are transactionally capped at 100 messages, and a runtime may send at most five messages per minute.

## Locking upgrade

Before activating the generation-safe locking update, drain and stop all older Pi/worker processes sharing coordinator, subagent, or workflow state, then start fresh runtimes. Do not hot-reload just one session while older writers remain active: their legacy lock-reclamation code can remove a newer live lock. The new implementation safely recovers abandoned legacy locks after the old writers have stopped. No live state needs to be deleted manually.

Locks use unique PID/token owner markers, pinned directory identity, and atomic empty-directory removal. Concurrent stale reclaimers cannot remove a replacement owner's live marker. This is a host-local filesystem protocol; it is not intended for network/shared-host filesystems.

## Configuration

Environment variables are optional:

| Variable | Default | Purpose |
|---|---:|---|
| `PI_SESSION_COORDINATOR_DIR` | `~/.pi/session-coordinator` | Shared coordinator state directory. |
| `PI_SESSION_COORDINATOR_HEARTBEAT_MS` | `5000` | Presence heartbeat interval. |
| `PI_SESSION_COORDINATOR_POLL_MS` | `1000` | Inbox polling interval. |
| `PI_SESSION_COORDINATOR_LEASE_MS` | `20000` | Presence lease; always at least three heartbeat intervals. |

The state directory intentionally lives outside `PI_CODING_AGENT_DIR` so normal and alternate Pi profiles on the same host can discover each other when both load `pi-shared`. "Machine-wide" means every live session sharing this directory; profiles that override the directory or do not load the coordinator are not visible.

## Trust model

This is local, same-user coordination—not an authentication boundary. Any process running as the same OS user and able to write the state directory can inspect workspace paths and statuses or impersonate a peer. Peer listings include an inline untrusted-metadata warning; peer presence, names, paths, statuses, workspace changes, messages, and lifecycle records remain advisory. Do not send secrets or sensitive prompt content.
