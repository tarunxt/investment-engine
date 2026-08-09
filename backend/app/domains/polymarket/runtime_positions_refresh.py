from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlencode

import httpx

from app.domains.polymarket import runtime_broker as runtime_broker_module


_MANUAL_UI_POSITION_REFRESH_CALLERS = frozenset(
    {
        "ui-history-portfolio-refresh",
        "ui-manual-refresh",
    }
)
_PASSIVE_UI_POSITION_REFRESH_CALLERS = frozenset(
    {
        "ui-history-portfolio-load",
        "ui-passive-refresh",
    }
)

_ORIGINAL_GET_POSITIONS_SNAPSHOT = (
    runtime_broker_module.BullpenRuntimeBroker.get_positions_snapshot
)
_INSTALLED = False

_POLYMARKET_DATA_API_BASE_URL = "https://data-api.polymarket.com"
_POLYMARKET_DATA_API_TIMEOUT_SECONDS = 10
_POLYMARKET_HTTP_HEADERS = {"User-Agent": "investment-engine-bullpen-portfolio/1.0"}
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


def _verified_auth_cache_for_credential(
    auth_cache: runtime_broker_module.BullpenAuthReadyCache | None,
    credential_artifact: runtime_broker_module.BullpenCredentialArtifact,
) -> runtime_broker_module.BullpenAuthReadyCache | None:
    if auth_cache is None:
        return None
    if not runtime_broker_module._credential_artifact_matches(
        auth_cache.credential_artifact,
        credential_artifact,
    ):
        return None
    return auth_cache


def _verified_active_auth_for_credential(
    active_auth: runtime_broker_module.BullpenRuntimeActiveAuthResult | None,
    credential_artifact: runtime_broker_module.BullpenCredentialArtifact,
) -> runtime_broker_module.BullpenRuntimeActiveAuthResult | None:
    if active_auth is None or not active_auth.healthy:
        return None
    if not runtime_broker_module._credential_artifact_matches(
        active_auth.credential_artifact,
        credential_artifact,
    ):
        return None
    return active_auth


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
        return value
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
            _first_value(
                row,
                "redeemable",
                "isRedeemable",
                "is_redeemable",
            )
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
        _first_value(row, "initialValue", "initial_value", "investedUsd", "invested_usd")
    )
    unrealized_pnl = _read_number(
        _first_value(row, "cashPnl", "cash_pnl", "unrealizedPnl", "unrealized_pnl")
    )
    pnl_percent = _read_number(
        _first_value(row, "percentPnl", "percent_pnl", "pnlPercent", "pnl_percent")
    )
    condition_id = _first_value(row, "conditionId", "condition_id")
    event_slug = _first_value(row, "eventSlug", "event_slug")
    market = _first_value(row, "title", "market", "question")
    outcome = _first_value(row, "outcome", "side")
    slug = _first_value(row, "slug", "marketSlug", "market_slug")
    end_date = _first_value(row, "endDate", "end_date")
    icon = _first_value(row, "icon", "image")
    asset = _first_value(row, "asset", "assetId", "asset_id", "tokenId", "token_id")

    expected_payout = (
        max(0.0, current_value or 0.0) if redeemable else 0.0
    )
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


def _build_public_summary(
    positions: list[dict[str, Any]],
    *,
    cash_balance: float,
) -> dict[str, Any]:
    active_positions = [
        row
        for row in positions
        if not bool(row.get("redeemable")) and (_read_number(row.get("shares")) or 0) > _VALUE_EPSILON
    ]
    claimable_positions = [
        row
        for row in positions
        if bool(row.get("redeemable"))
        and (_read_number(row.get("current_value")) or 0) > _VALUE_EPSILON
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
        except Exception as exc:  # pragma: no cover - provider-specific failure detail
            last_error = exc
            continue
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
        "summary": _build_public_summary(
            positions,
            cash_balance=cash_balance,
        ),
    }


async def _status_wallet_address(
    broker: runtime_broker_module.BullpenRuntimeBroker,
) -> str | None:
    try:
        result = await broker.execute_raw(
            ["status", "--output", "json"],
            timeout_seconds=10,
            retry_auth_once=False,
        )
        payload = json.loads(result.stdout or "{}")
        wallet = _normalize_wallet_address(
            runtime_broker_module._extract_account_identity(payload)
        )
        if wallet:
            return wallet
    except Exception:
        pass

    active_auth = await broker.read_latest_active_auth_result()
    wallet = _normalize_wallet_address(
        active_auth.account_identity if active_auth is not None else None
    )
    if wallet:
        return wallet

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
            return wallet
    return None


