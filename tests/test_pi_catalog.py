"""Tests for pi-shared/lib/pi_catalog.py — Pi artifact renderer.

Covers: models.json reasoning/thinkingFormat/api_type/vision/baseUrl logic,
launcher id<->models.json id agreement, legacy launcher flag compatibility,
--check drift, symlink-safe writes, empty-catalog refusal.

Run:  cd ~/local_code/pi-shared && python3 -m pytest tests/ -q
"""

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

SHARED_ROOT = Path(__file__).resolve().parents[1]
MODULE = SHARED_ROOT / "lib" / "pi_catalog.py"


@pytest.fixture(autouse=True)
def isolate_operator_profile(tmp_path, monkeypatch):
    # Some tests execute generated launchers. Never let their repair helper
    # write the real HOME or patch the operator's installed Pi runtime.
    home = tmp_path / "operator-home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("PI_INSTALL_DIR", str(tmp_path / "pi-install"))
    for name in ("PI_OMLX_AGENT_DIR", "PI_SHARED_AGENT_DIR", "PI_SHARED_OMLX_AGENT_DIR", "PI_SHARED_BIN_DIR"):
        monkeypatch.delenv(name, raising=False)


def _run(*extra, env: dict | None = None) -> subprocess.CompletedProcess:
    e = dict(os.environ)
    e["PYTHONPATH"] = str(SHARED_ROOT / "lib") + (os.pathsep + e.get("PYTHONPATH", ""))
    if env:
        e.update(env)
    return subprocess.run(
        # Pin the legacy provider for these existing schema/compatibility tests.
        # test_pi_launcher_options.py covers the new portable defaults/migration.
        [sys.executable, str(MODULE), "--provider-name", "ls99-models", *extra],
        capture_output=True, text=True, env=e,
    )


def _load_aliases(tmp_path: Path, entries: dict) -> Path:
    p = tmp_path / "aliases.json"
    p.write_text(json.dumps(entries))
    return p


# --- models.json rendering --------------------------------------------------

def test_local_qwen_gets_qwen_chat_template(tmp_path):
    aliases = {
        "qwen3.6-27b-mlx": {
            "name": "qwen3.6-27b", "alias": "qwen36mlx", "desc": "local qwen",
            "provider": "local", "omlx_id": "qwen3.6-27b-mlx",
            "thinking": "always", "thinking_format": "qwen-chat-template",
            "context": 262144, "max_output_tokens": 32768, "vision": True,
        },
    }
    p = _load_aliases(tmp_path, aliases)
    r = _run("--aliases", str(p), "--models-out", str(tmp_path / "models.json"))
    assert r.returncode == 0, r.stderr
    models = json.loads((tmp_path / "models.json").read_text())
    prov = models["providers"]["ls99-models"]
    m = prov["models"][0]
    assert m["id"] == "qwen3.6-27b-mlx"  # local id == alias key
    assert m["api"] == "openai-completions"
    assert m["reasoning"] is True
    assert m["compat"] == {"thinkingFormat": "qwen-chat-template"}
    assert m["thinkingLevelMap"]["off"] is None  # thinking=always disables off
    # high is the default on-level (not remapped); minimal/low/medium/xhigh collapse to it
    assert m["thinkingLevelMap"]["minimal"] is None
    assert "high" not in m["thinkingLevelMap"]
    assert m["input"] == ["text", "image"]  # vision=True
    assert m["contextWindow"] == 262144


def test_explicit_false_vision_overrides_local_name_heuristic(tmp_path):
    aliases = {
        "Laguna-S-2.1-MLX-6bit": {
            "name": "laguna-s-2.1-6bit", "alias": "laguna",
            "desc": "text model via mlx-vlm", "provider": "local",
            "omlx_id": "Laguna-S-2.1-MLX-6bit", "vision": False,
        },
        "gemma-vl": {
            "name": "gemma-vl", "alias": "gemma", "provider": "local",
            "omlx_id": "gemma-vl",
        },
    }
    p = _load_aliases(tmp_path, aliases)
    r = _run("--aliases", str(p), "--models-out", str(tmp_path / "models.json"))
    assert r.returncode == 0, r.stderr
    models = json.loads((tmp_path / "models.json").read_text())["providers"]["ls99-models"]["models"]
    by_id = {m["id"]: m for m in models}
    assert by_id["Laguna-S-2.1-MLX-6bit"]["input"] == ["text"]
    assert by_id["gemma-vl"]["input"] == ["text", "image"]


def test_cloud_vision_capability_is_explicit_and_fails_closed_when_absent(tmp_path):
    aliases = {
        "cloud:text": {
            "name": "cloud-text", "alias": "cloudtext", "provider": "fireworks",
            "provider_model_id": "cloud-text", "vision": False,
        },
        "cloud:unknown": {
            "name": "cloud-vl-by-name", "alias": "cloudunknown", "provider": "anthropic",
            "provider_model_id": "cloud-unknown",
        },
        "cloud:vision": {
            "name": "cloud-vision", "alias": "cloudvision", "provider": "fireworks",
            "provider_model_id": "cloud-vision", "vision": True,
        },
    }
    p = _load_aliases(tmp_path, aliases)
    r = _run("--aliases", str(p), "--models-out", str(tmp_path / "models.json"))
    assert r.returncode == 0, r.stderr
    models = json.loads((tmp_path / "models.json").read_text())["providers"]["ls99-models"]["models"]
    by_id = {m["id"]: m for m in models}
    assert by_id["cloud-text"]["input"] == ["text"]
    assert by_id["cloud-unknown"]["input"] == ["text"]
    assert by_id["cloud-vision"]["input"] == ["text", "image"]


def test_explicit_gateway_assisted_image_input_is_preserved_and_labeled(tmp_path):
    aliases = {
        "text-local": {
            "name": "text-local", "alias": "textlocal", "provider": "local",
            "omlx_id": "text-local", "vision": False,
            "pi": {"image_input": "gateway-assisted"},
        },
        "cloud:text": {
            "name": "cloud-text", "alias": "cloudtext", "provider": "fireworks",
            "provider_model_id": "cloud-text", "vision": False,
            "pi": {"image_input": "gateway-assisted"},
        },
        "disabled-local": {
            "name": "disabled-local", "alias": "disabledlocal", "provider": "local",
            "omlx_id": "disabled-local", "vision": False,
            "pi": {"image_input": "disabled"},
        },
    }
    p = _load_aliases(tmp_path, aliases)
    r = _run(
        "--aliases", str(p),
        "--models-out", str(tmp_path / "models.json"),
        "--launchers-out", str(tmp_path / "launchers.zsh"),
    )
    assert r.returncode == 0, r.stderr
    models = json.loads((tmp_path / "models.json").read_text())["providers"]["ls99-models"]["models"]
    by_id = {model["id"]: model for model in models}
    assert by_id["text-local"]["input"] == ["text", "image"]
    assert by_id["cloud-text"]["input"] == ["text", "image"]
    assert by_id["disabled-local"]["input"] == ["text"]
    assert by_id["text-local"]["name"].endswith("· assisted vision")
    assert by_id["cloud-text"]["name"].endswith("· assisted vision")
    assert not by_id["disabled-local"]["name"].endswith("· assisted vision")
    launchers = (tmp_path / "launchers.zsh").read_text()
    assert "[assisted vision]" in launchers
    assert "disabled-local (disabled-local) [text-only]" in launchers


