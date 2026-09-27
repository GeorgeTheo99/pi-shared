"""Portable, offline Codex subscription context policy."""
import json
from pathlib import Path
import stat
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from pi_codex_context import CODEX_MAX_CONTEXT, configure


def test_new_profile_gets_only_codex_ceiling(tmp_path):
    profile = tmp_path / "agent"
    path = profile / "models.json"
    assert configure(path, check=True) == len(CODEX_MAX_CONTEXT)
    assert not path.exists()
    assert configure(path) == len(CODEX_MAX_CONTEXT)
    data = json.loads(path.read_text())
    assert set(data["providers"]) == {"openai-codex"}
    assert {key: value["contextWindow"] for key, value in
            data["providers"]["openai-codex"]["modelOverrides"].items()} == CODEX_MAX_CONTEXT
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    before = path.read_bytes()
    assert configure(path) == 0
    assert path.read_bytes() == before


def test_preserves_explicit_overrides_custom_models_and_api(tmp_path):
    path = tmp_path / "models.json"
    original = {"providers": {
        "openai": {"modelOverrides": {"gpt-6-sol": {"contextWindow": 272000}}},
        "openai-codex": {"models": [{"id": "custom"}], "headers": {"x-test": "value"},
                         "modelOverrides": {"gpt-6-sol": {"contextWindow": 300000, "name": "mine"},
                                            "gpt-6-luna": {"name": "Luna"}}},
        "other": {"models": []}}}
    path.write_text(json.dumps(original))
    assert configure(path) == len(CODEX_MAX_CONTEXT) - 1
    result = json.loads(path.read_text())["providers"]
    assert result["openai"] == original["providers"]["openai"]
    assert result["other"] == original["providers"]["other"]
    assert result["openai-codex"]["models"] == [{"id": "custom"}]
    assert result["openai-codex"]["headers"] == {"x-test": "value"}
    assert result["openai-codex"]["modelOverrides"]["gpt-6-sol"] == {
        "contextWindow": 300000, "name": "mine"}
    assert result["openai-codex"]["modelOverrides"]["gpt-6-luna"] == {
        "contextWindow": 872000, "name": "Luna"}


@pytest.mark.parametrize("body", ["[]", '{"providers":[]}',
                                  '{"providers":{"openai-codex":{"modelOverrides":{"gpt-6-sol":1}}}}'])
def test_invalid_existing_config_is_unchanged(tmp_path, body):
    path = tmp_path / "models.json"
    path.write_text(body)
    with pytest.raises(ValueError):
        configure(path, check=True)
    assert path.read_text() == body


def test_refuses_symlinked_config(tmp_path):
    target = tmp_path / "gateway-models.json"
    target.write_text('{"providers":{}}')
    link = tmp_path / "models.json"
    link.symlink_to(target)
    with pytest.raises(ValueError, match="symlinked"):
        configure(link)
    assert target.read_text() == '{"providers":{}}'