async def _refresh_public_wallet_snapshot(
    broker: runtime_broker_module.BullpenRuntimeBroker,
    *,
    caller_source: str,
) -> runtime_broker_module.BullpenPositionsSnapshot:
    wallet = await _status_wallet_address(broker)
    if wallet is None:
        raise runtime_broker_module.BullpenRuntimeCommandError(
            "Unable to resolve the Bullpen Polymarket wallet address for the display-only public refresh.",
            classification="public_wallet_identity_missing",
        )

    payload = await _read_public_positions_payload(wallet)
    config = runtime_broker_module._runtime_config()
    diagnostics = runtime_broker_module.BullpenCommandDiagnostics(
        command_category="positions",
        pid=__import__("os").getpid(),
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
        # The data was observed now, but it is intentionally labelled cached:
        # it is safe for display and sizing previews, not for execution lineage.
        source="redis-cache",
        freshness_state="cached",
        diagnostics=diagnostics,
    )
    await broker._redis.set(
        runtime_broker_module._POSITIONS_DISPLAY_LKG_KEY,
        snapshot.model_dump_json(),
        ex=runtime_broker_module._POSITIONS_DISPLAY_LKG_TTL_SECONDS,
    )
    return snapshot


async def _refresh_ui_positions_snapshot(
    broker: runtime_broker_module.BullpenRuntimeBroker,
    *,
    caller_source: str,
    timeout_seconds: int,
) -> runtime_broker_module.BullpenPositionsSnapshot:
    """Read the Bullpen wallet without pre-gating the read on trade auth.

    The Bullpen CLI can expose Polymarket positions even when its account/trade
    login needs remediation. A UI refresh is therefore allowed to execute the
    read command first. ``execute_raw`` still performs the broker's existing
    auth-refresh-and-retry flow if the positions command itself returns an
    auth rejection.

    A successful read is always safe to publish to the display-only LKG. It is
    promoted into the authenticated execution snapshot only when the current
    credential artifact still has a matching short-lived auth-ready cache.
    This keeps auto-trade/auto-claim lineage strict while making the portfolio
    refresh reflect the wallet that Bullpen itself can currently read.
    """

    refresh_requested_at = runtime_broker_module._utc_now_iso()
    normalized_caller_source = runtime_broker_module._normalize_caller_source(
        caller_source
    )

    result = await broker.execute_raw(
        ["polymarket", "positions", "--output", "json"],
        timeout_seconds=timeout_seconds,
        retry_auth_once=True,
    )
    try:
        payload: Any = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        error = runtime_broker_module.BullpenRuntimeCommandError(
            "Bullpen positions returned invalid JSON.",
            classification="json_parse_error",
            stdout=result.stdout,
            stderr=result.stderr,
            exit_code=result.exit_code,
            signal=result.signal,
        )
        result.diagnostics.error_classification = error.classification
        broker._record_failure(
            command_category="positions",
            classification=error.classification,
            message=str(error),
            diagnostics=result.diagnostics,
        )
        raise error from exc

    credential_artifact = result.diagnostics.credential_artifact
    auth_cache_key = f"{runtime_broker_module._REDIS_PREFIX}:auth:ready"
    auth_cache = _verified_auth_cache_for_credential(
        await broker._read_auth_ready_cache(auth_cache_key),
        credential_artifact,
    )
    active_auth = _verified_active_auth_for_credential(
        await broker.read_latest_active_auth_result(),
        credential_artifact,
    )

    payload_account_identity = runtime_broker_module._extract_account_identity(payload)
    cached_account_identity = (
        auth_cache.account_identity if auth_cache is not None else None
    )
    active_account_identity = (
        active_auth.account_identity if active_auth is not None else None
    )
    verified_account_identity = cached_account_identity or active_account_identity

    if (
        payload_account_identity
        and verified_account_identity
        and payload_account_identity != verified_account_identity
    ) or (
        cached_account_identity
        and active_account_identity
        and cached_account_identity != active_account_identity
    ):
        result.diagnostics.error_classification = "account_identity_mismatch"
        message = (
            "Bullpen positions account identity did not match the authenticated "
            "account."
        )
        broker._record_failure(
            command_category="positions",
            classification="account_identity_mismatch",
            message=message,
            diagnostics=result.diagnostics,
        )
        raise runtime_broker_module.BullpenRuntimeCommandError(
            message,
            classification="account_identity_mismatch",
        )

    account_identity = (
        payload_account_identity
        or cached_account_identity
        or active_account_identity
    )
    auth_checked_at = (
        auth_cache.checked_at
        if auth_cache is not None
        else active_auth.auth_checked_at if active_auth is not None else None
    )

    diagnostics = result.diagnostics.model_copy(
        update={
            "command_category": "positions",
            "cache_status": "bypass",
            "refresh_requested_at": refresh_requested_at,
            "caller_source": normalized_caller_source,
            "snapshot_producer_source": normalized_caller_source,
            "produced_by_another_refresh": False,
        }
    )
    snapshot = runtime_broker_module.BullpenPositionsSnapshot(
        payload=payload,
        fetched_at=runtime_broker_module._utc_now_iso(),
        cli_version=result.diagnostics.bullpen_version or broker._version_cache_value,
        credential_artifact=credential_artifact,
        account_identity=account_identity,
        position_classifier_version=(
            runtime_broker_module.BULLPEN_POSITION_CLASSIFIER_VERSION
        ),
        auth_checked_at=auth_checked_at,
        source="live-cli",
        freshness_state="fresh",
        diagnostics=diagnostics,
    )
    serialized_snapshot = snapshot.model_dump_json()

    # UI display state is intentionally separate from the execution-safe cache.
    await broker._redis.set(
        runtime_broker_module._POSITIONS_DISPLAY_LKG_KEY,
        serialized_snapshot,
        ex=runtime_broker_module._POSITIONS_DISPLAY_LKG_TTL_SECONDS,
    )

    if auth_cache is not None:
        # Preserve the existing strict execution contract only when the current
        # credential still has a recent verified auth-ready proof.
        await broker._write_auth_ready_cache(
            cache_key=auth_cache_key,
            checked_at=auth_cache.checked_at,
            credential_artifact=credential_artifact,
            account_identity=account_identity,
        )
        await broker._redis.set(
            runtime_broker_module._POSITIONS_SNAPSHOT_KEY,
            serialized_snapshot,
            ex=runtime_broker_module._POSITIONS_SNAPSHOT_TTL_SECONDS,
        )

    # A prior auth failure remains valid for trade safety, but it must not make
    # a successfully read wallet look unavailable to the portfolio UI.
    broker._update_cached_health(
        ok=True,
        message="Bullpen positions read completed for portfolio display.",
        command_category="positions",
        error_classification=None,
        diagnostics=diagnostics,
    )
    broker._log_runtime_event(diagnostics, success=True)
    return snapshot


