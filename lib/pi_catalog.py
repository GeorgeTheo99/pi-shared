#!/usr/bin/env python3
"""Render Pi CLI artifacts from a model catalog alias file.

This is the Pi-side of the model-gateway / Pi separation. model-gateway emits a
generic ``model-aliases.json`` catalog (its public contract); this module
consumes that catalog and renders the Pi-specific artifacts:

  1. ``models.json`` — a Pi provider/models config targeting the gateway (or
     any OpenAI-compatible endpoint) with full reasoning/thinkingFormat compat
     knowledge that lives here, not in the gateway.
  2. ``pi-launchers.zsh`` — ``pi-<alias>()`` quick-start functions + ``pi-list``
     + ``pi-restart`` (+ optional ``pi-default`` / ``pi-openai``).

The model id used in the launcher ALWAYS matches the id written to models.json
(local models use the alias key / omlx_id; cloud models use provider_model_id),
so the two outputs can never drift.

Inputs:
  --aliases      path to model-aliases.json (required)
  --models-out   write Pi models.json here (optional)
  --launchers-out write pi-launchers.zsh here (optional)
  --provider-name Pi provider name in models.json (default: ls99-models)
  --gateway-url  endpoint Pi providers point at (default: http://localhost:9111)
  --gateway-api-key  apiKey for the Pi provider (default: cloud)
  --pi-agent-dir  PI_CODING_AGENT_DIR the launcher sets (default: none = default profile)
  --omlx-status  optional JSON from oMLX /v1/models/status for thinking_default fallback
  --ls99-extras  include pi-default + pi-openai (ls99 opt-in layer)
  --check        drift check only; exit 1 when outputs are stale

Modes:
    pi-catalog --aliases ~/.claude/model-aliases.json \\
                --models-out ~/.pi-omlx/agent/models.json \\
                --launchers-out ~/.pi/generated/pi-launchers.zsh \\
                --pi-agent-dir ~/.pi-omlx/agent --ls99-extras
"""

from __future__ import annotations

import argparse
import difflib
import json
import os
import sys
from pathlib import Path

# --- Pi models.json schema knowledge ----------------------------------------

# Thinking values that mean "this model can reason" (optional = user toggle,
# always = on by default). Mirrors model-info.json's `thinking` field.
THINKING_VALUES = {"optional", "always"}
ANTHROPIC_PROVIDERS = {"anthropic"}

# Default provider-level compat sent for an openai-completions provider. Per-model
# `compat` (thinkingFormat etc.) is added by apply_reasoning.
_DEFAULT_PROVIDER_COMPAT = {
    "supportsDeveloperRole": False,
    "supportsReasoningEffort": False,
    "supportsUsageInStreaming": False,
    "supportsStore": False,
    "maxTokensField": "max_tokens",
}


def _norm_provider(meta: dict) -> str:
    return (meta.get("provider") or "local").strip().lower()


def _is_cloud_key(key: str) -> bool:
    """Whether a catalog entry is routed to a cloud provider."""
    return key.startswith("cloud:")


def _pi_hints(meta: dict) -> dict:
    """Optional Pi-specific passthrough hints from the gateway catalog.

    The gateway carries an opaque ``pi:`` block per model (id/name/reasoning/
    thinkingLevelMap/compat) so machine-local config can shape the rendered Pi
    artifacts without this module needing provider-specific knowledge.
    """
    hints = meta.get("pi")
    return hints if isinstance(hints, dict) else {}


def _is_anthropic_shape(key: str, meta: dict) -> bool:
    """Should Pi talk anthropic-messages to the gateway for this model?

    True for native anthropic providers, for models whose upstream protocol is
    anthropic, and for claude-family models behind translating gateways (the
    gateway's /v1/messages path translates for openai-shaped upstreams, and
    Pi's anthropic client handles claude thinking/tool responses best).
    """
    if _norm_provider(meta) in ANTHROPIC_PROVIDERS:
        return True
    if not _is_cloud_key(key):
        return False
    if (meta.get("protocol") or "").strip().lower() == "anthropic":
        return True
    return str(meta.get("name", "")).lower().startswith("claude")


def _is_qwen_family(key: str, meta: dict) -> bool:
    haystack = " ".join(str(meta.get(k, "")) for k in ("alias", "name", "omlx_id", "provider_model_id"))
    return "qwen" in f"{key} {haystack}".lower()


def _is_local_key(key: str, meta: dict) -> bool:
    return not _is_cloud_key(key) and _norm_provider(meta) in {"local", "omlx", "mlx"}


