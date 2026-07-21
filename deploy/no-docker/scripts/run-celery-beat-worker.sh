#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./runtime-common.sh
source "$SCRIPT_DIR/runtime-common.sh"

APP_ROOT="$(resolve_app_root)"
BACKEND_ROOT="$APP_ROOT/backend"

ensure_single_backend_service_family_active
validate_canonical_bullpen_runtime_env

cd "$BACKEND_ROOT"

exec "$BACKEND_ROOT/.venv/bin/celery" \
  -A app.infrastructure.messaging.celery_app \
  worker \
  -n "beat-worker@%h" \
  -Q "${CELERY_BEAT_WORKER_QUEUE:-beat}" \
  --loglevel="${CELERY_LOG_LEVEL:-info}" \
  --concurrency=1 \
  --prefetch-multiplier="${CELERY_BEAT_WORKER_PREFETCH_MULTIPLIER:-1}" \
  --max-tasks-per-child="${CELERY_MAX_TASKS_PER_CHILD:-1000}"
