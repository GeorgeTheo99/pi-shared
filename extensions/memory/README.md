# Project Memory

Machine-local, project-only memory for Pi: one curated Markdown file per repository.

## Storage

```text
~/.pi/memory/projects/<project-name>-<project-id>.md
```

Project identity is derived from the git repo root plus `remote.origin.url` when available, falling back to the canonical current working directory for non-git folders. Linked worktrees use the main checkout's root, so they share its memory; submodules keep their own. `PI_MEMORY_DIR` overrides `~/.pi/memory`.

The file is ordinary Markdown organized into `## ` sections. Each section edited through the tool starts with an `<!-- updated: YYYY-MM-DD -->` line so readers can judge staleness. It can also be edited by hand.

No global memory is implemented. Do not store user-wide preferences here.

Data safety:

- Writes hold an interprocess lock (`<file>.lock`), so concurrent Pi sessions in the same project cannot overwrite each other's changes.
- Files are replaced atomically with mode `0600`; the previous version is kept as `<file>.bak`.
- The file is limited to 12,000 characters. Writes that would grow it past the limit are refused, so it must be condensed rather than silently cut; edits that shrink an oversized, hand-edited file are allowed.
- Text that looks like a credential (tokens, keys, JWTs, `Bearer` headers, URLs with passwords) is refused. This is a best-effort check, not a guarantee.

## Tools

- `memory_read` — return the current memory file. `path` reads the memory of the repository containing that file or directory.
- `memory_write` — edit the memory file:
  - `set_section` with `section` and `content` creates or replaces a `## ` section; empty `content` removes it. Content cannot contain its own `## ` headings (fenced code is fine).
  - `replace` with `old_text` and `new_text` swaps one exact, unique piece of text; empty `new_text` deletes it. The containing section's date is updated.
  - `path` targets the repository a fact is about. In a folder that is not a git repository, such as a directory of checkouts, facts about one checkout belong in that checkout's memory.

`memory_read` declares a versioned output schema. Pi 0.99.1+ codemode receives `{version:1,status:"ok",data:{project:{id,name},document,chars,limit}}`; project root and storage paths are omitted. The document remains untrusted evidence.

## Prompt injection

The memory file is read once per session and appended to the system prompt together with the memory policy, an untrusted-content notice and the current size. It is refreshed when a new session starts or after compaction; writes made during a session do not change that session's prompt, which keeps the prompt cache stable. Use `memory_read` for the current file.

A legacy JSON store (`<project-name>-<project-id>.json`, from earlier versions) is not loaded; the prompt points to it so its useful facts can be folded into the Markdown file before it is moved into `~/.pi/memory/legacy/`.

## Command

```text
/memory [path|help]
```

## Policy

The memory is a curated reference, not a log. Record what is costly to rediscover and not derivable from the code, git history or repository docs:

- decisions and their reasons
- machine-local setup, services, ports and paths
- gotchas and recurring fixes
- explicit user decisions

Do not record task progress, release or test logs, job IDs, guesses, secrets or sensitive personal data. Brief evidence (a file, command or user decision) helps. When something in memory turns out to be wrong or stale, fix it before finishing; prefer editing an existing section over adding one.
