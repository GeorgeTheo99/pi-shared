"""Environment doctor fixtures: no real services, models, installs or profiles."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

import pytest

from test_pi_browser_check import server

ROOT = Path(__file__).resolve().parents[1]
DOCTOR = ROOT / "bin/pi-doctor"
SECRET = "DOCTOR_SECRET_MUST_NEVER_APPEAR"


@pytest.fixture
def setup(tmp_path):
    home = tmp_path / "home"
    agent = home / ".pi/agent"
    agent.mkdir(parents=True)
    (agent / "settings.json").write_text('{"extensions": []}')
    config = home / ".pi/research/config.json"
    config.parent.mkdir(parents=True)
    config.write_text('{"browserWorkerEnabled": false}')
    deps = tmp_path / "extensions"
    deps.mkdir()
    token = tmp_path / "token"
    token.write_text(SECRET)
    env = {**os.environ, "HOME": str(home), "PI_CODING_AGENT_DIR": str(agent),
           "BROWSER_WORKER_MCP_URL": "http://127.0.0.1:1/mcp", "BROWSER_WORKER_MCP_TOKEN_FILE": str(token),
           "PYTHONDONTWRITEBYTECODE": "1"}
    return {"home": home, "agent": agent, "config": config, "deps": deps, "env": env, "tmp": tmp_path}


def invoke(setup, *args, checker="pi-doctor", deadline=10):
    base = [sys.executable, str(ROOT / "bin" / checker), "--json"]
    if checker == "pi-doctor":
        base += ["--extensions-dir", str(setup["deps"])]
    result = subprocess.run([*base, *args], env=setup["env"], capture_output=True, text=True, timeout=deadline)
    assert SECRET not in result.stdout + result.stderr
    assert not result.stderr, result.stderr
    report = json.loads(result.stdout)
    assert report["schema_version"] == 1
    for row in report["capabilities"]:
        assert row["verified_at"]
        assert all(row[key] in {"yes", "no", "unknown"} for key in ("installed", "loaded", "active", "configured"))
    return result, {row["capability"]: row for row in report["capabilities"]}


def fake_sdk(setup, code):
    sdk = setup["tmp"] / "sdk"
    sdk.mkdir(exist_ok=True)
    (sdk / "package.json").write_text(json.dumps({"name": "@earendil-works/pi-coding-agent", "main": "index.mjs"}))
    (sdk / "index.mjs").write_text(code)
    setup["env"]["PI_INSTALL_DIR"] = str(sdk)


def test_static_default_never_executes_extensions_auth_commands_or_node(setup):
    marker = setup["tmp"] / "executed"
    extension = setup["tmp"] / "bad.ts"
    extension.write_text(f'import fs from "node:fs"; fs.writeFileSync({json.dumps(str(marker))}, "bad"); throw Error("{SECRET}");')
    (setup["agent"] / "settings.json").write_text(json.dumps({"extensions": [str(extension)]}))
    (setup["agent"] / "models.json").write_text(json.dumps({"providers": {SECRET: {
        "apiKey": f"!touch {marker}", "models": [{"id": SECRET}], "headers": {"Authorization": SECRET},
    }}}))
    os.mkfifo(setup["agent"] / "auth.json")  # Static mode must not even open credentials.
    bindir = setup["tmp"] / "bin"
    bindir.mkdir()
    for name in ("node", "pi"):
        path = bindir / name
        path.write_text(f"#!/bin/sh\ntouch '{marker}'\nexit 9\n")
        path.chmod(0o755)
    setup["env"]["PATH"] = str(bindir) + os.pathsep + os.environ["PATH"]
    before = {str(p): p.stat().st_mtime_ns for p in setup["home"].rglob("*")}
    result, rows = invoke(setup)
    assert result.returncode == 0
    assert not marker.exists()
    assert before == {str(p): p.stat().st_mtime_ns for p in setup["home"].rglob("*")}
    assert rows["profile"]["outcome"] == "inspected"
    assert rows["node"]["installed"] == "yes"
    assert rows["extensions"]["loaded"] == "unknown"
    assert rows["models"]["configured"] == "yes"
    assert rows["models"]["outcome"] == "not_exercised"
    assert rows["models"]["active"] == "unknown"
    assert rows["browser_worker"]["outcome"] == "disabled"
    assert rows["dependencies"]["probe_type"] == "static"


def test_missing_runtime_dependency_and_unknown_states_are_separate(setup):
    package = setup["deps"] / "example"
    package.mkdir()
    (package / "package.json").write_text(json.dumps({"dependencies": {"doctor-nonexistent-dependency-843214": "1"}}))
    (package / "package-lock.json").write_text("{}")
    _, static = invoke(setup)
    assert static["dependencies"]["installed"] == "unknown"
    assert static["dependencies"]["checked_count"] == 0
    result, rows = invoke(setup, "--probe-deps")
    assert result.returncode == 1
    assert rows["dependencies"]["outcome"] == "missing_dependency"
    assert rows["dependencies"]["failed_count"] == 1
    assert rows["dependencies"]["loaded"] == "unknown"
    module = package / "node_modules/doctor-nonexistent-dependency-843214"
    module.mkdir(parents=True)
    # Resolving a module is not importing it.
    (module / "index.js").write_text(f'throw new Error("{SECRET}")')
    result, rows = invoke(setup, "--probe-deps")
    assert result.returncode == 0
    assert rows["dependencies"]["outcome"] == "resolved"


def test_missing_node_is_not_success(setup):
    bindir = setup["tmp"] / "bin"
    bindir.mkdir()
    (bindir / "python3").symlink_to(sys.executable)
    setup["env"]["PATH"] = str(bindir)
    result, rows = invoke(setup, "--probe-deps")
    assert result.returncode == 1
    assert rows["node"]["installed"] == "no"
    assert rows["dependencies"]["outcome"] == "missing"


@pytest.mark.parametrize("contents", ["null", "[]", '{"extensions": null}', "{" + SECRET])
def test_bad_profile_is_structured_and_secret_safe(setup, contents):
    (setup["agent"] / "settings.json").write_text(contents)
    result, rows = invoke(setup)
    assert result.returncode == 1
    assert rows["profile"]["outcome"] == "invalid_config"
    assert rows["extensions"]["loaded"] == "unknown"


def test_oversized_and_fifo_configuration_are_bounded(setup):
    path = setup["agent"] / "settings.json"
    path.write_text("x" * (256 * 1024 + 1))
    result, rows = invoke(setup, "--timeout", "1")
    assert result.returncode == 1
    assert rows["profile"]["outcome"] == "invalid_config"
    path.unlink()
    os.mkfifo(path)
    result, rows = invoke(setup, "--timeout", "1")
    assert result.returncode == 1
    assert rows["profile"]["outcome"] == "invalid_config"


@pytest.mark.skipif(not shutil.which("node"), reason="requires Node")
@pytest.mark.parametrize("code,outcome", [
    (f'throw new Error("{SECRET}")', "import_failed"),
    ('process.exit(0)', "import_failed"),
    ('process.exit(7)', "import_failed"),
    ('await new Promise(() => setInterval(() => {}, 1000))', "timeout"),
    ('process.stdout.write("x".repeat(1024*1024)); await new Promise(() => setInterval(() => {}, 1000))', "output_limit"),
])
def test_import_errors_timeouts_and_floods_never_pass(setup, code, outcome):
    fake_sdk(setup, code)
    # Give the inner deadline time to report its exact status.
    result, rows = invoke(setup, "--agent-dir", str(setup["agent"]), "--timeout", "0.5", checker="pi-profile-check")
    assert result.returncode == 1
    assert rows["extensions"]["outcome"] == outcome
    assert rows["extensions"]["loaded"] == "unknown"
    assert len(result.stdout) < 5000


@pytest.mark.skipif(not shutil.which("pi") or not shutil.which("node"), reason="requires installed Pi")
def test_real_import_evidence_is_not_active_session_evidence(setup):
    extension = setup["tmp"] / "extension.ts"
    extension.write_text(f'export default function () {{ console.log("{SECRET}"); }}')
    (setup["agent"] / "settings.json").write_text(json.dumps({"extensions": [str(extension)]}))
    result, rows = invoke(setup, "--probe-imports")
    assert result.returncode == 0
    assert rows["extensions"]["imported_count"] == 1
    assert rows["extensions"]["loaded"] == "yes"
    assert rows["extensions"]["active"] == "unknown"
    extension.write_text(f'export default function () {{ throw new Error("{SECRET}"); }}')
    result, rows = invoke(setup, "--probe-imports")
    assert result.returncode == 1
    assert rows["extensions"]["outcome"] == "import_failed"


def test_disabled_browser_never_contacts_server_even_with_opt_in(setup):
    with server() as (url, requests):
        setup["env"]["BROWSER_WORKER_MCP_URL"] = url
        result, rows = invoke(setup, "--probe-browser")
    assert result.returncode == 0
    assert rows["browser_worker"]["outcome"] == "disabled"
    assert requests == []


def test_bad_endpoint_is_static_failure_without_leaking_userinfo(setup):
    setup["config"].write_text('{"browserWorkerEnabled": true}')
    setup["env"]["BROWSER_WORKER_MCP_URL"] = f"http://user:{SECRET}@127.0.0.1:8890/mcp"
    result, rows = invoke(setup)
    assert result.returncode == 1
    assert rows["browser_worker"]["outcome"] == "invalid_config"


@pytest.mark.parametrize("status,outcome", [(200, "inventory_verified"), (401, "auth_failed"), (403, "auth_failed"), (500, "http_error")])
def test_browser_inventory_is_explicit_opt_in_and_not_execution(setup, status, outcome):
    setup["config"].write_text('{"browserWorkerEnabled": true}')
    with server(status=status) as (url, requests):
        setup["env"]["BROWSER_WORKER_MCP_URL"] = url
        result, rows = invoke(setup)
        assert rows["browser_worker"]["outcome"] == "not_checked"
        assert requests == []
        result, rows = invoke(setup, "--probe-browser")
        assert len(requests) == 1
        assert requests[0][2]["method"] == "tools/list"
    assert result.returncode == (0 if status == 200 else 1)
    assert rows["browser_worker"]["outcome"] == outcome
    assert rows["browser_worker"]["execution"] == "not_tested"
    assert rows["browser_worker"]["active"] == "unknown"


def test_browser_total_deadline(setup):
    import socket
    setup["config"].write_text('{"browserWorkerEnabled": true}')
    with socket.socket() as stalled:
        stalled.bind(("127.0.0.1", 0))
        stalled.listen()
        setup["env"]["BROWSER_WORKER_MCP_URL"] = f"http://127.0.0.1:{stalled.getsockname()[1]}/mcp"
        start = time.monotonic()
        result, rows = invoke(setup, "--timeout", "0.2", checker="pi-browser-check")
    assert time.monotonic() - start < 2
    assert result.returncode == 2
    assert rows["browser_worker"]["outcome"] == "timeout"


def test_structured_require_models_and_legacy_timeout_contract(setup):
    result, rows = invoke(setup, "--static", "--require-models", "--agent-dir", str(setup["agent"]), checker="pi-profile-check")
    assert result.returncode == 1
    assert rows["models"]["outcome"] == "missing"
    legacy = subprocess.run([sys.executable, str(ROOT / "bin/pi-profile-check"), "--agent-dir", str(setup["agent"]), "--timeout", "0"],
                            env=setup["env"], capture_output=True, text=True, timeout=2)
    assert legacy.returncode == 1
    assert "FAIL" in legacy.stderr
    # Existing profile-check allows user-selected deadlines above one minute.
    result, _ = invoke(setup, "--static", "--timeout", "120", "--agent-dir", str(setup["agent"]), checker="pi-profile-check")
    assert result.returncode == 0


@pytest.mark.skipif(not shutil.which("node"), reason="requires Node")
@pytest.mark.parametrize("cancel", [False, True])
def test_outer_deadline_and_cancellation_clean_nested_import_group(setup, cancel):
    pidfile = setup["tmp"] / "pid"
    fake_sdk(setup, f'''
import fs from "node:fs";
fs.writeFileSync({json.dumps(str(pidfile))}, String(process.pid));
await new Promise(() => setInterval(() => {{}}, 1000));
''')
    proc = subprocess.Popen([sys.executable, str(DOCTOR), "--json", "--probe-imports", "--timeout", "1",
                             "--extensions-dir", str(setup["deps"])], env=setup["env"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        deadline = time.monotonic() + 3
        while not pidfile.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert pidfile.exists()
        pid = int(pidfile.read_text())
        if cancel:
            proc.send_signal(signal.SIGTERM)
        out, err = proc.communicate(timeout=5)
        assert not err
        assert proc.returncode != 0
        assert SECRET.encode() not in out
        if cancel:
            report = json.loads(out)
            assert any(row["outcome"] == "canceled" for row in report["capabilities"]), [(r["capability"], r["outcome"]) for r in report["capabilities"]]
            assert not any(row["capability"] in {"browser_worker", "dependencies"} for row in report["capabilities"])
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            status = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True).stdout.strip()
            if not status or status.startswith("Z"):
                break
            time.sleep(0.02)
        assert not status or status.startswith("Z"), "nested Node probe was left running"
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


@pytest.mark.parametrize("timeout", ["nan", "inf", "0", "-1", "61"])
def test_invalid_deadlines_are_refused(setup, timeout):
    result = subprocess.run([sys.executable, str(DOCTOR), "--timeout", timeout],
                            env=setup["env"], capture_output=True, text=True, timeout=2)
    assert result.returncode == 2
