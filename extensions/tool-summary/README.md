# Tool Summary

`tool-summary` reduces repeated provider-context growth from oversized tool results while retaining the exact originals in Pi session history.

## Behavior

1. The first provider call after an eligible oversized tool result receives the exact raw result.
2. Raw exposure is committed only when that provider call's non-error assistant response finishes; failed auth, serialization, aborted/error responses, and pre-response attempts therefore retry with raw content.
3. The extension creates one stable summary keyed by `toolCallId + raw SHA-256 + policy version`.
4. Model summaries run only in the background. If one is unfinished or cooling down after a failure, the next provider call remains raw instead of waiting.
5. Later provider calls receive a completed stored summary through Pi's ephemeral `context` hook.
6. The original `toolResult` message is never patched, so its exact content remains in session JSONL and the TUI transcript.
7. A replacement is used only when it is at least 40% smaller than the original. Summary bodies target 3,000 characters; the complete replacement is hard-capped at 4,000. A non-worthwhile result is persisted as a terminal marker so later calls remain raw without repeatedly summarizing it.
8. Tool-result **images age out of provider context**: only the newest 4 image parts across the active branch are sent to the provider; older ones are replaced by a small deterministic text placeholder naming the tool, `toolCallId`, MIME type, and approximate size. Aging runs only in `on` mode, mutates provider copies only (stored entries and JSONL keep the exact images), and a formerly image-bearing result becomes eligible for normal text summarization once its images age out. Control it with `/tool-summary images <0-64>|off|reset`.

Model summaries use the active session model (`ctx.model`) through `complete()` from `@earendil-works/pi-ai/compat`. Reasoning is requested at `low` only for APIs that support it. The extension never changes Pi's main-session thinking level. Failed model summaries leave the exact result raw and append a bounded retry cooldown: 30 seconds initially, doubling to a 30-minute cap. They never freeze a deterministic fallback as the permanent summary.

Summaries, retry cooldowns, raw-exposure markers, mode, thresholds, and reset epochs are append-only non-context custom entries. They survive `/reload`, resume, and active-branch navigation without copying raw tool output into extension state. The first valid model or deterministic completion for a key is frozen to avoid prompt-cache churn. Policy v2 intentionally ignores v1 summary/exposure state so eligible historical results receive one fresh raw exposure under the safer rules. Persisted configs using the exact former default pair (`8K` standard / `16K` high-fidelity) migrate to `16K` / `24K`; other custom threshold pairs are preserved.

## Default policy

| Class | Threshold | Reduction |
|---|---:|---|
| `read`, `deep_research`, `spawn_subagent`, `workflow`, panel/report outputs | 24,000 characters | Background active-model high-fidelity summary |
| `web_fetch`, browser/app extracted prose, text/HTML API bodies | 16,000 characters | Background active-model summary |
| `bash`, logs, search/KB results, structured JSON, evaluate/API output | 16,000 characters | Deterministic reduction |
| Unknown/custom text tools | 16,000 characters | Deterministic for JSON/log-like output; otherwise background active-model summary |
| `memory_read`, mutation/control/status/navigation tools, images, screenshots, recall, and path-only artifact results | Exempt | Raw only |

Image-bearing results are exempt from *summarization*, but their image parts are still subject to image aging (rule 8) — the newest 4 images stay raw, older ones become text placeholders in provider context only.

Oversized error results always use deterministic reduction so exact exit codes, stderr, assertions, stack locations, paths, URLs, IDs, hashes, statuses, and important values are not paraphrased. Deterministic summaries reserve space for every recognized non-2xx HTTP status line and every `diff --git`, `---`, and `+++` file header, plus recognized scalar JSON exit codes, counts (`count`, `total`, `passed`, `failed`, `failures`, `skipped`, `tests`), and artifact IDs. These values are selected lexically, never reconstructed by a model. If those required exact lines cannot all fit, the result stays raw and a terminal overflow marker prevents lossy retries. Model failure, empty/incomplete output, or timeout leaves the result raw during its retry cooldown; lifecycle cancellation does not count as a failure.

## Slash controls

Changes apply immediately; `/reload` is not required.

```text
/tool-summary on
/tool-summary pause
/tool-summary off
/tool-summary status
/tool-summary threshold
/tool-summary threshold 9k
/tool-summary threshold standard 9k
/tool-summary threshold high 18k
/tool-summary threshold 9k 18k
/tool-summary threshold reset
/tool-summary images
/tool-summary images 8
/tool-summary images off
/tool-summary images reset
/tool-summary reset
```

