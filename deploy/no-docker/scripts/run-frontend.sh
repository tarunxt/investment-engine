#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./runtime-common.sh
source "$SCRIPT_DIR/runtime-common.sh"

APP_ROOT="$(resolve_app_root)"
FRONTEND_ROOT="$APP_ROOT/frontend"
ACTIVE_BUILD_POINTER="$FRONTEND_ROOT/.next-active-dir"

cd "$FRONTEND_ROOT"

ACTIVE_BUILD_DIRECTORY="${NEXT_DIST_DIR:-.next}"
if [[ -f "$ACTIVE_BUILD_POINTER" ]]; then
  ACTIVE_BUILD_DIRECTORY="$(tr -d '\r\n' < "$ACTIVE_BUILD_POINTER")"
fi
case "$ACTIVE_BUILD_DIRECTORY" in
  .next|.next-candidate)
    ;;
  *)
    echo "Invalid active Next build directory: ${ACTIVE_BUILD_DIRECTORY:-<empty>}" >&2
    exit 1
    ;;
esac

ACTIVE_RUNTIME_ROOT="$FRONTEND_ROOT/$ACTIVE_BUILD_DIRECTORY"
if [[ -f "$ACTIVE_RUNTIME_ROOT/server.js" ]]; then
  cd "$ACTIVE_RUNTIME_ROOT"
  # The standalone artifact always owns an internal .next directory. Do not
  # leak the outer blue/green slot name into its embedded Next.js config.
  unset NEXT_DIST_DIR
  exec env \
    HOSTNAME="${FRONTEND_HOST:-127.0.0.1}" \
    PORT="${FRONTEND_PORT:-3000}" \
    node "$ACTIVE_RUNTIME_ROOT/server.js"
fi

export NEXT_DIST_DIR="$ACTIVE_BUILD_DIRECTORY"
exec "$FRONTEND_ROOT/node_modules/.bin/next" \
  start \
  -H "${FRONTEND_HOST:-127.0.0.1}" \
  -p "${FRONTEND_PORT:-3000}"
