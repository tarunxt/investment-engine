"""Linux-only, fail-closed runner for Bullpen's in-memory acceptance selection.

Install an inherited kernel egress fence before pytest, app, HTTP or SDK imports.
No inet sockets/connects or io_uring bypass; AF_UNIX socketpairs remain usable by
asyncio. Python guards additionally fail tests on attempted egress. Only explicit
HTTPX MockTransport/ASGITransport fixtures are allowed. No TCP/PG/browser fixture
is allowed by this runner; they require their own reviewed local-only harness.
"""
from __future__ import annotations

import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import sys


if not sys.flags.no_site:
    raise RuntimeError("Run with python -S: site hooks must not precede the fence")


def kernel_fence():
    if sys.platform != "linux":
        raise RuntimeError("Linux libseccomp required; refusing unguarded tests")
    for fd in Path("/proc/self/fd").iterdir():
        try:
            if int(fd.name) > 2 and os.readlink(fd).startswith("socket:"):
                os.close(int(fd.name))
        except (FileNotFoundError, OSError):
            pass
    lib = None
    for path in ("/lib/x86_64-linux-gnu/libseccomp.so.2", "/usr/lib/x86_64-linux-gnu/libseccomp.so.2",
                 "/lib/aarch64-linux-gnu/libseccomp.so.2", "/usr/lib/aarch64-linux-gnu/libseccomp.so.2"):
        try:
            lib = ctypes.CDLL(path, use_errno=True)
            break
        except OSError:
            continue
    if lib is None:
        raise RuntimeError("libseccomp missing; refusing unguarded tests")
    class Arg(ctypes.Structure):
        _fields_ = [("arg", ctypes.c_uint), ("op", ctypes.c_int),
                    ("a", ctypes.c_uint64), ("b", ctypes.c_uint64)]
    lib.seccomp_init.argtypes = [ctypes.c_uint32]
    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_syscall_resolve_name.restype = ctypes.c_int
    lib.seccomp_rule_add_array.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int,
                                          ctypes.c_uint, ctypes.POINTER(Arg)]
    lib.seccomp_load.argtypes = [ctypes.c_void_p]
    lib.seccomp_release.argtypes = [ctypes.c_void_p]
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
        raise RuntimeError("Could not set no_new_privs")
    ctx = lib.seccomp_init(0x7FFF0000)  # SCMP_ACT_ALLOW
    if not ctx:
        raise RuntimeError("Could not allocate seccomp filter")
    try:
        for name in ("socket", "connect", "socketcall", "io_uring_setup", "io_uring_enter", "io_uring_register"):
            syscall = lib.seccomp_syscall_resolve_name(name.encode())
            if syscall < 0:
                if name in {"socket", "connect"}:
                    raise RuntimeError("Required syscall unavailable")
                continue
            # SCMP_CMP_NE, socket family != AF_UNIX (1). connect is denied even
            # for AF_UNIX, preventing local proxy/DNS-daemon forwarding.
            comparison = Arg(0, 1, 1, 0)
            result = lib.seccomp_rule_add_array(ctx, 0x00050000 | errno.EPERM,
                syscall, 1 if name == "socket" else 0,
                ctypes.byref(comparison) if name == "socket" else None)
            if result != 0:
                raise RuntimeError(f"Could not fence syscall {name}")
        if lib.seccomp_load(ctx) != 0:
            raise RuntimeError("Could not load seccomp filter")
    finally:
        lib.seccomp_release(ctx)
    # Native syscall probe: no destination, DNS, HTTP or provider invocation.
    libc.socket.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int]
    ctypes.set_errno(0)
    if libc.socket(2, 1, 0) != -1 or ctypes.get_errno() != errno.EPERM:
        raise RuntimeError("Native AF_INET fence verification failed")
    return {"native_inet_socket": "EPERM", "connect": "denied", "io_uring": "denied"}


FENCE = kernel_fence()  # Before every third-party/pytest/application import.
# -S skips site hooks. Add installed packages only after the kernel fence;
# do not execute .pth/sitecustomize code via site.main().
package_path = Path(sys.executable).parent.parent / "lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "site-packages"
if not package_path.is_dir():
    raise RuntimeError("Explicit local test package directory missing")
sys.path.insert(0, str(package_path))

import asyncio
from datetime import UTC, datetime
import socket
import subprocess

