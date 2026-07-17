from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Literal
from zoneinfo import ZoneInfo

from dateutil import parser as date_parser

from app.domains.polymarket_auto_live.scanner import ScannedMarket

ET = ZoneInfo("America/New_York")

YES_DEFINITION_PATTERN = re.compile(
    r'resolve(?:s)?\s+to\s+"?yes"?\s+if\s+(?P<definition>.+?)(?:\.\s+otherwise|\.\s+if neither|\.\s+for the purposes|\.$)',
    re.IGNORECASE | re.DOTALL,
)
YES_DEFINITION_FALLBACK_PATTERN = re.compile(
    r'\byes\b\s+(?:resolves|will resolve)\s+if\s+(?P<definition>.+?)(?:\.|$)',
    re.IGNORECASE | re.DOTALL,
)
DATE_WITH_OPTIONAL_TIME_PATTERN = re.compile(
    r"(?P<prefix>\bby\b|\bon\b|\bbefore\b|\bno later than\b)?\s*"
    r"(?P<date>(?:[A-Z][a-z]+ \d{1,2}, \d{4}|\d{4}-\d{2}-\d{2}))"
    r"(?:,\s*(?P<time>\d{1,2}:\d{2}\s*(?:AM|PM)))?"
    r"(?:\s*(?P<timezone>ET|EST|EDT|UTC|GMT|AST|Arabia Standard Time|Eastern Time|New York time))?",
    re.IGNORECASE,
)
QUESTION_BY_DATE_PATTERN = re.compile(
    r"\bby\s+(?P<date>(?:[A-Z][a-z]+\s+\d{1,2}(?:,\s*\d{4})?))\b",
    re.IGNORECASE,
)

