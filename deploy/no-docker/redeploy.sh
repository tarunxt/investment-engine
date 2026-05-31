#!/usr/bin/env bash

set -euo pipefail

SCOPE="${1:-full}"
APP_ROOT="${APP_ROOT:-/srv/investor}"
APP_USER="${APP_USER:-investor}"
BACKEND_ENV_FILE="${BACKEND_ENV_FILE:-/etc/investor/backend.env}"
FRONTEND_ENV_FILE="${FRONTEND_ENV_FILE:-/etc/investor/frontend.env}"
SKIP_GIT_SYNC="${SKIP_GIT_SYNC:-false}"

case "$SCOPE" in
  backend|full)
    ;;
  *)
    echo "Usage: $0 [backend|full]" >&2
    exit 1
    ;;
esac

if [[ ! -d "$APP_ROOT" ]]; then
  echo "App root not found: $APP_ROOT" >&2
  exit 1
fi

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
  set -a
  # shellcheck disable=SC1090
  source "$FRONTEND_ENV_FILE"
  set +a

  validate_required_env_var "NEXTAUTH_URL"
  validate_required_env_var "NEXTAUTH_SECRET"

  if looks_like_placeholder_url "${NEXTAUTH_URL:-}"; then
    echo "NEXTAUTH_URL still uses a placeholder domain: $NEXTAUTH_URL" >&2
    exit 1
  fi

  if [[ -n "${NEXT_PUBLIC_FRONTEND_URL:-}" ]] && looks_like_placeholder_url "${NEXT_PUBLIC_FRONTEND_URL:-}"; then
    echo "NEXT_PUBLIC_FRONTEND_URL still uses a placeholder domain: $NEXT_PUBLIC_FRONTEND_URL" >&2
    exit 1
  fi

  if [[ -n "${NEXT_PUBLIC_API_URL:-}" ]] && looks_like_placeholder_url "${NEXT_PUBLIC_API_URL:-}"; then
    echo "NEXT_PUBLIC_API_URL still uses a placeholder domain: $NEXT_PUBLIC_API_URL" >&2
    exit 1
  fi

  echo "==> Frontend URL: ${NEXT_PUBLIC_FRONTEND_URL:-$NEXTAUTH_URL}"
  echo "==> Frontend API URL: ${NEXT_PUBLIC_API_URL:-<runtime inferred from browser host>}"
}

validate_backend_env_file() {
  set -a
  # shellcheck disable=SC1090
  source "$BACKEND_ENV_FILE"
  set +a

  validate_required_env_var "DATABASE_URL"
  validate_required_env_var "REDIS_URL"
  validate_required_env_var "FRONTEND_URL"

  if looks_like_placeholder_url "${FRONTEND_URL:-}"; then
    echo "FRONTEND_URL still uses a placeholder domain: $FRONTEND_URL" >&2
    exit 1
  fi
}

run_as_app_user() {
  sudo -u "$APP_USER" -H bash -lc "$1"
}

echo "==> Deploy scope: $SCOPE"
echo "==> App root: $APP_ROOT"
echo "==> App user: $APP_USER"

validate_backend_env_file
if [[ "$SCOPE" == "full" ]]; then
  validate_frontend_env_file
fi

if [[ "$SKIP_GIT_SYNC" != "true" ]]; then
  echo "==> Pull latest code"
  run_as_app_user "
    cd '$APP_ROOT'
    git fetch origin main
    git reset --hard origin/main
  "
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
    npm ci
    set -a
    source '$FRONTEND_ENV_FILE'
    set +a
    npm run build
  "
fi

echo "==> Restart services"
sudo systemctl restart investor-backend investor-celery-worker investor-celery-beat

if [[ "$SCOPE" == "full" ]]; then
  sudo systemctl restart investor-frontend
fi

echo "==> Service status"
sudo systemctl status investor-backend --no-pager
sudo systemctl status investor-celery-worker --no-pager
sudo systemctl status investor-celery-beat --no-pager

if [[ "$SCOPE" == "full" ]]; then
  sudo systemctl status investor-frontend --no-pager
fi

echo "==> Deploy complete"
