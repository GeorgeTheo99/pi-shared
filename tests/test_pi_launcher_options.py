"""Portable launcher options, legacy migration, and per-machine isolation."""

from __future__ import annotations

import importlib.util
import json
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "lib/pi_catalog.py"


@pytest.fixture
def machine(tmp_path):
    home = tmp_path / "home"
    aliases = home / ".pi/model-aliases.json"
    aliases.parent.mkdir(parents=True)
    aliases.write_text(json.dumps({"cloud:test": {
        "name": "test", "alias": "test", "provider": "openai", "provider_model_id": "test",
    }}))
    env = {k: v for k, v in os.environ.items() if not k.startswith("PI_SHARED_")}
    env.update(HOME=str(home), PI_INSTALL_DIR=str(tmp_path / "absent-install"))
    return home, aliases, env


def run(*cmd, env):
    return subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=30)


def paths(machine):
    home, aliases, _ = machine
    return aliases, home / ".pi-omlx/agent/models.json", home / ".pi/generated/pi-launchers.zsh"


def render(machine, *args):
    aliases, models, launcher = paths(machine)
    return run(sys.executable, str(MODULE), "--aliases", str(aliases),
               "--models-out", str(models), "--launchers-out", str(launcher),
               *args, env=machine[2])


def install(machine, *args, extra_env=None):
    return run(str(ROOT / "bin/pi-shared-install"), "--no-deps", *args,
               env={**machine[2], **(extra_env or {})})


def assert_state(machine, enabled, provider="model-gateway"):
    _, models, launcher = paths(machine)
    assert list(json.loads(models.read_text())["providers"]) == [provider]
    text = launcher.read_text()
    assert ("\npi-openai() {\n" in text) is enabled
    assert ("\npi-default() {\n" in text) is enabled
    assert "--ls99-extras" not in text
    assert ("--direct-launchers" if enabled else "--no-direct-launchers") in text
    assert f"--provider-name {provider}" in text
    return text


def test_fresh_defaults_are_portable_and_opt_in(machine):
    result = render(machine)
    assert result.returncode == 0, result.stderr
    assert_state(machine, False)
    assert "ls99" not in paths(machine)[2].read_text()


@pytest.mark.parametrize("flag", ["--direct-launchers", "--ls99-extras"])
def test_canonical_and_legacy_flags_render_canonical_regen(machine, flag):
    result = render(machine, flag, "--provider-name", "ls99-models")
    assert result.returncode == 0, result.stderr
    text = assert_state(machine, True, "ls99-models")
    assert '-u PI_CODING_AGENT_DIR -u OPENAI_API_KEY -u OPENAI_BASE_URL' in text
    assert '--provider openai-codex --model gpt-6-astra --models "openai-codex/*"' in text
    assert render(machine, "--check").returncode == 0


@pytest.mark.skipif(not shutil.which("zsh"), reason="zsh is required")
@pytest.mark.parametrize("override", [[], ["--model", "gpt-5.5"]])
def test_openai_launcher_defaults_to_astra_and_preserves_explicit_override(machine, override):
    assert render(machine, "--direct-launchers").returncode == 0
    home, _, env = machine
    bin_dir = home / "bin"
    bin_dir.mkdir()
    stub = bin_dir / "pi"
    stub.write_text(f"#!{sys.executable}\n" + "import json, os, sys\n"
                    "print(json.dumps({'args': sys.argv[1:], 'env': {k: os.environ.get(k) "
                    "for k in ('PI_CODING_AGENT_DIR', 'OPENAI_API_KEY', 'OPENAI_BASE_URL')}}))\n")
    stub.chmod(0o755)
    result = run("zsh", "-f", "-c",
                 f"source {shlex.quote(str(paths(machine)[2]))}; pi-openai {shlex.join(override)}",
                 env={**env, "PATH": str(bin_dir) + os.pathsep + env.get("PATH", ""),
                      "PI_CODING_AGENT_DIR": "/unused-profile", "OPENAI_API_KEY": "test-only",
                      "OPENAI_BASE_URL": "https://invalid.example"})
    assert result.returncode == 0, result.stderr
    invocation = json.loads(result.stdout.splitlines()[-1])
    assert invocation["args"] == ["--provider", "openai-codex", "--model", "gpt-6-astra",
                                  "--models", "openai-codex/*", *override]
    assert all(value is None for value in invocation["env"].values())