@pytest.mark.parametrize(
    "entry",
    [
        {"vision": False, "pi": {"image_input": "implicit"}},
        {"vision": True, "pi": {"image_input": "gateway-assisted"}},
    ],
)
def test_invalid_assisted_image_contract_fails_closed(tmp_path, entry):
    aliases = {
        "model": {
            "name": "model", "alias": "model", "provider": "local",
            "omlx_id": "model", **entry,
        },
    }
    p = _load_aliases(tmp_path, aliases)
    r = _run("--aliases", str(p), "--models-out", str(tmp_path / "models.json"))
    assert r.returncode != 0
    assert "image" in r.stderr.lower()


def test_local_glm_gets_graded_reasoning(tmp_path):
    aliases = {
        "glm-5.2-4.5bit": {
            "name": "glm-5.2", "alias": "glm52mlx", "desc": "GLM 5.2",
            "provider": "local", "omlx_id": "glm-5.2-4.5bit",
            "thinking": "optional", "thinking_format": "glm-chat-template",
            "context": 1000000, "max_output_tokens": 128000,
        },
    }
    p = _load_aliases(tmp_path, aliases)
    r = _run("--aliases", str(p), "--models-out", str(tmp_path / "models.json"))
    assert r.returncode == 0, r.stderr
    m = json.loads((tmp_path / "models.json").read_text())["providers"]["ls99-models"]["models"][0]
    assert m["compat"]["thinkingFormat"] == "chat-template"
    assert m["compat"]["chatTemplateKwargs"]["reasoning_effort"]["$var"] == "thinking.effort"
    assert m["thinkingLevelMap"]["xhigh"] == "max"
    assert m["thinkingLevelMap"]["max"] == "max"
    assert m["thinkingLevelMap"]["high"] == "high"


def test_capability_levels_constrain_generic_glm_openai_and_anthropic(tmp_path):
    aliases = {
        "cloud:generic": {
            "name": "generic-reasoner", "alias": "generic", "provider": "databricks",
            "provider_model_id": "generic-reasoner", "thinking": "optional",
            "thinking_levels": ["off", "low", "max"],
        },
        "glm-local": {
            "name": "glm-5.2", "alias": "glm", "provider": "local",
            "thinking": "always", "thinking_format": "glm-chat-template",
            "thinking_levels": ["high", "max"],
        },
        "cloud:gpt": {
            "name": "gpt-5.4", "alias": "gpt", "provider": "openai",
            "provider_model_id": "gpt-5.4", "thinking": "optional",
            "thinking_levels": ["off", "minimal", "high", "xhigh"],
        },
        "cloud:claude": {
            "name": "claude-opus-4.8", "alias": "claude", "provider": "anthropic",
            "provider_model_id": "claude-opus-4-8", "thinking": "optional",
            "thinking_levels": ["off", "low", "high", "max"],
        },
    }
    p = _load_aliases(tmp_path, aliases)
    r = _run("--aliases", str(p), "--models-out", str(tmp_path / "models.json"))
    assert r.returncode == 0, r.stderr
    models = json.loads((tmp_path / "models.json").read_text())["providers"]["ls99-models"]["models"]
    by_id = {model["id"]: model for model in models}

    generic = by_id["generic-reasoner"]
    assert generic["thinkingLevelMap"] == {
        "off": "off", "minimal": None, "low": "low", "medium": None,
        "high": None, "xhigh": None, "max": "max",
    }
    assert list(generic["thinkingLevelMap"]) == [
        "off", "minimal", "low", "medium", "high", "xhigh", "max",
    ]
    assert generic["compat"]["supportsReasoningEffort"] is True
    assert "thinkingFormat" not in generic["compat"]

    glm = by_id["glm-local"]
    assert glm["thinkingLevelMap"] == {
        "off": None, "minimal": None, "low": None, "medium": None,
        "high": "high", "xhigh": None, "max": "max",
    }
    assert glm["reasoning"] is True
    assert glm["compat"] == {"supportsReasoningEffort": True}

    gpt = by_id["gpt-5.4"]
    assert gpt["thinkingLevelMap"] == {
        "off": "none", "minimal": "minimal", "low": None, "medium": None,
        "high": "high", "xhigh": "xhigh", "max": None,
    }

    claude = by_id["claude-opus-4-8"]
    assert claude["thinkingLevelMap"] == {
        "off": "off", "minimal": None, "low": "low", "medium": None,
        "high": "high", "xhigh": None, "max": "max",
    }
    assert claude["compat"]["forceAdaptiveThinking"] is True
    assert claude["compat"]["supportsEagerToolInputStreaming"] is False


def test_cloud_anthropic_uses_messages_api_and_root_baseurl(tmp_path):
    aliases = {
        "cloud:claude-opus-4-8": {
            "name": "claude-opus-4.8", "alias": "opus48", "desc": "Opus 4.8",
            "provider": "anthropic", "provider_model_id": "claude-opus-4-8",
            "thinking": "optional", "vision": True, "context": 1000000, "max_output_tokens": 128000,
        },
    }
    p = _load_aliases(tmp_path, aliases)
    r = _run("--aliases", str(p), "--models-out", str(tmp_path / "models.json"))
    assert r.returncode == 0, r.stderr
    m = json.loads((tmp_path / "models.json").read_text())["providers"]["ls99-models"]["models"][0]
    assert m["id"] == "claude-opus-4-8"  # cloud id == provider_model_id
    assert m["api"] == "anthropic-messages"
    assert m["reasoning"] is True  # anthropic kind
    assert m["thinkingLevelMap"]["xhigh"] == "xhigh"
    assert m["thinkingLevelMap"]["max"] == "max"
    assert m["compat"]["forceAdaptiveThinking"] is True
    assert m["compat"]["supportsTemperature"] is False
    assert "sendSessionAffinityHeaders" not in m["compat"]
    assert m["baseUrl"] == "http://localhost:9111"  # root, not /v1 (avoid /v1/v1/messages)
    assert m["input"] == ["text", "image"]  # explicit vision=True


def test_gateway_proxied_anthropic_protocol_model(tmp_path):
    """A databricks-style pooled model with protocol: anthropic gets the
    anthropic-messages API, root baseUrl, eager-tool-streaming off, and pi
    hints (name override, reasoning: false) honored."""
    aliases = {
        "cloud:databricks-claude-fable-5": {
            "name": "claude-fable-5", "alias": "fable", "desc": "fable",
            "provider": "databricks-e2-west", "protocol": "anthropic",
            "provider_model_id": "databricks-claude-fable-5",
            "vision": True, "context": 1000000, "max_output_tokens": 128000,
            "pi": {"name": "Claude Fable 5 via Databricks"},
        },
        "cloud:databricks-claude-opus-4-8": {
            "name": "claude-opus-4.8", "alias": "opus48", "desc": "opus",
            "provider": "databricks", "protocol": "anthropic",
            "provider_model_id": "databricks-claude-opus-4-8",
            "thinking": "optional", "vision": True, "context": 1000000, "max_output_tokens": 128000,
            "pi": {"name": "pi-opus48", "reasoning": False},
        },
    }
    p = _load_aliases(tmp_path, aliases)
    r = _run("--aliases", str(p), "--models-out", str(tmp_path / "models.json"))
    assert r.returncode == 0, r.stderr
    models = json.loads((tmp_path / "models.json").read_text())["providers"]["ls99-models"]["models"]
    by_id = {m["id"]: m for m in models}
    fable = by_id["databricks-claude-fable-5"]
    assert fable["api"] == "anthropic-messages"
    assert fable["baseUrl"] == "http://localhost:9111"
    assert fable["name"] == "Claude Fable 5 via Databricks"  # pi.name override
    assert fable["reasoning"] is True  # anthropic-shape default
    assert fable["thinkingLevelMap"] == {"off": None, "xhigh": "xhigh", "max": "max"}
    assert fable["compat"]["forceAdaptiveThinking"] is True
    assert fable["compat"]["supportsEagerToolInputStreaming"] is False
    assert "sendSessionAffinityHeaders" not in fable["compat"]
    opus = by_id["databricks-claude-opus-4-8"]
    assert opus["reasoning"] is False  # pi.reasoning: false wins
    assert opus["api"] == "anthropic-messages"


