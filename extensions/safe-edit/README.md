# Safe edit previews

`safe_edit` is an opt-in companion to the unchanged built-in `edit`.

```javascript
safe_edit({action:"preview",path:"src/index.ts",edits:[{oldText:"before",newText:"after"}]})
// Inspect patch; then supply both returned identity fields:
safe_edit({action:"apply",preview_id:"edit_<uuid>",expected_sha256:"<preview SHA-256>"})
```

- One existing caller-owned UTF-8 file within the canonical caller workspace.
  Maximum input/result 1 MiB, 100 edits, eight in-memory previews, ten-minute TTL.
- Exact unique nonoverlapping matches against the original contents. No fuzzy
  matching or newline normalization. BOM and untouched line endings remain exact.
- Preview is read-only; optional `expected_sha256` rejects stale input immediately.
  Apply requires project trust, the exact preview ID/hash, unchanged content,
  permissions, inode, and symlink target. Reload/session replacement clears previews.
- Uses Pi's exported `withFileMutationQueue` to cooperate with built-in edits;
  fails closed if unavailable. Stages a private same-directory temporary file,
  rechecks the source, then atomically renames. Temporary files are cleaned up.
- Atomic replacement preserves ordinary permission bits, not inode identity,
  ownership of other users, hardlink identity, extended attributes, or other special
  metadata. Other-owned files, hardlinks, and special permission bits are refused.
  Use the appropriate existing editor for files whose extended metadata matters.
- No multi-file transaction or recovery journal. Other processes can race the final
  check/rename; an in-process queue is not a cross-process lock or OS sandbox.
- Preview patch output is capped at 50,000 characters with an explicit truncation
  flag. Source content is untrusted and may be sensitive; nothing is uploaded.

Verification: `npm run test:safe-edit` exercises exact spans, stale inputs, symlink
changes, permissions, BOM/newlines/Unicode, workspace bounds, aborts and cleanup.
