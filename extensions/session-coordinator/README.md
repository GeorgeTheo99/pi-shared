# Session Coordinator

Repository-scoped presence and asynchronous messaging for concurrent Pi sessions.

The extension lets independent Pi processes working in the same Git repository discover one another, see a short activity summary, and exchange notification-only messages. It does not wake peer agents, modify another session file, or prevent concurrent edits.

## Surfaces

### LLM tools

| Tool | Purpose |
|---|---|
| `peer_sessions` | List other live sessions in the current repository/workspace, including activity, branch, worktree, and short status. |
| `peer_send` | Queue a concise asynchronous message for a live peer. Accepts a runtime ID, unique ID prefix, or unique exact session name. |

`peer_send` optionally accepts `inReplyTo` for one correlated reply hop. A reply to a reply is rejected to prevent automatic message loops.

### Commands

| Command | Purpose |
|---|---|
| `/peers` | Show the same live-peer listing in the transcript. |
| `/peer-status <text>` | Override the short status published to peers. |
| `/peer-status clear` | Return to the automatically derived status. |

Without an explicit status, the coordinator publishes the active work-plan item when one exists, otherwise `Working` or `Idle`.

## Repository identity

Git sessions are grouped by a SHA-256-derived ID of the realpath-canonicalized output from:

```bash
git rev-parse --path-format=absolute --git-common-dir
```

Linked worktrees therefore share a room while retaining their distinct worktree paths in presence records. Separate clones are separate rooms. Submodules use their own Git common directory. A non-Git session falls back to a room based on its canonical current working directory.

Separate Git worktrees remain the recommended protection against conflicting edits. Presence is advisory and does not lock files.

## Delivery model

Each extension runtime publishes a PID/UUID heartbeat and consumes its own file inbox under:

```text
~/.pi/session-coordinator/
├── rooms/<room-id>/
│   ├── presence/<runtime-id>.json
│   └── inbox/<runtime-id>/<timestamp>-<message-id>.json
└── receipts/session-<sha256(session-id)>/<message-id>.json
```

Files and directories use `0600`/`0700` permissions where supported. Presence expires after missed heartbeats and is removed on a clean session shutdown. Old crashed-session state is pruned after 24 hours.

Inbound envelopes are first persisted as coordinator receipt files keyed by Pi session ID, then removed from the runtime inbox. Receipts do not depend on Pi having created its JSONL session file, so messages remain durable across `/reload`, session switching, shutdown, or process restart before delivery. When the recipient is idle, the extension inserts the message with:

```ts
{ triggerTurn: false }
```

The resulting custom message appears as clearly marked untrusted context and never starts or interrupts an agent turn. The receipt is removed only after the matching custom-message entry is observable and Pi's JSONL session file exists; otherwise it remains available for retry. While the recipient is busy, the durable receipt waits until `agent_settled` or the next idle inbox pass. Messages and receipts expire after 24 hours, messages are limited to 8 KiB, inboxes are transactionally capped at 100 messages, and a runtime may send at most five messages per minute.

## Configuration

Environment variables are optional:

| Variable | Default | Purpose |
|---|---:|---|
| `PI_SESSION_COORDINATOR_DIR` | `~/.pi/session-coordinator` | Shared coordinator state directory. |
| `PI_SESSION_COORDINATOR_HEARTBEAT_MS` | `5000` | Presence heartbeat interval. |
| `PI_SESSION_COORDINATOR_POLL_MS` | `1000` | Inbox polling interval. |
| `PI_SESSION_COORDINATOR_LEASE_MS` | `20000` | Presence lease; always at least three heartbeat intervals. |

The state directory intentionally lives outside `PI_CODING_AGENT_DIR` so normal and alternate Pi profiles on the same host can discover each other when both load `pi-shared`.

## Trust model

This is local, same-user coordination—not an authentication boundary. Any process running as the same OS user and able to write the state directory can impersonate a peer. Peer status and messages must be treated as untrusted model-generated input. Do not send secrets or sensitive prompt content.
