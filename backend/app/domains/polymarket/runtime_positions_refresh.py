from __future__ import annotations

import json
import os
import re
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlencode

import httpx

from app.domains.polymarket import runtime_broker as runtime_broker_module


# These callers are presentation-only portfolio reads. They must all resolve the
# same wallet display snapshot. Execution/Stage-3 callers intentionally do not
# appear here and continue to use the authenticated execution snapshot.
_MANUAL_UI_POSITION_REFRESH_CALLERS = frozenset(
    {
        "ui-history-portfolio-refresh",
        "ui-manual-refresh",
        "ui-portfolio-refresh",
    }
)
_PASSIVE_UI_POSITION_REFRESH_CALLERS = frozenset(
    {
        "ui-history-portfolio-load",
        "ui-passive-refresh",
    }
)
# Stage 1 needs the current economic portfolio for analysis even when the
# service-account execution snapshot is temporarily empty while the operator/
# public wallet still has live holdings. These callers may use same-wallet
# public evidence for Stage 1/2 analysis only. The returned snapshot remains
# display-only (no auth lineage and never promoted to the execution cache), so
# Stage 3 still fails closed until the authenticated runtime agrees.
_STAGE1_ANALYSIS_POSITION_REFRESH_CALLERS = frozenset(
    {
        "auto-live-stage1",
        "auto-live-stage1-recovery",
    }
)

_ORIGINAL_GET_POSITIONS_SNAPSHOT = (
    runtime_broker_module.BullpenRuntimeBroker.get_positions_snapshot
)
_INSTALLED = False

_POLYMARKET_DATA_API_BASE_URL = "https://data-api.polymarket.com"
_POLYMARKET_DATA_API_TIMEOUT_SECONDS = 10
_POLYMARKET_HTTP_HEADERS = {"User-Agent": "investment-engine-bullpen-portfolio/2.0"}
_POLYGON_RPC_URLS = (
    "https://polygon-rpc.com",
    "https://polygon-bor-rpc.publicnode.com",
    "https://polygon.drpc.org",
    "https://polygon-rpc.publicnode.com",
)
_POLYMARKET_PUSD_TOKEN_ADDRESS = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB"
_POLYMARKET_PUSD_DECIMALS = 1_000_000
_WALLET_ADDRESS_RE = re.compile(r"^0x[a-fA-F0-9]{40}$")
_PUBLIC_POSITION_PAGE_SIZE = 500
_PUBLIC_POSITION_MAX_PAGES = 4
_VALUE_EPSILON = 0.000001
# The display wallet address is public/read-only identity, not an auth token.
# Keep it independently of the 24-hour display/auth LKGs so a UI refresh can
# still rebuild the current wallet after those caches expire.
_DISPLAY_WALLET_IDENTITY_KEY = (
    f"{runtime_broker_module._REDIS_PREFIX}:positions:display-wallet-identity"
)


def _read_number(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        parsed = float(value)
        return parsed if parsed == parsed else None
    if isinstance(value, str) and value.strip():
        try:
            return float(value.replace(",", "").strip())
        except ValueError:
            return None
    return None


def _read_bool(value: object) -> bool | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value != 0
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "y"}:
            return True
        if normalized in {"0", "false", "no", "n"}:
            return False
    return None


def _first_value(row: dict[str, Any], *keys: str) -> object | None:
    for key in keys:
        if key in row and row[key] is not None:
            return row[key]
    return None


