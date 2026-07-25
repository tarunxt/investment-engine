#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./runtime-common.sh
source "$SCRIPT_DIR/runtime-common.sh"

APP_ROOT="$(resolve_app_root)"
BACKEND_ROOT="$APP_ROOT/backend"

if [[ "${CELERY_WORKER_QUEUES+x}" == "x" ]]; then
  CONFIGURED_CELERY_WORKER_QUEUES="$CELERY_WORKER_QUEUES"
else
  CONFIGURED_CELERY_WORKER_QUEUES="ai,email"
fi
EFFECTIVE_CELERY_WORKER_QUEUES="$(
  primary_celery_worker_effective_queues "$CONFIGURED_CELERY_WORKER_QUEUES"
)"

ensure_single_backend_service_family_active
validate_canonical_bullpen_runtime_env

cd "$BACKEND_ROOT"

printf '%s\n' \
  "Investor primary Celery worker effective queue list: $EFFECTIVE_CELERY_WORKER_QUEUES"

exec "$BACKEND_ROOT/.venv/bin/celery" \
  -A app.infrastructure.messaging.celery_app \
  worker \
  -Q "$EFFECTIVE_CELERY_WORKER_QUEUES" \
  --loglevel="${CELERY_LOG_LEVEL:-info}" \
  --concurrency="${CELERY_WORKER_CONCURRENCY:-2}" \
  --prefetch-multiplier="${CELERY_WORKER_PREFETCH_MULTIPLIER:-1}" \
  --max-tasks-per-child="${CELERY_WORKER_MAX_TASKS_PER_CHILD:-${CELERY_MAX_TASKS_PER_CHILD:-25}}" \
  --max-memory-per-child="${CELERY_WORKER_MAX_MEMORY_PER_CHILD_KB:-800000}"
