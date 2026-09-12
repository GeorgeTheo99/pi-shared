"""Automatic refresh never evaluates input shell text or performs network probes."""
import fcntl
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys

import pytest
from test_pi_launcher_options import machine, paths, render, run

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "bin/pi-launchers-refresh"
loader = importlib.machinery.SourceFileLoader("launcher_refresh", str(HELPER))
spec = importlib.util.spec_from_loader(loader.name, loader)
refresh = importlib.util.module_from_spec(spec); loader.exec_module(refresh)


def invoke(machine, *args):
    return run(sys.executable, str(HELPER), "--launcher", str(paths(machine)[2]), *args, env=machine[2])


def test_poll_skips_unchanged_files_and_refreshes_changed_catalog(machine):
    assert render(machine, "--direct-launchers").returncode == 0
    first = invoke(machine, "--poll", "")
    assert first.returncode == 0, first.stderr
    stamp = first.stdout.strip()
    assert len(stamp) == 64
    before = paths(machine)[2].stat().st_mtime_ns
    second = invoke(machine, "--poll", stamp)
    assert second.returncode == 0 and not second.stdout
    assert paths(machine)[2].stat().st_mtime_ns == before
    machine[1].write_text(json.dumps({"cloud:new": {"alias": "new", "name": "new", "provider_model_id": "new"}}))
    third = invoke(machine, "--poll", stamp)
    assert third.returncode == 0 and third.stdout.strip() != stamp
    assert "pi-new()" in paths(machine)[2].read_text()


def test_malformed_catalog_is_reported_once_without_sourcing_or_replacing_outputs(machine):
    assert render(machine).returncode == 0
    before = paths(machine)[2].read_bytes()
    machine[1].write_text("{bad json")
    first = invoke(machine, "--poll", "")
    assert first.returncode == 1 and "refresh failed" in first.stderr
    assert paths(machine)[2].read_bytes() == before
    second = invoke(machine, "--poll", first.stdout.strip())
    assert second.returncode == 0 and not second.stderr and not second.stdout


def test_manual_model_edits_are_preserved_and_warn_once(machine):
    assert render(machine).returncode == 0
    models = paths(machine)[1]
    data = json.loads(models.read_text())
    data["providers"]["model-gateway"]["apiKey"] = "private-model-preference"
    models.write_text(json.dumps(data))
    before_models, before_launcher = models.read_bytes(), paths(machine)[2].read_bytes()
    first = invoke(machine, "--poll", "")
    assert first.returncode == 1 and "paused" in first.stderr
    assert "private-model-preference" not in first.stdout + first.stderr
    assert models.read_bytes() == before_models and paths(machine)[2].read_bytes() == before_launcher
    again = invoke(machine, "--poll", first.stdout.strip())
    assert again.returncode == 0 and not again.stderr


def test_untrusted_shell_body_is_not_evaluated(machine):
    assert render(machine).returncode == 0
    launcher = paths(machine)[2]
    sentinel = machine[0] / "never-execute"
    launcher.write_text(launcher.read_text() + f"\ntouch {shlex.quote(str(sentinel))}\n")
    assert invoke(machine).returncode == 0
    assert not sentinel.exists()
    assert "never-execute" not in launcher.read_text()


@pytest.mark.parametrize("mutation", ["unknown-option", "wrong-output", "wrong-root", "duplicate-metadata", "world-writable"])
def test_invalid_or_unsafe_regeneration_metadata_fails_closed(machine, mutation):
    assert render(machine).returncode == 0
    launcher = paths(machine)[2]
    text = launcher.read_text()
    line = next(line for line in text.splitlines() if line.startswith(refresh.PREFIX))
    args = json.loads(line[len(refresh.PREFIX):])
    if mutation == "unknown-option": args += ["--evil"]
    elif mutation == "wrong-output": args[args.index("--launchers-out") + 1] = "/tmp/other-file"
    elif mutation == "wrong-root": args[args.index("--shared-dir") + 1] = "/tmp/other-root"
    if mutation == "duplicate-metadata": text += "\n" + line + "\n"
    else: text = text.replace(line, refresh.PREFIX + json.dumps(args))
    launcher.write_text(text)
    if mutation == "world-writable": launcher.chmod(0o666)
    before = launcher.read_bytes()
    result = invoke(machine)
    assert result.returncode == 1
    assert launcher.read_bytes() == before


def test_refresh_forces_offline_and_does_not_print_credentials(machine, monkeypatch, capsys):
    assert render(machine, "--gateway-api-key", "synthetic-secret-never-log").returncode == 0
    seen = []
    def command(args, **kw):
        seen.append((args, kw))
        return subprocess.CompletedProcess(args, 1, b"sensitive output", b"sensitive error")
    monkeypatch.setattr(refresh.subprocess, "run", command)
    assert refresh.refresh(paths(machine)[2]) == 1
    assert "--offline" in json.loads(seen[0][1]["input"])
    assert "synthetic-secret-never-log" not in " ".join(seen[0][0])
    captured = capsys.readouterr()
    assert "synthetic-secret-never-log" not in captured.out + captured.err
    assert "sensitive output" not in captured.out + captured.err