def _reasoning_kind(key: str, meta: dict, status: dict) -> str:
    """Classify how a model wants its thinking controls, or "" if none.

    Conservative: only enable model-specific thinking parameters where the
    request shape is already known to tolerate them (recorded in model-info via
    thinking_format / provider). model-gateway is shared by other services, so
    Pi's generated config must not send speculative thinking params.
    """
    provider = _norm_provider(meta)
    thinking = meta.get("thinking") or ""
    thinking_format = (meta.get("thinking_format") or "").strip().lower()
    chat_template_kwargs = meta.get("chat_template_kwargs") if isinstance(meta.get("chat_template_kwargs"), dict) else {}

    if meta.get("enable_thinking") is False or chat_template_kwargs.get("enable_thinking") is False:
        return ""
    # Explicit Pi hint wins in both directions: reasoning: false silences a
    # model that would otherwise get thinking controls (e.g. an anthropic-shape
    # model served without extended thinking).
    if _pi_hints(meta).get("reasoning") is False:
        return ""

    if _is_anthropic_shape(key, meta):
        return "anthropic"

    if _is_local_key(key, meta):
        if thinking in THINKING_VALUES and thinking_format == "qwen-chat-template":
            return "local-qwen"
        if thinking in THINKING_VALUES and thinking_format == "glm-chat-template":
            return "local-glm"
        if thinking in THINKING_VALUES and thinking_format == "deepseek-v4-dsml":
            return "local-deepseek-v4-dsml"
        # Qwen models discovered by oMLX as thinking_default=True but not marked
        # in model-info: treat thinking as optional so Pi can still turn it off.
        if _is_qwen_family(key, meta) and (thinking in THINKING_VALUES or status.get("thinking_default") is True):
            return "local-qwen"
        return ""

    if provider == "gguf":
        return ""

    if provider == "fireworks" and thinking in THINKING_VALUES:
        # Pi's upstream registry uses Anthropic Messages shape for Fireworks
        # reasoning models; the gateway's /v1/messages path translates that.
        return "fireworks-messages"

    if provider in {"zhipuai", "zai", "zai_coding", "bigmodel"} and thinking in THINKING_VALUES:
        return "zai"

    if provider == "openrouter" and thinking in THINKING_VALUES:
        return "openrouter"

    if provider in {"moonshot", "moonshotai", "moonshotai-cn"} and thinking in THINKING_VALUES:
        model_id = str(meta.get("provider_model_id") or meta.get("name") or "").lower()
        if model_id == "kimi-k3":
            return "kimi-k3"

    if provider == "openai" and thinking in THINKING_VALUES:
        # GPT-5.x rejects some reasoning+tools shapes on Chat Completions.
        return "openai-responses"

    if _pi_hints(meta).get("reasoning") is True or (
        _is_cloud_key(key) and thinking in THINKING_VALUES
    ):
        # Generic gateway-proxied reasoning model (no provider-specific branch
        # matched): mark reasoning without speculative thinking params — the
        # gateway/provider owns any request-shape translation.
        return "gateway"

    return ""


def _api_type_for(kind: str, key: str, meta: dict) -> str:
    if _is_anthropic_shape(key, meta) or kind == "fireworks-messages":
        return "anthropic-messages"
    if kind == "openai-responses":
        return "openai-responses"
    return "openai-completions"


def _apply_reasoning(model: dict, kind: str, meta: dict) -> None:
    if not kind:
        return
    model["reasoning"] = True
    thinking = meta.get("thinking") or ""
    identities = {
        str(meta.get(field) or "").lower()
        for field in ("provider_model_id", "name", "omlx_id")
        if meta.get(field)
    }
    level_map: dict = {}
    if thinking == "always":
        level_map["off"] = None

    if kind == "local-qwen":
        # Boolean chat_template_kwargs.enable_thinking toggle, not graded effort.
        # Expose "high" as the on state; other levels collapse to it.
        model["compat"] = {"thinkingFormat": "qwen-chat-template"}
        level_map.update({"minimal": None, "low": None, "medium": None, "xhigh": None, "max": None})
    elif kind == "local-glm":
        model["compat"] = {
            "thinkingFormat": "chat-template",
            "chatTemplateKwargs": {
                "enable_thinking": {"$var": "thinking.enabled"},
                "preserve_thinking": True,
                "reasoning_effort": {"$var": "thinking.effort", "omitWhenOff": True},
            },
        }
        if any("glm-5.2" in identity for identity in identities):
            # GLM 5.2's template supports graded high/max effort.
            level_map.update({
                "minimal": "high", "low": "high", "medium": "high",
                "high": "high", "xhigh": "max", "max": "max",
            })
        else:
            # Keep unverified chat-template variants on the boolean high state.
            level_map.update({"minimal": None, "low": None, "medium": None, "xhigh": None, "max": None})
    elif kind == "local-deepseek-v4-dsml":
        model["compat"] = {"thinkingFormat": "qwen-chat-template", "stripDsmlToolMarkup": True}
        level_map.update({"minimal": None, "low": None, "medium": None, "xhigh": None, "max": None})
    elif kind == "zai":
        compat = {"supportsDeveloperRole": False, "thinkingFormat": "zai"}
        if identities & {"glm-4.7", "glm-5-turbo", "glm-5.1", "glm-5.2"}:
            compat["zaiToolStream"] = True
        if "glm-5.2" in identities:
            compat["supportsReasoningEffort"] = True
            level_map.update({"minimal": None, "low": "high", "medium": "high", "high": "high", "max": "max"})
        model["compat"] = compat
    elif kind == "openrouter":
        model["compat"] = {"thinkingFormat": "openrouter"}
        if str(meta.get("provider_model_id", "")).startswith("deepseek/"):
            model["compat"]["requiresReasoningContentOnAssistantMessages"] = True
            level_map.update({
                "minimal": None, "low": None, "medium": None,
                "high": "high", "xhigh": "xhigh", "max": None,
            })
    elif kind == "kimi-k3":
        model.setdefault("compat", {}).update({
            "supportsStore": False,
            "supportsDeveloperRole": False,
            "supportsReasoningEffort": False,
            "maxTokensField": "max_tokens",
            "supportsStrictMode": False,
            "thinkingFormat": "deepseek",
            "requiresReasoningContentOnAssistantMessages": True,
            "deferredToolsMode": "kimi",
        })
        level_map.update({
            "off": None,
            "minimal": None,
            "low": None,
            "medium": None,
            "high": None,
            "xhigh": None,
            "max": "max",
        })
    elif kind == "anthropic":
        compat = model.setdefault("compat", {})
        if "claude-fable-5" in identities:
            compat["forceAdaptiveThinking"] = True
            level_map.update({"off": None, "xhigh": "xhigh", "max": "max"})
        elif identities & {"claude-opus-4-7", "claude-opus-4-8"}:
            compat.update({"forceAdaptiveThinking": True, "supportsTemperature": False})
            level_map.update({"xhigh": "xhigh", "max": "max"})
        elif identities & {"claude-opus-4-6", "claude-sonnet-4-6"}:
            compat["forceAdaptiveThinking"] = True
            level_map["max"] = "max"
    elif kind == "openai-responses":
        if identities & {"gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"}:
            level_map.update({"off": "none", "xhigh": "xhigh", "max": "max"})
        elif identities & {"gpt-5.5-pro"}:
            level_map.update({"off": None, "minimal": None, "low": None, "xhigh": "xhigh"})
        elif identities & {"gpt-5.5"}:
            level_map.update({"off": "none", "minimal": None, "xhigh": "xhigh"})
        elif identities & {"gpt-5.4-pro"}:
            level_map.update({"off": None, "xhigh": "xhigh"})
        elif identities & {"gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"}:
            level_map.update({"off": "none", "xhigh": "xhigh"})

    if level_map:
        model["thinkingLevelMap"] = level_map


