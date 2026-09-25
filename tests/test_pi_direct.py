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


def install_combined(machine, *args, **env):
    return subprocess.run(
        [str(ROOT / "bin/pi-shared-install"), "--no-deps", *args],
        env={**machine["env"], "PI_SHARED_DIRECT_ONLY": "0", "PI_SHARED_ENABLE_GATEWAY": "1",
             "PI_SHARED_BOOTSTRAP_LAUNCHERS": "1", "PI_SHARED_ALIASES": str(machine["aliases"]),
             "PI_SHARED_CLI_OUT": str(machine["config"]), **env},
        capture_output=True, text=True, timeout=30,
    )


@pytest.mark.parametrize("shortcut", [True, False])
def test_add_gateway_preserves_native_configuration_and_is_idempotent(machine, shortcut):
    assert install_direct(machine, *([] if shortcut else ["--no-direct-launchers"])).returncode == 0
    native = machine["home"] / ".pi/agent"
    settings = native / "settings.json"
    original = json.loads(settings.read_text())
    original.update(defaultProvider="custom", defaultModel="native", theme="user-theme")
    settings.write_text(json.dumps(original))
    (native / "models.json").write_text('{"providers":{"custom":{"apiKey":"$USER_KEY"}}}')
    (native / "auth.json").write_text('{"custom":{"type":"api_key","key":"fixture-only"}}')
    saved = {path: path.read_bytes() for path in native.glob("*.json")}
    result = install_combined(machine)
    assert result.returncode == 0, result.stderr
    config = json.loads(machine["config"].read_text())
    assert "--direct-only" not in config["generation"]["args"]
    assert set(config["routes"]) == {"test", "other"} | ({"openai"} if shortcut else set())
    assert config["defaultProfile"] is None
    assert invocation(launch(machine))["env"]["PI_CODING_AGENT_DIR"] is None
    assert invocation(launch(machine, "--provider", "custom", "--model", "native"))["argv"] == [
        "--provider", "custom", "--model", "native"]
    for path, body in saved.items():
        assert json.loads(path.read_bytes()) == json.loads(body)
    gateway = machine["home"] / ".pi-omlx/agent"
    assert set(json.loads((gateway / "models.json").read_text())["providers"]) == {"model-gateway"}
    before = {path: path.read_bytes() for path in (machine["config"], gateway / "models.json", gateway / "settings.json")}
    result = install_combined(machine)
    assert result.returncode == 0, result.stderr
    assert all(path.read_bytes() == body for path, body in before.items())
    assert launch(machine, "--launcher-check", upstream=False).returncode == 0


@pytest.mark.parametrize("mutation", ["custom-route", "custom-field", "malformed", "catalog", "models", "empty-models", "models-link"])
def test_add_gateway_fails_before_writes_on_custom_or_malformed_inputs(machine, mutation):
    assert install_direct(machine).returncode == 0
    config = machine["config"]
    value = json.loads(config.read_text())
    models = machine["home"] / ".pi-omlx/agent/models.json"
    if mutation == "custom-route":
        value["routes"]["mine"] = dict(provider="custom", model="native", gateway=False, profile=None)
        config.write_text(json.dumps(value))
    elif mutation == "custom-field":
        value["userSetting"] = "retain"
        config.write_text(json.dumps(value))
    elif mutation == "malformed":
        config.write_text("invalid JSON")
    elif mutation == "catalog":
        machine["aliases"].write_text("[]")
    elif mutation == "models":
        models.write_text('{"providers":{"custom":{}}}')
    elif mutation == "empty-models":
        models.touch()
    else:
        models.symlink_to(machine["home"] / "missing-user-models.json")
    before = {p: p.read_bytes() for p in machine["home"].rglob("*") if p.is_file() and not p.is_symlink()}
    result = install_combined(machine)
    assert result.returncode != 0
    assert "Cannot safely add gateway routing" in result.stderr
    assert all(path.read_bytes() == body for path, body in before.items())
    assert not (machine["home"] / ".pi-omlx/agent/settings.json").exists()


def test_gateway_upgrade_requires_explicit_intent(machine):
    assert install_direct(machine).returncode == 0
    before = machine["config"].read_bytes()
    assert install_combined(machine, PI_SHARED_ENABLE_GATEWAY="0").returncode == 0
    assert machine["config"].read_bytes() == before
    assert not (machine["home"] / ".pi-omlx/agent/models.json").exists()
    assert install_combined(machine, "--enable-gateway", PI_SHARED_ENABLE_GATEWAY="0").returncode == 0
    assert "--direct-only" not in json.loads(machine["config"].read_text())["generation"]["args"]


def test_installer_help_advertises_gateway_upgrade_and_succeeds_without_writes(machine):
    before = set(machine["home"].rglob("*"))
    result = subprocess.run([str(ROOT / "bin/pi-shared-install"), "--help"],
                            env=machine["env"], capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
    assert "--enable-gateway" in result.stdout
    assert set(machine["home"].rglob("*")) == before
    result = subprocess.run([str(ROOT / "bin/pi-shared-install"), "--not-a-real-option"],
                            env=machine["env"], capture_output=True, text=True, timeout=10)
    assert result.returncode != 0
    assert "unknown argument" in result.stderr


def test_add_gateway_bootstrap_without_catalog_retains_native_routes(machine):
    assert install_direct(machine).returncode == 0
    machine["aliases"].unlink()
    result = install_combined(machine)
    assert result.returncode == 0, result.stderr
    config = json.loads(machine["config"].read_text())
    assert "--direct-only" not in config["generation"]["args"]
    assert "--models-out" in config["generation"]["args"]
    assert set(config["routes"]) == {"openai"}
    assert not (machine["home"] / ".pi-omlx/agent/models.json").exists()
    assert launch(machine, "--launcher-check", upstream=False).returncode == 0
