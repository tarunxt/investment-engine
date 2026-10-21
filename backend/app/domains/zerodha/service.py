from __future__ import annotations

from app.core.recovery import (
    recovery_mode, manual_zerodha_orders_enabled, require_zerodha_write_allowed,
)

import hashlib
from datetime import datetime, timedelta, timezone
from typing import Any
from collections.abc import Mapping, Sequence

import httpx

from app.core.config import settings
from app.domains.connections.material import AppMaterial, BoundToken
from app.domains.connections.crypto import ConnectionFault

IST = timezone(timedelta(hours=5, minutes=30))


class KiteError(Exception):
    def __init__(self, message: str, error_type: str = "GeneralException") -> None:
        self.message = message
        self.error_type = error_type
        super().__init__(message)


class ZerodhaService:
    KITE_BASE = "https://api.kite.trade"
    LOGIN_BASE = "https://kite.zerodha.com/connect/login"

    def __init__(self, app_binding: AppMaterial | None = None):
        # No environment credential fallback. Shared apps must be resolved by
        # the versioned platform credential service, then explicitly supplied.
        self._app_binding = app_binding

    @property
    def is_configured(self) -> bool:
        return self._app_binding is not None

    @property
    def direct_market_orders_enabled(self) -> bool:
        recovery_mode()  # malformed recovery configuration still fails closed
        return False  # Stage14 has no activated financial transport

    @property
    def order_submission_blocked_reason(self) -> str | None:
        if recovery_mode() and not manual_zerodha_orders_enabled():
            return (
                "Order submission is disabled during analysis-only recovery. "
                "No orders will be sent to Kite. Trading must be explicitly restored "
                "by the operator before placing orders from Cred-X."
            )
        return 'Financial execution is disabled pending separately reviewed payload-bound order activation.'

    def get_login_url(self) -> str:
        if self._app_binding is None:raise ConnectionFault("CONNECTION_APP_BINDING_REQUIRED")
        return f"{self.LOGIN_BASE}?v=3&api_key={self._app_binding.key.get_secret_value()}"

    def _checksum(self, request_token: str) -> str:
        if self._app_binding is None:raise ConnectionFault("CONNECTION_APP_BINDING_REQUIRED")
        raw = f"{self._app_binding.key.get_secret_value()}{request_token}{self._app_binding.secret.get_secret_value()}"
        return hashlib.sha256(raw.encode()).hexdigest()

    def _auth_headers(self, access_token: BoundToken) -> dict[str, str]:
        if not isinstance(access_token,BoundToken):raise ConnectionFault("CONNECTION_BOUND_TOKEN_REQUIRED")
        access_token.validate()
        from app.domains.modules.execution import _current
        context=_current.get()
        if context is not None:
            if context.identity.owner_id!=access_token.owner_id:raise ConnectionFault("CONNECTION_OWNER_MISMATCH",403)
        if self._app_binding is not None and self._app_binding.fingerprint()!=access_token.app.fingerprint():raise ConnectionFault("CONNECTION_APP_BINDING_CHANGED")
        return {
            "X-Kite-Version": "3",
            "Authorization": f"token {access_token.app.key.get_secret_value()}:{access_token.token.get_secret_value()}",
        }

    def _binding_query(self, token):
        from sqlalchemy import select
        from app.domains.connections.models import IntegrationConnection
        return select(IntegrationConnection.version).where(
            IntegrationConnection.id==token.connection_id,
            IntegrationConnection.owner_id==token.owner_id,
            IntegrationConnection.version==token.version,
            IntegrationConnection.is_current.is_(True),IntegrationConnection.status=='active')

    async def _current_binding_async(self, token):
        from app.domains.modules.execution import _current
        context=_current.get()
        if context is None:return
        factory=context.async_factory
        if factory is None:
            from app.infrastructure.database.session import AsyncSessionLocal
            factory=AsyncSessionLocal
        async with factory() as db:
            if await db.scalar(self._binding_query(token)) is None:raise ConnectionFault('CONNECTION_VERSION_CHANGED')

    def _current_binding_sync(self, token):
        from app.domains.modules.execution import _current
        context=_current.get()
        if context is None:return
        with context.factory() as db:
            if db.scalar(self._binding_query(token)) is None:raise ConnectionFault('CONNECTION_VERSION_CHANGED')

    def _raise_for_kite(self, resp: httpx.Response, redactions=()) -> None:
        try:
            body = resp.json()
        except Exception:
            resp.raise_for_status()
            return
        if body.get("status") == "error":
            message=str(body.get("message", "Unknown Kite error"))
            for secret in redactions:
                if secret:message=message.replace(secret,"[redacted]")
            kind=body.get("error_type", "GeneralException")
            if kind not in {"GeneralException","TokenException","PermissionException","InputException","NetworkException","DataException","OrderException"}:kind="GeneralException"
            raise KiteError(message[:500],kind)
        resp.raise_for_status()

    async def _request_async(
        self,
        method: str,
        path: str,
        *,
        access_token: str | None = None,
        data: dict[str, Any] | None = None,
        params: Mapping[str, Any] | Sequence[tuple[str, Any]] | None = None,
        headers: dict[str, str] | None = None,
        timeout: float = 30.0,
    ) -> Any:
        if method.upper() not in {"GET", "HEAD"} and not (
            method.upper() == "POST" and path == "/session/token"
        ):
            require_zerodha_write_allowed(method.upper(), path, data)
        if method.upper() not in {'GET','HEAD'} and not (path == '/session/token' and method.upper() in {'POST','DELETE'}):
            from app.domains.order_intents.contracts import require_live_financial_disabled
            require_live_financial_disabled()
        request_headers = dict(headers or {})
        if access_token:
            request_headers.update(self._auth_headers(access_token))
            await self._current_binding_async(access_token)

        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.request(
                method,
                f"{self.KITE_BASE}{path}",
                data=data,
                params=params,
                headers=request_headers,
            )
            secrets=[]
            if isinstance(access_token,BoundToken):secrets.extend([access_token.app.key.get_secret_value(),access_token.app.secret.get_secret_value(),access_token.token.get_secret_value()])
            if self._app_binding:secrets.extend([self._app_binding.key.get_secret_value(),self._app_binding.secret.get_secret_value()])
            if path=="/session/token":secrets.extend(str(v) for v in (data or {}).values())
            self._raise_for_kite(resp,secrets)
            return resp.json().get("data")

    def _request_sync(
        self,
        method: str,
        path: str,
        *,
        access_token: str | None = None,
        data: dict[str, Any] | None = None,
        params: Mapping[str, Any] | Sequence[tuple[str, Any]] | None = None,
        headers: dict[str, str] | None = None,
        timeout: float = 30.0,
    ) -> Any:
        if method.upper() not in {"GET", "HEAD"} and not (
            method.upper() == "POST" and path == "/session/token"
        ):
            require_zerodha_write_allowed(method.upper(), path, data)
        if method.upper() not in {'GET','HEAD'} and not (path == '/session/token' and method.upper() in {'POST','DELETE'}):
            from app.domains.order_intents.contracts import require_live_financial_disabled
            require_live_financial_disabled()
        request_headers = dict(headers or {})
        if access_token:
            request_headers.update(self._auth_headers(access_token))
            self._current_binding_sync(access_token)

        with httpx.Client(timeout=timeout) as client:
            resp = client.request(
                method,
                f"{self.KITE_BASE}{path}",
                data=data,
                params=params,
                headers=request_headers,
            )
            secrets=[]
            if isinstance(access_token,BoundToken):secrets.extend([access_token.app.key.get_secret_value(),access_token.app.secret.get_secret_value(),access_token.token.get_secret_value()])
            if self._app_binding:secrets.extend([self._app_binding.key.get_secret_value(),self._app_binding.secret.get_secret_value()])
            if path=="/session/token":secrets.extend(str(v) for v in (data or {}).values())
            self._raise_for_kite(resp,secrets)
            return resp.json().get("data")

    async def exchange_token(self, request_token: str) -> dict:
        checksum = self._checksum(request_token)
        data = await self._request_async(
            "POST",
            "/session/token",
            data={
                "api_key": self._app_binding.key.get_secret_value(),
                "request_token": request_token,
                "checksum": checksum,
            },
            headers={
                "X-Kite-Version": "3",
                "Content-Type": "application/x-www-form-urlencoded",
            },
        )
        return data or {}

    async def get_orders(self, access_token: str) -> list:
        data = await self._request_async("GET", "/orders", access_token=access_token)
        return data or []

    async def get_margins(self, access_token: str) -> dict[str, Any]:
        data = await self._request_async("GET", "/user/margins", access_token=access_token)
        return data or {}

    async def get_quotes(
        self, access_token: str, instruments: list[str]
    ) -> dict[str, Any]:
        params = [("i", instrument) for instrument in instruments]
        data = await self._request_async(
            "GET", "/quote", access_token=access_token, params=params
        )
        return data or {}

    async def get_holdings(self, access_token: str) -> list[dict[str, Any]]:
        data = await self._request_async(
            "GET",
            "/portfolio/holdings",
            access_token=access_token,
        )
        return data or []

    async def get_positions(self, access_token: str) -> dict[str, Any]:
        data = await self._request_async(
            "GET",
            "/portfolio/positions",
            access_token=access_token,
        )
        return data or {}

    def get_holdings_sync(self, access_token: str) -> list[dict[str, Any]]:
        data = self._request_sync(
            "GET",
            "/portfolio/holdings",
            access_token=access_token,
        )
        return data or []

    def get_positions_sync(self, access_token: str) -> dict[str, Any]:
        data = self._request_sync(
            "GET",
            "/portfolio/positions",
            access_token=access_token,
        )
        return data or {}

    def get_margins_sync(self, access_token: str) -> dict[str, Any]:
        data = self._request_sync(
            "GET",
            "/user/margins",
            access_token=access_token,
        )
        return data or {}

    async def place_order(
        self,
        access_token: str,
        order_data: dict,
        *,
        variety: str = "regular",
    ) -> dict:
        data = await self._request_async(
            "POST",
            f"/orders/{variety}",
            access_token=access_token,
            data=order_data,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        return data or {}

    async def invalidate_token(self, access_token: str) -> None:
        """Best-effort: revoke the session on Zerodha's side."""
        try:
            await self._request_async(
                "DELETE",
                "/session/token",
                access_token=access_token,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                timeout=15.0,
            )
        except Exception:
            pass  # fire-and-forget; local record is deleted regardless

    @staticmethod
    def token_expires_at(login_time: datetime) -> datetime:
        """Returns the next 6:00 AM IST after login_time, expressed as UTC."""
        login_ist = login_time.astimezone(IST)
        expiry_ist = login_ist.replace(hour=6, minute=0, second=0, microsecond=0)
        if expiry_ist <= login_ist:
            expiry_ist += timedelta(days=1)
        return expiry_ist.astimezone(timezone.utc)

# Private broker reads and orders need a fresh originating module context;
# connection setup/disconnect remain separate core account operations.
from app.domains.modules.execution import guarded_effect as _module_effect
for _name in ('get_orders','get_margins','get_quotes','get_holdings','get_positions',
              'get_holdings_sync','get_positions_sync','get_margins_sync'):
    setattr(ZerodhaService,_name,_module_effect(getattr(ZerodhaService,_name)))
ZerodhaService.place_order = _module_effect(ZerodhaService.place_order, capability='execute')
