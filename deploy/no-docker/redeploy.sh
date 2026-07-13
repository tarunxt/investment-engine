#!/usr/bin/env bash

set -euo pipefail

SCOPE="${1:-full}"
DEFAULT_APP_ROOT="/srv/investment-engine"
LEGACY_APP_ROOT="/srv/investor"
DEFAULT_APP_USER="investment-engine"
LEGACY_APP_USER="investor"
DEFAULT_BACKEND_ENV_FILE="/etc/investor/backend.env"
DEFAULT_FRONTEND_ENV_FILE="/etc/investor/frontend.env"
APP_ROOT="${APP_ROOT:-$DEFAULT_APP_ROOT}"
APP_USER="${APP_USER:-$DEFAULT_APP_USER}"
BACKEND_ENV_FILE="${BACKEND_ENV_FILE:-$DEFAULT_BACKEND_ENV_FILE}"
FRONTEND_ENV_FILE="${FRONTEND_ENV_FILE:-$DEFAULT_FRONTEND_ENV_FILE}"
SKIP_GIT_SYNC="${SKIP_GIT_SYNC:-false}"
BULLPEN_VERSION="${BULLPEN_VERSION:-0.1.101}"
BACKEND_LIVE_URL="${BACKEND_LIVE_URL:-http://127.0.0.1:8000/health/live}"
BACKEND_READY_URL="${BACKEND_READY_URL:-http://127.0.0.1:8000/health/ready}"
FRONTEND_SMOKE_URL="${FRONTEND_SMOKE_URL:-http://127.0.0.1:3000/login}"
SMOKE_TIMEOUT_SECONDS="${SMOKE_TIMEOUT_SECONDS:-20}"
SMOKE_RETRIES="${SMOKE_RETRIES:-30}"
SMOKE_RETRY_SLEEP_SECONDS="${SMOKE_RETRY_SLEEP_SECONDS:-2}"
SERVICE_STARTUP_RETRIES="${SERVICE_STARTUP_RETRIES:-30}"
SERVICE_STARTUP_RETRY_SLEEP_SECONDS="${SERVICE_STARTUP_RETRY_SLEEP_SECONDS:-2}"
SERVICE_STABLE_SECONDS="${SERVICE_STABLE_SECONDS:-8}"

declare -a CONFIG_BACKUPS=()
declare -a INSTALLED_SYSTEMD_UNITS=()
CONFIG_BACKUP_DIR="$(mktemp -d)"
BACKED_UP_PATHS_LIST=$'\n'
CONFIG_ROLLBACK_ENABLED=false
NGINX_RELOAD_REQUIRED=false

case "$SCOPE" in
  backend|full)
    ;;
  *)
    echo "Usage: $0 [backend|full]" >&2
    exit 1
    ;;
esac

if [[ ! -d "$APP_ROOT" && -d "$LEGACY_APP_ROOT" ]]; then
  APP_ROOT="$LEGACY_APP_ROOT"
fi

if ! id -u "$APP_USER" >/dev/null 2>&1 && id -u "$LEGACY_APP_USER" >/dev/null 2>&1; then
  APP_USER="$LEGACY_APP_USER"
fi

if [[ ! -d "$APP_ROOT" ]]; then
  echo "App root not found: $APP_ROOT" >&2
  exit 1
fi

default_service_prefix() {
  if [[ "$APP_ROOT" == "$LEGACY_APP_ROOT" || "$APP_USER" == "$LEGACY_APP_USER" ]]; then
    printf 'investor\n'
    return
  fi

  printf 'investment-engine\n'
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
      exit 1
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
  local prefix alternate

  prefix="$(default_service_prefix)"
  alternate="$(alternate_service_prefix "$prefix")"

  resolve_systemd_service_name \
    "$(service_name_for_role "$prefix" "$role")" \
    "$(service_name_for_role "$alternate" "$role")"
}

run_as_app_user() {
  sudo -u "$APP_USER" -H bash -lc "$1"
}

looks_like_placeholder_url() {
  local value="${1:-}"
  [[ -n "$value" ]] && [[ "$value" == *"yourdomain.com"* || "$value" == *"example.com"* ]]
}

validate_required_env_var() {
  local name="$1"
  local value="${!name:-}"

  if [[ -z "$value" ]]; then
    echo "Required environment variable missing: $name" >&2
    exit 1
  fi
}

