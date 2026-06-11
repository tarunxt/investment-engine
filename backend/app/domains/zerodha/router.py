from __future__ import annotations

import logging
from datetime import date, datetime, time, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User
from app.domains.zerodha.audit import ZerodhaAuditRepository
from app.domains.zerodha.basket import (
    is_kite_quote_permission_error_message,
    prepare_basket_order_from_request,
)
from app.domains.zerodha.models import ZerodhaPortfolioSnapshot
from app.domains.zerodha.order_validation import (
    ZerodhaPriceGuardInput,
    guard_zerodha_limit_price,
)
from app.domains.zerodha.portfolio import current_snapshot_date
from app.domains.zerodha.repository import (
    ZerodhaCredentialRepository,
    ZerodhaPortfolioSnapshotRepository,
)
from app.domains.zerodha.schemas import (
    ZerodhaCallbackRequest,
    ZerodhaLoginUrlResponse,
    ZerodhaPrepareBasketRequest,
    ZerodhaPrepareBasketResponse,
    ZerodhaPreparedBasketOrder,
    ZerodhaPortfolioOverviewResponse,
    ZerodhaPortfolioSnapshotDetailResponse,
    ZerodhaPortfolioSnapshotSummaryResponse,
    ZerodhaPortfolioSyncResponse,
    ZerodhaPortfolioPositions,
    ZerodhaPlaceOrderRequest,
    ZerodhaPlaceOrderResponse,
    ZerodhaStatusResponse,
)
from app.domains.zerodha.service import KiteError, ZerodhaService
from app.domains.zerodha.tasks import sync_portfolio_snapshot_task
from app.infrastructure.database.session import get_async_db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/zerodha", tags=["zerodha"])
_svc = ZerodhaService()

INDIA_MARKET_EXCHANGES = {"NSE", "BSE"}
INDIA_MARKET_TZ = timezone(timedelta(hours=5, minutes=30))
INDIA_MARKET_OPEN = time(9, 15)
INDIA_MARKET_CLOSE = time(15, 30)


def _is_regular_market_open(exchange: str, now: datetime | None = None) -> bool:
    """Return whether regular equity market orders are currently accepted.

    We intentionally keep this deterministic and conservative for Zerodha India
    equity basket orders. Exchange holidays are still enforced by Kite; outside
    normal weekday NSE/BSE hours we use AMO when requested by the client.
    """
    if exchange.upper() not in INDIA_MARKET_EXCHANGES:
        return True
    current = (now or datetime.now(tz=timezone.utc)).astimezone(INDIA_MARKET_TZ)
    if current.weekday() >= 5:
        return False
    current_time = current.time()
    return INDIA_MARKET_OPEN <= current_time <= INDIA_MARKET_CLOSE


def _instrument_key(exchange: str, tradingsymbol: str) -> str:
    return f"{exchange.upper()}:{tradingsymbol.upper()}"


def _quote_number(quote: dict, key: str) -> float | None:
    value = quote.get(key)
    return float(value) if isinstance(value, (int, float)) and value > 0 else None


def _prepared_basket_order_from_quote(order, quote: dict) -> ZerodhaPreparedBasketOrder:
    last_price = _quote_number(quote, "last_price") or order.price
    guard = guard_zerodha_limit_price(
        ZerodhaPriceGuardInput(
            side=order.transaction_type,
            requested_price=order.price,
            last_price=last_price,
            lower_circuit_limit=_quote_number(quote, "lower_circuit_limit"),
            upper_circuit_limit=_quote_number(quote, "upper_circuit_limit"),
            tick_size=_quote_number(quote, "tick_size"),
        )
    )
    return ZerodhaPreparedBasketOrder(
        tradingsymbol=order.tradingsymbol.upper(),
        exchange=order.exchange.upper(),
        transaction_type=order.transaction_type,
        quantity=order.quantity,
        requested_price=order.price,
        price=guard.price,
        last_price=last_price,
        tick_size=guard.tick_size,
        lower_circuit_limit=guard.lower_circuit_limit,
        upper_circuit_limit=guard.upper_circuit_limit,
        adjusted=guard.adjusted,
        reasons=list(guard.reasons),
    )


