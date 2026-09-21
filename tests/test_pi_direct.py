"""Native-only bootstrap must not depend on a gateway catalog, profile or service."""
import json
import subprocess

import pytest

from test_pi_cli import ROOT, invocation, launch, machine, render


def install_direct(machine, *args, **env):
    return subprocess.run(
        [str(ROOT / "bin/pi-shared-install"), "--no-deps", *args],
        env=dict(machine["env"], PI_SHARED_DIRECT_ONLY="1", PI_SHARED_BOOTSTRAP_LAUNCHERS="1",
                 PI_SHARED_CLI_OUT=str(machine["config"]), **env),
        capture_output=True, text=True, timeout=30,
    )


def test_direct_install_ignores_catalog_and_preserves_native_models(machine):
    home = machine["home"]
    (home / ".pi-omlx/agent").rmdir()
    (home / ".pi-omlx").rmdir()
    native = home / ".pi/agent"
    native.mkdir()
    models = native / "models.json"
    models.write_text('{"providers":{"custom":{"apiKey":"$CUSTOM_KEY"}}}')
    settings = native / "settings.json"
    settings.write_text('{"defaultProvider":"zai","defaultModel":"native-model"}')
    before = models.read_bytes()
    # Neither a stale/malformed catalog nor future gateway changes can affect direct routes.
    aliases = home / ".pi/model-aliases.json"
    aliases.write_text("not even JSON")
    result = install_direct(machine)
    assert result.returncode == 0, result.stderr
    assert not (home / ".pi-omlx").exists()
    assert models.read_bytes() == before
    assert json.loads(settings.read_text())["defaultProvider"] == "zai"
    assert not (home / ".zshrc").exists()
    config = json.loads(machine["config"].read_text())
    assert config["generation"]["args"] == ["--direct-only", "--shared-dir", str(ROOT), "--direct-launchers"]
    assert set(config["routes"]) == {"openai"}
    for args in [("models",), ("--launcher-check",), ("--launcher-refresh",)]:
        check = launch(machine, *args, upstream=False)
        assert check.returncode == 0, check.stderr
    assert models.read_bytes() == before
    inv = invocation(launch(machine, "--provider", "zai", "--model", "native-model"))
    assert inv["argv"] == ["--provider", "zai", "--model", "native-model"]
    assert inv["env"]["PI_CODING_AGENT_DIR"] is None
    assert invocation(launch(machine, "openai"))["argv"][0:2] == ["--provider", "openai-codex"]
    assert not (home / ".pi-omlx").exists()
    assert install_direct(machine).returncode == 0
    assert models.read_bytes() == before


def test_direct_defaults_and_opt_out_survive_reinitialization(machine):
    assert install_direct(machine).returncode == 0
    assert launch(machine, "openai", "--default").returncode == 0
    settings = machine["home"] / ".pi/agent/settings.json"
    before = settings.read_bytes()
    assert install_direct(machine, "--no-direct-launchers").returncode == 0
    assert install_direct(machine).returncode == 0
    assert settings.read_bytes() == before
    assert json.loads(machine["config"].read_text())["routes"] == {}
    assert launch(machine, "--launcher-check", upstream=False).returncode == 0
    assert invocation(launch(machine))["argv"] == []


def test_direct_preflight_has_no_writes(machine):
    before = set(machine["home"].rglob("*"))
    result = launch(machine, "--launcher-check-direct", upstream=False)
    assert result.returncode == 0, result.stderr
    assert set(machine["home"].rglob("*")) == before


@pytest.mark.parametrize("configured", [True, False])
def test_direct_refuses_existing_gateway_or_bootstrap_launcher(machine, configured):
    if not configured:
        machine["aliases"].unlink()
    assert render(machine, "--allow-empty-catalog").returncode == 0
    before = machine["config"].read_bytes()
    result = install_direct(machine)
    assert result.returncode != 0
    assert "not direct-only" in result.stderr
    assert machine["config"].read_bytes() == before
    assert not (machine["home"] / ".local/bin").exists()


def test_direct_refuses_legacy_without_executing_or_rewriting(machine):
    legacy = machine["home"] / ".pi/generated/pi-launchers.zsh"
    legacy.parent.mkdir()
    body = "exit 99\n"
    legacy.write_text(body)
    result = install_direct(machine)
    assert result.returncode != 0 and "legacy launcher" in result.stderr
    assert legacy.read_text() == body
    assert not machine["config"].exists()
    assert not (machine["home"] / ".local/bin").exists()


@pytest.mark.parametrize("args", [("--no-catalog",), ("--aliases", "/unused"), ("--pi-agent-dir", "/unused")])
def test_direct_rejects_gateway_overrides_before_writes(machine, args):
    result = install_direct(machine, *args)
    assert result.returncode != 0
    assert not machine["config"].exists()
    assert not (machine["home"] / ".local/bin").exists()


def test_direct_launch_preserves_api_key_for_explicit_native_provider(machine):
    assert install_direct(machine).returncode == 0
    inv = invocation(launch(machine, "--provider", "openai", "--model", "native-model",
                            env_extra={"OPENAI_API_KEY": "test-key"}))
    assert inv["env"]["OPENAI_API_KEY"] == "test-key"


def test_mixed_launcher_direct_preset_works_without_gateway_service(machine):
    assert render(machine, "--direct-launchers").returncode == 0
    result = launch(machine, "openai")
    assert result.returncode == 0, result.stderr
    assert invocation(result)["argv"][0:2] == ["--provider", "openai-codex"]


@pytest.mark.parametrize("mutation", ["generation", "route", "default"])
def test_direct_config_rejects_gateway_metadata(machine, mutation):
    assert install_direct(machine).returncode == 0
    config = json.loads(machine["config"].read_text())
    if mutation == "generation":
        config["generation"]["args"] += ["--aliases", str(machine["aliases"])]
    elif mutation == "route":
        config["routes"]["openai"]["gateway"] = True
    else:
        config["defaultProfile"] = str(machine["home"] / ".pi-omlx/agent")
    machine["config"].write_text(json.dumps(config))
    result = launch(machine, "--launcher-check", upstream=False)
    assert result.returncode != 0 and "Direct-only" in result.stderr
