"""Install reviewed ChatGPT subscription context ceilings without replacing user choices.

These are the max_context_window values in OpenAI Codex's bundled model catalog
(codex-rs/models-manager/models.json), which the Sign in with ChatGPT model
list (GET /v1/models with the subscription token) also reports; they are not
API-key context limits. They apply to the `openai` provider, which the openai
shortcut signs in to with Sign in with ChatGPT, and to the legacy `openai-codex`
provider. Refresh this allowlist only after checking those catalogs on a new
release.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import stat
import sys

from pi_cli import atomic_write, dump, read_owned


CODEX_STANDARD_CONTEXT = 272000
SUBSCRIPTION_PROVIDERS = ("openai", "openai-codex")
CODEX_MAX_CONTEXT = {
    "gpt-5.6-luna": 872000,
    "gpt-5.6-sol": 872000,
    "gpt-5.6-terra": 872000,
    "gpt-6-astra": 872000,
    "gpt-6-luna": 872000,
    "gpt-6-sol": 872000,
}


def configure(path: Path, *, check: bool = False, mode: str | None = None) -> int:
    """Fill absent subscription ceilings, or explicitly set all reviewed subscription contexts."""
    if mode not in (None, "standard", "max") or (check and mode is not None):
        raise ValueError("Codex context mode must be standard or max")
    if path.is_symlink():
        raise ValueError(f"Refusing symlinked native model config: {path}")
    ancestor = path.resolve().parent
    while not ancestor.exists():
        ancestor = ancestor.parent
    info = ancestor.stat()
    if info.st_uid != os.getuid() or info.st_mode & 0o022 or not stat.S_ISDIR(info.st_mode):
        raise ValueError(f"Unsafe native model config directory: {ancestor}")
    raw = read_owned(path, missing=True)
    config = json.loads(raw) if raw else {}
    if not isinstance(config, dict):
        raise ValueError(f"Expected a model config object: {path}")
    providers = config.get("providers", {})
    if not isinstance(providers, dict):
        raise ValueError(f"Expected providers object: {path}")
    targets = ({model: CODEX_STANDARD_CONTEXT for model in CODEX_MAX_CONTEXT}
               if mode == "standard" else CODEX_MAX_CONTEXT)
    legacy = providers.get("openai-codex", {})
    legacy = legacy.get("modelOverrides", {}) if isinstance(legacy, dict) else {}
    changes = {}
    for provider in SUBSCRIPTION_PROVIDERS:
        if mode is None and provider == "openai" and isinstance(legacy, dict):
            # Moving to Sign in with ChatGPT keeps the context the owner chose for openai-codex.
            inherited = {model: value.get("contextWindow") for model, value in legacy.items()
                         if model in CODEX_MAX_CONTEXT and isinstance(value, dict)
                         and value.get("contextWindow") in (CODEX_STANDARD_CONTEXT, CODEX_MAX_CONTEXT[model])}
            provider_targets = {**targets, **inherited}
        else:
            provider_targets = targets
        entry = providers.get(provider, {})
        if not isinstance(entry, dict):
            raise ValueError(f"Expected {provider} provider object: {path}")
        overrides = entry.get("modelOverrides", {})
        if not isinstance(overrides, dict):
            raise ValueError(f"Expected {provider} modelOverrides object: {path}")
        for model, value in overrides.items():
            if model in CODEX_MAX_CONTEXT and not isinstance(value, dict):
                raise ValueError(f"Expected {provider} {model} override object: {path}")
        if mode is None:
            missing = [model for model in provider_targets if "contextWindow" not in overrides.get(model, {})]
        else:
            missing = [model for model, size in provider_targets.items()
                       if overrides.get(model, {}).get("contextWindow") != size]
        if missing:
            changes[provider] = (entry, overrides, missing, provider_targets)
    if changes and not check:
        config = dict(config)
        providers = dict(providers)
        for provider, (entry, overrides, missing, provider_targets) in changes.items():
            overrides = {**overrides}
            for model in missing:
                overrides[model] = {**overrides.get(model, {}), "contextWindow": provider_targets[model]}
            providers[provider] = {**entry, "modelOverrides": overrides}
        config["providers"] = providers
        atomic_write(path, dump(config))
    return sum(len(change[2]) for change in changes.values())


if __name__ == "__main__":
    if len(sys.argv) not in (2, 3) or (len(sys.argv) == 3 and sys.argv[2] != "--check"):
        raise SystemExit("Usage: pi_codex_context.py <native-profile-models.json> [--check]")
    try:
        count = configure(Path(sys.argv[1]).expanduser(), check=len(sys.argv) == 3)
    except (OSError, ValueError) as exc:
        raise SystemExit(f"Codex context policy: {exc}")
    print(f"Codex context overrides: {count} {'missing' if len(sys.argv) == 3 else 'added'}")
