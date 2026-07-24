#!/usr/bin/env bash

set -euo pipefail

APP_ROOT="${APP_ROOT:-/srv/investor}"
APP_USER="${APP_USER:-investor}"
FRONTEND_ENV_FILE="${FRONTEND_ENV_FILE:-/etc/investor/frontend.env}"
SYSTEMD_TEMPLATE_DIR="$APP_ROOT/deploy/no-docker/systemd"
SERVICE_NAME="credx-bullpen-healthcheck.service"
TIMER_NAME="credx-bullpen-healthcheck.timer"

if [[ ! -d "$APP_ROOT" ]]; then
  echo "App root not found: $APP_ROOT" >&2
  exit 1
fi
if ! id "$APP_USER" >/dev/null 2>&1; then
  echo "App user not found: $APP_USER" >&2
  exit 1
fi
if [[ ! -f "$FRONTEND_ENV_FILE" ]]; then
  echo "Frontend environment file not found: $FRONTEND_ENV_FILE" >&2
  exit 1
fi
if [[ ! -x /usr/bin/node ]]; then
  echo "Node executable not found at /usr/bin/node" >&2
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
  FRONTEND_ENV_FILE="$FRONTEND_ENV_FILE" \
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
    "__FRONTEND_ENV_FILE__": os.environ["FRONTEND_ENV_FILE"],
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
