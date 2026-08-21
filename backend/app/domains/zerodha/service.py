from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone
from typing import Any
from collections.abc import Mapping, Sequence

import httpx

from app.core.config import settings

IST = timezone(timedelta(hours=5, minutes=30))


class KiteError(Exception):
    def __init__(self, message: str, error_type: str = "GeneralException") -> None:
        self.message = message
        self.error_type = error_type
        super().__init__(message)


class ZerodhaService:
    KITE_BASE = "https://api.kite.trade"
    LOGIN_BASE = "https://kite.zerodha.com/connect/login"

    @property
    def is_configured(self) -> bool:
        return bool(settings.zerodha_api_key and settings.zerodha_api_secret)

    @property
    def direct_market_orders_enabled(self) -> bool:
        return bool(self.is_configured and settings.zerodha_enable_direct_market_orders)

    def get_login_url(self) -> str:
        return f"{self.LOGIN_BASE}?v=3&api_key={settings.zerodha_api_key}"

    def _checksum(self, request_token: str) -> str:
        raw = f"{settings.zerodha_api_key}{request_token}{settings.zerodha_api_secret}"
        return hashlib.sha256(raw.encode()).hexdigest()

    def _auth_headers(self, access_token: str) -> dict[str, str]:
        return {
            "X-Kite-Version": "3",
            "Authorization": f"token {settings.zerodha_api_key}:{access_token}",
        }

    def _raise_for_kite(self, resp: httpx.Response) -> None:
        try:
            body = resp.json()
        except Exception:
            resp.raise_for_status()
            return
        if body.get("status") == "error":
            raise KiteError(
                body.get("message", "Unknown Kite error"),
                body.get("error_type", "GeneralException"),
            )
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
        request_headers = dict(headers or {})
        if access_token:
            request_headers.update(self._auth_headers(access_token))

        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.request(
                method,
                f"{self.KITE_BASE}{path}",
                data=data,
                params=params,
                headers=request_headers,
            )
            self._raise_for_kite(resp)
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
        request_headers = dict(headers or {})
        if access_token:
            request_headers.update(self._auth_headers(access_token))

        with httpx.Client(timeout=timeout) as client:
            resp = client.request(
                method,
                f"{self.KITE_BASE}{path}",
                data=data,
                params=params,
                headers=request_headers,
            )
            self._raise_for_kite(resp)
            return resp.json().get("data")

    async def exchange_token(self, request_token: str) -> dict:
        checksum = self._checksum(request_token)
        data = await self._request_async(
            "POST",
            "/session/token",
            data={
                "api_key": settings.zerodha_api_key,
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
