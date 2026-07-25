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

# Keep Stage 1/2 planning separate from long Stage 3 remote reconciliation.
# One process is intentional: run-level Redis leases still fence redelivery,
# while no queue backlog can occupy the planning pool before a run begins.
exec "$BACKEND_ROOT/.venv/bin/celery" \
  -A app.infrastructure.messaging.celery_app \
  worker \
  -n "auto-live-worker@%h" \
  -Q "${CELERY_AUTO_LIVE_WORKER_QUEUE:-auto_live}" \
  --loglevel="${CELERY_LOG_LEVEL:-info}" \
  --concurrency="${CELERY_AUTO_LIVE_WORKER_CONCURRENCY:-1}" \
  --prefetch-multiplier="${CELERY_AUTO_LIVE_WORKER_PREFETCH_MULTIPLIER:-${CELERY_WORKER_PREFETCH_MULTIPLIER:-1}}" \
  --max-tasks-per-child="${CELERY_AUTO_LIVE_MAX_TASKS_PER_CHILD:-1}"
