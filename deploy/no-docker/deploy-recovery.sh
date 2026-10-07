#!/usr/bin/env bash
# Promote application code without enabling legacy financial consumers.
set -euo pipefail
APP_ROOT="${APP_ROOT:-/srv/investor}"
APP_USER="${APP_USER:-investor}"
BACKEND_ENV_FILE="${BACKEND_ENV_FILE:-/etc/investor/backend.env}"
mode_for_service() {
  local pid
  pid=$(sudo systemctl show "$1" --property=MainPID --value)
  if [[ ! "$pid" =~ ^[1-9][0-9]*$ ]]; then
    sudo systemctl show "$1" --property=Environment --value | python3 -c '
import shlex,sys
values=shlex.split(sys.stdin.read())
mode=next((v.split("=",1)[1] for v in values if v.startswith("CREDX_RECOVERY_MODE=")),"0")
print(mode if mode in ("0","1") else "invalid")'
    return
  fi
  sudo python3 - "$pid" <<'PY'
import pathlib,sys
values=pathlib.Path('/proc/'+sys.argv[1]+'/environ').read_bytes().split(b'\0')
mode=next((v.split(b'=',1)[1] for v in values if v.startswith(b'CREDX_RECOVERY_MODE=')),b'0')
print(mode.decode() if mode in (b'0',b'1') else 'invalid')
PY
}
if [[ "${1:-}" == --detect ]]; then
  mode_for_service investor-backend
  exit 0
fi
[[ "$(mode_for_service investor-backend)" == 1 ]]
[[ "$(mode_for_service investor-recovery-analysis)" == 1 ]]
assert_financial_stopped() {
  for family in investor investment-engine; do
    for role in celery-worker celery-email-worker celery-auto-live-worker celery-beat celery-beat-worker; do
      if sudo systemctl is-active --quiet "$family-$role"; then
        echo "Refusing recovery deployment: $family-$role is active." >&2
        return 1
      fi
    done
  done
}
assert_financial_stopped
# The existing recovery units keep their producer/consumer environment and
# explicit queue selection. Do not install normal units or run migrations.
sudo -u "$APP_USER" env APP_ROOT="$APP_ROOT" BACKEND_ENV_FILE="$BACKEND_ENV_FILE" bash <<'SH'
set -euo pipefail
cd "$APP_ROOT/backend"
source "$APP_ROOT/deploy/no-docker/load-env-file.sh"
load_env_file "$BACKEND_ENV_FILE"
export CREDX_RECOVERY_MODE=1
.venv/bin/python - <<'PY'
from app.core.recovery import ANALYSIS_QUEUE,TRANSPORT_PREFIX,ZERODHA_SYNC_TASK
from app.infrastructure.messaging.celery_app import celery
celery.loader.import_default_modules()
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
# Preserve a known contained rollback, including its runtime guards, rather
# than restarting the previous main checkout without recovery policy.
ROLLBACK_SHA=084423dce552d524aab2b1f7d89f168a2c3f701f
if ! sudo -u "$APP_USER" git -C "$APP_ROOT" cat-file -e "$ROLLBACK_SHA^{commit}" 2>/dev/null; then
  sudo -u "$APP_USER" git -C "$APP_ROOT" fetch origin credx/recovery-analysis-e401
fi
sudo -u "$APP_USER" git -C "$APP_ROOT" cat-file -e "$ROLLBACK_SHA^{commit}"
rollback_dir=$(sudo -u "$APP_USER" mktemp -d "$APP_ROOT/.recovery-rollback-XXXXXX")
while IFS= read -r path; do
  [[ "$path" == backend/app/* ]] || continue
  sudo -u "$APP_USER" mkdir -p "$rollback_dir/$(dirname "$path")"
  sudo -u "$APP_USER" bash -c 'git -C "$1" show "$2:$3" > "$4/$3"' bash "$APP_ROOT" "$ROLLBACK_SHA" "$path" "$rollback_dir"
done < <(sudo -u "$APP_USER" git -C "$APP_ROOT" diff-tree --no-commit-id --name-only -r 788cad76bfd793ec66bdb459efe5dad17b3fc8b4)
promoted=false
rollback() {
  if [[ "$promoted" != true ]]; then
    echo 'Recovery promotion failed; restoring contained backend files.' >&2
    sudo -u "$APP_USER" cp -a "$rollback_dir/backend/app/." "$APP_ROOT/backend/app/"
    sudo systemctl restart investor-recovery-analysis investor-backend
  fi
}
trap rollback EXIT
# Give the isolated consumer time to finish its current task on shutdown.
sudo mkdir -p /etc/systemd/system/investor-recovery-analysis.service.d
printf '[Service]\nTimeoutStopSec=300\n' | sudo tee /etc/systemd/system/investor-recovery-analysis.service.d/zz-graceful-stop.conf >/dev/null
sudo systemctl daemon-reload
sudo systemctl stop investor-backend
sudo systemctl restart investor-recovery-analysis
sudo systemctl start investor-backend
for attempt in $(seq 1 40); do
  if curl -fsS --max-time 3 http://127.0.0.1:8000/health/ready >/dev/null; then break; fi
  sleep 1
done
curl -fsS --max-time 5 http://127.0.0.1:8000/health/ready >/dev/null
[[ "$(mode_for_service investor-backend)" == 1 ]]
[[ "$(mode_for_service investor-recovery-analysis)" == 1 ]]
for path in /zerodha/status /zerodha/login-url /zerodha/portfolio; do
  code=$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:8000$path")
  [[ "$code" == 401 ]]
  echo "$path now reaches authentication (HTTP $code)."
done
code=$(curl -sS --max-time 5 -X POST -o /dev/null -w '%{http_code}' http://127.0.0.1:8000/zerodha/orders)
[[ "$code" == 503 ]]
assert_financial_stopped
promoted=true
echo 'Recovery API and isolated worker promoted; financial services remain stopped.'
