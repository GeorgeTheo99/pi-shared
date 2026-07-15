# Tool Summary

`tool-summary` reduces repeated provider-context growth from oversized tool results while retaining the exact originals in Pi session history.

## Behavior

1. The first provider call after an eligible oversized tool result receives the exact raw result.
2. Raw exposure is committed only when that provider call's non-error assistant response finishes; failed auth, serialization, aborted/error responses, and pre-response attempts therefore retry with raw content.
3. The extension creates one stable summary keyed by `toolCallId + raw SHA-256 + policy version`.
4. Later provider calls receive that stored summary through Pi's ephemeral `context` hook.
5. The original `toolResult` message is never patched, so its exact content remains in session JSONL and the TUI transcript.
6. A replacement is used only when it is at least 40% smaller than the original. Summary bodies target 3,000 characters; the complete replacement is hard-capped at 4,000. A non-worthwhile result is persisted as a terminal marker so later calls remain raw without repeatedly summarizing it.

Model summaries use the active session model (`ctx.model`) through `complete()` from `@earendil-works/pi-ai/compat`. Reasoning is requested at `low` only for APIs that support it. The extension never changes Pi's main-session thinking level.

Summaries, raw-exposure markers, mode, thresholds, and reset epochs are append-only non-context custom entries. They survive `/reload`, resume, and active-branch navigation without copying raw tool output into extension state. The first valid completion for a key is frozen to avoid prompt-cache churn.

## Default policy

| Class | Threshold | Reduction |
|---|---:|---|
| `read`, `deep_research`, `spawn_subagent`, `workflow`, panel/report outputs | 16,000 characters | Active-model high-fidelity summary |
| `web_fetch`, browser/app extracted prose, text/HTML API bodies | 8,000 characters | Active-model summary |
| `bash`, logs, memory/search/KB results, structured JSON, evaluate/API output | 8,000 characters | Deterministic reduction |
| Unknown/custom text tools | 8,000 characters | Deterministic for JSON/log-like output; otherwise active-model summary |
| Mutation/control/status/navigation tools, images, screenshots, recall, and path-only artifact results | Exempt | Raw only |

Oversized error results always use deterministic reduction so exact exit codes, stderr, assertions, stack locations, paths, URLs, IDs, hashes, statuses, and important values are not paraphrased. Model failures, empty/incomplete output, cancellation, or timeout also settle to a deterministic head/important-lines/tail fallback when the originating session branch is still valid.

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
/tool-summary reset
```

- `on`: create new summaries and substitute stored summaries.
- `pause`: abort pending/in-flight creation and retain existing substitutions.
- `off`: restore raw provider context and warn about estimated active-branch growth.
- `status`: show mode, thresholds, exposure/completion counts, in-flight work, and estimated savings.
- `threshold`: inspect or change the standard/high-fidelity character thresholds. The minimum is 4,001, and standard cannot exceed high-fidelity.
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
- Duplicate jobs share an in-flight promise; active-model requests are serialized.
- Jobs are bound to the session ID/file, policy epoch, runtime generation, and originating branch entry.
- Session shutdown, branch navigation, pause, threshold changes, reset, and `off` abort work; queue generations detach from providers that ignore abort, and stale completions are discarded before persistence.
- The extension uses `context`, not provider-specific request rewriting, so JSONL remains unchanged and provider serialization stays Pi-owned.
