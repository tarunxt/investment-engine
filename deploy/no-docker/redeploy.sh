#!/usr/bin/env bash

set -euo pipefail

SCOPE="${1:-full}"
APP_ROOT="${APP_ROOT:-/srv/investor}"
APP_USER="${APP_USER:-investor}"
BACKEND_ENV_FILE="${BACKEND_ENV_FILE:-/etc/investor/backend.env}"
FRONTEND_ENV_FILE="${FRONTEND_ENV_FILE:-/etc/investor/frontend.env}"
SKIP_GIT_SYNC="${SKIP_GIT_SYNC:-false}"
BULLPEN_VERSION="${BULLPEN_VERSION:-0.1.101}"
BACKEND_LIVE_URL="${BACKEND_LIVE_URL:-http://127.0.0.1:8000/health/live}"
BACKEND_READY_URL="${BACKEND_READY_URL:-http://127.0.0.1:8000/health/ready}"
FRONTEND_SMOKE_URL="${FRONTEND_SMOKE_URL:-http://127.0.0.1:3000/login}"
SMOKE_TIMEOUT_SECONDS="${SMOKE_TIMEOUT_SECONDS:-20}"

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

run_as_app_user() {
  sudo -u "$APP_USER" -H bash -lc "$1"
}

smoke_check() {
  local label="$1"
  local url="$2"

  echo "==> Smoke check: $label ($url)"
  curl --fail --silent --show-error --location --max-time "$SMOKE_TIMEOUT_SECONDS" "$url" >/dev/null
}

install_bullpen_cli_if_needed() {
  local bullpen_bin
  bullpen_bin="$(
    run_as_app_user "
      set -euo pipefail
      set -a
      source '$BACKEND_ENV_FILE'
      set +a
      printf '%s' "\${BULLPEN_BIN:-/usr/local/bin/bullpen}"
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
  local install_dir
  install_dir="$(dirname "$bullpen_bin")"
  local installer
  installer="$(mktemp)"
  curl -fsSL https://cli.bullpen.fi/install.sh -o "$installer"
  chmod +x "$installer"
  sudo mkdir -p "$install_dir"
  sudo env BULLPEN_VERSION="$BULLPEN_VERSION" BULLPEN_INSTALL_DIR="$install_dir" "$installer"
  rm -f "$installer"

  if [[ ! -x "$bullpen_bin" ]]; then
    local discovered_bin=""
    local candidate
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

echo "==> Deploy scope: $SCOPE"
echo "==> App root: $APP_ROOT"
echo "==> App user: $APP_USER"

validate_backend_env_file
install_bullpen_cli_if_needed
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
sudo systemctl daemon-reload
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

echo "==> Smoke checks"
smoke_check "backend live" "$BACKEND_LIVE_URL"
smoke_check "backend ready" "$BACKEND_READY_URL"

if [[ "$SCOPE" == "full" ]]; then
  smoke_check "frontend login" "$FRONTEND_SMOKE_URL"
fi

echo "==> Deploy complete"