def test_gateway_proxied_openai_protocol_model(tmp_path):
    """OpenAI-protocol gateway models: openai-completions at provider /v1,
    generic reasoning from thinking, pi.id override for the model id, and
    pi.compat merged per-model."""
    aliases = {
        "cloud:databricks-gpt-5-5": {
            "name": "gpt-5.5", "alias": "gpt", "desc": "gpt",
            "provider": "databricks", "protocol": "openai",
            "provider_model_id": "databricks-gpt-5-5",
            "thinking": "optional", "context": 400000, "max_output_tokens": 128000,
            "pi": {
                "thinkingLevelMap": {"off": None, "max": "max"},
                "compat": {"supportsReasoningEffort": True},
            },
        },
        "cloud:databricks-gemini-3-1-pro": {
            "name": "gemini-3.1-pro", "alias": "gemini", "desc": "gemini",
            "provider": "databricks-e2", "protocol": "openai",
            "provider_model_id": "databricks-gemini-3-1-pro",
            "thinking": "optional", "vision": True, "context": 1000000, "max_output_tokens": 65536,
            "pi": {"id": "gemini-3.1-pro-preview"},
        },
    }
    p = _load_aliases(tmp_path, aliases)
    r = _run("--aliases", str(p), "--models-out", str(tmp_path / "models.json"),
             "--launchers-out", str(tmp_path / "launchers.zsh"))
    assert r.returncode == 0, r.stderr
    models = json.loads((tmp_path / "models.json").read_text())["providers"]["ls99-models"]["models"]
    by_id = {m["id"]: m for m in models}
    gpt = by_id["databricks-gpt-5-5"]
    assert gpt["api"] == "openai-completions"
    assert "baseUrl" not in gpt  # provider /v1 base
    assert gpt["reasoning"] is True  # generic gateway reasoning from thinking
    assert gpt["thinkingLevelMap"] == {"off": None, "max": "max"}
    assert gpt["compat"]["supportsReasoningEffort"] is True  # pi.compat merged
    gem = by_id["gemini-3.1-pro-preview"]  # pi.id override used as model id
    assert gem["reasoning"] is True
    # Launcher uses the SAME overridden id.
    launchers = (tmp_path / "launchers.zsh").read_text()
    assert f" {shlex.quote('gemini-3.1-pro-preview')} " in launchers
    assert "pi-gemini()" in launchers
    assert "pi-fable" not in launchers  # only defined aliases render


def test_cloud_gpt_uses_responses_api(tmp_path):
    aliases = {
        "cloud:gpt-5.4": {
            "name": "gpt-5.4", "alias": "gpt", "desc": "GPT-5.4",
            "provider": "openai", "provider_model_id": "gpt-5.4",
            "thinking": "optional", "context": 1000000, "max_output_tokens": 32768,
        },
    }
    p = _load_aliases(tmp_path, aliases)
    r = _run("--aliases", str(p), "--models-out", str(tmp_path / "models.json"))
    assert r.returncode == 0, r.stderr
    m = json.loads((tmp_path / "models.json").read_text())["providers"]["ls99-models"]["models"][0]
    assert m["api"] == "openai-responses"
    assert m["reasoning"] is True
    assert m["thinkingLevelMap"]["off"] == "none"
    assert m["thinkingLevelMap"]["xhigh"] == "xhigh"
    assert "max" not in m["thinkingLevelMap"]
    assert "baseUrl" not in m  # openai-shaped uses provider /v1 base


def test_api_style_open_responses_renders_responses_api(tmp_path):
    """Gateway api_style: open_responses (e.g. gpt-6-astra) forces Pi onto
    the openai-responses protocol regardless of provider."""
    aliases = {
        "cloud:databricks-gpt-6-astra": {
            "name": "gpt-6-astra", "alias": "astra", "desc": "GPT-6 Astra",
            "provider": "databricks-e2", "provider_model_id": "databricks-gpt-6-astra",
            "api_style": "open_responses",
            "thinking": "always",
            "thinking_levels": ["minimal", "low", "medium", "high", "xhigh", "max"],
            "context": 1050000, "max_output_tokens": 128000, "pi": {"name": "GPT-6 Astra via Databricks"},
        },
    }
    p = _load_aliases(tmp_path, aliases)
    r = _run("--aliases", str(p), "--models-out", str(tmp_path / "models.json"))
    assert r.returncode == 0, r.stderr
    m = json.loads((tmp_path / "models.json").read_text())["providers"]["ls99-models"]["models"][0]
    assert m["api"] == "openai-responses"
    assert m["name"] == "GPT-6 Astra via Databricks"
    assert m["reasoning"] is True
    # thinking_levels is authoritative: always-reasons model has no off level.
    assert m["thinkingLevelMap"]["off"] is None
    assert m["thinkingLevelMap"]["max"] == "max"
    assert "baseUrl" not in m  # responses client appends /responses to /v1 base


def test_cloud_fireworks_kimi_k3_keeps_native_deferred_tools_and_logical_id(tmp_path):
    aliases = {
        "cloud:kimi-k3": {
            "name": "kimi-k3", "alias": "kimi3", "desc": "Kimi K3",
            "provider": "fireworks",
            "provider_model_id": "accounts/fireworks/models/kimi-k3",
            "thinking": "always", "thinking_levels": ["max"],
            "context": 1000000, "max_output_tokens": 131072,
            "pi": {"id": "kimi-k3"},
        },
    }
    p = _load_aliases(tmp_path, aliases)
    r = _run("--aliases", str(p), "--models-out", str(tmp_path / "models.json"))
    assert r.returncode == 0, r.stderr
    m = json.loads((tmp_path / "models.json").read_text())["providers"]["ls99-models"]["models"][0]
    assert m["id"] == "kimi-k3"
    assert m["api"] == "openai-completions"
    assert m["reasoning"] is True
    assert m["thinkingLevelMap"] == {
        "off": None,
        "minimal": None,
        "low": None,
        "medium": None,
        "high": None,
        "xhigh": None,
        "max": "max",
    }
    assert "thinkingFormat" not in m["compat"]
    assert m["compat"]["supportsReasoningEffort"] is True
    assert m["compat"]["requiresReasoningContentOnAssistantMessages"] is True
    assert m["compat"]["deferredToolsMode"] == "kimi"


def test_zai_exposes_model_specific_graded_efforts(tmp_path):
    aliases = {
        "cloud:glm-5.1": {
            "name": "glm-5.1", "alias": "glm51", "provider": "zai",
            "provider_model_id": "glm-5.1", "thinking": "optional",
        },
        "cloud:glm-5.2": {
            "name": "glm-5.2", "alias": "glm52", "provider": "zai",
            "provider_model_id": "glm-5.2", "thinking": "optional",
        },
    }
    p = _load_aliases(tmp_path, aliases)
    r = _run("--aliases", str(p), "--models-out", str(tmp_path / "models.json"))
    assert r.returncode == 0, r.stderr
    models = json.loads((tmp_path / "models.json").read_text())["providers"]["ls99-models"]["models"]
    by_id = {model["id"]: model for model in models}
    assert "thinkingLevelMap" not in by_id["glm-5.1"]
    assert by_id["glm-5.1"]["compat"]["zaiToolStream"] is True
    assert "supportsReasoningEffort" not in by_id["glm-5.1"]["compat"]
    assert by_id["glm-5.2"]["thinkingLevelMap"] == {
        "minimal": None, "low": "high", "medium": "high", "high": "high", "max": "max",
    }
    assert by_id["glm-5.2"]["compat"]["supportsReasoningEffort"] is True


