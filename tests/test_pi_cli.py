"""Hermetic tests for the unified pi-launch CLI (lib/pi_cli.py) and the
pi-catalog --cli-out generator that feeds it.

No test starts a real Pi session or calls a provider: the stock executable is a
Python stub that only echoes argv/env, PI_UPSTREAM_BIN points at that stub, and
HOME is redirected into a temp dir so profile repair (if any) is contained.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "lib/pi_catalog.py"
LAUNCH = ROOT / "bin/pi-launch"

ALIASES = {
    "cloud:test": {"name": "Test", "alias": "test", "provider": "openai", "provider_model_id": "test-1"},
    "cloud:other": {"name": "Other", "alias": "other", "provider": "openai", "provider_model_id": "other-2"},
}


@pytest.fixture
def machine(tmp_path):
    home = tmp_path / "home"
    (home / ".pi").mkdir(parents=True)
    (home / ".pi-omlx/agent").mkdir(parents=True)
    aliases = tmp_path / "aliases.json"
    aliases.write_text(json.dumps(ALIASES))
    config = home / ".pi/launcher.json"
    # A stub "stock Pi" that echoes argv + a few env vars and never runs a model.
    upstream = tmp_path / "pi-upstream"
    upstream.write_text(
        f"#!{sys.executable}\n"
        "import json, os, sys\n"
        "print(json.dumps({'argv': sys.argv[1:], 'env': {k: os.environ.get(k) "
        "for k in ('PI_CODING_AGENT_DIR', 'OPENAI_API_KEY', 'OPENAI_BASE_URL')}}))\n"
    )
    upstream.chmod(0o755)
    env = {k: v for k, v in os.environ.items() if not k.startswith("PI_")}
    env.update(HOME=str(home), PI_LAUNCHER_CONFIG=str(config), PI_UPSTREAM_BIN=str(upstream))
    return {"home": home, "aliases": aliases, "config": config, "upstream": str(upstream), "env": env}


def render(machine, *args, cli_out=True, launchers=False, **overrides):
    cmd = [sys.executable, str(CATALOG), "--aliases", str(machine["aliases"]),
           "--models-out", str(machine["home"] / ".pi-omlx/agent/models.json"),
           "--provider-name", overrides.get("provider", "model-gateway"),
           "--pi-agent-dir", str(machine["home"] / ".pi-omlx/agent")]
    if cli_out:
        cmd += ["--cli-out", str(machine["config"])]
    if launchers:
        cmd += ["--launchers-out", str(machine["home"] / ".pi/generated/pi-launchers.zsh")]
    cmd += list(args)
    return subprocess.run(cmd, env=machine["env"], capture_output=True, text=True, timeout=30)


def launch(machine, *argv, env_extra=None, upstream=True):
    env = dict(machine["env"])
    if not upstream:
        env.pop("PI_UPSTREAM_BIN", None)
    if env_extra:
        env.update(env_extra)
    return subprocess.run([sys.executable, str(LAUNCH), *argv], env=env, capture_output=True, text=True, timeout=30)


def invocation(result):
    return json.loads(result.stdout.splitlines()[-1])


# --- generation ------------------------------------------------------------

def test_cli_out_generates_expected_schema(machine):
    assert render(machine, "--no-direct-launchers").returncode == 0
    config = json.loads(machine["config"].read_text())
    assert config["version"] == 1
    assert config["defaultProfile"] is None
    assert set(config["routes"]) == {"other", "test"}
    route = config["routes"]["test"]
    assert route == {"provider": "model-gateway", "model": "test-1",
                     "profile": str(machine["home"] / ".pi-omlx/agent"), "gateway": True}
    assert set(config["generation"]) == {"args", "status", "modelsSha256", "aliasesSha256"}
    assert len(config["generation"]["modelsSha256"]) == 64


def test_direct_launchers_add_openai_subscription_route(machine):
    assert render(machine, "--direct-launchers").returncode == 0
    routes = json.loads(machine["config"].read_text())["routes"]
    assert routes["openai"] == {"provider": "openai-codex", "model": "gpt-6-astra",
                                "profile": None, "gateway": False}
    assert render(machine, "--no-direct-launchers").returncode == 0
    assert "openai" not in json.loads(machine["config"].read_text())["routes"]


def test_cli_and_zsh_render_identical_routes(machine):
    assert render(machine, "--direct-launchers", launchers=True).returncode == 0
    zsh = (machine["home"] / ".pi/generated/pi-launchers.zsh").read_text()
    routes = json.loads(machine["config"].read_text())["routes"]
    for alias in ("test", "other"):
        assert f"\npi-{alias}() {{" in zsh and alias in routes


# --- argv routing ----------------------------------------------------------

def test_exact_alias_injects_provider_and_model_before_user_args(machine):
    assert render(machine).returncode == 0
    inv = invocation(launch(machine, "test", "hello", "--thinking", "high"))
    assert inv["argv"] == ["--provider", "model-gateway", "--model", "test-1",
                           "hello", "--thinking", "high"]


def test_unknown_positional_prompt_passes_through_unchanged(machine):
    assert render(machine).returncode == 0
    inv = invocation(launch(machine, "explain this file"))
    assert inv["argv"] == ["explain this file"]


def test_double_dash_literal_bypasses_alias_resolution(machine):
    assert render(machine).returncode == 0
    inv = invocation(launch(machine, "--", "test"))
    assert inv["argv"] == ["--", "test"]  # 'test' stays a literal prompt, not the route


def test_stock_command_is_never_intercepted(machine):
    assert render(machine).returncode == 0
    for command in ("list", "help", "version"):
        inv = invocation(launch(machine, command))
        assert inv["argv"] == [command]


def test_explicit_model_wins_over_alias_and_skips_profile_switch(machine):
    assert render(machine).returncode == 0
    # The alias is still selected (consumed), but an explicit --provider/--model
    # wins over the route's injection and suppresses the implicit profile switch.
    inv = invocation(launch(machine, "test", "--provider", "x", "--model", "y"))
    assert inv["argv"] == ["--provider", "x", "--model", "y"]
    assert inv["env"]["PI_CODING_AGENT_DIR"] is None


def test_openai_preset_unsets_api_key_env(machine):
    assert render(machine, "--direct-launchers").returncode == 0
    inv = invocation(launch(machine, "openai", env_extra={
        "OPENAI_API_KEY": "secret", "OPENAI_BASE_URL": "https://invalid.example"}))
    assert inv["argv"] == ["--provider", "openai-codex", "--model", "gpt-6-astra"]
    assert inv["env"]["OPENAI_API_KEY"] is None and inv["env"]["OPENAI_BASE_URL"] is None


# --- defaults + save -------------------------------------------------------

def test_default_saves_settings_and_default_profile_then_exits(machine):
    assert render(machine).returncode == 0
    result = launch(machine, "test", "--default")
    assert result.returncode == 0 and "Saved Pi default" in result.stderr
    assert not result.stdout  # save + exit, no upstream exec
    settings = json.loads((machine["home"] / ".pi-omlx/agent/settings.json").read_text())
    assert settings == {"defaultProvider": "model-gateway", "defaultModel": "test-1"}
    assert json.loads(machine["config"].read_text())["defaultProfile"] == str(machine["home"] / ".pi-omlx/agent")
    # A later plain invocation adopts the saved default profile.
    inv = invocation(launch(machine, "explain"))
    assert inv["env"]["PI_CODING_AGENT_DIR"] == str(machine["home"] / ".pi-omlx/agent")


def test_default_must_be_alone_after_an_alias(machine):
    assert render(machine).returncode == 0
    result = launch(machine, "test", "--default", "--thinking", "high")
    assert result.returncode == 1 and "--default must be used alone" in result.stderr


def test_explicit_profile_env_is_respected_and_not_persisted(machine):
    assert render(machine).returncode == 0
    other = machine["home"] / "explicit-profile"
    other.mkdir()
    result = launch(machine, "test", "--default", env_extra={"PI_CODING_AGENT_DIR": str(other)})
    assert result.returncode == 0
    # settings.json is saved into the explicit profile, but the config default is untouched.
    assert (other / "settings.json").is_file()
    assert json.loads(machine["config"].read_text())["defaultProfile"] is None


@pytest.mark.parametrize("flag", ["--resume", "--continue", "--session", "--fork"])
def test_session_flags_suppress_implicit_default_profile(machine, flag):
    assert render(machine).returncode == 0
    result = launch(machine, "test", "--default")
    assert result.returncode == 0
    inv = invocation(launch(machine, flag, "value"))
    assert inv["env"]["PI_CODING_AGENT_DIR"] is None


# --- read-only interfaces --------------------------------------------------

def test_launcher_check_and_list_work_without_upstream(machine):
    assert render(machine).returncode == 0
    check = launch(machine, "--launcher-check", upstream=False)
    assert check.returncode == 0 and "OK" in check.stdout
    listing = launch(machine, "--launcher-list", upstream=False)
    assert listing.returncode == 0
    assert "test\tmodel-gateway/test-1" in listing.stdout


def test_models_lists_aliases_offline_without_changing_defaults(machine):
    assert render(machine, "--direct-launchers").returncode == 0
    assert launch(machine, "test", "--default").returncode == 0
    before = machine["config"].read_bytes()
    listing = launch(machine, "models", upstream=False)
    assert listing.returncode == 0, listing.stderr
    assert listing.stdout == launch(machine, "--launcher-list", upstream=False).stdout
    assert "openai\topenai-codex/" in listing.stdout
    assert machine["config"].read_bytes() == before


def test_models_retires_old_colliding_alias_without_rejecting_config(machine):
    aliases = dict(ALIASES, **{"cloud:collision": {"alias": "models", "provider_model_id": "collision"}})
    machine["aliases"].write_text(json.dumps(aliases))
    assert render(machine).returncode == 0
    config = json.loads(machine["config"].read_text())
    assert "models" not in config["routes"]
    # Older generators allowed this alias; refreshing must remain possible.
    config["routes"]["models"] = dict(config["routes"]["test"])
    machine["config"].write_text(json.dumps(config))
    result = launch(machine, "models", upstream=False)
    assert result.returncode == 0, result.stderr
    assert "models\t" not in result.stdout
    assert "models" not in json.loads(machine["config"].read_text())["routes"]


@pytest.mark.parametrize("args", [("--", "models"), ("--system-prompt", "models")])
def test_models_literal_or_option_value_passes_through(machine, args):
    assert invocation(launch(machine, *args))["argv"] == list(args)


@pytest.mark.parametrize("flag", ["-h", "--help"])
def test_models_help_works_without_config(machine, flag):
    result = launch(machine, "models", flag, upstream=False)
    assert result.returncode == 0 and "pi models" in result.stdout


def test_models_extra_args_are_not_sent_to_upstream(machine):
    result = launch(machine, "models", "unexpected")
    assert result.returncode == 1 and "Usage: pi models" in result.stderr
    assert not result.stdout


@pytest.mark.parametrize("mode", ["models", "--launcher-check", "--launcher-list", "--launcher-refresh"])
def test_read_only_modes_fail_when_cli_mode_unconfigured(machine, mode):
    assert not machine["config"].exists()
    result = launch(machine, mode, upstream=False)
    assert result.returncode == 1 and "not configured" in result.stderr


def test_launcher_help_needs_no_config_or_upstream(machine):
    result = launch(machine, "--launcher-help", upstream=False)
    assert result.returncode == 0 and "exact-alias" in result.stdout


def test_launcher_refresh_is_offline_and_idempotent(machine):
    assert render(machine).returncode == 0
    before = machine["config"].read_bytes()
    result = launch(machine, "--launcher-refresh", upstream=False)
    assert result.returncode == 0
    assert machine["config"].read_bytes() == before


def test_launcher_refresh_adds_new_alias_from_catalog(machine):
    assert render(machine).returncode == 0
    aliases = dict(ALIASES, **{"cloud:fresh": {"alias": "fresh", "name": "Fresh", "provider_model_id": "fresh-9"}})
    machine["aliases"].write_text(json.dumps(aliases))
    assert launch(machine, "--launcher-refresh", upstream=False).returncode == 0
    assert "fresh" in json.loads(machine["config"].read_text())["routes"]


# --- status digest + models protection -------------------------------------

def test_status_hints_are_captured_and_reused(machine):
    machine["aliases"].write_text(json.dumps({"qwen": {"alias": "qwen", "omlx_id": "qwen"}}))
    cache = machine["home"] / "observed.json"
    cache.write_text(json.dumps({"models": [{"id": "qwen", "max_context_window": 4242, "thinking_default": True}]}))
    assert render(machine, "--offline", "--status-cache", str(cache)).returncode == 0
    status = json.loads(machine["config"].read_text())["generation"]["status"]
    assert status["qwen"] == {"max_context_window": 4242, "thinking_default": True}


def test_manual_models_edit_pauses_refresh(machine):
    assert render(machine).returncode == 0
    models = machine["home"] / ".pi-omlx/agent/models.json"
    models.write_text(json.dumps({"providers": {"model-gateway": {"apiKey": "hand-edited"}}}))
    result = launch(machine, "--launcher-refresh", upstream=False)
    assert result.returncode == 1 and "edited" in result.stderr
    assert "hand-edited" in models.read_text()


# --- migration -------------------------------------------------------------

def test_migrate_legacy_launcher_preserves_identity_without_shell(machine):
    zsh = machine["home"] / ".pi/generated/pi-launchers.zsh"
    assert render(machine, "--no-direct-launchers", cli_out=False, launchers=True).returncode == 0
    sentinel = machine["home"] / "never-run"
    zsh.write_text(zsh.read_text() + f"\ntouch {sentinel}\n")  # shell side effect must never fire
    result = launch(machine, "--launcher-migrate", str(zsh), upstream=False)
    assert result.returncode == 0, result.stderr
    assert not sentinel.exists()
    config = json.loads(machine["config"].read_text())
    assert set(config["routes"]) == {"other", "test"}
    assert config["routes"]["test"]["profile"] == str(machine["home"] / ".pi-omlx/agent")
    # Recorded digest lets the migrated config verify without immediate drift.
    assert launch(machine, "--launcher-check", upstream=False).returncode == 0


def test_migrate_refuses_to_clobber_existing_config(machine):
    assert render(machine, launchers=True).returncode == 0
    zsh = machine["home"] / ".pi/generated/pi-launchers.zsh"
    result = launch(machine, "--launcher-migrate", str(zsh), upstream=False)
    assert result.returncode == 1 and "Refusing to overwrite" in result.stderr


def test_migrate_rejects_unrecognized_launcher(machine):
    fake = machine["home"] / "custom.zsh"
    fake.write_text("# hand-written\npi-test() { : ; }\n")
    result = launch(machine, "--launcher-migrate", str(fake), upstream=False)
    assert result.returncode == 1 and "recognized JSON metadata" in result.stderr


# --- robustness ------------------------------------------------------------

@pytest.mark.parametrize("body", ["", "{bad json", "[]", '{"version": 2}',
                                  '{"version": 1, "routes": {}}'])
def test_broken_config_fails_alias_routing_but_never_writes(machine, body):
    machine["config"].write_text(body)
    result = launch(machine, "test")
    assert result.returncode == 1
    assert machine["config"].read_text() == body


@pytest.mark.parametrize("body", ["", "{bad json", "[]", '{"version": 2}'])
def test_broken_config_does_not_block_stock_utilities(machine, body):
    machine["config"].write_text(body)
    inv = invocation(launch(machine, "--version"))
    assert inv["argv"] == ["--version"]


def test_missing_config_passes_argv_through_untouched(machine):
    assert not machine["config"].exists()
    inv = invocation(launch(machine, "anything"))
    assert inv["argv"] == ["anything"]


def test_reserved_alias_is_rejected_at_generation(machine):
    machine["aliases"].write_text(json.dumps({"cloud:x": {"alias": "list", "provider_model_id": "x"}}))
    result = render(machine)
    assert result.returncode != 0
    assert not machine["config"].exists()


@pytest.mark.parametrize("value", ["", "/nonexistent/pi", str(LAUNCH)])
def test_bad_or_recursive_upstream_is_rejected(machine, value):
    assert render(machine).returncode == 0
    result = launch(machine, "test", env_extra={"PI_UPSTREAM_BIN": value})
    assert result.returncode == 1
    lowered = result.stderr.lower()
    assert "pi_upstream_bin" in lowered or "recursive" in lowered


def test_no_launch_active_guard_leaks_to_subagents(machine):
    # The launcher must not export a recursion guard into the child environment;
    # a spawned subagent that runs `pi` again would otherwise be wrongly blocked.
    assert render(machine).returncode == 0
    result = launch(machine, "test")
    assert result.returncode == 0
    inv = invocation(result)
    assert "PI_LAUNCH_ACTIVE" not in json.dumps(inv["env"])
    # And PI_LAUNCH_ACTIVE=1 in the parent env must not break resolution.
    assert launch(machine, "test", env_extra={"PI_LAUNCH_ACTIVE": "1"}).returncode == 0


def test_saved_defaults_and_direct_preference_survive_catalog_regeneration(machine):
    assert render(machine, "--direct-launchers").returncode == 0
    assert launch(machine, "test", "--default").returncode == 0
    assert render(machine).returncode == 0
    config = json.loads(machine["config"].read_text())
    assert config["defaultProfile"] == str(machine["home"] / ".pi-omlx/agent")
    assert "openai" in config["routes"]
    inv = invocation(launch(machine, "--mode", "json"))
    assert inv["env"]["PI_CODING_AGENT_DIR"] == config["defaultProfile"]
    assert inv["argv"] == ["--mode", "json"]


def test_bootstrap_remembers_future_models_output_and_accepts_first_catalog(machine):
    machine["aliases"].unlink()
    result = render(machine, "--allow-empty-catalog", "--direct-launchers")
    assert result.returncode == 0, result.stderr
    assert launch(machine, "--launcher-check", upstream=False).returncode == 0
    machine["aliases"].write_text(json.dumps(ALIASES))
    result = launch(machine, "--launcher-refresh", upstream=False)
    assert result.returncode == 0, result.stderr
    assert (machine["home"] / ".pi-omlx/agent/models.json").exists()
    assert "test" in json.loads(machine["config"].read_text())["routes"]


def test_cli_catalog_refuses_empty_replacement_of_configured_routes(machine):
    assert render(machine).returncode == 0
    before = machine["config"].read_bytes()
    machine["aliases"].write_text("{}")
    result = render(machine, "--allow-empty-catalog")
    assert result.returncode != 0
    assert machine["config"].read_bytes() == before


def install_cli(machine):
    return subprocess.run([str(ROOT / "bin/pi-shared-install"), "--no-deps", "--bootstrap-launchers",
        "--cli-out", str(machine["config"]), "--aliases", str(machine["aliases"])],
        env=machine["env"], capture_output=True, text=True, timeout=30)


def test_cli_installer_generates_no_shell_and_preserves_saved_defaults_on_rerun(machine):
    result = install_cli(machine)
    assert result.returncode == 0, result.stderr
    assert machine["config"].is_file()
    assert not (machine["home"] / ".pi/generated/pi-launchers.zsh").exists()
    assert "source the generated" not in result.stdout
    assert launch(machine, "test", "--default").returncode == 0
    before = json.loads(machine["config"].read_text())["defaultProfile"]
    assert install_cli(machine).returncode == 0
    assert json.loads(machine["config"].read_text())["defaultProfile"] == before


def test_cli_installer_explicit_overlay_aliases_replace_bootstrap_input(machine):
    original = machine["aliases"]
    original.unlink()
    assert render(machine, "--allow-empty-catalog", "--direct-launchers").returncode == 0
    machine["aliases"] = machine["home"] / ".pi/enterprise-aliases.json"
    machine["aliases"].write_text(json.dumps(ALIASES))
    result = install_cli(machine)
    assert result.returncode == 0, result.stderr
    config = json.loads(machine["config"].read_text())
    assert "test" in config["routes"] and "openai" in config["routes"]
    assert str(machine["aliases"]) in config["generation"]["args"]
    assert str(original) not in config["generation"]["args"]
    assert launch(machine, "--launcher-check", upstream=False).returncode == 0


def test_cli_installer_migrates_legacy_without_rewriting_or_executing_shell(machine):
    assert render(machine, "--no-direct-launchers", cli_out=False, launchers=True, provider="original-provider").returncode == 0
    legacy = machine["home"] / ".pi/generated/pi-launchers.zsh"
    before = legacy.read_bytes()
    result = install_cli(machine)
    assert result.returncode == 0, result.stderr
    assert legacy.read_bytes() == before
    config = json.loads(machine["config"].read_text())
    assert config["routes"]["test"]["provider"] == "original-provider"
    assert "openai" not in config["routes"]
