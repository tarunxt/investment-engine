"""Enroll an existing CredX account using its private Kite app on the systemd host.

Usage: sudo /srv/investor/backend/.venv/bin/python /srv/investor/backend/scripts/configure-kite-personal-app.py
The server-only ZERODHA_PERSONAL_APPS JSON object maps numeric CredX user IDs to
client_id, api_key and api_secret. The command reloads active broker services
with the new configuration after saving it.
"""
import fcntl
import getpass
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from dotenv import load_dotenv, set_key
from sqlalchemy import func, select

BACKEND = Path(__file__).resolve().parents[1]
ENV_FILE = Path("/etc/investor/backend.env")


def main() -> None:
    if not sys.stdin.isatty() or os.geteuid() != 0:
        raise SystemExit("Run with sudo in an interactive terminal on the CredX server.")
    email = input("CredX sign-in email: ").strip().lower()
    client_id = input("Zerodha client ID: ").strip().upper()
    api_key = input("Kite app API key: ").strip()
    secret = getpass.getpass("Kite app API secret (hidden): ").strip()

    # Serialize concurrent enrollments and atomically replace the configuration.
    lock = os.open(ENV_FILE.parent, os.O_RDONLY)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX)
        load_dotenv(ENV_FILE, override=True, interpolate=False)
        sys.path.insert(0, str(BACKEND))
        from app.core.config import KitePersonalApp, settings
        from app.domains.auth.models import User
        from app.infrastructure.database.sync_session import SyncSessionLocal

        with SyncSessionLocal() as session:
            users = User.__table__.c
            user_id = session.execute(
                select(users.id).where(func.lower(users.email) == email, users.is_active)
            ).scalar_one_or_none()
        if user_id is None:
            raise SystemExit("Active CredX account not found. Check the sign-in email.")
        personal = KitePersonalApp(client_id=client_id, api_key=api_key, api_secret=secret)
        apps = dict(settings.zerodha_personal_apps)
        if api_key == settings.zerodha_api_key or any(
            app.api_key == api_key for owner, app in apps.items() if owner != user_id
        ):
            raise SystemExit("This Kite app is already assigned to another profile.")
        apps[user_id] = personal
        # SecretStr masks dumps by design. Only the root-owned runtime file needs
        # the actual values; keep them out of shell arguments and terminal output.
        values = {
            str(owner): {"client_id": app.client_id, "api_key": app.api_key,
                         "api_secret": app.api_secret.get_secret_value()}
            for owner, app in apps.items()
        }
        encoded = json.dumps(values, separators=(",", ":"))
        if "'" in encoded or "\\" in encoded:
            raise SystemExit("Unexpected character in Kite credentials. Copy the original values.")
        with tempfile.TemporaryDirectory(dir=ENV_FILE.parent) as staging:
            target = Path(staging) / "backend.env"
            shutil.copyfile(ENV_FILE, target)
            set_key(str(target), "ZERODHA_PERSONAL_APPS", encoded, quote_mode="always")
            original = ENV_FILE.stat()
            os.chown(target, original.st_uid, original.st_gid)
            os.chmod(target, original.st_mode & 0o770)
            os.replace(target, ENV_FILE)
    finally:
        os.close(lock)
    units = ("investor-backend", "investor-recovery-analysis", "investor-celery-worker",
             "investor-celery-beat-worker")
    active = [unit for unit in units if subprocess.run(
        ["systemctl", "is-active", "--quiet", unit], check=False,
    ).returncode == 0]
    if not active:
        raise SystemExit("Kite app saved. Restart the active CredX API and portfolio workers to apply it.")
    print("Kite app saved. Reloading " + ", ".join(active) + ".", flush=True)
    subprocess.run(["systemctl", "try-restart", *active], check=True)
    print("Start a fresh Connect Kite login from the enrolled CredX account.")


if __name__ == "__main__":
    main()
