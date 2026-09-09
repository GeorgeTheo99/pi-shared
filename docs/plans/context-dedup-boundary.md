# Context deduplication: upstream boundary

Inspected installed Pi 0.85.1 on 2026-09-08. No core files or live prompts were
modified. This is roadmap unit 10's compatibility finding, not a working extension.

## Reproduced source condition

On this machine, `~/.pi/agent/AGENTS.md` is a symlink to pi-shared's `AGENTS.md`.
Both paths resolve to the same file with identical contents. Installed
`dist/core/resource-loader.js:loadProjectContextFiles()` uses lexical `path`
strings in `seenPaths`, so the aliases can both survive context loading.
The session indeed received the shared instructions through both paths. A later
read-only reproduction through the supported `DefaultResourceLoader` API, with
extension/skill/prompt/theme imports disabled and in-memory settings, returned
four context files and two occurrences of the same canonical shared file. Each
copy was 21,945 bytes; this establishes duplicate instruction payload, not an
estimated token count.

The supported extension hook exposes `before_agent_start.systemPromptOptions`,
but its documented return contract replaces the rendered `systemPrompt`, not the
resource loader's context-file inventory. Pi's root package exports do not expose
`buildSystemPrompt`; it is private to `dist/core/system-prompt.js`. Rebuilding the
prompt by importing private installed internals or splicing rendered text would
risk dropping custom prompts or other extensions' contributions.

## Recommended upstream change

Implement canonical-path deduplication in Pi's resource loader, with these tests:

1. The same canonical file loaded globally and through a repository alias appears
   once, retaining its most-specific occurrence and thus normal ancestor ordering.
2. Distinct canonical files with identical contents remain distinct resources.
3. The same canonical path with different loaded contents is not silently collapsed
   (a file could change between reads).
4. Distinct ancestor rules and custom prompts remain untouched.
5. Existing linked-worktree shadowing and unreadable-path behavior remain intact.

A small loader-level implementation can first collect the ordered context files,
then scan from most-specific to least-specific and keep the last occurrence of
an identical `(canonical path, loaded content)` pair. Preserve original order for
the survivors. Reuse the core's existing path canonicalization helper; do not
introduce content-only or fuzzy instruction deduplication.

## Action boundary

There is no Pi core source checkout among the inspected Pi-related local project
folders. The canonical installed source is an npm package, not pi-shared. Do not
patch `node_modules` or remove the canonical shared `AGENTS.md` symlink as a workaround.
A local upstream patch has now been prepared without installing or submitting it:
[patch, pinned provenance, and offline validation](../upstream/context-dedup/README.md).
It targets commit `b2602be77cb7b0de45dd616407fd210daa48aa75` and includes loader changes
plus six upstream regressions. Its standalone harness exercises the actual
extracted patched functions and pinned helpers; it is not a full Pi runtime test.

Choosing an upstream submission, a separately built Pi installation, or waiting
for an upstream release is the remaining action boundary. Before submission or
installation, native upstream Vitest/full loader checks and typecheck/lint still
need to run in a proper source checkout. No installed npm files were changed, and
no additional active extension was created. The other nine roadmap units are
already live and do not depend on this change.
