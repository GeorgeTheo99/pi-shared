"""Real-SDK failure probes plus isolated generated-profile wiring tests."""
import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]
PROBE = ROOT / "bin/pi-profile-check"


def invoke(tmp_path, *, code=None, settings=None, args=(), env_extra=None):
    home = tmp_path / "home"
    agent = home / ".pi/agent"
    agent.mkdir(parents=True, exist_ok=True)
    extension = tmp_path / "extension.ts"
    extension.write_text(code or "export default function () {}")
    (agent / "settings.json").write_text(json.dumps(settings or {"extensions": [str(extension)]}))
    env = {**os.environ, "HOME": str(home), "PI_OFFLINE": "1"}
    if env_extra:
        env.update(env_extra)
    return subprocess.run([str(PROBE), "--agent-dir", str(agent), *args], env=env,
                          capture_output=True, text=True, timeout=90)


@pytest.mark.skipif(not shutil.which("pi") or not shutil.which("node"), reason="requires installed Pi SDK + Node")
def test_real_sdk_accepts_healthy_extension_and_rejects_throw(tmp_path):
    good = invoke(tmp_path)
    assert good.returncode == 0, good.stderr
    assert "1 extensions imported" in good.stdout
    bad = invoke(tmp_path, code='export default function () { throw new Error("PROBE_BROKEN"); }')
    assert bad.returncode == 1
    assert "PROBE_BROKEN" in bad.stderr


@pytest.mark.skipif(not shutil.which("pi") or not shutil.which("node"), reason="requires installed Pi SDK + Node")
def test_required_package_not_loaded_is_failure(tmp_path):
    package = tmp_path / "required-package"
    package.mkdir()
    result = invoke(tmp_path, args=["--expect-package", str(package)])
    assert result.returncode == 1
    assert "No extensions loaded from required package" in result.stderr


def test_missing_models_never_passes(tmp_path):
    result = invoke(tmp_path, args=["--require-models"])
    assert result.returncode == 1
    assert "Missing model catalog" in result.stderr


@pytest.mark.skipif(not shutil.which("node"), reason="requires Node")
@pytest.mark.parametrize("module, message", [
    ("process.exit(42);", "exited 42 without"),
    ("process.exit(0);", "exited 0 without"),
    ("await new Promise(() => setInterval(() => {}, 1000));", "timed out"),
])
def test_bad_process_or_timeout_cannot_fake_readiness(tmp_path, module, message):
    sdk = tmp_path / "sdk"
    sdk.mkdir()
    (sdk / "package.json").write_text(json.dumps({"name": "@earendil-works/pi-coding-agent", "main": "index.mjs"}))
    (sdk / "index.mjs").write_text(module)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    pi = bin_dir / "pi"
    pi.write_text("#!/bin/sh\nexit 0\n")
    pi.chmod(0o755)
    result = invoke(tmp_path, args=["--timeout", "1"], env_extra={
        "PI_INSTALL_DIR": str(sdk), "PATH": str(bin_dir) + os.pathsep + os.environ["PATH"]})
    assert result.returncode == 1
    assert message in result.stderr


def test_installer_wires_both_profiles_without_user_bin_on_path(tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    overlay = tmp_path / "overlay"
    overlay.mkdir()
    (overlay / "package.json").write_text(json.dumps({"name": "overlay", "pi": {"extensions": ["./extensions"]}}))
    aliases = tmp_path / "aliases.json"
    aliases.write_text(json.dumps({"cloud:test": {"alias": "test", "name": "test", "provider": "cloud", "provider_model_id": "test"}}))
    paths = [str(Path(shutil.which("python3")).parent), "/usr/bin", "/bin"]
    env = {**os.environ, "HOME": str(home), "PATH": os.pathsep.join(paths)}
    args = [str(ROOT / "bin/pi-shared-install"), "--no-deps", "--aliases", str(aliases), "--overlay", str(overlay)]
    for _ in range(2):
        result = subprocess.run(args, env=env, capture_output=True, text=True, timeout=30)
        assert result.returncode == 0, result.stderr
    for profile in (home / ".pi/agent", home / ".pi-omlx/agent"):
        settings = json.loads((profile / "settings.json").read_text())
        packages = [(profile / value).resolve() for value in settings["packages"]]
        assert packages == [ROOT.resolve(), overlay.resolve()]
        assert (profile / "AGENTS.md").is_symlink()
    launcher = home / ".pi/generated/pi-launchers.zsh"
    before = (home / ".pi-omlx/agent/settings.json").read_bytes()
    result = subprocess.run(["zsh", "-f", "-c", 'source "$1"; whence -w pi-list', "test", str(launcher)],
                            env=env, capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
    assert "function" in result.stdout
    assert (home / ".pi-omlx/agent/settings.json").read_bytes() == before
    assert str(ROOT / "bin/pi-omlx-repair") in launcher.read_text()
    assert "pi-omlx-repair >/dev/null 2>&1 || true" not in launcher.read_text()


@pytest.mark.skipif(not shutil.which("node"), reason="requires Node")
def test_explicit_sdk_directory_does_not_require_pi_executable(tmp_path):
    sdk = tmp_path / "sdk"
    sdk.mkdir()
    (sdk / "package.json").write_text(json.dumps({"name": "@earendil-works/pi-coding-agent", "main": "index.mjs"}))
    (sdk / "index.mjs").write_text('''
export const SettingsManager = { create: () => ({drainErrors: () => []}) };
export class DefaultResourceLoader {
  async reload() {}
  getExtensions() { return {errors: [], extensions: []}; }
}
''')
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "node").symlink_to(Path(shutil.which("node")).resolve())
    (bin_dir / "python3").symlink_to(Path(shutil.which("python3")).resolve())
    result = invoke(tmp_path, env_extra={"PI_INSTALL_DIR": str(sdk), "PATH": str(bin_dir) + ":/usr/bin:/bin"})
    assert result.returncode == 0, result.stderr
