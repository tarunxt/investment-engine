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

exec "$BACKEND_ROOT/.venv/bin/uvicorn" \
  app.main:app \
  --host "${UVICORN_HOST:-127.0.0.1}" \
  --port "${UVICORN_PORT:-8000}" \
  --workers "${UVICORN_WORKERS:-2}" \
  --timeout-keep-alive "${UVICORN_TIMEOUT_KEEP_ALIVE:-5}" \
  --timeout-graceful-shutdown "${UVICORN_TIMEOUT_GRACEFUL_SHUTDOWN:-30}"
