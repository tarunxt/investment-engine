#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./runtime-common.sh
source "$SCRIPT_DIR/runtime-common.sh"

APP_ROOT="$(resolve_app_root)"
FRONTEND_ROOT="$APP_ROOT/frontend"

cd "$FRONTEND_ROOT"

exec "$FRONTEND_ROOT/node_modules/.bin/next" \
  start \
  -H "${FRONTEND_HOST:-127.0.0.1}" \
  -p "${FRONTEND_PORT:-3000}"
