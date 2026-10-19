#!/usr/bin/env python3
"""Runs inside each application unit's cgroup before starting the application.

Refuse startup if a direct public IPv4 socket is not explicitly denied by the OS.
No request targets a financial endpoint. TEST-NET-1 is reserved for documentation.
The required nftables unit installs an admin-prohibited rule before this check.
A timeout does not count as network confinement.
"""
import errno
import json
import socket
import urllib.request

opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
with opener.open('http://127.0.0.1:18082/certs', timeout=8) as response:
    if not json.load(response):
        raise SystemExit('Certificate-only proxy readiness failed')
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
    probe.settimeout(3)
    try:
        result = probe.connect_ex(('192.0.2.1', 443))
    except PermissionError:
        result = errno.EACCES
    if result not in {errno.EPERM, errno.EACCES, errno.EHOSTUNREACH}:
        raise SystemExit('Public egress did not return a denial from the required network policy; refusing UAT2 startup')
try:
    with socket.socket(socket.AF_INET6, socket.SOCK_STREAM):
        pass
except OSError as exc:
    if exc.errno not in {errno.EAFNOSUPPORT, errno.EPERM, errno.EACCES, errno.EHOSTUNREACH}:
        raise
else:
    raise SystemExit('Native UAT2 requires IPv6 socket creation to be restricted')
print('UAT2 process network confinement verified')