def _cost() -> dict:
    return {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}


def _eligible_entries(aliases: dict) -> list[tuple[str, dict]]:
    """Yield (key, meta) for catalog entries both render_models and render_launchers
    include — the single eligibility + dedup rule so launcher ids and models.json
    ids can never disagree.

    Rules (mirroring render_models' skip logic):
      - skip entries with no `alias` or `supported: false`
      - skip `provider: gguf` entries
      - cloud entries: skip if no `provider_model_id` or a duplicate one
      - local entries: skip duplicate keys
    Order: alias-file iteration order is preserved; local entries come out in
    file order, cloud entries in file order. (render_models concatenates
    local + cloud; render_launchers sorts by alias, so order doesn't matter for
    correctness, only for stable output.)
    """
    seen_local: set[str] = set()
    seen_cloud: set[str] = set()
    out: list[tuple[str, dict]] = []
    for key, alias_meta in aliases.items():
        meta = dict(alias_meta)
        if not meta.get("alias") or meta.get("supported") is False:
            continue
        provider = _norm_provider(meta)
        if provider == "gguf":
            continue
        if _is_cloud_key(key):
            pm = meta.get("provider_model_id")
            if not pm or pm in seen_cloud:
                continue
            seen_cloud.add(pm)
        else:
            if key in seen_local:
                continue
            seen_local.add(key)
        out.append((key, meta))
    return out


def _model_id_for(key: str, meta: dict) -> str:
    """The model id used in BOTH models.json and the launcher (never drifts)."""
    if _is_cloud_key(key):
        return _pi_hints(meta).get("id") or meta.get("provider_model_id") or key
    return key  # local: alias key == omlx_id


