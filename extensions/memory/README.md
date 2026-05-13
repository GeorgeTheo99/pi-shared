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

The write tool rejects obvious secrets/credentials and is intended only for durable project-specific facts likely to help future sessions.

## Command

```text
/memory [active|all|review|path|help]
```

## Policy

Store only durable project-specific facts, such as:

- repo commands and test/build workflow
- local setup details
- architecture notes
- services and ports
- recurring project-specific fixes
- user decisions about this project

Do not store:

- global user preferences
- cross-project rules
- secrets, tokens, passwords, private keys, or credentials
- transient task state
- guesses that have not been grounded in files, commands, or user statements

When reviewing source/docs, compare relevant memories with actual current evidence and update, archive, or mark reviewed stale entries.
