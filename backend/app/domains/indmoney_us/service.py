from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

from app.domains.indmoney_us.models import IndMoneyUsPortfolioSnapshot

IST = ZoneInfo("Asia/Kolkata")

SUMMARY_LABELS = {
    "current value": "current_value",
    "invested value": "invested_value",
}

RETURN_LABELS = {
    "1d returns": ("day_return_value", "day_return_percent"),
    "total returns": ("total_return_value", "total_return_percent"),
}

HOLDINGS_TABLE_HEADERS = {
    "stock name",
    "market price",
    "invested (qty/price)",
    "current value",
    "total pnl",
    "up arrowdown arrow",
}

HOLDINGS_FOOTER_LINES = {
    "trading and brokerage services provided by",
    "banking and remittance services provided by",
    "products",
    "legal & regulatory",
    "my us stocks investments - indmoney",
}

HOLDINGS_FOOTER_PREFIXES = (
    "disclaimer:",
    "*remittance service offered by",
    "all rights reserved |",
)

NOISE_LINES = {
    "wallet",
    "toggle-visibility",
    "add money",
    "/",
}

TICKER_RE = re.compile(r"^[A-Z][A-Z0-9.-]{0,9}$")
NUMBER_RE = re.compile(r"[+-]?\d[\d,]*(?:\.\d+)?")
MONEY_RE = re.compile(r"([+-]?)\s*(?:\$|₹)?\s*([\d,]+(?:\.\d+)?)")
PERCENT_RE = re.compile(r"([▲▼+-]?)\s*([\d,]+(?:\.\d+)?)%")
RETURN_RE = re.compile(
    r"([+-]?\s*(?:\$|₹)?\s*[\d,]+(?:\.\d+)?)\s*\(([^)]+)\)"
)
QTY_RE = re.compile(r"([\d,]+(?:\.\d+)?)\s*qty\b", re.IGNORECASE)
AVG_RE = re.compile(r"((?:\$|₹)?\s*[\d,]+(?:\.\d+)?)\s*avg\.?", re.IGNORECASE)


