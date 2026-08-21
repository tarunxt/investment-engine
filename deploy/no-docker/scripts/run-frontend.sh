#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./runtime-common.sh
source "$SCRIPT_DIR/runtime-common.sh"

APP_ROOT="$(resolve_app_root)"
FRONTEND_ROOT="$APP_ROOT/frontend"

cd "$FRONTEND_ROOT"

LAUNCH_TARGET="$(
  node "$APP_ROOT/deploy/no-docker/frontend-artifact.mjs" \
    resolve-launch \
    "$FRONTEND_ROOT"
)"
IFS=$'\t' read -r LAUNCH_KIND ACTIVE_RUNTIME_ROOT ACTIVE_BUILD_DIRECTORY \
  <<<"$LAUNCH_TARGET"

case "$LAUNCH_KIND" in
  standalone-slot|standalone-root-recovery)
    if [[ "$LAUNCH_KIND" == "standalone-root-recovery" ]]; then
      echo "Using validated root standalone runtime for pointerless migration recovery." >&2
    fi
    cd "$ACTIVE_RUNTIME_ROOT"
    # A standalone artifact always owns an internal .next directory. Do not
    # leak the outer blue/green slot name into its embedded Next.js config.
    unset NEXT_DIST_DIR
    exec env \
      HOSTNAME="${FRONTEND_HOST:-127.0.0.1}" \
      PORT="${FRONTEND_PORT:-3000}" \
      node "$ACTIVE_RUNTIME_ROOT/server.js"
    ;;
  legacy-slot)
    export NEXT_DIST_DIR="$ACTIVE_BUILD_DIRECTORY"
    exec "$FRONTEND_ROOT/node_modules/.bin/next" \
      start \
      -H "${FRONTEND_HOST:-127.0.0.1}" \
      -p "${FRONTEND_PORT:-3000}"
    ;;
  *)
    echo "Invalid frontend launch target: ${LAUNCH_KIND:-<empty>}" >&2
    exit 1
    ;;
esac
