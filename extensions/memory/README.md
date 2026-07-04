# Project Memory

Machine-local, project-only memory for Pi.

## Storage

Canonical storage is JSON under the native Pi folder:

```text
~/.pi/memory/projects/<project-name>-<project-id>.json
```

Project identity is derived from the git repo root plus `remote.origin.url` when available, falling back to the canonical current working directory for non-git folders.

No global memory is implemented. Do not store user-wide preferences here.

## Tools

- `memory_read` — read active, all, or review-due memories for the current project.
- `memory_write` — add, update, archive, or mark reviewed a memory for the current project.

The write tool rejects obvious secrets/credentials and is intended only for evidence-backed, durable project-specific facts likely to help future sessions. Memory hygiene should happen during normal session work, while files, commands, runtime state, and user decisions are fresh.

## Command

```text
/memory [active|all|review|path|help]
```

## Policy

Treat memory maintenance as part of normal session work:

- read relevant memories before relying on prior project state
- write or update memory immediately when a verified durable project fact is discovered or corrected
- before finishing substantive work, audit whether touched memories should be updated, archived, or marked reviewed
- prefer updating, archiving, or marking reviewed existing memories over adding duplicates

Store only durable project-specific facts, such as:

- canonical repo commands and test/build workflow
- local setup details
- architecture decisions and repo relationships
- services, labels, paths, ports, and deployment state
- recurring project-specific fixes or gotchas
- explicit user decisions about this project

Every add/update should include concrete evidence in `source` when possible, such as file paths, command results, commit hashes, service status, tests, or explicit user statements.

Do not store:

- global user preferences
- cross-project rules
- secrets, tokens, passwords, private keys, credentials, or sensitive personal data
- transient task state, todos, or one-off progress
- guesses that have not been grounded in files, commands, runtime checks, or user statements
- raw logs or bulky data dumps

When reviewing source/docs, compare relevant memories with actual current evidence and update, archive, or mark reviewed stale entries.
