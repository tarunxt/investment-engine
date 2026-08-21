#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./runtime-common.sh
source "$SCRIPT_DIR/runtime-common.sh"

DRY_RUN="${1:-}"
APP_ROOT="$(resolve_app_root)"
APP_USER="$(resolve_app_user)"
PYTHON_BIN="$(python_bin_for_app "$APP_ROOT")"

BACKEND_SERVICE_NAME="$(resolve_role_service_name backend "$APP_ROOT" "$APP_USER")"
WORKER_SERVICE_NAME="$(resolve_role_service_name celery-worker "$APP_ROOT" "$APP_USER")"
EMAIL_WORKER_SERVICE_NAME="$(resolve_role_service_name celery-email-worker "$APP_ROOT" "$APP_USER")"
AUTO_LIVE_WORKER_SERVICE_NAME="$(resolve_role_service_name celery-auto-live-worker "$APP_ROOT" "$APP_USER")"
BEAT_SERVICE_NAME="$(resolve_role_service_name celery-beat "$APP_ROOT" "$APP_USER")"
BEAT_WORKER_SERVICE_NAME="$(resolve_role_service_name celery-beat-worker "$APP_ROOT" "$APP_USER")"
FRONTEND_SERVICE_NAME="$(resolve_role_service_name frontend "$APP_ROOT" "$APP_USER")"

if [[ "$DRY_RUN" == "--dry-run" ]]; then
  print_section "Dry Run"
  echo "Would inspect EC2 metadata, CloudWatch CPU metrics, host memory/swap/disk/load, process CPU/RSS, and systemd service state."
  "$PYTHON_BIN" "$SCRIPT_DIR/aws-readonly-report.py" runtime-resource --dry-run
  exit 0
fi

print_section "Runtime Context"
echo "app_root=$APP_ROOT"
echo "app_user=$APP_USER"

print_section "AWS Runtime"
"$PYTHON_BIN" "$SCRIPT_DIR/aws-readonly-report.py" runtime-resource

print_section "Host Memory"
free -h

print_section "Swap"
if swapon --show >/dev/null 2>&1; then
  swapon --show
else
  echo "swap reporting unavailable"
fi

print_section "Disk"
df -h /

print_section "Load Average"
cat /proc/loadavg

print_section "Systemd Services"
for service_name in \
  "$BACKEND_SERVICE_NAME" \
  "$WORKER_SERVICE_NAME" \
  "$EMAIL_WORKER_SERVICE_NAME" \
  "$AUTO_LIVE_WORKER_SERVICE_NAME" \
  "$BEAT_SERVICE_NAME" \
  "$BEAT_WORKER_SERVICE_NAME" \
  "$FRONTEND_SERVICE_NAME"; do
  describe_service "$service_name"
done

print_section "Worker Counts"
echo "uvicorn_processes=$(pgrep -fc 'uvicorn .*app.main:app' || true)"
echo "celery_worker_processes=$(pgrep -fc 'celery .* worker' || true)"
echo "celery_beat_processes=$(pgrep -fc 'celery .* beat' || true)"
echo "next_processes=$(pgrep -fc 'next start' || true)"

print_section "Process CPU and RSS"
print_process_family "Next.js" "next start"
print_process_family "Uvicorn" "uvicorn .*app.main:app"
print_process_family "Celery" "celery .* (worker|beat)"
print_process_family "PostgreSQL" "postgres"
print_process_family "Redis" "redis-server"
