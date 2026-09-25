"""Remote onboarding contracts with a loopback fake gateway; no real credentials/services."""
import copy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import threading

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "lib"))
import pi_gateway as gateway

CATALOG = {"object": "list", "data": [
    {"id": "org/model-x", "available": True, "context_length": 65536,
     "max_output_tokens": 4096, "thinking_levels": ["off", "high"], "vision": False},
    {"id": "vision", "available": True, "context_length": 32768,
     "max_output_tokens": 2048, "thinking_levels": [], "vision": True},
    {"id": "unavailable", "available": False},
]}


@pytest.fixture
def server():
    state = {"body": CATALOG, "status": 200, "requests": [], "inference": []}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            state["requests"].append((self.path, self.headers.get("Authorization")))
            if state.get("malformed_status"):
                self.wfile.write((self.headers.get("Authorization") + "\r\n\r\n").encode())
                return
            self.send_response(state["status"])
            self.send_header("Location", "/should-not-follow")
            self.end_headers()
            value = state["body"]
            self.wfile.write(value if isinstance(value, bytes) else json.dumps(value).encode())

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            state["inference"].append((self.path, self.headers.get("Authorization"), body))
            item = {"id": "msg_test", "type": "message", "role": "assistant", "status": "completed",
                    "content": [{"type": "output_text", "text": "fixture reply", "annotations": []}]}
            events = [
                {"type": "response.created", "response": {"id": "resp_test", "status": "in_progress", "output": []}},
                {"type": "response.output_item.added", "output_index": 0,
                 "item": {**item, "status": "in_progress", "content": []}},
                {"type": "response.content_part.added", "output_index": 0, "content_index": 0,
                 "item_id": item["id"], "part": {"type": "output_text", "text": "", "annotations": []}},
                {"type": "response.output_text.delta", "output_index": 0, "content_index": 0,
                 "item_id": item["id"], "delta": "fixture reply"},
                {"type": "response.output_text.done", "output_index": 0, "content_index": 0,
                 "item_id": item["id"], "text": "fixture reply"},
                {"type": "response.output_item.done", "output_index": 0, "item": item},
                {"type": "response.completed", "response": {"id": "resp_test", "status": "completed",
                 "output": [item], "usage": {"input_tokens": 1, "output_tokens": 2, "total_tokens": 3}}},
            ]
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            self.wfile.write("".join("data: " + json.dumps(e) + "\n\n" for e in events).encode())

        def log_message(self, *_):
            pass

    http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=http.serve_forever, daemon=True)
    thread.start()
    state["url"] = f"http://127.0.0.1:{http.server_port}"
    yield state
    http.shutdown()
    thread.join()
    http.server_close()


