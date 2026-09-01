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

Oversized error results always use deterministic reduction so exact exit codes, stderr, assertions, stack locations, paths, URLs, IDs, hashes, statuses, and important values are not paraphrased. Deterministic summaries reserve space for every recognized non-2xx HTTP status line and every `diff --git`, `---`, and `+++` file header. If those required exact lines cannot all fit, the result stays raw and a terminal overflow marker prevents lossy retries. Model failure, empty/incomplete output, or timeout leaves the result raw during its retry cooldown; lifecycle cancellation does not count as a failure.

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

Recall output is exempt from summarization to prevent recursion. It is capped at 50,000 characters and 2,000 lines. If a requested exact slice is too large, the tool returns a size error instead of silently truncating it; request a narrower line range. Search may return a bounded subset of exact matching lines and reports omissions.

## Safety and lifecycle

- Tool output is treated as untrusted data in both summarizer prompts and replacement wrappers.
- Nested `complete()` calls use the active model plus auth/headers resolved by `ctx.modelRegistry`; as required by Pi's direct compat API, they do not re-enter AgentSession provider lifecycle hooks. Deployments that rely on those hooks for outbound DLP should keep this extension off until that policy is implemented in the provider/gateway itself.
- Assistant messages, tool-call ordering, `toolCallId`, `toolName`, error state, details, and reasoning signatures are not changed.
- Duplicate jobs for the same tool-call key share an in-flight promise; active-model requests are serialized, but provider calls never wait for them.
- Jobs are bound to the session ID/file, policy epoch, runtime generation, and originating branch entry.
- Session shutdown, branch navigation, pause, threshold changes, reset, and `off` abort work; queue generations detach from providers that ignore abort, and stale completions are discarded before persistence.
- The extension uses `context`, not provider-specific request rewriting, so JSONL remains unchanged and provider serialization stays Pi-owned.