def test_legacy_output_is_preserved_without_executing_it(machine):
    assert render(machine, "--ls99-extras", "--provider-name", "ls99-models").returncode == 0
    launcher = paths(machine)[2]
    marker = machine[0] / "must-not-exist"
    # Simulate old generated output with the original flag, plus a shell side effect.
    launcher.write_text(launcher.read_text().replace("--direct-launchers", "--ls99-extras")
                        + f"\ntouch {shlex.quote(str(marker))}\n")
    assert render(machine).returncode == 0
    assert not marker.exists()
    assert_state(machine, True, "ls99-models")


@pytest.mark.parametrize("flags,enabled", [
    (["--direct-launchers", "--no-direct-launchers"], False),
    (["--no-direct-launchers", "--direct-launchers"], True),
    (["--ls99-extras", "--no-direct-launchers"], False),
])
def test_last_cli_option_wins(machine, flags, enabled):
    assert render(machine, *flags).returncode == 0
    assert_state(machine, enabled)


@pytest.mark.skipif(not shutil.which("zsh"), reason="zsh is required")
def test_real_regen_preserves_options_and_can_disable_sourced_helpers(machine):
    assert render(machine, "--ls99-extras", "--provider-name", "ls99-models").returncode == 0
    text = assert_state(machine, True, "ls99-models")
    launcher = shlex.quote(str(paths(machine)[2]))
    result = run("zsh", "-f", "-c", f"source {launcher}; pi-regen --quiet; pi-regen --check", env=machine[2])
    assert result.returncode == 0, result.stderr
    assert paths(machine)[2].read_text() == text
    result = run("zsh", "-f", "-c", f"""
source {launcher}
pi-regen --no-direct-launchers --quiet || exit
source {launcher}
(( ! $+functions[pi-openai] && ! $+functions[pi-default] )) || exit 1
pi-regen --check
""", env=machine[2])
    assert result.returncode == 0, result.stderr
    assert_state(machine, False, "ls99-models")


@pytest.mark.parametrize("args,extra_env,enabled", [
    (["--direct-launchers"], {}, True),
    (["--ls99-extras"], {}, True),
    ([], {"PI_SHARED_DIRECT_LAUNCHERS": "1"}, True),
    ([], {"PI_SHARED_LS99_EXTRAS": "1"}, True),
    ([], {"PI_SHARED_LS99_EXTRAS": "1", "PI_SHARED_DIRECT_LAUNCHERS": "0"}, False),
    (["--direct-launchers"], {"PI_SHARED_DIRECT_LAUNCHERS": "0"}, True),
    (["--no-direct-launchers"], {"PI_SHARED_DIRECT_LAUNCHERS": "1"}, False),
])
def test_installer_flags_and_environment_precedence(machine, args, extra_env, enabled):
    result = install(machine, *args, extra_env=extra_env)
    assert result.returncode == 0, result.stderr
    assert_state(machine, enabled)


def test_plain_installer_rerun_preserves_legacy_provider_and_direct_launchers(machine):
    assert render(machine, "--ls99-extras", "--provider-name", "ls99-models").returncode == 0
    before_models = paths(machine)[1].read_bytes()
    for _ in range(2):
        result = install(machine)
        assert result.returncode == 0, result.stderr
        assert_state(machine, True, "ls99-models")
        assert paths(machine)[1].read_bytes() == before_models
    assert install(machine, "--no-direct-launchers").returncode == 0
    assert install(machine).returncode == 0
    assert_state(machine, False, "ls99-models")


@pytest.mark.parametrize("args,extra_env,canonical_present,enabled", [
    ([], {}, False, True),
    (["--no-direct-launchers"], {}, False, False),
    ([], {"PI_SHARED_DIRECT_LAUNCHERS": "0"}, False, False),
    ([], {}, True, False),
])
def test_legacy_path_migration_preserves_opt_in_without_overriding_choices(
    machine, args, extra_env, canonical_present, enabled,
):
    assert render(machine, "--ls99-extras", "--provider-name", "ls99-models").returncode == 0
    launcher = paths(machine)[2]
    legacy = machine[0] / ".pi/model-gateway/pi-launchers.zsh"
    legacy.parent.mkdir(parents=True)
    # Model old flag spelling and prove migration never sources shell content.
    marker = machine[0] / "must-not-exist"
    legacy.write_text(launcher.read_text().replace("--direct-launchers", "--ls99-extras")
                      + f"\ntouch {shlex.quote(str(marker))}\n")
    if canonical_present:
        assert render(machine, "--no-direct-launchers").returncode == 0
    else:
        launcher.unlink()
    result = install(machine, *args, extra_env=extra_env)
    assert result.returncode == 0, result.stderr
    assert_state(machine, enabled, "ls99-models")
    assert legacy.is_symlink() and legacy.resolve() == launcher.resolve()
    assert not marker.exists()