- `on`: create new summaries and substitute stored summaries.
- `pause`: abort pending/in-flight creation and retain existing substitutions.
- `off`: restore raw provider context and warn about estimated active-branch growth.
- `status`: show mode, thresholds, exposure/completion/retry counts, in-flight work, and estimated savings.
- `threshold`: inspect or change the standard/high-fidelity character thresholds. The minimum is 4,001, and standard cannot exceed high-fidelity.
- `images`: inspect or change tool-result image retention (default: newest 4; range 0–64; `off` disables aging; `reset` restores the default).
- `reset`: advance the branch epoch, clearing active summaries and exposure markers without deleting append-only history. Mode and thresholds are retained.

## Exact recall

The `tool_result_recall` tool retrieves exact text from the original stored `toolResult` by `toolCallId`:

- `search`: literal line search, optional case sensitivity, up to 100 matches.
- `head`: first lines.
- `tail`: last lines.
- `line-range`: inclusive 1-based line range.
- `json-pointer`: RFC 6901 selection over an explicitly chosen original text part or stored `details` (see below).

Recall output is exempt from summarization to prevent recursion. It is capped at 50,000 characters and 2,000 lines. If a requested exact slice is too large, the tool returns a size error instead of silently truncating it; request a narrower line range. Search may return a bounded subset of exact matching lines and reports omissions.

### Structured recall

```json
{"toolCallId":"call_123","operation":"json-pointer","source":"text","contentIndex":0,"pointer":"/rows/0/id"}
```

For stored tool metadata, use `"source":"details"` and omit `contentIndex`.
`source` and `pointer` are required for JSON Pointer; text also requires an explicit
zero-based index into the **original content array**, including image parts in the
index count. Text parts are never concatenated for JSON queries. Use `pointer:""`
for the root, `/a~1b` for key `a/b`, and `/~0` for key `~`. Array indices must be
canonical nonnegative integers: no leading zeros, signs, or `-`. JSONPath and URI
fragment pointers are not supported.

- Text selections return the original JSON value span, preserving large integer,
  exponent, negative-zero, string-escape, and internal whitespace lexemes exactly.
- Details selections use JSON serialization of the **already stored JavaScript
  value**; they cannot recover original numeric precision or formatting. Normal
  JSON serialization rules apply (for example, undefined object properties are
  omitted). Unserializable details fail clearly.
- `details.version:1` and `status:ok|missing|error` distinguish successful selection
  (including `valueType:null`) from a missing target and query errors. `found`
  identifies the original result; `matched` identifies a resolved pointer.
  Query errors are returned as structured outcomes, like legacy recall diagnostics,
  not as Pi execution exceptions. Selected JSON is in the untrusted text wrapper;
  metadata contains its SHA-256 and zero-based, end-exclusive UTF-16 source span.
- Provenance includes session/entry/call identity, original tool/error state,
  content and selected-source hashes, source/index/pointer, and fidelity.
  Recall reads only original message entries on the active branch, including
  pre-compaction originals; it never uses a provider summary or another branch.
  Reused call IDs fail as ambiguous even if their text is identical.
- Entire JSON sources are validated. Duplicate object keys are rejected, even in
  an unrelated subtree, rather than choosing an implementation-dependent value.
  Limits: 5,000,000 source characters, 4,096 pointer characters, 128 nesting levels,
  and 200,000 values. Oversized provenance is refused too.
- JSON recall returns at most 50,000 serialized characters **and UTF-8 bytes**
  (including content and details), and 2,000 text lines. Oversized selections are
  omitted entirely with `error:selection_too_large`, `omitted:true`, `exact:false`;
  `truncated:false` means no partial JSON was returned. Choose a narrower pointer.
- Exactness is relative to stored data, not upstream completeness. Explicit
  `details.truncated:true` or `details.truncation.truncated:true` is reported as
  `upstreamTruncation:reported`; otherwise it is `unknown`. Recall never recovers
  data already removed by the original tool or provider.

## Safety and lifecycle

- Tool output is treated as untrusted data in both summarizer prompts and replacement wrappers.
- Nested `complete()` calls use the active model plus auth/headers resolved by `ctx.modelRegistry`; as required by Pi's direct compat API, they do not re-enter AgentSession provider lifecycle hooks. Deployments that rely on those hooks for outbound DLP should keep this extension off until that policy is implemented in the provider/gateway itself.
- Assistant messages, tool-call ordering, `toolCallId`, `toolName`, error state, details, and reasoning signatures are not changed.
- Duplicate jobs for the same tool-call key share an in-flight promise; active-model requests are serialized, but provider calls never wait for them.
- Jobs are bound to the session ID/file, policy epoch, runtime generation, and originating branch entry.
- Session shutdown, branch navigation, pause, threshold changes, reset, and `off` abort work; queue generations detach from providers that ignore abort, and stale completions are discarded before persistence.
- The extension uses `context`, not provider-specific request rewriting, so JSONL remains unchanged and provider serialization stays Pi-owned.
