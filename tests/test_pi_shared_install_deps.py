"""Tests for the locked extension-dependency phase of bin/pi-shared-install.

A copy of the installer is run against a synthetic repo layout under tmp_path
with a recording fake ``npm`` so no network or real install happens.
"""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
from pathlib import Path

import pytest

SHARED_ROOT = Path(__file__).resolve().parents[1]


def _write_exec(path: Path, body: str) -> None:
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


def _make_repo(tmp_path: Path, extensions: dict[str, dict | None]) -> Path:
    """Build a fake pi-shared checkout.

    ``extensions`` maps directory name -> dependencies dict (with lockfile) or
    None (no lockfile, dependency-free).
    """
    repo = tmp_path / "repo"
    (repo / "bin").mkdir(parents=True)
    (repo / "package.json").write_text(json.dumps({"name": "pi-shared", "pi": {"extensions": ["./extensions"]}}))
    shutil.copy(SHARED_ROOT / "bin" / "pi-shared-install", repo / "bin" / "pi-shared-install")
    shutil.copy(SHARED_ROOT / "bin" / "pi-shared-check-deps", repo / "bin" / "pi-shared-check-deps")
    for name in ("pi-catalog", "pi-omlx-repair", "pi-vanilla"):
        _write_exec(repo / "bin" / name, "#!/bin/sh\nexit 0\n")
    for name, deps in extensions.items():
        d = repo / "extensions" / name
        d.mkdir(parents=True)
        (d / "package.json").write_text(json.dumps({"name": name, "dependencies": deps or {}}))
        if deps is not None:
            (d / "package-lock.json").write_text("{}\n")
    return repo


def _fake_npm(tmp_path: Path, *, fail: bool = False) -> tuple[Path, Path]:
    """Fake npm that records argv+cwd and materialises resolvable modules."""
    bindir = tmp_path / "fakebin"
    bindir.mkdir(exist_ok=True)
    log = tmp_path / "npm.log"
    body = f"""#!/bin/sh
printf '%s\\t%s\\n' "$PWD" "$*" >> {log}
{"exit 7" if fail else ""}
# Simulate a lockfile install: create a resolvable stub for each dependency.
python3 - <<'PY'
import json, pathlib
deps = json.loads(pathlib.Path("package.json").read_text()).get("dependencies") or {{}}
for name in deps:
    d = pathlib.Path("node_modules") / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "package.json").write_text(json.dumps({{"name": name, "main": "index.js"}}))
    (d / "index.js").write_text("module.exports = {{}};\\n")
PY
"""
    _write_exec(bindir / "npm", body)
    return bindir, log


def _env(tmp_path: Path, bindir: Path) -> dict:
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    node_dir = str(Path(shutil.which("node")).parent)
    py_dir = str(Path(shutil.which("python3")).parent)
    return {
        "HOME": str(home),
        "PATH": os.pathsep.join([str(bindir), node_dir, py_dir, "/usr/bin", "/bin"]),
        "PI_SHARED_BIN_DIR": str(home / "bin"),
        "PI_SHARED_AGENT_DIR": str(home / ".pi" / "agent"),
    }


def _install(repo: Path, env: dict, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [str(repo / "bin" / "pi-shared-install"), "--no-catalog", *args],
        env=env, capture_output=True, text=True,
    )


pytestmark = pytest.mark.skipif(not shutil.which("node"), reason="node is required")


def test_runs_npm_ci_once_per_locked_extension_and_skips_dependency_free(tmp_path):
    repo = _make_repo(tmp_path, {"bundles": {"yaml": "^2"}, "browser": {"patchright": "^1"}, "plain": None})
    bindir, log = _fake_npm(tmp_path)
    result = _install(repo, _env(tmp_path, bindir))
    assert result.returncode == 0, result.stderr
    calls = [line.split("\t") for line in log.read_text().splitlines()]
    assert sorted(Path(c[0]).name for c in calls) == ["browser", "bundles"]
    for _cwd, argv in calls:
        assert argv.startswith("ci --ignore-scripts")
    assert "Extension dependencies installed" in result.stdout


def test_stops_when_npm_fails(tmp_path):
    repo = _make_repo(tmp_path, {"bundles": {"yaml": "^2"}})
    bindir, _log = _fake_npm(tmp_path, fail=True)
    result = _install(repo, _env(tmp_path, bindir))
    assert result.returncode != 0
    assert "npm ci failed" in result.stderr
    assert "pi-shared installed" not in result.stdout
    # Installer must not have wired settings before dependencies were healthy.
    assert not (tmp_path / "home" / ".pi" / "agent" / "settings.json").exists()


def _no_npm_env(tmp_path: Path) -> dict:
    # node ships next to the real npm, so hide npm via the supported override
    # rather than relying on PATH ordering.
    bindir = tmp_path / "emptybin"
    bindir.mkdir()
    return {**_env(tmp_path, bindir), "PI_SHARED_NPM": "npm-does-not-exist"}


def test_fails_clearly_when_npm_missing(tmp_path):
    repo = _make_repo(tmp_path, {"bundles": {"yaml": "^2"}})
    result = _install(repo, _no_npm_env(tmp_path))
    assert result.returncode != 0
    assert "npm is required" in result.stderr


def test_no_npm_needed_when_no_locked_extensions(tmp_path):
    repo = _make_repo(tmp_path, {"plain": None})
    result = _install(repo, _no_npm_env(tmp_path))
    assert result.returncode == 0, result.stderr


def test_idempotent_second_run(tmp_path):
    repo = _make_repo(tmp_path, {"bundles": {"yaml": "^2"}})
    bindir, log = _fake_npm(tmp_path)
    env = _env(tmp_path, bindir)
    assert _install(repo, env).returncode == 0
    assert _install(repo, env).returncode == 0
    assert len(log.read_text().splitlines()) == 2  # one npm ci per run, deterministic


def test_no_deps_flag_skips_phase(tmp_path):
    repo = _make_repo(tmp_path, {"bundles": {"yaml": "^2"}})
    result = _install(repo, _no_npm_env(tmp_path), "--no-deps")
    assert result.returncode == 0, result.stderr


def test_check_deps_detects_unresolvable_dependency(tmp_path):
    repo = _make_repo(tmp_path, {"bundles": {"yaml": "^2"}})
    (repo / "extensions" / "bundles" / "node_modules").mkdir()  # present but empty
    result = subprocess.run(
        [str(repo / "bin" / "pi-shared-check-deps"), str(repo / "extensions")],
        capture_output=True, text=True,
    )
    assert result.returncode == 1
    assert "cannot resolve yaml" in result.stderr
    assert "npm ci --ignore-scripts" in result.stderr


def test_check_deps_reports_real_checkout_state():
    """Runs the real checker; passes only if this checkout has its deps installed,
    otherwise skips (a fresh clone before ./install.sh is a legitimate state)."""
    result = subprocess.run([str(SHARED_ROOT / "bin" / "pi-shared-check-deps")], capture_output=True, text=True)
    if result.returncode != 0:
        pytest.skip(f"extension deps not installed in this checkout:\n{result.stderr}")
    assert "ok    integration-bundles -> yaml" in result.stdout