def test_zai_glm53_compatibility_route_preserves_legacy_launcher(tmp_path):
    thinking_map = {
        "off": "low",
        "minimal": "minimal",
        "low": "low",
        "medium": "medium",
        "high": "high",
        "xhigh": "xhigh",
        "max": "max",
    }
    aliases = {
        "cloud:glm-5.2": {
            "name": "glm-5.3-zai",
            "alias": "glm53zai",
            "provider": "zai_coding",
            "provider_model_id": "glm-5.2",
            "thinking": "always",
            "thinking_levels": ["minimal", "low", "medium", "high", "xhigh", "max"],
            "pi": {
                "id": "glm-5.3",
                "aliases": ["glm52zai"],
                "thinkingLevelMap": thinking_map,
            },
        },
    }
    p = _load_aliases(tmp_path, aliases)
    models_out = tmp_path / "models.json"
    launchers_out = tmp_path / "launchers.zsh"
    r = _run(
        "--aliases", str(p),
        "--models-out", str(models_out),
        "--launchers-out", str(launchers_out),
    )
    assert r.returncode == 0, r.stderr
    models = json.loads(models_out.read_text())["providers"]["ls99-models"]["models"]
    assert len(models) == 1
    model = models[0]
    assert model["id"] == "glm-5.3"
    assert model["thinkingLevelMap"] == thinking_map
    assert model["compat"]["supportsReasoningEffort"] is True
    assert model["compat"]["zaiToolStream"] is True
    launchers = launchers_out.read_text()
    assert "pi-glm53zai()" in launchers
    assert "pi-glm52zai()" in launchers
    assert launchers.count('glm-5.3') >= 2


def test_openrouter_deepseek_v4_matches_current_pi_effort_map(tmp_path):
    aliases = {
        "cloud:deepseek/deepseek-v4-flash": {
            "name": "deepseek-v4-flash", "alias": "dsv4", "provider": "openrouter",
            "provider_model_id": "deepseek/deepseek-v4-flash", "thinking": "optional",
        },
    }
    p = _load_aliases(tmp_path, aliases)
    r = _run("--aliases", str(p), "--models-out", str(tmp_path / "models.json"))
    assert r.returncode == 0, r.stderr
    m = json.loads((tmp_path / "models.json").read_text())["providers"]["ls99-models"]["models"][0]
    assert m["thinkingLevelMap"] == {
        "minimal": None, "low": None, "medium": None,
        "high": "high", "xhigh": "xhigh", "max": None,
    }
    assert m["compat"]["requiresReasoningContentOnAssistantMessages"] is True


@pytest.mark.parametrize(
    ("model_id", "expected"),
    [
        ("gpt-5.4-pro", {"off": None, "xhigh": "xhigh"}),
        ("gpt-5.5", {"off": "none", "minimal": None, "xhigh": "xhigh"}),
        ("gpt-5.5-pro", {"off": None, "minimal": None, "low": None, "xhigh": "xhigh"}),
        ("gpt-5.6-sol", {"off": "none", "xhigh": "xhigh", "max": "max"}),
    ],
)
def test_openai_responses_variant_effort_restrictions(tmp_path, model_id, expected):
    aliases = {
        f"cloud:{model_id}": {
            "name": model_id, "alias": "gpt", "provider": "openai",
            "provider_model_id": model_id, "thinking": "optional",
        },
    }
    p = _load_aliases(tmp_path, aliases)
    r = _run("--aliases", str(p), "--models-out", str(tmp_path / "models.json"))
    assert r.returncode == 0, r.stderr
    m = json.loads((tmp_path / "models.json").read_text())["providers"]["ls99-models"]["models"][0]
    assert m["thinkingLevelMap"] == expected


def test_cloud_gemini_openrouter_reasoning(tmp_path):
    aliases = {
        "cloud:google/gemini-3.1-pro-preview": {
            "name": "gemini-3.1-pro", "alias": "gemini", "desc": "Gemini",
            "provider": "openrouter", "provider_model_id": "google/gemini-3.1-pro-preview",
            "thinking": "optional", "thinking_format": "openrouter", "vision": True,
            "context": 1000000, "max_output_tokens": 65536,
        },
    }
    p = _load_aliases(tmp_path, aliases)
    r = _run("--aliases", str(p), "--models-out", str(tmp_path / "models.json"))
    assert r.returncode == 0, r.stderr
    m = json.loads((tmp_path / "models.json").read_text())["providers"]["ls99-models"]["models"][0]
    assert m["api"] == "openai-completions"
    assert m["compat"]["thinkingFormat"] == "openrouter"
    assert m["reasoning"] is True


def test_supported_false_skipped(tmp_path):
    aliases = {
        "bad-mlx": {"name": "bad", "alias": "bad", "supported": False, "desc": "", "provider": "local"},
        "cloud:good-id": {
            "name": "good", "alias": "good", "provider": "openai",
            "provider_model_id": "good-id", "thinking": "optional",
        },
    }
    p = _load_aliases(tmp_path, aliases)
    r = _run("--aliases", str(p), "--models-out", str(tmp_path / "models.json"))
    assert r.returncode == 0, r.stderr
    models = json.loads((tmp_path / "models.json").read_text())["providers"]["ls99-models"]["models"]
    assert [m["id"] for m in models] == ["good-id"]


def test_provider_name_override(tmp_path):
    aliases = {"cloud:x": {"name": "x", "alias": "x", "provider": "openai", "provider_model_id": "x", "thinking": "optional"}}
    p = _load_aliases(tmp_path, aliases)
    r = _run("--aliases", str(p), "--models-out", str(tmp_path / "m.json"), "--provider-name", "my-prov")
    assert r.returncode == 0, r.stderr
    assert "my-prov" in json.loads((tmp_path / "m.json").read_text())["providers"]


# --- launcher rendering + id agreement --------------------------------------

def test_launcher_and_models_ids_agree(tmp_path):
    aliases = {
        "qwen3.6-27b-mlx": {
            "name": "qwen3.6-27b", "alias": "qwen36mlx", "desc": "local qwen",
            "provider": "local", "thinking": "optional", "thinking_format": "qwen-chat-template",
        },
        "cloud:claude-opus-4-8": {
            "name": "claude-opus-4.8", "alias": "opus48", "provider": "anthropic",
            "provider_model_id": "claude-opus-4-8", "thinking": "optional",
        },
    }
    p = _load_aliases(tmp_path, aliases)
    r = _run("--aliases", str(p), "--models-out", str(tmp_path / "m.json"),
             "--launchers-out", str(tmp_path / "l.zsh"), "--pi-agent-dir", "/tmp/.pi-omlx/agent")
    assert r.returncode == 0, r.stderr
    models = json.loads((tmp_path / "m.json").read_text())["providers"]["ls99-models"]["models"]
    launchers = (tmp_path / "l.zsh").read_text()
    # The launcher passes the model id as a shell-quoted arg to _pi_gw_launch;
    # it must match the models.json id exactly (no drift).
    for m in models:
        assert f" {shlex.quote(m['id'])} " in launchers, f"launcher missing model id {m['id']!r}"
    assert "pi-qwen36mlx()" in launchers
    assert "pi-opus48()" in launchers
    assert "pi-long()" not in launchers
    for retired in ("pi-qwen35", "pi-heretic", "pi-qwen35dense", "pi-qwen35tiny", "pi-qwen35tinyvl"):
        assert f"{retired}()" not in launchers
    assert "PI_CACHE_RETENTION" not in launchers
    assert "pi-list()" in launchers
    assert "pi-restart()" in launchers
    # pi-agent-dir wrapping
    expected_agent_dir = str(Path("/tmp/.pi-omlx/agent").resolve())
    assert f"PI_CODING_AGENT_DIR={shlex.quote(expected_agent_dir)}" in launchers
    # provider name passed as 1st arg to _pi_gw_launch
    assert f"_pi_gw_launch {shlex.quote('ls99-models')}" in launchers
    # NO claude-*/codex-* FUNCTION definitions (standardize on pi).
    # (Model ids like 'claude-opus-4-8' may appear as args, that's fine.)
    import re
    assert not re.search(r'\bclaude-[A-Za-z0-9_]+\s*\(\)', launchers), "launcher defines claude-* functions"
    assert not re.search(r'\bcodex-[A-Za-z0-9_]+\s*\(\)', launchers), "launcher defines codex-* functions"


