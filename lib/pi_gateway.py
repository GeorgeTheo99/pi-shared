"""Remote gateway discovery: explicit connect/probe/sync, plus a throttled background
auto-sync that pi-launch starts for a saved connection. Launcher refresh stays offline."""
from __future__ import annotations

import argparse
import fcntl
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
import time
import urllib.error
import urllib.parse
import urllib.request

from pi_cli import (ROOT, atomic_write, digest, dump, generation_values, load_config,
                    make_config, read_owned, refresh)
from pi_catalog import merge_models, render_models

LIMIT = 1024 * 1024
MODEL_LIMIT = 1000
LEVELS = {"off", "minimal", "low", "medium", "high", "xhigh", "max"}
PRIVATE_NETWORKS = tuple(ipaddress.ip_network(net) for net in (
    "127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
    "100.64.0.0/10", "::1/128", "fc00::/7",
))
# probe exit codes; argparse owns 2 for usage errors.
DRIFT, AUTH_REJECTED, UNREACHABLE = 3, 4, 5
# Minimum seconds between background catalog reads for one launcher.
AUTO_SYNC_INTERVAL = 15 * 60


class GatewayError(ValueError):
    def __init__(self, message, code):
        super().__init__(message)
        self.code = code


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
        if exc.code in (401, 403):
            raise GatewayError(f"Gateway catalog HTTP {exc.code}", AUTH_REJECTED) from None
        raise ValueError(f"Gateway catalog HTTP {exc.code}; check client auth and /v1/models/canonical support") from None
    except (urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError):
        raise GatewayError("Gateway discovery failed; check TLS, Tailscale connectivity and endpoint",
                           UNREACHABLE) from None
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
        raise GatewayError("Gateway discovery exceeded the 20-second deadline", UNREACHABLE) from None
    # Exit codes are chosen by our own child, so they are safe to interpret.
    if result.returncode == AUTH_REJECTED:
        raise GatewayError("Gateway rejected the client key (HTTP 401/403); it was likely rotated or retired. "
                           "Write a new consumer key from the gateway operator into the mode-0600 key file, "
                           "then rerun pi-gateway connect to refresh the catalog", AUTH_REJECTED)
    if result.returncode == UNREACHABLE:
        raise GatewayError("Gateway unreachable; check TLS, Tailscale connectivity and endpoint", UNREACHABLE)
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


def write_catalog(cli, config, values, aliases_path, url, key_file, aliases):
    """Render everything in memory, then replace the three managed files."""
    alias_text = dump(aliases)
    values = {**values, "--aliases": str(aliases_path), "--gateway-url": url,
              "--gateway-api-key": key_reference(key_file)}
    values.pop("--omlx-status", None)
    values.pop("--omlx-status-url", None)
    argv = [part for flag, value in values.items() for part in ([flag] if value is True else [flag, value])]
    # Only the generated provider is replaced: other providers, top-level keys
    # and the owner's modelOverrides in an existing models.json are kept.
    models_path = Path(values["--models-out"])
    models = merge_models(read_owned(models_path, missing=True),
                          render_models(aliases, provider_name=values["--provider-name"],
                                        gateway_url=url, gateway_api_key=values["--gateway-api-key"],
                                        claude_bridge_only="--claude-bridge-only" in values),
                          values["--provider-name"])
    updated = make_config(aliases, argv, {}, digest(models.encode()), digest(alias_text.encode()),
                          config.get("defaultProfile"))
    # Atomic per-file replacement, not a cross-file transaction. The setup
    # receipt remains incomplete on I/O failure; inspect partial output before retrying.
    atomic_write(aliases_path, alias_text)
    atomic_write(models_path, models)
    atomic_write(cli, dump(updated))


def connect(args):
    url = gateway_url(args.url, args.allow_private_http)
    read_key(args.key_file)
    cli, config, values = configuration(args.cli_out)
    aliases_path = artifact_paths(cli, values, args.key_file)
    if aliases_path.exists() and values["--aliases"] != str(aliases_path):
        raise ValueError("Refusing to replace an existing unmanaged gateway catalog")
    # Perform all discovery and rendering validation before changing artifacts.
    aliases = aliases_from_catalog(discover(url, args.key_file, args.allow_private_http))
    write_catalog(cli, config, values, aliases_path, url, args.key_file, aliases)
    print(f"Configured {len(aliases)} remote model routes. Catalog/auth read succeeded; inference was not tested.")


