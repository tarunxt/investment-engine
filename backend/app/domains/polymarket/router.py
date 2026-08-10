from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User
from app.domains.polymarket.access import require_singleton_bullpen_runtime_access
from app.domains.polymarket.runtime_broker import (
    BullpenPositionsSnapshot,
    BullpenPositionsSnapshotMetadata,
    BullpenRuntimeCachedHealth,
    BullpenRuntimeActiveAuthResult,
    BullpenRuntimeFailure,
    get_bullpen_runtime_broker,
)
from app.domains.polymarket.schemas import (
    PolymarketBotState,
    PolymarketDiscoveryDebugReport,
    PolymarketDiscoveryDebugRequest,
    PolymarketHistoryResponse,
    PolymarketLiveRedeemRequest,
    PolymarketManualInvestRequest,
    PolymarketManualInvestResponse,
    PolymarketLiveLimitUpdate,
    PolymarketTrackedAccountCreate,
    PolymarketTrackedAccountUpdate,
)
from app.domains.polymarket.service import polymarket_bot_manager

router = APIRouter(prefix="/polymarket", tags=["polymarket"])


class BullpenRuntimePositionsResponse(BaseModel):
    ok: bool
    snapshot: BullpenPositionsSnapshot | None = None
    stale_snapshot: BullpenPositionsSnapshot | None = None
    broker_health: BullpenRuntimeCachedHealth | None = None
    auth_checked_at: str | None = None
    latest_snapshot: BullpenPositionsSnapshotMetadata | None = None
    last_failure: BullpenRuntimeFailure | None = None
    active_auth: BullpenRuntimeActiveAuthResult | None = None
    cli_version: str | None = None
    error: str | None = None


class BullpenRuntimeDisplaySnapshot(BaseModel):
    """Sanitized wallet evidence safe for authenticated UI display."""

    payload: dict[str, object]
    fetched_at: str
    account_identity: str | None = None
    position_classifier_version: int | None = None
    source: str | None = None
    freshness_state: str | None = None


class BullpenRuntimeDisplayPositionsResponse(BaseModel):
    ok: bool
    snapshot: BullpenRuntimeDisplaySnapshot | None = None
    stale_snapshot: BullpenRuntimeDisplaySnapshot | None = None
    error: str | None = None


class BullpenRuntimeHealthResponse(BaseModel):
    ok: bool
    checked_at: str
    doctor: object
    snapshot: BullpenPositionsSnapshotMetadata | None = None
    stale_snapshot: BullpenPositionsSnapshotMetadata | None = None
    broker_health: BullpenRuntimeCachedHealth | None = None
    auth_checked_at: str | None = None
    latest_snapshot: BullpenPositionsSnapshotMetadata | None = None
    last_failure: BullpenRuntimeFailure | None = None
    active_auth: BullpenRuntimeActiveAuthResult | None = None
    cli_version: str | None = None
    command_path: str | None = None
    error: str | None = None


class BullpenRuntimeDiagnosticsResponse(BaseModel):
    ok: bool
    checked_at: str
    doctor: object
    snapshot: BullpenPositionsSnapshot | None = None
    stale_snapshot: BullpenPositionsSnapshot | None = None
    error: str | None = None


class BullpenRuntimeSearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=500)


def _sanitize_bullpen_display_snapshot(
    snapshot: BullpenPositionsSnapshot | None,
) -> BullpenRuntimeDisplaySnapshot | None:
    if snapshot is None:
        return None
    return BullpenRuntimeDisplaySnapshot(
        payload=snapshot.payload,
        fetched_at=snapshot.fetched_at,
        account_identity=snapshot.account_identity,
        position_classifier_version=snapshot.position_classifier_version,
        source=snapshot.source,
        freshness_state=snapshot.freshness_state,
    )


async def _get_bot(current_user: User) -> object:
    return await polymarket_bot_manager.get_bot(current_user.id)


def _http_error_detail(exc: Exception) -> str:
    message = str(exc).strip()
    if message and message.lower() != "none":
        return f"{exc.__class__.__name__}: {message}"
    return f"{exc.__class__.__name__}: {exc!r}"


