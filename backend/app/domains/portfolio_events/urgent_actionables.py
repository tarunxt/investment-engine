from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import re
from typing import Any, Iterable, Mapping
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")

URGENT_ACTIONABLES_TABLE_KEY = "urgent_actionables"
URGENT_ACTIONABLES_TABLE_TITLE = "Table 10: Urgent Actionables / Immediate Risk-Control Actions"

_STOCK_NAME_KEYS = ("Stock Name", "Stock", "Holding", "Company", "Company Name")
_STOCK_SYMBOL_KEYS = ("Stock Symbol", "Symbol", "Ticker", "Tradingsymbol")
_EXCHANGE_KEYS = ("Exchange",)
_ACTION_KEYS = ("Urgent Action Needed", "Action Needed", "Urgent Action")
_WHY_KEYS = ("Why Action Is Needed Now", "Why Action Needed Now", "Why")
_TRIGGER_KEYS = ("Trigger / Condition", "Trigger", "Condition")
_EXACT_DATE_KEYS = ("Exact Date / Deadline", "Exact Date", "Deadline")
_ACTION_SIZE_KEYS = ("Suggested Action Size", "Action Size")
_PRIORITY_KEYS = ("Priority",)
_TIME_SENSITIVITY_KEYS = ("Time Sensitivity",)
_PRIORITY_RANKS = {
    "very high": 4,
    "high": 3,
    "medium": 2,
    "low": 1,
}


@dataclass(frozen=True)
class HoldingContext:
    exchange: str
    stock_symbol: str
    stock_name: str
    amount_invested: float | None
    portfolio_percentage: float | None


@dataclass(frozen=True)
class UrgentActionHistoryEntry:
    tagged_at: datetime
    exchange: str
    stock_symbol: str
    stock_name: str
    amount_invested: float | None
    portfolio_percentage: float | None
    urgent_action_needed: str
    why_action_is_needed_now: str
    trigger_condition: str
    exact_date_deadline: str
    suggested_action_size: str
    priority: str
    time_sensitivity: str


def find_urgent_actionables_section(report: dict[str, Any] | None) -> dict[str, Any] | None:
    if not report:
        return None

    for section in report.get("tables") or []:
        if section.get("key") == URGENT_ACTIONABLES_TABLE_KEY:
            return section
    return None


def build_holding_context_index(contexts: Iterable[HoldingContext]) -> dict[str, HoldingContext]:
    index: dict[str, HoldingContext] = {}
    for context in contexts:
        for key in _lookup_keys(
            exchange=context.exchange,
            stock_symbol=context.stock_symbol,
            stock_name=context.stock_name,
        ):
            if key:
                index.setdefault(key, context)
    return index


def resolve_portfolio_percentage(
    *,
    amount_invested: float | None,
    total_amount_invested: float | None,
    position_value: float | None,
    total_position_value: float | None,
    preferred_percentage: float | None = None,
) -> float | None:
    if total_amount_invested is not None and total_amount_invested > 0:
        if amount_invested is None:
            return None
        return (amount_invested / total_amount_invested) * 100

    if preferred_percentage is not None:
        return preferred_percentage

    if total_position_value is not None and total_position_value > 0:
        if position_value is None:
            return None
        return (position_value / total_position_value) * 100

    return None


def build_urgent_action_history_entries(
    report: dict[str, Any] | None,
    *,
    tagged_at: datetime,
    holding_context_index: Mapping[str, HoldingContext] | None = None,
) -> list[UrgentActionHistoryEntry]:
    section = find_urgent_actionables_section(report)
    if not section:
        return []

    entries: list[UrgentActionHistoryEntry] = []
    holding_context_index = holding_context_index or {}

    for row in section.get("rows") or []:
        if not isinstance(row, dict) or _is_no_urgent_action_row(row):
            continue

        exchange = _first_value(row, _EXCHANGE_KEYS)
        stock_symbol = _first_value(row, _STOCK_SYMBOL_KEYS)
        stock_name = _first_value(row, _STOCK_NAME_KEYS)

        context = _resolve_holding_context(
            holding_context_index,
            exchange=exchange,
            stock_symbol=stock_symbol,
            stock_name=stock_name,
        )

        entries.append(
            UrgentActionHistoryEntry(
                tagged_at=tagged_at,
                exchange=exchange or (context.exchange if context else ""),
                stock_symbol=stock_symbol or (context.stock_symbol if context else ""),
                stock_name=stock_name or (context.stock_name if context else stock_symbol),
                amount_invested=context.amount_invested if context else None,
                portfolio_percentage=context.portfolio_percentage if context else None,
                urgent_action_needed=_first_value(row, _ACTION_KEYS),
                why_action_is_needed_now=_first_value(row, _WHY_KEYS),
                trigger_condition=_first_value(row, _TRIGGER_KEYS),
                exact_date_deadline=_first_value(row, _EXACT_DATE_KEYS),
                suggested_action_size=_first_value(row, _ACTION_SIZE_KEYS),
                priority=_first_value(row, _PRIORITY_KEYS),
                time_sensitivity=_first_value(row, _TIME_SENSITIVITY_KEYS),
            )
        )

    return entries


