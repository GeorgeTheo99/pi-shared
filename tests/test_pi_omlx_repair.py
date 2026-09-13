from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest


SHARED_ROOT = Path(__file__).resolve().parents[1]
REPAIR = SHARED_ROOT / "bin/pi-omlx-repair"


def run_repair(tmp_path: Path, *, settings=None, databricks=False):
    agent = tmp_path / "agent"
    agent.mkdir(exist_ok=True)
    if settings is not None:
        (agent / "settings.json").write_text(json.dumps(settings))
    overlay = tmp_path / "pi-databricks"
    if databricks:
        overlay.mkdir(exist_ok=True)
    bins = tmp_path / "bin"
    bins.mkdir(exist_ok=True)
    python = bins / "python3"
    if not python.exists():
        python.symlink_to(Path(shutil.which("python3")).resolve())
    # Neither Pi nor Node is needed for profile wiring. Runtime overrides from
    # older shells are ignored, even when they refer to a real installation.
    env = {**os.environ, "HOME": str(tmp_path), "PATH": str(bins) + ":/usr/bin:/bin",
           "PI_OMLX_AGENT_DIR": str(agent), "PI_SHARED_DIR": str(SHARED_ROOT),
           "PI_DATABRICKS_DIR": str(overlay), "PI_INSTALL_DIR": str(tmp_path / "runtime")}
    return subprocess.run([str(REPAIR)], env=env, text=True, capture_output=True, timeout=20)


def test_profile_wiring_without_runtime_is_idempotent(tmp_path):
    first = run_repair(tmp_path)
    assert first.returncode == 0, first.stderr
    agent = tmp_path / "agent"
    before = (agent / "settings.json").read_bytes()
    settings = json.loads(before)
    assert [(agent / p).resolve() for p in settings["packages"]] == [SHARED_ROOT]
    assert settings["enableSkillCommands"] is True
    assert settings["defaultThinkingLevel"] == "high"
    assert (agent / "AGENTS.md").resolve() == SHARED_ROOT / "AGENTS.md"
    second = run_repair(tmp_path)
    assert second.returncode == 0, second.stderr
    assert (agent / "settings.json").read_bytes() == before
    assert "runtime unchanged" in second.stdout


def test_preserves_explicit_preferences_and_package_filters(tmp_path):
    package = {"source": str(SHARED_ROOT), "skills": []}
    original = {"packages": ["npm:other-package", package], "defaultProvider": "example",
                "defaultModel": "chosen", "defaultThinkingLevel": "off", "theme": "dark",
                "extensions": ["./custom.ts"]}
    result = run_repair(tmp_path, settings=original)
    assert result.returncode == 0, result.stderr
    actual = json.loads((tmp_path / "agent/settings.json").read_text())
    assert actual == {**original, "enableSkillCommands": True}


def test_optional_overlay_and_legacy_resource_migration(tmp_path):
    original = {"packages": [], "extensions": ["../../local_code/pi-databricks/extensions"],
                "skills": ["~/.codex/skills"]}
    result = run_repair(tmp_path, settings=original, databricks=True)
    assert result.returncode == 0, result.stderr
    agent = tmp_path / "agent"
    actual = json.loads((agent / "settings.json").read_text())
    assert [(agent / p).resolve() for p in actual["packages"]] == [SHARED_ROOT, tmp_path / "pi-databricks"]
    assert "extensions" not in actual and "skills" not in actual


def test_does_not_touch_runtime_models_or_credentials(tmp_path):
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    for name in ["dist/core/compaction/compaction.js", "dist/core/session-manager.js",
                 "dist/bundle/cli.js", "node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js"]:
        path = runtime / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"immutable packaged runtime sentinel\n")
        path.chmod(0o444)
    agent = tmp_path / "agent"
    agent.mkdir()
    for name in ["models.json", "auth.json"]:
        (agent / name).write_bytes(b"private data sentinel\n")
    before = {str(p.relative_to(tmp_path)): (p.read_bytes(), p.stat().st_mode)
              for p in tmp_path.rglob('*') if p.is_file()}
    result = run_repair(tmp_path)
    assert result.returncode == 0, result.stderr
    for name, evidence in before.items():
        path = tmp_path / name
        assert (path.read_bytes(), path.stat().st_mode) == evidence
    assert {str(p.relative_to(runtime)) for p in runtime.rglob('*') if p.is_file()} == {
        name.removeprefix('runtime/') for name in before if name.startswith('runtime/')}


@pytest.mark.parametrize("contents", ['{broken', '{"packages": "invalid"}'])
def test_bad_settings_fail_without_overwriting_them(tmp_path, contents):
    agent = tmp_path / "agent"
    agent.mkdir()
    (agent / "settings.json").write_text(contents)
    result = run_repair(tmp_path)
    assert result.returncode != 0
    assert (agent / "settings.json").read_text() == contents
    assert not (agent / "AGENTS.md").exists()