validate_frontend_env_file() {
  run_as_app_user "
    set -euo pipefail
    set -a
    source '$FRONTEND_ENV_FILE'
    set +a

    if [[ -z \"\${NEXTAUTH_URL:-}\" ]]; then
      echo 'Required environment variable missing: NEXTAUTH_URL' >&2
      exit 1
    fi

    if [[ -z \"\${NEXTAUTH_SECRET:-}\" ]]; then
      echo 'Required environment variable missing: NEXTAUTH_SECRET' >&2
      exit 1
    fi

    if [[ \"\${NEXTAUTH_URL:-}\" == *yourdomain.com* || \"\${NEXTAUTH_URL:-}\" == *example.com* ]]; then
      echo \"NEXTAUTH_URL still uses a placeholder domain: \${NEXTAUTH_URL}\" >&2
      exit 1
    fi

    if [[ -n \"\${NEXT_PUBLIC_FRONTEND_URL:-}\" ]] && [[ \"\${NEXT_PUBLIC_FRONTEND_URL:-}\" == *yourdomain.com* || \"\${NEXT_PUBLIC_FRONTEND_URL:-}\" == *example.com* ]]; then
      echo \"NEXT_PUBLIC_FRONTEND_URL still uses a placeholder domain: \${NEXT_PUBLIC_FRONTEND_URL}\" >&2
      exit 1
    fi

    if [[ -n \"\${NEXT_PUBLIC_API_URL:-}\" ]] && [[ \"\${NEXT_PUBLIC_API_URL:-}\" == *yourdomain.com* || \"\${NEXT_PUBLIC_API_URL:-}\" == *example.com* ]]; then
      echo \"NEXT_PUBLIC_API_URL still uses a placeholder domain: \${NEXT_PUBLIC_API_URL}\" >&2
      exit 1
    fi

    echo \"==> Frontend URL: \${NEXT_PUBLIC_FRONTEND_URL:-\$NEXTAUTH_URL}\"
    echo \"==> Frontend API URL: \${NEXT_PUBLIC_API_URL:-<runtime inferred from browser host>}\"
  "
}

validate_backend_env_file() {
  run_as_app_user "
    set -euo pipefail
    set -a
    source '$BACKEND_ENV_FILE'
    set +a

    if [[ -z \"\${DATABASE_URL:-}\" ]]; then
      echo 'Required environment variable missing: DATABASE_URL' >&2
      exit 1
    fi

    if [[ -z \"\${REDIS_URL:-}\" ]]; then
      echo 'Required environment variable missing: REDIS_URL' >&2
      exit 1
    fi

    if [[ -z \"\${FRONTEND_URL:-}\" ]]; then
      echo 'Required environment variable missing: FRONTEND_URL' >&2
      exit 1
    fi

    if [[ \"\${FRONTEND_URL:-}\" == *yourdomain.com* || \"\${FRONTEND_URL:-}\" == *example.com* ]]; then
      echo \"FRONTEND_URL still uses a placeholder domain: \${FRONTEND_URL}\" >&2
      exit 1
    fi
  "
}

validate_bullpen_env_alignment() {
  run_as_app_user "
    set -euo pipefail

    set -a
    source '$BACKEND_ENV_FILE'
    backend_bullpen_bin=\${BULLPEN_BIN:-}
    backend_bullpen_home=\${BULLPEN_HOME:-}
    backend_bullpen_credentials_home=\${BULLPEN_CREDENTIALS_HOME:-}
    set +a

    set -a
    source '$FRONTEND_ENV_FILE'
    frontend_bullpen_bin=\${BULLPEN_BIN:-}
    frontend_bullpen_home=\${BULLPEN_HOME:-}
    frontend_bullpen_credentials_home=\${BULLPEN_CREDENTIALS_HOME:-}
    set +a

    compare_bullpen_setting() {
      local name=\"\$1\"
      local backend_value=\"\$2\"
      local frontend_value=\"\$3\"

      if [[ -z \"\$backend_value\" && -z \"\$frontend_value\" ]]; then
        return 0
      fi

      if [[ -z \"\$backend_value\" || -z \"\$frontend_value\" ]]; then
        echo \"\$name must be set in both $BACKEND_ENV_FILE and $FRONTEND_ENV_FILE once Bullpen is configured. Backend='\$backend_value' Frontend='\$frontend_value'\" >&2
        exit 1
      fi

      if [[ \"\$backend_value\" != \"\$frontend_value\" ]]; then
        echo \"\$name differs between $BACKEND_ENV_FILE (\$backend_value) and $FRONTEND_ENV_FILE (\$frontend_value). The Bullpen popup and Auto-Live worker will read different Bullpen sessions.\" >&2
        exit 1
      fi
    }

    compare_bullpen_setting BULLPEN_BIN \"\$backend_bullpen_bin\" \"\$frontend_bullpen_bin\"
    compare_bullpen_setting BULLPEN_HOME \"\$backend_bullpen_home\" \"\$frontend_bullpen_home\"
    compare_bullpen_setting BULLPEN_CREDENTIALS_HOME \"\$backend_bullpen_credentials_home\" \"\$frontend_bullpen_credentials_home\"
  "
}

smoke_check() {
  local label="$1"
  local url="$2"
  local attempt

  echo "==> Smoke check: $label ($url)"

  for (( attempt = 1; attempt <= SMOKE_RETRIES; attempt++ )); do
    if curl --fail --silent --show-error --location --max-time "$SMOKE_TIMEOUT_SECONDS" "$url" >/dev/null 2>&1; then
      echo "==> Smoke check passed: $label"
      return 0
    fi

    if (( attempt < SMOKE_RETRIES )); then
      echo "==> Smoke check not ready: $label (attempt $attempt/$SMOKE_RETRIES); retrying in ${SMOKE_RETRY_SLEEP_SECONDS}s"
      sleep "$SMOKE_RETRY_SLEEP_SECONDS"
    fi
  done

  echo "Smoke check failed after $SMOKE_RETRIES attempts: $label ($url)" >&2
  curl --fail --silent --show-error --location --max-time "$SMOKE_TIMEOUT_SECONDS" "$url" >/dev/null
}

print_service_diagnostics() {
  local service_name="$1"

  echo "==> Diagnostics for $service_name" >&2
  sudo systemctl status "$service_name" --no-pager --lines=50 >&2 || true
  sudo journalctl -u "$service_name" --no-pager --lines=100 >&2 || true
}

service_restart_count() {
  local service_name="$1"
  local restarts

  restarts="$(sudo systemctl show "$service_name" --property=NRestarts --value 2>/dev/null || true)"
  if [[ "$restarts" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$restarts"
    return
  fi

  printf '0\n'
}

verify_service_active() {
  local service_name="$1"
  local attempt
  local state
  local restarts_before
  local restarts_after

  echo "==> Waiting for service to become active and stable: $service_name"

  for (( attempt = 1; attempt <= SERVICE_STARTUP_RETRIES; attempt++ )); do
    if sudo systemctl is-active --quiet "$service_name"; then
      restarts_before="$(service_restart_count "$service_name")"
      echo "==> Service is active: $service_name; confirming it remains stable for ${SERVICE_STABLE_SECONDS}s"
      sleep "$SERVICE_STABLE_SECONDS"

      if sudo systemctl is-active --quiet "$service_name"; then
        restarts_after="$(service_restart_count "$service_name")"
        if (( restarts_after == restarts_before )); then
          echo "==> Service is active and stable: $service_name"
          return 0
        fi

        echo "Service restarted while stability check was running: $service_name (restarts ${restarts_before}->${restarts_after})" >&2
      else
        state="$(sudo systemctl is-active "$service_name" 2>/dev/null || true)"
        echo "Service stopped being active during stability check: $service_name (state=${state:-unknown})" >&2
      fi

      print_service_diagnostics "$service_name"
      return 1
    fi

    state="$(sudo systemctl is-active "$service_name" 2>/dev/null || true)"
    if [[ "$state" == "failed" ]]; then
      echo "Service failed during startup: $service_name" >&2
      print_service_diagnostics "$service_name"
      return 1
    fi

    if (( attempt < SERVICE_STARTUP_RETRIES )); then
      echo "==> Service not active yet: $service_name (state=${state:-unknown}, attempt $attempt/$SERVICE_STARTUP_RETRIES); retrying in ${SERVICE_STARTUP_RETRY_SLEEP_SECONDS}s"
      sleep "$SERVICE_STARTUP_RETRY_SLEEP_SECONDS"
    fi
  done

  echo "Service did not become active after $SERVICE_STARTUP_RETRIES attempts: $service_name (state=${state:-unknown})" >&2
  print_service_diagnostics "$service_name"
  return 1
}

read_env_file_var() {
  local file="$1"
  local name="$2"

  sudo python3 - "$file" "$name" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
name = sys.argv[2]

if not path.exists():
    sys.exit(0)

for raw_line in path.read_text(encoding="utf-8").splitlines():
    line = raw_line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    if key.strip() != name:
        continue
    value = value.strip()
    if value[:1] == value[-1:] and value[:1] in {"'", '"'}:
        value = value[1:-1]
    print(value)
    break
PY
}

url_host() {
  local value="${1:-}"

  python3 - "$value" <<'PY'
import sys
from urllib.parse import urlparse

value = sys.argv[1].strip()
if not value:
    raise SystemExit(0)

parsed = urlparse(value if "://" in value else f"https://{value}")
print(parsed.hostname or value)
PY
}

backup_target() {
  local target="$1"
  local backup

  if [[ "$BACKED_UP_PATHS_LIST" == *$'\n'"$target"$'\n'* ]]; then
    return
  fi

  CONFIG_ROLLBACK_ENABLED=true
  backup="$CONFIG_BACKUP_DIR${target}"
  sudo mkdir -p "$(dirname "$backup")"

  if sudo test -e "$target" || sudo test -L "$target"; then
    sudo cp -a "$target" "$backup"
    CONFIG_BACKUPS+=("existing|$target|$backup")
  else
    CONFIG_BACKUPS+=("missing|$target|")
  fi

  BACKED_UP_PATHS_LIST+="$target"$'\n'
}

restart_services_after_restore() {
  sudo systemctl daemon-reload || true
  sudo systemctl restart "$BACKEND_SERVICE_NAME" "$WORKER_SERVICE_NAME" "$BEAT_SERVICE_NAME" || true

  if [[ "$BEAT_WORKER_MANAGED" == "true" ]]; then
    sudo systemctl restart "$BEAT_WORKER_SERVICE_NAME" || true
  fi

  if [[ "$SCOPE" == "full" ]]; then
    sudo systemctl restart "$FRONTEND_SERVICE_NAME" || true
  fi

  if [[ "$NGINX_RELOAD_REQUIRED" == "true" ]]; then
    sudo nginx -t >/dev/null 2>&1 && sudo systemctl reload nginx || true
  fi
}

rollback_configuration() {
  local index kind target backup

  if [[ "$CONFIG_ROLLBACK_ENABLED" != "true" ]]; then
    return
  fi

  echo "==> Rolling back systemd/nginx configuration"
  set +e

  for (( index = ${#CONFIG_BACKUPS[@]} - 1; index >= 0; index-- )); do
    IFS='|' read -r kind target backup <<<"${CONFIG_BACKUPS[$index]}"
    if [[ "$kind" == "existing" ]]; then
      sudo rm -rf "$target"
      sudo mkdir -p "$(dirname "$target")"
      sudo cp -a "$backup" "$target"
    else
      sudo rm -rf "$target"
    fi
  done

  restart_services_after_restore
}

trap 'status=$?; if (( status != 0 )); then rollback_configuration; fi; exit $status' ERR

render_systemd_template() {
  local template="$1"
  local destination="$2"

  APP_ROOT="$APP_ROOT" \
  APP_USER="$APP_USER" \
  BACKEND_ENV_FILE="$BACKEND_ENV_FILE" \
  FRONTEND_ENV_FILE="$FRONTEND_ENV_FILE" \
  python3 - "$template" "$destination" <<'PY'
import os
import sys
from pathlib import Path

template_path = Path(sys.argv[1])
destination_path = Path(sys.argv[2])
text = template_path.read_text(encoding="utf-8")
replacements = {
    "__APP_ROOT__": os.environ["APP_ROOT"],
    "__APP_USER__": os.environ["APP_USER"],
    "__BACKEND_ENV_FILE__": os.environ["BACKEND_ENV_FILE"],
    "__FRONTEND_ENV_FILE__": os.environ["FRONTEND_ENV_FILE"],
}

for old, new in replacements.items():
    text = text.replace(old, new)

destination_path.write_text(text, encoding="utf-8")
PY
}

render_nginx_template() {
  local template="$1"
  local destination="$2"
  local frontend_host="$3"
  local api_host="$4"

  FRONTEND_HOST="$frontend_host" \
  API_HOST="$api_host" \
  python3 - "$template" "$destination" <<'PY'
import os
import sys
from pathlib import Path

template_path = Path(sys.argv[1])
destination_path = Path(sys.argv[2])
text = template_path.read_text(encoding="utf-8")
replacements = [
    ("api.yourdomain.com", os.environ["API_HOST"]),
    ("yourdomain.com", os.environ["FRONTEND_HOST"]),
]

for old, new in replacements:
    text = text.replace(old, new)

destination_path.write_text(text, encoding="utf-8")
PY
}

systemd_unit_file_name() {
  local unit_name="$1"

  if [[ "$unit_name" == *.service ]]; then
    printf '%s\n' "$unit_name"
    return
  fi

  printf '%s.service\n' "$unit_name"
}

install_systemd_unit() {
  local unit_name="$1"
  local unit_file
  local template
  local target
  local rendered

  unit_file="$(systemd_unit_file_name "$unit_name")"
  template="$APP_ROOT/deploy/no-docker/systemd/$unit_file"
  target="/etc/systemd/system/$unit_file"

  if [[ ! -f "$template" ]]; then
    echo "Systemd template not found: $template" >&2
    exit 1
  fi

  rendered="$(mktemp)"
  render_systemd_template "$template" "$rendered"
  backup_target "$target"
  sudo install -m 0644 "$rendered" "$target"
  rm -f "$rendered"
  INSTALLED_SYSTEMD_UNITS+=("$target")
}

validate_systemd_units() {
  local unit_path

  for unit_path in "${INSTALLED_SYSTEMD_UNITS[@]}"; do
    sudo systemd-analyze verify "$unit_path"
  done
}

install_or_update_nginx_template() {
  local template="$APP_ROOT/deploy/no-docker/nginx/investor.conf"
  local available="/etc/nginx/sites-available/investor.conf"
  local enabled="/etc/nginx/sites-enabled/investor.conf"
  local frontend_url api_url frontend_host api_host
  local available_preexisting=false
  local enabled_preexisting=false
  local rendered

  if [[ ! -f "$template" ]]; then
    echo "==> Nginx template not found: $template"
    return
  fi

  if sudo test -e "$available" || sudo test -L "$available"; then
    available_preexisting=true
  fi

  if sudo test -e "$enabled" || sudo test -L "$enabled"; then
    enabled_preexisting=true
  fi

  frontend_url="$(read_env_file_var "$FRONTEND_ENV_FILE" "NEXT_PUBLIC_FRONTEND_URL")"
  if [[ -z "$frontend_url" ]]; then
    frontend_url="$(read_env_file_var "$FRONTEND_ENV_FILE" "NEXTAUTH_URL")"
  fi
  if [[ -z "$frontend_url" ]]; then
    frontend_url="$(read_env_file_var "$BACKEND_ENV_FILE" "FRONTEND_URL")"
  fi
  api_url="$(read_env_file_var "$FRONTEND_ENV_FILE" "NEXT_PUBLIC_API_URL")"

  frontend_host="$(url_host "$frontend_url")"
  api_host="$(url_host "$api_url")"
  if [[ -z "$api_host" && -n "$frontend_host" ]]; then
    api_host="api.$frontend_host"
  fi

  if [[ -z "$frontend_host" || -z "$api_host" ]]; then
    echo "Unable to render nginx template without frontend/api hostnames." >&2
    exit 1
  fi

  rendered="$(mktemp)"
  render_nginx_template "$template" "$rendered" "$frontend_host" "$api_host"

  backup_target "$available"
  sudo install -D -m 0644 "$rendered" "$available"
  rm -f "$rendered"

  if [[ "$enabled_preexisting" == "true" ]]; then
    backup_target "$enabled"
    sudo ln -sfn "$available" "$enabled"
    NGINX_RELOAD_REQUIRED=true
  elif [[ "$available_preexisting" == "true" ]]; then
    echo "==> Updated nginx template at $available; enable it manually if this host does not already use /etc/nginx/sites-enabled/investor.conf"
  else
    echo "==> Installed nginx template at $available without enabling it automatically"
  fi
}

ensure_bullpen_runtime_links() {
  local bullpen_bin="$1"
  local backend_root="$APP_ROOT/backend"
  local link_dir

  for link_dir in "$backend_root/.runtime-tools" "$backend_root/runtime-tools"; do
    sudo mkdir -p "$link_dir"
    sudo ln -sfn "$bullpen_bin" "$link_dir/bullpen"
    sudo chown -h "$APP_USER:$APP_USER" "$link_dir/bullpen" || true
  done

  if [[ "$bullpen_bin" != "/usr/local/bin/bullpen" ]]; then
    sudo mkdir -p /usr/local/bin
    sudo ln -sfn "$bullpen_bin" /usr/local/bin/bullpen
  fi
}

install_bullpen_cli_if_needed() {
  local bullpen_bin
  bullpen_bin="$(
    run_as_app_user "
      set -euo pipefail
      set -a
      source '$BACKEND_ENV_FILE'
      set +a
      printf '%s' \"\${BULLPEN_BIN:-/usr/local/bin/bullpen}\"
    "
  )"

  if [[ -z "$bullpen_bin" ]]; then
    bullpen_bin="/usr/local/bin/bullpen"
  fi

  if [[ "$bullpen_bin" != /* ]]; then
    echo "BULLPEN_BIN must be an absolute path for production deploys: $bullpen_bin" >&2
    exit 1
  fi

  if [[ -x "$bullpen_bin" ]]; then
    echo "==> Bullpen CLI already installed at $bullpen_bin"
    "$bullpen_bin" --version
    ensure_bullpen_runtime_links "$bullpen_bin"
    return
  fi

  echo "==> Bullpen CLI missing at $bullpen_bin; installing version $BULLPEN_VERSION"
  local install_dir installer discovered_bin candidate
  install_dir="$(dirname "$bullpen_bin")"
  installer="$(mktemp)"
  curl -fsSL https://cli.bullpen.fi/install.sh -o "$installer"
  chmod +x "$installer"
  sudo mkdir -p "$install_dir"
  sudo env BULLPEN_VERSION="$BULLPEN_VERSION" BULLPEN_INSTALL_DIR="$install_dir" "$installer"
  rm -f "$installer"

  if [[ ! -x "$bullpen_bin" ]]; then
    discovered_bin=""
    for candidate in \
      "/home/$APP_USER/.bullpen/bin/bullpen" \
      "$APP_ROOT/backend/.runtime-tools/bullpen" \
      "$APP_ROOT/backend/runtime-tools/bullpen" \
      "/root/.bullpen/bin/bullpen"; do
      if [[ -x "$candidate" ]]; then
        discovered_bin="$candidate"
        break
      fi
    done

    if [[ -n "$discovered_bin" ]]; then
      echo "==> Bullpen installer wrote $discovered_bin; linking expected path $bullpen_bin"
      sudo ln -sfn "$discovered_bin" "$bullpen_bin"
    fi
  fi

  if [[ ! -x "$bullpen_bin" ]]; then
    echo "Bullpen install completed but executable is still missing or not executable: $bullpen_bin" >&2
    exit 1
  fi

  "$bullpen_bin" --version
  ensure_bullpen_runtime_links "$bullpen_bin"
}

BACKEND_SERVICE_NAME="$(resolve_role_service_name backend)"
WORKER_SERVICE_NAME="$(resolve_role_service_name celery-worker)"
BEAT_SERVICE_NAME="$(resolve_role_service_name celery-beat)"
BEAT_WORKER_SERVICE_NAME="$(resolve_role_service_name celery-beat-worker)"
FRONTEND_SERVICE_NAME="$(resolve_role_service_name frontend)"

BEAT_WORKER_MANAGED=false
if systemctl is-active --quiet "$BEAT_WORKER_SERVICE_NAME" >/dev/null 2>&1 || systemctl is-enabled --quiet "$BEAT_WORKER_SERVICE_NAME" >/dev/null 2>&1; then
  BEAT_WORKER_MANAGED=true
fi

echo "==> Deploy scope: $SCOPE"
echo "==> App root: $APP_ROOT"
echo "==> App user: $APP_USER"
echo "==> Backend service: $BACKEND_SERVICE_NAME"
echo "==> Worker service: $WORKER_SERVICE_NAME"
echo "==> Beat service: $BEAT_SERVICE_NAME"
echo "==> Beat worker service: $BEAT_WORKER_SERVICE_NAME (managed=$BEAT_WORKER_MANAGED)"
echo "==> Frontend service: $FRONTEND_SERVICE_NAME"

validate_backend_env_file
install_bullpen_cli_if_needed
if [[ "$SCOPE" == "full" ]]; then
  validate_frontend_env_file
  validate_bullpen_env_alignment
fi

if [[ "$SKIP_GIT_SYNC" != "true" ]]; then
  echo "==> Pull latest code"
  run_as_app_user "
    cd '$APP_ROOT'
    git fetch origin main
    git reset --hard origin/main
  "
fi

echo "==> Install/update systemd templates"
install_systemd_unit "$BACKEND_SERVICE_NAME"
install_systemd_unit "$WORKER_SERVICE_NAME"
install_systemd_unit "$BEAT_SERVICE_NAME"
install_systemd_unit "$BEAT_WORKER_SERVICE_NAME"
if [[ "$SCOPE" == "full" ]]; then
  install_systemd_unit "$FRONTEND_SERVICE_NAME"
fi

if [[ "$SCOPE" == "full" ]]; then
  echo "==> Install/update nginx template"
  install_or_update_nginx_template
fi

echo "==> Validate configuration"
sudo systemctl daemon-reload
validate_systemd_units
if [[ "$SCOPE" == "full" ]]; then
  sudo nginx -t
fi

echo "==> Update backend dependencies and run migrations"
run_as_app_user "
  cd '$APP_ROOT/backend'
  source .venv/bin/activate
  pip install -r requirements.txt
  set -a
  source '$BACKEND_ENV_FILE'
  set +a
  alembic upgrade head
"

if [[ "$SCOPE" == "full" ]]; then
  echo "==> Update frontend dependencies and build"
  run_as_app_user "
    cd '$APP_ROOT/frontend'
    rm -rf node_modules .next
    npm ci
    test -f node_modules/next/dist/compiled/cookie/index.js
    test -f node_modules/next/dist/server/lib/router-utils/instrumentation-globals.external.js
    set -a
    source '$FRONTEND_ENV_FILE'
    set +a
    npm run build
    node '$APP_ROOT/deploy/no-docker/repair-next-runtime-artifacts.mjs' '$APP_ROOT/frontend'
  "
fi

echo "==> Restart services"
sudo systemctl restart "$BACKEND_SERVICE_NAME" "$WORKER_SERVICE_NAME" "$BEAT_SERVICE_NAME"
if [[ "$BEAT_WORKER_MANAGED" == "true" ]]; then
  sudo systemctl restart "$BEAT_WORKER_SERVICE_NAME"
else
  echo "==> Optional beat queue worker is not active or enabled; template updated without starting it"
fi

if [[ "$SCOPE" == "full" ]]; then
  sudo systemctl restart "$FRONTEND_SERVICE_NAME"
  if [[ "$NGINX_RELOAD_REQUIRED" == "true" ]]; then
    sudo systemctl reload nginx
  fi
fi

echo "==> Verify service startup"
verify_service_active "$BACKEND_SERVICE_NAME"
verify_service_active "$WORKER_SERVICE_NAME"
verify_service_active "$BEAT_SERVICE_NAME"
if [[ "$BEAT_WORKER_MANAGED" == "true" ]]; then
  verify_service_active "$BEAT_WORKER_SERVICE_NAME"
fi
if [[ "$SCOPE" == "full" ]]; then
  verify_service_active "$FRONTEND_SERVICE_NAME"
fi

echo "==> Service status"
sudo systemctl status "$BACKEND_SERVICE_NAME" --no-pager
sudo systemctl status "$WORKER_SERVICE_NAME" --no-pager
sudo systemctl status "$BEAT_SERVICE_NAME" --no-pager
if [[ "$BEAT_WORKER_MANAGED" == "true" ]]; then
  sudo systemctl status "$BEAT_WORKER_SERVICE_NAME" --no-pager
fi
if [[ "$SCOPE" == "full" ]]; then
  sudo systemctl status "$FRONTEND_SERVICE_NAME" --no-pager
fi

echo "==> Smoke checks"
smoke_check "backend live" "$BACKEND_LIVE_URL"
smoke_check "backend ready" "$BACKEND_READY_URL"
if [[ "$SCOPE" == "full" ]]; then
  smoke_check "frontend login" "$FRONTEND_SMOKE_URL"
fi

CONFIG_ROLLBACK_ENABLED=false
rm -rf "$CONFIG_BACKUP_DIR"

echo "==> Deploy complete"
