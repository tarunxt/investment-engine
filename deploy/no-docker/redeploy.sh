#!/usr/bin/env bash

set -euo pipefail

REQUESTED_SCOPE="${1:-full-stack}"
DEFAULT_APP_ROOT="/srv/investor"
LEGACY_APP_ROOT="/srv/investment-engine"
DEFAULT_APP_USER="investor"
LEGACY_APP_USER="investment-engine"
DEFAULT_BACKEND_ENV_FILE="/etc/investor/backend.env"
DEFAULT_FRONTEND_ENV_FILE="/etc/investor/frontend.env"
CANONICAL_BULLPEN_RUNTIME_OWNER="investor"
CANONICAL_BULLPEN_HOME="/home/investor"
CANONICAL_BULLPEN_STORE="/home/investor/.bullpen"
CANONICAL_BULLPEN_CONFIG="/home/investor/.bullpen/config.toml"
CANONICAL_BULLPEN_ENV="production"
CANONICAL_BULLPEN_BIN="/usr/local/bin/bullpen"
APP_ROOT="${APP_ROOT:-$DEFAULT_APP_ROOT}"
APP_USER="${APP_USER:-$DEFAULT_APP_USER}"
BACKEND_ENV_FILE="${BACKEND_ENV_FILE:-$DEFAULT_BACKEND_ENV_FILE}"
FRONTEND_ENV_FILE="${FRONTEND_ENV_FILE:-$DEFAULT_FRONTEND_ENV_FILE}"
SKIP_GIT_SYNC="${SKIP_GIT_SYNC:-false}"
FRONTEND_ARTIFACT="${FRONTEND_ARTIFACT:-}"
EXPECTED_FRONTEND_SHA="${EXPECTED_FRONTEND_SHA:-}"
ALLOW_ON_HOST_FRONTEND_BUILD="${ALLOW_ON_HOST_FRONTEND_BUILD:-false}"
BULLPEN_VERSION="${BULLPEN_VERSION:-0.1.115}"
BACKEND_LIVE_URL="${BACKEND_LIVE_URL:-http://127.0.0.1:8000/health/live}"
BACKEND_READY_URL="${BACKEND_READY_URL:-http://127.0.0.1:8000/health/ready}"
FRONTEND_SMOKE_URL="${FRONTEND_SMOKE_URL:-http://127.0.0.1:3000/login}"
FRONTEND_CONSOLE_SMOKE_URL="${FRONTEND_CONSOLE_SMOKE_URL:-http://127.0.0.1:3000/console/dashboard}"
FRONTEND_BULLPEN_AI_SMOKE_URL="${FRONTEND_BULLPEN_AI_SMOKE_URL:-http://127.0.0.1:3000/console/bullpen-ai}"
SMOKE_TIMEOUT_SECONDS="${SMOKE_TIMEOUT_SECONDS:-20}"
SMOKE_RETRIES="${SMOKE_RETRIES:-30}"
SMOKE_RETRY_SLEEP_SECONDS="${SMOKE_RETRY_SLEEP_SECONDS:-2}"
SERVICE_STARTUP_RETRIES="${SERVICE_STARTUP_RETRIES:-30}"
SERVICE_STARTUP_RETRY_SLEEP_SECONDS="${SERVICE_STARTUP_RETRY_SLEEP_SECONDS:-2}"
SERVICE_STABLE_SECONDS="${SERVICE_STABLE_SECONDS:-8}"
SYSTEMD_UNIT_ROOT="${SYSTEMD_UNIT_ROOT:-/etc/systemd/system}"
NGINX_CONFIG_ROOT="${NGINX_CONFIG_ROOT:-/etc/nginx}"

case "$REQUESTED_SCOPE" in
  frontend|frontend-only)
    SCOPE="frontend-only"
    DEPLOY_FRONTEND=true
    DEPLOY_BACKEND=false
    ;;
  backend|backend-only)
    SCOPE="backend-only"
    DEPLOY_FRONTEND=false
    DEPLOY_BACKEND=true
    ;;
  full|full-stack)
    SCOPE="full-stack"
    DEPLOY_FRONTEND=true
    DEPLOY_BACKEND=true
    ;;
  *)
    echo "Usage: $0 [frontend-only|backend-only|full-stack]" >&2
    exit 1
    ;;
esac

declare -a CONFIG_BACKUPS=()
declare -a INSTALLED_SYSTEMD_UNITS=()
declare -a PHASE_NAMES=()
declare -A PHASE_STARTED_AT=()
declare -A PHASE_DURATIONS=()
CONFIG_BACKUP_DIR="$(mktemp -d)"
BACKED_UP_PATHS_LIST=$'\n'
CONFIG_ROLLBACK_ENABLED=false
CONFIG_ROLLBACK_ATTEMPTED=false
NGINX_RELOAD_REQUIRED=false
SYSTEMD_RELOAD_REQUIRED=false
FRONTEND_PROMOTED=false
FRONTEND_ROLLBACK_ATTEMPTED=false
DEPLOY_STARTED_AT="$(date +%s)"

start_phase() {
  local name="$1"
  PHASE_STARTED_AT["$name"]="$(date +%s)"
  PHASE_NAMES+=("$name")
}

finish_phase() {
  local name="$1"
  local finished_at
  finished_at="$(date +%s)"
  if [[ -n "${PHASE_STARTED_AT[$name]:-}" ]]; then
    PHASE_DURATIONS["$name"]="$(( finished_at - PHASE_STARTED_AT[$name] ))"
    unset 'PHASE_STARTED_AT[$name]'
  fi
}

print_timing_summary() {
  local finished_at name duration
  finished_at="$(date +%s)"
  echo "==> Deployment timing summary"
  for name in "${PHASE_NAMES[@]}"; do
    duration="${PHASE_DURATIONS[$name]:-}"
    if [[ -z "$duration" && -n "${PHASE_STARTED_AT[$name]:-}" ]]; then
      duration="$(( finished_at - PHASE_STARTED_AT[$name] ))"
    fi
    if [[ -n "$duration" ]]; then
      printf '  %-32s %4ss\n' "$name" "$duration"
    fi
  done
  printf '  %-32s %4ss\n' "ec2-deploy-total" "$(( finished_at - DEPLOY_STARTED_AT ))"
}

cleanup_config_backup_dir() {
  if [[ -n "${CONFIG_BACKUP_DIR:-}" && -d "$CONFIG_BACKUP_DIR" ]]; then
    sudo rm -rf "$CONFIG_BACKUP_DIR"
  fi
}

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