async def _get_positions_snapshot_with_ui_read_fallback(
    self: runtime_broker_module.BullpenRuntimeBroker,
    *,
    force_fresh: bool = False,
    allow_refresh: bool = True,
    caller_source: str | None = None,
    max_age_seconds: int = runtime_broker_module._POSITIONS_FRESH_SECONDS,
    timeout_seconds: int = runtime_broker_module._CLI_DEFAULT_TIMEOUT_SECONDS,
) -> runtime_broker_module.BullpenPositionsSnapshot:
    normalized_caller_source = runtime_broker_module._normalize_caller_source(
        caller_source
    )

    if (
        force_fresh
        and allow_refresh
        and normalized_caller_source in _MANUAL_UI_POSITION_REFRESH_CALLERS
    ):
        try:
            return await _refresh_ui_positions_snapshot(
                self,
                caller_source=normalized_caller_source,
                timeout_seconds=timeout_seconds,
            )
        except Exception as cli_error:
            try:
                return await _refresh_public_wallet_snapshot(
                    self,
                    caller_source=normalized_caller_source,
                )
            except Exception:
                raise cli_error

    if (
        not force_fresh
        and not allow_refresh
        and normalized_caller_source in _PASSIVE_UI_POSITION_REFRESH_CALLERS
    ):
        try:
            return await _ORIGINAL_GET_POSITIONS_SNAPSHOT(
                self,
                force_fresh=force_fresh,
                allow_refresh=allow_refresh,
                caller_source=caller_source,
                max_age_seconds=max_age_seconds,
                timeout_seconds=timeout_seconds,
            )
        except runtime_broker_module.BullpenRuntimeCommandError as cache_error:
            if cache_error.classification != "passive_cache_miss":
                raise
            try:
                return await _refresh_public_wallet_snapshot(
                    self,
                    caller_source=normalized_caller_source,
                )
            except Exception:
                raise cache_error

    return await _ORIGINAL_GET_POSITIONS_SNAPSHOT(
        self,
        force_fresh=force_fresh,
        allow_refresh=allow_refresh,
        caller_source=caller_source,
        max_age_seconds=max_age_seconds,
        timeout_seconds=timeout_seconds,
    )


def install_bullpen_ui_positions_refresh() -> None:
    """Install the UI-only wallet-read path exactly once per process."""

    global _INSTALLED
    if _INSTALLED:
        return
    runtime_broker_module.BullpenRuntimeBroker.get_positions_snapshot = (
        _get_positions_snapshot_with_ui_read_fallback
    )
    _INSTALLED = True