def test_auto_refresh_preserves_previously_observed_runtime_hints(machine):
    machine[1].write_text(json.dumps({"qwen-test": {"alias": "qwen", "omlx_id": "qwen-test"}}))
    cache = machine[0] / "observed.json"
    cache.write_text(json.dumps({"models": [{"id": "qwen-test", "max_context_window": 12345, "max_tokens": 1234, "thinking_default": True}]}))
    assert render(machine, "--offline", "--status-cache", str(cache)).returncode == 0
    before = paths(machine)[1].read_bytes()
    cache.unlink()
    assert invoke(machine).returncode == 0
    assert paths(machine)[1].read_bytes() == before


def test_prompt_refresh_adds_and_retires_only_generated_model_functions(machine):
    assert render(machine, "--direct-launchers").returncode == 0
    replacement = machine[0] / "next.json"
    replacement.write_text(json.dumps({"cloud:next": {"alias": "next", "name": "next", "provider_model_id": "next"}}))
    script = f'''
source {shlex.quote(str(paths(machine)[2]))} || exit
pi-personal() {{ :; }}
_pi_refresh_commands
cp {shlex.quote(str(replacement))} {shlex.quote(str(machine[1]))}
_pi_refresh_commands
(( $+functions[pi-next] && ! $+functions[pi-test] && $+functions[pi-personal] )) || exit 9
pi-list
'''
    result = run("zsh", "-f", "-c", script, env=machine[2])
    assert result.returncode == 0, result.stderr
    assert "pi-next" in result.stdout


def test_refresh_failure_cannot_exit_an_errexit_shell(machine):
    assert render(machine).returncode == 0
    machine[1].write_text("{invalid")
    result = run("zsh", "-f", "-e", "-c", f"source {shlex.quote(str(paths(machine)[2]))}; _pi_refresh_commands; echo STILL_ALIVE", env=machine[2])
    assert result.returncode == 0 and "STILL_ALIVE" in result.stdout


def test_prompt_refresh_waits_for_explicit_update_lock(machine):
    assert render(machine).returncode == 0
    lock = machine[0] / ".config/pi-shared/update.lock"
    lock.parent.mkdir(parents=True)
    with lock.open("w") as stream:
        lock.chmod(0o600)
        fcntl.flock(stream, fcntl.LOCK_EX)
        before = paths(machine)[2].read_bytes()
        result = invoke(machine, "--poll", "")
        assert result.returncode == 0 and not result.stdout and not result.stderr
        assert paths(machine)[2].read_bytes() == before


def test_catalog_cannot_shadow_the_public_updater(machine):
    assert render(machine).returncode == 0
    before = (paths(machine)[1].read_bytes(), paths(machine)[2].read_bytes())
    machine[1].write_text(json.dumps({"cloud:shared": {"alias": "shared", "provider_model_id": "shared"}}))
    result = render(machine)
    assert result.returncode != 0 and "reserved Pi launcher alias" in result.stderr
    assert (paths(machine)[1].read_bytes(), paths(machine)[2].read_bytes()) == before


def test_offline_renderer_never_reads_status_url(machine, monkeypatch):
    spec = importlib.util.spec_from_file_location("offline_catalog", ROOT / "lib/pi_catalog.py")
    catalog = importlib.util.module_from_spec(spec); spec.loader.exec_module(catalog)
    monkeypatch.setattr(catalog, "_load_omlx_status", lambda *a: (_ for _ in ()).throw(AssertionError("network probe")))
    machine[1].write_text(json.dumps({"local": {"alias": "local", "omlx_id": "local"}}))
    assert catalog.main(["--aliases", str(machine[1]), "--models-out", str(paths(machine)[1]),
                         "--omlx-status-url", "https://invalid.example/status", "--offline"]) == 0


def test_interactive_hook_registration_is_idempotent(machine):
    assert render(machine).returncode == 0
    launcher = shlex.quote(str(paths(machine)[2]))
    result = run("zsh", "-f", "-i", "-c", f'''source {launcher}; source {launcher};
print -l -- $precmd_functions
''', env=machine[2])
    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines().count("_pi_refresh_commands") == 1


def test_compatibility_alias_uses_unified_cli_and_propagates_failure(machine):
    assert render(machine).returncode == 0
    receipt = machine[0] / ".config/pi-shared/setup.json"
    receipt.parent.mkdir(parents=True)
    receipt.write_text("{}")
    bindir = machine[0] / "bin"; bindir.mkdir()
    stub = bindir / "pi-shared"
    stub.write_text('#!/bin/sh\nprintf "%s\\n" "$*" > "$HOME/update-call"\nexit 7\n'); stub.chmod(0o755)
    result = run("zsh", "-f", "-c", f"source {shlex.quote(str(paths(machine)[2]))}; pi-shared-update --plan",
                 env={**machine[2], "PATH": str(bindir) + os.pathsep + machine[2]["PATH"]})
    assert result.returncode == 7
    assert (machine[0] / "update-call").read_text().strip() == "update --plan"