def _client_ip(request: Request) -> str | None:
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    if request.client:
        return request.client.host
    return None


def _snapshot_summary(
    snapshot: ZerodhaPortfolioSnapshot,
) -> ZerodhaPortfolioSnapshotSummaryResponse:
    return ZerodhaPortfolioSnapshotSummaryResponse(
        snapshot_date=snapshot.snapshot_date,
        captured_at=snapshot.captured_at,
        source=snapshot.source,
        holdings_count=snapshot.holdings_count,
        net_positions_count=snapshot.net_positions_count,
        day_positions_count=snapshot.day_positions_count,
        holdings_market_value=snapshot.holdings_market_value,
        holdings_pnl=snapshot.holdings_pnl,
        holdings_day_change_value=snapshot.holdings_day_change_value,
        available_margin=snapshot.available_margin or 0.0,
        positions_pnl=snapshot.positions_pnl,
        positions_m2m=snapshot.positions_m2m,
    )


def _snapshot_detail(
    snapshot: ZerodhaPortfolioSnapshot,
) -> ZerodhaPortfolioSnapshotDetailResponse:
    return ZerodhaPortfolioSnapshotDetailResponse(
        **_snapshot_summary(snapshot).model_dump(),
        holdings=snapshot.holdings or [],
        positions=ZerodhaPortfolioPositions(
            net=snapshot.net_positions or [],
            day=snapshot.day_positions or [],
        ),
    )


@router.get("/login-url", response_model=ZerodhaLoginUrlResponse)
async def get_login_url(current_user: User = Depends(get_current_user)):
    return ZerodhaLoginUrlResponse(
        login_url=_svc.get_login_url() if _svc.is_configured else "",
        configured=_svc.is_configured,
    )


