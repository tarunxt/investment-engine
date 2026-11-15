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
  beat \
  --loglevel="${CELERY_LOG_LEVEL:-info}"