def _normalize_wallet_address(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    if not _WALLET_ADDRESS_RE.fullmatch(normalized):
        return None
    return normalized.lower()


async def _read_persisted_display_wallet_identity(
    broker: runtime_broker_module.BullpenRuntimeBroker,
) -> str | None:
    try:
        raw_wallet = await broker._redis.get(_DISPLAY_WALLET_IDENTITY_KEY)
    except Exception:
        return None
    return _normalize_wallet_address(raw_wallet)


async def _persist_display_wallet_identity(
    broker: runtime_broker_module.BullpenRuntimeBroker,
    wallet: object,
) -> str | None:
    normalized = _normalize_wallet_address(wallet)
    if normalized is None:
        return None
    try:
        # Deliberately no TTL. This is only a public wallet address and exists
        # solely to make current read-only portfolio reconstruction durable.
        await broker._redis.set(_DISPLAY_WALLET_IDENTITY_KEY, normalized)
    except Exception:
        # A Redis write failure must not make an otherwise valid wallet read fail.
        pass
    return normalized


def _collect_rows(payload: object) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    if not isinstance(payload, dict):
        return []
    for key in ("positions", "data", "rows", "results"):
        nested = payload.get(key)
        if isinstance(nested, list):
            return [row for row in nested if isinstance(row, dict)]
    return []


def _normalize_public_position(row: dict[str, Any]) -> dict[str, Any] | None:
    shares = _read_number(_first_value(row, "size", "shares")) or 0.0
    current_value = _read_number(
        _first_value(row, "currentValue", "current_value", "value")
    )
    redeemable = bool(
        _read_bool(
            _first_value(row, "redeemable", "isRedeemable", "is_redeemable")
        )
    )
    if shares <= _VALUE_EPSILON and not (
        redeemable and (current_value or 0.0) > _VALUE_EPSILON
    ):
        return None

    avg_price = _read_number(_first_value(row, "avgPrice", "avg_price"))
    current_price = _read_number(
        _first_value(row, "curPrice", "currentPrice", "current_price")
    )
    invested = _read_number(
        _first_value(
            row,
            "initialValue",
            "initial_value",
            "investedUsd",
            "invested_usd",
        )
    )
    unrealized_pnl = _read_number(
        _first_value(
            row,
            "cashPnl",
            "cash_pnl",
            "unrealizedPnl",
            "unrealized_pnl",
        )
    )
    pnl_percent = _read_number(
        _first_value(
            row,
            "percentPnl",
            "percent_pnl",
            "pnlPercent",
            "pnl_percent",
        )
    )
    condition_id = _first_value(row, "conditionId", "condition_id")
    event_slug = _first_value(row, "eventSlug", "event_slug")
    market = _first_value(row, "title", "market", "question")
    outcome = _first_value(row, "outcome", "side")
    slug = _first_value(row, "slug", "marketSlug", "market_slug")
    end_date = _first_value(row, "endDate", "end_date")
    icon = _first_value(row, "icon", "image")
    asset = _first_value(
        row,
        "asset",
        "assetId",
        "asset_id",
        "tokenId",
        "token_id",
    )

    expected_payout = max(0.0, current_value or 0.0) if redeemable else 0.0
    return {
        "asset": str(asset) if asset is not None else None,
        "avg_price": avg_price,
        "condition_id": str(condition_id) if condition_id is not None else None,
        "current_price": current_price,
        "current_value": current_value,
        "end_date": str(end_date) if end_date is not None else None,
        "event_slug": str(event_slug) if event_slug is not None else None,
        "expected_payout_usdc": expected_payout,
        "icon": str(icon) if icon is not None else None,
        "invested_usd": invested,
        "market": str(market) if market is not None else "Polymarket position",
        "negative_risk": bool(
            _read_bool(_first_value(row, "negativeRisk", "negative_risk"))
        ),
        "outcome": str(outcome) if outcome is not None else "",
        "pnl_percent": pnl_percent,
        "redeemable": redeemable,
        "resolution_status": "resolved" if redeemable else "open",
        "shares": shares,
        "slug": str(slug) if slug is not None else None,
        "unrealized_pnl": unrealized_pnl,
        "upstream_redeemable": redeemable,
    }


def _snapshot_has_positive_wallet_rows(
    snapshot: runtime_broker_module.BullpenPositionsSnapshot,
) -> bool:
    """Whether a snapshot contains any economically relevant wallet row."""

    return any(
        _normalize_public_position(row) is not None
        for row in _collect_rows(snapshot.payload)
    )


def _build_public_summary(
    positions: list[dict[str, Any]],
    *,
    cash_balance: float,
) -> dict[str, Any]:
    active_positions = [
        row
        for row in positions
        if not bool(row.get("redeemable"))
        and (_read_number(row.get("shares")) or 0.0) > _VALUE_EPSILON
    ]
    claimable_positions = [
        row
        for row in positions
        if bool(row.get("redeemable"))
        and (_read_number(row.get("current_value")) or 0.0) > _VALUE_EPSILON
    ]
    positions_value = sum(
        max(0.0, _read_number(row.get("current_value")) or 0.0)
        for row in active_positions
    )
    claimable_value = sum(
        max(0.0, _read_number(row.get("current_value")) or 0.0)
        for row in claimable_positions
    )
    unrealized_pnl = sum(
        _read_number(row.get("unrealized_pnl")) or 0.0
        for row in active_positions
    )
    return {
        "active_count": len(active_positions),
        "cash_balance": round(cash_balance, 6),
        "claimable_count": len(claimable_positions),
        "claimable_value": round(claimable_value, 6),
        "redeemable_count": len(claimable_positions),
        "redeemable_value": round(claimable_value, 6),
        "total_value": round(cash_balance + positions_value + claimable_value, 6),
        "unrealized_pnl": round(unrealized_pnl, 6),
        "wallet_value": round(positions_value, 6),
        "win_rate": None,
    }


async def _read_public_pusd_balance(
    client: httpx.AsyncClient,
    wallet: str,
) -> float:
    address_hex = wallet.removeprefix("0x").lower().rjust(64, "0")
    calldata = f"0x70a08231{address_hex}"
    last_error: Exception | None = None
    for rpc_url in _POLYGON_RPC_URLS:
        try:
            response = await client.post(
                rpc_url,
                json={
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "eth_call",
                    "params": [
                        {"to": _POLYMARKET_PUSD_TOKEN_ADDRESS, "data": calldata},
                        "latest",
                    ],
                },
            )
            response.raise_for_status()
            payload = response.json()
            result = payload.get("result") if isinstance(payload, dict) else None
            if not isinstance(result, str) or not result.startswith("0x"):
                raise RuntimeError("Polygon RPC returned an invalid pUSD balance payload.")
            return int(result, 16) / _POLYMARKET_PUSD_DECIMALS
        except Exception as exc:  # pragma: no cover - provider-specific detail
            last_error = exc
    if last_error is not None:
        raise last_error
    raise RuntimeError("No Polygon RPC endpoint was available for the pUSD balance read.")


async def _read_public_positions_payload(wallet: str) -> dict[str, Any]:
    raw_rows: list[dict[str, Any]] = []
    async with httpx.AsyncClient(
        timeout=_POLYMARKET_DATA_API_TIMEOUT_SECONDS,
        headers=_POLYMARKET_HTTP_HEADERS,
    ) as client:
        for page_index in range(_PUBLIC_POSITION_MAX_PAGES):
            offset = page_index * _PUBLIC_POSITION_PAGE_SIZE
            query = urlencode(
                {
                    "user": wallet,
                    "sizeThreshold": "0",
                    "limit": str(_PUBLIC_POSITION_PAGE_SIZE),
                    "offset": str(offset),
                    "sortBy": "CURRENT",
                    "sortDirection": "DESC",
                }
            )
            response = await client.get(
                f"{_POLYMARKET_DATA_API_BASE_URL}/positions?{query}"
            )
            response.raise_for_status()
            page_rows = _collect_rows(response.json())
            raw_rows.extend(page_rows)
            if len(page_rows) < _PUBLIC_POSITION_PAGE_SIZE:
                break
        cash_balance = await _read_public_pusd_balance(client, wallet)

    positions = [
        normalized
        for row in raw_rows
        if (normalized := _normalize_public_position(row)) is not None
    ]
    return {
        "_meta": {
            "source": "polymarket-public-data-api",
            "wallet_address": wallet,
            "display_only": True,
            "observed_at": datetime.now(UTC).isoformat(),
        },
        "magic_link_suspected": False,
        "positions": positions,
        "source": "polymarket-public-data-api",
        "summary": _build_public_summary(positions, cash_balance=cash_balance),
    }


async def _status_wallet_address(
    broker: runtime_broker_module.BullpenRuntimeBroker,
) -> str | None:
    # Status is passive/local in current Bullpen CLI builds and is the best
    # account-identity source when the trade-auth diagnostic is degraded.
    try:
        result = await broker.execute_raw(
            ["status", "--output", "json"],
            timeout_seconds=5,
            retry_auth_once=False,
        )
        payload = json.loads(result.stdout or "{}")
        wallet = _normalize_wallet_address(
            runtime_broker_module._extract_account_identity(payload)
        )
        if wallet:
            await _persist_display_wallet_identity(broker, wallet)
            return wallet
    except Exception:
        pass

    active_auth = await broker.read_latest_active_auth_result()
    wallet = _normalize_wallet_address(
        active_auth.account_identity if active_auth is not None else None
    )
    if wallet:
        await _persist_display_wallet_identity(broker, wallet)
        return wallet

    # Unlike the display/auth LKGs below, this public wallet identity does not
    # expire. It is the durable anchor that lets a forced refresh reconstruct
    # current positions even after all 24-hour snapshots have aged out.
    persisted_wallet = await _read_persisted_display_wallet_identity(broker)
    if persisted_wallet:
        return persisted_wallet

    # Read raw cache records deliberately. Display identity remains useful for
    # presentation even if a rotated canonical credential makes the stricter
    # execution-lineage validator reject that snapshot.
    for cache_key in (
        runtime_broker_module._POSITIONS_DISPLAY_LKG_KEY,
        runtime_broker_module._POSITIONS_SNAPSHOT_KEY,
    ):
        try:
            snapshot = await broker._read_positions_snapshot(cache_key)
        except Exception:
            snapshot = None
        wallet = _normalize_wallet_address(
            snapshot.account_identity if snapshot is not None else None
        )
        if wallet:
            await _persist_display_wallet_identity(broker, wallet)
            return wallet
    return None


def _verified_auth_proof(
    broker: runtime_broker_module.BullpenRuntimeBroker,
    *,
    credential: runtime_broker_module.BullpenCredentialArtifact,
    auth_cache: runtime_broker_module.BullpenAuthReadyCache | None,
    active_auth: runtime_broker_module.BullpenRuntimeActiveAuthResult | None,
) -> tuple[str | None, str | None]:
    cached_identity: str | None = None
    active_identity: str | None = None
    auth_checked_at: str | None = None

    if auth_cache is not None and runtime_broker_module._credential_artifact_matches(
        auth_cache.credential_artifact,
        credential,
    ):
        cached_identity = auth_cache.account_identity
        auth_checked_at = auth_cache.checked_at

    if (
        active_auth is not None
        and active_auth.healthy
        and runtime_broker_module._credential_artifact_matches(
            active_auth.credential_artifact,
            credential,
        )
    ):
        active_identity = active_auth.account_identity
        auth_checked_at = (
            auth_checked_at or active_auth.auth_checked_at or active_auth.checked_at
        )

    if cached_identity and active_identity and cached_identity != active_identity:
        return None, None
    return auth_checked_at, cached_identity or active_identity


async def _write_display_snapshot(
    broker: runtime_broker_module.BullpenRuntimeBroker,
    snapshot: runtime_broker_module.BullpenPositionsSnapshot,
) -> None:
    await broker._redis.set(
        runtime_broker_module._POSITIONS_DISPLAY_LKG_KEY,
        snapshot.model_dump_json(),
        ex=runtime_broker_module._POSITIONS_DISPLAY_LKG_TTL_SECONDS,
    )


async def _refresh_public_wallet_snapshot(
    broker: runtime_broker_module.BullpenRuntimeBroker,
    *,
    caller_source: str,
) -> runtime_broker_module.BullpenPositionsSnapshot:
    wallet = await _status_wallet_address(broker)
    if wallet is None:
        raise runtime_broker_module.BullpenRuntimeCommandError(
            "Unable to resolve the Bullpen Polymarket wallet address for the display refresh.",
            classification="public_wallet_identity_missing",
        )

    await _persist_display_wallet_identity(broker, wallet)
    payload = await _read_public_positions_payload(wallet)
    config = runtime_broker_module._runtime_config()
    diagnostics = runtime_broker_module.BullpenCommandDiagnostics(
        command_category="positions",
        pid=os.getpid(),
        unix_user=config.effective_user,
        effective_home=config.home,
        bullpen_version=broker._version_cache_value,
        credential_artifact=runtime_broker_module._stat_credential_artifact(config),
        cache_status="bypass",
        refresh_requested_at=runtime_broker_module._utc_now_iso(),
        caller_source=runtime_broker_module._normalize_caller_source(caller_source),
        snapshot_producer_source="polymarket-public-data-api",
        produced_by_another_refresh=False,
        error_classification="display_public_fallback",
    )
    snapshot = runtime_broker_module.BullpenPositionsSnapshot(
        payload=payload,
        fetched_at=runtime_broker_module._utc_now_iso(),
        cli_version=broker._version_cache_value,
        credential_artifact=diagnostics.credential_artifact,
        account_identity=wallet,
        position_classifier_version=(
            runtime_broker_module.BULLPEN_POSITION_CLASSIFIER_VERSION
        ),
        auth_checked_at=None,
        # Cached means display-only here. This record is never written to the
        # execution-authoritative positions key by this function.
        source="redis-cache",
        freshness_state="cached",
        diagnostics=diagnostics,
    )
    await _write_display_snapshot(broker, snapshot)
    return snapshot


async def _refresh_ui_positions_snapshot(
    broker: runtime_broker_module.BullpenRuntimeBroker,
    *,
    caller_source: str,
    timeout_seconds: int,
) -> runtime_broker_module.BullpenPositionsSnapshot:
    # Match the operator's successful command exactly. Do not run doctor-auth
    # first; a readable wallet must remain readable even when trade auth needs
    # remediation.
    result = await broker.execute_raw(
        ["polymarket", "positions", "--output", "json"],
        timeout_seconds=timeout_seconds,
        retry_auth_once=False,
    )
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise runtime_broker_module.BullpenRuntimeCommandError(
            "Bullpen positions returned invalid JSON.",
            classification="json_parse_error",
            stdout=result.stdout,
            stderr=result.stderr,
            exit_code=result.exit_code,
            signal=result.signal,
        ) from exc

    credential = result.diagnostics.credential_artifact
    auth_cache_key = f"{runtime_broker_module._REDIS_PREFIX}:auth:ready"
    auth_cache = await broker._read_auth_ready_cache(auth_cache_key)
    active_auth = await broker.read_latest_active_auth_result()
    auth_checked_at, verified_identity = _verified_auth_proof(
        broker,
        credential=credential,
        auth_cache=auth_cache,
        active_auth=active_auth,
    )
    payload_identity = _normalize_wallet_address(
        runtime_broker_module._extract_account_identity(payload)
    )
    normalized_verified_identity = _normalize_wallet_address(verified_identity)
    if (
        payload_identity
        and normalized_verified_identity
        and payload_identity != normalized_verified_identity
    ):
        raise runtime_broker_module.BullpenRuntimeCommandError(
            "Bullpen positions account identity did not match the authenticated account.",
            classification="account_identity_mismatch",
        )
    account_identity = payload_identity or normalized_verified_identity
    if account_identity:
        await _persist_display_wallet_identity(broker, account_identity)

    result.diagnostics.refresh_requested_at = runtime_broker_module._utc_now_iso()
    result.diagnostics.caller_source = runtime_broker_module._normalize_caller_source(
        caller_source
    )
    result.diagnostics.snapshot_producer_source = "live-cli"
    result.diagnostics.cache_status = "bypass"
    snapshot = runtime_broker_module.BullpenPositionsSnapshot(
        payload=payload,
        fetched_at=runtime_broker_module._utc_now_iso(),
        cli_version=result.diagnostics.bullpen_version or broker._version_cache_value,
        credential_artifact=credential,
        account_identity=account_identity,
        position_classifier_version=(
            runtime_broker_module.BULLPEN_POSITION_CLASSIFIER_VERSION
        ),
        auth_checked_at=auth_checked_at,
        source="live-cli",
        freshness_state="fresh",
        diagnostics=result.diagnostics,
    )
    await _write_display_snapshot(broker, snapshot)

    # Promotion into the execution key requires an independently established
    # current auth proof for this exact credential. A successful read alone is
    # never interpreted as trade authorization.
    if auth_checked_at is not None:
        await broker._redis.set(
            runtime_broker_module._POSITIONS_SNAPSHOT_KEY,
            snapshot.model_dump_json(),
            ex=runtime_broker_module._POSITIONS_SNAPSHOT_TTL_SECONDS,
        )
    return snapshot


async def _read_display_snapshot_without_deleting(
    broker: runtime_broker_module.BullpenRuntimeBroker,
) -> runtime_broker_module.BullpenPositionsSnapshot | None:
    try:
        return await broker.read_display_positions_snapshot(delete_invalid=False)
    except Exception:
        return None


async def _get_stage1_analysis_positions_snapshot(
    broker: runtime_broker_module.BullpenRuntimeBroker,
    *,
    force_fresh: bool,
    allow_refresh: bool,
    caller_source: str | None,
    max_age_seconds: int,
    timeout_seconds: int,
) -> runtime_broker_module.BullpenPositionsSnapshot:
    """Reconcile a false-empty execution snapshot for Stage 1 analysis only.

    The authenticated execution snapshot remains preferred. A current public
    wallet snapshot is consulted only when that authoritative read is empty or
    unavailable. Public evidence is accepted only for the same known wallet and
    remains `redis-cache`/`cached` with no auth timestamp, so it cannot authorize
    a Stage 3 write or be promoted into the execution snapshot.
    """

    canonical_snapshot: runtime_broker_module.BullpenPositionsSnapshot | None = None
    canonical_error: Exception | None = None
    try:
        canonical_snapshot = await _ORIGINAL_GET_POSITIONS_SNAPSHOT(
            broker,
            force_fresh=force_fresh,
            allow_refresh=allow_refresh,
            caller_source=caller_source,
            max_age_seconds=max_age_seconds,
            timeout_seconds=timeout_seconds,
        )
    except Exception as exc:
        canonical_error = exc

    if canonical_snapshot is not None and _snapshot_has_positive_wallet_rows(
        canonical_snapshot
    ):
        return canonical_snapshot

    try:
        public_snapshot = await _refresh_public_wallet_snapshot(
            broker,
            caller_source=runtime_broker_module._normalize_caller_source(caller_source),
        )
    except Exception:
        if canonical_snapshot is not None:
            return canonical_snapshot
        if canonical_error is not None:
            raise canonical_error
        raise

    canonical_identity = _normalize_wallet_address(
        canonical_snapshot.account_identity if canonical_snapshot is not None else None
    )
    public_identity = _normalize_wallet_address(public_snapshot.account_identity)
    if (
        canonical_identity is not None
        and public_identity is not None
        and canonical_identity != public_identity
    ):
        raise runtime_broker_module.BullpenRuntimeCommandError(
            "Stage 1 public wallet identity did not match the authenticated execution account.",
            classification="account_identity_mismatch",
        )

    if _snapshot_has_positive_wallet_rows(public_snapshot):
        diagnostics = public_snapshot.diagnostics.model_copy(
            update={
                "caller_source": runtime_broker_module._normalize_caller_source(
                    caller_source
                ),
                "snapshot_producer_source": (
                    "polymarket-public-data-api-stage1-analysis"
                ),
                "error_classification": "stage1_analysis_public_fallback",
            }
        )
        return public_snapshot.model_copy(update={"diagnostics": diagnostics})

    if canonical_snapshot is not None:
        return canonical_snapshot
    if canonical_error is not None:
        raise canonical_error
    return public_snapshot


async def _get_positions_snapshot_with_ui_read_fallback(
    self: runtime_broker_module.BullpenRuntimeBroker,
    *,
    force_fresh: bool = False,
    allow_refresh: bool = True,
    caller_source: str | None = None,
    max_age_seconds: int = 20,
    timeout_seconds: int = 30,
) -> runtime_broker_module.BullpenPositionsSnapshot:
    normalized_caller_source = runtime_broker_module._normalize_caller_source(
        caller_source
    )

    if normalized_caller_source in _STAGE1_ANALYSIS_POSITION_REFRESH_CALLERS:
        return await _get_stage1_analysis_positions_snapshot(
            self,
            force_fresh=force_fresh,
            allow_refresh=allow_refresh,
            caller_source=caller_source,
            max_age_seconds=max_age_seconds,
            timeout_seconds=timeout_seconds,
        )

    if normalized_caller_source in _MANUAL_UI_POSITION_REFRESH_CALLERS:
        if not force_fresh:
            cached_display = await _read_display_snapshot_without_deleting(self)
            if cached_display is not None:
                return cached_display
        try:
            return await _refresh_ui_positions_snapshot(
                self,
                caller_source=normalized_caller_source,
                timeout_seconds=timeout_seconds,
            )
        except Exception:
            # The canonical service-account CLI can be degraded while the wallet
            # identity remains known. Refresh the same wallet from Polymarket's
            # current data API and on-chain pUSD balance for display.
            return await _refresh_public_wallet_snapshot(
                self,
                caller_source=normalized_caller_source,
            )

    if (
        normalized_caller_source in _PASSIVE_UI_POSITION_REFRESH_CALLERS
        and not allow_refresh
        and not force_fresh
    ):
        # Do not enter the original broker's long passive lock/poll budget for a
        # page render. Both portfolio surfaces should read the same display LKG
        # immediately; if none exists, rebuild it from the current wallet.
        cached_display = await _read_display_snapshot_without_deleting(self)
        if cached_display is not None:
            return cached_display
        try:
            return await _refresh_public_wallet_snapshot(
                self,
                caller_source=normalized_caller_source,
            )
        except Exception:
            # Preserve the original error/fallback behavior only as the final
            # fallback when the shared display path itself cannot be resolved.
            return await _ORIGINAL_GET_POSITIONS_SNAPSHOT(
                self,
                force_fresh=force_fresh,
                allow_refresh=allow_refresh,
                caller_source=caller_source,
                max_age_seconds=max_age_seconds,
                timeout_seconds=timeout_seconds,
            )

    return await _ORIGINAL_GET_POSITIONS_SNAPSHOT(
        self,
        force_fresh=force_fresh,
        allow_refresh=allow_refresh,
        caller_source=caller_source,
        max_age_seconds=max_age_seconds,
        timeout_seconds=timeout_seconds,
    )


def install_bullpen_ui_positions_refresh() -> None:
    global _INSTALLED
    if _INSTALLED:
        return
    runtime_broker_module.BullpenRuntimeBroker.get_positions_snapshot = (
        _get_positions_snapshot_with_ui_read_fallback
    )
    _INSTALLED = True