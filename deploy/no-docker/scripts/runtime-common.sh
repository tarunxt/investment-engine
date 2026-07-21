#!/usr/bin/env bash

set -euo pipefail

DEFAULT_APP_ROOT="/srv/investor"
LEGACY_APP_ROOT="/srv/investment-engine"
DEFAULT_APP_USER="investor"
LEGACY_APP_USER="investment-engine"
CANONICAL_BULLPEN_RUNTIME_OWNER="investor"
CANONICAL_BULLPEN_HOME="/home/investor"
CANONICAL_BULLPEN_STORE="/home/investor/.bullpen"
CANONICAL_BULLPEN_CONFIG="/home/investor/.bullpen/config.toml"
CANONICAL_BULLPEN_ENV="production"
CANONICAL_BULLPEN_BIN="/usr/local/bin/bullpen"

runtime_repo_root() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  (
    # This file lives at <repo>/deploy/no-docker/scripts/runtime-common.sh.
    cd "$script_dir/../../.."
    pwd
  )
}

resolve_app_root() {
  local app_root="${APP_ROOT:-$(runtime_repo_root)}"

  if [[ ! -d "$app_root" && -d "$LEGACY_APP_ROOT" ]]; then
    app_root="$LEGACY_APP_ROOT"
  fi

  printf '%s\n' "$app_root"
}

resolve_app_user() {
  local app_user="${APP_USER:-$DEFAULT_APP_USER}"

  if ! id -u "$app_user" >/dev/null 2>&1 && id -u "$LEGACY_APP_USER" >/dev/null 2>&1; then
    app_user="$LEGACY_APP_USER"
  fi

  printf '%s\n' "$app_user"
}

default_service_prefix() {
  local app_root="$1"
  local app_user="$2"

  if [[ "$app_root" == "$LEGACY_APP_ROOT" || "$app_user" == "$LEGACY_APP_USER" ]]; then
    printf 'investment-engine\n'
    return
  fi

  printf 'investor\n'
}

alternate_service_prefix() {
  local prefix="$1"

  if [[ "$prefix" == "investor" ]]; then
    printf 'investment-engine\n'
    return
  fi

  printf 'investor\n'
}

service_name_for_role() {
  local prefix="$1"
  local role="$2"

  case "$role" in
    backend)
      printf '%s-backend\n' "$prefix"
      ;;
    celery-worker)
      printf '%s-celery-worker\n' "$prefix"
      ;;
    celery-auto-live-worker)
      printf '%s-celery-auto-live-worker\n' "$prefix"
      ;;
    celery-beat)
      printf '%s-celery-beat\n' "$prefix"
      ;;
    celery-beat-worker)
      printf '%s-celery-beat-worker\n' "$prefix"
      ;;
    frontend)
      printf '%s-frontend\n' "$prefix"
      ;;
    *)
      echo "Unknown service role: $role" >&2
      return 1
      ;;
  esac
}

resolve_systemd_service_name() {
  local preferred="$1"
  local fallback="$2"

  if systemctl is-active --quiet "$preferred" >/dev/null 2>&1 || systemctl is-enabled --quiet "$preferred" >/dev/null 2>&1; then
    printf '%s\n' "$preferred"
    return
  fi

  if systemctl is-active --quiet "$fallback" >/dev/null 2>&1 || systemctl is-enabled --quiet "$fallback" >/dev/null 2>&1; then
    printf '%s\n' "$fallback"
    return
  fi

  if systemctl cat "$preferred" >/dev/null 2>&1; then
    printf '%s\n' "$preferred"
    return
  fi

  if systemctl cat "$fallback" >/dev/null 2>&1; then
    printf '%s\n' "$fallback"
    return
  fi

  printf '%s\n' "$preferred"
}

resolve_role_service_name() {
  local role="$1"
  local app_root="${2:-$(resolve_app_root)}"
  local app_user="${3:-$(resolve_app_user)}"
  local prefix alternate

  prefix="$(default_service_prefix "$app_root" "$app_user")"
  alternate="$(alternate_service_prefix "$prefix")"

  resolve_systemd_service_name \
    "$(service_name_for_role "$prefix" "$role")" \
    "$(service_name_for_role "$alternate" "$role")"
}

service_is_active() {
  local service_name="$1"
  systemctl is-active --quiet "$service_name" >/dev/null 2>&1
}

service_family_has_active_backend_member() {
  local prefix="$1"
  local role service_name

  for role in backend celery-worker celery-auto-live-worker celery-beat celery-beat-worker; do
    service_name="$(service_name_for_role "$prefix" "$role")"
    if service_is_active "$service_name"; then
      return 0
    fi
  done

  return 1
}

