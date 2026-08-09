#!/usr/bin/env bash

set -euo pipefail

# The operator normally authenticates Bullpen from the EC2 `ubuntu` account,
# while the web backend runs as `investor`.  A Bullpen session can therefore be
# healthy in the SSH shell while the web process has no current positions
# snapshot.  Do not copy encrypted credentials between Unix accounts: those
# artifacts are not guaranteed to be portable.  Instead, bridge only public,
# read-only wallet evidence into the centralized runtime cache.
#
# Safety contract:
# - the operator wallet address and positions payload are public/read-only;
# - the display LKG is always safe to seed;
# - the execution snapshot is seeded only when the canonical service account
#   resolves the exact same wallet AND its existing active-auth verdict is
#   healthy; otherwise execution state is left untouched;
# - this helper never prevents the backend from starting merely because the
#   operator CLI is unavailable.

CANONICAL_USER="${CANONICAL_BULLPEN_RUNTIME_OWNER:-investor}"
OPERATOR_USER="${BULLPEN_OPERATOR_USER:-ubuntu}"
BULLPEN_BIN="${BULLPEN_BIN:-/usr/local/bin/bullpen}"
CANONICAL_HOME="${CANONICAL_BULLPEN_HOME:-/home/${CANONICAL_USER}}"
OPERATOR_HOME="${BULLPEN_OPERATOR_HOME:-/home/${OPERATOR_USER}}"
CANONICAL_STORE="${CANONICAL_BULLPEN_STORE:-${CANONICAL_HOME}/.bullpen}"
OPERATOR_STORE="${BULLPEN_OPERATOR_STORE:-${OPERATOR_HOME}/.bullpen}"
CANONICAL_CONFIG="${CANONICAL_STORE}/config.toml"
OPERATOR_CONFIG="${OPERATOR_STORE}/config.toml"
APP_ROOT="${APP_ROOT:-/srv/investor}"
BACKEND_PYTHON="${BACKEND_PYTHON:-${APP_ROOT}/backend/.venv/bin/python}"

log() {
  printf 'bullpen-wallet-bridge: %s\n' "$*"
}

if [[ ! -x "$BULLPEN_BIN" || ! -x "$BACKEND_PYTHON" ]]; then
  log "Bullpen CLI or backend Python is unavailable; leaving runtime state unchanged."
  exit 0
fi

if ! id "$OPERATOR_USER" >/dev/null 2>&1 || ! id "$CANONICAL_USER" >/dev/null 2>&1; then
  log "Operator/canonical Unix account is unavailable; leaving runtime state unchanged."
  exit 0
fi

run_bullpen() {
  local user="$1"
  local home="$2"
  local store="$3"
  local config="$4"
  shift 4
  timeout 45s sudo -u "$user" -H env \
    HOME="$home" \
    BULLPEN_HOME="$store" \
    BULLPEN_CREDENTIALS_HOME="$store" \
    BULLPEN_CONFIG="$config" \
    BULLPEN_ENV=production \
    BULLPEN_NON_INTERACTIVE=true \
    "$BULLPEN_BIN" "$@"
}

extract_wallet() {
  "$BACKEND_PYTHON" -c '
import json,re,sys
try:
    p=json.load(sys.stdin)
except Exception:
    raise SystemExit(0)
vals=[]
if isinstance(p,dict):
    for parent,key in (("account","address"),("health","polymarket_address"),("trading_access","deposit_wallet_address")):
        obj=p.get(parent)
        if isinstance(obj,dict): vals.append(obj.get(key))
for v in vals:
    if isinstance(v,str) and re.fullmatch(r"0x[a-fA-F0-9]{40}",v.strip()):
        print(v.strip().lower()); break
'
}

operator_status="$(run_bullpen "$OPERATOR_USER" "$OPERATOR_HOME" "$OPERATOR_STORE" "$OPERATOR_CONFIG" status --output json 2>/dev/null || true)"
operator_wallet="$(printf '%s' "$operator_status" | extract_wallet)"
if [[ -z "$operator_wallet" ]]; then
  log "Operator Bullpen status did not expose a wallet; leaving runtime state unchanged."
  exit 0
fi

operator_positions="$(run_bullpen "$OPERATOR_USER" "$OPERATOR_HOME" "$OPERATOR_STORE" "$OPERATOR_CONFIG" polymarket positions --output json 2>/dev/null || true)"
if ! printf '%s' "$operator_positions" | "$BACKEND_PYTHON" -c '
import json,sys
try: p=json.load(sys.stdin)
except Exception: raise SystemExit(1)
raise SystemExit(0 if isinstance(p,dict) and isinstance(p.get("positions"),list) else 1)
'; then
  log "Operator Bullpen positions read was unavailable; leaving runtime state unchanged."
  exit 0
fi

canonical_status="$(run_bullpen "$CANONICAL_USER" "$CANONICAL_HOME" "$CANONICAL_STORE" "$CANONICAL_CONFIG" status --output json 2>/dev/null || true)"
canonical_wallet="$(printf '%s' "$canonical_status" | extract_wallet)"

