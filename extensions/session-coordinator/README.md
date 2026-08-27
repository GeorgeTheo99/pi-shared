# Session Coordinator

Machine-wide presence and asynchronous messaging for concurrent Pi sessions.

The extension lets independent Pi processes sharing the same machine-local coordinator directory discover one another across repositories and workspaces, see a short activity summary, and exchange notification-only messages. It does not wake peer agents, modify another session file, or prevent concurrent edits.

## Surfaces

### LLM tools

| Tool | Purpose |
|---|---|
| `peer_sessions` | List other live sessions across the machine by default, including workspace, activity, branch, worktree, and short status. Pass `scope: "project"` to limit the result to the current repository/workspace. |
| `peer_send` | Queue a concise asynchronous message for any discovered live peer, including peers in other workspaces. Accepts a runtime ID, unique ID prefix, or unique exact session name. |

`peer_send` optionally accepts `inReplyTo` for one correlated reply hop. A reply to a reply is rejected to prevent automatic message loops.

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

Rooms organize presence and inbox files; they are no longer discovery or messaging boundaries. Machine-wide listings scan every validated room under the shared coordinator directory. Project-scoped listings still use the current room. Separate Git worktrees remain the recommended protection against conflicting edits. Presence is advisory and does not lock files.

## Delivery model

Each extension runtime publishes a PID/UUID heartbeat in its workspace room and consumes its own file inbox under:

```text
~/.pi/session-coordinator/
├── rooms/<room-id>/
│   ├── presence/<runtime-id>.json
│   └── inbox/<runtime-id>/<timestamp>-<message-id>.json
└── receipts/session-<sha256(session-id)>/<message-id>.json
```

Files and directories use `0600`/`0700` permissions where supported. Presence expires after missed heartbeats and is removed on a clean session shutdown. After publishing its own presence, the coordinator starts a best-effort background scan that prunes crashed-session state older than 24 hours without delaying session startup.

Senders resolve targets from the machine-wide presence list and write each envelope to the target's `roomId`; recipients continue polling only their own room. The existing envelope schema already records that target room, so cross-workspace delivery requires no state migration.

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

The state directory intentionally lives outside `PI_CODING_AGENT_DIR` so normal and alternate Pi profiles on the same host can discover each other when both load `pi-shared`. "Machine-wide" means every live session sharing this directory; profiles that override the directory or do not load the coordinator are not visible.

## Trust model

This is local, same-user coordination—not an authentication boundary. Any process running as the same OS user and able to write the state directory can inspect workspace paths and statuses or impersonate a peer. Peer listings include an inline untrusted-metadata warning; peer presence, names, paths, status, and messages must still be treated as untrusted model-generated input. Do not send secrets or sensitive prompt content.
