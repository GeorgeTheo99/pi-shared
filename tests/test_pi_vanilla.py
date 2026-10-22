"""pi-vanilla defaults to the ChatGPT plan, never an OpenAI API key."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

VANILLA = Path(__file__).resolve().parents[1] / "bin/pi-vanilla"

pytestmark = pytest.mark.skipif(not shutil.which("plutil"), reason="plutil is required")


def run_vanilla(tmp_path, auth, **env):
    stub = tmp_path / "pi"
    stub.write_text(f"#!{sys.executable}\n" + "import json, os, sys\n"
                    "print(json.dumps({'args': sys.argv[1:], 'key': os.environ.get('OPENAI_API_KEY')}))\n")
    stub.chmod(0o755)
    agent = tmp_path / "agent"
    agent.mkdir()
    if auth is not None:
        (agent / "auth.json").write_text(json.dumps(auth))
    result = subprocess.run(
        ["/bin/bash", str(VANILLA)], capture_output=True, text=True, timeout=30,
        env={**os.environ, "PI_VANILLA_PI_BIN": str(stub), "PI_VANILLA_AGENT_DIR": str(agent),
             "PI_VANILLA_SESSION_DIR": str(tmp_path / "sessions"),
             "PI_VANILLA_SOURCE_AGENT_DIR": str(tmp_path / "no-source"), "OPENAI_API_KEY": "test-only", **env})
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


@pytest.mark.parametrize("auth,provider", [
    (None, "openai"),
    ({"openai": {"type": "oauth"}, "openai-codex": {"type": "oauth"}}, "openai"),
    ({"openai-codex": {"type": "oauth"}}, "openai-codex"),
    ({"openai": {"type": "api_key", "key": "stored"}}, "openai-codex"),
])
def test_default_provider_is_the_plan_login(tmp_path, auth, provider):
    launched = run_vanilla(tmp_path, auth)
    assert launched["args"][:4] == ["--provider", provider, "--model", "gpt-6-astra"]
    assert launched["key"] is None


def test_explicit_provider_is_kept_with_its_environment(tmp_path):
    launched = run_vanilla(tmp_path, {"openai": {"type": "oauth"}}, PI_VANILLA_PROVIDER="custom")
    assert launched["args"][:2] == ["--provider", "custom"]
    assert launched["key"] == "test-only"
