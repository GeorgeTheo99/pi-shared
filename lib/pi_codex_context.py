"""Install reviewed Codex subscription context ceilings without replacing user choices.

These are the max_context_window values in OpenAI Codex's bundled model catalog
(codex-rs/models-manager/models.json), not OpenAI API context limits. Refresh
this allowlist only after checking the Codex-specific catalog on a new release.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import stat
import sys

from pi_cli import atomic_write, dump, read_owned


CODEX_MAX_CONTEXT = {
    "gpt-5.6-luna": 872000,
    "gpt-5.6-sol": 872000,
    "gpt-5.6-terra": 872000,
    "gpt-6-astra": 872000,
    "gpt-6-luna": 872000,
    "gpt-6-sol": 872000,
}


def configure(path: Path, *, check: bool = False) -> int:
    """Fill only absent Codex context overrides; do not touch other providers."""
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
    codex = providers.get("openai-codex", {})
    if not isinstance(codex, dict):
        raise ValueError(f"Expected openai-codex provider object: {path}")
    overrides = codex.get("modelOverrides", {})
    if not isinstance(overrides, dict):
        raise ValueError(f"Expected modelOverrides object: {path}")
    for model, value in overrides.items():
        if model in CODEX_MAX_CONTEXT and not isinstance(value, dict):
            raise ValueError(f"Expected {model} override object: {path}")
    missing = [model for model in CODEX_MAX_CONTEXT
               if "contextWindow" not in overrides.get(model, {})]
    if missing and not check:
        config = dict(config)
        providers = dict(providers)
        codex = dict(codex)
        overrides = {**overrides}
        for model in missing:
            overrides[model] = {**overrides.get(model, {}), "contextWindow": CODEX_MAX_CONTEXT[model]}
        codex["modelOverrides"] = overrides
        providers["openai-codex"] = codex
        config["providers"] = providers
        atomic_write(path, dump(config))
    return len(missing)


if __name__ == "__main__":
    if len(sys.argv) not in (2, 3) or (len(sys.argv) == 3 and sys.argv[2] != "--check"):
        raise SystemExit("Usage: pi_codex_context.py <native-profile-models.json> [--check]")
    try:
        count = configure(Path(sys.argv[1]).expanduser(), check=len(sys.argv) == 3)
    except (OSError, ValueError) as exc:
        raise SystemExit(f"Codex context policy: {exc}")
    print(f"Codex context overrides: {count} {'missing' if len(sys.argv) == 3 else 'added'}")
