/**
 * glm-thinking — graded reasoning_effort for local GLM models on oMLX.
 *
 * Problem: pi-ai's `qwen-chat-template` thinkingFormat branch (the one local
 * oMLX GLM/Qwen/Gemma models use) only sends a boolean
 * `chat_template_kwargs.enable_thinking`. It ignores `thinkingLevelMap`, so
 * the GLM-5.2 chat template's graded `reasoning_effort` ("high" / "max") is
 * never forwarded — every thinking level produces the same `max`-effort run.
 *
 * The cloud route has no such gap because cloud-gateway's
 * `_apply_gateway_reasoning` translates effort per format. Local oMLX models
 * bypass the gateway (Pi → oMLX direct), so there is no translator.
 *
 * This extension closes that gap at the `before_provider_request` hook: for
 * any model whose `thinkingLevelMap` maps the *currently selected* thinking
 * level to a string effort (e.g. GLM-5.2: high→"high", xhigh→"max"), it
 * injects `chat_template_kwargs.reasoning_effort` into the outgoing payload.
 *
 * - Qwen / Gemma (all-null maps) are untouched: no string mapping → no
 *   injection → identical on/off behavior as before.
 * - GLM-5.1 (on/off template, no reasoning_effort support) keeps the
 *   `local-qwen` all-null map, so it is also untouched.
 * - GLM-5.2 (graded map via the launcher's `local-glm` kind) gets real
 *   high/max effort control, matching the cloud `zai` route.
 *
 * The currently selected thinking level is recovered from the session branch
 * (the `before_provider_request` context exposes `ctx.sessionManager`, not
 * `ctx.getThinkingLevel()` which is command-context only).
 *
 * This is a stopgap until pi-ai's `qwen-chat-template` branch forwards a
 * mapped `reasoning_effort` (matching how the zai/deepseek/openrouter branches
 * already use `thinkingLevelMap`); at that point this extension can be deleted
 * in a single file removal.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/** Walk the current session branch for the most recent thinking_level_change. */
function currentThinkingLevel(ctx: { sessionManager: any }): string | undefined {
  const sm = ctx.sessionManager;
  if (!sm || typeof sm.getBranch !== "function") return undefined;
  let leafId: string | null | undefined;
  try {
    leafId = typeof sm.getLeafId === "function" ? sm.getLeafId() : undefined;
  } catch {
    leafId = undefined;
  }
  let branch: any[];
  try {
    branch = sm.getBranch(leafId ?? undefined) ?? [];
  } catch {
    return undefined;
  }
  let level: string | undefined;
  for (const entry of branch) {
    if (entry && entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") {
      level = entry.thinkingLevel;
    }
  }
  return level;
}

export default function glmThinkingExtension(pi: ExtensionAPI) {
  pi.on("before_provider_request", (event, ctx) => {
    const payload = event.payload as Record<string, any> | undefined;
    const model = ctx.model;
    if (!payload || !model) return;

    // Only qwen-chat-template models carry chat_template_kwargs from pi-ai.
    const thinkingFormat = (model as any).compat?.thinkingFormat;
    if (thinkingFormat !== "qwen-chat-template") return;

    // Only act when this model+level resolves to a real effort string.
    // Qwen/Gemma/GLM-5.1 maps are all-null/undefined → skip (no behavior change).
    const level = currentThinkingLevel(ctx);
    if (!level) return;
    const effort = (model as any).thinkingLevelMap?.[level];
    if (typeof effort !== "string") return;

    // Inject reasoning_effort into the existing chat_template_kwargs, preserving
    // enable_thinking / preserve_thinking that pi-ai already set.
    const kwargs = (payload.chat_template_kwargs ?? {}) as Record<string, any>;
    kwargs.reasoning_effort = effort;
    // ensure_thinking reflects the selected (non-off) level.
    if (kwargs.enable_thinking === undefined) kwargs.enable_thinking = true;
    payload.chat_template_kwargs = kwargs;

    return payload;
  });
}
