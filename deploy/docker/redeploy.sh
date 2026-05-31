#!/usr/bin/env bash

set -euo pipefail

SCOPE="${1:-full}"
APP_ROOT="${APP_ROOT:-$(pwd)}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_ROOT/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-$APP_ROOT/.env.prod}"
SKIP_GIT_SYNC="${SKIP_GIT_SYNC:-false}"

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "Compose file not found: $COMPOSE_FILE" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Env file not found: $ENV_FILE" >&2
  exit 1
fi

case "$SCOPE" in
  backend|full)
    ;;
  *)
    echo "Usage: $0 [backend|full]" >&2
    exit 1
    ;;
esac

compose() {
  docker compose --parallel 1 -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

echo "==> Deploy scope: $SCOPE"
echo "==> App root: $APP_ROOT"

cd "$APP_ROOT"

if [[ "$SKIP_GIT_SYNC" != "true" ]]; then
  echo "==> Pull latest code"
  git fetch origin main
  git reset --hard origin/main
fi

echo "==> Ensure swap exists"
if ! swapon --show | grep -q swapfile; then
  sudo fallocate -l 2G /swapfile || true
  sudo chmod 600 /swapfile || true
  sudo mkswap /swapfile || true
  sudo swapon /swapfile || true
fi

echo "==> Build images"
if [[ "$SCOPE" == "backend" ]]; then
  compose build backend celery_worker celery_beat
else
  compose build backend frontend celery_worker celery_beat
fi

echo "==> Start/update services"
if [[ "$SCOPE" == "backend" ]]; then
  compose up -d --no-deps backend celery_worker celery_beat
else
  compose up -d --remove-orphans
fi

echo "==> Run migrations"
compose exec -T backend alembic upgrade head

echo "==> Wait for services"
sleep 15

echo "==> Container status"
if [[ "$SCOPE" == "backend" ]]; then
  compose ps backend celery_worker celery_beat
else
  compose ps
fi

echo "==> Cleanup unused images"
docker image prune -af || true

echo "==> Deploy complete"
