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
                --launchers-out ~/local_code/model-gateway-runtime/pi-launchers.zsh \\
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
    "maxTokensField": "max_tokens",
}


def _norm_provider(meta: dict) -> str:
    return (meta.get("provider") or "local").strip().lower()


def _is_qwen_family(key: str, meta: dict) -> bool:
    haystack = " ".join(str(meta.get(k, "")) for k in ("alias", "name", "omlx_id", "provider_model_id"))
    return "qwen" in f"{key} {haystack}".lower()


def _is_local_key(key: str, meta: dict) -> bool:
    return not key.startswith("cloud:") and _norm_provider(meta) in {"local", "omlx", "mlx"}


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

    if provider in ANTHROPIC_PROVIDERS:
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

    if provider == "openai" and thinking in THINKING_VALUES:
        # GPT-5.x rejects some reasoning+tools shapes on Chat Completions.
        return "openai-responses"

    return ""


def _api_type_for(kind: str, provider: str) -> str:
    if provider in ANTHROPIC_PROVIDERS or kind == "fireworks-messages":
        return "anthropic-messages"
    if kind == "openai-responses":
        return "openai-responses"
    return "openai-completions"


def _apply_reasoning(model: dict, kind: str, meta: dict) -> None:
    if not kind:
        return
    model["reasoning"] = True
    thinking = meta.get("thinking") or ""
    level_map: dict = {}
    if thinking == "always":
        level_map["off"] = None

    if kind == "local-qwen":
        # Boolean chat_template_kwargs.enable_thinking toggle, not graded effort.
        # Expose "high" as the on state; other levels collapse to it.
        model["compat"] = {"thinkingFormat": "qwen-chat-template"}
        level_map.update({"minimal": None, "low": None, "medium": None, "xhigh": None})
    elif kind == "local-glm":
        # GLM-5.2 template supports graded reasoning_effort (high/max) via
        # chat_template_kwargs. Carry both enable_thinking and reasoning_effort.
        model["compat"] = {
            "thinkingFormat": "chat-template",
            "chatTemplateKwargs": {
                "enable_thinking": {"$var": "thinking.enabled"},
                "preserve_thinking": True,
                "reasoning_effort": {"$var": "thinking.effort", "omitWhenOff": True},
            },
        }
        level_map.update({"minimal": "high", "low": "high", "medium": "high", "high": "high", "xhigh": "max"})
    elif kind == "local-deepseek-v4-dsml":
        model["compat"] = {"thinkingFormat": "qwen-chat-template", "stripDsmlToolMarkup": True}
        level_map.update({"minimal": None, "low": None, "medium": None, "xhigh": None})
    elif kind == "zai":
        model["compat"] = {"supportsDeveloperRole": False, "thinkingFormat": "zai"}
        level_map.update({"minimal": "high", "low": "high", "medium": "high", "high": "high", "xhigh": "max"})
    elif kind == "openrouter":
        model["compat"] = {"thinkingFormat": "openrouter"}
        if str(meta.get("provider_model_id", "")).startswith("deepseek/"):
            model["compat"]["requiresReasoningContentOnAssistantMessages"] = True
            level_map.update({"minimal": None, "low": None, "medium": None, "high": "high", "xhigh": "max"})

    if level_map:
        model["thinkingLevelMap"] = level_map


def _cost() -> dict:
    return {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}


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
    seen_local: set[str] = set()
    seen_cloud: set[str] = set()

    for key, alias_meta in aliases.items():
        meta = dict(alias_meta)
        alias = meta.get("alias")
        if not alias or meta.get("supported") is False:
            continue
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
        if provider == "gguf":
            continue
        kind = _reasoning_kind(key, meta, status)
        api_type = _api_type_for(kind, provider)
        is_anthropic = provider in ANTHROPIC_PROVIDERS
        is_cloud = provider not in {"local", "omlx", "mlx", "gguf"}
        # Cloud models route through the gateway, which handles vision fallback
        # for text-only models (reroute to gemini). So mark every cloud model
        # image-capable. Local VL models get image input via vision flag or a
        # VL/gemma name heuristic (model-info vision flag is incomplete); local
        # text-only models stay text-only (no cloud reroute available).
        _hay = " ".join(
            str(meta.get(k, ""))
            for k in ("alias", "name", "omlx_id", "provider_model_id", "desc")
        ).lower()
        is_vision = bool(meta.get("vision")) or "vl" in _hay or "gemma" in _hay
        desc = meta.get("desc") or key
        model: dict = {
            "id": key,
            "name": desc,
            "api": api_type,
            "reasoning": False,
            "input": (["text", "image"] if (is_anthropic or is_cloud or is_vision) else ["text"]),
            "contextWindow": ctx,
            "maxTokens": max_out,
            "cost": _cost(),
        }
        if key.startswith("cloud:") and api_type == "anthropic-messages":
            # Pi's Anthropic client appends /v1/messages; OpenAI clients append
            # /chat/completions to a /v1 base. Keep provider base at /v1 for
            # OpenAI-shaped models but override Anthropic cloud models to the
            # gateway root to avoid /v1/v1/messages.
            model["baseUrl"] = gw
        _apply_reasoning(model, kind, meta)
        if key.startswith("cloud:"):
            provider_model = meta.get("provider_model_id")
            if not provider_model or provider_model in seen_cloud:
                continue
            model["id"] = provider_model
            seen_cloud.add(provider_model)
            cloud_models.append(model)
        else:
            if key in seen_local:
                continue
            seen_local.add(key)
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

def _launcher_model_id(key: str, meta: dict) -> str:
    """The model id passed to `pi --model`. Matches render_models exactly."""
    if key.startswith("cloud:"):
        return meta.get("provider_model_id") or key
    return key  # local: alias key == omlx_id


