#!/usr/bin/env bash
# Promote application code without enabling legacy financial consumers.
set -euo pipefail
APP_ROOT="${APP_ROOT:-/srv/investor}"
APP_USER="${APP_USER:-investor}"
BACKEND_ENV_FILE="${BACKEND_ENV_FILE:-/etc/investor/backend.env}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
rollback_dir="${CREDX_RECOVERY_ROLLBACK_DIR:-}"
mode_for_service() {
  local pid
  pid=$(sudo systemctl show "$1" --property=MainPID --value) || return 1
  sudo systemctl is-active --quiet "$1" || return 1
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || { echo 'Active runtime PID unavailable' >&2; return 1; }
  sudo python3 - "$pid" <<'PY'
import pathlib,sys
from decimal import Decimal
values=dict(v.split(b'=',1) for v in pathlib.Path('/proc/'+sys.argv[1]+'/environ').read_bytes().split(b'\0') if b'=' in v)
mode=values.get(b'CREDX_RECOVERY_MODE')
if mode not in (b'0',b'1'): raise SystemExit('Explicit runtime recovery mode unavailable')
for key in (b'RECOMMENDATION_AUDIT_ENABLED',b'RECOMMENDATION_AUDIT_EXTERNAL_ENABLED',b'RECOMMENDATION_AUDIT_FUNDAMENTALS_ENABLED'):
    if values.get(key,b'false').strip().lower() not in (b'0',b'false',b'off',b'no'): raise SystemExit('Audit activation requires a separate verified gate')
if Decimal(values.get(b'RECOMMENDATION_AUDIT_DAILY_CAP_USD',b'0').decode())!=0: raise SystemExit('Audit spend must stay disabled')
print(mode.decode())
PY
}
if [[ "${1:-}" == --detect ]]; then
  mode_for_service investor-backend
  exit 0
fi
assert_financial_stopped() {
  for family in investor investment-engine; do
    for role in celery-worker celery-email-worker celery-auto-live-worker celery-beat celery-beat-worker; do
      state=$(sudo systemctl show "$family-$role" --property=ActiveState --value) || return 1
      if [[ "$state" != inactive && "$state" != failed ]]; then
        echo "Refusing recovery deployment: $family-$role is not confirmed stopped." >&2
        return 1
      fi
    done
  done
}
require_lock() {
  # The workflow owns this descriptor across snapshot, checkout and promotion.
  [[ "$(readlink /proc/$$/fd/9)" == /run/investor-production-deploy.lock ]] || return 1
  flock -n 9
}
preflight() {
  [[ "$(mode_for_service investor-backend)" == 1 ]] || return 1
  [[ "$(mode_for_service investor-recovery-analysis)" == 1 ]] || return 1
  # Unreviewed startup hooks can fetch external data or synchronize credentials.
  # Preserve units; refuse deployment rather than changing those hooks here.
  for service in investor-backend investor-recovery-analysis; do
    hooks=$(sudo systemctl show "$service" --property=ExecStartPre --value) || return 1
    [[ -z "$hooks" ]] || { echo 'Unreviewed pre-start hooks block contained promotion.' >&2; return 1; }
  done
  assert_financial_stopped
}
restore_backend() {
  require_lock || return 1
  assert_financial_stopped || return 1
  [[ -n "$rollback_dir" ]] || return 1
  sudo systemctl stop investor-backend investor-recovery-analysis || return 1
  sudo -u "$APP_USER" python3 "$SCRIPT_DIR/backend-recovery-artifact.py" restore "$APP_ROOT" "$rollback_dir" || return 1
  sudo systemctl start investor-recovery-analysis investor-backend || return 1
  for attempt in $(seq 1 40); do
    if curl -fsS --max-time 3 http://127.0.0.1:8000/health/ready >/dev/null; then break; fi
    sleep 1
  done
  curl -fsS --max-time 5 http://127.0.0.1:8000/health/ready >/dev/null || return 1
  preflight
}
if [[ "${1:-}" == --restore ]]; then restore_backend; exit 0; fi
if [[ "${1:-}" == --preflight ]]; then preflight; exit 0; fi
if [[ "${1:-}" == --post-frontend-check ]]; then
  require_lock
  preflight
  curl -fsS --max-time 5 http://127.0.0.1:8000/health/ready >/dev/null
  exit 0
