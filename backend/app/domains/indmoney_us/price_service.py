from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import logging
import re
from typing import Any

import httpx
import json5

logger = logging.getLogger(__name__)


class IndMoneyUsCurrentPriceService:
    GOOGLE_FINANCE_URL = "https://www.google.com/finance/quote/{symbol}:{exchange}"
    USER_AGENT = (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
    )

    def __init__(self, *, timeout_seconds: float = 15.0, max_concurrency: int = 5) -> None:
        self._timeout_seconds = timeout_seconds
        self._max_concurrency = max_concurrency

    async def fetch_quotes(self, quotes: list[dict[str, str]]) -> list[dict[str, Any]]:
        if not quotes:
            return []

        normalized_quotes: list[dict[str, str]] = []
        seen: set[tuple[str, str]] = set()
        for quote in quotes:
            exchange = str(quote.get("exchange") or "").strip().upper()
            symbol = str(quote.get("symbol") or "").strip().upper()
            if not exchange or not symbol:
                continue

            key = (exchange, symbol)
            if key in seen:
                continue

            seen.add(key)
            normalized_quotes.append({"exchange": exchange, "symbol": symbol})

        if not normalized_quotes:
            return []

        semaphore = asyncio.Semaphore(self._max_concurrency)
        async with httpx.AsyncClient(
            follow_redirects=True,
            timeout=self._timeout_seconds,
            headers={
                "User-Agent": self.USER_AGENT,
                "Accept-Language": "en-US,en;q=0.9",
            },
        ) as client:
            tasks = [
                self._fetch_quote_with_limit(
                    semaphore=semaphore,
                    client=client,
                    exchange=quote["exchange"],
                    symbol=quote["symbol"],
                )
                for quote in normalized_quotes
            ]
            return await asyncio.gather(*tasks)

    async def _fetch_quote_with_limit(
        self,
        *,
        semaphore: asyncio.Semaphore,
        client: httpx.AsyncClient,
        exchange: str,
        symbol: str,
    ) -> dict[str, Any]:
        async with semaphore:
            return await self._fetch_quote(client=client, exchange=exchange, symbol=symbol)

    async def _fetch_quote(
        self,
        *,
        client: httpx.AsyncClient,
        exchange: str,
        symbol: str,
    ) -> dict[str, Any]:
        try:
            response = await client.get(
                self.GOOGLE_FINANCE_URL.format(exchange=exchange, symbol=symbol),
            )
            response.raise_for_status()
            return self.parse_quote_page(
                response.text,
                exchange=exchange,
                symbol=symbol,
            )
        except Exception as exc:
            logger.warning(
                "Failed to fetch Google Finance quote for %s:%s: %s",
                exchange,
                symbol,
                exc,
            )
            return {
                "exchange": exchange,
                "symbol": symbol,
                "company_name": None,
                "currency": None,
                "current_price": None,
                "previous_close": None,
                "change_value": None,
                "change_percent": None,
                "market_open": False,
                "session_open_at": None,
                "session_close_at": None,
                "error_message": str(exc)[:300] or "Unable to fetch current price",
            }

    def parse_quote_page(
        self,
        html: str,
        *,
        exchange: str,
        symbol: str,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        quote_dataset = self._extract_dataset(html, dataset_key="ds:2")
        quote_row = self._first_quote_row(quote_dataset)
        if not quote_row:
            raise ValueError(f"Google Finance quote payload missing for {exchange}:{symbol}")

        price_stats = quote_row[5] if len(quote_row) > 5 and isinstance(quote_row[5], list) else []
        session_open_at, session_close_at, market_open = self._extract_session_state(
            self._session_entries_from_quote_row(quote_row),
            now=now,
        )

        return {
            "exchange": exchange,
            "symbol": symbol,
            "company_name": self._optional_str(quote_row[2] if len(quote_row) > 2 else None),
            "currency": self._optional_str(quote_row[4] if len(quote_row) > 4 else None),
            "current_price": self._optional_float(price_stats[0] if len(price_stats) > 0 else None),
            "change_value": self._optional_float(price_stats[1] if len(price_stats) > 1 else None),
            "change_percent": self._optional_float(price_stats[2] if len(price_stats) > 2 else None),
            "previous_close": self._optional_float(quote_row[7] if len(quote_row) > 7 else None),
            "market_open": market_open,
            "session_open_at": session_open_at,
            "session_close_at": session_close_at,
            "error_message": None,
        }

    def _extract_dataset(self, html: str, *, dataset_key: str) -> Any:
        pattern = re.compile(
            rf'<script class="{re.escape(dataset_key)}"[^>]*>\s*'
            rf"AF_initDataCallback\(\{{.*?data:(?P<data>.*?),\s*sideChannel:\s*\{{\}}\}}\);\s*"
            rf"</script>",
            flags=re.DOTALL,
        )
        match = pattern.search(html)
        if not match:
            raise ValueError(f"Google Finance dataset {dataset_key} was not found")

        return json5.loads(match.group("data"))

    @staticmethod
    def _first_quote_row(dataset: Any) -> list[Any] | None:
        if (
            isinstance(dataset, list)
            and dataset
            and isinstance(dataset[0], list)
            and dataset[0]
            and isinstance(dataset[0][0], list)
            and dataset[0][0]
            and isinstance(dataset[0][0][0], list)
        ):
            return dataset[0][0][0]

        return None

    @staticmethod
    def _session_entries_from_quote_row(quote_row: list[Any]) -> Any:
        for value in quote_row:
            if (
                isinstance(value, list)
                and value
                and isinstance(value[0], list)
                and len(value[0]) >= 3
                and value[0][0] == 1
            ):
                return value
        return []

    def _extract_session_state(
        self,
        sessions: Any,
        *,
        now: datetime | None = None,
    ) -> tuple[datetime | None, datetime | None, bool]:
        if not isinstance(sessions, list):
            return None, None, False

        now_utc = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
        latest_open: datetime | None = None
        latest_close: datetime | None = None
        market_open = False

        for session in sessions:
            if not isinstance(session, list) or len(session) < 3 or session[0] != 1:
                continue

            session_open_at = self._parse_google_datetime(session[1])
            session_close_at = self._parse_google_datetime(session[2])
            if session_open_at is None or session_close_at is None:
                continue

            if latest_close is None or session_close_at > latest_close:
                latest_open = session_open_at
                latest_close = session_close_at

            if session_open_at <= now_utc <= session_close_at:
                latest_open = session_open_at
                latest_close = session_close_at
                market_open = True

        return latest_open, latest_close, market_open

    def _parse_google_datetime(self, value: Any) -> datetime | None:
        if not isinstance(value, list) or len(value) < 8:
            return None

        try:
            year = int(value[0])
            month = int(value[1])
            day = int(value[2])
            hour = int(value[3] or 0)
            minute = int(value[4] or 0)
            second = int(value[5] or 0)
            offsets = value[7] if isinstance(value[7], list) else []
            offset_seconds = int(offsets[0]) if offsets else 0
        except (TypeError, ValueError):
            return None

        tzinfo = timezone(timedelta(seconds=offset_seconds))
        return datetime(
            year,
            month,
            day,
            hour,
            minute,
            second,
            tzinfo=tzinfo,
        ).astimezone(timezone.utc)

    @staticmethod
    def _optional_float(value: Any) -> float | None:
        if value in (None, ""):
            return None

        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _optional_str(value: Any) -> str | None:
        if value in (None, ""):
            return None

        return str(value)