TIMEZONE_NAME_TO_IANA = {
    "et": "America/New_York",
    "est": "America/New_York",
    "edt": "America/New_York",
    "eastern time": "America/New_York",
    "new york time": "America/New_York",
    "utc": "UTC",
    "gmt": "UTC",
    "ast": "Asia/Riyadh",
    "arabia standard time": "Asia/Riyadh",
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
    rule_quality_status: Literal["complete", "partial", "missing", "contradictory"] = "missing"
    resolution_timezone_name: str | None = None
    resolution_timezone_iana: str | None = None
    resolution_date_window: str | None = None
    deadline_local: str | None = None
    deadline_utc: str | None = None
    deadline_source: str | None = None
    deadline_confidence: Literal["high", "medium", "low", "unresolved"] = "unresolved"
    current_time_utc: str | None = None
    warnings: list[str] = field(default_factory=list)


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


def _format_deadline_in_zone(value: datetime | None, zone: ZoneInfo, label: str) -> str | None:
    if value is None:
        return None
    local = value.astimezone(zone)
    return local.strftime(f"%Y-%m-%d %I:%M:%S %p {label}")


def _normalize_text(value: str | None) -> str | None:
    if not value:
        return None
    normalized = " ".join(value.split()).strip()
    return normalized or None


def _extract_yes_definition(description: str | None) -> str | None:
    if not description:
        return None
    for pattern in (YES_DEFINITION_PATTERN, YES_DEFINITION_FALLBACK_PATTERN):
        match = pattern.search(description)
        if not match:
            continue
        definition = _normalize_text(match.group("definition"))
        if definition:
            return definition.rstrip(".")
    return None


def _detect_timezones(description: str | None) -> list[tuple[str, str]]:
    if not description:
        return []
    matches: list[tuple[str, str]] = []
    for raw_name, iana in TIMEZONE_NAME_TO_IANA.items():
        if re.search(rf"\b{re.escape(raw_name)}\b", description, re.IGNORECASE):
            matches.append((raw_name, iana))
    deduped: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for item in matches:
        if item in seen:
            continue
        seen.add(item)
        deduped.append(item)
    return deduped


def _timezone_label(raw_name: str | None, zone_iana: str | None) -> str | None:
    if raw_name:
        return raw_name
    return zone_iana


def _parse_deadline_from_rules(
    description: str | None,
    *,
    question: str,
    market_close_time: str | None,
    now: datetime,
) -> tuple[datetime | None, str | None, str | None, str | None, str, list[str]]:
    warnings: list[str] = []
    # A Polymarket multi-market event can retain an event-level `endDate` that
    # belongs to a different outcome.  The date in the selected market's
    # question (for example, "... by July 24?") is therefore authoritative
    # over both that stale close time and background dates in the rules.
    title_match = QUESTION_BY_DATE_PATTERN.search(question)
    if title_match:
        title_date = title_match.group("date")
        try:
            parsed = date_parser.parse(title_date, default=now.astimezone(ET))
            if not re.search(r"\b\d{4}\b", title_date):
                close_time = _parse_iso(market_close_time)
                if close_time is not None:
                    parsed = parsed.replace(year=close_time.astimezone(ET).year)
            parsed = parsed.replace(hour=23, minute=59, second=0, microsecond=0, tzinfo=ET)
        except (ValueError, OverflowError):
            warnings.append("Could not parse the deadline date in the market question.")
        else:
            return (
                parsed.astimezone(UTC),
                "ET",
                ET.key,
                f"{title_date} 11:59 PM ET",
                "question_title_by_date",
                "high",
                warnings,
            )

    if not description:
        fallback_deadline = _parse_iso(market_close_time)
        return (
            fallback_deadline,
            None,
            "UTC" if fallback_deadline else None,
            "market_close_time" if fallback_deadline else None,
            "low" if fallback_deadline else "unresolved",
            warnings,
        )

    timezone_matches = _detect_timezones(description)
    timezone_iana = timezone_matches[0][1] if timezone_matches else None
    timezone_name = timezone_matches[0][0] if timezone_matches else None
    distinct_timezones = {item[1] for item in timezone_matches}
    if len(distinct_timezones) > 1:
        warnings.append("Resolution rules reference multiple timezones.")

    for match in DATE_WITH_OPTIONAL_TIME_PATTERN.finditer(description):
        date_text = match.group("date")
        time_text = match.group("time")
        raw_timezone = match.group("timezone")
        effective_timezone_name = _normalize_text(raw_timezone) or timezone_name
        effective_timezone_iana = (
            TIMEZONE_NAME_TO_IANA.get(effective_timezone_name.lower())
            if effective_timezone_name
            else timezone_iana
        )
        if not date_text:
            continue
        try:
            parsed = date_parser.parse(
                f"{date_text} {time_text or '11:59 PM'}",
                fuzzy=True,
            )
        except (ValueError, OverflowError):
            continue
        if effective_timezone_iana:
            parsed = parsed.replace(tzinfo=ZoneInfo(effective_timezone_iana))
        else:
            warnings.append("Resolution rules include a date but no reliable timezone.")
            continue
        prefix = (match.group("prefix") or "").strip().lower()
        source = "rules_explicit_datetime"
        if not time_text:
            source = "rules_date_end_of_day"
            if prefix == "on":
                source = "rules_date"
        confidence: Literal["high", "medium", "low", "unresolved"] = (
            "high" if time_text and effective_timezone_iana else "medium"
        )
        return (
            parsed.astimezone(UTC),
            effective_timezone_name or _timezone_label(None, effective_timezone_iana),
            effective_timezone_iana,
            _normalize_text(f"{date_text} {time_text or ''} {effective_timezone_name or ''}"),
            source,
            confidence,
            warnings,
        )

    fallback_deadline = _parse_iso(market_close_time)
    if fallback_deadline is not None:
        warnings.append("Used market close time because the rules did not expose a parseable deadline.")
        return (
            fallback_deadline,
            "UTC",
            "UTC",
            market_close_time,
            "market_close_time",
            "low",
            warnings,
        )

    return None, timezone_name, timezone_iana, None, None, "unresolved", warnings


def _derive_rule_quality(
    *,
    resolution_criteria: str | None,
    yes_definition: str | None,
    deadline_utc: datetime | None,
    warnings: list[str],
) -> Literal["complete", "partial", "missing", "contradictory"]:
    if not resolution_criteria:
        return "missing"
    if any("multiple timezones" in warning.lower() for warning in warnings):
        return "contradictory"
    if yes_definition and deadline_utc is not None:
        return "complete"
    if yes_definition or deadline_utc is not None:
        return "partial"
    return "missing"


def evaluate_market_rules(
    market: ScannedMarket,
    *,
    now: datetime | None = None,
    resolution_text: str | None = None,
) -> RuleEvaluation:
    now = now or datetime.now(UTC)
    resolution_criteria = _normalize_text(resolution_text or market.description)
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
            rule_quality_status="missing",
            deadline_confidence="unresolved",
            current_time_utc=now.isoformat(),
        )

    yes_definition = _extract_yes_definition(resolution_criteria)
    (
        deadline_utc_dt,
        timezone_name,
        timezone_iana,
        resolution_date_window,
        deadline_source,
        deadline_confidence,
        warnings,
    ) = _parse_deadline_from_rules(
        resolution_criteria,
        question=market.question,
        market_close_time=market.close_time,
        now=now,
    )
    hours_remaining = (
        round((deadline_utc_dt - now).total_seconds() / 3600, 2)
        if deadline_utc_dt is not None
        else None
    )
    outcome_clear = bool(
        yes_definition
        and {label.strip().lower() for label in market.outcome_labels} == {"yes", "no"}
    )
    expired = bool(deadline_utc_dt and deadline_utc_dt <= now)
    rule_quality_status = _derive_rule_quality(
        resolution_criteria=resolution_criteria,
        yes_definition=yes_definition,
        deadline_utc=deadline_utc_dt,
        warnings=warnings,
    )
    ambiguous = not outcome_clear or rule_quality_status in {"missing", "contradictory"}

    fail_reason = None
    if not yes_definition:
        fail_reason = "Exact YES resolution criteria are unavailable."
    elif deadline_utc_dt is None:
        fail_reason = "Deadline is unclear from the market rules."
    elif expired:
        fail_reason = "Market is already expired."
    elif rule_quality_status == "contradictory":
        fail_reason = "Resolution rules are contradictory."
    elif ambiguous:
        fail_reason = "Market wording is too ambiguous."

    deadline_local = None
    if deadline_utc_dt is not None and timezone_iana:
        zone = ZoneInfo(timezone_iana)
        deadline_local = _format_deadline_in_zone(
            deadline_utc_dt,
            zone,
            timezone_name or zone.key,
        )

    return RuleEvaluation(
        yes_definition=yes_definition,
        resolution_criteria=resolution_criteria,
        deadline_et=_format_deadline_in_zone(deadline_utc_dt, ET, "ET"),
        hours_remaining=hours_remaining,
        outcome_clear=outcome_clear,
        expired=expired,
        ambiguous=ambiguous,
        fail_reason=fail_reason,
        rule_quality_status=rule_quality_status,
        resolution_timezone_name=timezone_name,
        resolution_timezone_iana=timezone_iana,
        resolution_date_window=resolution_date_window,
        deadline_local=deadline_local,
        deadline_utc=deadline_utc_dt.isoformat() if deadline_utc_dt is not None else None,
        deadline_source=deadline_source,
        deadline_confidence=deadline_confidence,
        current_time_utc=now.isoformat(),
        warnings=warnings,
    )