def saved_connection(args):
    url = gateway_url(args.url, args.allow_private_http)
    read_key(args.key_file)
    cli, config, values = configuration(args.cli_out)
    aliases_path = artifact_paths(cli, values, args.key_file)
    if (values.get("--gateway-url") != url or values.get("--gateway-api-key") != key_reference(args.key_file)
            or values.get("--aliases") != str(aliases_path)
            or not any(route["gateway"] for route in config["routes"].values())):
        raise ValueError("Saved gateway connection does not match the managed launcher")
    return url, aliases_path, cli, config, values


def catalog_ids(aliases):
    return {a.get("provider_model_id") for a in aliases.values() if isinstance(a, dict)}


def saved_ids(aliases_path):
    saved = json.loads(read_owned(aliases_path, missing=True) or b"{}")
    return catalog_ids(saved) if isinstance(saved, dict) else set()


def describe_drift(added, removed):
    for label, models in (("new on gateway", added), ("no longer available", removed)):
        if models:
            print(f"  {len(models)} {label}: " + ", ".join(models[:8]) + (", …" if len(models) > 8 else ""))


def check(args):
    saved_connection(args)
    print("Remote gateway configuration valid (offline); reachability/authentication/inference not tested.")


def probe(args):
    """One authenticated catalog read: no writes, no inference."""
    url, aliases_path, *_ = saved_connection(args)
    remote = catalog_ids(aliases_from_catalog(discover(url, args.key_file, args.allow_private_http)))
    local = saved_ids(aliases_path)
    added, removed = sorted(remote - local), sorted(local - remote)
    if not (added or removed):
        print(f"Remote gateway OK: client key accepted; local catalog matches {len(remote)} available models. "
              "Inference not tested.")
        return 0
    describe_drift(added, removed)
    print("Remote gateway OK, but the local catalog is stale. Refresh it with pi-gateway sync "
          "(same --url/--key-file/--cli-out).")
    return DRIFT


def apply_sync(args, *, keep_missing=False, before_write=None):
    """Apply the remote catalog to the saved connection; writes only when it changed.

    keep_missing retains saved models the gateway no longer lists, so a brief
    availability blip cannot remove routes between explicit syncs.
    """
    url, aliases_path, cli, config, values = saved_connection(args)
    remote = aliases_from_catalog(discover(url, args.key_file, args.allow_private_http))
    raw = read_owned(aliases_path, missing=True)
    saved = json.loads(raw or b"{}")
    saved = saved if isinstance(saved, dict) else {}
    aliases = dict(remote)
    if keep_missing:
        for key, value in saved.items():
            aliases.setdefault(key, value)
    local, current = catalog_ids(saved), catalog_ids(remote)
    added, missing = sorted(current - local), sorted(local - current)
    if raw == dump(aliases).encode():
        return len(aliases), added, missing, False
    if before_write:
        before_write()
    write_catalog(cli, config, values, aliases_path, url, args.key_file, aliases)
    return len(aliases), added, missing, True


def sync(args):
    count, added, removed, changed = apply_sync(args)
    if changed:
        describe_drift(added, removed)
        print(f"Remote gateway catalog refreshed: {count} available models. Inference not tested.")
    else:
        print(f"Remote gateway catalog current: {count} available models. Inference not tested.")
    return 0


def saved_arguments(cli_out):
    """Recover --url/--key-file from a managed launcher; never from user input."""
    cli = Path(cli_out).expanduser().absolute()
    values = generation_values(load_config(cli)["generation"]["args"])
    url, reference = values.get("--gateway-url"), values.get("--gateway-api-key") or ""
    parts = shlex.split(reference[1:]) if reference.startswith("!") else []
    # Only the exact reference connect writes, so ROOT and the flag layout match.
    if (len(parts) != 4 or parts[1:3] != ["key", "--key-file"] or not url
            or values.get("--aliases") != str(cli.with_name(cli.stem + ".gateway-aliases.json"))
            or key_reference(parts[3]) != reference):
        raise ValueError("Launcher has no saved remote gateway connection")
    # connect accepted plain HTTP only with the private-network opt-in.
    return argparse.Namespace(url=url, key_file=parts[3], cli_out=str(cli),
                              allow_private_http=urllib.parse.urlsplit(url).scheme == "http")


def auto_sync_state(cli):
    return cli.with_name(cli.stem + ".gateway-sync.json")