def render_launchers(
    aliases: dict,
    *,
    provider_name: str = "ls99-models",
    gateway_url: str = "http://localhost:9111",
    pi_agent_dir: str | None = None,
    ls99_extras: bool = False,
) -> str:
    """zsh snippet defining pi-<alias>() quick-start functions + pi-list + pi-restart.

    Optionally appends pi-default + pi-openai (ls99 opt-in layer). No
    claude-*/codex-* — standardize on pi.
    """
    gw_host = gateway_url.rstrip("/").replace("https://", "").replace("http://", "")
    # Build the (alias, model_id, display) rows, sorted for stable output.
    rows: list[tuple[str, str, str]] = []
    for key, meta in aliases.items():
        alias = meta.get("alias")
        if not alias or meta.get("supported") is False:
            continue
        model_id = _launcher_model_id(key, meta)
        name = meta.get("name") or model_id
        rows.append((str(alias), model_id, str(name)))
    rows.sort(key=lambda r: r[0])

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
    for alias, model_id, _name in rows:
        lines.append(
            f"pi-{alias}() {{ _pi_gw_launch {provider_name!r} {model_id!r} {alias!r} \"$@\"; }}"
        )

    lines += [
        "",
        "pi-list() {",
        f'  echo "Pi quick-start commands (via {provider_name} → {gw_host}):"',
    ]
    width = max((len(a) for a, *_ in rows), default=8) + 3
    for alias, model_id, name in rows:
        lines.append(f'  printf "  %-{width}s %s\\n" "pi-{alias}" {name + " (" + model_id + ")"!r}')
    lines += [
        '  echo ""',
        '  echo "  pi-restart [service]           restart gateway/oMLX/services (default: model-gw)"',
    ]
    if ls99_extras:
        lines += [
            '  echo "  pi-default                     Pi default provider/model"',
            '  echo "  pi-openai                      OpenAI subscription (ChatGPT Plus/Pro via /login OAuth)"',
        ]
    lines += ['}', ""]

    lines += _render_pi_restart()
    if ls99_extras:
        lines += ["", _render_pi_default(), "", _render_pi_openai()]

    return "\n".join(lines) + "\n"


def _render_pi_restart() -> list[str]:
    """pi-restart() — wraps `server-ci restart --<service>` and polls the port."""
    return [
        "pi-restart() {",
        "  # Restart model-gateway (and other services) via the canonical server-ci",
        "  # interface, which maps flags to launchd labels. Defaults to model-gw.",
        '  local svc="${1:-model-gw}"',
        '  if [ "$svc" = "-h" ] || [ "$svc" = "--help" ]; then',
        '    echo "Usage: pi-restart [service]   (default: model-gw)"',
        '    echo ""',
        r'    echo "Wraps `server-ci restart --<service>`. Common services:"',
        '    echo "  model-gw  Cloud LLM gateway (port 9111)  [default]"',
        '    echo "  omlx      oMLX inference server (port 9110)"',
        '    echo "  all       All services"',
        '    echo "  status    Show status of all services (no restart)"',
        '    echo "Full list: server-ci restart --help"',
        "    return 0",
        "  fi",
        '  if [ "$svc" = "status" ]; then',
        "    server-ci restart --status",
        "    return $?",
        "  fi",
        '  if ! command -v server-ci >/dev/null 2>&1; then',
        '    echo "Error: server-ci not found on PATH" >&2',
        "    return 1",
        "  fi",
        '  server-ci restart --"$svc"',
        "  local rc=$?",
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
        '        line=$(server-ci restart --status 2>/dev/null | grep -E "^[[:space:]]*$port " | head -1)',
        '        if echo "$line" | grep -qi "UP"; then',
        "          break",
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
        "  return $rc",
        "}",
        "",
    ]


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
    parser.add_argument("--omlx-status", type=Path, default=None, help="optional oMLX /v1/models/status JSON file for thinking_default fallback")
    parser.add_argument("--omlx-status-url", default=None, help="optional oMLX status URL (default: http://localhost:9110/v1/models/status when --omlx-status not given)")
    parser.add_argument("--ls99-extras", action="store_true", help="include pi-default + pi-openai (ls99 opt-in layer)")
    parser.add_argument("--check", action="store_true", help="drift check only; exit 1 when stale")
    args = parser.parse_args(argv)

    if not args.aliases.exists():
        sys.exit(f"pi-catalog: aliases file not found: {args.aliases}")
    if not args.models_out and not args.launchers_out:
        sys.exit("pi-catalog: nothing to do (pass --models-out and/or --launchers-out)")

    aliases = json.loads(args.aliases.read_text())
    if not aliases:
        sys.exit("pi-catalog: refusing to render an empty catalog (alias file has no entries)")

    # omlx_status is optional; only fetch if it could matter (local models present).
    has_local = any(not k.startswith("cloud:") for k in aliases)
    omlx_status: dict = {}
    if has_local:
        if args.omlx_status:
            omlx_status = _load_omlx_status(args.omlx_status, None)
        elif args.omlx_status_url:
            omlx_status = _load_omlx_status(None, args.omlx_status_url)
        else:
            omlx_status = _load_omlx_status(None, "http://localhost:9110/v1/models/status")

    pi_agent_dir = str(Path(args.pi_agent_dir).expanduser()) if args.pi_agent_dir else None

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
            pi_agent_dir=pi_agent_dir,
            ls99_extras=args.ls99_extras,
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
        shown = path if path == target else f"{path} → {target}"
        print(f"pi-catalog: wrote {label} → {shown}")
    print(f"pi-catalog: {len(aliases)} aliases rendered")
    return 0


if __name__ == "__main__":
    sys.exit(main())