def render_models(
    aliases: dict,
    *,
    provider_name: str = "ls99-models",
    gateway_url: str = "http://localhost:9111",
    gateway_api_key: str = "cloud",
    omlx_status: dict | None = None,
) -> dict:
    """Render a Pi models.json targeting the gateway from an alias catalog.

    Local models are keyed by their alias key (the omlx_id); cloud models by
    provider_model_id — the launcher uses the same ids, so they never drift.
    """
    omlx_status = omlx_status or {}
    gw = gateway_url.rstrip("/")
    local_models: list[dict] = []
    cloud_models: list[dict] = []

    for key, meta in _eligible_entries(aliases):
        status = omlx_status.get(key, {})
        ctx = int(
            meta.get("context")
            or status.get("max_context_window")
            or meta.get("max_context_window")
            or 32768
        )
        max_out = int(
            meta.get("max_output_tokens")
            or status.get("max_tokens")
            or meta.get("max_tokens")
            or 32768
        )
        provider = _norm_provider(meta)
        kind = _reasoning_kind(key, meta, status)
        api_type = _api_type_for(kind, key, meta)
        is_anthropic = _is_anthropic_shape(key, meta)
        is_cloud = provider not in {"local", "omlx", "mlx", "gguf"}
        # Cloud models route through the gateway, which handles vision fallback
        # for text-only models (reroute to gemini). So mark every cloud model
        # image-capable. Local VL models get image input via an explicit vision
        # flag or, when that flag is absent, a VL/gemma name heuristic. An
        # explicit false keeps text-only models text-only (no cloud reroute).
        _hay = " ".join(
            str(meta.get(k, ""))
            for k in ("alias", "name", "omlx_id", "provider_model_id", "desc")
        ).lower()
        vision_flag = meta.get("vision")
        is_vision = vision_flag is True or (
            vision_flag is None and ("vl" in _hay or "gemma" in _hay)
        )
        hints = _pi_hints(meta)
        desc = hints.get("name") or meta.get("desc") or key
        model: dict = {
            "id": _model_id_for(key, meta),
            "name": desc,
            "api": api_type,
            "reasoning": False,
            "input": (["text", "image"] if (is_anthropic or is_cloud or is_vision) else ["text"]),
            "contextWindow": ctx,
            "maxTokens": max_out,
            "cost": _cost(),
        }
        if _is_cloud_key(key) and api_type == "anthropic-messages":
            # Pi's Anthropic client appends /v1/messages; OpenAI clients append
            # /chat/completions to a /v1 base. Keep provider base at /v1 for
            # OpenAI-shaped models but override Anthropic cloud models to the
            # gateway root to avoid /v1/v1/messages.
            model["baseUrl"] = gw
            # Gateway-translated anthropic streams don't support Pi's eager
            # tool-input streaming; disable it for proxied anthropic models.
            model.setdefault("compat", {})["supportsEagerToolInputStreaming"] = False
        _apply_reasoning(model, kind, meta)
        if kind == "gateway":
            model["reasoning"] = True
        if isinstance(hints.get("thinkingLevelMap"), dict):
            model["thinkingLevelMap"] = dict(hints["thinkingLevelMap"])
        if isinstance(hints.get("compat"), dict):
            model.setdefault("compat", {}).update(hints["compat"])
        if _is_cloud_key(key):
            cloud_models.append(model)
        else:
            local_models.append(model)

    return {
        "providers": {
            provider_name: {
                "baseUrl": gw + "/v1",
                "api": "openai-completions",
                "apiKey": gateway_api_key,
                "compat": dict(_DEFAULT_PROVIDER_COMPAT),
                "models": local_models + cloud_models,
            },
        }
    }


# --- Launcher rendering ------------------------------------------------------


