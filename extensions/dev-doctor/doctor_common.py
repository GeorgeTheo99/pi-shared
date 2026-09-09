"""Small stdlib-only reporting/process primitives shared by the doctor checkers."""
from __future__ import annotations

from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import selectors
import signal
import stat
import subprocess
import time

MAX_BYTES = 256 * 1024


class CheckError(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def capability(name, probe_type, outcome, guidance, **fields):
    return {"capability": name, "installed": "unknown", "loaded": "unknown",
            "active": "unknown", "configured": "unknown", "verified_at": timestamp(),
            "probe_type": probe_type, "outcome": outcome, "guidance": guidance, **fields}


def read_bytes(path: Path, limit=MAX_BYTES):
    # Refuse devices/FIFOs and bound regular-file reads, including configuration.
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise CheckError("invalid_config", "Configuration must be a regular file")
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise CheckError("output_limit", "File exceeds the configured byte limit")
    return data


def read_json(path: Path):
    try:
        return json.loads(read_bytes(path))
    except (ValueError, UnicodeError, RecursionError):
        raise CheckError("invalid_config", "Configuration is not valid JSON") from None


def positive_timeout(value):
    value = float(value)
    if not math.isfinite(value) or value <= 0:
        raise ValueError("timeout must be finite and positive")
    return value


def timeout_value(value):
    value = positive_timeout(value)
    if value > 60:
        raise ValueError("timeout must be at most 60 seconds")
    return value


def bounded_run(argv, *, env=None, cwd=None, seconds=10, new_session=True):
    """Bound total wall time and combined pipes; never return partial success.

    SIGTERM propagates to the probe group (including on wrapper cancellation).
    Escaped descendants are outside this operational cleanup guarantee.
    """
    try:
        process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   start_new_session=new_session)
    except OSError:
        raise CheckError("spawn_error", "Probe executable could not be started") from None

    def kill_group():
        try:
            if new_session:
                os.killpg(process.pid, signal.SIGKILL)
            else:
                process.kill()  # The outer doctor owns and cleans this process group.
        except OSError:
            # A vanished group can also yield EPERM on macOS. Cleanup is best
            # effort and must not replace the original timeout/cancel outcome.
            pass

    def interrupted(_signum, _frame):
        kill_group()
        raise CheckError("canceled", "Probe canceled")

    previous = signal.signal(signal.SIGTERM, interrupted)
    deadline = time.monotonic() + seconds
    streams = {process.stdout: bytearray(), process.stderr: bytearray()}
    retained = 0
    try:
        with selectors.DefaultSelector() as selector:
            for stream in streams:
                selector.register(stream, selectors.EVENT_READ)
            while selector.get_map() or process.poll() is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise CheckError("timeout", f"Probe timed out after {seconds:g}s; no successful load was verified")
                for key, _ in selector.select(min(remaining, 0.05)):
                    chunk = os.read(key.fileobj.fileno(), 16384)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    retained += len(chunk)
                    if retained > MAX_BYTES:
                        raise CheckError("output_limit", "Probe output exceeded 256 KiB; result is incomplete")
                    streams[key.fileobj].extend(chunk)
        return process.returncode, *(bytes(data).decode("utf-8", "replace") for data in streams.values())
    finally:
        # Also clean in-group children after a successful leader exits.
        kill_group()
        for stream in streams:
            stream.close()
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            pass  # Signaling is not proof of cleanup; no such claim is reported.
        signal.signal(signal.SIGTERM, previous)
