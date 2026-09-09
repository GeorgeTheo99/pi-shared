# Local upstream context-file dedup patch (roadmap unit 10)

**Prepared, not activated or submitted.** Nothing here is a Pi extension. No installed
Pi files, profiles, settings, context instructions, or live prompts are changed.

## Pinned source

- Repository: <https://github.com/earendil-works/pi>, `packages/coding-agent` (also
  identified by installed Pi **0.85.1** package metadata).
- Base commit: [`b2602be77cb7b0de45dd616407fd210daa48aa75`](https://github.com/earendil-works/pi/commit/b2602be77cb7b0de45dd616407fd210daa48aa75),
  `fix(ai): optimize EventStream queue`, committed **2026-09-07 20:26:47 UTC**.
- Resolved public `main` on 2026-09-08, then verified by the exact-commit API.
  All vendored bytes were independently matched against the pinned GitHub Contents
  API's decoded content and Git blob SHA-1. GitHub reports the commit signature as
  **unverified**; this is source identity verification, not signed attestation.
- `provenance.json` is the authoritative manifest: exact URLs, commit/tree IDs,
  byte sizes, SHA-256 and Git blob hashes, patch hash, and expected patched outputs.
  The base is this commit, **not** the installed npm distribution or a floating branch.

`baseline/` contains four small, unmodified source files and their upstream MIT
license, retained as `.txt` solely for reproducible offline patch application and
function extraction. The full loader snapshot avoids maintaining a reconstructed
patch base. Inspected upstream `CONTRIBUTING.md`, `AGENTS.md`, development docs,
package scripts, and existing `resource-loader.test.ts`; these were not vendored.
No upstream scripts or dependency installs were run. Downloads were serial and
limited to 2 MiB/s. The local `.gitattributes` exempts the serialized patch's
required context markers from whitespace lint; validation independently checks
its actual changed source with `git apply --whitespace=error-all`.

## Change and regression coverage

`context-dedup.patch` changes only these upstream paths:

1. `packages/coding-agent/src/core/resource-loader.ts`: remove early lexical-path
   suppression; after the existing ordered discovery/shadowing pass, scan backward
   using `Map<canonical path, Set<loaded content>>`, then restore survivor order.
   Reuse the existing `canonicalizePath` helper and its raw-path fallback.
2. `packages/coding-agent/test/resource-loader-context-dedup.test.ts`: six Vitest
   regressions for file aliases, directory aliases, distinct identical-content
   files, ancestor/global overlap ordering, and differing loaded content at the
   same lexical path or through canonical aliases.

The surviving occurrence is the last in normal **global → root ancestors → cwd**
order, not the last physical read (ancestor reads proceed cwd-upward). Its original
lexical path is retained for attribution. Deduplication compares the already-loaded,
BOM-stripped strings, not raw bytes, hashes alone, inodes, or fuzzy content. Distinct
canonical paths, including hardlinks, remain separate even with identical content.

The existing candidate priority, read/warning handling, and linked-worktree shadow
selection are unchanged. Additional offline checks cover real nested, sibling,
symlinked, ordinary, bare-layout and submodule Git fixtures, invalid gitdir fallback,
three-alias/version ordering, BOM normalization, broken links, directory candidates,
unreadable-candidate fallback, and canonicalization failure. Two negative controls
execute the unpatched loader to prove the alias duplication and lexical-path
changed-content loss before checking the patch.

## Offline validation

Requirements: **Node with `node:module.stripTypeScriptTypes` (22.13+; tested on
25.8.1), Git, and permission to create local symlinks**. No npm packages, network,
credentials, installed-Pi imports, or application startup are needed.

From the pi-shared root:

```sh
node docs/upstream/context-dedup/validate.mjs
```

The validator:

1. Checks every baseline SHA-256/Git blob hash and the patch SHA-256.
2. Creates an owned temporary source tree; runs `git apply --check` and
   `git apply --whitespace=error-all`; checks exact patched output SHA-256 values.
3. Extracts the **actual patched** `loadContextFileFromDir`,
   `findShadowedContextFile`, `loadProjectContextFiles`, and the actual pinned
   canonicalization, path-normalization, BOM and Git-discovery helpers. Unique
   source anchors fail closed on layout drift. Node erases TypeScript syntax.
4. Runs the six patch regressions through `node:test` plus an explicit adapter for
   Vitest hooks and two one-shot spies; assertions remain unchanged. Runs eighteen
   additional offline checks against real temporary files/symlinks/Git metadata.
5. Checks reverse patch applicability and removes its owned temporary tree in
   `finally`. Git fixture repositories/commits/worktrees are local to owned temp
   directories; fixture cleanup removes those only.

`offline-tests.mjs` is copied next to the extracted module by the validator; it is
not a directly runnable test at its checked-in path.

### Verified result

On macOS, Node **25.8.1**, Apple Git **2.50.1**:

- **24 tests passed; 0 failed, skipped, or canceled.**
- Pinned source/patch/output hashes and forward/reverse applicability passed.
- No active runtime integration, package install, network access during validation,
  external Git operation, or installed-package modification.

### Limits and upstream gate

This is an **extracted-function harness**, not the full resource-loader module or
Pi runtime. Only import plumbing is supplied; `chalk.yellow` is an identity wrapper.
Fault tests inject read/realpath errors or mutate real fixture files immediately
after reads. Ordinary integration tests use real filesystem calls and Git metadata.
The Vitest adapter does not establish Vitest module-mocking compatibility.

**Not run:** native upstream Vitest, the existing full loader suite, whole-repository
`npm run check`/typecheck/lint, or full non-e2e suite. No Windows/Linux run or live
prompt test was performed. Canonicalization is best-effort and is not atomic with
reads: concurrent symlink retargeting/deletion is not made race-free by this patch;
realpath failure preserves the helper's conservative lexical fallback.

Before upstream submission or installation, review against a proper checkout of
the pinned commit and run the upstream checks with its already-prepared dependencies:

```sh
# From packages/coding-agent in that upstream checkout:
node ../../node_modules/vitest/dist/cli.js --run \
  test/resource-loader-context-dedup.test.ts test/resource-loader.test.ts
# From the upstream root:
npm run check
./test.sh
```

Application/submission/installation requires a separate decision. This artifact
neither authorizes it nor bypasses the upstream contributor gate. Source-of-truth
behavior remains in upstream Pi; do not copy this fix into an active extension or
patch installed `node_modules` as an interim workaround.
