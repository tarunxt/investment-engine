from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from app.domains.polymarket_auto_live.scanner import ScannedMarket

ET = ZoneInfo("America/New_York")

YES_DEFINITION_PATTERN = re.compile(
    r'resolve to\s+"yes"\s+if\s+(?P<definition>.+?)(?:\.\s+otherwise|\.\s+if neither|\.\s+for the purposes|\.$)',
    re.IGNORECASE | re.DOTALL,
)
ET_DEADLINE_PATTERN = re.compile(
    r"by\s+(?P<month>[A-Z][a-z]+)\s+(?P<day>\d{1,2}),\s+(?P<year>\d{4})(?:,\s*(?P<hour>\d{1,2}):(?P<minute>\d{2})\s*(?P<period>AM|PM))?\s*ET",
    re.IGNORECASE,
)
MONTH_INDEX = {
    "january": 1,
    "february": 2,
    "march": 3,
    "april": 4,
    "may": 5,
    "june": 6,
    "july": 7,
    "august": 8,
    "september": 9,
    "october": 10,
    "november": 11,
    "december": 12,
}


@dataclass
class RuleEvaluation:
    yes_definition: str | None
    resolution_criteria: str | None
    deadline_et: str | None
    hours_remaining: float | None
    outcome_clear: bool
    expired: bool
    ambiguous: bool
    fail_reason: str | None


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _format_deadline_et(value: datetime | None) -> str | None:
    if value is None:
        return None
    local = value.astimezone(ET)
    return local.strftime("%Y-%m-%d %I:%M:%S %p ET")


def _extract_yes_definition(description: str | None) -> str | None:
    if not description:
        return None
    match = YES_DEFINITION_PATTERN.search(description)
    if not match:
        return None
    definition = " ".join(match.group("definition").split())
    return definition or None


def _extract_deadline_from_description(description: str | None) -> datetime | None:
    if not description:
        return None
    match = ET_DEADLINE_PATTERN.search(description)
    if not match:
        return None
    month = MONTH_INDEX.get(match.group("month").lower())
    day = int(match.group("day"))
    year = int(match.group("year"))
    hour = int(match.group("hour") or 11)
    minute = int(match.group("minute") or 59)
    period = (match.group("period") or "PM").upper()
    if period == "PM" and hour != 12:
        hour += 12
    if period == "AM" and hour == 12:
        hour = 0
    try:
        return datetime(year, month or 1, day, hour, minute, 0, tzinfo=ET).astimezone(UTC)
    except ValueError:
        return None


def evaluate_market_rules(market: ScannedMarket, *, now: datetime | None = None) -> RuleEvaluation:
    now = now or datetime.now(UTC)
    resolution_criteria = market.description.strip() if market.description else None
    if not resolution_criteria:
        return RuleEvaluation(
            yes_definition=None,
            resolution_criteria=None,
            deadline_et=None,
            hours_remaining=None,
            outcome_clear=False,
            expired=False,
            ambiguous=True,
            fail_reason="Resolution criteria are unavailable.",
        )

    yes_definition = _extract_yes_definition(resolution_criteria)
    deadline_utc = _extract_deadline_from_description(resolution_criteria) or _parse_iso(
        market.close_time
    )
    deadline_et = _format_deadline_et(deadline_utc)
    hours_remaining = (
        round((deadline_utc - now).total_seconds() / 3600, 2) if deadline_utc else None
    )
    outcome_clear = bool(
        yes_definition
        and {label.strip().lower() for label in market.outcome_labels} == {"yes", "no"}
    )
    expired = bool(deadline_utc and deadline_utc <= now)
    ambiguous = not outcome_clear

    fail_reason = None
    if not yes_definition:
        fail_reason = "Outcome side is unclear under the market rules."
    elif not deadline_utc:
        fail_reason = "Deadline is unclear from the market rules."
    elif expired:
        fail_reason = "Market is already expired."
    elif ambiguous:
        fail_reason = "Market wording is too ambiguous."

    return RuleEvaluation(
        yes_definition=yes_definition,
        resolution_criteria=resolution_criteria,
        deadline_et=deadline_et,
        hours_remaining=hours_remaining,
        outcome_clear=outcome_clear,
        expired=expired,
        ambiguous=ambiguous,
        fail_reason=fail_reason,
    )
