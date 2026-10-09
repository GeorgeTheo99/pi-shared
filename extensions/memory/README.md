# Project Memory

Machine-local, project-only memory for Pi.

## Storage

Canonical storage is JSON under the native Pi folder:

```text
~/.pi/memory/projects/<project-name>-<project-id>.json
```

Project identity is derived from the git repo root plus `remote.origin.url` when available, falling back to the canonical current working directory for non-git folders.

No global memory is implemented. Do not store user-wide preferences here.

Data safety:

- Writes hold an interprocess lock (`<file>.lock`), so concurrent Pi sessions in the same project cannot overwrite each other's changes.
- Files are replaced atomically with mode `0600`; the previous version is kept as `<file>.bak`.
- A file that is not valid JSON, is not a version-1 store, or has a non-array `memories` field is never read or overwritten: memory tools fail with the path and reason, and the prompt reports memory as unavailable. Repair or move the file aside.
- Entries that fail validation are ignored but written back unchanged.
- Nothing is deleted: `archive` only hides a memory from the prompt and active reads.

## Tools

- `memory_read` — read active, all, or review-due memories for the current project.
- `memory_write` — add, update, archive, or mark reviewed a memory for the current project.

`mark_reviewed` stores its `reason` as `reviewReason`; it does not replace `source`.

`text`, `source`, and `reason` are whitespace-normalized and limited to 2,000 characters each; longer values are rejected, never truncated, so the agent must shorten or split the memory.

The write tool rejects obvious secrets/credentials and is intended only for evidence-backed, durable project-specific facts likely to help future sessions. Memory hygiene should happen during normal session work, while files, commands, runtime state, and user decisions are fresh.

## Structured reads

`memory_read` declares a versioned output schema. Pi 0.99.1 codemode receives
`{version:1,status:"ok",data:{project:{id,name},mode,memories:[...]}}` directly.
Unlike the legacy renderer details, `memories` contains only the requested
active/all/review selection. Entries expose memory text, tags, status, source,
confidence and maintenance timestamps, not extra stored fields; project remote,
root and storage paths are omitted. Memory text remains untrusted evidence.
Text/details and invocation parameters are unchanged. The additional output
fields are ignorable on older Pi; they do not add codemode to Pi 0.87.

## Prompt injection

Each turn appends a section of at most 12,000 characters: the untrusted-memory notice and policy first, then active memories, most recently updated first, as whole entries (text, tags, review-due flag; `source` and review notes are omitted). When not everything fits, a third of the budget is kept for 120-character previews of older memories, followed by a count of any memories not shown. The section is never truncated mid-entry; use `memory_read` for full details.

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