fi
require_lock
[[ -n "$rollback_dir" ]]
if [[ "${1:-}" == --prepare ]]; then
  preflight
  previous_sha=$(sudo -u "$APP_USER" git -C "$APP_ROOT" rev-parse HEAD)
  sudo -u "$APP_USER" python3 "$SCRIPT_DIR/backend-recovery-artifact.py" snapshot "$APP_ROOT" "$rollback_dir" --previous-sha "$previous_sha"
  exit 0
fi
sudo -u "$APP_USER" test -f "$rollback_dir/manifest.json"
sudo -u "$APP_USER" test -f "$rollback_dir/backend-source.tar.gz"
[[ "${CREDX_RECOVERY_ROLLBACK_OWNER:-}" == workflow ]]
assert_financial_stopped
for service in investor-backend investor-recovery-analysis; do
  state=$(sudo systemctl show "$service" --property=ActiveState --value)
  [[ "$state" == inactive || "$state" == failed ]]
done
# The existing recovery units keep their producer/consumer environment and
# explicit queue selection. Do not install normal units or run migrations.
sudo -u "$APP_USER" env APP_ROOT="$APP_ROOT" BACKEND_ENV_FILE="$BACKEND_ENV_FILE" bash <<'SH'
set -euo pipefail
cd "$APP_ROOT/backend"
source "$APP_ROOT/deploy/no-docker/load-env-file.sh"
load_env_file "$BACKEND_ENV_FILE"
export CREDX_RECOVERY_MODE=1
.venv/bin/python - <<'PY'
from app.core.recovery import ANALYSIS_QUEUE,TRANSPORT_PREFIX,ZERODHA_SYNC_TASK,require_equity_analysis
from app.infrastructure.messaging.celery_app import celery
from app.core.config import settings
assert not settings.recommendation_audit_enabled
assert not settings.recommendation_audit_external_enabled
assert not settings.recommendation_audit_fundamentals_enabled
assert settings.recommendation_audit_daily_cap_usd == 0
celery.loader.import_default_modules()
require_equity_analysis("india", {"kind": "equity_output_sources_v1", "market": "india"})
assert celery.conf.task_default_queue == ANALYSIS_QUEUE
assert celery.conf.broker_transport_options['global_keyprefix'] == TRANSPORT_PREFIX
assert celery.conf.result_backend_transport_options['global_keyprefix'] == TRANSPORT_PREFIX
assert not celery.conf.beat_schedule
assert not celery.conf.worker_enable_remote_control
assert ZERODHA_SYNC_TASK in celery.tasks
assert all(q.name == ANALYSIS_QUEUE for q in celery.conf.task_queues)
print('Candidate recovery queue and portfolio sync registration verified.')
PY
SH
# Existing recovery units and their environment/queue policy stay in place.
# No systemd drop-in, daemon-reload, migration or normal unit installation.
# The workflow stopped both processes before replacing their source.
sudo systemctl start investor-recovery-analysis investor-backend
for attempt in $(seq 1 40); do
  if curl -fsS --max-time 3 http://127.0.0.1:8000/health/ready >/dev/null; then break; fi
  sleep 1
done
curl -fsS --max-time 5 http://127.0.0.1:8000/health/ready >/dev/null
[[ "$(mode_for_service investor-backend)" == 1 ]]
[[ "$(mode_for_service investor-recovery-analysis)" == 1 ]]
for path in /zerodha/status /zerodha/login-url /zerodha/portfolio /zerodha/threats/latest /zerodha/events/latest; do
  code=$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:8000$path")
  [[ "$code" == 401 ]]
  echo "$path now reaches authentication (HTTP $code)."
done
for path in /zerodha/threats/run /zerodha/events/run; do
  code=$(curl -sS --max-time 5 -X POST -H 'Content-Type: application/json' --data '{}' -o /dev/null -w '%{http_code}' "http://127.0.0.1:8000$path")
  [[ "$code" == 401 ]]
  echo "$path now reaches authentication (HTTP $code)."
done
code=$(curl -sS --max-time 5 -X POST -o /dev/null -w '%{http_code}' http://127.0.0.1:8000/zerodha/orders)
[[ "$code" == 503 ]]
assert_financial_stopped
echo 'Recovery API and isolated worker promoted; financial services remain stopped.'