FRONTEND_ROOT="$APP_ROOT/frontend"
FRONTEND_ACTIVE_BUILD_POINTER="$FRONTEND_ROOT/.next-active-dir"
FRONTEND_ACTIVE_BUILD_NAME=".next"
FRONTEND_CANDIDATE_BUILD_NAME=".next-candidate"
FRONTEND_LIVE_BUILD_DIR="$FRONTEND_ROOT/$FRONTEND_ACTIVE_BUILD_NAME"
FRONTEND_CANDIDATE_BUILD_DIR="$FRONTEND_ROOT/$FRONTEND_CANDIDATE_BUILD_NAME"
FRONTEND_INACTIVE_BUILD_DIR="$FRONTEND_CANDIDATE_BUILD_DIR"
FRONTEND_CANDIDATE_READY=false
FRONTEND_CANDIDATE_IS_STANDALONE=false
FRONTEND_PREVIOUS_BUILD_AVAILABLE=false
FRONTEND_ACTIVE_POINTER_PRESENT=false

default_service_prefix() {
  if [[ "$APP_ROOT" == "$LEGACY_APP_ROOT" || "$APP_USER" == "$LEGACY_APP_USER" ]]; then
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

validate_no_duplicate_backend_service_families() {
  local investor_active=false
  local investment_engine_active=false

  if service_family_has_active_backend_member "investor"; then
    investor_active=true
  fi

  if service_family_has_active_backend_member "investment-engine"; then
    investment_engine_active=true
  fi

  if [[ "$investor_active" == "true" && "$investment_engine_active" == "true" ]]; then
    echo "Both investor-* and investment-engine-* backend/worker service families are active. Stop one family before deploying the canonical Bullpen runtime." >&2
    exit 1
  fi
}

run_as_app_user() {
  local script="$1"
  sudo -u "$APP_USER" -H bash -lc "$(printf 'set -euo pipefail\n%s' "$script")"
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

validate_canonical_bullpen_backend_env() {
  run_as_app_user "
    set -euo pipefail

    set -a
    source '$BACKEND_ENV_FILE'
    set +a

    require_effective_setting() {
      local name=\"\$1\"
      local actual=\"\$2\"
      local expected=\"\$3\"

      if [[ \"\$actual\" != \"\$expected\" ]]; then
        echo \"\$name must resolve to \$expected for the backend runtime. Found '\${actual:-<unset>}'\" >&2
        exit 1
      fi
    }

    resolved_home=\"\${HOME:-$CANONICAL_BULLPEN_HOME}\"
    resolved_bullpen_bin=\"\${BULLPEN_BIN:-$CANONICAL_BULLPEN_BIN}\"
    resolved_bullpen_home=\"\${BULLPEN_HOME:-\${BULLPEN_CREDENTIALS_HOME:-$CANONICAL_BULLPEN_STORE}}\"
    resolved_bullpen_config=\"\${BULLPEN_CONFIG:-$CANONICAL_BULLPEN_CONFIG}\"
    resolved_bullpen_env=\"\${BULLPEN_ENV:-$CANONICAL_BULLPEN_ENV}\"
    resolved_bullpen_credentials_home=\"\${BULLPEN_CREDENTIALS_HOME:-\$resolved_bullpen_home}\"

    require_effective_setting HOME \"\$resolved_home\" '$CANONICAL_BULLPEN_HOME'
    require_effective_setting BULLPEN_BIN \"\$resolved_bullpen_bin\" '$CANONICAL_BULLPEN_BIN'
    require_effective_setting BULLPEN_HOME \"\$resolved_bullpen_home\" '$CANONICAL_BULLPEN_STORE'
    require_effective_setting BULLPEN_CONFIG \"\$resolved_bullpen_config\" '$CANONICAL_BULLPEN_CONFIG'
    require_effective_setting BULLPEN_ENV \"\$resolved_bullpen_env\" '$CANONICAL_BULLPEN_ENV'
    require_effective_setting BULLPEN_CREDENTIALS_HOME \"\$resolved_bullpen_credentials_home\" '$CANONICAL_BULLPEN_STORE'

    actual_user=\"\$(id -un)\"
    if [[ \"\$actual_user\" != '$CANONICAL_BULLPEN_RUNTIME_OWNER' ]]; then
      echo \"Deploy validations must run as $CANONICAL_BULLPEN_RUNTIME_OWNER to match the canonical Bullpen credential owner. Current user: \$actual_user\" >&2
      exit 1
    fi

    if [[ ! -x \"\$resolved_bullpen_bin\" ]]; then
      echo \"Bullpen binary is missing or not executable at \$resolved_bullpen_bin\" >&2
      exit 1
    fi

    if [[ ! -d \"\$resolved_bullpen_home\" ]]; then
      echo \"Bullpen credential store is missing at \$resolved_bullpen_home\" >&2
      exit 1
    fi
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

smoke_check_auth_payload() {
  local label="$1"
  local url="$2"
  local payload_kind="$3"
  local attempt payload_file

  payload_file="$(mktemp)"
  echo "==> Smoke check: $label payload ($url)"

  for (( attempt = 1; attempt <= SMOKE_RETRIES; attempt++ )); do
    if curl --fail --silent --show-error --max-time "$SMOKE_TIMEOUT_SECONDS" \
      "$url" >"$payload_file" 2>/dev/null &&
      python3 - "$payload_file" "$payload_kind" <<'PY'
import json
import sys
from urllib.parse import urlparse

with open(sys.argv[1], encoding="utf-8") as payload:
    value = json.load(payload)

kind = sys.argv[2]
if kind == "providers":
    credentials = value.get("credentials") if isinstance(value, dict) else None
    sign_in_url = (
        credentials.get("signinUrl") if isinstance(credentials, dict) else None
    )
    valid = (
        credentials.get("id") == "credentials"
        and isinstance(sign_in_url, str)
        and urlparse(sign_in_url).path == "/api/auth/signin/credentials"
    )
elif kind == "csrf":
    token = value.get("csrfToken") if isinstance(value, dict) else None
    valid = isinstance(token, str) and bool(token.strip())
else:
    raise SystemExit(f"Unknown Auth.js payload kind: {kind}")

raise SystemExit(0 if valid else 1)
PY
    then
      rm -f "$payload_file"
      echo "==> Smoke check passed: $label payload"
      return 0
    fi

    if (( attempt < SMOKE_RETRIES )); then
      echo "==> Smoke check not ready: $label payload (attempt $attempt/$SMOKE_RETRIES)"
      sleep "$SMOKE_RETRY_SLEEP_SECONDS"
    fi
  done

  rm -f "$payload_file"
  echo "Smoke check failed: $label returned an invalid payload." >&2
  return 1
}

smoke_check_protected_frontend_route() {
  local label="$1"
  local url="$2"
  local expected_path="$3"
  local attempt headers_file http_code location

  headers_file="$(mktemp)"
  echo "==> Smoke check: $label authentication boundary ($url)"

  for (( attempt = 1; attempt <= SMOKE_RETRIES; attempt++ )); do
    : >"$headers_file"
    http_code="$(
      curl --silent --show-error \
        --output /dev/null \
        --dump-header "$headers_file" \
        --write-out '%{http_code}' \
        --max-time "$SMOKE_TIMEOUT_SECONDS" \
        "$url" 2>/dev/null || true
    )"
    location="$(
      awk 'BEGIN { IGNORECASE = 1 } /^location:/ {
        sub(/^[^:]*:[[:space:]]*/, "")
        sub(/\r$/, "")
        print
        exit
      }' "$headers_file"
    )"

    if [[ "$http_code" =~ ^30[2378]$ ]] && python3 - "$location" "$expected_path" <<'PY'
import sys
from urllib.parse import parse_qs, urlparse

location = urlparse(sys.argv[1])
expected = sys.argv[2]
raise SystemExit(
    0
    if location.path == "/login"
    and parse_qs(location.query).get("redirectTo") == [expected]
    else 1
)
PY
    then
      rm -f "$headers_file"
      echo "==> Smoke check passed: $label route and login redirect"
      return 0
    fi

    if (( attempt < SMOKE_RETRIES )); then
      echo "==> Smoke check not ready: $label (HTTP ${http_code:-<missing>}, attempt $attempt/$SMOKE_RETRIES)"
      sleep "$SMOKE_RETRY_SLEEP_SECONDS"
    fi
  done

  rm -f "$headers_file"
  echo "$label did not return its expected authenticated login redirect." >&2
  return 1
}

smoke_check_frontend_static_asset() {
  local html_file headers_file body_file asset_path content_type
  local saw_javascript=false
  local saw_css=false
  local -a asset_paths=()

  html_file="$(mktemp)"
  headers_file="$(mktemp)"
  body_file="$(mktemp)"

  cleanup_frontend_static_smoke_files() {
    rm -f "$html_file" "$headers_file" "$body_file"
  }

  echo "==> Smoke check: frontend static asset ($FRONTEND_SMOKE_URL)"
  if ! curl --fail --silent --show-error --location --max-time "$SMOKE_TIMEOUT_SECONDS" "$FRONTEND_SMOKE_URL" >"$html_file"; then
    cleanup_frontend_static_smoke_files
    return 1
  fi

  mapfile -t asset_paths < <(python3 - "$html_file" <<'PY'
import re
import sys

html = open(sys.argv[1], encoding="utf-8").read()
assets = re.findall(r"/_next/static/[^\x22\x27\s>]+\.(?:css|js)(?:\?[^\x22\x27\s>]*)?", html)
for asset in dict.fromkeys(assets):
    print(asset)
PY
  )

  if (( ${#asset_paths[@]} == 0 )); then
    echo "Frontend smoke response did not reference Next static assets." >&2
    cleanup_frontend_static_smoke_files
    return 1
  fi

  for asset_path in "${asset_paths[@]}"; do
    : >"$headers_file"
    : >"$body_file"
    if ! curl --fail --silent --show-error --max-time "$SMOKE_TIMEOUT_SECONDS" \
      --dump-header "$headers_file" \
      "http://127.0.0.1:3000${asset_path}" >"$body_file"; then
      cleanup_frontend_static_smoke_files
      return 1
    fi
    if [[ ! -s "$body_file" ]]; then
      echo "Frontend static asset was empty: $asset_path" >&2
      cleanup_frontend_static_smoke_files
      return 1
    fi

    content_type="$(awk 'BEGIN { IGNORECASE = 1 } /^content-type:/ { sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); print tolower($0); exit }' "$headers_file")"
    if [[ "$asset_path" == *.css* ]]; then
      saw_css=true
      if [[ "$content_type" != text/css* ]]; then
        echo "Frontend CSS asset returned an invalid content type: $asset_path ($content_type)" >&2
        cleanup_frontend_static_smoke_files
        return 1
      fi
    else
      saw_javascript=true
      if [[ "$content_type" != *javascript* && "$content_type" != *ecmascript* ]]; then
        echo "Frontend JavaScript asset returned an invalid content type: $asset_path ($content_type)" >&2
        cleanup_frontend_static_smoke_files
        return 1
      fi
    fi
  done

  cleanup_frontend_static_smoke_files
  if [[ "$saw_javascript" != "true" || "$saw_css" != "true" ]]; then
    echo "Frontend login page must reference at least one JavaScript and one CSS asset." >&2
    return 1
  fi
  echo "==> Smoke check passed: frontend JavaScript and CSS assets"
}

verify_frontend_fingerprint() {
  local attempt fingerprint_json actual_sha

  if [[ -z "$EXPECTED_FRONTEND_SHA" ]]; then
    echo "EXPECTED_FRONTEND_SHA is required for frontend fingerprint verification." >&2
    return 1
  fi

  echo "==> Verify active frontend build fingerprint"
  actual_sha=""
  for (( attempt = 1; attempt <= SMOKE_RETRIES; attempt++ )); do
    fingerprint_json="$(curl -fsS --max-time "$SMOKE_TIMEOUT_SECONDS" http://127.0.0.1:3000/api/runtime-fingerprint || true)"
    actual_sha="$(
      python3 -c 'import json, sys; print(json.load(sys.stdin).get("build_sha", ""))' \
        <<<"$fingerprint_json" 2>/dev/null || true
    )"
    if [[ "$actual_sha" == "$EXPECTED_FRONTEND_SHA" ]]; then
      echo "==> Active frontend fingerprint verified: $actual_sha"
      return 0
    fi
    if (( attempt < SMOKE_RETRIES )); then
      echo "Frontend fingerprint mismatch (attempt $attempt/$SMOKE_RETRIES): expected=$EXPECTED_FRONTEND_SHA actual=${actual_sha:-<missing>}"
      sleep "$SMOKE_RETRY_SLEEP_SECONDS"
    fi
  done

  echo "The active frontend is not serving the expected build: expected=$EXPECTED_FRONTEND_SHA actual=${actual_sha:-<missing>}" >&2
  return 1
}

select_frontend_build_slots() {
  local selected_slots

  selected_slots="$(
    sudo -u "$APP_USER" -H -- \
      node "$APP_ROOT/deploy/no-docker/frontend-artifact.mjs" \
        select "$FRONTEND_ROOT"
  )"
  case "$selected_slots" in
    $'.next\t.next-candidate')
      FRONTEND_ACTIVE_BUILD_NAME=".next"
      FRONTEND_CANDIDATE_BUILD_NAME=".next-candidate"
      ;;
    $'.next-candidate\t.next')
      FRONTEND_ACTIVE_BUILD_NAME=".next-candidate"
      FRONTEND_CANDIDATE_BUILD_NAME=".next"
      ;;
    *)
      echo "Invalid frontend slot selection: ${selected_slots:-<empty>}" >&2
      return 1
      ;;
  esac

  FRONTEND_LIVE_BUILD_DIR="$FRONTEND_ROOT/$FRONTEND_ACTIVE_BUILD_NAME"
  FRONTEND_CANDIDATE_BUILD_DIR="$FRONTEND_ROOT/$FRONTEND_CANDIDATE_BUILD_NAME"
  FRONTEND_INACTIVE_BUILD_DIR="$FRONTEND_CANDIDATE_BUILD_DIR"

  if sudo -u "$APP_USER" -H -- test -f "$FRONTEND_ACTIVE_BUILD_POINTER"; then
    FRONTEND_ACTIVE_POINTER_PRESENT=true
  else
    FRONTEND_ACTIVE_POINTER_PRESENT=false
  fi

  case "$FRONTEND_LIVE_BUILD_DIR|$FRONTEND_CANDIDATE_BUILD_DIR" in
    "$FRONTEND_ROOT/.next|$FRONTEND_ROOT/.next-candidate"|\
    "$FRONTEND_ROOT/.next-candidate|$FRONTEND_ROOT/.next")
      ;;
    *)
      echo "Frontend slots escaped their allowed roots." >&2
      return 1
      ;;
  esac
  echo "==> Frontend slots: active=$FRONTEND_ACTIVE_BUILD_NAME inactive=$FRONTEND_CANDIDATE_BUILD_NAME pointer_present=$FRONTEND_ACTIVE_POINTER_PRESENT"
}

resolve_frontend_launch_target_as_app_user() {
  sudo -u "$APP_USER" -H -- bash -c '
    set -euo pipefail
    set -a
    source "$1"
    set +a
    exec node "$2" resolve-launch "$3"
  ' -- \
    "$FRONTEND_ENV_FILE" \
    "$APP_ROOT/deploy/no-docker/frontend-artifact.mjs" \
    "$FRONTEND_ROOT"
}

frontend_slot_is_valid() {
  local slot="$1"
  local launch_target

  launch_target="$(resolve_frontend_launch_target_as_app_user)"
  [[
    "$launch_target" == $'standalone-slot\t'"$slot"$'\t'"$FRONTEND_ACTIVE_BUILD_NAME" ||
      "$launch_target" == $'legacy-slot\t'"$slot"$'\t'"$FRONTEND_ACTIVE_BUILD_NAME"
  ]]
}

frontend_root_standalone_is_valid() {
  local launch_target

  if [[ "$FRONTEND_ACTIVE_POINTER_PRESENT" == "true" ]]; then
    return 1
  fi
  launch_target="$(resolve_frontend_launch_target_as_app_user)"
  [[ "$launch_target" == $'standalone-root-recovery\t'"$FRONTEND_ROOT"$'\t' ]]
}

validate_frontend_archive_members() {
  python3 - "$FRONTEND_ARTIFACT" <<'PY'
import pathlib
import sys
import tarfile

with tarfile.open(sys.argv[1], "r:gz") as archive:
    members = archive.getmembers()
    if not members:
        raise SystemExit("Frontend artifact archive is empty.")
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts:
            raise SystemExit(f"Unsafe frontend artifact member: {member.name}")
        if member.issym() or member.islnk():
            link = pathlib.PurePosixPath(member.linkname)
            resolved_parts = (path.parent / link).parts
            if link.is_absolute() or ".." in resolved_parts:
                raise SystemExit(
                    f"Unsafe frontend artifact link: {member.name} -> {member.linkname}"
                )
PY
}

prepare_frontend_candidate_artifact() {
  local artifact_directory artifact_name

  echo "==> Stage frontend artifact in the inactive build slot"
  if [[ -z "$FRONTEND_ARTIFACT" || -z "$EXPECTED_FRONTEND_SHA" ]]; then
    echo "FRONTEND_ARTIFACT and EXPECTED_FRONTEND_SHA are required for artifact deployment." >&2
    return 1
  fi
  if [[ ! -f "$FRONTEND_ARTIFACT" || ! -f "$FRONTEND_ARTIFACT.sha256" ]]; then
    echo "Frontend artifact or checksum is missing: $FRONTEND_ARTIFACT" >&2
    return 1
  fi

  select_frontend_build_slots
  artifact_directory="$(dirname "$FRONTEND_ARTIFACT")"
  artifact_name="$(basename "$FRONTEND_ARTIFACT")"
  (
    cd "$artifact_directory"
    sha256sum -c "$artifact_name.sha256"
  )
  validate_frontend_archive_members

  run_as_app_user "
    rm -rf -- '$FRONTEND_CANDIDATE_BUILD_DIR'
    mkdir -p '$FRONTEND_CANDIDATE_BUILD_DIR'
    tar --no-same-owner -xzf '$FRONTEND_ARTIFACT' -C '$FRONTEND_CANDIDATE_BUILD_DIR'
    set -a
    source '$FRONTEND_ENV_FILE'
    set +a
    node '$APP_ROOT/deploy/no-docker/frontend-artifact.mjs' \
      validate-host \
      '$FRONTEND_CANDIDATE_BUILD_DIR' \
      '$EXPECTED_FRONTEND_SHA' \
      '$FRONTEND_ROOT/package-lock.json' \
      webpack \
      true >/dev/null
    node '$APP_ROOT/scripts/verify-frontend-artifact-runtime.mjs' \
      '$FRONTEND_CANDIDATE_BUILD_DIR' \
      '$EXPECTED_FRONTEND_SHA'
  "
  FRONTEND_CANDIDATE_READY=true
  FRONTEND_CANDIDATE_IS_STANDALONE=true
}

prepare_frontend_candidate_build_on_host() {
  local active_runtime_is_standalone=false

  echo "==> Emergency fallback: build frontend candidate on this host"
  select_frontend_build_slots

  if run_as_app_user "test -f '$FRONTEND_LIVE_BUILD_DIR/server.js'"; then
    active_runtime_is_standalone=true
  fi

  run_as_app_user "
    cd '$FRONTEND_ROOT'

    lock_hash=\"\$(sha256sum package-lock.json | awk '{print \$1}')\"
    lock_marker='node_modules/.investor-package-lock.sha256'
    dependencies_need_install=false
    dependency_reason=''

    if [[ ! -x node_modules/.bin/next ]]; then
      dependencies_need_install=true
      dependency_reason='frontend dependencies are missing'
    elif [[ ! -f \"\$lock_marker\" ]]; then
      dependencies_need_install=true
      dependency_reason='frontend dependency lock marker is missing'
    elif [[ \"\$(cat \"\$lock_marker\")\" != \"\$lock_hash\" ]]; then
      dependencies_need_install=true
      dependency_reason='frontend dependency lock changed'
    fi

    if [[ \"\$dependencies_need_install\" == 'true' ]]; then
      if [[ '$active_runtime_is_standalone' != 'true' ]]; then
        echo \"\$dependency_reason. Refusing npm ci because the active legacy frontend shares node_modules and must remain untouched during candidate preparation.\" >&2
        exit 1
      fi
      echo \"==> \$dependency_reason; restoring emergency-build dependencies\"
      npm ci --prefer-offline --no-audit --fund=false --loglevel=error
    fi

    test -f node_modules/next/dist/compiled/cookie/index.js
    test -f node_modules/next/dist/server/lib/router-utils/instrumentation-globals.external.js
    printf '%s\\n' \"\$lock_hash\" > \"\$lock_marker\"

    rm -rf '$FRONTEND_CANDIDATE_BUILD_DIR'
    set -a
    source '$FRONTEND_ENV_FILE'
    set +a
    NEXT_DIST_DIR='$FRONTEND_CANDIDATE_BUILD_NAME' npm run build -- --webpack

    test -f '$FRONTEND_CANDIDATE_BUILD_DIR/BUILD_ID'
    test -d '$FRONTEND_CANDIDATE_BUILD_DIR/static'
    node '$APP_ROOT/deploy/no-docker/repair-next-runtime-artifacts.mjs' '$FRONTEND_ROOT' '$FRONTEND_CANDIDATE_BUILD_NAME'
  "

  FRONTEND_CANDIDATE_READY=true
  FRONTEND_CANDIDATE_IS_STANDALONE=false
}

prepare_frontend_candidate_build() {
  if [[ -n "$FRONTEND_ARTIFACT" ]]; then
    prepare_frontend_candidate_artifact
    return
  fi
  if [[ "$ALLOW_ON_HOST_FRONTEND_BUILD" == "true" && "$SCOPE" == "full-stack" ]]; then
    prepare_frontend_candidate_build_on_host
    return
  fi
  echo "A CI-built frontend artifact is required. The on-host build fallback is reserved for explicit recovery workflows." >&2
  return 1
}

promote_frontend_candidate_build() {
  local promoted_pointer

  if [[ "$FRONTEND_CANDIDATE_READY" != "true" ]]; then
    echo "Frontend candidate build is not ready for promotion." >&2
    return 1
  fi

  # Revalidate immediately before changing the pointer so a candidate cannot
  # disappear or become incomplete between extraction and promotion.
  if [[ "$FRONTEND_CANDIDATE_IS_STANDALONE" == "true" ]]; then
    run_as_app_user "
      set -a
      source '$FRONTEND_ENV_FILE'
      set +a
      node '$APP_ROOT/deploy/no-docker/frontend-artifact.mjs' \
        validate-host \
        '$FRONTEND_CANDIDATE_BUILD_DIR' \
        '$EXPECTED_FRONTEND_SHA' \
        '$FRONTEND_ROOT/package-lock.json' \
        webpack \
        true >/dev/null
    "
  else
    run_as_app_user "
      test -x '$FRONTEND_ROOT/node_modules/.bin/next'
      test -f '$FRONTEND_CANDIDATE_BUILD_DIR/BUILD_ID'
      test -d '$FRONTEND_CANDIDATE_BUILD_DIR/static'
    "
  fi

  # Resolve a pointerless standalone overlay before the legacy .next shape so
  # a restored shared next executable cannot make the overlay's internal
  # dist directory look like an outer rollback slot.
  if frontend_root_standalone_is_valid; then
    FRONTEND_PREVIOUS_BUILD_AVAILABLE=true
  elif frontend_slot_is_valid "$FRONTEND_LIVE_BUILD_DIR"; then
    FRONTEND_PREVIOUS_BUILD_AVAILABLE=true
  else
    echo "Refusing frontend promotion because no validated rollback runtime is available." >&2
    return 1
  fi

  run_as_app_user "node '$APP_ROOT/deploy/no-docker/frontend-artifact.mjs' point '$FRONTEND_ROOT' '$FRONTEND_CANDIDATE_BUILD_NAME'"
  # The pointer is now live. Arm rollback before any subsequent assertion can
  # fail so every post-mutation exit restores the previous runtime.
  FRONTEND_PROMOTED=true
  promoted_pointer="$(
    sudo -u "$APP_USER" -H -- \
      node -e \
        'process.stdout.write(require("node:fs").readFileSync(process.argv[1], "utf8").replaceAll("\r", "").trim())' \
        "$FRONTEND_ACTIVE_BUILD_POINTER"
  )"
  if [[ "$promoted_pointer" != "$FRONTEND_CANDIDATE_BUILD_NAME" ]]; then
    echo "Frontend promotion pointer mismatch: expected=$FRONTEND_CANDIDATE_BUILD_NAME actual=${promoted_pointer:-<missing>}" >&2
    return 1
  fi
  if [[ "$FRONTEND_CANDIDATE_IS_STANDALONE" == "true" ]]; then
    run_as_app_user "test -f '$FRONTEND_CANDIDATE_BUILD_DIR/server.js'"
  fi

  FRONTEND_CANDIDATE_READY=false
}

verify_restored_frontend_build() {
  local actual_pointer
  local verification_failed=false

  if [[ "$FRONTEND_ACTIVE_POINTER_PRESENT" != "true" ]]; then
    if sudo -u "$APP_USER" -H -- test -e "$FRONTEND_ACTIVE_BUILD_POINTER"; then
      echo "Frontend rollback pointer mismatch: expected=<missing> actual=<present>" >&2
      verification_failed=true
    fi
  else
    actual_pointer="$(
      sudo -u "$APP_USER" -H -- \
        node -e \
          'process.stdout.write(require("node:fs").readFileSync(process.argv[1], "utf8").replaceAll("\r", "").trim())' \
          "$FRONTEND_ACTIVE_BUILD_POINTER" 2>/dev/null ||
        true
    )"
    if [[ "$actual_pointer" != "$FRONTEND_ACTIVE_BUILD_NAME" ]]; then
      echo "Frontend rollback pointer mismatch: expected=$FRONTEND_ACTIVE_BUILD_NAME actual=${actual_pointer:-<missing>}" >&2
      verification_failed=true
    fi
  fi
  if ! verify_service_active "$FRONTEND_SERVICE_NAME"; then
    echo "Previous frontend service did not become stable." >&2
    verification_failed=true
  fi
  if ! smoke_check "restored frontend login" "$FRONTEND_SMOKE_URL"; then
    echo "Previous frontend failed its rollback login check." >&2
    verification_failed=true
  fi
  if ! smoke_check_auth_payload \
    "restored frontend Auth.js CSRF route" \
    "http://127.0.0.1:3000/api/auth/csrf" \
    "csrf"; then
    verification_failed=true
  fi
  if ! smoke_check_auth_payload \
    "restored frontend Auth.js providers route" \
    "http://127.0.0.1:3000/api/auth/providers" \
    "providers"; then
    verification_failed=true
  fi
  if ! smoke_check_protected_frontend_route \
    "restored frontend console dashboard" \
    "$FRONTEND_CONSOLE_SMOKE_URL" \
    "/console/dashboard"; then
    verification_failed=true
  fi
  if ! smoke_check_protected_frontend_route \
    "restored frontend Bullpen AI console" \
    "$FRONTEND_BULLPEN_AI_SMOKE_URL" \
    "/console/bullpen-ai"; then
    verification_failed=true
  fi
  if ! smoke_check_frontend_static_asset; then
    echo "Previous frontend failed its rollback static-asset check." >&2
    verification_failed=true
  fi
  if ! smoke_check \
    "restored same-origin backend proxy" \
    "http://127.0.0.1:3000/backend-api/health/live"; then
    echo "Previous frontend failed its rollback backend-proxy check." >&2
    verification_failed=true
  fi

  if [[ "$verification_failed" == "true" ]]; then
    return 1
  fi
}

restore_previous_frontend_build() {
  local rollback_failed=false

  if [[ "$FRONTEND_PROMOTED" != "true" || "$FRONTEND_ROLLBACK_ATTEMPTED" == "true" ]]; then
    return 0
  fi
  FRONTEND_ROLLBACK_ATTEMPTED=true
  if [[ "$FRONTEND_PREVIOUS_BUILD_AVAILABLE" != "true" ]]; then
    echo "No valid previous frontend slot is available for automatic rollback." >&2
    return 1
  fi

  echo "==> Restoring the previous frontend build after failed verification"
  if [[ "$FRONTEND_ACTIVE_POINTER_PRESENT" != "true" ]]; then
    if ! run_as_app_user "rm -f -- '$FRONTEND_ACTIVE_BUILD_POINTER' '$FRONTEND_ACTIVE_BUILD_POINTER.next'"; then
      echo "Failed to restore the previous pointerless frontend runtime." >&2
      rollback_failed=true
    fi
  else
    if ! run_as_app_user "node '$APP_ROOT/deploy/no-docker/frontend-artifact.mjs' point '$FRONTEND_ROOT' '$FRONTEND_ACTIVE_BUILD_NAME'"; then
      echo "Failed to restore the previous frontend pointer." >&2
      rollback_failed=true
    fi
  fi

  if ! sudo systemctl restart "$FRONTEND_SERVICE_NAME"; then
    echo "Failed to restart the previous frontend service." >&2
    rollback_failed=true
  fi
  if ! verify_restored_frontend_build; then
    rollback_failed=true
  fi

  if [[ "$rollback_failed" == "true" ]]; then
    echo "CRITICAL: automatic frontend rollback did not complete successfully." >&2
    return 1
  fi
  FRONTEND_PROMOTED=false
  echo "==> Previous frontend build restored successfully"
}

discard_previous_frontend_build() {
  # Retain the previous slot until a later successful build overwrites it so
  # an immediate verification failure can be rolled back without rebuilding.
  FRONTEND_PREVIOUS_BUILD_AVAILABLE=false
  FRONTEND_CANDIDATE_IS_STANDALONE=false
  FRONTEND_PROMOTED=false
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
  local restart_failed=false

  if [[ "$SYSTEMD_RELOAD_REQUIRED" == "true" ]]; then
    if ! sudo systemctl daemon-reload; then
      echo "Failed to reload systemd after restoring configuration." >&2
      restart_failed=true
    fi
  fi
  if [[ "$DEPLOY_BACKEND" == "true" ]]; then
    if ! sudo systemctl restart "$BACKEND_SERVICE_NAME" "$WORKER_SERVICE_NAME" "$AUTO_LIVE_WORKER_SERVICE_NAME" "$BEAT_SERVICE_NAME" "$BEAT_WORKER_SERVICE_NAME"; then
      echo "Failed to restart one or more backend services after restoring configuration." >&2
      restart_failed=true
    fi
  fi
  if [[ "$DEPLOY_FRONTEND" == "true" ]]; then
    if ! sudo systemctl restart "$FRONTEND_SERVICE_NAME"; then
      echo "Failed to restart the frontend after restoring configuration." >&2
      restart_failed=true
    fi
  fi

  if [[ "$NGINX_RELOAD_REQUIRED" == "true" ]]; then
    if ! sudo nginx -t; then
      echo "Restored Nginx configuration failed validation." >&2
      restart_failed=true
    elif ! sudo systemctl reload nginx; then
      echo "Failed to reload Nginx after restoring configuration." >&2
      restart_failed=true
    fi
  fi

  if [[ "$restart_failed" == "true" ]]; then
    return 1
  fi
}

rollback_configuration() {
  local index kind target backup
  local restore_failed=false

  if [[ "$CONFIG_ROLLBACK_ENABLED" != "true" ]]; then
    return 0
  fi

  echo "==> Rolling back systemd/nginx configuration"
  CONFIG_ROLLBACK_ATTEMPTED=true

  for (( index = ${#CONFIG_BACKUPS[@]} - 1; index >= 0; index-- )); do
    IFS='|' read -r kind target backup <<<"${CONFIG_BACKUPS[$index]}"
    if [[ "$kind" == "existing" ]]; then
      if ! sudo rm -rf -- "$target"; then
        echo "Failed to remove changed configuration target: $target" >&2
        restore_failed=true
        continue
      fi
      if ! sudo mkdir -p "$(dirname "$target")"; then
        echo "Failed to recreate configuration parent for: $target" >&2
        restore_failed=true
        continue
      fi
      if ! sudo cp -a "$backup" "$target"; then
        echo "Failed to restore configuration target: $target" >&2
        restore_failed=true
      fi
    else
      if ! sudo rm -rf -- "$target"; then
        echo "Failed to remove newly installed configuration target: $target" >&2
        restore_failed=true
      fi
    fi
  done

  if ! restart_services_after_restore; then
    restore_failed=true
  fi

  if [[ "$restore_failed" == "true" ]]; then
    return 1
  fi
}

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
  target="$SYSTEMD_UNIT_ROOT/$unit_file"

  if [[ ! -f "$template" ]]; then
    echo "Systemd template not found: $template" >&2
    exit 1
  fi

  rendered="$(mktemp)"
  render_systemd_template "$template" "$rendered"
  if sudo test -f "$target" && sudo cmp -s "$rendered" "$target"; then
    echo "==> Systemd unit unchanged: $unit_file"
    rm -f "$rendered"
    return
  fi
  backup_target "$target"
  sudo install -D -m 0644 "$rendered" "$target"
  rm -f "$rendered"
  INSTALLED_SYSTEMD_UNITS+=("$target")
  SYSTEMD_RELOAD_REQUIRED=true
}

remove_obsolete_primary_worker_dropins() {
  local unit_file
  local dropin
  local target

  unit_file="$(systemd_unit_file_name "$WORKER_SERVICE_NAME")"
  # This pre-topology drop-in replaced ExecStart with a hard-coded
  # concurrency=4 command. It bypasses the canonical launcher, queue
  # validation, environment concurrency, prefetch, and child recycling.
  for dropin in no-beat-queue.conf; do
    target="$SYSTEMD_UNIT_ROOT/${unit_file}.d/$dropin"
    if ! sudo test -e "$target" && ! sudo test -L "$target"; then
      continue
    fi
    echo "==> Removing obsolete primary-worker systemd drop-in: $target"
    backup_target "$target"
    sudo rm -f -- "$target"
    SYSTEMD_RELOAD_REQUIRED=true
  done
}

validate_primary_worker_launcher() {
  local expected
  local actual

  expected="$APP_ROOT/deploy/no-docker/scripts/run-celery-worker.sh"
  actual="$(
    sudo systemctl show "$WORKER_SERVICE_NAME" \
      --property=ExecStart \
      --value \
      --no-pager
  )"
  if [[ "$actual" != *"$expected"* ]]; then
    echo "Primary worker ExecStart bypasses the canonical launcher: $actual" >&2
    echo "Expected launcher: $expected" >&2
    exit 1
  fi
}

validate_systemd_units() {
  local unit_path

  for unit_path in "${INSTALLED_SYSTEMD_UNITS[@]}"; do
    sudo systemd-analyze verify "$unit_path"
  done
}

install_or_update_nginx_template() {
  local template="$APP_ROOT/deploy/no-docker/nginx/investor.conf"
  local available="$NGINX_CONFIG_ROOT/sites-available/investor.conf"
  local enabled="$NGINX_CONFIG_ROOT/sites-enabled/investor.conf"
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

  if ! sudo test -f "$available" || ! sudo cmp -s "$rendered" "$available"; then
    backup_target "$available"
    sudo install -D -m 0644 "$rendered" "$available"
    NGINX_RELOAD_REQUIRED="$enabled_preexisting"
  else
    echo "==> Nginx configuration unchanged"
  fi
  rm -f "$rendered"

  if [[ "$enabled_preexisting" == "true" ]]; then
    if [[ "$(sudo readlink -f "$enabled" 2>/dev/null || true)" != "$(sudo readlink -f "$available" 2>/dev/null || true)" ]]; then
      backup_target "$enabled"
      sudo ln -sfn "$available" "$enabled"
      NGINX_RELOAD_REQUIRED=true
    fi
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


ensure_swap_file() {
  local swapfile="${PROD_SWAP_FILE:-/swapfile}"
  local swap_size="${PROD_SWAP_SIZE:-2G}"

  if swapon --show=NAME --noheadings 2>/dev/null | awk '{print $1}' | grep -Fxq "$swapfile"; then
    echo "==> Swap already active at $swapfile"
    return
  fi

  if swapon --show --noheadings 2>/dev/null | grep -q .; then
    echo "==> Swap already active; leaving existing swap configuration unchanged"
    return
  fi

  echo "==> No active swap detected; creating $swap_size swapfile for memory-safe frontend installs"
  if [[ ! -f "$swapfile" ]]; then
    sudo fallocate -l "$swap_size" "$swapfile" || sudo dd if=/dev/zero of="$swapfile" bs=1M count=2048 status=none
  fi
  sudo chmod 600 "$swapfile"
  if ! sudo file "$swapfile" | grep -q 'swap file'; then
    sudo mkswap "$swapfile" >/dev/null
  fi
  sudo swapon "$swapfile"
}

handle_deploy_exit() {
  local status=$?
  local rollback_failed=false
  trap - EXIT
  set +e

  if (( status != 0 )); then
    echo "Deployment failed; applying scoped rollback protections." >&2
    if [[ "$FRONTEND_PROMOTED" == "true" ]]; then
      start_phase "frontend-rollback"
      if ! restore_previous_frontend_build; then
        rollback_failed=true
      fi
      finish_phase "frontend-rollback"
    fi
    if ! rollback_configuration; then
      rollback_failed=true
    fi
    if [[ "$FRONTEND_ROLLBACK_ATTEMPTED" == "true" ]]; then
      echo "==> Final verification of restored frontend after configuration rollback"
      if ! verify_restored_frontend_build; then
        rollback_failed=true
      else
        FRONTEND_PROMOTED=false
      fi
    elif [[ "$CONFIG_ROLLBACK_ATTEMPTED" == "true" && "$DEPLOY_FRONTEND" == "true" ]]; then
      echo "==> Verify unchanged active frontend after configuration rollback"
      if ! select_frontend_build_slots || ! verify_restored_frontend_build; then
        rollback_failed=true
      fi
    fi
    if [[ "$rollback_failed" == "true" ]]; then
      echo "CRITICAL: deployment failed and its rollback protections could not be fully verified." >&2
      status=2
    fi
  fi

  cleanup_config_backup_dir
  print_timing_summary
  exit "$status"
}
trap handle_deploy_exit EXIT

BACKEND_SERVICE_NAME=""
WORKER_SERVICE_NAME=""
AUTO_LIVE_WORKER_SERVICE_NAME=""
BEAT_SERVICE_NAME=""
BEAT_WORKER_SERVICE_NAME=""
FRONTEND_SERVICE_NAME=""

if [[ "$DEPLOY_BACKEND" == "true" ]]; then
  validate_no_duplicate_backend_service_families
  BACKEND_SERVICE_NAME="$(resolve_role_service_name backend)"
  WORKER_SERVICE_NAME="$(resolve_role_service_name celery-worker)"
  AUTO_LIVE_WORKER_SERVICE_NAME="$(resolve_role_service_name celery-auto-live-worker)"
  BEAT_SERVICE_NAME="$(resolve_role_service_name celery-beat)"
  BEAT_WORKER_SERVICE_NAME="$(resolve_role_service_name celery-beat-worker)"
fi
if [[ "$DEPLOY_FRONTEND" == "true" ]]; then
  FRONTEND_SERVICE_NAME="$(resolve_role_service_name frontend)"
fi

echo "==> Deploy scope: $SCOPE"
echo "==> App root: $APP_ROOT"
echo "==> App user: $APP_USER"
if [[ "$DEPLOY_BACKEND" == "true" ]]; then
  echo "==> Backend service: $BACKEND_SERVICE_NAME"
  echo "==> Worker service: $WORKER_SERVICE_NAME"
  echo "==> Auto-Live planning worker service: $AUTO_LIVE_WORKER_SERVICE_NAME"
  echo "==> Beat service: $BEAT_SERVICE_NAME"
  echo "==> Beat queue worker service: $BEAT_WORKER_SERVICE_NAME"
fi
if [[ "$DEPLOY_FRONTEND" == "true" ]]; then
  echo "==> Frontend service: $FRONTEND_SERVICE_NAME"
fi

start_phase "environment-validation"
if [[ "$DEPLOY_BACKEND" == "true" ]]; then
  validate_backend_env_file
  validate_canonical_bullpen_backend_env
  install_bullpen_cli_if_needed
fi
if [[ "$DEPLOY_FRONTEND" == "true" ]]; then
  validate_frontend_env_file
fi
finish_phase "environment-validation"

if [[ "$SKIP_GIT_SYNC" != "true" ]]; then
  start_phase "source-sync"
  echo "==> Pull latest code"
  run_as_app_user "
    cd '$APP_ROOT'
    git fetch origin main
    git reset --hard origin/main
  "
  finish_phase "source-sync"
fi

start_phase "configuration"
echo "==> Install/update scoped systemd templates"
if [[ "$DEPLOY_BACKEND" == "true" ]]; then
  install_systemd_unit "$BACKEND_SERVICE_NAME"
  install_systemd_unit "$WORKER_SERVICE_NAME"
  install_systemd_unit "$AUTO_LIVE_WORKER_SERVICE_NAME"
  install_systemd_unit "$BEAT_SERVICE_NAME"
  install_systemd_unit "$BEAT_WORKER_SERVICE_NAME"
  remove_obsolete_primary_worker_dropins
fi
if [[ "$DEPLOY_FRONTEND" == "true" ]]; then
  install_systemd_unit "$FRONTEND_SERVICE_NAME"
  echo "==> Install/update frontend nginx template when changed"
  install_or_update_nginx_template
fi

echo "==> Validate scoped configuration"
if [[ "$SYSTEMD_RELOAD_REQUIRED" == "true" ]]; then
  sudo systemctl daemon-reload
fi
if [[ "$DEPLOY_BACKEND" == "true" ]]; then
  validate_primary_worker_launcher
fi
validate_systemd_units
if [[ "$DEPLOY_FRONTEND" == "true" ]]; then
  sudo nginx -t
fi
finish_phase "configuration"

if [[ "$DEPLOY_FRONTEND" == "true" ]]; then
  start_phase "frontend-artifact-extraction"
  if [[ -z "$FRONTEND_ARTIFACT" && "$ALLOW_ON_HOST_FRONTEND_BUILD" == "true" ]]; then
    ensure_swap_file
  fi
  prepare_frontend_candidate_build
  finish_phase "frontend-artifact-extraction"
fi

if [[ "$DEPLOY_BACKEND" == "true" ]]; then
  start_phase "backend-dependencies-migrations"
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
  finish_phase "backend-dependencies-migrations"

  start_phase "backend-service-restart"
  echo "==> Restart backend and Celery services"
  sudo systemctl enable "$AUTO_LIVE_WORKER_SERVICE_NAME" "$BEAT_WORKER_SERVICE_NAME"
  sudo systemctl restart "$BACKEND_SERVICE_NAME" "$WORKER_SERVICE_NAME" "$AUTO_LIVE_WORKER_SERVICE_NAME" "$BEAT_SERVICE_NAME" "$BEAT_WORKER_SERVICE_NAME"
  verify_service_active "$BACKEND_SERVICE_NAME"
  verify_service_active "$WORKER_SERVICE_NAME"
  verify_service_active "$AUTO_LIVE_WORKER_SERVICE_NAME"
  verify_service_active "$BEAT_SERVICE_NAME"
  verify_service_active "$BEAT_WORKER_SERVICE_NAME"
  finish_phase "backend-service-restart"

  start_phase "backend-smoke-tests"
  smoke_check "backend live" "$BACKEND_LIVE_URL"
  smoke_check "backend ready" "$BACKEND_READY_URL"
  if [[ "$DEPLOY_FRONTEND" != "true" ]]; then
    smoke_check \
      "same-origin backend proxy" \
      "http://127.0.0.1:3000/backend-api/health/live"
  fi
  finish_phase "backend-smoke-tests"
fi

if [[ "$DEPLOY_FRONTEND" == "true" ]]; then
  start_phase "frontend-service-restart"
  echo "==> Promote frontend candidate and restart only the frontend service"
  promote_frontend_candidate_build
  sudo systemctl restart "$FRONTEND_SERVICE_NAME"
  if [[ "$NGINX_RELOAD_REQUIRED" == "true" ]]; then
    sudo systemctl reload nginx
  fi
  verify_service_active "$FRONTEND_SERVICE_NAME"
  finish_phase "frontend-service-restart"

  start_phase "frontend-fingerprint"
  verify_frontend_fingerprint
  finish_phase "frontend-fingerprint"

  start_phase "frontend-smoke-tests"
  smoke_check "frontend login" "$FRONTEND_SMOKE_URL"
  smoke_check_auth_payload \
    "frontend Auth.js CSRF route" \
    "http://127.0.0.1:3000/api/auth/csrf" \
    "csrf"
  smoke_check_auth_payload \
    "frontend Auth.js providers route" \
    "http://127.0.0.1:3000/api/auth/providers" \
    "providers"
  smoke_check_protected_frontend_route \
    "frontend console dashboard" \
    "$FRONTEND_CONSOLE_SMOKE_URL" \
    "/console/dashboard"
  smoke_check_protected_frontend_route \
    "frontend Bullpen AI console" \
    "$FRONTEND_BULLPEN_AI_SMOKE_URL" \
    "/console/bullpen-ai"
  smoke_check_frontend_static_asset
  smoke_check "same-origin backend proxy" "http://127.0.0.1:3000/backend-api/health/live"
  finish_phase "frontend-smoke-tests"
fi

echo "==> Service status"
if [[ "$DEPLOY_BACKEND" == "true" ]]; then
  sudo systemctl status "$BACKEND_SERVICE_NAME" --no-pager
  sudo systemctl status "$WORKER_SERVICE_NAME" --no-pager
  sudo systemctl status "$AUTO_LIVE_WORKER_SERVICE_NAME" --no-pager
  sudo systemctl status "$BEAT_SERVICE_NAME" --no-pager
  sudo systemctl status "$BEAT_WORKER_SERVICE_NAME" --no-pager
fi
if [[ "$DEPLOY_FRONTEND" == "true" ]]; then
  sudo systemctl status "$FRONTEND_SERVICE_NAME" --no-pager
  discard_previous_frontend_build
fi

CONFIG_ROLLBACK_ENABLED=false
echo "==> Deploy complete"