def test_launcher_removes_retired_functions(tmp_path):
    if not shutil.which("zsh"):
        pytest.skip("zsh not available")
    aliases = {
        "cloud:opus": {
            "name": "Opus", "alias": "opus", "provider": "anthropic",
            "provider_model_id": "claude-opus-5",
        },
    }
    p = _load_aliases(tmp_path, aliases)
    launcher = tmp_path / "launchers.zsh"
    r = _run("--aliases", str(p), "--launchers-out", str(launcher))
    assert r.returncode == 0, r.stderr
    result = subprocess.run(
        [
            "zsh", "-c",
            f"pi-omlx-repair() {{ return 0; }}; "
            f"for fn in pi-qwen35 pi-heretic pi-qwen35dense pi-qwen35tiny pi-qwen35tinyvl; do "
            f"  eval \"$fn() {{ return 0; }}\"; "
            f"done; source {launcher!s}; "
            f"for fn in pi-qwen35 pi-heretic pi-qwen35dense pi-qwen35tiny pi-qwen35tinyvl; do "
            f"  (( ! $+functions[$fn] )) || exit 1; "
            f"done",
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr


def test_pi_list_groups_local_and_cloud_models(tmp_path):
    aliases = {
        "local-z": {"name": "Local Z", "alias": "zlocal", "provider": "local", "vision": True},
        "cloud:z": {
            "name": "Cloud Z", "alias": "zcloud", "provider": "openai",
            "provider_model_id": "cloud-z", "vision": False,
        },
        "local-a": {"name": "Local A", "alias": "alocal", "provider": "local"},
        "cloud:a": {
            "name": "Cloud A", "alias": "acloud", "provider": "anthropic",
            "provider_model_id": "cloud-a", "vision": True,
        },
    }
    p = _load_aliases(tmp_path, aliases)
    r = _run("--aliases", str(p), "--launchers-out", str(tmp_path / "l.zsh"))
    assert r.returncode == 0, r.stderr
    launchers = (tmp_path / "l.zsh").read_text()
    pi_list = launchers.split("pi-list() {", 1)[1].split("\n}", 1)[0]

    assert 'echo "Pi quick-start commands:"' in pi_list
    assert pi_list.index("Local models (via ls99-models") < pi_list.index("Cloud models (via ls99-models")
    local_section = pi_list.split("Local models", 1)[1].split("Cloud models", 1)[0]
    cloud_section = pi_list.split("Cloud models", 1)[1].split("Management", 1)[0]
    assert local_section.index("pi-alocal") < local_section.index("pi-zlocal")
    assert "pi-acloud" not in local_section and "pi-zcloud" not in local_section
    assert cloud_section.index("pi-acloud") < cloud_section.index("pi-zcloud")
    assert "pi-alocal" not in cloud_section and "pi-zlocal" not in cloud_section
    assert "Local Z (local-z) [vision]" in local_section
    assert "Local A (local-a) [text-only]" in local_section
    assert "Cloud A (cloud-a) [vision]" in cloud_section
    assert "Cloud Z (cloud-z) [text-only]" in cloud_section


@pytest.mark.parametrize(
    ("aliases", "present_heading", "absent_heading"),
    [
        (
            {"local": {"name": "Local", "alias": "local", "provider": "local"}},
            "Local models",
            "Cloud models",
        ),
        (
            {
                "cloud:model": {
                    "name": "Cloud", "alias": "cloud", "provider": "openai",
                    "provider_model_id": "model",
                },
            },
            "Cloud models",
            "Local models",
        ),
    ],
)
def test_pi_list_omits_empty_model_sections(tmp_path, aliases, present_heading, absent_heading):
    p = _load_aliases(tmp_path, aliases)
    r = _run("--aliases", str(p), "--launchers-out", str(tmp_path / "l.zsh"))
    assert r.returncode == 0, r.stderr
    pi_list = (tmp_path / "l.zsh").read_text().split("pi-list() {", 1)[1].split("\n}", 1)[0]
    assert present_heading in pi_list
    assert absent_heading not in pi_list


def test_ls99_extras_adds_pi_default_and_pi_openai(tmp_path):
    aliases = {"cloud:x": {"name": "x", "alias": "x", "provider": "openai", "provider_model_id": "x", "thinking": "optional"}}
    p = _load_aliases(tmp_path, aliases)
    r = _run("--aliases", str(p), "--launchers-out", str(tmp_path / "l.zsh"), "--ls99-extras")
    assert r.returncode == 0, r.stderr
    launchers = (tmp_path / "l.zsh").read_text()
    assert "pi-default()" in launchers
    assert "pi-openai()" in launchers
    assert "-u PI_CODING_AGENT_DIR" in launchers  # both use default profile
    assert "openai-codex" in launchers
    pi_list = launchers.split("pi-list() {", 1)[1].split("\n}", 1)[0]
    assert pi_list.index("Cloud models") < pi_list.index("Direct Pi:") < pi_list.index("Management:")
    assert "pi-default" in pi_list
    assert "pi-openai" in pi_list


def test_pi_regen_baked_with_paths(tmp_path):
    aliases = {"cloud:x": {"name": "x", "alias": "x", "provider": "openai", "provider_model_id": "x", "thinking": "optional"}}
    p = _load_aliases(tmp_path, aliases)
    mp = tmp_path / "m.json"
    lp = tmp_path / "l.zsh"
    r = _run("--aliases", str(p), "--models-out", str(mp), "--launchers-out", str(lp), "--provider-name", "ls99-models")
    assert r.returncode == 0, r.stderr
    launchers = lp.read_text()
    assert "pi-regen()" in launchers
    # the regen command reproduces the generation args
    assert "--aliases" in launchers and str(p) in launchers
    assert "--models-out" in launchers and str(mp) in launchers
    assert "--launchers-out" in launchers and str(lp) in launchers
    assert "--provider-name" in launchers and "ls99-models" in launchers


def test_pi_restart_calls_regen_after_model_gw_and_polls_configured_url(tmp_path):
    aliases = {"cloud:x": {"name": "x", "alias": "x", "provider": "openai", "provider_model_id": "x", "thinking": "optional"}}
    p = _load_aliases(tmp_path, aliases)
    gateway_url = "http://127.0.0.1:19111"
    r = _run(
        "--aliases", str(p),
        "--models-out", str(tmp_path / "m.json"),
        "--launchers-out", str(tmp_path / "l.zsh"),
        "--gateway-url", gateway_url,
    )
    assert r.returncode == 0, r.stderr
    launchers = (tmp_path / "l.zsh").read_text()
    restart = launchers.split("pi-restart() {", 1)[1].split("\n}", 1)[0]
    # pi-restart auto-regens after a successful model-gw restart and uses the
    # same endpoint as generated clients instead of a hard-coded port.
    assert 'pi-regen --quiet' in restart
    assert '"$svc" = model-gw' in restart
    assert 'model-gateway restart' in restart
    assert 'server-ci restart --"$svc"' in restart
    assert f"{gateway_url}/health" in restart
    assert "model-gw) port=9111" not in restart
    assert "port=9110" not in restart


def test_pi_restart_polls_omlx_readiness_by_service_name(tmp_path):
    if not shutil.which("zsh"):
        pytest.skip("zsh not available")
    aliases = {"cloud:x": {"name": "x", "alias": "x", "provider": "openai", "provider_model_id": "x"}}
    p = _load_aliases(tmp_path, aliases)
    launcher = tmp_path / "l.zsh"
    r = _run("--aliases", str(p), "--launchers-out", str(launcher))
    assert r.returncode == 0, r.stderr

    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    state = tmp_path / "status-count"
    server_ci = fake_bin / "server-ci"
    server_ci.write_text(
        "#!/bin/sh\n"
        f"state={shlex.quote(str(state))}\n"
        "if [ \"$1 $2\" = \"restart --omlx\" ]; then exit 0; fi\n"
        "if [ \"$1 $2\" = \"restart --status\" ]; then\n"
        "  n=$(cat \"$state\" 2>/dev/null || echo 0); n=$((n + 1)); echo \"$n\" >\"$state\"\n"
        "  if [ \"$n\" -lt 2 ]; then echo '  (omlx): STARTING'; else echo '  (omlx): UP'; fi\n"
        "  exit 0\n"
        "fi\n"
        "exit 1\n",
        encoding="utf-8",
    )
    server_ci.chmod(0o755)
    result = subprocess.run(
        [
            "zsh", "-c",
            f"PATH={shlex.quote(str(fake_bin))}:$PATH; "
            f"pi-omlx-repair() {{ return 0; }}; source {shlex.quote(str(launcher))}; "
            "sleep() { return 0; }; pi-restart omlx",
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert state.read_text().strip() == "2"
    assert "(omlx): UP" in result.stdout


def test_pi_restart_returns_nonzero_when_omlx_never_becomes_ready(tmp_path):
    if not shutil.which("zsh"):
        pytest.skip("zsh not available")
    aliases = {"cloud:x": {"name": "x", "alias": "x", "provider": "openai", "provider_model_id": "x"}}
    p = _load_aliases(tmp_path, aliases)
    launcher = tmp_path / "l.zsh"
    r = _run("--aliases", str(p), "--launchers-out", str(launcher))
    assert r.returncode == 0, r.stderr

    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    server_ci = fake_bin / "server-ci"
    server_ci.write_text(
        "#!/bin/sh\n"
        "if [ \"$1 $2\" = \"restart --omlx\" ]; then exit 0; fi\n"
        "if [ \"$1 $2\" = \"restart --status\" ]; then echo '  9110 (omlx): DOWN'; exit 0; fi\n"
        "exit 1\n",
        encoding="utf-8",
    )
    server_ci.chmod(0o755)
    result = subprocess.run(
        [
            "zsh", "-c",
            f"PATH={shlex.quote(str(fake_bin))}:$PATH; "
            f"pi-omlx-repair() {{ return 0; }}; source {shlex.quote(str(launcher))}; "
            "sleep() { return 0; }; pi-restart omlx",
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0
    assert "omlx did not report UP within 25s" in result.stdout


def test_pi_restart_help_does_not_execute_backticked_commands(tmp_path):
    if not shutil.which("zsh"):
        pytest.skip("zsh not available")
    aliases = {"cloud:x": {"name": "x", "alias": "x", "provider": "openai", "provider_model_id": "x", "thinking": "optional"}}
    p = _load_aliases(tmp_path, aliases)
    launcher = tmp_path / "l.zsh"
    r = _run("--aliases", str(p), "--models-out", str(tmp_path / "m.json"), "--launchers-out", str(launcher))
    assert r.returncode == 0, r.stderr
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    invoked = tmp_path / "invoked"
    for name in ("model-gateway", "server-ci"):
        script = fake_bin / name
        script.write_text(f"#!/usr/bin/env bash\necho {name} >> {invoked}\n")
        script.chmod(0o755)
    z = subprocess.run(
        ["zsh", "-c", f"PATH={fake_bin}:$PATH; source {launcher}; pi-restart --help"],
        capture_output=True,
        text=True,
    )
    assert z.returncode == 0, z.stderr
    assert not invoked.exists()
    assert "model-gateway restart" in z.stdout


def test_no_regen_when_no_output_paths(tmp_path):
    # when launched without output paths (unrealistic, but render_launchers guard)
    aliases = {"cloud:x": {"name": "x", "alias": "x", "provider": "openai", "provider_model_id": "x", "thinking": "optional"}}
    p = _load_aliases(tmp_path, aliases)
    # only models-out, no launchers-out: pi-regen still baked (models_out given)
    r = _run("--aliases", str(p), "--models-out", str(tmp_path / "m.json"))
    assert r.returncode == 0, r.stderr


def test_cloud_missing_provider_model_id_skipped_in_both(tmp_path):
    # A cloud entry with no provider_model_id must be skipped in BOTH models.json
    # and the launcher (no pi-<alias> emitted) — the id-agreement edge case.
    aliases = {
        "cloud:no-pm": {"name": "np", "alias": "np", "provider": "openai", "thinking": "optional"},  # no provider_model_id
        "cloud:good": {"name": "g", "alias": "g", "provider": "openai", "provider_model_id": "good-id", "thinking": "optional"},
    }
    p = _load_aliases(tmp_path, aliases)
    r = _run("--aliases", str(p), "--models-out", str(tmp_path / "m.json"), "--launchers-out", str(tmp_path / "l.zsh"))
    assert r.returncode == 0, r.stderr
    models = json.loads((tmp_path / "m.json").read_text())["providers"]["ls99-models"]["models"]
    ids = {m["id"] for m in models}
    assert "good-id" in ids
    assert "cloud:no-pm" not in ids  # skipped
    launchers = (tmp_path / "l.zsh").read_text()
    assert "pi-g()" in launchers
    assert "pi-np()" not in launchers  # no launcher for the skipped model


def test_duplicate_provider_model_id_deduped_in_both(tmp_path):
    aliases = {
        "cloud:a": {"name": "a", "alias": "a", "provider": "openai", "provider_model_id": "dup-id", "thinking": "optional"},
        "cloud:b": {"name": "b", "alias": "b", "provider": "openai", "provider_model_id": "dup-id", "thinking": "optional"},
    }
    p = _load_aliases(tmp_path, aliases)
    r = _run("--aliases", str(p), "--models-out", str(tmp_path / "m.json"), "--launchers-out", str(tmp_path / "l.zsh"))
    assert r.returncode == 0, r.stderr
    models = json.loads((tmp_path / "m.json").read_text())["providers"]["ls99-models"]["models"]
    assert len([m for m in models if m["id"] == "dup-id"]) == 1
    launchers = (tmp_path / "l.zsh").read_text()
    # only the first alias wins; second is skipped
    assert ("pi-a()" in launchers) != ("pi-b()" in launchers)


def test_gguf_provider_skipped_in_both(tmp_path):
    aliases = {
        "cloud:gg": {"name": "gg", "alias": "gg", "provider": "gguf", "provider_model_id": "gg-id", "thinking": "optional"},
        "cloud:ok": {"name": "ok", "alias": "ok", "provider": "openai", "provider_model_id": "ok-id", "thinking": "optional"},
    }
    p = _load_aliases(tmp_path, aliases)
    r = _run("--aliases", str(p), "--models-out", str(tmp_path / "m.json"), "--launchers-out", str(tmp_path / "l.zsh"))
    assert r.returncode == 0, r.stderr
    models = json.loads((tmp_path / "m.json").read_text())["providers"]["ls99-models"]["models"]
    assert {m["id"] for m in models} == {"ok-id"}
    launchers = (tmp_path / "l.zsh").read_text()
    assert "pi-ok()" in launchers
    assert "pi-gg()" not in launchers


def test_enable_thinking_false_disables_reasoning(tmp_path):
    aliases = {
        "qwen-mlx": {
            "name": "qwen", "alias": "qwen", "provider": "local",
            "thinking": "always", "thinking_format": "qwen-chat-template",
            "enable_thinking": False,  # short-circuits reasoning to off
        },
    }
    p = _load_aliases(tmp_path, aliases)
    r = _run("--aliases", str(p), "--models-out", str(tmp_path / "m.json"))
    assert r.returncode == 0, r.stderr
    m = json.loads((tmp_path / "m.json").read_text())["providers"]["ls99-models"]["models"][0]
    assert m["reasoning"] is False
    assert "compat" not in m  # no thinkingFormat


def test_empty_capability_levels_disable_local_qwen_status_fallback(tmp_path):
    aliases = {
        "qwen3.5-VL-9b-8bit-10gb": {
            "name": "qwen3.5-9b", "alias": "qwen35tinyvl", "provider": "local",
            "omlx_id": "qwen3.5-VL-9b-8bit-10gb", "thinking_levels": [],
        },
    }
    status = tmp_path / "status.json"
    status.write_text(json.dumps({"models": [{
        "id": "qwen3.5-VL-9b-8bit-10gb", "thinking_default": True,
    }]}))
    p = _load_aliases(tmp_path, aliases)
    r = _run("--aliases", str(p), "--models-out", str(tmp_path / "m.json"),
             "--omlx-status", str(status))
    assert r.returncode == 0, r.stderr
    m = json.loads((tmp_path / "m.json").read_text())["providers"]["ls99-models"]["models"][0]
    assert m["reasoning"] is False
    assert "thinkingLevelMap" not in m
    assert "compat" not in m


def test_pi_thinking_level_map_overrides_gateway_capabilities(tmp_path):
    aliases = {
        "cloud:override": {
            "name": "override", "alias": "override", "provider": "databricks",
            "provider_model_id": "override", "thinking": "always",
            "thinking_levels": ["max"],
            "pi": {"thinkingLevelMap": {"off": None, "high": "machine-high"}},
        },
    }
    p = _load_aliases(tmp_path, aliases)
    r = _run("--aliases", str(p), "--models-out", str(tmp_path / "m.json"))
    assert r.returncode == 0, r.stderr
    m = json.loads((tmp_path / "m.json").read_text())["providers"]["ls99-models"]["models"][0]
    assert m["thinkingLevelMap"] == {"off": None, "high": "machine-high"}


def test_legacy_catalog_without_capability_levels_keeps_generated_map(tmp_path):
    aliases = {
        "legacy-glm": {
            "name": "glm-5.2", "alias": "legacy", "provider": "local",
            "thinking": "optional", "thinking_format": "glm-chat-template",
        },
    }
    p = _load_aliases(tmp_path, aliases)
    r = _run("--aliases", str(p), "--models-out", str(tmp_path / "m.json"))
    assert r.returncode == 0, r.stderr
    m = json.loads((tmp_path / "m.json").read_text())["providers"]["ls99-models"]["models"][0]
    assert m["thinkingLevelMap"]["xhigh"] == "max"
    assert m["thinkingLevelMap"]["max"] == "max"
    assert m["compat"]["thinkingFormat"] == "chat-template"


def test_provider_compat_not_shared_between_providers(tmp_path):
    # _DEFAULT_PROVIDER_COMPAT is copied per-provider; mutation must not leak.
    aliases = {"cloud:x": {"name": "x", "alias": "x", "provider": "openai", "provider_model_id": "x", "thinking": "optional"}}
    p = _load_aliases(tmp_path, aliases)
    r = _run("--aliases", str(p), "--models-out", str(tmp_path / "m.json"))
    assert r.returncode == 0, r.stderr
    prov = json.loads((tmp_path / "m.json").read_text())["providers"]["ls99-models"]
    assert prov["compat"]["maxTokensField"] == "max_tokens"
    assert "sendSessionAffinityHeaders" not in prov["compat"]


@pytest.mark.parametrize("alias", ["bad alias", "bad*glob", "bad'quote", "bad\nline", "long"])
def test_launcher_aliases_reject_unsafe_or_reserved_names(tmp_path, alias):
    aliases = {
        "cloud:x": {
            "name": "x", "alias": alias, "provider": "anthropic",
            "provider_model_id": "claude-x",
        },
    }
    p = _load_aliases(tmp_path, aliases)
    r = _run("--aliases", str(p), "--launchers-out", str(tmp_path / "l.zsh"))
    assert r.returncode != 0
    assert "Pi launcher alias" in r.stderr


def test_launcher_aliases_reject_unsafe_pi_compat_aliases(tmp_path):
    aliases = {
        "cloud:x": {
            "name": "x",
            "alias": "safe",
            "provider": "openai",
            "provider_model_id": "x",
            "pi": {"aliases": ["bad alias"]},
        },
    }
    p = _load_aliases(tmp_path, aliases)
    r = _run("--aliases", str(p), "--launchers-out", str(tmp_path / "l.zsh"))
    assert r.returncode != 0
    assert "invalid Pi launcher alias" in r.stderr


def test_launcher_shell_quotes_all_catalog_and_cli_values(tmp_path):
    if not shutil.which("zsh"):
        pytest.skip("zsh not available")
    marker_provider = tmp_path / "provider-injected"
    marker_model = tmp_path / "model-injected"
    marker_url = tmp_path / "url-injected"
    marker_name = tmp_path / "name-injected"
    provider_name = f"prov'$(touch {marker_provider})"
    model_id = f"model'$(touch {marker_model})"
    gateway_url = f"http://localhost:9111/'$(touch {marker_url})"
    display_name = f"Display '$(touch {marker_name})"
    aliases = {
        "cloud:safe": {
            "name": display_name, "alias": "safe", "provider": "anthropic",
            "provider_model_id": model_id,
        },
    }
    p = _load_aliases(tmp_path, aliases)
    launcher = tmp_path / "quoted.zsh"
    shared = tmp_path / "shared"
    (shared / "bin").mkdir(parents=True)
    repair = shared / "bin/pi-omlx-repair"
    repair.write_text("#!/bin/sh\nexit 0\n")
    repair.chmod(0o755)
    r = _run(
        "--aliases", str(p), "--launchers-out", str(launcher),
        "--provider-name", provider_name, "--gateway-url", gateway_url,
        "--shared-dir", str(shared),
    )
    assert r.returncode == 0, r.stderr
    syntax = subprocess.run(["zsh", "-n", str(launcher)], capture_output=True, text=True)
    assert syntax.returncode == 0, syntax.stderr

    capture = tmp_path / "args.txt"
    script = f"""
        pi-omlx-repair() {{ return 0; }}
        curl() {{ return 0; }}
        pi() {{ printf '%s\\n' \"$@\" > {capture}; }}
        source {launcher}
        pi-safe
        pi-list >/dev/null
    """
    executed = subprocess.run(["zsh", "-c", script], capture_output=True, text=True)
    assert executed.returncode == 0, executed.stderr
    assert provider_name in capture.read_text().splitlines()
    assert model_id in capture.read_text().splitlines()
    for marker in (marker_provider, marker_model, marker_url, marker_name):
        assert not marker.exists()


def test_skipped_entries_do_not_validate_or_reserve_launcher_aliases(tmp_path):
    aliases = {
        "cloud:skipped-gguf": {
            "name": "skip", "alias": "bad alias", "provider": "gguf",
            "provider_model_id": "skip",
        },
        "cloud:skipped-missing-id": {
            "name": "skip", "alias": "same", "provider": "openai",
        },
        "cloud:valid": {
            "name": "valid", "alias": "same", "provider": "openai",
            "provider_model_id": "valid",
        },
    }
    p = _load_aliases(tmp_path, aliases)
    r = _run("--aliases", str(p), "--launchers-out", str(tmp_path / "l.zsh"))
    assert r.returncode == 0, r.stderr
    launchers = (tmp_path / "l.zsh").read_text()
    assert "pi-same()" in launchers
    assert "bad alias" not in launchers


def test_duplicate_launcher_aliases_are_rejected(tmp_path):
    aliases = {
        "cloud:a": {"name": "a", "alias": "same", "provider": "anthropic", "provider_model_id": "a"},
        "cloud:b": {"name": "b", "alias": "same", "provider": "openai", "provider_model_id": "b"},
    }
    p = _load_aliases(tmp_path, aliases)
    r = _run("--aliases", str(p), "--launchers-out", str(tmp_path / "l.zsh"))
    assert r.returncode != 0
    assert "duplicate Pi launcher alias 'same'" in r.stderr


def test_no_ls99_extras_omits_default_openai(tmp_path):
    aliases = {"cloud:x": {"name": "x", "alias": "x", "provider": "openai", "provider_model_id": "x", "thinking": "optional"}}
    p = _load_aliases(tmp_path, aliases)
    r = _run("--aliases", str(p), "--launchers-out", str(tmp_path / "l.zsh"))
    assert r.returncode == 0, r.stderr
    launchers = (tmp_path / "l.zsh").read_text()
    assert "pi-default()" not in launchers
    assert "pi-openai()" not in launchers


# --- IO / drift / edge cases -------------------------------------------------

def test_check_drift_detection(tmp_path):
    aliases = {"cloud:x": {"name": "x", "alias": "x", "provider": "openai", "provider_model_id": "x", "thinking": "optional"}}
    p = _load_aliases(tmp_path, aliases)
    mp = tmp_path / "m.json"
    r = _run("--aliases", str(p), "--models-out", str(mp))
    assert r.returncode == 0
    r = _run("--aliases", str(p), "--models-out", str(mp), "--check")
    assert r.returncode == 0, r.stderr
    assert "in sync" in r.stdout
    mp.write_text("{}")
    r = _run("--aliases", str(p), "--models-out", str(mp), "--check")
    assert r.returncode == 1
    assert "DRIFT" in r.stderr or "DRIFT" in r.stdout


def test_symlink_safe_write(tmp_path):
    aliases = {"cloud:x": {"name": "x", "alias": "x", "provider": "openai", "provider_model_id": "x", "thinking": "optional"}}
    p = _load_aliases(tmp_path, aliases)
    target = tmp_path / "real-models.json"
    target.write_text("{}")
    link = tmp_path / "link-models.json"
    link.symlink_to(target)
    r = _run("--aliases", str(p), "--models-out", str(link))
    assert r.returncode == 0, r.stderr
    assert link.is_symlink()
    assert "ls99-models" in json.loads(target.read_text())["providers"]


def test_empty_catalog_refused(tmp_path):
    p = _load_aliases(tmp_path, {})
    r = _run("--aliases", str(p), "--models-out", str(tmp_path / "m.json"))
    assert r.returncode != 0
    assert "empty catalog" in r.stderr


def test_no_output_targets_errors(tmp_path):
    p = _load_aliases(tmp_path, {"cloud:x": {"name": "x", "alias": "x", "provider": "openai", "provider_model_id": "x", "thinking": "optional"}})
    r = _run("--aliases", str(p))
    assert r.returncode != 0
    assert "nothing to do" in r.stderr


def test_installer_defaults_to_pi_owned_paths():
    installer = (SHARED_ROOT / "bin" / "pi-shared-install").read_text()
    assert "$HOME/.pi/model-aliases.json" in installer
    assert "$HOME/.pi/generated/pi-launchers.zsh" in installer
    assert "model-gateway-runtime" not in installer


def test_installer_renders_from_default_pi_alias_catalog(tmp_path):
    home = tmp_path / "home"
    aliases = home / ".pi" / "model-aliases.json"
    aliases.parent.mkdir(parents=True)
    aliases.write_text(json.dumps({
        "cloud:x": {
            "name": "x",
            "alias": "x",
            "provider": "openai",
            "provider_model_id": "x",
        }
    }))
    env = dict(os.environ)
    env.update({
        "HOME": str(home),
        "PI_SHARED_BIN_DIR": str(home / ".local" / "bin"),
        "PI_SHARED_AGENT_DIR": str(home / ".pi" / "agent"),
        "PI_SHARED_OMLX_AGENT_DIR": str(home / ".pi-omlx" / "agent"),
    })
    r = subprocess.run(
        [str(SHARED_ROOT / "bin" / "pi-shared-install"), "--no-deps", "--pi-agent-dir", ""],
        capture_output=True,
        text=True,
        env=env,
    )
    assert r.returncode == 0, r.stderr
    assert (home / ".pi-omlx" / "agent" / "models.json").is_file()
    assert (home / ".pi" / "generated" / "pi-launchers.zsh").is_file()


def test_installer_migrates_recognized_legacy_launcher(tmp_path):
    home = tmp_path / "home"
    aliases = tmp_path / "aliases.json"
    aliases.write_text(json.dumps({
        "cloud:x": {
            "name": "x",
            "alias": "x",
            "provider": "openai",
            "provider_model_id": "x",
        }
    }))
    legacy = home / ".pi" / "model-gateway" / "pi-launchers.zsh"
    legacy.parent.mkdir(parents=True)
    legacy.write_text("# Generated by pi-shared/bin/pi-catalog — do not hand-edit.\n")
    env = dict(os.environ)
    env.update({
        "HOME": str(home),
        "PI_SHARED_BIN_DIR": str(home / ".local" / "bin"),
        "PI_SHARED_AGENT_DIR": str(home / ".pi" / "agent"),
        "PI_SHARED_OMLX_AGENT_DIR": str(home / ".pi-omlx" / "agent"),
    })
    r = subprocess.run(
        [
            str(SHARED_ROOT / "bin" / "pi-shared-install"),
            "--no-deps",
            "--aliases", str(aliases),
            "--pi-agent-dir", "",
        ],
        capture_output=True,
        text=True,
        env=env,
    )
    assert r.returncode == 0, r.stderr
    canonical = home / ".pi" / "generated" / "pi-launchers.zsh"
    assert canonical.is_file()
    assert legacy.is_symlink()
    assert legacy.resolve() == canonical.resolve()
    assert f"source {canonical}" in r.stdout


def test_real_alias_file_renders(tmp_path):
    """Smoke test against the live ls99 alias file if present."""
    af = Path.home() / ".pi" / "model-aliases.json"
    if not af.exists():
        pytest.skip("no live alias file")
    r = _run("--aliases", str(af), "--models-out", str(tmp_path / "m.json"),
             "--launchers-out", str(tmp_path / "l.zsh"), "--pi-agent-dir", str(Path.home() / ".pi-omlx/agent"),
             "--ls99-extras", "--omlx-status-url", "http://localhost:9110/v1/models/status")
    assert r.returncode == 0, r.stderr
    models = json.loads((tmp_path / "m.json").read_text())["providers"]["ls99-models"]["models"]
    assert len(models) >= 30
    launchers = (tmp_path / "l.zsh").read_text()
    for m in models:
        assert f" {shlex.quote(m['id'])} " in launchers, f"launcher missing model id {m['id']!r}"
