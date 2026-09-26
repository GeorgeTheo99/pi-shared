"""Explicit remote gateway discovery; routine launcher refresh stays offline."""
from __future__ import annotations

import argparse
import http.client
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

from pi_cli import (ROOT, atomic_write, digest, dump, generation_values, load_config,
                    make_config, read_owned, refresh)
from pi_catalog import render_models, _dump as dump_models

LIMIT = 1024 * 1024
MODEL_LIMIT = 1000
LEVELS = {"off", "minimal", "low", "medium", "high", "xhigh", "max"}
PRIVATE_NETWORKS = tuple(ipaddress.ip_network(net) for net in (
    "127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
    "100.64.0.0/10", "::1/128", "fc00::/7",
))


def gateway_url(value, allow_private_http=False):
    if not isinstance(value, str) or any(ord(c) < 33 or ord(c) > 126 for c in value):
        raise ValueError("Gateway URL must not contain whitespace/control characters")
    try:
        url = urllib.parse.urlsplit(value)
        port = url.port
        # Keep reverse-proxy prefixes literal; reject traversal and encoded or
        # empty segments rather than relying on a proxy's normalization rules.
        path = url.path.removesuffix("/")
        segments = path.split("/")[1:] if path else []
        if (url.scheme not in {"https", "http"} or not url.hostname or url.username is not None
                or url.password is not None or any(c in value for c in "?#\\%")
                or (port is not None and not 1 <= port <= 65535)
                or path.endswith("/v1/v1")
                or any(not re.fullmatch(r"[A-Za-z0-9._~-]+", part) or part in {".", ".."}
                       for part in segments)):
            raise ValueError()
    except ValueError:
        raise ValueError("Use a gateway HTTP(S) base URL with a safe optional path prefix (/v1 optional), without credentials/query/fragment") from None
    if url.scheme == "http":
        try:
            address = ipaddress.ip_address(url.hostname)
        except ValueError:
            raise ValueError("Private HTTP requires a numeric private/Tailscale IP; use HTTPS for hostnames") from None
        if not allow_private_http or not any(address in net for net in PRIVATE_NETWORKS):
            raise ValueError("HTTP requires --allow-private-http and a private/Tailscale IP; prefer HTTPS")
    return urllib.parse.urlunsplit((url.scheme, url.netloc, path.removesuffix("/v1"), "", ""))


def key_path(value):
    path = Path(value).expanduser()
    if not path.is_absolute() or any(ord(c) < 32 or ord(c) == 127 for c in str(path)):
        raise ValueError("Credential file must be an absolute path without control characters")
    # Check every component: a symlinked credential or directory can redirect reads.
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError("Credential path must not contain symlinks")
    return path


def read_key(value):
    path = key_path(value)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600
                or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_size > 8192):
            raise ValueError("Credential must be an owned, regular, single-link mode-0600 file (max 8 KiB)")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            raw = stream.read(8193)
        try:
            token = raw.decode("ascii").strip()
        except UnicodeError:
            raise ValueError("Credential file must contain an ASCII Bearer token") from None
        if not token or len(raw) > 8192 or not re.fullmatch(r"[A-Za-z0-9._~+/=-]+", token):
            raise ValueError("Credential file must contain one nonempty Bearer token")
        return token
    finally:
        os.close(fd)


def key_reference(path):
    # Pi executes !command verbatim; environment interpolation/$$ escaping
    # applies only to non-command config values. Quote every shell argument.
    command = shlex.join([str(ROOT / "bin/pi-gateway"), "key", "--key-file", str(key_path(path))])
    return "!" + command


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch_catalog(url, key_file):
    request = urllib.request.Request(url + "/v1/models/canonical", headers={
        "Authorization": "Bearer " + read_key(key_file), "Accept": "application/json",
    })
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=10) as response:
            if response.status != 200:
                raise ValueError("Gateway catalog did not return HTTP 200")
            raw = response.read(LIMIT + 1)
    except urllib.error.HTTPError as exc:
        # Never print bodies, URLs or headers supplied by an untrusted endpoint.
        raise ValueError(f"Gateway catalog HTTP {exc.code}; check client auth and /v1/models/canonical support") from None
    except (urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError):
        raise ValueError("Gateway discovery failed; check TLS, Tailscale connectivity and endpoint") from None
    if len(raw) > LIMIT:
        raise ValueError("Gateway catalog exceeds 1 MiB")
    try:
        return json.loads(raw)
    except (ValueError, UnicodeError):
        raise ValueError("Gateway returned an invalid JSON catalog") from None


def discover(url, key_file, allow_private_http):
    # A subprocess deadline also bounds DNS and slow-drip responses; socket
    # timeouts alone do not bound the complete discovery operation.
    args = [sys.executable, str(ROOT / "bin/pi-gateway"), "_discover",
            "--url", url, "--key-file", str(key_file)]
    if allow_private_http:
        args.append("--allow-private-http")
    try:
        result = subprocess.run(args, capture_output=True, timeout=20, check=False)
    except subprocess.TimeoutExpired:
        raise ValueError("Gateway discovery exceeded the 20-second deadline") from None
    if result.returncode:
        # Never relay child stderr: unexpected HTTP/parser tracebacks can echo
        # attacker-controlled response bytes, including the request credential.
        raise ValueError("Gateway discovery failed; check TLS/network, client auth and /v1/models/canonical support")
    return json.loads(result.stdout)


