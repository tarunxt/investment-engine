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

ensure_required_queue() {
  local configured="$1"
  local required="$2"
  local compact

  # Celery accepts a comma-separated queue list. Normalize whitespace first so
  # values such as "email, ai" are handled consistently.
  compact="${configured//[[:space:]]/}"

  case ",$compact," in
    *",$required,"*)
      printf '%s\n' "$compact"
      ;;
    *)
      echo "WARNING: CELERY_WORKER_QUEUES='${configured:-<unset>}' omits required queue '$required'; adding it so durable Stage 3 orders can execute." >&2
      if [[ -n "$compact" ]]; then
        printf '%s,%s\n' "$required" "$compact"
      else
        printf '%s\n' "$required"
      fi
      ;;
  esac
}

# Stage 3 order-intent execution and reconciliation are routed to ``ai``. A
# stale production override must never leave the service active while consuming
# only another queue, because that strands READY intents with attempt_count=0.
WORKER_QUEUES="$(ensure_required_queue "${CELERY_WORKER_QUEUES:-ai,email}" "ai")"
echo "Starting primary Celery worker on queues: $WORKER_QUEUES"

exec "$BACKEND_ROOT/.venv/bin/celery" \
  -A app.infrastructure.messaging.celery_app \
  worker \
  -Q "$WORKER_QUEUES" \
  --loglevel="${CELERY_LOG_LEVEL:-info}" \
  --concurrency="${CELERY_WORKER_CONCURRENCY:-2}" \
  --prefetch-multiplier="${CELERY_WORKER_PREFETCH_MULTIPLIER:-1}" \
  --max-tasks-per-child="${CELERY_MAX_TASKS_PER_CHILD:-1000}"
