#!/usr/bin/env bash

set -euo pipefail

# The production web runtime intentionally runs Bullpen as the unprivileged
# `investor` service account. Operators, however, commonly authenticate the
# Bullpen CLI from the EC2 login account (`ubuntu`). If those two credential
# stores drift, `bullpen polymarket positions` works in an SSH shell while the
# web UI can only fall back to stale Stage 1/tracked-position data.
#
# This pre-start helper reconciles only the encrypted Bullpen credential/config
# artifacts. It never copies shell history, logs, lock files, or arbitrary home
# contents. It also refuses to switch the canonical runtime to a different
# wallet when both stores expose a wallet identity.

CANONICAL_USER="${CANONICAL_BULLPEN_RUNTIME_OWNER:-investor}"
OPERATOR_USER="${BULLPEN_OPERATOR_USER:-ubuntu}"
BULLPEN_BIN="${BULLPEN_BIN:-/usr/local/bin/bullpen}"
CANONICAL_HOME="${CANONICAL_BULLPEN_HOME:-/home/${CANONICAL_USER}}"
OPERATOR_HOME="${BULLPEN_OPERATOR_HOME:-/home/${OPERATOR_USER}}"
CANONICAL_STORE="${CANONICAL_BULLPEN_STORE:-${CANONICAL_HOME}/.bullpen}"
OPERATOR_STORE="${BULLPEN_OPERATOR_STORE:-${OPERATOR_HOME}/.bullpen}"
CANONICAL_CREDENTIALS="${CANONICAL_STORE}/credentials.json.enc"
OPERATOR_CREDENTIALS="${OPERATOR_STORE}/credentials.json.enc"
CANONICAL_CONFIG="${CANONICAL_STORE}/config.toml"
OPERATOR_CONFIG="${OPERATOR_STORE}/config.toml"

log() {
  printf 'bullpen-credential-sync: %s\n' "$*"
}

if [[ ! -x "$BULLPEN_BIN" ]]; then
  log "Bullpen binary is unavailable at $BULLPEN_BIN; skipping credential reconciliation."
  exit 0
fi

if ! id "$CANONICAL_USER" >/dev/null 2>&1; then
  log "Canonical user $CANONICAL_USER does not exist; skipping."
  exit 0
fi

if ! id "$OPERATOR_USER" >/dev/null 2>&1 || [[ ! -f "$OPERATOR_CREDENTIALS" ]]; then
  # Nothing to reconcile. The canonical account may have been authenticated
  # directly with `sudo -u investor -H bullpen login --no-browser`.
  exit 0
fi

read_wallet() {
  local user="$1"
  local home="$2"
  local store="$3"
  local config="$4"
  local payload

  payload="$(
    timeout 10s sudo -u "$user" -H env \
      HOME="$home" \
      BULLPEN_HOME="$store" \
      BULLPEN_CREDENTIALS_HOME="$store" \
      BULLPEN_CONFIG="$config" \
      BULLPEN_ENV=production \
      BULLPEN_NON_INTERACTIVE=true \
      "$BULLPEN_BIN" status --output json 2>/dev/null || true
  )"

  python3 - "$payload" <<'PY'
import json
import re
import sys

raw = sys.argv[1]
try:
    payload = json.loads(raw)
except Exception:
    raise SystemExit(0)

candidates = []
if isinstance(payload, dict):
    account = payload.get("account")
    health = payload.get("health")
    trading = payload.get("trading_access")
    if isinstance(account, dict):
        candidates.append(account.get("address"))
    if isinstance(health, dict):
        candidates.append(health.get("polymarket_address"))
    if isinstance(trading, dict):
        candidates.append(trading.get("deposit_wallet_address"))

for value in candidates:
    if isinstance(value, str) and re.fullmatch(r"0x[a-fA-F0-9]{40}", value.strip()):
        print(value.strip().lower())
        break
PY
}

operator_wallet="$(read_wallet "$OPERATOR_USER" "$OPERATOR_HOME" "$OPERATOR_STORE" "$OPERATOR_CONFIG")"
if [[ -z "$operator_wallet" ]]; then
  log "Operator credential store exists but did not expose a Polymarket wallet; leaving canonical credentials unchanged."
  exit 0
fi

canonical_wallet=""
if [[ -f "$CANONICAL_CREDENTIALS" ]]; then
  canonical_wallet="$(read_wallet "$CANONICAL_USER" "$CANONICAL_HOME" "$CANONICAL_STORE" "$CANONICAL_CONFIG")"
fi

if [[ -n "$canonical_wallet" && "$canonical_wallet" != "$operator_wallet" ]]; then
  log "Refusing to replace canonical wallet $canonical_wallet with different operator wallet $operator_wallet."
  exit 1
fi

# If the encrypted payload is already identical, no filesystem mutation is
# needed. Config may still be refreshed independently below.
credentials_changed=true
if [[ -f "$CANONICAL_CREDENTIALS" ]] && cmp -s "$OPERATOR_CREDENTIALS" "$CANONICAL_CREDENTIALS"; then
  credentials_changed=false
fi

install -d -o "$CANONICAL_USER" -g "$CANONICAL_USER" -m 0700 "$CANONICAL_STORE"

if [[ "$credentials_changed" == "true" ]]; then
  temp_credentials="${CANONICAL_CREDENTIALS}.sync.$$"
  install -o "$CANONICAL_USER" -g "$CANONICAL_USER" -m 0600 \
    "$OPERATOR_CREDENTIALS" "$temp_credentials"
  mv -f "$temp_credentials" "$CANONICAL_CREDENTIALS"
  chown "$CANONICAL_USER:$CANONICAL_USER" "$CANONICAL_CREDENTIALS"
  chmod 0600 "$CANONICAL_CREDENTIALS"
  log "Synchronized encrypted Bullpen credentials for wallet $operator_wallet into the canonical runtime."
fi

if [[ -f "$OPERATOR_CONFIG" ]]; then
  if [[ ! -f "$CANONICAL_CONFIG" ]] || ! cmp -s "$OPERATOR_CONFIG" "$CANONICAL_CONFIG"; then
    temp_config="${CANONICAL_CONFIG}.sync.$$"
    install -o "$CANONICAL_USER" -g "$CANONICAL_USER" -m 0600 \
      "$OPERATOR_CONFIG" "$temp_config"
    mv -f "$temp_config" "$CANONICAL_CONFIG"
    chown "$CANONICAL_USER:$CANONICAL_USER" "$CANONICAL_CONFIG"
    chmod 0600 "$CANONICAL_CONFIG"
    log "Synchronized Bullpen config.toml into the canonical runtime."
  fi
fi

# Validate that the canonical service account can now resolve the same wallet.
post_sync_wallet="$(read_wallet "$CANONICAL_USER" "$CANONICAL_HOME" "$CANONICAL_STORE" "$CANONICAL_CONFIG")"
if [[ "$post_sync_wallet" != "$operator_wallet" ]]; then
  log "Canonical Bullpen wallet verification failed after synchronization."
  exit 1
fi

exit 0