@router.post("/callback", response_model=ZerodhaStatusResponse)
async def callback(
    request: Request,
    body: ZerodhaCallbackRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    if not _svc.is_configured:
        raise HTTPException(503, detail="Zerodha is not configured on this server")

    ip = _client_ip(request)
    audit = ZerodhaAuditRepository(db)

    try:
        data = await _svc.exchange_token(body.request_token)
    except KiteError as exc:
        await audit.log(
            current_user.id, "token_exchange_failed", ip, {"error": exc.message}
        )
        await db.commit()
        raise HTTPException(400, detail=exc.message)
    except Exception:
        logger.exception("Zerodha token exchange failed for user %s", current_user.id)
        await audit.log(
            current_user.id, "token_exchange_failed", ip, {"error": "unexpected"}
        )
        await db.commit()
        raise HTTPException(502, detail="Token exchange with Zerodha failed")

    login_time = datetime.now(tz=timezone.utc)
    expires_at = ZerodhaService.token_expires_at(login_time)
    access_token: str = data.get("access_token", "")

    repo = ZerodhaCredentialRepository(db)
    await repo.upsert(current_user.id, access_token, login_time, expires_at)
    await audit.log(
        current_user.id, "token_exchange", ip, {"expires_at": expires_at.isoformat()}
    )
    await db.commit()

    try:
        task = sync_portfolio_snapshot_task.delay(current_user.id, "login")  # type: ignore[attr-defined]
        logger.info(
            "Queued Zerodha login portfolio sync for user %s (task_id=%s)",
            current_user.id,
            task.id,
        )
    except Exception:
        logger.exception(
            "Failed to queue Zerodha login portfolio sync for user %s", current_user.id
        )

    logger.info(
        "Zerodha connected for user %s, expires %s", current_user.id, expires_at
    )
    return ZerodhaStatusResponse(
        connected=True, login_time=login_time, expires_at=expires_at
    )


@router.get("/status", response_model=ZerodhaStatusResponse)
async def get_status(
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    repo = ZerodhaCredentialRepository(db)
    snapshot_repo = ZerodhaPortfolioSnapshotRepository(db)
    cred = await repo.get_by_user(current_user.id)
    latest_snapshot = await snapshot_repo.get_latest_by_user(current_user.id)
    snapshot_meta = {
        "last_portfolio_sync_at": (
            latest_snapshot.captured_at if latest_snapshot else None
        ),
        "last_portfolio_snapshot_date": (
            latest_snapshot.snapshot_date if latest_snapshot else None
        ),
    }
    if not cred:
        return ZerodhaStatusResponse(connected=False, **snapshot_meta)
    if cred.expires_at <= datetime.now(tz=timezone.utc):
        return ZerodhaStatusResponse(connected=False, **snapshot_meta)
    return ZerodhaStatusResponse(
        connected=True,
        login_time=cred.login_time,
        expires_at=cred.expires_at,
        **snapshot_meta,
    )


@router.get("/portfolio", response_model=ZerodhaPortfolioOverviewResponse)
async def get_portfolio_overview(
    limit: int = 30,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    snapshot_repo = ZerodhaPortfolioSnapshotRepository(db)
    snapshots = await snapshot_repo.list_by_user(
        current_user.id, limit=min(max(limit, 1), 120)
    )
    latest = _snapshot_detail(snapshots[0]) if snapshots else None
    return ZerodhaPortfolioOverviewResponse(
        latest=latest,
        history=[_snapshot_summary(snapshot) for snapshot in snapshots],
    )


@router.post("/portfolio/sync", response_model=ZerodhaPortfolioSyncResponse)
async def queue_portfolio_sync(
    request: Request,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    ip = _client_ip(request)
    repo = ZerodhaCredentialRepository(db)
    audit = ZerodhaAuditRepository(db)
    cred = await repo.get_by_user(current_user.id)

    if not cred or cred.expires_at <= datetime.now(tz=timezone.utc):
        raise HTTPException(401, detail="Zerodha session expired. Please login again.")

    snapshot_date = current_snapshot_date()
    try:
        task = sync_portfolio_snapshot_task.delay(current_user.id, "manual")  # type: ignore[attr-defined]
    except Exception:
        logger.exception(
            "Failed to queue Zerodha portfolio sync for user %s", current_user.id
        )
        await audit.log(
            current_user.id,
            "portfolio_sync_queue_failed",
            ip,
            {"source": "manual", "snapshot_date": snapshot_date.isoformat()},
        )
        await db.commit()
        raise HTTPException(502, detail="Failed to queue portfolio sync")

    await audit.log(
        current_user.id,
        "portfolio_sync_queued",
        ip,
        {
            "source": "manual",
            "snapshot_date": snapshot_date.isoformat(),
            "task_id": task.id,
        },
    )
    await db.commit()

    return ZerodhaPortfolioSyncResponse(
        status="queued",
        message="Portfolio sync queued",
        snapshot_date=snapshot_date,
        task_id=task.id,
    )


@router.get(
    "/portfolio/{snapshot_date}", response_model=ZerodhaPortfolioSnapshotDetailResponse
)
async def get_portfolio_snapshot(
    snapshot_date: date,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    snapshot_repo = ZerodhaPortfolioSnapshotRepository(db)
    snapshot = await snapshot_repo.get_by_user_and_date(current_user.id, snapshot_date)
    if not snapshot:
        raise HTTPException(404, detail="Portfolio snapshot not found")
    return _snapshot_detail(snapshot)


@router.get("/orders")
async def get_orders(
    request: Request,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    ip = _client_ip(request)
    repo = ZerodhaCredentialRepository(db)
    audit = ZerodhaAuditRepository(db)

    token = await repo.get_plaintext_token(current_user.id)
    if not token:
        raise HTTPException(401, detail="Not connected to Zerodha. Please login first.")

    await audit.log(current_user.id, "token_used", ip, {"operation": "get_orders"})

    try:
        orders = await _svc.get_orders(token)
    except KiteError as exc:
        await audit.log(
            current_user.id, "get_orders_failed", ip, {"error": exc.message}
        )
        await db.commit()
        raise HTTPException(400, detail=exc.message)
    except Exception:
        logger.exception("Failed to fetch Zerodha orders for user %s", current_user.id)
        await audit.log(
            current_user.id, "get_orders_failed", ip, {"error": "unexpected"}
        )
        await db.commit()
        raise HTTPException(502, detail="Failed to fetch orders from Zerodha")

    await audit.log(current_user.id, "get_orders", ip, {"count": len(orders)})
    await db.commit()
    return {"data": orders}


@router.post("/orders/prepare-basket", response_model=ZerodhaPrepareBasketResponse)
async def prepare_basket_orders(
    request: Request,
    body: ZerodhaPrepareBasketRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    ip = _client_ip(request)
    repo = ZerodhaCredentialRepository(db)
    audit = ZerodhaAuditRepository(db)

    token = await repo.get_plaintext_token(current_user.id)
    if not token:
        raise HTTPException(401, detail="Not connected to Zerodha. Please login first.")

    if not body.orders:
        return ZerodhaPrepareBasketResponse(orders=[], adjusted_count=0)

    instruments = [
        _instrument_key(order.exchange, order.tradingsymbol) for order in body.orders
    ]
    await audit.log(
        current_user.id,
        "token_used",
        ip,
        {"operation": "prepare_basket_orders", "count": len(instruments)},
    )

    quote_permission_error: KiteError | None = None
    try:
        quotes = await _svc.get_quotes(token, instruments)
    except KiteError as exc:
        if is_kite_quote_permission_error_message(exc.message):
            quote_permission_error = exc
            quotes = {}
        else:
            await audit.log(
                current_user.id,
                "prepare_basket_orders_failed",
                ip,
                {"error": exc.message},
            )
            await db.commit()
            raise HTTPException(400, detail=exc.message)
    except Exception:
        logger.exception(
            "Failed to prepare Zerodha basket orders for user %s", current_user.id
        )
        await audit.log(
            current_user.id, "prepare_basket_orders_failed", ip, {"error": "unexpected"}
        )
        await db.commit()
        raise HTTPException(502, detail="Failed to validate basket orders with Zerodha")

    if quote_permission_error:
        logger.warning(
            "Falling back to requested Zerodha basket prices for user %s because live quote permission is unavailable: %s",
            current_user.id,
            quote_permission_error.message,
        )
        await audit.log(
            current_user.id,
            "prepare_basket_orders_quote_fallback",
            ip,
            {"error": quote_permission_error.message, "count": len(instruments)},
        )

    prepared_orders: list[ZerodhaPreparedBasketOrder] = []
    for order in body.orders:
        key = _instrument_key(order.exchange, order.tradingsymbol)
        quote = quotes.get(key)
        if quote_permission_error:
            try:
                prepared_orders.append(prepare_basket_order_from_request(order))
                continue
            except ValueError as exc:
                await audit.log(
                    current_user.id,
                    "prepare_basket_orders_failed",
                    ip,
                    {"error": str(exc), "instrument": key},
                )
                await db.commit()
                raise HTTPException(
                    400, detail=f"Could not compute a safe order price for {key}: {exc}"
                )
        if not isinstance(quote, dict):
            await audit.log(
                current_user.id,
                "prepare_basket_orders_failed",
                ip,
                {"error": f"missing_quote:{key}"},
            )
            await db.commit()
            raise HTTPException(
                400, detail=f"Could not fetch live Zerodha quote for {key}"
            )
        try:
            prepared_orders.append(_prepared_basket_order_from_quote(order, quote))
        except ValueError as exc:
            await audit.log(
                current_user.id,
                "prepare_basket_orders_failed",
                ip,
                {"error": str(exc), "instrument": key},
            )
            await db.commit()
            raise HTTPException(
                400, detail=f"Could not compute a safe order price for {key}: {exc}"
            )

    adjusted_count = sum(1 for order in prepared_orders if order.adjusted)
    await audit.log(
        current_user.id,
        "prepare_basket_orders",
        ip,
        {"count": len(prepared_orders), "adjusted_count": adjusted_count},
    )
    await db.commit()
    return ZerodhaPrepareBasketResponse(
        orders=prepared_orders, adjusted_count=adjusted_count
    )


@router.post("/orders", response_model=ZerodhaPlaceOrderResponse)
async def place_order(
    request: Request,
    body: ZerodhaPlaceOrderRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    ip = _client_ip(request)
    repo = ZerodhaCredentialRepository(db)
    audit = ZerodhaAuditRepository(db)

    token = await repo.get_plaintext_token(current_user.id)
    if not token:
        raise HTTPException(401, detail="Not connected to Zerodha. Please login first.")

    exchange = body.exchange.upper()
    requested_variety = body.variety.lower()
    market_open = _is_regular_market_open(exchange)
    variety = (
        "amo"
        if requested_variety == "regular"
        and body.auto_amo_when_closed
        and not market_open
        else requested_variety
    )

    order_data: dict[str, str] = {
        "tradingsymbol": body.tradingsymbol.upper(),
        "exchange": exchange,
        "transaction_type": body.transaction_type,
        "order_type": body.order_type,
        "quantity": str(body.quantity),
        "product": body.product,
        "validity": body.validity,
    }
    if body.order_type in {"MARKET", "SL-M"}:
        order_data["market_protection"] = str(
            body.market_protection if body.market_protection else -1
        )
    if body.price:
        order_data["price"] = str(body.price)
    if body.trigger_price:
        order_data["trigger_price"] = str(body.trigger_price)
    if body.market_protection:
        order_data["market_protection"] = str(body.market_protection)

    order_meta = {
        "tradingsymbol": order_data["tradingsymbol"],
        "exchange": order_data["exchange"],
        "transaction_type": order_data["transaction_type"],
        "order_type": order_data["order_type"],
        "quantity": body.quantity,
        "product": order_data["product"],
        "variety": variety,
        "market_open": market_open,
        "auto_converted_to_amo": requested_variety != variety,
    }
    await audit.log(
        current_user.id, "token_used", ip, {"operation": "place_order", **order_meta}
    )

    try:
        result = await _svc.place_order(token, order_data, variety=variety)
    except KiteError as exc:
        await audit.log(
            current_user.id,
            "place_order_failed",
            ip,
            {"error": exc.message, **order_meta},
        )
        await db.commit()
        raise HTTPException(400, detail=exc.message)
    except Exception:
        logger.exception("Failed to place Zerodha order for user %s", current_user.id)
        await audit.log(
            current_user.id,
            "place_order_failed",
            ip,
            {"error": "unexpected", **order_meta},
        )
        await db.commit()
        raise HTTPException(502, detail="Failed to place order on Zerodha")

    order_id = result.get("order_id", "")
    await audit.log(
        current_user.id, "place_order", ip, {"order_id": order_id, **order_meta}
    )
    await db.commit()

    logger.info("Order placed for user %s: %s", current_user.id, result)
    return ZerodhaPlaceOrderResponse(
        order_id=order_id,
        variety=variety,
        market_open=market_open,
        auto_converted_to_amo=requested_variety != variety,
    )


@router.delete("/disconnect")
async def disconnect(
    request: Request,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    ip = _client_ip(request)
    repo = ZerodhaCredentialRepository(db)
    audit = ZerodhaAuditRepository(db)

    token = await repo.get_plaintext_token(current_user.id)
    if token:
        await audit.log(current_user.id, "token_used", ip, {"operation": "disconnect"})
        await _svc.invalidate_token(token)
        await repo.delete_by_user(current_user.id)
        await audit.log(current_user.id, "disconnect", ip)
        await db.commit()
        logger.info("Zerodha disconnected for user %s", current_user.id)
    return {"message": "Disconnected from Zerodha"}


@router.get("/audit-logs")
async def get_audit_logs(
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
    limit: int = 100,
):
    audit = ZerodhaAuditRepository(db)
    logs = await audit.get_by_user(current_user.id, limit=min(limit, 500))
    return {
        "data": [
            {
                "id": e.id,
                "action": e.action,
                "ip_address": e.ip_address,
                "details": e.details,
                "created_at": e.created_at.isoformat(),
            }
            for e in logs
        ]
    }
