"""Start/stop the actual Next.js UI and synthetic-only backend on loopback."""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / ".runtime/stage01-preview"
STATE = RUNTIME / "state.json"


def process_stamp(pid):
    result = subprocess.run(["/bin/ps", "-p", str(pid), "-o", "lstart=", "-o", "command="],
                            capture_output=True, text=True, check=True)
    return result.stdout.strip()


def port():
    with socket.socket() as server:
        server.bind(("127.0.0.1", 0))
        return server.getsockname()[1]


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument("action", choices=["build", "start", "stop", "status"])
    parser.add_argument("--foreground", action="store_true", help="Keep owned child handles; Ctrl-C stops this preview")
    parser.add_argument("--concept-f-ui", action="store_true", help="Render UAT2-only UI from a committed source.json archive in this disposable synthetic/network-denied preview")
    args = parser.parse_args()
    if args.action not in {"build", "start"}:
        if not STATE.exists():
            print("Preview is stopped")
            return
        state = json.loads(STATE.read_text())
        if args.action == "stop":
            # Verify every process before stopping any group; stale PIDs must not
            # target another task after a reboot or an independent process exit.
            stamps = state.get("process_stamps", {})
            for pid in state["pids"]:
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    continue
                if not stamps.get(str(pid)) or process_stamp(pid) != stamps[str(pid)]:
                    raise SystemExit(f"Refusing unverified/stale preview PID {pid}; inspect state and process ownership")
            for pid in state["pids"]:
                try:
                    os.killpg(pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            STATE.unlink()
            print("Stopped preview process groups; synthetic database retained")
        else:
            print(json.dumps(state, indent=2))
        return
    if STATE.exists():
        raise SystemExit("Preview state already exists; inspect status or stop before starting")
    node = os.environ.get("STAGE01_NODE") or shutil.which("node")
    if not node:
        candidates = sorted((Path.home() / "Library/Application Support/Codex/artifact-sessions/runtime-generations").glob("*/runtime/bin/node"))
        node = str(candidates[-1]) if candidates else None
    if not node or not (ROOT / "frontend/node_modules/next/dist/bin/next").exists():
        raise SystemExit("Node and frontend dependencies required; install frontend/package-lock.json dependencies first")
    for directory in (ROOT, ROOT / "frontend"):
        for name in (".env", ".env.local", ".env.production", ".env.production.local"):
            if (directory / name).exists():
                raise SystemExit(f"Refusing inherited application environment file: {directory / name}")
    RUNTIME.mkdir(parents=True, exist_ok=True)
    build_ports = RUNTIME / "build-ports.json"
    if args.action == "start":
        if not build_ports.exists():
            raise SystemExit("Build this preview first so compiled WebSocket URLs match its unused ports")
        ports = json.loads(build_ports.read_text())
        ui_port, api_port = ports["frontend_port"], ports["backend_port"]
        for value in (ui_port, api_port):
            with socket.socket() as check:
                # Ignore closed connections in TIME_WAIT; an active listener
                # still prevents this bind (SO_REUSEPORT is never enabled).
                check.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                try: check.bind(("127.0.0.1", value))
                except OSError: raise SystemExit("Preview build port is in use; build again to select fresh unused ports")
    else:
        ui_port, api_port = port(), port()
        while api_port == ui_port:
            api_port = port()
    url = f"http://localhost:{ui_port}"
    # Deliberately do not inherit provider, cloud, SMTP, broker or production env.
    common = {"PATH": str(Path(node).parent) + ":/usr/bin:/bin:/usr/local/bin",
              "HOME": str(Path.home()), "TMPDIR": os.environ.get("TMPDIR", "/tmp"),
              "PYTHONDONTWRITEBYTECODE": "1", "ENVIRONMENT": "test", "AUTH_DISABLED": "false",
              "DATABASE_URL": f"sqlite+aiosqlite:///{RUNTIME / 'preview.sqlite3'}",
              "REDIS_URL": "redis://127.0.0.1:1/0", "STAGE01_PREVIEW": "synthetic-only",
              "FRONTEND_URL": url, "PYTHONPATH": str(ROOT / "backend") + ":" + str(ROOT),
              "CREDX_RECOVERY_MODE": "0", "ZERODHA_RECOVERY_MANUAL_ORDERS_ENABLED": "false"}
    frontend = {**common, "NODE_ENV": "production", "NEXT_TELEMETRY_DISABLED": "1",
                "NEXTAUTH_URL": url, "AUTH_URL": url, "NEXTAUTH_SECRET": "stage01-synthetic-local-only",
                "AUTH_SECRET": "stage01-synthetic-local-only", "AUTH_TRUST_HOST": "true",
                "BACKEND_API_URL": f"http://127.0.0.1:{api_port}",
                "API_URL": f"http://127.0.0.1:{api_port}",
                "NEXT_PUBLIC_API_URL": f"http://127.0.0.1:{api_port}",
                "NEXT_PUBLIC_FRONTEND_URL": url, "NEXT_PUBLIC_DISABLE_AUTH": "false",
                "STAGE01_ALLOWED_PORTS": f"{api_port},{ui_port}",
                "NODE_OPTIONS": f'--require="{ROOT / "scripts/public_launch/preview_network.cjs"}"'}
    if args.concept_f_ui:
        frontend["NEXT_PUBLIC_UAT2"] = "true"
    if args.action == "build":
        frontend.pop("NODE_OPTIONS")
        subprocess.run([node, "node_modules/next/dist/bin/next", "build", "--webpack"],
                       cwd=ROOT / "frontend", env=frontend, check=True)
        if args.concept_f_ui:
            from concept_f_build_receipt import write_receipt
            write_receipt(ROOT)
        build_ports.write_text(json.dumps({"frontend_port": ui_port, "backend_port": api_port}) + "\n")
        return
    if not (ROOT / "frontend/.next/BUILD_ID").exists():
        raise SystemExit("Run preview.py build first; development mode bypasses client auth in this baseline")
    commands = [([sys.executable, "-m", "uvicorn", "scripts.public_launch.preview_backend:app",
                  "--host", "127.0.0.1", "--port", str(api_port)], ROOT, common, "backend.log"),
                ([node, "node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1",
                  "--port", str(ui_port)], ROOT / "frontend", frontend, "frontend.log")]
    pids = []
    children = []
    for command, cwd, env, log_name in commands:
        with (RUNTIME / log_name).open("a") as output:
            child = subprocess.Popen(command, cwd=cwd, env=env, stdout=output, stderr=output, start_new_session=True)
            pids.append(child.pid)
            children.append(child)
    def stop_children():
        for child in children:
            if child.poll() is None: child.terminate()
        for child in children:
            try: child.wait(timeout=8)
            except subprocess.TimeoutExpired: child.kill(); child.wait()
    if args.foreground:
        import atexit
        atexit.register(stop_children)
    state = {"url": url + "/login?redirectTo=/console/profile/preferences", "backend_url": f"http://127.0.0.1:{api_port}",
             "pids": pids, "frontend_port": ui_port, "backend_port": api_port,
             "synthetic": True, "logs": str(RUNTIME)}
    # Next may replace its process title after readiness, so stamp it below.
    STATE.write_text(json.dumps(state, indent=2) + "\n")
    print(json.dumps(state, indent=2), flush=True)
    for target in (state["backend_url"] + "/preview-health", url + "/login"):
        for attempt in range(60):
            try:
                with urllib.request.urlopen(target, timeout=2) as response:
                    if response.status == 200:
                        break
            except Exception:
                time.sleep(0.5)
        else:
            raise SystemExit(f"Startup incomplete at {target}; inspect logs and run stop")
    print("Ready: synthetic usera/userb/admin@stage01.example.com; password SyntheticPreview123!")
    if args.foreground:
        print("Foreground preview: Ctrl-C stops only these owned children", flush=True)
        try:
            while all(child.poll() is None for child in children):
                time.sleep(0.5)
        except KeyboardInterrupt:
            pass
        finally:
            stop_children()
            if STATE.exists() and json.loads(STATE.read_text()).get('pids') == pids:
                STATE.unlink()
        return
    state["process_stamps"] = {str(pid): process_stamp(pid) for pid in pids}
    STATE.write_text(json.dumps(state, indent=2) + "\n")


if __name__ == "__main__":
    main()
