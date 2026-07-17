"""Integration tests for the generated pi-shared-update shell function."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

SHARED_ROOT = Path(__file__).resolve().parents[1]
MODULE = SHARED_ROOT / "lib" / "pi_catalog.py"


def _run(*cmd: str, cwd: Path | None = None, check: bool = True, env: dict | None = None):
    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, env=env)
    if check and result.returncode != 0:
        raise AssertionError(f"command failed ({result.returncode}): {' '.join(cmd)}\n{result.stdout}\n{result.stderr}")
    return result


def _git(cwd: Path, *args: str):
    return _run("git", *args, cwd=cwd)


def _setup_repositories(tmp_path: Path) -> tuple[Path, Path, Path]:
    remote = tmp_path / "pi-shared.git"
    source = tmp_path / "source"
    checkout = tmp_path / "checkout"

    _run("git", "init", "--bare", "--initial-branch=main", str(remote))
    _run("git", "init", "-b", "main", str(source))
    _git(source, "config", "user.name", "Pi Shared Test")
    _git(source, "config", "user.email", "pi-shared@example.test")
    (source / "bin").mkdir()
    catalog = source / "bin" / "pi-catalog"
    catalog.write_text("#!/bin/sh\n[ -z \"${PI_CATALOG_ARGS_OUT:-}\" ] || printf '%s\\n' \"$@\" > \"$PI_CATALOG_ARGS_OUT\"\nexit 0\n")
    catalog.chmod(0o755)
    (source / "README.md").write_text("initial\n")
    _git(source, "add", ".")
    _git(source, "commit", "-m", "initial")
    _git(source, "remote", "add", "origin", str(remote))
    _git(source, "push", "-u", "origin", "main")

    _run("git", "clone", str(remote), str(checkout))
    _git(checkout, "config", "user.name", "Pi Shared Test")
    _git(checkout, "config", "user.email", "pi-shared@example.test")

    (source / "README.md").write_text("updated\n")
    _git(source, "add", "README.md")
    _git(source, "commit", "-m", "remote update")
    _git(source, "push")
    return source, checkout, remote


def _render_launcher(tmp_path: Path, shared_dir: Path) -> Path:
    aliases = tmp_path / "aliases.json"
    aliases.write_text(json.dumps({
        "cloud:test": {
            "name": "test",
            "alias": "test",
            "provider": "openai",
            "provider_model_id": "test",
        }
    }))
    launcher = tmp_path / "pi-launchers.zsh"
    result = _run(
        sys.executable,
        str(MODULE),
        "--aliases", str(aliases),
        "--launchers-out", str(launcher),
        "--shared-dir", str(shared_dir),
    )
    assert result.returncode == 0
    return launcher


def _test_path() -> str:
    dirs = [str(Path(shutil.which(name)).parent) for name in ("git", "zsh") if shutil.which(name)]
    dirs.extend(["/usr/bin", "/bin"])
    return os.pathsep.join(dict.fromkeys(dirs))


def _invoke_update(checkout: Path, launcher: Path, regen_body: str):
    script = f"""