def merge_urgent_actionables_history(
    report: dict[str, Any] | None,
    *,
    entries: list[UrgentActionHistoryEntry],
    currency_code: str,
    portfolio_percentage_label: str,
) -> dict[str, Any] | None:
    if not report:
        return None

    if not entries:
        return report

    history_section = _build_history_section(
        entries=entries,
        currency_code=currency_code,
        portfolio_percentage_label=portfolio_percentage_label,
    )

    tables = list(report.get("tables") or [])
    replaced = False
    for index, section in enumerate(tables):
        if section.get("key") == URGENT_ACTIONABLES_TABLE_KEY:
            tables[index] = history_section
            replaced = True
            break

    if not replaced:
        tables.append(history_section)

    return {
        **report,
        "tables": tables,
    }


def _build_history_section(
    *,
    entries: list[UrgentActionHistoryEntry],
    currency_code: str,
    portfolio_percentage_label: str,
) -> dict[str, Any]:
    grouped: dict[str, list[UrgentActionHistoryEntry]] = {}
    latest_tagged_at_by_key: dict[str, datetime] = {}

    for entry in sorted(entries, key=lambda item: _as_utc(item.tagged_at)):
        group_key = _group_key(entry)
        grouped.setdefault(group_key, []).append(entry)
        latest_tagged_at_by_key[group_key] = entry.tagged_at

    ordered_group_keys = sorted(
        grouped,
        key=lambda key: (
            -_group_priority_rank(grouped[key]),
            -_as_utc(latest_tagged_at_by_key[key]).timestamp(),
            grouped[key][-1].stock_symbol.lower(),
            grouped[key][-1].stock_name.lower(),
        ),
    )

    rows: list[dict[str, str]] = []
    for group_key in ordered_group_keys:
        stock_entries = list(reversed(grouped[group_key]))
        latest_entry = stock_entries[0]
        amount_invested = next(
            (entry.amount_invested for entry in stock_entries if entry.amount_invested is not None),
            None,
        )
        portfolio_percentage = next(
            (
                entry.portfolio_percentage
                for entry in stock_entries
                if entry.portfolio_percentage is not None
            ),
            None,
        )

        rows.append(
            {
                "Exchange": latest_entry.exchange,
                "Stock Symbol": latest_entry.stock_symbol,
                "Stock Name": latest_entry.stock_name or latest_entry.stock_symbol or "-",
                "Amount Invested": _format_currency(amount_invested, currency_code),
                portfolio_percentage_label: _format_percentage(portfolio_percentage),
                "Tagged At": "\n".join(_display_or_dash(_format_tagged_at(entry.tagged_at)) for entry in stock_entries),
                "Urgent Action Needed": "\n".join(_display_or_dash(entry.urgent_action_needed) for entry in stock_entries),
                "Why Action Is Needed Now": "\n".join(
                    _display_or_dash(entry.why_action_is_needed_now) for entry in stock_entries
                ),
                "Trigger / Condition": "\n".join(
                    _display_or_dash(entry.trigger_condition) for entry in stock_entries
                ),
                "Exact Date / Deadline": "\n".join(
                    _display_or_dash(entry.exact_date_deadline) for entry in stock_entries
                ),
                "Suggested Action Size": "\n".join(
                    _display_or_dash(entry.suggested_action_size) for entry in stock_entries
                ),
                "Priority": "\n".join(_display_or_dash(entry.priority) for entry in stock_entries),
                "Time Sensitivity": "\n".join(
                    _display_or_dash(entry.time_sensitivity) for entry in stock_entries
                ),
            }
        )

    return {
        "key": URGENT_ACTIONABLES_TABLE_KEY,
        "title": URGENT_ACTIONABLES_TABLE_TITLE,
        "columns": [
            "Stock Symbol",
            "Stock Name",
            "Amount Invested",
            portfolio_percentage_label,
            "Tagged At",
            "Urgent Action Needed",
            "Why Action Is Needed Now",
            "Trigger / Condition",
            "Exact Date / Deadline",
            "Suggested Action Size",
            "Priority",
            "Time Sensitivity",
        ],
        "rows": rows,
    }


def _resolve_holding_context(
    index: Mapping[str, HoldingContext],
    *,
    exchange: str,
    stock_symbol: str,
    stock_name: str,
) -> HoldingContext | None:
    for key in _lookup_keys(exchange=exchange, stock_symbol=stock_symbol, stock_name=stock_name):
        if key and key in index:
            return index[key]
    return _resolve_holding_context_by_alias(
        index,
        exchange=exchange,
        stock_symbol=stock_symbol,
        stock_name=stock_name,
    )