@pytest.fixture
def machine(tmp_path, monkeypatch):
    home = tmp_path.resolve() / "home"
    home.mkdir(mode=0o700)
    monkeypatch.setenv("HOME", str(home))
    key = home / "gateway'$ KEY"
    key.write_text("private-test-token\n")
    key.chmod(0o600)
    cli = home / "launcher.json"
    models = home / "agent/models.json"
    result = subprocess.run([str(ROOT / "bin/pi-catalog"), "--aliases", str(home / "missing.json"),
                             "--models-out", str(models), "--cli-out", str(cli),
                             "--pi-agent-dir", str(models.parent), "--allow-empty-catalog",
                             "--direct-launchers", "--offline"], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    return {"home": home, "key": key, "cli": cli, "models": models}


def invoke(machine, server, action="connect"):
    return subprocess.run([str(ROOT / "bin/pi-gateway"), action, "--url", server["url"] + "/v1/",
                           "--key-file", str(machine["key"]), "--cli-out", str(machine["cli"]),
                           "--allow-private-http"], capture_output=True, text=True, timeout=25)


def test_connect_check_refresh_and_secret_reference(machine, server):
    result = invoke(machine, server)
    assert result.returncode == 0, result.stderr
    assert server["requests"] == [("/v1/models/canonical", "Bearer private-test-token")]
    models = json.loads(machine["models"].read_text())["providers"]["model-gateway"]
    assert models["baseUrl"] == server["url"] + "/v1"
    assert [m["id"] for m in models["models"]] == ["org/model-x", "vision"]
    assert all(m["api"] == "openai-responses" for m in models["models"])
    assert models["models"][0]["thinkingLevelMap"]["low"] is None
    assert models["models"][0]["thinkingLevelMap"]["off"] == "none"
    assert models["models"][0]["input"] == ["text"]
    assert models["models"][1]["input"] == ["text", "image"]
    command = models["apiKey"][1:]
    resolved = subprocess.run(["sh", "-c", command], capture_output=True, text=True)
    assert resolved.returncode == 0, resolved.stderr
    assert resolved.stdout.strip() == "private-test-token"
    for path in (machine["cli"], machine["models"], machine["cli"].with_name("launcher.gateway-aliases.json")):
        assert "private-test-token" not in path.read_text()
        assert path.stat().st_mode & 0o777 == 0o600
    assert "private-test-token" not in result.stdout + result.stderr
    config = json.loads(machine["cli"].read_text())
    assert "openai" in config["routes"]
    assert len(config["routes"]) == 3
    result = invoke(machine, server, "check")
    assert result.returncode == 0, result.stderr
    assert "offline" in result.stdout
    assert len(server["requests"]) == 1
    first = machine["cli"].read_bytes()
    assert invoke(machine, server).returncode == 0
    assert machine["cli"].read_bytes() == first
    # The generic launcher refresh never repeats discovery.
    result = subprocess.run([str(ROOT / "bin/pi-launch"), "--launcher-refresh"],
                            env={**os.environ, "PI_LAUNCHER_CONFIG": str(machine["cli"])},
                            capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert len(server["requests"]) == 2


def test_direct_bootstrap_then_remote_connect_preserves_native_route(machine, server):
    from pi_cli import atomic_write, dump, enable_gateway, initialize_direct
    # Replace the fixture's empty gateway bootstrap with a fresh native policy.
    direct = machine["home"] / "direct-launcher.json"
    initialize_direct(direct)
    machine["cli"] = direct
    native = machine["home"] / ".pi/agent"
    native.mkdir(parents=True)
    settings = native / "settings.json"
    atomic_write(settings, dump({"defaultProvider": "custom", "defaultModel": "native"}))
    before = settings.read_bytes()
    args = ["--shared-dir", str(ROOT), "--aliases", str(machine["home"] / "absent-remote-bootstrap.json"),
            "--models-out", str(machine["models"]), "--pi-agent-dir", str(machine["models"].parent),
            "--provider-name", "model-gateway", "--gateway-url", "http://localhost:9111",
            "--gateway-api-key", "cloud", "--allow-empty-catalog"]
    assert enable_gateway(direct, args)
    result = invoke(machine, server)
    assert result.returncode == 0, result.stderr
    config = json.loads(direct.read_text())
    assert config["routes"]["openai"]["gateway"] is False
    assert config["defaultProfile"] is None
    assert settings.read_bytes() == before
    assert invoke(machine, server, "check").returncode == 0


@pytest.mark.parametrize("status,body", [(302, {}), (401, b"SECRET server detail"),
    (404, {}), (200, b"not json"), (200, b"x" * (gateway.LIMIT + 1)),
    (200, {"data": []}), (200, {"data": [{"id": "bad", "available": True}]})],
    ids=["redirect", "unauthorized", "old-server", "invalid-json", "oversized", "empty", "invalid-model"])
def test_discovery_failure_preserves_outputs(machine, server, status, body):
    first = machine["cli"].read_bytes()
    server.update(status=status, body=body)
    result = invoke(machine, server)
    assert result.returncode != 0
    assert machine["cli"].read_bytes() == first
    assert not machine["models"].exists()
    assert not machine["cli"].with_name("launcher.gateway-aliases.json").exists()
    assert len(server["requests"]) == 1  # no redirects/retries
    assert "SECRET" not in result.stderr


@pytest.mark.parametrize("url,allow", [
    ("http://100.64.0.1:9111", False), ("http://8.8.8.8:9111", True),
    ("http://gateway.example.com", True), ("https://u:p@example.com", False),
    ("https://example.com/?key=secret", False), ("https://example.com/#fragment", False),
    ("https://example.com/admin", False), ("https://example.com:0", False),
    ("https://example.com\n", False), ("file:///secret", False),
])
def test_bad_urls(url, allow):
    with pytest.raises(ValueError):
        gateway.gateway_url(url, allow)


@pytest.mark.parametrize("url", ["http://100.100.1.2:9111", "http://[fd7a:115c:a1e0::1]:9111",
                                  "http://192.168.1.2:9111", "http://127.0.0.1:9111"])
def test_private_http_requires_explicit_opt_in(url):
    assert gateway.gateway_url(url + "/v1/", True) == url


def test_https_normalizes_v1():
    assert gateway.gateway_url("https://server.tailnet.ts.net/v1") == "https://server.tailnet.ts.net"


@pytest.mark.parametrize("mode", [0o644, 0o640, 0o400, 0o666])
def test_key_permissions(machine, mode):
    machine["key"].chmod(mode)
    with pytest.raises(ValueError):
        gateway.read_key(machine["key"])


@pytest.mark.parametrize("value", [b"", b"one\ntwo", b"bad\x00secret", b"secret\xff", b"x" * 8193])
def test_bad_token_does_not_leak(machine, value):
    machine["key"].write_bytes(value)
    result = subprocess.run([str(ROOT / "bin/pi-gateway"), "key", "--key-file", str(machine["key"])],
                            capture_output=True, text=True)
    assert result.returncode != 0
    assert not result.stdout
    assert "secret" not in result.stderr


def test_key_symlinks_hardlinks_and_fifo(machine):
    link = machine["home"] / "linked-key"
    link.symlink_to(machine["key"])
    with pytest.raises(ValueError):
        gateway.read_key(link)
    link.unlink()
    os.link(machine["key"], link)
    with pytest.raises(ValueError):
        gateway.read_key(machine["key"])
    link.unlink()
    fifo = machine["home"] / "fifo"
    os.mkfifo(fifo, 0o600)
    with pytest.raises(ValueError):
        gateway.read_key(fifo)


def test_manual_model_edit_fails_before_discovery(machine, server):
    assert invoke(machine, server).returncode == 0
    machine["models"].write_text('{}\n')
    saved = machine["cli"].read_bytes()
    assert invoke(machine, server).returncode != 0
    assert len(server["requests"]) == 1
    assert machine["cli"].read_bytes() == saved
    assert machine["models"].read_text() == '{}\n'


def test_check_rejects_different_endpoint(machine, server):
    assert invoke(machine, server).returncode == 0
    result = invoke(machine, {"url": "https://other.example.com"}, "check")
    assert result.returncode != 0
    assert len(server["requests"]) == 1


def test_deadline(monkeypatch):
    def timeout(*args, **kwargs):
        assert kwargs["timeout"] == 20
        raise subprocess.TimeoutExpired(args[0], 20)
    monkeypatch.setattr(subprocess, "run", timeout)
    with pytest.raises(ValueError, match="20-second"):
        gateway.discover("https://gateway.example.com", "/safe/key", False)


@pytest.mark.parametrize("change", [
    {"vision": "yes"}, {"thinking_levels": ["unknown"]}, {"thinking_levels": ["high", "high"]},
    {"context_length": True}, {"context_length": 0}, {"max_output_tokens": -1},
    {"id": "line\nbreak"}, {"available": "yes"},
])
def test_bad_capabilities(change):
    catalog = copy.deepcopy(CATALOG)
    catalog["data"][0].update(change)
    with pytest.raises(ValueError):
        gateway.aliases_from_catalog(catalog)


def test_aliases_stable_and_unique():
    catalog = copy.deepcopy(CATALOG)
    catalog["data"].append({**catalog["data"][0], "id": "org-model-x"})
    before = gateway.aliases_from_catalog(CATALOG)
    after = gateway.aliases_from_catalog(catalog)
    assert before["cloud:org/model-x"] == after["cloud:org/model-x"]
    assert len({row["alias"] for row in after.values()}) == 3


@pytest.mark.skipif(not os.environ.get("PI_GATEWAY_TEST_SDK_ROOT"), reason="opt-in installed Pi SDK smoke")
def test_installed_pi_loads_models_and_resolves_file_key(machine, server):
    assert invoke(machine, server).returncode == 0
    sdk = Path(os.environ["PI_GATEWAY_TEST_SDK_ROOT"]) / "dist/index.js"
    script = """
import { pathToFileURL } from 'node:url';
const { ModelRuntime } = await import(pathToFileURL(process.argv[1]).href);
const runtime = await ModelRuntime.create({modelsPath: process.argv[2],
  authPath: process.argv[3], modelsStorePath: process.argv[4], allowModelNetwork: false});
if (runtime.getError()) throw new Error(runtime.getError());
const model = runtime.getModel('model-gateway', 'org/model-x');
if (!model || model.api !== 'openai-responses' || model.contextWindow !== 65536)
  throw new Error('Generated model contract was not loaded');
const auth = await runtime.getAuth(model);
if (!auth || auth.auth.apiKey !== 'private-test-token') throw new Error('File credential did not resolve');
const reply = await runtime.completeSimple(model, {
  messages: [{role: 'user', content: 'fixture request', timestamp: Date.now()}],
  tools: [{name: 'echo', description: 'fixture tool', parameters: {type: 'object', properties: {}}}],
}, {reasoning: 'high', maxTokens: 128});
if (reply.stopReason === 'error' || !reply.content.some(c => c.type === 'text' && c.text === 'fixture reply'))
  throw new Error('Fake gateway Responses transport failed: ' + reply.errorMessage);
console.log('Installed Pi model/auth and fake gateway transport passed; no real provider inference');
"""
    result = subprocess.run(["node", "--input-type=module", "-e", script, str(sdk),
                             str(machine["models"]), str(machine["home"] / "auth.json"),
                             str(machine["home"] / "model-store.json")],
                            capture_output=True, text=True, timeout=25)
    assert result.returncode == 0, result.stderr
    assert "private-test-token" not in result.stdout + result.stderr
    assert len(server["requests"]) == 1
    assert len(server["inference"]) == 1
    path, auth, request = server["inference"][0]
    assert (path, auth) == ("/v1/responses", "Bearer private-test-token")
    assert request["model"] == "org/model-x"
    assert request["reasoning"]["effort"] == "high"
    assert request["tools"][0]["name"] == "echo"


def test_unmanaged_catalog_not_clobbered(machine, server):
    alias_path = machine["cli"].with_name("launcher.gateway-aliases.json")
    alias_path.write_text("private user catalog")
    result = invoke(machine, server)
    assert result.returncode != 0
    assert alias_path.read_text() == "private user catalog"
    assert not server["requests"]


def test_malformed_http_cannot_echo_credential(machine, server):
    server["malformed_status"] = True
    original = machine["cli"].read_bytes()
    result = invoke(machine, server)
    assert result.returncode != 0
    assert "private-test-token" not in result.stdout + result.stderr
    assert "Traceback" not in result.stderr
    assert machine["cli"].read_bytes() == original
    # Also protect the internal fetch command, not just its parent's stderr boundary.
    result = subprocess.run([str(ROOT / "bin/pi-gateway"), "_discover", "--url", server["url"],
                             "--key-file", str(machine["key"]), "--allow-private-http"],
                            capture_output=True, text=True, timeout=25)
    assert result.returncode != 0
    assert "private-test-token" not in result.stdout + result.stderr
    assert "Traceback" not in result.stderr


def test_unicode_key_and_model_round_trip(machine, server):
    key = machine["key"].with_name("clé-日本語")
    machine["key"].rename(key)
    machine["key"] = key
    server["body"] = copy.deepcopy(CATALOG)
    server["body"]["data"][0]["id"] = "org/modèle-日本語"
    assert invoke(machine, server).returncode == 0
    assert invoke(machine, server, "check").returncode == 0
    before = (machine["cli"].read_bytes(), machine["models"].read_bytes())
    assert invoke(machine, server).returncode == 0
    assert (machine["cli"].read_bytes(), machine["models"].read_bytes()) == before
    assert len(server["requests"]) == 2


def test_child_stderr_is_not_forwarded(monkeypatch):
    monkeypatch.setattr(subprocess, "run", lambda *a, **kw:
                        subprocess.CompletedProcess(a[0], 1, b"", b"Traceback: private-test-token"))
    with pytest.raises(ValueError) as error:
        gateway.discover("https://gateway.example.com", "/safe/key", False)
    assert "private-test-token" not in str(error.value)