source {shlex_quote(launcher)}
pi-catalog() {{ return 99; }}
pi-regen() {{
{regen_body}
}}
pi-shared-update --quiet
rc=$?
print -r -- "rc=$rc"
print -r -- "sourced=${{PI_SHARED_UPDATE_TEST_SOURCED:-0}}"
exit $rc
"""
    env = dict(os.environ)
    env["PATH"] = _test_path()
    env["HOME"] = str(checkout.parent / "home")
    Path(env["HOME"]).mkdir(exist_ok=True)
    return _run("zsh", "-c", script, check=False, env=env)


def shlex_quote(path: Path) -> str:
    import shlex

    return shlex.quote(str(path))


@pytest.mark.skipif(not shutil.which("zsh"), reason="zsh is required")
def test_pi_shared_update_fast_forwards_regenerates_and_sources(tmp_path):
    source, checkout, _remote = _setup_repositories(tmp_path)
    launcher = _render_launcher(tmp_path, checkout)
    regen_body = f"  print -r -- 'PI_SHARED_UPDATE_TEST_SOURCED=1' > {shlex_quote(launcher)}"

    result = _invoke_update(checkout, launcher, regen_body)

    assert result.returncode == 0, result.stderr
    assert "sourced=1" in result.stdout
    assert "artifacts regenerated and shell launchers reloaded" in result.stdout
    assert "Run /reload in any open Pi sessions" in result.stdout
    assert _git(checkout, "rev-parse", "HEAD").stdout == _git(source, "rev-parse", "HEAD").stdout


@pytest.mark.skipif(not shutil.which("zsh"), reason="zsh is required")
def test_pi_shared_update_refuses_dirty_checkout_before_pull(tmp_path):
    source, checkout, _remote = _setup_repositories(tmp_path)
    launcher = _render_launcher(tmp_path, checkout)
    (checkout / "dirty.txt").write_text("dirty\n")
    _git(checkout, "config", "status.showUntrackedFiles", "no")
    before = _git(checkout, "rev-parse", "HEAD").stdout
    regen_body = f"  print -r -- 'PI_SHARED_UPDATE_TEST_SOURCED=1' > {shlex_quote(launcher)}"

    result = _invoke_update(checkout, launcher, regen_body)

    assert result.returncode != 0
    assert "checkout is dirty" in result.stderr
    assert "sourced=0" in result.stdout
    assert _git(checkout, "rev-parse", "HEAD").stdout == before
    assert before != _git(source, "rev-parse", "HEAD").stdout


@pytest.mark.skipif(not shutil.which("zsh"), reason="zsh is required")
def test_pi_shared_update_refuses_detached_head(tmp_path):
    _source, checkout, _remote = _setup_repositories(tmp_path)
    launcher = _render_launcher(tmp_path, checkout)
    _git(checkout, "checkout", "--detach")

    result = _invoke_update(checkout, launcher, "  return 0")

    assert result.returncode != 0
    assert "detached HEAD" in result.stderr
    assert "sourced=0" in result.stdout


@pytest.mark.skipif(not shutil.which("zsh"), reason="zsh is required")
def test_pi_shared_update_does_not_source_after_regeneration_failure(tmp_path):
    source, checkout, _remote = _setup_repositories(tmp_path)
    launcher = _render_launcher(tmp_path, checkout)

    result = _invoke_update(checkout, launcher, "  return 9")

    assert result.returncode != 0
    assert "artifact regeneration failed" in result.stderr
    assert "sourced=0" in result.stdout
    assert _git(checkout, "rev-parse", "HEAD").stdout == _git(source, "rev-parse", "HEAD").stdout


@pytest.mark.skipif(not shutil.which("zsh"), reason="zsh is required")
def test_pi_shared_update_validates_regenerated_launcher_before_source(tmp_path):
    _source, checkout, _remote = _setup_repositories(tmp_path)
    launcher = _render_launcher(tmp_path, checkout)
    regen_body = f"  print -r -- 'if broken' > {shlex_quote(launcher)}"

    result = _invoke_update(checkout, launcher, regen_body)

    assert result.returncode != 0
    assert "failed zsh syntax validation" in result.stderr
    assert "sourced=0" in result.stdout


@pytest.mark.skipif(not shutil.which("zsh"), reason="zsh is required")
def test_pi_shared_update_reports_launcher_source_failure(tmp_path):
    _source, checkout, _remote = _setup_repositories(tmp_path)
    launcher = _render_launcher(tmp_path, checkout)
    regen_body = f"  print -r -- 'return 7' > {shlex_quote(launcher)}"

    result = _invoke_update(checkout, launcher, regen_body)

    assert result.returncode != 0
    assert "could not be loaded into this shell" in result.stderr
    assert "sourced=0" in result.stdout


@pytest.mark.skipif(not shutil.which("zsh"), reason="zsh is required")
def test_pi_regen_uses_baked_catalog_executable_not_shell_shadow(tmp_path):
    _source, checkout, _remote = _setup_repositories(tmp_path)
    launcher = _render_launcher(tmp_path, checkout)
    args_out = tmp_path / "catalog-args.txt"
    script = f"""