def render_launchers(
    aliases: dict,
    *,
    provider_name: str = "ls99-models",
    gateway_url: str = "http://localhost:9111",
    gateway_api_key: str = "cloud",
    pi_agent_dir: str | None = None,
    ls99_extras: bool = False,
    aliases_path: str | None = None,
    models_out: str | None = None,
    launchers_out: str | None = None,
    shared_dir: str | None = None,
    omlx_status_path: str | None = None,
    omlx_status_url: str | None = None,
) -> str:
    """zsh snippet defining pi-<alias>() quick-start functions + pi-list + pi-restart.

    Optionally appends pi-default + pi-openai (ls99 opt-in layer). No
    claude-*/codex-* — standardize on pi. If output paths are given, also emits
    a ``pi-regen`` function that re-runs pi-catalog with the same args, so the
    launcher can refresh itself + models.json after a catalog change.
    """
    gw_host = gateway_url.rstrip("/").replace("https://", "").replace("http://", "")
    # Build the (alias, model_id, display) rows from the SAME eligibility rule
    # as render_models, so launcher ids and models.json ids can never disagree.
    rows: list[tuple[str, str, str, bool]] = []
    for key, meta in _eligible_entries(aliases):
        alias = str(meta["alias"])
        model_id = _model_id_for(key, meta)
        name = meta.get("name") or model_id
        rows.append((alias, model_id, str(name), _is_cloud_key(key)))
    rows.sort(key=lambda r: r[0])
    local_rows = [row for row in rows if not row[3]]
    cloud_rows = [row for row in rows if row[3]]

    # The pi invocation. If pi_agent_dir is set, wrap with env so the launcher
    # targets that Pi profile (e.g. the oMLX profile with its model list).
    if pi_agent_dir:
        launch_cmd = (
            f'env PI_CODING_AGENT_DIR={pi_agent_dir!r} '
            f'pi --provider "$pi_provider" --model "$model" "$@"'
        )
    else:
        launch_cmd = 'pi --provider "$pi_provider" --model "$model" "$@"'

    lines = [
        "# Generated by pi-shared/bin/pi-catalog — do not hand-edit.",
        "# Source from ~/.zshrc. Regenerated from model-aliases.json (the",
        "# model-gateway public catalog contract). No claude-*/codex-* — pi-* only.",
        "",
    ]
    # Run the shared repair script once at source time so the profile used by
    # generated pi-* launchers stays wired after Pi updates. This also applies
    # Pi's zero-usage context fallback to the installed runtime; use ~/.pi/agent
    # when no dedicated profile was requested because that is what the launcher
    # will use.
    repair_agent_dir_expr = repr(pi_agent_dir) if pi_agent_dir else '"$HOME/.pi/agent"'
    lines += [
        f'if command -v pi-omlx-repair >/dev/null 2>&1; then',
        f'  PI_OMLX_AGENT_DIR={repair_agent_dir_expr} pi-omlx-repair >/dev/null 2>&1 || true',
        f'fi',
        "",
    ]
    lines += [
        "_pi_gw_launch() {",
        "  local pi_provider=\"$1\" model=\"$2\" alias_name=\"$3\"; shift 3",
        f'  if ! curl -sf --max-time 2 {gateway_url}/health >/dev/null 2>&1; then',
        f'    echo "WARNING: model-gateway not healthy on {gw_host} — try: pi-restart model-gw"',
        "  fi",
        '  echo "Pi → model-gateway (${alias_name} → ${model})"',
        f"  {launch_cmd}",
        "}",
        "",
    ]
    for alias, model_id, _name, _is_cloud in rows:
        lines.append(
            f"pi-{alias}() {{ _pi_gw_launch {provider_name!r} {model_id!r} {alias!r} \"$@\"; }}"
        )

    lines += [
        "",
        "pi-list() {",
        '  echo "Pi quick-start commands:"',
    ]
    width = max((len(alias) for alias, *_ in rows), default=8) + 3
    for title, section_rows in (("Local models", local_rows), ("Cloud models", cloud_rows)):
        if not section_rows:
            continue
        lines += [
            '  echo ""',
            f'  echo "{title} (via {provider_name} → {gw_host}):"',
        ]
        for alias, model_id, name, _is_cloud in section_rows:
            lines.append(f'  printf "  %-{width}s %s\\n" "pi-{alias}" {name + " (" + model_id + ")"!r}')
    if ls99_extras:
        lines += [
            '  echo ""',
            '  echo "Direct Pi:"',
            '  echo "  pi-default                     Pi default provider/model"',
            '  echo "  pi-openai                      OpenAI subscription (ChatGPT Plus/Pro via /login OAuth)"',
        ]
    lines += [
        '  echo ""',
        '  echo "Management:"',
        '  echo "  pi-restart [service]           restart gateway/oMLX/services (default: model-gw)"',
    ]
    if models_out or launchers_out:
        lines += ['  echo "  pi-regen                       regenerate this launcher + models.json from the alias catalog"']
    if launchers_out and shared_dir:
        lines += ['  echo "  pi-shared-update               pull pi-shared, regenerate artifacts, and reload this shell"']
    lines += ['}', ""]

    # pi-regen: re-run pi-catalog with the same args used to generate this file.
    if models_out or launchers_out:
        lines += _render_pi_regen(
            aliases_path=aliases_path,
            models_out=models_out,
            launchers_out=launchers_out,
            provider_name=provider_name,
            gateway_url=gateway_url,
            gateway_api_key=gateway_api_key,
            pi_agent_dir=pi_agent_dir,
            ls99_extras=ls99_extras,
            shared_dir=shared_dir,
            omlx_status_path=omlx_status_path,
            omlx_status_url=omlx_status_url,
        )
    if launchers_out and shared_dir:
        lines += _render_pi_shared_update(launchers_out=launchers_out, shared_dir=shared_dir)

    lines += _render_pi_restart(
        auto_regen=bool(models_out or launchers_out),
        aliases_path=aliases_path,
    )
    if ls99_extras:
        lines += ["", _render_pi_default(), "", _render_pi_openai()]

    return "\n".join(lines) + "\n"


def _render_pi_regen(*, aliases_path, models_out, launchers_out, provider_name, gateway_url, gateway_api_key, pi_agent_dir, ls99_extras, shared_dir, omlx_status_path, omlx_status_url) -> list[str]:
    # Build the pi-catalog invocation that reproduces this launcher. Bakes the
    # machine-specific paths so `pi-regen` refreshes both outputs in one call.
    import shlex
    catalog_bin = str(Path(shared_dir) / "bin" / "pi-catalog") if shared_dir else "pi-catalog"
    cmd = [catalog_bin]
    if aliases_path:
        cmd += ["--aliases", aliases_path]
    if models_out:
        cmd += ["--models-out", models_out]
    if launchers_out:
        cmd += ["--launchers-out", launchers_out]
    cmd += ["--provider-name", provider_name, "--gateway-url", gateway_url, "--gateway-api-key", gateway_api_key]
    if pi_agent_dir:
        cmd += ["--pi-agent-dir", pi_agent_dir]
    if omlx_status_path:
        cmd += ["--omlx-status", omlx_status_path]
    if omlx_status_url:
        cmd += ["--omlx-status-url", omlx_status_url]
    if ls99_extras:
        cmd += ["--ls99-extras"]
    if shared_dir:
        cmd += ["--shared-dir", shared_dir]
    cmd_str = " ".join(shlex.quote(c) for c in cmd)
    return [
        "pi-regen() {",
        "  # Regenerate this launcher + models.json from the alias catalog.",
        "  # (model-gateway writes the alias file; pi-catalog renders Pi artifacts.)",
        f'  echo "Regenerating Pi artifacts from {aliases_path or "the alias catalog"}..."',
        f"  {cmd_str} \"$@\"",
        "}",
        "",
    ]