def auto_sync_due(cli):
    try:
        checked = auto_sync_state(cli).stat().st_mtime
    except FileNotFoundError:
        return True
    return time.time() - checked >= AUTO_SYNC_INTERVAL


def auto_sync(args):
    """Background child of pi-launch: at most one catalog read per interval and launcher."""
    cli = Path(args.cli_out).expanduser().absolute()
    held = []

    def update_idle():
        # Never write launcher files halfway through pi-shared setup/update; the
        # lock is held only around writes so an update never waits on the network.
        try:
            fd = os.open(Path.home() / ".config/pi-shared/update.lock", os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            return
        held.append(fd)
        fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)

    try:
        state = os.open(auto_sync_state(cli), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        held.append(state)
        fcntl.flock(state, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        for fd in held:
            os.close(fd)
        return 0  # another auto-sync runs, or the state path is unusable
    try:
        info = os.fstat(state)
        # An empty file was just created or never finished; otherwise honor the interval.
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or (
                info.st_size and time.time() - info.st_mtime < AUTO_SYNC_INTERVAL):
            return 0
        os.utime(state)  # throttle from the attempt, so an outage is not retried every launch
        try:
            count, added, missing, changed = apply_sync(saved_arguments(cli), keep_missing=True,
                                                        before_write=update_idle)
            result = {"result": "refreshed" if changed else "current", "models": count,
                      "added": added, "notListed": missing}
        except BlockingIOError:
            result = {"result": "skipped-update-running"}
        except GatewayError as exc:
            result = {"result": "auth-rejected" if exc.code == AUTH_REJECTED else "unreachable"}
        except Exception as exc:  # a background child has no one to report a traceback to
            result = {"result": "error", "detail": (str(exc) if isinstance(exc, (ValueError, OSError))
                                                    else type(exc).__name__)[:500]}
        result["checkedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        os.ftruncate(state, 0)
        os.pwrite(state, dump(result).encode(), 0)
        if result["result"] == "skipped-update-running":
            os.utime(state, (0, 0))  # retry at the next launch
        return 0 if result["result"] in {"refreshed", "current"} else 1
    finally:
        for fd in held:
            os.close(fd)


def remote_launcher(cli, values):
    return values.get("--aliases") == str(cli.with_name(cli.stem + ".gateway-aliases.json")) \
        and "--gateway-url" in values


def start_auto_sync(cli, config):
    """Called by pi-launch: cheap checks, then a fully detached grandchild."""
    if os.environ.get("PI_GATEWAY_AUTO_SYNC") == "0":
        return False
    try:
        if not remote_launcher(cli, generation_values(config["generation"]["args"])) or not auto_sync_due(cli):
            return False
        # The launcher execs into Pi next, which would never reap a direct child:
        # a short-lived sh backgrounds the job and exits, so launchd adopts it.
        subprocess.run(["/bin/sh", "-c", 'exec </dev/null >/dev/null 2>&1; "$0" "$@" &',
                        sys.executable, str(ROOT / "bin/pi-gateway"), "auto-sync", "--cli-out", str(cli)],
                       stdin=subprocess.DEVNULL, start_new_session=True, cwd="/", close_fds=True,
                       timeout=5, check=True)
        return True
    except Exception:
        return False  # never block or fail a launch on background refresh


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    for action in ("connect", "check", "probe", "sync", "_discover", "key", "auto-sync"):
        command = commands.add_parser(action)
        if action != "auto-sync":
            command.add_argument("--key-file", required=True)
        if action not in {"key", "auto-sync"}:
            command.add_argument("--url", required=True)
            command.add_argument("--allow-private-http", action="store_true")
        if action in {"connect", "check", "probe", "sync", "auto-sync"}:
            command.add_argument("--cli-out", required=True)
    args = parser.parse_args(argv)
    try:
        if args.action == "key":
            print(read_key(args.key_file))
        elif args.action == "_discover":
            print(json.dumps(fetch_catalog(gateway_url(args.url, args.allow_private_http), args.key_file)))
        elif args.action == "connect":
            connect(args)
        elif args.action == "probe":
            return probe(args)
        elif args.action == "sync":
            return sync(args)
        elif args.action == "auto-sync":
            return auto_sync(args)
        else:
            check(args)
        return 0
    except (ValueError, OSError) as exc:
        # File/network error strings can contain paths but never credential bytes.
        print(f"pi-gateway: {exc}", file=sys.stderr)
        return exc.code if isinstance(exc, GatewayError) else 1


if __name__ == "__main__":
    raise SystemExit(main())