ensure_single_backend_service_family_active() {
  local investor_active=false
  local investment_engine_active=false

  if service_family_has_active_backend_member "investor"; then
    investor_active=true
  fi

  if service_family_has_active_backend_member "investment-engine"; then
    investment_engine_active=true
  fi

  if [[ "$investor_active" == "true" && "$investment_engine_active" == "true" ]]; then
    echo "Both investor-* and investment-engine-* backend/worker service families are active. Stop one family before starting the canonical Bullpen runtime." >&2
    return 1
  fi
}

validate_canonical_bullpen_runtime_env() {
  local actual_user

  actual_user="$(id -un)"
  export BULLPEN_BIN="${BULLPEN_BIN:-$CANONICAL_BULLPEN_BIN}"
  export BULLPEN_HOME="${BULLPEN_HOME:-$CANONICAL_BULLPEN_STORE}"
  export BULLPEN_CREDENTIALS_HOME="${BULLPEN_CREDENTIALS_HOME:-$BULLPEN_HOME}"
  export BULLPEN_CONFIG="${BULLPEN_CONFIG:-$CANONICAL_BULLPEN_CONFIG}"
  export BULLPEN_ENV="${BULLPEN_ENV:-$CANONICAL_BULLPEN_ENV}"

  if [[ "$actual_user" != "$CANONICAL_BULLPEN_RUNTIME_OWNER" ]]; then
    echo "Bullpen runtime must run as Unix user $CANONICAL_BULLPEN_RUNTIME_OWNER, found $actual_user." >&2
    return 1
  fi

  if [[ "${HOME:-}" != "$CANONICAL_BULLPEN_HOME" ]]; then
    echo "HOME must be $CANONICAL_BULLPEN_HOME for Bullpen runtime, found ${HOME:-<unset>}." >&2
    return 1
  fi

  if [[ "$BULLPEN_BIN" != "$CANONICAL_BULLPEN_BIN" ]]; then
    echo "BULLPEN_BIN must be $CANONICAL_BULLPEN_BIN, found $BULLPEN_BIN." >&2
    return 1
  fi

  if [[ "$BULLPEN_HOME" != "$CANONICAL_BULLPEN_STORE" ]]; then
    echo "BULLPEN_HOME must be $CANONICAL_BULLPEN_STORE, found $BULLPEN_HOME." >&2
    return 1
  fi

  if [[ "$BULLPEN_CREDENTIALS_HOME" != "$CANONICAL_BULLPEN_STORE" ]]; then
    echo "BULLPEN_CREDENTIALS_HOME must be $CANONICAL_BULLPEN_STORE, found $BULLPEN_CREDENTIALS_HOME." >&2
    return 1
  fi

  if [[ "$BULLPEN_CONFIG" != "$CANONICAL_BULLPEN_CONFIG" ]]; then
    echo "BULLPEN_CONFIG must be $CANONICAL_BULLPEN_CONFIG, found $BULLPEN_CONFIG." >&2
    return 1
  fi

  if [[ "$BULLPEN_ENV" != "$CANONICAL_BULLPEN_ENV" ]]; then
    echo "BULLPEN_ENV must be $CANONICAL_BULLPEN_ENV, found $BULLPEN_ENV." >&2
    return 1
  fi

  if [[ ! -x "$BULLPEN_BIN" ]]; then
    echo "Bullpen binary is missing or not executable at $BULLPEN_BIN." >&2
    return 1
  fi

  if [[ ! -d "$BULLPEN_HOME" ]]; then
    echo "Bullpen credential store is missing at $BULLPEN_HOME." >&2
    return 1
  fi
}

python_bin_for_app() {
  local app_root="${1:-$(resolve_app_root)}"
  local python_bin="$app_root/backend/.venv/bin/python"

  if [[ -x "$python_bin" ]]; then
    printf '%s\n' "$python_bin"
    return
  fi

  if command -v python3 >/dev/null 2>&1; then
    command -v python3
    return
  fi

  echo "Python runtime not found. Expected $python_bin or python3 on PATH." >&2
  return 1
}

print_section() {
  printf '\n== %s ==\n' "$1"
}

describe_service() {
  local service_name="$1"

  if ! systemctl cat "$service_name" >/dev/null 2>&1; then
    printf '%s: not installed\n' "$service_name"
    return
  fi

  systemctl show "$service_name" --no-pager \
    -p Id \
    -p LoadState \
    -p ActiveState \
    -p SubState \
    -p UnitFileState \
    -p MainPID \
    -p ExecMainStatus
}

print_process_family() {
  local label="$1"
  local pattern="$2"
  local pids

  pids="$(pgrep -f "$pattern" || true)"
  if [[ -z "$pids" ]]; then
    printf '%s: no matching processes\n' "$label"
    return
  fi

  printf '%s:\n' "$label"
  printf 'PID CPU%% RSS_KiB COMMAND\n'
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    ps -p "$pid" -o pid=,pcpu=,rss=,args=
  done <<<"$pids"
}