def _render_pi_shared_update(*, launchers_out: str, shared_dir: str) -> list[str]:
    """Render an in-shell updater bound to the generating pi-shared checkout.

    This must be a shell function—not a standalone script or Git hook—because
    only the current shell can load the regenerated launcher definitions.
    """
    import shlex

    launcher = shlex.quote(launchers_out)
    repo = shlex.quote(shared_dir)
    catalog = shlex.quote(str(Path(shared_dir) / "bin" / "pi-catalog"))
    return [
        "pi-shared-update() {",
        f"  local repo_dir={repo} catalog_bin={catalog} dirty actual_repo",
        '  actual_repo="$(git -C "$repo_dir" rev-parse --show-toplevel 2>/dev/null)"',
        '  if [ -z "$actual_repo" ] || [ "$actual_repo" != "$repo_dir" ] || [ ! -x "$catalog_bin" ]; then',
        '    echo "ERROR: configured pi-shared checkout is invalid: $repo_dir" >&2',
        "    return 1",
        "  fi",
        '  if ! git -C "$repo_dir" symbolic-ref -q HEAD >/dev/null; then',
        '    echo "ERROR: pi-shared checkout has a detached HEAD: $repo_dir" >&2',
        "    return 1",
        "  fi",
        '  if ! git -C "$repo_dir" rev-parse --abbrev-ref "@{upstream}" >/dev/null 2>&1; then',
        '    echo "ERROR: pi-shared branch has no upstream: $repo_dir" >&2',
        "    return 1",
        "  fi",
        '  dirty="$(git -C "$repo_dir" status --porcelain --untracked-files=all)" || return 1',
        '  if [ -n "$dirty" ]; then',
        '    echo "ERROR: pi-shared checkout is dirty; commit, stash, or discard changes first: $repo_dir" >&2',
        "    return 1",
        "  fi",
        '  echo "Updating pi-shared in $repo_dir..."',
        '  if ! git -C "$repo_dir" pull --ff-only; then',
        '    echo "ERROR: pi-shared pull failed; artifacts were not regenerated." >&2',
        "    return 1",
        "  fi",
        '  if ! pi-regen "$@"; then',
        '    echo "ERROR: pi-shared updated, but artifact regeneration failed." >&2',
        "    return 1",
        "  fi",
        f"  if ! zsh -n {launcher}; then",
        '    echo "ERROR: regenerated Pi launcher failed zsh syntax validation." >&2',
        "    return 1",
        "  fi",
        f"  if ! source {launcher}; then",
        '    echo "ERROR: regenerated Pi launcher could not be loaded into this shell." >&2',
        "    return 1",
        "  fi",
        '  echo "pi-shared updated; Pi artifacts regenerated and shell launchers reloaded."',
        '  echo "Run /reload in any open Pi sessions."',
        "}",
        "",
    ]


