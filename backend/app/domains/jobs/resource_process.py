"""Local subprocess deadline primitive; not provider cancellation certification.

Only trusted, fixed backend entrypoints may supply argv. No API exposes this
function. A killed connection/process cannot prove the remote provider stopped or
was unbilled; every unsuccessful outcome requires retained reservations and no
blind replay. No production worker/provider is wired to this primitive yet.
"""
from __future__ import annotations

import json
import math
import os
import selectors
import signal
import subprocess
import time
from collections.abc import Sequence

from .resource_policy import MAX_BODY_BYTES, REQUEST_SECONDS, ResourceBlocked


class LocalInvocationUncertain(ResourceBlocked):
    """Local work stopped or unconfirmed; external consumption is still unknown."""


def invoke_local_json_process(argv: Sequence[str], payload: dict, *, remaining_job_seconds: float,
                              cancel_event=None, request_seconds: float = REQUEST_SECONDS,
                              maximum_wire_bytes: int = MAX_BODY_BYTES) -> dict:
    """Bound an interruptible POSIX child/process-group without a helper thread.

    Caller must atomically reserve and preserve the original job deadline before
    entry; remaining_job_seconds is NOT a new allowance. This only enforces this
    local boundary and must not be labeled a confirmed invoice or remote cancel.
    Wire bytes are an internal IPC safety bound, not a tokenizer approximation.
    """
    if os.name != "posix":
        raise ResourceBlocked("Local process deadline enforcement is unavailable")
    if (not isinstance(argv, (tuple, list)) or not argv
            or any(not isinstance(value, str) or not value or "\x00" in value for value in argv)
            or not isinstance(payload, dict)):
        raise ResourceBlocked("Unrecognized local invocation contract")
    for value in (remaining_job_seconds, request_seconds):
        if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
            raise ResourceBlocked("No remaining local execution deadline")
    if type(maximum_wire_bytes) is not int or maximum_wire_bytes <= 0:
        raise ResourceBlocked("Invalid local result envelope")
    if cancel_event is not None and cancel_event.is_set():
        raise ResourceBlocked("Cancelled before local invocation; no process started")
    try:
        wire = json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    except (ValueError, TypeError, UnicodeEncodeError):
        raise ResourceBlocked("Local invocation input is not bounded JSON") from None
    if len(wire) > MAX_BODY_BYTES:
        raise ResourceBlocked("Local invocation input exceeds the approved body envelope")
    deadline = time.monotonic() + min(remaining_job_seconds, request_seconds, REQUEST_SECONDS)
    process = None
    selector = selectors.DefaultSelector()
    output = bytearray()
    offset = 0
    try:
        process = subprocess.Popen(tuple(argv), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, start_new_session=True, close_fds=True)
        for stream, event in ((process.stdin, selectors.EVENT_WRITE), (process.stdout, selectors.EVENT_READ),
                              (process.stderr, selectors.EVENT_READ)):
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, event)
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0 or (cancel_event is not None and cancel_event.is_set()):
                raise LocalInvocationUncertain("Local invocation deadline/cancellation reached; retain consumption evidence")
            for key, _ in selector.select(min(remaining, 0.05)):
                stream = key.fileobj
                if stream is process.stdin:
                    try:
                        offset += os.write(stream.fileno(), wire[offset:offset + 65536])
                    except BrokenPipeError:
                        offset = len(wire)
                    if offset == len(wire):
                        selector.unregister(stream)
                        stream.close()
                else:
                    data = os.read(stream.fileno(), 65536)
                    if not data:
                        selector.unregister(stream)
                        stream.close()
                    elif stream is process.stdout:
                        output.extend(data)
                        if len(output) > maximum_wire_bytes:
                            raise LocalInvocationUncertain("Local result envelope exceeded; no partial result accepted")
                    # Stderr is drained but never logged, retained or surfaced.
        if process.wait(timeout=max(0.001, deadline - time.monotonic())) != 0:
            raise LocalInvocationUncertain("Local invocation failed; external consumption remains unknown")
        if time.monotonic() >= deadline or (cancel_event is not None and cancel_event.is_set()):
            raise LocalInvocationUncertain("Local invocation finished after authorization expired")
        try:
            result = json.loads(output)
        except (ValueError, UnicodeDecodeError):
            raise LocalInvocationUncertain("Local invocation returned unconfirmed output") from None
        if not isinstance(result, dict):
            raise LocalInvocationUncertain("Local invocation result does not match its contract")
        return result
    except ResourceBlocked:
        raise
    except Exception:
        # Even startup/pipe errors are not proof of non-acceptance after spawn.
        if process is not None:
            raise LocalInvocationUncertain("Local invocation outcome is uncertain; do not replay") from None
        raise ResourceBlocked("Local process could not be started; no invocation authorized") from None
    finally:
        if process is not None:
            # Kill the owned process group even if its parent exited and left a
            # pipe-holding descendant. No foreign process group is addressed.
            cleanup_unknown = False
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except OSError:
                cleanup_unknown = True
            try:
                process.wait(timeout=1.0)
            except subprocess.TimeoutExpired:
                cleanup_unknown = True
            finally:
                for stream in (process.stdin, process.stdout, process.stderr):
                    if stream is not None and not stream.closed:
                        stream.close()
                selector.close()
            if cleanup_unknown:
                raise LocalInvocationUncertain("Local cleanup could not be confirmed; retain reservations")
        else:
            selector.close()