@router.get("/state", response_model=PolymarketBotState)
async def get_polymarket_state(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    return await bot.get_state()


@router.get("/history", response_model=PolymarketHistoryResponse)
async def get_polymarket_history(
    limit: int = Query(default=100, ge=1, le=200),
    current_user: User = Depends(get_current_user),
):
    """Explicit bounded history; ordinary state responses include only 50 rows."""

    bot = await _get_bot(current_user)
    return PolymarketHistoryResponse(
        paper_trades=list(reversed(bot.trade_history[-limit:])),
        live_decisions=list(reversed(bot.live_trade_history[-limit:])),
        redeemed_trades=bot.bullpen_redeemed_trades[:limit],
    )


@router.get("/runtime/positions", response_model=BullpenRuntimePositionsResponse)
async def get_bullpen_runtime_positions(
    force_fresh: bool = Query(default=False),
    passive: bool = Query(default=False),
    caller_source: str | None = Query(default=None, max_length=80),
    max_age_seconds: int = Query(default=20, ge=0, le=300),
    current_user: User = Depends(require_singleton_bullpen_runtime_access),
):
    del current_user
    if passive and force_fresh:
        raise HTTPException(
            status_code=400,
            detail="Passive Bullpen positions requests cannot force a refresh.",
        )
    broker = get_bullpen_runtime_broker()
    stale_snapshot = await broker.read_cached_positions_snapshot()
    if stale_snapshot is None:
        stale_snapshot = await broker.read_display_positions_snapshot()
    try:
        snapshot = await broker.get_positions_snapshot(
            force_fresh=force_fresh,
            allow_refresh=not passive,
            caller_source=caller_source,
            max_age_seconds=max_age_seconds,
        )
        passive_health = await broker.read_passive_health()
        return BullpenRuntimePositionsResponse(
            ok=True,
            snapshot=snapshot,
            broker_health=passive_health.broker_health,
            auth_checked_at=passive_health.auth_checked_at,
            latest_snapshot=passive_health.latest_snapshot,
            last_failure=passive_health.last_failure,
            active_auth=passive_health.active_auth,
            cli_version=passive_health.cli_version,
        )
    except Exception as exc:
        passive_health = await broker.read_passive_health()
        return BullpenRuntimePositionsResponse(
            ok=False,
            stale_snapshot=stale_snapshot,
            broker_health=passive_health.broker_health,
            auth_checked_at=passive_health.auth_checked_at,
            latest_snapshot=passive_health.latest_snapshot,
            last_failure=passive_health.last_failure,
            active_auth=passive_health.active_auth,
            cli_version=passive_health.cli_version,
            error=_http_error_detail(exc),
        )


@router.get(
    "/runtime/positions/display",
    response_model=BullpenRuntimeDisplayPositionsResponse,
)
async def get_bullpen_runtime_display_positions(
    force_fresh: bool = Query(default=False),
    passive: bool = Query(default=False),
    caller_source: str | None = Query(default=None, max_length=80),
    max_age_seconds: int = Query(default=20, ge=0, le=300),
    current_user: User = Depends(get_current_user),
):
    """Read-only, sanitized Bullpen wallet evidence for the signed-in UI.

    The operational singleton runtime endpoints remain admin-only. This route
    exposes only portfolio evidence and deliberately strips credential and
    runtime diagnostics from the snapshot before it crosses the user boundary.
    """

    del current_user
    if passive and force_fresh:
        raise HTTPException(
            status_code=400,
            detail="Passive Bullpen positions requests cannot force a refresh.",
        )
    broker = get_bullpen_runtime_broker()
    stale_snapshot = await broker.read_display_positions_snapshot()
    if stale_snapshot is None:
        stale_snapshot = await broker.read_cached_positions_snapshot()
    try:
        snapshot = await broker.get_positions_snapshot(
            force_fresh=force_fresh,
            allow_refresh=not passive,
            caller_source=caller_source,
            max_age_seconds=max_age_seconds,
        )
        return BullpenRuntimeDisplayPositionsResponse(
            ok=True,
            snapshot=_sanitize_bullpen_display_snapshot(snapshot),
        )
    except Exception as exc:
        return BullpenRuntimeDisplayPositionsResponse(
            ok=False,
            stale_snapshot=_sanitize_bullpen_display_snapshot(stale_snapshot),
            error=_http_error_detail(exc),
        )


@router.get("/runtime/health", response_model=BullpenRuntimeHealthResponse)
async def get_bullpen_runtime_health(
    current_user: User = Depends(require_singleton_bullpen_runtime_access),
):
    del current_user
    broker = get_bullpen_runtime_broker()
    passive_health = await broker.read_passive_health()
    return BullpenRuntimeHealthResponse(
        ok=passive_health.ok,
        checked_at=passive_health.checked_at,
        doctor=passive_health.broker_health.model_dump(mode="json"),
        snapshot=passive_health.latest_snapshot,
        stale_snapshot=passive_health.latest_snapshot,
        broker_health=passive_health.broker_health,
        auth_checked_at=passive_health.auth_checked_at,
        latest_snapshot=passive_health.latest_snapshot,
        last_failure=passive_health.last_failure,
        active_auth=passive_health.active_auth,
        cli_version=passive_health.cli_version,
        command_path=passive_health.command_path,
        error=passive_health.last_failure.message if not passive_health.ok and passive_health.last_failure else None,
    )


@router.get("/runtime/diagnostics", response_model=BullpenRuntimeDiagnosticsResponse)
async def get_bullpen_runtime_diagnostics(
    current_user: User = Depends(require_singleton_bullpen_runtime_access),
):
    bot = await _get_bot(current_user)
    broker = get_bullpen_runtime_broker()
    checked_at = datetime.now(UTC).isoformat()
    cached_snapshot = await broker.read_cached_positions_snapshot()
    doctor: object | None = None
    try:
        doctor = await bot.live_executor.doctor()
        return BullpenRuntimeDiagnosticsResponse(
            ok=bool(getattr(doctor, "ok", False)),
            checked_at=checked_at,
            doctor=doctor,
            snapshot=cached_snapshot,
        )
    except Exception as exc:
        if doctor is None:
            doctor = {"ok": False, "message": _http_error_detail(exc)}
        return BullpenRuntimeDiagnosticsResponse(
            ok=False,
            checked_at=checked_at,
            doctor=doctor,
            stale_snapshot=cached_snapshot,
            error=_http_error_detail(exc),
        )


@router.get("/runtime/discover")
async def get_bullpen_runtime_discover(
    current_user: User = Depends(require_singleton_bullpen_runtime_access),
):
    del current_user
    broker = get_bullpen_runtime_broker()
    return await broker.execute_first_json(
        [
            [
                "polymarket",
                "discover",
                "--status",
                "active",
                "--limit",
                "1000",
                "--output",
                "json",
            ],
            [
                "polymarket",
                "discover",
                "--status",
                "active",
                "--sort",
                "newest",
                "--limit",
                "1000",
                "--output",
                "json",
            ],
        ],
        timeout_seconds=25,
    )


@router.post("/runtime/search")
async def search_bullpen_runtime_markets(
    request: BullpenRuntimeSearchRequest,
    current_user: User = Depends(require_singleton_bullpen_runtime_access),
):
    del current_user
    broker = get_bullpen_runtime_broker()
    return await broker.execute_json(
        ["polymarket", "search", request.query, "--output", "json"],
        timeout_seconds=20,
    )


@router.post("/start", response_model=PolymarketBotState)
async def start_polymarket_bot(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    try:
        await bot.start()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=_http_error_detail(exc)) from exc
    return await bot.get_state()


@router.post("/stop", response_model=PolymarketBotState)
async def stop_polymarket_bot(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    await bot.stop()
    return await bot.get_state()


@router.post("/pause", response_model=PolymarketBotState)
async def pause_polymarket_bot(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    await bot.pause()
    return await bot.get_state()


@router.post("/resume", response_model=PolymarketBotState)
async def resume_polymarket_bot(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    await bot.resume()
    return await bot.get_state()


@router.post("/live/unlock", response_model=PolymarketBotState)
async def unlock_polymarket_live(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    try:
        await bot.unlock_live()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=_http_error_detail(exc)) from exc
    return await bot.get_state()


@router.post("/live/lock", response_model=PolymarketBotState)
async def lock_polymarket_live(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    await bot.lock_live()
    return await bot.get_state()


@router.post("/live/doctor", response_model=PolymarketBotState)
async def refresh_polymarket_doctor(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    await bot.refresh_doctor()
    return await bot.get_state()


@router.post("/live/balance/refresh", response_model=PolymarketBotState)
async def refresh_polymarket_balance(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    # The Bullpen refresh may include balance, redeem-history and wallet work.
    # Start/coalesce that work and return the current loading snapshot instead
    # of holding an HTTP request open across the full CLI operation.
    await bot.request_balance_refresh()
    return bot.get_state_snapshot()


@router.post("/live/redeem", response_model=PolymarketBotState)
async def redeem_polymarket_live_positions(
    request: PolymarketLiveRedeemRequest | None = None,
    current_user: User = Depends(get_current_user),
):
    bot = await _get_bot(current_user)
    try:
        await bot.redeem_live_positions(request.condition_ids if request else None)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=_http_error_detail(exc)) from exc
    return await bot.get_state()


@router.post("/live/emergency-stop", response_model=PolymarketBotState)
async def emergency_stop_polymarket_live(
    current_user: User = Depends(get_current_user),
):
    bot = await _get_bot(current_user)
    await bot.emergency_stop()
    return await bot.get_state()


@router.post("/live/reset-emergency-stop", response_model=PolymarketBotState)
async def reset_polymarket_live_emergency_stop(
    current_user: User = Depends(get_current_user),
):
    bot = await _get_bot(current_user)
    await bot.reset_emergency_stop()
    return await bot.get_state()


@router.patch("/live/limits", response_model=PolymarketBotState)
async def update_polymarket_live_limits(
    request: PolymarketLiveLimitUpdate,
    current_user: User = Depends(get_current_user),
):
    bot = await _get_bot(current_user)
    try:
        await bot.update_live_limits(request)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=_http_error_detail(exc)) from exc
    return await bot.get_state()


@router.post("/live/trades/{trade_id}/confirm", response_model=PolymarketBotState)
async def confirm_polymarket_trade(
    trade_id: str, current_user: User = Depends(get_current_user)
):
    bot = await _get_bot(current_user)
    try:
        await bot.confirm_live_trade(trade_id)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=_http_error_detail(exc)) from exc
    return await bot.get_state()


@router.post("/live/trades/{trade_id}/reject", response_model=PolymarketBotState)
async def reject_polymarket_trade(
    trade_id: str, current_user: User = Depends(get_current_user)
):
    bot = await _get_bot(current_user)
    try:
        await bot.reject_live_trade(trade_id)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=_http_error_detail(exc)) from exc
    return await bot.get_state()


@router.post("/live/trades/reject-all", response_model=PolymarketBotState)
async def reject_all_polymarket_trades(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    await bot.reject_all_pending_live_trades()
    return await bot.get_state()


@router.post("/manual-invest", response_model=PolymarketManualInvestResponse)
async def manual_invest_polymarket_orders(
    request: PolymarketManualInvestRequest,
    current_user: User = Depends(get_current_user),
):
    bot = await _get_bot(current_user)
    try:
        orders = await bot.execute_manual_investments(request.orders)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=_http_error_detail(exc)) from exc
    return PolymarketManualInvestResponse(
        orders=orders,
        state=await bot.get_state(),
    )


@router.post("/tracked-accounts", response_model=PolymarketBotState)
async def add_polymarket_tracked_account(
    request: PolymarketTrackedAccountCreate,
    current_user: User = Depends(get_current_user),
):
    bot = await _get_bot(current_user)
    try:
        await bot.add_tracked_account(request)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=_http_error_detail(exc)) from exc
    return await bot.get_state()


@router.patch("/tracked-accounts/{account_id}", response_model=PolymarketBotState)
async def update_polymarket_tracked_account(
    account_id: str,
    request: PolymarketTrackedAccountUpdate,
    current_user: User = Depends(get_current_user),
):
    bot = await _get_bot(current_user)
    try:
        await bot.update_tracked_account(account_id, request)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=_http_error_detail(exc)) from exc
    return await bot.get_state()


@router.post(
    "/tracked-accounts/{account_id}/net-worth/refresh",
    response_model=PolymarketBotState,
)
async def refresh_polymarket_tracked_account_net_worth(
    account_id: str, current_user: User = Depends(get_current_user)
):
    bot = await _get_bot(current_user)
    try:
        await bot.refresh_tracked_account_net_worth(account_id)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=_http_error_detail(exc)) from exc
    return await bot.get_state()


@router.delete("/tracked-accounts/{account_id}", response_model=PolymarketBotState)
async def delete_polymarket_tracked_account(
    account_id: str, current_user: User = Depends(get_current_user)
):
    bot = await _get_bot(current_user)
    try:
        await bot.delete_tracked_account(account_id)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=_http_error_detail(exc)) from exc
    return await bot.get_state()


@router.post("/live/discovery/debug", response_model=PolymarketDiscoveryDebugReport)
async def debug_polymarket_discovery(
    request: PolymarketDiscoveryDebugRequest,
    current_user: User = Depends(get_current_user),
):
    bot = await _get_bot(current_user)
    try:
        return await bot.debug_discovery(request.target)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=_http_error_detail(exc)) from exc