# Verify inheritance using only an explicit local Python fixture, no endpoint.
probe = subprocess.run([sys.executable, "-S", "-c", "import socket,errno;\ntry: socket.socket(socket.AF_INET,socket.SOCK_STREAM)\nexcept OSError as e: raise SystemExit(0 if e.errno==errno.EPERM else 2)\nelse: raise SystemExit(3)"],
                       capture_output=True, check=False)
if probe.returncode != 0:
    raise RuntimeError("Child-process egress fence verification failed")
FENCE["child_process_inet_socket"] = "EPERM"
EVENTS = []


def block(*args, **kwargs):
    EVENTS.append("blocked_egress_or_unapproved_subprocess")
    raise RuntimeError("Offline test attempted egress/unapproved process; details redacted")


async def async_block(*args, **kwargs):
    return block(*args, **kwargs)


# Deny DNS and sockets before loading HTTP libraries or SDKs. AF_UNIX
# socketpair write/read operations remain available to the local event loop.
socket.getaddrinfo = block
socket.gethostbyname = block
socket.gethostbyname_ex = block
socket.gethostbyaddr = block
socket.socket.connect = block
socket.socket.connect_ex = block
socket.socket.sendto = block
socket.create_connection = block
subprocess.Popen = block
os.system = block
os.popen = block
if hasattr(os, "posix_spawn"):
    os.posix_spawn = block
if hasattr(os, "posix_spawnp"):
    os.posix_spawnp = block
asyncio.create_subprocess_exec = async_block
asyncio.create_subprocess_shell = async_block

import urllib.request
import urllib3
import requests
import httpx

urllib.request.urlopen = block
urllib.request.OpenerDirector.open = block
urllib3.PoolManager.request = block
requests.sessions.Session.request = block
sync_send, async_send = httpx.Client.send, httpx.AsyncClient.send


def mock_transport(client, request):
    transport = client._transport_for_url(request.url)
    return isinstance(transport, (httpx.MockTransport, httpx.ASGITransport))


def guarded_send(client, request, *args, **kwargs):
    return sync_send(client, request, *args, **kwargs) if mock_transport(client, request) else block()


async def guarded_async_send(client, request, *args, **kwargs):
    return await async_send(client, request, *args, **kwargs) if mock_transport(client, request) else block()


httpx.Client.send = guarded_send
httpx.AsyncClient.send = guarded_async_send
# DDGS uses a native Rust HTTP client: deny its callable surface in addition
# to the inherited kernel fence. Other installed SDK HTTP stacks are fenced by
# HTTPX/requests/urllib and native syscalls; no SDK/client is initialized here.
from duckduckgo_search import DDGS
for method in ("text", "news", "images", "videos", "maps", "translate", "suggestions"):
    if hasattr(DDGS, method):
        setattr(DDGS, method, block)

os.environ["PYTEST_DISABLE_PLUGIN_AUTOLOAD"] = "1"
os.environ["DATABASE_URL"] = "postgresql+asyncpg://synthetic:synthetic@localhost/synthetic"
os.environ["REDIS_URL"] = "redis://localhost:6379/15"
for name in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "DEEPSEEK_API_KEY"):
    os.environ[name] = "offline-synthetic-not-a-credential"
os.environ.pop("TAVILY_API_KEY", None)

import pytest


class Audit:
    @pytest.hookimpl(hookwrapper=True)
    def pytest_runtest_protocol(self, item, nextitem):
        before = len(EVENTS)
        yield
        if len(EVENTS) != before:
            pytest.fail("Offline fence intercepted an attempted egress/process call", pytrace=False)

    def pytest_sessionfinish(self, session, exitstatus):
        if EVENTS:
            session.exitstatus = 1
        print(json.dumps({"offline_guard": FENCE, "recorded_python_attempts": len(EVENTS),
                          "finish_utc": datetime.now(UTC).isoformat()}))


print(json.dumps({"start_utc": datetime.now(UTC).isoformat(), "offline_guard": FENCE,
                  "runner_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                  "source_head": os.environ.get("BULLPEN_TEST_SOURCE_HEAD", "not-supplied"),
                  "fixtures": "SQLite/in-memory HTTPX transports only; no browser or TCP fixture"}))
raise SystemExit(pytest.main(["-p", "anyio.pytest_plugin", *sys.argv[1:]], plugins=[Audit()]))
