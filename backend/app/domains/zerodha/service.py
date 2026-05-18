from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone

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

    async def exchange_token(self, request_token: str) -> dict:
        checksum = self._checksum(request_token)
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{self.KITE_BASE}/session/token",
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
            self._raise_for_kite(resp)
            return resp.json()["data"]

    async def get_orders(self, access_token: str) -> list:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(
                f"{self.KITE_BASE}/orders",
                headers=self._auth_headers(access_token),
            )
            self._raise_for_kite(resp)
            return resp.json().get("data", [])

    async def place_order(self, access_token: str, order_data: dict) -> dict:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{self.KITE_BASE}/orders/regular",
                data=order_data,
                headers={
                    **self._auth_headers(access_token),
                    "Content-Type": "application/x-www-form-urlencoded",
                },
            )
            self._raise_for_kite(resp)
            return resp.json()["data"]

    async def invalidate_token(self, access_token: str) -> None:
        """Best-effort: revoke the session on Zerodha's side."""
        async with httpx.AsyncClient(timeout=15.0) as client:
            try:
                await client.delete(
                    f"{self.KITE_BASE}/session/token",
                    headers={
                        **self._auth_headers(access_token),
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
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