def _render_pi_restart(*, auto_regen: bool = False, aliases_path: str | None = None) -> list[str]:
    """pi-restart() — restart model-gateway portably, with server-ci fallback.

    `model-gateway restart` is the portable repo-owned restart surface. ls99's
    `server-ci restart --model-gw` remains as a fallback so older/dev-server
    installs keep working. If auto_regen is set, a successful model-gw restart
    also runs `pi-regen` so launcher + models.json stay in sync with the
    freshly-regenerated alias catalog.
    """
    out = [
        "pi-restart() {",
        "  # Restart model-gateway via its portable CLI when available; fall",
        "  # back to ls99's server-ci for legacy/dev-server services.",
        '  local svc="${1:-model-gw}"',
        '  if [ "$svc" = "-h" ] || [ "$svc" = "--help" ]; then',
        '    echo "Usage: pi-restart [service]   (default: model-gw)"',
        '    echo ""',
        "    echo 'For model-gw, calls model-gateway restart when available.'",
        "    echo 'Falls back to server-ci restart --<service> for legacy services.'",
        '    echo "  model-gw  Model gateway (port 9111)  [default]"',
        '    echo "  omlx      oMLX inference server (port 9110; server-ci only)"',
        '    echo "  all       All server-ci services"',
        '    echo "  status    Show gateway/server-ci status (no restart)"',
        "    return 0",
        "  fi",
        '  if [ "$svc" = "status" ]; then',
        "    if command -v model-gateway >/dev/null 2>&1; then",
        "      model-gateway status",
        "    elif command -v server-ci >/dev/null 2>&1; then",
        "      server-ci restart --status",
        "    else",
        '      echo "Error: neither model-gateway nor server-ci found on PATH" >&2',
        "      return 1",
        "    fi",
        "    return $?",
        "  fi",
        "  local rc=0",
        '  if [ "$svc" = "model-gw" ] && command -v model-gateway >/dev/null 2>&1; then',
        "    model-gateway restart",
        "    rc=$?",
        "    if [ $rc -ne 0 ] && command -v server-ci >/dev/null 2>&1; then",
        '      echo "model-gateway restart failed; falling back to server-ci restart --model-gw" >&2',
        "      server-ci restart --model-gw",
        "      rc=$?",
        "    fi",
        "  else",
        '    if ! command -v server-ci >/dev/null 2>&1; then',
        '      echo "Error: model-gateway not found for model-gw and server-ci not found for fallback" >&2',
        "      return 1",
        "    fi",
        '    server-ci restart --"$svc"',
        "    rc=$?",
        "  fi",
        '  if [ $rc -eq 0 ] && [ "$svc" != "all" ] && [ "$svc" != "status" ]; then',
        "    # Poll until the service port reports UP (or ~25s elapse).",
        '    local port=""',
        '    case "$svc" in',
        "      model-gw) port=9111 ;;",
        "      omlx) port=9110 ;;",
        "    esac",
        '    if [ -n "$port" ]; then',
        "      local elapsed=0 line=\"\"",
        "      while [ $elapsed -lt 25 ]; do",
        '        if [ "$svc" = "model-gw" ]; then',
        '          if curl -fsS --max-time 3 "http://127.0.0.1:$port/health" 2>/dev/null | grep -q "\\\"status\\\""; then',
        '            line="  $port ($svc): UP"',
        "            break",
        "          fi",
        '        elif command -v server-ci >/dev/null 2>&1; then',
        '          line=$(server-ci restart --status 2>/dev/null | grep -E "^[[:space:]]*$port " | head -1)',
        '          if echo "$line" | grep -qi "UP"; then',
        "            break",
        "          fi",
        "        fi",
        "        sleep 2",
        "        elapsed=$((elapsed + 2))",
        "      done",
        '      echo ""',
        '      if [ -n "$line" ]; then',
        "        echo \"$line\"",
        "      else",
        '        echo "  $port ($svc): status unknown"',
        "      fi",
        '      if [ $elapsed -ge 25 ]; then',
        '        echo "WARNING: $svc did not report UP within 25s"',
        "      fi",
        "    fi",
        "  fi",
        "  if [ $rc -eq 0 ] && [ \"$svc\" = model-gw ] && command -v pi-regen >/dev/null 2>&1; then",
        "    # model-gw restart regenerated the alias catalog; refresh Pi artifacts.",
        "    # Wait briefly for the alias file mtime to advance so we don't render",
        "    # from a stale file (the port-poll confirms the server is up, not that",
        "    # exports finished).",
    ]
    if aliases_path:
        out += [
            f'    _af={aliases_path!r}',
            '    if [ -f "$_af" ]; then',
            '      _pre=$(stat -f %m "$_af" 2>/dev/null || echo 0)',
            '      _w=0',
            '      while [ $_w -lt 10 ]; do',
            '        _post=$(stat -f %m "$_af" 2>/dev/null || echo 0)',
            '        [ "$_post" != "$_pre" ] && break',
            '        sleep 1; _w=$((_w + 1))',
            '      done',
            '    fi',
        ]
    out += [
        "    pi-regen --quiet 2>/dev/null || true",
        "  fi",
        "  return $rc",
        "}",
        "",
    ]
    return out


def _render_pi_default() -> str:
    # pi-default uses Pi's OWN default profile (unset PI_CODING_AGENT_DIR) so
    # whatever Pi considers its default provider/model is used.
    return (
        "pi-default() {\n"
        '  echo "Pi → default provider/model from Pi settings"\n'
        "  env -u PI_CODING_AGENT_DIR pi \"$@\"\n"
        "}"
    )


def _render_pi_openai() -> str:
    # pi-openai uses Pi's OWN default profile + the openai-codex subscription
    # provider (ChatGPT Plus/Pro /login OAuth), with any API-key env unset so
    # the subscription auth path is used.
    return (
        "pi-openai() {\n"
        '  echo "Pi → OpenAI subscription (ChatGPT Plus/Pro via /login OAuth)"\n'
        "  env -u PI_CODING_AGENT_DIR -u OPENAI_API_KEY -u OPENAI_BASE_URL \\\n"
        '    pi --provider openai-codex "$@"\n'
        "}"
    )


# --- IO / CLI ---------------------------------------------------------------

def _resolve_write_target(path: Path) -> Path:
    """Resolve symlinks so we write THROUGH the link, not replace it.

    models.json may be a symlink (e.g. ~/.pi/agent/models.json -> a shared
    file); a naive tmp.replace(path) would replace the symlink itself.
    """
    if path.is_symlink() or path.exists():
        try:
            return path.resolve()
        except OSError:
            return path
    return path


def _dump(data: dict) -> str:
    return json.dumps(data, indent=2) + "\n"


def _check_one(path: Path, rendered: str, label: str) -> bool:
    target = _resolve_write_target(path)
    current = target.read_text() if target.exists() else ""
    if current == rendered:
        return True
    diff = difflib.unified_diff(
        current.splitlines(keepends=True),
        rendered.splitlines(keepends=True),
        fromfile=f"{label} (on disk)",
        tofile=f"{label} (rendered)",
    )
    sys.stderr.write("".join(list(diff)[:60]))
    return False