source {shlex_quote(launcher)}
pi-catalog() {{ return 23; }}
pi-regen --quiet
"""
    env = dict(os.environ)
    env["PATH"] = _test_path()
    env["HOME"] = str(tmp_path / "home")
    env["PI_CATALOG_ARGS_OUT"] = str(args_out)
    Path(env["HOME"]).mkdir(exist_ok=True)

    result = _run("zsh", "-c", script, check=False, env=env)

    assert result.returncode == 0, result.stderr
    args = args_out.read_text().splitlines()
    assert "--shared-dir" in args
    assert str(checkout.resolve()) in args


@pytest.mark.skipif(not shutil.which("zsh"), reason="zsh is required")
def test_pi_regen_preserves_custom_generation_settings(tmp_path):
    aliases = tmp_path / "aliases.json"
    aliases.write_text(json.dumps({
        "local-model": {
            "name": "local",
            "alias": "local",
            "provider": "local",
        }
    }))
    status = tmp_path / "status.json"
    status.write_text(json.dumps({
        "models": [{
            "id": "local-model",
            "max_context_window": 12345,
            "max_tokens": 456,
        }]
    }))
    models = tmp_path / "models.json"
    launcher = tmp_path / "pi-launchers.zsh"
    result = _run(
        sys.executable,
        str(MODULE),
        "--aliases", str(aliases),
        "--models-out", str(models),
        "--launchers-out", str(launcher),
        "--gateway-api-key", "custom-key",
        "--omlx-status", str(status),
        "--omlx-status-url", "http://status.example.test/models",
    )
    assert result.returncode == 0
    before = json.loads(models.read_text())
    script = f"source {shlex_quote(launcher)}\npi-regen --quiet\n"
    env = dict(os.environ)
    env["PATH"] = _test_path()
    env["HOME"] = str(tmp_path / "home")
    Path(env["HOME"]).mkdir(exist_ok=True)

    regenerated = _run("zsh", "-c", script, check=False, env=env)

    assert regenerated.returncode == 0, regenerated.stderr
    assert json.loads(models.read_text()) == before
    provider = before["providers"]["ls99-models"]
    assert provider["apiKey"] == "custom-key"
    assert provider["models"][0]["contextWindow"] == 12345
    assert provider["models"][0]["maxTokens"] == 456
    launcher_text = launcher.read_text()
    assert str(status.resolve()) in launcher_text
    assert "http://status.example.test/models" in launcher_text


def test_generated_regen_paths_are_absolute(tmp_path):
    relative_dir = tmp_path / "relative"
    relative_dir.mkdir()
    aliases = relative_dir / "aliases.json"
    aliases.write_text(json.dumps({
        "cloud:test": {
            "name": "test",
            "alias": "test",
            "provider": "openai",
            "provider_model_id": "test",
        }
    }))
    result = _run(
        sys.executable,
        str(MODULE),
        "--aliases", "aliases.json",
        "--models-out", "models.json",
        "--launchers-out", "pi-launchers.zsh",
        "--pi-agent-dir", "agent",
        cwd=relative_dir,
    )

    assert result.returncode == 0
    launcher = (relative_dir / "pi-launchers.zsh").read_text()
    assert str(aliases.resolve()) in launcher
    assert str((relative_dir / "models.json").resolve()) in launcher
    assert str((relative_dir / "pi-launchers.zsh").resolve()) in launcher
    assert str((relative_dir / "agent").resolve()) in launcher
    assert str(SHARED_ROOT.resolve() / "bin" / "pi-catalog") in launcher
