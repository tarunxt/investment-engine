#!/usr/bin/env bash

set -euo pipefail

APP_ROOT="${APP_ROOT:-/srv/investor}"
APP_USER="${APP_USER:-investor}"
BACKEND_ENV_FILE="${BACKEND_ENV_FILE:-/etc/investor/backend.env}"
SYSTEMD_TEMPLATE_DIR="$APP_ROOT/deploy/no-docker/systemd"
SERVICE_NAME="credx-bullpen-healthcheck.service"
TIMER_NAME="credx-bullpen-healthcheck.timer"
PYTHON_BIN="$APP_ROOT/backend/.venv/bin/python"

if [[ ! -d "$APP_ROOT" ]]; then
  echo "App root not found: $APP_ROOT" >&2
  exit 1
fi
if ! id "$APP_USER" >/dev/null 2>&1; then
  echo "App user not found: $APP_USER" >&2
  exit 1
fi
if [[ ! -f "$BACKEND_ENV_FILE" ]]; then
  echo "Backend environment file not found: $BACKEND_ENV_FILE" >&2
  exit 1
fi
if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "Backend virtualenv Python not found: $PYTHON_BIN" >&2
  exit 1
fi

render_unit() {
  local source="$1"
  local destination="$2"
  local rendered

  if [[ ! -f "$source" ]]; then
    echo "Systemd template not found: $source" >&2
    exit 1
  fi

  rendered="$(mktemp)"
  APP_ROOT="$APP_ROOT" \
  APP_USER="$APP_USER" \
  BACKEND_ENV_FILE="$BACKEND_ENV_FILE" \
  python3 - "$source" "$rendered" <<'PY'
import os
import sys
from pathlib import Path

source = Path(sys.argv[1])
destination = Path(sys.argv[2])
text = source.read_text(encoding="utf-8")
for old, new in {
    "__APP_ROOT__": os.environ["APP_ROOT"],
    "__APP_USER__": os.environ["APP_USER"],
    "__BACKEND_ENV_FILE__": os.environ["BACKEND_ENV_FILE"],
}.items():
    text = text.replace(old, new)
destination.write_text(text, encoding="utf-8")
PY

  sudo install -m 0644 "$rendered" "$destination"
  rm -f "$rendered"
}

render_unit \
  "$SYSTEMD_TEMPLATE_DIR/$SERVICE_NAME" \
  "/etc/systemd/system/$SERVICE_NAME"
render_unit \
  "$SYSTEMD_TEMPLATE_DIR/$TIMER_NAME" \
  "/etc/systemd/system/$TIMER_NAME"

sudo systemd-analyze verify \
  "/etc/systemd/system/$SERVICE_NAME" \
  "/etc/systemd/system/$TIMER_NAME"
sudo systemctl daemon-reload
sudo systemctl enable --now "$TIMER_NAME"

printf 'Installed %s and %s\n' "$SERVICE_NAME" "$TIMER_NAME"
sudo systemctl status "$TIMER_NAME" --no-pager --full

initial_health_status=0
sudo systemctl start "$SERVICE_NAME" || initial_health_status=$?
sudo systemctl show "$SERVICE_NAME" \
  --property=ActiveState \
  --property=SubState \
  --property=Result \
  --property=ExecMainStatus \
  --no-pager
sudo journalctl --unit "$SERVICE_NAME" --lines=80 --no-pager
if (( initial_health_status != 0 )); then
  printf \
    'Initial passive Bullpen health snapshot is unhealthy (service exit %s); deployment continues because this monitor is read-only.\n' \
    "$initial_health_status" >&2
fi