def _load_omlx_status(path: Path | None, url: str | None) -> dict:
    """Load oMLX /v1/models/status JSON (file or URL) into an id->model map."""
    import urllib.request
    raw = None
    if path:
        if not path.exists():
            return {}
        raw = path.read_text()
    elif url:
        try:
            req = urllib.request.Request(url, headers={"Authorization": "Bearer omlx"})
            with urllib.request.urlopen(req, timeout=3) as r:  # noqa: S310 — local endpoint
                raw = r.read().decode()
        except OSError:
            return {}
    if not raw:
        return {}
    try:
        return {m["id"]: m for m in json.loads(raw).get("models", []) if "id" in m}
    except Exception:
        return {}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--aliases", type=Path, required=True, help="path to model-aliases.json (gateway catalog contract)")
    parser.add_argument("--models-out", type=Path, default=None, help="write Pi models.json here")
    parser.add_argument("--launchers-out", type=Path, default=None, help="write pi-launchers.zsh here")
    parser.add_argument("--provider-name", default="ls99-models", help="Pi provider name in models.json (default: ls99-models)")
    parser.add_argument("--gateway-url", default="http://localhost:9111", help="endpoint Pi providers point at")
    parser.add_argument("--gateway-api-key", default="cloud", help="apiKey for the Pi provider")
    parser.add_argument("--pi-agent-dir", default=None, help="PI_CODING_AGENT_DIR the launcher sets (default: none = default profile)")
    parser.add_argument("--shared-dir", type=Path, default=Path(__file__).resolve().parents[1], help="pi-shared checkout used by pi-shared-update (default: this renderer's checkout)")
    parser.add_argument("--omlx-status", type=Path, default=None, help="optional oMLX /v1/models/status JSON file for thinking_default fallback")
    parser.add_argument("--omlx-status-url", default=None, help="optional oMLX status URL (default: http://localhost:9110/v1/models/status when --omlx-status not given)")
    parser.add_argument("--ls99-extras", action="store_true", help="include pi-default + pi-openai (ls99 opt-in layer)")
    parser.add_argument("--check", action="store_true", help="drift check only; exit 1 when stale")
    parser.add_argument("--quiet", action="store_true", help="suppress per-file write messages (used by pi-regen)")
    args = parser.parse_args(argv)

    if not args.aliases.exists():
        sys.exit(f"pi-catalog: aliases file not found: {args.aliases}")
    if not args.models_out and not args.launchers_out:
        sys.exit("pi-catalog: nothing to do (pass --models-out and/or --launchers-out)")

    aliases = json.loads(args.aliases.read_text())
    if not aliases:
        sys.exit("pi-catalog: refusing to render an empty catalog (alias file has no entries)")

    # omlx_status is optional; only fetch if it could matter (local models present).
    has_local = any(not _is_cloud_key(k) for k in aliases)
    omlx_status_path = args.omlx_status.expanduser().resolve() if args.omlx_status else None
    omlx_status: dict = {}
    if has_local:
        if omlx_status_path:
            omlx_status = _load_omlx_status(omlx_status_path, None)
        elif args.omlx_status_url:
            omlx_status = _load_omlx_status(None, args.omlx_status_url)
        else:
            omlx_status = _load_omlx_status(None, "http://localhost:9110/v1/models/status")

    pi_agent_dir = str(Path(args.pi_agent_dir).expanduser().resolve()) if args.pi_agent_dir else None
    shared_dir = str(args.shared_dir.expanduser().resolve())

    renders: list[tuple[Path, str, str]] = []
    if args.models_out:
        models = render_models(
            aliases,
            provider_name=args.provider_name,
            gateway_url=args.gateway_url,
            gateway_api_key=args.gateway_api_key,
            omlx_status=omlx_status,
        )
        renders.append((args.models_out, _dump(models), "pi models.json"))
    if args.launchers_out:
        launchers = render_launchers(
            aliases,
            provider_name=args.provider_name,
            gateway_url=args.gateway_url,
            gateway_api_key=args.gateway_api_key,
            pi_agent_dir=pi_agent_dir,
            ls99_extras=args.ls99_extras,
            aliases_path=str(args.aliases.expanduser().resolve()),
            models_out=str(args.models_out.expanduser().resolve()) if args.models_out else None,
            launchers_out=str(args.launchers_out.expanduser().resolve()) if args.launchers_out else None,
            shared_dir=shared_dir,
            omlx_status_path=str(omlx_status_path) if omlx_status_path else None,
            omlx_status_url=args.omlx_status_url,
        )
        renders.append((args.launchers_out, launchers, "pi-launchers.zsh"))

    if args.check:
        ok = all(_check_one(path, content, label) for path, content, label in renders)
        if not ok:
            print("pi-catalog: DRIFT — regenerate with pi-catalog", file=sys.stderr)
            return 1
        print(f"pi-catalog: in sync ({len(aliases)} aliases, {len(renders)} outputs)")
        return 0

    for path, content, label in renders:
        target = _resolve_write_target(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(f"{target.suffix}.tmp.{os.getpid()}")
        tmp.write_text(content)
        tmp.replace(target)
        if not args.quiet:
            shown = path if path == target else f"{path} → {target}"
            print(f"pi-catalog: wrote {label} → {shown}")
    if not args.quiet:
        print(f"pi-catalog: {len(aliases)} aliases rendered")
    return 0


if __name__ == "__main__":
    sys.exit(main())