def test_invalid_installer_option_fails_before_writes(machine):
    result = install(machine, extra_env={"PI_SHARED_DIRECT_LAUNCHERS": "yes"})
    assert result.returncode != 0
    assert "must be 0 or 1" in result.stderr
    assert not paths(machine)[1].exists()
    assert not (machine[0] / ".pi/agent/settings.json").exists()


def test_unrecognized_launcher_is_not_used_to_infer_opt_in(machine):
    launcher = paths(machine)[2]
    launcher.parent.mkdir(parents=True)
    launcher.write_text("# custom file\npi-default() {\n}\npi-openai() {\n}\n")
    assert render(machine).returncode == 0
    assert_state(machine, False)


@pytest.mark.parametrize("content", ["{bad json", "[]", '{"providers": []}',
                                     '{"providers": {"a": {}, "b": {}}}'])
def test_bad_or_ambiguous_models_fail_without_writing_outputs(machine, content):
    assert render(machine).returncode == 0
    _, models, launcher = paths(machine)
    before = launcher.read_bytes()
    models.write_text(content)
    result = render(machine)
    assert result.returncode != 0
    assert models.read_text() == content
    assert launcher.read_bytes() == before


def test_explicit_provider_override_can_migrate_label(machine):
    assert render(machine, "--provider-name", "ls99-models").returncode == 0
    assert render(machine, "--provider-name", "model-gateway").returncode == 0
    assert_state(machine, False)


def test_existing_provider_is_read_through_models_symlink(machine):
    assert render(machine, "--provider-name", "ls99-models").returncode == 0
    models = paths(machine)[1]
    target = models.with_name("real-models.json")
    models.rename(target)
    models.symlink_to(target)
    assert render(machine, "--direct-launchers").returncode == 0
    assert models.is_symlink()
    assert_state(machine, True, "ls99-models")


def test_python_keyword_compatibility_and_neutral_defaults():
    spec = importlib.util.spec_from_file_location("pi_catalog_options", MODULE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    aliases = {"cloud:x": {"name": "x", "alias": "x", "provider_model_id": "x"}}
    assert list(module.render_models(aliases)["providers"]) == ["model-gateway"]
    assert module.render_launchers(aliases, direct_launchers=True) == module.render_launchers(aliases, ls99_extras=True)
    assert "\npi-openai() {\n" not in module.render_launchers(aliases, direct_launchers=False, ls99_extras=True)


@pytest.mark.skipif(not shutil.which("zsh"), reason="zsh is required")
def test_two_machines_regenerate_independently(tmp_path):
    fixtures = []
    for name, provider, port, enabled in [("laptop", "model-gateway", 19111, True),
                                          ("server", "ls99-models", 29111, False)]:
        home = tmp_path / name
        home.mkdir()
        aliases = home / "aliases.json"
        aliases.write_text(json.dumps({f"cloud:{name}": {
            "name": name, "alias": name, "provider_model_id": name,
        }}))
        fixture = (home, aliases, {**os.environ, "HOME": str(home)})
        result = render(fixture, "--provider-name", provider,
                        "--gateway-url", f"http://127.0.0.1:{port}",
                        "--pi-agent-dir", str(home / "agent"),
                        "--direct-launchers" if enabled else "--no-direct-launchers")
        assert result.returncode == 0, result.stderr
        fixtures.append((fixture, paths(fixture)[1].read_bytes(), paths(fixture)[2].read_bytes()))
    for fixture, models, launcher in fixtures:
        result = run("zsh", "-f", "-c", f"source {shlex.quote(str(paths(fixture)[2]))}; pi-regen --quiet", env=fixture[2])
        assert result.returncode == 0, result.stderr
        assert paths(fixture)[1].read_bytes() == models
        assert paths(fixture)[2].read_bytes() == launcher
        other = "server" if fixture[0].name == "laptop" else "laptop"
        assert str(tmp_path / other) not in paths(fixture)[2].read_text()