# Persist the operator payload to temporary files rather than command-line
# arguments, so large JSON cannot hit argv limits and never appears in logs.
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
printf '%s' "$operator_positions" >"$tmp_dir/positions.json"
printf '%s' "$operator_wallet" >"$tmp_dir/operator-wallet.txt"
printf '%s' "$canonical_wallet" >"$tmp_dir/canonical-wallet.txt"
chmod 0600 "$tmp_dir"/*

# Seed the display LKG and, only under strict same-wallet + healthy-auth proof,
# the execution snapshot.  Also attach the public wallet identity to any
# existing active-auth result so the UI public fallback can resolve it quickly.
PYTHONPATH="${APP_ROOT}/backend" \
  "$BACKEND_PYTHON" - "$tmp_dir/positions.json" "$tmp_dir/operator-wallet.txt" "$tmp_dir/canonical-wallet.txt" <<'PY'
import asyncio
import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path

import redis.asyncio as aioredis

from app.domains.polymarket import runtime_broker as rb

positions_path, operator_wallet_path, canonical_wallet_path = sys.argv[1:4]
payload = json.loads(Path(positions_path).read_text())
operator_wallet = Path(operator_wallet_path).read_text().strip().lower()
canonical_wallet = Path(canonical_wallet_path).read_text().strip().lower() or None


def credential_artifact() -> rb.BullpenCredentialArtifact:
    path = Path('/home/investor/.bullpen/credentials.json.enc')
    try:
        st = path.stat()
    except OSError:
        return rb.BullpenCredentialArtifact(path=str(path))
    return rb.BullpenCredentialArtifact(
        path=str(path),
        inode=st.st_ino,
        mtime=st.st_mtime,
        mtime_ns=st.st_mtime_ns,
        size=st.st_size,
    )


async def main() -> None:
    redis_url = os.environ.get('REDIS_URL')
    if not redis_url:
        print('bullpen-wallet-bridge: REDIS_URL is unavailable; cache bridge skipped.')
        return
    client = aioredis.from_url(redis_url, decode_responses=True)
    try:
        raw_active = await client.get(rb._ACTIVE_AUTH_RESULT_KEY)
        active = None
        if raw_active:
            try:
                active = rb.BullpenRuntimeActiveAuthResult.model_validate_json(raw_active)
            except Exception:
                active = None

        if active is not None and active.account_identity:
            existing = active.account_identity.strip().lower()
            if existing and existing != operator_wallet:
                print(
                    'bullpen-wallet-bridge: existing active-auth wallet differs from '
                    'operator wallet; refusing to alter runtime wallet identity.'
                )
                return

        artifact = credential_artifact()
        now = datetime.now(UTC).isoformat()
        diagnostics = rb.BullpenCommandDiagnostics(
            command_category='positions',
            pid=os.getpid(),
            unix_user='ubuntu',
            effective_home='/home/ubuntu',
            credential_artifact=artifact,
            cache_status='bypass',
            refresh_requested_at=now,
            caller_source='operator-wallet-bridge',
            snapshot_producer_source='operator-cli-display-bridge',
            produced_by_another_refresh=True,
        )
        snapshot = rb.BullpenPositionsSnapshot(
            payload=payload,
            fetched_at=now,
            cli_version=None,
            credential_artifact=artifact,
            account_identity=operator_wallet,
            position_classifier_version=rb.BULLPEN_POSITION_CLASSIFIER_VERSION,
            auth_checked_at=(active.auth_checked_at if active and active.healthy else None),
            source='redis-cache',
            freshness_state='cached',
            diagnostics=diagnostics,
        )
        serialized = snapshot.model_dump_json()
        await client.set(
            rb._POSITIONS_DISPLAY_LKG_KEY,
            serialized,
            ex=rb._POSITIONS_DISPLAY_LKG_TTL_SECONDS,
        )

        if active is not None:
            active = active.model_copy(update={'account_identity': operator_wallet})
            await client.set(
                rb._ACTIVE_AUTH_RESULT_KEY,
                active.model_dump_json(),
                ex=rb._ACTIVE_AUTH_RESULT_TTL_SECONDS,
            )
        else:
            identity_only = rb.BullpenRuntimeActiveAuthResult(
                checked_at=now,
                healthy=False,
                login_required=False,
                doctor_refresh_succeeded=False,
                credentials_valid=None,
                refresh_succeeded=None,
                token_valid=None,
                trade_auth_blocked=None,
                requires_login=None,
                wallet_ready=None,
                failure_reason='Wallet identity observed from operator Bullpen status; active trade auth not verified.',
                error_classification='auth_not_verified',
                account_identity=operator_wallet,
                credential_artifact=artifact,
            )
            await client.set(
                rb._ACTIVE_AUTH_RESULT_KEY,
                identity_only.model_dump_json(),
                ex=rb._ACTIVE_AUTH_RESULT_TTL_SECONDS,
            )

        active_count = len(payload.get('positions') or [])
        print(
            f'bullpen-wallet-bridge: display snapshot seeded for {operator_wallet} '
            f'({active_count} position rows).'
        )

        # Execution cache promotion is allowed only when the canonical Bullpen
        # status independently resolves the same wallet and the canonical
        # active-auth proof is already healthy.  No auth health is invented.
        if (
            active is not None
            and active.healthy
            and canonical_wallet == operator_wallet
        ):
            execution_snapshot = snapshot.model_copy(
                update={
                    'auth_checked_at': active.auth_checked_at or active.checked_at,
                    'diagnostics': diagnostics.model_copy(
                        update={'snapshot_producer_source': 'same-wallet-operator-read'}
                    ),
                }
            )
            await client.set(
                rb._POSITIONS_SNAPSHOT_KEY,
                execution_snapshot.model_dump_json(),
                ex=rb._POSITIONS_SNAPSHOT_TTL_SECONDS,
            )
            print(
                'bullpen-wallet-bridge: same-wallet healthy canonical auth verified; '
                'shared positions snapshot seeded.'
            )
        else:
            print(
                'bullpen-wallet-bridge: execution snapshot not promoted; '
                'canonical same-wallet healthy auth was not proven.'
            )
    finally:
        await client.aclose()


asyncio.run(main())
PY

# Never block application startup because this is a read-only display bridge.
exit 0
