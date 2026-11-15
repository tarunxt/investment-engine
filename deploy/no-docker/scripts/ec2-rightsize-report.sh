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
  echo "Would read EC2 metadata plus 7-day CloudWatch CPU and CPU credit metrics, then print a conservative right-size signal."
  "$PYTHON_BIN" "$SCRIPT_DIR/aws-readonly-report.py" ec2-rightsize --dry-run
  exit 0
fi

print_section "EC2 Right-Size Report"
"$PYTHON_BIN" "$SCRIPT_DIR/aws-readonly-report.py" ec2-rightsize
