#!/usr/bin/env bash
# Future approved dedicated host only; never flush the host ruleset.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for account in credx-uat2-app credx-uat2-web credx-uat2-db credx-uat2-redis; do id "$account" >/dev/null; done
{
  if /usr/sbin/nft list table inet credx_uat2 >/dev/null 2>&1; then
    echo 'flush table inet credx_uat2'
  fi
  cat "$HERE/network.nft"
} | /usr/sbin/nft -f -
