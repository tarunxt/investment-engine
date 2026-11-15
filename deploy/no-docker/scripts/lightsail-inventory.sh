#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./runtime-common.sh
source "$SCRIPT_DIR/runtime-common.sh"

DRY_RUN="${1:-}"
APP_ROOT="$(resolve_app_root)"
PYTHON_BIN="$(python_bin_for_app "$APP_ROOT")"

if [[ "$DRY_RUN" == "--dry-run" ]]; then
  print_section "Dry Run"
  echo "Would list Lightsail instances, static IPs, disks, and snapshots with read-only AWS API calls."
  "$PYTHON_BIN" "$SCRIPT_DIR/aws-readonly-report.py" lightsail-inventory --dry-run
  exit 0
fi

print_section "Lightsail Inventory"
"$PYTHON_BIN" "$SCRIPT_DIR/aws-readonly-report.py" lightsail-inventory
