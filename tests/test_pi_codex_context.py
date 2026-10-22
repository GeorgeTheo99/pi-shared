"""Portable, offline ChatGPT subscription context policy."""
import json
from pathlib import Path
import stat
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from pi_codex_context import CODEX_MAX_CONTEXT, CODEX_STANDARD_CONTEXT, configure


SUBSCRIPTION_PROVIDERS = ("openai", "openai-codex")


def windows(overrides):
    return {model: overrides[model]["contextWindow"] for model in CODEX_MAX_CONTEXT}


def test_new_profile_gets_subscription_ceilings(tmp_path):
    profile = tmp_path / "agent"
    path = profile / "models.json"
    assert configure(path, check=True) == 2 * len(CODEX_MAX_CONTEXT)
    assert not path.exists()
    assert configure(path) == 2 * len(CODEX_MAX_CONTEXT)
    data = json.loads(path.read_text())
    assert set(data["providers"]) == set(SUBSCRIPTION_PROVIDERS)
    for provider in SUBSCRIPTION_PROVIDERS:
        assert windows(data["providers"][provider]["modelOverrides"]) == CODEX_MAX_CONTEXT
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    before = path.read_bytes()
    assert configure(path) == 0
    assert path.read_bytes() == before


def test_preserves_explicit_overrides_custom_models_and_other_providers(tmp_path):
    path = tmp_path / "models.json"
    original = {"providers": {
        "openai": {"modelOverrides": {"gpt-6-sol": {"contextWindow": 272000}}},
        "openai-codex": {"models": [{"id": "custom"}], "headers": {"x-test": "value"},
                         "modelOverrides": {"gpt-6-sol": {"contextWindow": 300000, "name": "mine"},
                                            "gpt-6-luna": {"name": "Luna"}}},
        "other": {"models": []}}}
    path.write_text(json.dumps(original))
    assert configure(path) == 2 * (len(CODEX_MAX_CONTEXT) - 1)
    result = json.loads(path.read_text())["providers"]
    assert result["other"] == original["providers"]["other"]
    assert result["openai"]["modelOverrides"]["gpt-6-sol"] == {"contextWindow": 272000}
    assert result["openai"]["modelOverrides"]["gpt-6-luna"] == {"contextWindow": 872000}
    assert result["openai-codex"]["models"] == [{"id": "custom"}]
    assert result["openai-codex"]["headers"] == {"x-test": "value"}
    assert result["openai-codex"]["modelOverrides"]["gpt-6-sol"] == {
        "contextWindow": 300000, "name": "mine"}
    assert result["openai-codex"]["modelOverrides"]["gpt-6-luna"] == {
        "contextWindow": 872000, "name": "Luna"}


def test_openai_inherits_the_legacy_codex_choice(tmp_path):
    path = tmp_path / "models.json"
    legacy = {model: {"contextWindow": CODEX_STANDARD_CONTEXT} for model in CODEX_MAX_CONTEXT}
    legacy["gpt-6-sol"] = {"contextWindow": 300000}  # Not a reviewed choice: openai gets the ceiling.
    path.write_text(json.dumps({"providers": {"openai-codex": {"modelOverrides": legacy}}}))
    assert configure(path) == len(CODEX_MAX_CONTEXT)
    providers = json.loads(path.read_text())["providers"]
    assert providers["openai-codex"]["modelOverrides"] == legacy
    expected = {model: CODEX_STANDARD_CONTEXT for model in CODEX_MAX_CONTEXT}
    expected["gpt-6-sol"] = CODEX_MAX_CONTEXT["gpt-6-sol"]
    assert windows(providers["openai"]["modelOverrides"]) == expected


@pytest.mark.parametrize("body", ["[]", '{"providers":[]}',
                                  '{"providers":{"openai-codex":{"modelOverrides":{"gpt-6-sol":1}}}}',
                                  '{"providers":{"openai":{"modelOverrides":{"gpt-6-sol":1}}}}',
                                  '{"providers":{"openai":[]}}'])
def test_invalid_existing_config_is_unchanged(tmp_path, body):
    path = tmp_path / "models.json"
    path.write_text(body)
    with pytest.raises(ValueError):
        configure(path, check=True)
    assert path.read_text() == body


def test_explicit_mode_switch_updates_only_reviewed_subscription_windows(tmp_path):
    path = tmp_path / "models.json"
    original = {"providers": {
        "openai": {"modelOverrides": {"gpt-6-sol": {"contextWindow": 123456}}},
        "openai-codex": {"modelOverrides": {
            "gpt-6-sol": {"contextWindow": 300000, "name": "Custom Sol"},
            "custom-model": {"contextWindow": 45000}}},
        "other": {"modelOverrides": {"gpt-6-sol": {"contextWindow": 1000}}}}}
    path.write_text(json.dumps(original))
    assert configure(path, mode="standard") == 2 * len(CODEX_MAX_CONTEXT)
    providers = json.loads(path.read_text())["providers"]
    assert providers["other"] == original["providers"]["other"]
    overrides = providers["openai-codex"]["modelOverrides"]
    assert overrides["custom-model"] == {"contextWindow": 45000}
    assert overrides["gpt-6-sol"]["name"] == "Custom Sol"
    standard = {model: CODEX_STANDARD_CONTEXT for model in CODEX_MAX_CONTEXT}
    for provider in SUBSCRIPTION_PROVIDERS:
        assert windows(providers[provider]["modelOverrides"]) == standard
    before = path.read_bytes()
    assert configure(path, mode="standard") == 0
    assert path.read_bytes() == before
    assert configure(path) == 0  # An installer update preserves the user's selected standard mode.
    assert path.read_bytes() == before
    assert configure(path, mode="max") == 2 * len(CODEX_MAX_CONTEXT)
    providers = json.loads(path.read_text())["providers"]
    for provider in SUBSCRIPTION_PROVIDERS:
        assert windows(providers[provider]["modelOverrides"]) == CODEX_MAX_CONTEXT


@pytest.mark.parametrize("mode", ["short", "maximum", ""])
def test_invalid_explicit_mode_does_not_change_config(tmp_path, mode):
    path = tmp_path / "models.json"
    path.write_text('{"providers":{}}')
    with pytest.raises(ValueError):
        configure(path, mode=mode)
    assert path.read_text() == '{"providers":{}}'


def test_refuses_symlinked_config(tmp_path):
    target = tmp_path / "gateway-models.json"
    target.write_text('{"providers":{}}')
    link = tmp_path / "models.json"
    link.symlink_to(target)
    with pytest.raises(ValueError, match="symlinked"):
        configure(link)
    assert target.read_text() == '{"providers":{}}'