def _resolve_holding_context_by_alias(
    index: Mapping[str, HoldingContext],
    *,
    exchange: str,
    stock_symbol: str,
    stock_name: str,
) -> HoldingContext | None:
    candidates: list[tuple[int, HoldingContext]] = []

    for context in _iter_unique_contexts(index):
        score = _context_match_score(
            context,
            exchange=exchange,
            stock_symbol=stock_symbol,
            stock_name=stock_name,
        )
        if score > 0:
            candidates.append((score, context))

    if not candidates:
        return None

    best_score = max(score for score, _context in candidates)
    best_matches = [
        context
        for score, context in candidates
        if score == best_score
    ]

    if len(best_matches) != 1:
        return None

    return best_matches[0]


def _iter_unique_contexts(index: Mapping[str, HoldingContext]) -> list[HoldingContext]:
    seen: set[tuple[str, str, str]] = set()
    contexts: list[HoldingContext] = []

    for context in index.values():
        key = (
            _normalize_key_piece(context.exchange),
            _normalize_key_piece(context.stock_symbol),
            _normalize_key_piece(context.stock_name),
        )
        if key in seen:
            continue
        seen.add(key)
        contexts.append(context)

    return contexts


def _context_match_score(
    context: HoldingContext,
    *,
    exchange: str,
    stock_symbol: str,
    stock_name: str,
) -> int:
    normalized_exchange = _normalize_holding_token(exchange)
    normalized_symbol = _normalize_holding_token(stock_symbol)
    normalized_name = _normalize_holding_token(stock_name)
    context_exchange = _normalize_holding_token(context.exchange)
    context_symbol = _normalize_holding_token(context.stock_symbol)
    context_name = _normalize_holding_token(context.stock_name)

    if normalized_exchange and context_exchange and normalized_exchange != context_exchange:
        return 0

    score = 0

    if normalized_symbol:
        if normalized_symbol == context_symbol:
            score = max(score, 8)
        elif _holding_alias_matches(normalized_symbol, context_symbol):
            score = max(score, 7)
        elif _holding_alias_matches(normalized_symbol, context_name):
            score = max(score, 6)

    if normalized_name:
        if normalized_name == context_name:
            score = max(score, 7)
        elif _holding_alias_matches(normalized_name, context_name):
            score = max(score, 5)
        elif _holding_alias_matches(normalized_name, context_symbol):
            score = max(score, 4)

    if score > 0 and normalized_exchange and context_exchange == normalized_exchange:
        score += 1

    return score


def _lookup_keys(*, exchange: str, stock_symbol: str, stock_name: str) -> list[str]:
    normalized_exchange = _normalize_key_piece(exchange)
    normalized_symbol = _normalize_key_piece(stock_symbol)
    normalized_name = _normalize_key_piece(stock_name)

    keys = []
    if normalized_exchange and normalized_symbol:
        keys.append(f"exchange_symbol:{normalized_exchange}:{normalized_symbol}")
    if normalized_symbol:
        keys.append(f"symbol:{normalized_symbol}")
    if normalized_name:
        keys.append(f"name:{normalized_name}")
    return keys


def _normalize_key_piece(value: str) -> str:
    return " ".join((value or "").strip().lower().split())


def _normalize_holding_token(value: str) -> str:
    normalized = (value or "").strip().lower()
    return re.sub(r"[^a-z0-9]+", "", normalized)


def _holding_alias_matches(value: str, alias: str) -> bool:
    if not value or not alias:
        return False
    if value == alias:
        return True
    return len(value) >= 4 and len(alias) > 5 and (value in alias or alias in value)


def _group_key(entry: UrgentActionHistoryEntry) -> str:
    for key in _lookup_keys(
        exchange=entry.exchange,
        stock_symbol=entry.stock_symbol,
        stock_name=entry.stock_name,
    ):
        if key:
            return key
    return f"fallback:{id(entry)}"


def _group_priority_rank(entries: list[UrgentActionHistoryEntry]) -> int:
    return max((_priority_rank(entry.priority) for entry in entries), default=0)


def _priority_rank(value: str) -> int:
    return _PRIORITY_RANKS.get((value or "").strip().lower(), 0)


def _first_value(row: Mapping[str, Any], keys: Iterable[str]) -> str:
    for key in keys:
        value = row.get(key)
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return ""


def _is_no_urgent_action_row(row: Mapping[str, Any]) -> bool:
    action = _first_value(row, _ACTION_KEYS).lower()
    return "no urgent action required" in action


def _format_tagged_at(value: datetime) -> str:
    instant = _as_utc(value).astimezone(IST)
    return instant.strftime("%d %b %Y, %I:%M %p IST")


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _format_currency(value: float | None, currency_code: str) -> str:
    if value is None:
        return "-"
    return f"{currency_code} {value:,.2f}"


def _format_percentage(value: float | None) -> str:
    if value is None:
        return "-"
    return f"{value:.2f}%"


def _display_or_dash(value: str) -> str:
    return value.strip() if value and value.strip() else "-"
