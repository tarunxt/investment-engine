from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User
from app.domains.zerodha.audit import ZerodhaAuditRepository
from app.domains.zerodha.repository import ZerodhaCredentialRepository
from app.domains.zerodha.schemas import (
    ZerodhaCallbackRequest,
    ZerodhaLoginUrlResponse,
    ZerodhaPlaceOrderRequest,
    ZerodhaPlaceOrderResponse,
    ZerodhaStatusResponse,
)
from app.domains.zerodha.service import KiteError, ZerodhaService
from app.infrastructure.database.session import get_async_db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/zerodha", tags=["zerodha"])
_svc = ZerodhaService()


def _client_ip(request: Request) -> str | None:
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    if request.client:
        return request.client.host
    return None


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
        await audit.log(current_user.id, "token_exchange_failed", ip, {"error": exc.message})
        await db.commit()
        raise HTTPException(400, detail=exc.message)
    except Exception:
        logger.exception("Zerodha token exchange failed for user %s", current_user.id)
        await audit.log(current_user.id, "token_exchange_failed", ip, {"error": "unexpected"})
        await db.commit()
        raise HTTPException(502, detail="Token exchange with Zerodha failed")

    login_time = datetime.now(tz=timezone.utc)
    expires_at = ZerodhaService.token_expires_at(login_time)
    access_token: str = data.get("access_token", "")

    repo = ZerodhaCredentialRepository(db)
    await repo.upsert(current_user.id, access_token, login_time, expires_at)
    await audit.log(current_user.id, "token_exchange", ip, {"expires_at": expires_at.isoformat()})
    await db.commit()

    logger.info("Zerodha connected for user %s, expires %s", current_user.id, expires_at)
    return ZerodhaStatusResponse(connected=True, login_time=login_time, expires_at=expires_at)


@router.get("/status", response_model=ZerodhaStatusResponse)
async def get_status(
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    repo = ZerodhaCredentialRepository(db)
    cred = await repo.get_by_user(current_user.id)
    if not cred:
        return ZerodhaStatusResponse(connected=False)
    if cred.expires_at <= datetime.now(tz=timezone.utc):
        return ZerodhaStatusResponse(connected=False)
    return ZerodhaStatusResponse(
        connected=True, login_time=cred.login_time, expires_at=cred.expires_at
    )


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
        await audit.log(current_user.id, "get_orders_failed", ip, {"error": exc.message})
        await db.commit()
        raise HTTPException(400, detail=exc.message)
    except Exception:
        logger.exception("Failed to fetch Zerodha orders for user %s", current_user.id)
        await audit.log(current_user.id, "get_orders_failed", ip, {"error": "unexpected"})
        await db.commit()
        raise HTTPException(502, detail="Failed to fetch orders from Zerodha")

    await audit.log(current_user.id, "get_orders", ip, {"count": len(orders)})
    await db.commit()
    return {"data": orders}


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

    order_data: dict[str, str] = {
        "tradingsymbol": body.tradingsymbol.upper(),
        "exchange": body.exchange.upper(),
        "transaction_type": body.transaction_type,
        "order_type": body.order_type,
        "quantity": str(body.quantity),
        "product": body.product,
        "validity": body.validity,
        "market_protection": "1"
    }
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
    }
    await audit.log(current_user.id, "token_used", ip, {"operation": "place_order", **order_meta})

    try:
        result = await _svc.place_order(token, order_data)
    except KiteError as exc:
        await audit.log(current_user.id, "place_order_failed", ip, {"error": exc.message, **order_meta})
        await db.commit()
        raise HTTPException(400, detail=exc.message)
    except Exception:
        logger.exception("Failed to place Zerodha order for user %s", current_user.id)
        await audit.log(current_user.id, "place_order_failed", ip, {"error": "unexpected", **order_meta})
        await db.commit()
        raise HTTPException(502, detail="Failed to place order on Zerodha")

    order_id = result.get("order_id", "")
    await audit.log(current_user.id, "place_order", ip, {"order_id": order_id, **order_meta})
    await db.commit()

    logger.info("Order placed for user %s: %s", current_user.id, result)
    return ZerodhaPlaceOrderResponse(order_id=order_id)


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
