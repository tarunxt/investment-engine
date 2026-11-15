"""Bounded API/BFF smoke test of this worktree's running synthetic preview.

No live providers or production targets are accepted. Results exclude tokens.
"""
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

import requests

ROOT = Path(__file__).resolve().parents[2]
runtime = ROOT / ".runtime/stage01-preview"
state = json.loads((runtime / "state.json").read_text())
api = state["backend_url"]
# Auth.js canonicalizes this baseline's local redirects to localhost.
ui = f"http://localhost:{state['frontend_port']}"
for origin in (api, ui):
    parsed = urlsplit(origin)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"} or not parsed.port:
        raise RuntimeError("Only explicit loopback preview ports are permitted")

checks = []


def check(name, condition):
    if not condition:
        raise AssertionError(name)
    checks.append(name)


def call(method, path, token=None, **kwargs):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return requests.request(method, api + path, headers=headers, timeout=10, **kwargs)


check("synthetic health", call("GET", "/preview-health").json()["synthetic"] is True)
check("unauthenticated profile denied", call("GET", "/auth/profile").status_code == 401)
check("wrong password denied", call("POST", "/auth/login", json={"username": "usera", "password": "incorrect"}).status_code == 401)
tokens = {}
ids = []
for name in ("usera", "userb", "admin"):
    response = call("POST", "/auth/login", json={"email": f"{name}@stage01.example.com", "password": "SyntheticPreview123!"})
    check(f"{name} real login", response.status_code == 200)
    body = response.json()
    tokens[name] = body["access_token"]
    ids.append(body["user"]["id"])
    check(f"{name} role preserved", body["user"]["role"] == ("admin" if name == "admin" else "user"))
check("three independent user IDs", len(set(ids)) == 3)
original_a = call("GET", "/auth/profile", tokens["usera"]).json()
original_b = call("GET", "/auth/profile", tokens["userb"]).json()
try:
    check("user A preference write", call("PUT", "/auth/profile", tokens["usera"], json={"timezone": "Asia/Kolkata"}).status_code == 200)
    check("user A preference persists", call("GET", "/auth/profile", tokens["usera"]).json()["timezone"] == "Asia/Kolkata")
    check("user B preference unchanged", call("GET", "/auth/profile", tokens["userb"]).json() == original_b)
finally:
    call("PUT", "/auth/profile", tokens["usera"], json={"timezone": original_a["timezone"]}).raise_for_status()
for method, path in (("POST", "/auth/forgot-password"), ("POST", "/auth/google"),
                     ("POST", "/zerodha/orders/place-protected-market"), ("POST", "/jobs"),
                     ("GET", "/google-sheets")):
    check(f"external action blocked: {method} {path}", call(method, path, tokens["admin"], json={}).status_code == 503)
check("fake Google config disabled", call("GET", "/auth/google/config").json()["enabled"] is False)

for name in ("usera", "userb", "admin"):
    session = requests.Session()
    session.trust_env = False
    csrf = session.get(ui + "/api/auth/csrf", timeout=10).json()["csrfToken"]
    response = session.post(ui + "/api/auth/callback/credentials", data={
        "csrfToken": csrf, "email": f"{name}@stage01.example.com", "password": "SyntheticPreview123!",
        "callbackUrl": ui + "/console/profile/preferences", "json": "true"},
        headers={"X-Auth-Return-Redirect": "1"}, timeout=10)
    check(f"{name} Auth.js BFF login", response.status_code == 200 and "error" not in response.json().get("url", ""))
    browser_session = session.get(ui + "/api/auth/session", timeout=10).json()
    check(f"{name} BFF identity", browser_session.get("user", {}).get("email") == f"{name}@stage01.example.com")
    check(f"{name} BFF hides bearer tokens", "accessToken" not in browser_session and "refreshToken" not in browser_session)
    page = session.get(ui + "/console/profile/preferences", timeout=10)
    check(f"{name} authenticated real preferences HTML", page.status_code == 200 and "Update your application settings" in page.text)
    profile = session.get(ui + "/backend-api/auth/profile", timeout=10)
    check(f"{name} authenticated profile BFF", profile.status_code == 200)
    csrf = session.get(ui + "/api/auth/csrf", timeout=10).json()["csrfToken"]
    session.post(ui + "/api/auth/signout", data={"csrfToken": csrf, "callbackUrl": ui + "/login"},
                 headers={"X-Auth-Return-Redirect": "1"}, timeout=10).raise_for_status()
    check(f"{name} logout clears session", session.get(ui + "/api/auth/session", timeout=10).json() is None)
    check(f"{name} logged-out BFF denial", session.get(ui + "/backend-api/auth/profile", timeout=10).status_code == 401)

probe_env = {"PATH": "/usr/bin:/bin", "STAGE01_PREVIEW": "synthetic-only", "ENVIRONMENT": "test",
             "AUTH_DISABLED": "false", "DATABASE_URL": f"sqlite+aiosqlite:///{runtime / 'preview.sqlite3'}",
             "REDIS_URL": "redis://127.0.0.1:1/0", "FRONTEND_URL": ui,
             "PYTHONPATH": str(ROOT / "backend") + ":" + str(ROOT), "PYTHONDONTWRITEBYTECODE": "1"}
probe = subprocess.run([sys.executable, "-c", "from scripts.public_launch import preview_backend; import socket; "
                        "socket.create_connection(('192.0.2.1',443))"], cwd=ROOT, env=probe_env,
                       capture_output=True, text=True, timeout=30)
check("backend outbound socket denied before connection", probe.returncode != 0 and "preview prohibits outbound" in probe.stderr)
node = os.environ.get("STAGE01_NODE") or shutil.which("node")
if not node:
    candidates = sorted((Path.home() / "Library/Application Support/Codex/artifact-sessions/runtime-generations").glob("*/runtime/bin/node"))
    node = str(candidates[-1]) if candidates else None
if not node:
    raise RuntimeError("Node required for frontend outbound-boundary probe")
probe = subprocess.run([node, "--require", str(ROOT / "scripts/public_launch/preview_network.cjs"),
                        "-e", "require('node:net').connect({host:'192.0.2.1',port:443})"],
                       env={"PATH": "/usr/bin:/bin", "STAGE01_ALLOWED_PORTS": str(state["backend_port"])},
                       capture_output=True, text=True, timeout=10)
check("frontend external socket denied before connection", probe.returncode != 0 and "preview prohibits external" in probe.stderr)

report = {"checked_at": datetime.now(timezone.utc).isoformat(), "frontend": ui, "backend": api,
          "checks": checks, "passed": len(checks), "limitations": ["SQLite only; no PostgreSQL/Redis parity",
          "real Auth.js and auth/profile handlers; harness limits all other routes",
          "no real Google/provider/email/broker/queue activity; not UAT acceptance"]}
(runtime / "verification.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
