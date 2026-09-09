"""Isolated stdlib readiness tests: fake loopback HTTP only, never browser calls."""

import contextlib
import http.server
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import unittest


HELPER = Path(__file__).resolve().parents[1] / "bin/pi-browser-check"
TOKEN = "ISOLATED_TEST_TOKEN"


@contextlib.contextmanager
def server(payload=None, status=200, headers=None):
    requests = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append((self.path, dict(self.headers), body))
            result = payload(body) if callable(payload) else payload
            if result is None:
                result = {"jsonrpc": "2.0", "id": body["id"], "result": {"tools": [
                    {"name": "browser_fetch"}, {"name": "browser_inspect"},
                ]}}
            self.send_response(status)
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(result if isinstance(result, bytes) else json.dumps(result).encode())

        def log_message(self, *_args):
            pass

    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_port}/mcp", requests
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join()


class BrowserCheckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.token = self.root / "token"
        self.token.write_text(TOKEN + "\n")
        self.env = {
            "HOME": str(self.root), "PATH": os.environ.get("PATH", ""),
            "BROWSER_WORKER_MCP_TOKEN_FILE": str(self.token),
            "BROWSER_WORKER_MCP_URL": "http://127.0.0.1:1/mcp",
        }

    def run_check(self, *args, **env):
        return subprocess.run([sys.executable, str(HELPER), *args], env={**self.env, **env},
                              capture_output=True, text=True, timeout=10)

    def assert_warn(self, result, reason):
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertTrue(result.stdout.startswith("WARN:"), result.stdout)
        self.assertIn(reason, result.stdout)
        self.assertIn("BROWSER_WORKER_MCP_URL", result.stdout)
        self.assertIn("BROWSER_WORKER_MCP_TOKEN_FILE", result.stdout)
        self.assertIn("README.md", result.stdout)
        self.assertNotIn("READY:", result.stdout)
        self.assertNotIn(TOKEN, result.stdout + result.stderr)

    def test_explicitly_unselected_worker_is_not_an_unconfigured_warning(self):
        config = self.root / ".pi/research/config.json"
        config.parent.mkdir(parents=True)
        config.write_text(json.dumps({"browserWorkerEnabled": False, "websearchMcpUrl": "http://127.0.0.1:8891/mcp"}))
        self.token.unlink()
        with server() as (url, requests):
            result = self.run_check(BROWSER_WORKER_MCP_URL=url)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(result.stdout.startswith("DISABLED:"))
        self.assertNotIn("WARN:", result.stdout)
        self.assertNotIn("READY:", result.stdout)
        self.assertEqual(requests, [])

    def test_selection_must_be_boolean_and_true_checks_token(self):
        config = self.root / ".pi/research/config.json"
        config.parent.mkdir(parents=True)
        for value in ["false", None, 0, {}]:
            config.write_text(json.dumps({"browserWorkerEnabled": value}))
            self.assert_warn(self.run_check(), "browserWorkerEnabled")
        config.write_text(json.dumps({"browserWorkerEnabled": True}))
        self.token.unlink()
        self.assert_warn(self.run_check(), "token file")

    def test_installer_persisted_url_and_token_path_are_used_without_env(self):
        config = self.root / ".pi/research/config.json"
        config.parent.mkdir(parents=True)
        self.env.pop("BROWSER_WORKER_MCP_URL")
        self.env.pop("BROWSER_WORKER_MCP_TOKEN_FILE")
        with server() as (url, requests):
            config.write_text(json.dumps({"browserWorkerEnabled": True, "browserWorkerMcpUrl": url,
                                          "browserWorkerTokenFile": str(self.token)}))
            result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(result.stdout.startswith("READY:"))
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0][1]["Authorization"], "Bearer " + TOKEN)
        self.assertNotIn(TOKEN, result.stdout + result.stderr)

    def test_structured_modes_use_persisted_config_without_extra_probes(self):
        config = self.root / ".pi/research/config.json"
        config.parent.mkdir(parents=True)
        self.env.pop("BROWSER_WORKER_MCP_URL")
        self.env.pop("BROWSER_WORKER_MCP_TOKEN_FILE")
        with server() as (url, requests):
            config.write_text(json.dumps({"browserWorkerEnabled": True, "browserWorkerMcpUrl": url,
                                          "browserWorkerTokenFile": str(self.token)}))
            result = self.run_check("--json", "--static")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            row = json.loads(result.stdout)["capabilities"][0]
            self.assertEqual(row["outcome"], "not_checked")
            self.assertTrue(row["token_file_present"])
            self.assertEqual(requests, [])
            result = self.run_check("--json")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            row = json.loads(result.stdout)["capabilities"][0]
            self.assertEqual(row["outcome"], "inventory_verified")
            self.assertEqual(len(requests), 1)
            self.assertNotIn(TOKEN, result.stdout + result.stderr)

    def test_structured_config_remains_bounded_and_validated(self):
        config = self.root / ".pi/research/config.json"
        config.parent.mkdir(parents=True)
        for content in [json.dumps({"browserWorkerMcpUrl": 42}),
                        json.dumps({"browserWorkerTokenFile": ""}),
                        json.dumps({"padding": "x" * (300 * 1024)})]:
            config.write_text(content)
            result = self.run_check("--json", "--static")
            self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
            self.assertEqual(json.loads(result.stdout)["capabilities"][0]["outcome"], "invalid_config")

    def test_env_overrides_persisted_client_configuration(self):
        config = self.root / ".pi/research/config.json"
        config.parent.mkdir(parents=True)
        config.write_text(json.dumps({"browserWorkerMcpUrl": "http://127.0.0.1:1/mcp",
                                      "browserWorkerTokenFile": str(self.root / "missing")}))
        with server() as (url, requests):
            result = self.run_check(BROWSER_WORKER_MCP_URL=url)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len(requests), 1)

    def test_missing_default_token_is_optional_and_no_files_created(self):
        del self.env["BROWSER_WORKER_MCP_TOKEN_FILE"]
        del self.env["BROWSER_WORKER_MCP_URL"]
        before = list(self.root.iterdir())
        self.assert_warn(self.run_check(), "missing")
        self.assertEqual(before, list(self.root.iterdir()))

    def test_missing_empty_and_malformed_token_no_request(self):
        with server() as (url, requests):
            self.token.unlink()
            self.assert_warn(self.run_check(BROWSER_WORKER_MCP_URL=url), "missing")
            for value in ["", " \n", "a\nb", "a b", "\u00e9", "a\rb"]:
                self.token.write_text(value)
                self.assert_warn(self.run_check(BROWSER_WORKER_MCP_URL=url), "token file")
            self.token.write_bytes(b"\xff")
            self.assert_warn(self.run_check(BROWSER_WORKER_MCP_URL=url), "UTF-8")
            self.assertEqual(requests, [])

    def test_unsafe_urls_rejected_before_token_or_network_access(self):
        for url in [
            "https://127.0.0.1:8890/mcp", "http://example.com:8890/mcp",
            f"http://user:{TOKEN}@127.0.0.1:8890/mcp", f"http://127.0.0.1:8890/mcp?token={TOKEN}",
            "http://127.0.0.1:8890/mcp#", "http://localhost:8890/mcp",
            "http://127.0.0.2:8890/mcp", "http://2130706433:8890/mcp",
            "http://127.0.0.1/mcp", "http://127.0.0.1:80/mcp", "http://127.0.0.1:0/mcp",
            "http://127.0.0.1:65536/mcp", "http://127.0.0.1:08890/mcp",
            "http://127.0.0.1:8890/../mcp", "http://127.0.0.1:8890\\mcp",
            "\nhttp://127.0.0.1:8890/mcp", "http://127.0.0.1:8890/mcp\n",
        ]:
            with self.subTest(url=url):
                self.assert_warn(self.run_check(BROWSER_WORKER_MCP_URL=url,
                                               BROWSER_WORKER_MCP_TOKEN_FILE=str(self.root / "missing")),
                                 "uncredentialed loopback")

    def test_correct_worker_only_lists_tools_and_ignores_proxies(self):
        with server() as (url, requests), server() as (proxy, proxy_requests):
            result = self.run_check(BROWSER_WORKER_MCP_URL=url, http_proxy=proxy,
                                    HTTP_PROXY=proxy, ALL_PROXY=proxy, NO_PROXY="", no_proxy="")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue(result.stdout.startswith("READY:"))
            self.assertIn("browser execution not tested", result.stdout)
            self.assertNotIn(TOKEN, result.stdout + result.stderr)
            self.assertEqual(len(requests), 1)
            path, headers, body = requests[0]
            self.assertEqual(path, "/mcp")
            self.assertEqual(headers["Authorization"], "Bearer " + TOKEN)
            self.assertEqual(body["method"], "tools/list")
            self.assertEqual(body["params"], {})
            self.assertEqual(proxy_requests, [])

    def test_redirects_do_not_forward_token(self):
        with server() as (target, target_requests):
            with server(status=307, headers={"Location": target}) as (url, requests):
                self.assert_warn(self.run_check(BROWSER_WORKER_MCP_URL=url), "HTTP 307")
                self.assertEqual(len(requests), 1)
            self.assertEqual(target_requests, [])

    def test_http_auth_errors_and_invalid_json_fail_closed(self):
        for status, payload, reason in [(401, None, "HTTP 401"), (500, None, "HTTP 500"),
                                        (200, b"not-json", "invalid JSON"),
                                        (200, b"x" * (1024 * 1024 + 1), "exceeds 1 MiB")]:
            with server(status=status, payload=payload) as (url, _):
                self.assert_warn(self.run_check(BROWSER_WORKER_MCP_URL=url), reason)

    def test_wrong_inventory_rpc_envelope_or_pagination_not_ready(self):
        for tools in [[], [{"name": "web_search"}, {"name": "web_fetch"}],
                      [{"name": "browser_fetch"}],
                      [{"name": "browser_fetch"}, {"name": "browser_inspect"}, {"name": "browser_open"}],
                      [{"name": "browser_fetch"}, {}], [None, {}], {},
                      [{"name": "browser_fetch"}, {"name": "browser_fetch"}]]:
            with server(payload=lambda body: {"jsonrpc": "2.0", "id": body["id"], "result": {"tools": tools}}) as (url, _):
                self.assert_warn(self.run_check(BROWSER_WORKER_MCP_URL=url), "not the expected browser-worker")
        for override in [{"id": "wrong"}, {"error": {"message": TOKEN}}, {"jsonrpc": "1.0"}]:
            def payload(body):
                return {"jsonrpc": "2.0", "id": body["id"], "result": {"tools": [
                    {"name": "browser_fetch"}, {"name": "browser_inspect"},
                ]}, **override}
            with server(payload=payload) as (url, _):
                self.assert_warn(self.run_check(BROWSER_WORKER_MCP_URL=url), "not the expected browser-worker")
        with server(payload=b"null") as (url, _):
            self.assert_warn(self.run_check(BROWSER_WORKER_MCP_URL=url), "not the expected browser-worker")
        with server(payload=lambda body: {"jsonrpc": "2.0", "id": body["id"], "result": {
            "tools": [{"name": "browser_fetch"}, {"name": "browser_inspect"}], "nextCursor": "more",
        }}) as (url, _):
            self.assert_warn(self.run_check(BROWSER_WORKER_MCP_URL=url), "not the expected browser-worker")

    def test_unavailable_service_warns(self):
        # Reserve a loopback port without listening, never contact a real service.
        with socket.socket() as reserved:
            reserved.bind(("127.0.0.1", 0))
            url = f"http://127.0.0.1:{reserved.getsockname()[1]}/mcp"
            self.assert_warn(self.run_check(BROWSER_WORKER_MCP_URL=url), "unavailable or timed out")

    def test_timeout_warns(self):
        # Listening socket deliberately never responds; helper must not hang.
        with socket.socket() as stalled:
            stalled.bind(("127.0.0.1", 0))
            stalled.listen()
            url = f"http://127.0.0.1:{stalled.getsockname()[1]}/mcp"
            self.assert_warn(self.run_check(BROWSER_WORKER_MCP_URL=url), "timed out")


if __name__ == "__main__":
    unittest.main()