class IndMoneyUsPortfolioService:
    def parse_snapshot(
        self,
        raw_text: str,
        *,
        captured_at: datetime | None = None,
        source: str = "manual_paste",
    ) -> dict[str, Any]:
        normalized_text = raw_text.replace("\r\n", "\n").strip()
        lines = self._normalized_lines(normalized_text)
        captured = self._normalize_captured_at(captured_at)

        market_indices = self._parse_market_indices(lines)
        summary = self._parse_summary(lines)
        holdings = self._parse_holdings(lines)
        holdings = self._enrich_holdings(holdings, summary.get("current_value"))
        derived = self._build_derived(holdings, summary)
        warnings = self._build_warnings(summary, holdings, derived)
        parse_status = self._build_parse_status(summary, holdings, market_indices, warnings)

        return {
            "snapshot_date": captured.astimezone(IST).date(),
            "captured_at": captured,
            "source": source,
            "raw_text": normalized_text,
            "parse_status": parse_status,
            "parse_warnings": warnings,
            "holdings_count": len(holdings),
            "reported_holdings_count": summary.get("reported_holdings_count"),
            "indices_count": len(market_indices),
            "wallet_balance": summary.get("wallet_balance"),
            "current_value": summary.get("current_value"),
            "invested_value": summary.get("invested_value"),
            "day_return_value": summary.get("day_return_value"),
            "day_return_percent": summary.get("day_return_percent"),
            "total_return_value": summary.get("total_return_value"),
            "total_return_percent": summary.get("total_return_percent"),
            "market_indices": market_indices,
            "holdings": holdings,
        }

    def serialize_summary(
        self,
        snapshot: IndMoneyUsPortfolioSnapshot,
    ) -> dict[str, Any]:
        return {
            "id": snapshot.id,
            "snapshot_date": snapshot.snapshot_date,
            "captured_at": snapshot.captured_at,
            "source": snapshot.source,
            "parse_status": snapshot.parse_status,
            "parse_warnings": snapshot.parse_warnings or [],
            "holdings_count": snapshot.holdings_count,
            "reported_holdings_count": snapshot.reported_holdings_count,
            "indices_count": snapshot.indices_count,
            "wallet_balance": snapshot.wallet_balance,
            "current_value": snapshot.current_value,
            "invested_value": snapshot.invested_value,
            "day_return_value": snapshot.day_return_value,
            "day_return_percent": snapshot.day_return_percent,
            "total_return_value": snapshot.total_return_value,
            "total_return_percent": snapshot.total_return_percent,
        }

    def serialize_detail(
        self,
        snapshot: IndMoneyUsPortfolioSnapshot,
    ) -> dict[str, Any]:
        holdings = self._enrich_holdings(snapshot.holdings or [], snapshot.current_value)
        summary = {
            "wallet_balance": snapshot.wallet_balance,
            "current_value": snapshot.current_value,
            "invested_value": snapshot.invested_value,
            "day_return_value": snapshot.day_return_value,
            "day_return_percent": snapshot.day_return_percent,
            "total_return_value": snapshot.total_return_value,
            "total_return_percent": snapshot.total_return_percent,
            "reported_holdings_count": snapshot.reported_holdings_count,
        }
        return {
            **self.serialize_summary(snapshot),
            "raw_text": snapshot.raw_text,
            "market_indices": snapshot.market_indices or [],
            "holdings": holdings,
            "derived": self._build_derived(holdings, summary),
        }

    @staticmethod
    def _normalize_captured_at(captured_at: datetime | None) -> datetime:
        if captured_at is None:
            return datetime.now(tz=timezone.utc)
        if captured_at.tzinfo is None:
            return captured_at.replace(tzinfo=timezone.utc)
        return captured_at.astimezone(timezone.utc)

    @staticmethod
    def _normalized_lines(raw_text: str) -> list[str]:
        return [
            re.sub(r"\s+", " ", line).strip()
            for line in raw_text.splitlines()
            if re.sub(r"\s+", " ", line).strip()
        ]

    def _parse_market_indices(self, lines: list[str]) -> list[dict[str, Any]]:
        stop_markers = {"explore & invest", "my us stocks", "selected", "transactions"}
        scan_upto = len(lines)
        for index, line in enumerate(lines):
            if line.casefold() in stop_markers:
                scan_upto = index
                break

        indices: list[dict[str, Any]] = []
        cursor = 0
        while cursor + 2 < scan_upto:
            name = lines[cursor]
            value_line = lines[cursor + 1]
            change_line = lines[cursor + 2]

            if (
                self._is_plain_label(name)
                and self._looks_like_number(value_line)
                and "%" in change_line
            ):
                indices.append(
                    {
                        "name": name,
                        "value": self._parse_number(value_line),
                        "change_value": self._parse_prefix_number(change_line),
                        "change_percent": self._parse_percent(change_line),
                        "raw_change_text": change_line,
                    }
                )
                cursor += 3
                continue

            cursor += 1

        return indices

    def _parse_summary(self, lines: list[str]) -> dict[str, Any]:
        summary: dict[str, Any] = {
            "wallet_balance": self._parse_wallet_balance(lines),
            "reported_holdings_count": self._parse_reported_holdings_count(lines),
        }

        for label, field_name in SUMMARY_LABELS.items():
            value_line = self._find_following_line(lines, label, self._looks_like_money)
            summary[field_name] = self._parse_money(value_line) if value_line else None

        for label, fields in RETURN_LABELS.items():
            value_line = self._find_following_line(lines, label, lambda line: "%" in line)
            if not value_line:
                summary[fields[0]] = None
                summary[fields[1]] = None
                continue
            change_value, change_percent = self._parse_change_with_percent(value_line)
            summary[fields[0]] = change_value
            summary[fields[1]] = change_percent

        return summary

    def _parse_wallet_balance(self, lines: list[str]) -> float | None:
        current_value_idx = next(
            (index for index, line in enumerate(lines) if line.casefold() == "current value"),
            len(lines),
        )
        for index, line in enumerate(lines[:current_value_idx]):
            if line.casefold() != "wallet":
                continue
            candidate = self._find_next_matching(
                lines,
                start=index + 1,
                end=current_value_idx,
                predicate=self._looks_like_money,
            )
            if candidate:
                return self._parse_money(candidate)
        return None

    def _parse_reported_holdings_count(self, lines: list[str]) -> int | None:
        for line in lines:
            match = re.search(r"current holdings\s*\((\d+)\)", line, re.IGNORECASE)
            if match:
                return int(match.group(1))
        return None

    def _parse_holdings(self, lines: list[str]) -> list[dict[str, Any]]:
        start = next(
            (index for index, line in enumerate(lines) if "current holdings" in line.casefold()),
            -1,
        )
        if start < 0:
            return []

        end = len(lines)
        for index in range(start + 1, len(lines)):
            line = lines[index].casefold()
            if line in HOLDINGS_FOOTER_LINES or any(
                line.startswith(marker) for marker in HOLDINGS_FOOTER_PREFIXES
            ):
                end = index
                break

        block = [
            line
            for line in lines[start + 1 : end]
            if line.casefold() not in HOLDINGS_TABLE_HEADERS
        ]

        holdings: list[dict[str, Any]] = []
        cursor = 0

        while cursor < len(block):
            if block[cursor].casefold() in NOISE_LINES:
                cursor += 1
                continue

            name_lines: list[str] = []
            while cursor < len(block) and not self._is_ticker(block[cursor]):
                if block[cursor].casefold() not in NOISE_LINES:
                    name_lines.append(block[cursor])
                cursor += 1
                if len(name_lines) > 4:
                    break

            if cursor >= len(block):
                break

            ticker = block[cursor]
            if not self._is_ticker(ticker):
                cursor += 1
                continue

            cursor += 1
            record: dict[str, Any] = {
                "company_name": self._select_company_name(name_lines, ticker),
                "symbol": ticker,
                "market_price": None,
                "market_change_percent": None,
                "invested_value": None,
                "quantity": None,
                "average_price": None,
                "current_value": None,
                "total_pnl": None,
                "total_pnl_percent": None,
            }

            if cursor < len(block) and self._looks_like_money(block[cursor]):
                record["market_price"] = self._parse_money(block[cursor])
                cursor += 1

            if cursor < len(block) and "%" in block[cursor]:
                record["market_change_percent"] = self._parse_percent(block[cursor])
                cursor += 1

            if cursor < len(block) and self._looks_like_money(block[cursor]):
                record["invested_value"] = self._parse_money(block[cursor])
                cursor += 1

            if cursor < len(block):
                quantity = self._parse_quantity(block[cursor])
                if quantity is not None:
                    record["quantity"] = quantity
                    cursor += 1

            if cursor < len(block):
                average_price = self._parse_average_price(block[cursor])
                if average_price is not None:
                    record["average_price"] = average_price
                    cursor += 1

            if cursor < len(block) and self._looks_like_money(block[cursor]):
                record["current_value"] = self._parse_money(block[cursor])
                cursor += 1

            if cursor < len(block) and self._looks_like_signed_money(block[cursor]):
                record["total_pnl"] = self._parse_money(block[cursor])
                cursor += 1

            if cursor < len(block) and "%" in block[cursor]:
                record["total_pnl_percent"] = self._parse_percent(block[cursor])
                cursor += 1

            if not any(
                record.get(field) is not None
                for field in (
                    "market_price",
                    "invested_value",
                    "quantity",
                    "average_price",
                    "current_value",
                    "total_pnl",
                )
            ):
                continue

            self._backfill_holding(record)
            holdings.append(record)

        holdings.sort(key=lambda item: item.get("current_value") or 0, reverse=True)
        return holdings

    def _backfill_holding(self, record: dict[str, Any]) -> None:
        quantity = record.get("quantity")
        market_price = record.get("market_price")
        invested_value = record.get("invested_value")
        average_price = record.get("average_price")
        current_value = record.get("current_value")
        total_pnl = record.get("total_pnl")

        if average_price is None and invested_value is not None and quantity not in (None, 0):
            record["average_price"] = invested_value / quantity
            average_price = record["average_price"]

        if current_value is None and market_price is not None and quantity not in (None, 0):
            record["current_value"] = market_price * quantity
            current_value = record["current_value"]

        if invested_value is None and average_price is not None and quantity not in (None, 0):
            record["invested_value"] = average_price * quantity
            invested_value = record["invested_value"]

        if total_pnl is None and current_value is not None and invested_value is not None:
            record["total_pnl"] = current_value - invested_value
            total_pnl = record["total_pnl"]

        if (
            record.get("total_pnl_percent") is None
            and invested_value not in (None, 0)
            and total_pnl is not None
        ):
            record["total_pnl_percent"] = (total_pnl / invested_value) * 100

    def _enrich_holdings(
        self,
        holdings: list[dict[str, Any]],
        summary_current_value: float | None,
    ) -> list[dict[str, Any]]:
        copied = [dict(holding) for holding in holdings]
        parsed_current_value = sum((holding.get("current_value") or 0) for holding in copied)
        denominator = parsed_current_value or summary_current_value or 0

        for holding in copied:
            current_value = holding.get("current_value")
            average_price = holding.get("average_price")
            market_price = holding.get("market_price")
            if denominator and current_value is not None:
                holding["portfolio_weight_percent"] = (current_value / denominator) * 100
            else:
                holding["portfolio_weight_percent"] = None

            if average_price not in (None, 0) and market_price is not None:
                holding["price_vs_average_percent"] = ((market_price - average_price) / average_price) * 100
            else:
                holding["price_vs_average_percent"] = None

        copied.sort(key=lambda item: item.get("current_value") or 0, reverse=True)
        return copied

    def _build_derived(
        self,
        holdings: list[dict[str, Any]],
        summary: dict[str, Any],
    ) -> dict[str, Any]:
        parsed_current_value = sum((holding.get("current_value") or 0) for holding in holdings)
        parsed_invested_value = sum((holding.get("invested_value") or 0) for holding in holdings)
        parsed_total_pnl = sum((holding.get("total_pnl") or 0) for holding in holdings)

        profitable_holdings = [holding for holding in holdings if (holding.get("total_pnl") or 0) > 0]
        loss_making_holdings = [holding for holding in holdings if (holding.get("total_pnl") or 0) < 0]

        return {
            "parsed_holdings_current_value": parsed_current_value,
            "parsed_holdings_invested_value": parsed_invested_value,
            "parsed_holdings_total_pnl": parsed_total_pnl,
            "profitable_holdings_count": len(profitable_holdings),
            "loss_making_holdings_count": len(loss_making_holdings),
            "top_allocations": holdings[:8],
            "top_gainers": sorted(
                holdings,
                key=lambda item: item.get("total_pnl") or float("-inf"),
                reverse=True,
            )[:5],
            "top_laggards": sorted(
                holdings,
                key=lambda item: item.get("total_pnl") or float("inf"),
            )[:5],
            "reconciliation": self._build_reconciliation(
                summary=summary,
                parsed_current_value=parsed_current_value,
                parsed_invested_value=parsed_invested_value,
                parsed_total_pnl=parsed_total_pnl,
                parsed_holdings_count=len(holdings),
            ),
        }

    def _build_reconciliation(
        self,
        *,
        summary: dict[str, Any],
        parsed_current_value: float,
        parsed_invested_value: float,
        parsed_total_pnl: float,
        parsed_holdings_count: int,
    ) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        for label, summary_key, parsed_value in (
            ("Current Value", "current_value", parsed_current_value),
            ("Invested Value", "invested_value", parsed_invested_value),
            ("Total Returns", "total_return_value", parsed_total_pnl),
            (
                "Holdings Count",
                "reported_holdings_count",
                float(parsed_holdings_count),
            ),
        ):
            summary_value = summary.get(summary_key)
            if summary_value is None and parsed_value == 0:
                continue
            delta = None
            if summary_value is not None:
                delta = summary_value - parsed_value
            items.append(
                {
                    "label": label,
                    "summary_value": summary_value,
                    "parsed_value": parsed_value,
                    "delta": delta,
                }
            )
        return items

    def _build_warnings(
        self,
        summary: dict[str, Any],
        holdings: list[dict[str, Any]],
        derived: dict[str, Any],
    ) -> list[str]:
        warnings: list[str] = []
        reported_holdings_count = summary.get("reported_holdings_count")
        if not holdings:
            warnings.append("No holdings rows could be parsed from the pasted snapshot.")
        if reported_holdings_count is not None and reported_holdings_count != len(holdings):
            warnings.append(
                f"Parsed {len(holdings)} holdings but the snapshot reports {reported_holdings_count}."
            )

        for label, summary_key, parsed_key in (
            ("current value", "current_value", "parsed_holdings_current_value"),
            ("invested value", "invested_value", "parsed_holdings_invested_value"),
            ("total returns", "total_return_value", "parsed_holdings_total_pnl"),
        ):
            summary_value = summary.get(summary_key)
            parsed_value = derived.get(parsed_key)
            if summary_value is None or parsed_value is None:
                continue
            if abs(summary_value - parsed_value) > 1:
                warnings.append(
                    f"The pasted {label} does not fully reconcile with parsed holdings totals."
                )

        return warnings

    @staticmethod
    def _build_parse_status(
        summary: dict[str, Any],
        holdings: list[dict[str, Any]],
        market_indices: list[dict[str, Any]],
        warnings: list[str],
    ) -> str:
        has_summary = any(
            summary.get(key) is not None
            for key in (
                "wallet_balance",
                "current_value",
                "invested_value",
                "day_return_value",
                "total_return_value",
                "reported_holdings_count",
            )
        )
        if holdings and not warnings:
            return "parsed"
        if holdings or has_summary or market_indices:
            return "partial"
        return "unparsed"

    @staticmethod
    def _find_following_line(
        lines: list[str],
        label: str,
        predicate,
    ) -> str | None:
        label_folded = label.casefold()
        for index, line in enumerate(lines):
            if line.casefold() != label_folded:
                continue
            candidate = IndMoneyUsPortfolioService._find_next_matching(
                lines,
                start=index + 1,
                end=min(index + 6, len(lines)),
                predicate=predicate,
            )
            if candidate:
                return candidate
        return None

    @staticmethod
    def _find_next_matching(
        lines: list[str],
        *,
        start: int,
        end: int,
        predicate,
    ) -> str | None:
        for line in lines[start:end]:
            if predicate(line):
                return line
        return None

    @staticmethod
    def _select_company_name(name_lines: list[str], ticker: str) -> str:
        unique_names: list[str] = []
        for line in name_lines:
            if line == ticker:
                continue
            if line not in unique_names:
                unique_names.append(line)
        if not unique_names:
            return ticker
        return max(unique_names, key=len)

    @staticmethod
    def _is_plain_label(line: str) -> bool:
        folded = line.casefold()
        return (
            any(character.isalpha() for character in line)
            and "$" not in line
            and "%" not in line
            and "qty" not in folded
            and "avg" not in folded
            and not line.isupper()
        )

    @staticmethod
    def _is_ticker(line: str) -> bool:
        return bool(TICKER_RE.fullmatch(line.strip()))

    @staticmethod
    def _looks_like_number(line: str) -> bool:
        return bool(NUMBER_RE.fullmatch(line.strip()))

    @staticmethod
    def _looks_like_money(line: str) -> bool:
        return bool(MONEY_RE.search(line))

    @staticmethod
    def _looks_like_signed_money(line: str) -> bool:
        stripped = line.strip()
        return stripped.startswith("+") or stripped.startswith("-")

    @staticmethod
    def _parse_number(value: str) -> float | None:
        match = NUMBER_RE.search(value)
        if not match:
            return None
        return float(match.group(0).replace(",", ""))

    @staticmethod
    def _parse_prefix_number(value: str) -> float | None:
        match = NUMBER_RE.match(value.strip())
        if not match:
            return None
        return float(match.group(0).replace(",", ""))

    @staticmethod
    def _parse_money(value: str | None) -> float | None:
        if not value:
            return None
        match = MONEY_RE.search(value)
        if not match:
            return None
        sign = -1 if match.group(1) == "-" else 1
        return sign * float(match.group(2).replace(",", ""))

    @staticmethod
    def _parse_percent(value: str | None) -> float | None:
        if not value:
            return None
        match = PERCENT_RE.search(value)
        if not match:
            return None
        marker = match.group(1)
        sign = -1 if marker in {"-", "▼"} else 1
        return sign * float(match.group(2).replace(",", ""))

    def _parse_change_with_percent(self, value: str) -> tuple[float | None, float | None]:
        match = RETURN_RE.search(value)
        if not match:
            return self._parse_money(value), self._parse_percent(value)
        return self._parse_money(match.group(1)), self._parse_percent(match.group(2))

    @staticmethod
    def _parse_quantity(value: str) -> float | None:
        match = QTY_RE.search(value)
        if not match:
            return None
        return float(match.group(1).replace(",", ""))

    @staticmethod
    def _parse_average_price(value: str) -> float | None:
        match = AVG_RE.search(value)
        if not match:
            return None
        return IndMoneyUsPortfolioService._parse_money(match.group(1))