def aliases_from_catalog(catalog):
    rows = catalog.get("data") if isinstance(catalog, dict) else None
    if not isinstance(rows, list) or not rows or len(rows) > MODEL_LIMIT:
        raise ValueError("Expected a canonical gateway catalog with 1–1000 models")
    aliases, seen = {}, set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("Invalid canonical model row")
        model = row.get("id")
        if (not isinstance(model, str) or not model or len(model) > 256
                or any(ord(c) < 33 or ord(c) == 127 for c in model) or model in seen):
            raise ValueError("Invalid or duplicate canonical model ID")
        seen.add(model)
        if type(row.get("available")) is not bool:
            raise ValueError("Canonical models must declare availability")
        if not row["available"]:
            continue
        context, output = row.get("context_length"), row.get("max_output_tokens")
        if any(type(v) is not int or not 0 < v <= 100_000_000 for v in (context, output)):
            raise ValueError("Available models must declare positive context and output limits")
        levels = row.get("thinking_levels")
        if (not isinstance(levels, list) or any(not isinstance(v, str) or v not in LEVELS for v in levels)
                or len(set(levels)) != len(levels) or type(row.get("vision")) is not bool):
            raise ValueError("Available models must declare valid thinking and vision capabilities")
        # Stable, bounded, safe aliases even for slash/colon IDs. Always include
        # a digest so adding a similarly named model cannot rename an old alias.
        slug = re.sub(r"[^A-Za-z0-9_-]", "-", model).strip("-_")[:48] or "model"
        alias = "gw-" + slug + "-" + digest(model.encode())[:12]
        aliases["cloud:" + model] = {
            "alias": alias, "provider_model_id": model, "provider": "model-gateway",
            "context": context, "max_output_tokens": min(output, context),
            "thinking_levels": levels, "vision": row["vision"],
            # The gateway owns native-provider translation; Responses supports
            # both native Responses routes and Messages/Chat translation.
            "api_style": "open_responses", "pi": {"id": model, "name": model},
        }
    if not aliases:
        raise ValueError("Gateway has no available models; existing configuration was not changed")
    return aliases


def configuration(cli_out):
    path = Path(cli_out).expanduser().absolute()
    config = load_config(path)
    refresh(path, config, check=True)  # no writes; protect manual edits
    values = generation_values(config["generation"]["args"])
    if "--models-out" not in values:
        raise ValueError("Run pi-shared setup first to prepare managed model output")
    return path, config, values


def artifact_paths(cli, values, credential):
    aliases = cli.with_name(cli.stem + ".gateway-aliases.json")
    paths = [cli, aliases, Path(values["--models-out"]), key_path(credential)]
    if len({p.resolve() for p in paths}) != len(paths):
        raise ValueError("Gateway credential/input/output paths overlap")
    for path in paths[:-1]:
        if path.is_symlink():
            raise ValueError("Gateway outputs must not be symlinks")
        if path.exists():
            read_owned(path)
        parent = path.parent
        while not parent.exists():
            parent = parent.parent
        info = parent.stat()
        if info.st_uid != os.getuid() or info.st_mode & 0o022:
            raise ValueError("Unsafe gateway output directory")
    return aliases


def connect(args):
    url = gateway_url(args.url, args.allow_private_http)
    read_key(args.key_file)
    cli, config, values = configuration(args.cli_out)
    aliases_path = artifact_paths(cli, values, args.key_file)
    if aliases_path.exists() and values["--aliases"] != str(aliases_path):
        raise ValueError("Refusing to replace an existing unmanaged gateway catalog")
    aliases = aliases_from_catalog(discover(url, args.key_file, args.allow_private_http))
    # Perform all discovery and rendering validation before changing artifacts.
    alias_text = dump(aliases)
    values.update({"--aliases": str(aliases_path), "--gateway-url": url,
                   "--gateway-api-key": key_reference(args.key_file)})
    values.pop("--omlx-status", None)
    values.pop("--omlx-status-url", None)
    argv = [part for flag, value in values.items() for part in ([flag] if value is True else [flag, value])]
    models = dump_models(render_models(aliases, provider_name=values["--provider-name"],
                               gateway_url=url, gateway_api_key=values["--gateway-api-key"]))
    updated = make_config(aliases, argv, {}, digest(models.encode()), digest(alias_text.encode()),
                          config.get("defaultProfile"))
    # Atomic per-file replacement, not a cross-file transaction. The setup
    # receipt remains incomplete on I/O failure; inspect partial output before retrying.
    atomic_write(aliases_path, alias_text)
    atomic_write(Path(values["--models-out"]), models)
    atomic_write(cli, dump(updated))
    print(f"Configured {len(aliases)} remote model routes. Catalog/auth read succeeded; inference was not tested.")


def check(args):
    url = gateway_url(args.url, args.allow_private_http)
    read_key(args.key_file)
    cli, config, values = configuration(args.cli_out)
    aliases_path = artifact_paths(cli, values, args.key_file)
    if (values.get("--gateway-url") != url or values.get("--gateway-api-key") != key_reference(args.key_file)
            or values.get("--aliases") != str(aliases_path)
            or not any(route["gateway"] for route in config["routes"].values())):
        raise ValueError("Saved gateway connection does not match the managed launcher")
    print("Remote gateway configuration valid (offline); reachability/authentication/inference not tested.")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    for action in ("connect", "check", "_discover", "key"):
        command = commands.add_parser(action)
        command.add_argument("--key-file", required=True)
        if action != "key":
            command.add_argument("--url", required=True)
            command.add_argument("--allow-private-http", action="store_true")
        if action in {"connect", "check"}:
            command.add_argument("--cli-out", required=True)
    args = parser.parse_args(argv)
    try:
        if args.action == "key":
            print(read_key(args.key_file))
        elif args.action == "_discover":
            print(json.dumps(fetch_catalog(gateway_url(args.url, args.allow_private_http), args.key_file)))
        elif args.action == "connect":
            connect(args)
        else:
            check(args)
        return 0
    except (ValueError, OSError) as exc:
        # File/network error strings can contain paths but never credential bytes.
        print(f"pi-gateway: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
