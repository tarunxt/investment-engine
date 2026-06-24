from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

from app.domains.polymarket.bullpen import _collect_bullpen_rows, run_first_bullpen_json
from app.domains.polymarket_auto_live.scanner import ScannedMarket

CONSOLE_PROFILE_ID = "bullpen_console_top10"
CONSOLE_SCHEDULE_TIMEZONE = ZoneInfo("Asia/Kolkata")
CONSOLE_SCHEDULE_HOURS = (0, 6, 12, 18)
CONSOLE_SCAN_WINDOW_DAYS = 30
CONSOLE_RANKED_EVENT_LIMIT = 10
CONSOLE_FIXED_ORDER_USD = 5.0
CONSOLE_LLM_CANDIDATE_LIMIT = 30
CONSOLE_MIN_LLM_NO_ODDS = 80.0
CONSOLE_MIN_RETURNS_PER_DAY = 5.0
CONSOLE_MIN_MARKET_ODDS = 5.0

_POSITIONS_COMMAND_VARIANTS = [
    ["polymarket", "positions", "--output", "json"],
]
_EASTERN_TIMEZONE = ZoneInfo("America/New_York")


@dataclass
class ConsoleWalletPosition:
    market_id: str
    slug: str | None
    condition_id: str | None
    market_title: str
    market_url: str | None
    side: str
    shares: float
    average_price_cents: float
    exposure_usd: float
    current_price_cents: float | None
    current_yes_odds: float | None
    current_no_odds: float | None
    close_time: str | None
    theme: str
    is_claimable: bool


def next_console_schedule_time(reference_time: datetime) -> datetime:
    localized = reference_time.astimezone(CONSOLE_SCHEDULE_TIMEZONE)
    schedule_dates = [localized.date(), localized.date() + timedelta(days=1)]

    for schedule_date in schedule_dates:
        for hour in CONSOLE_SCHEDULE_HOURS:
            candidate = datetime.combine(
                schedule_date,
                time(hour=hour, minute=0, tzinfo=CONSOLE_SCHEDULE_TIMEZONE),
            )
            if candidate > localized:
                return candidate.astimezone(UTC)

    fallback = localized + timedelta(hours=6)
    return fallback.astimezone(UTC)


def _read_string(value: object) -> str | None:
    if isinstance(value, str):
        normalized = value.strip()
        return normalized or None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    return None


def _read_number(value: object) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    if isinstance(value, str):
        cleaned = value.replace("%", "").replace("$", "").replace(",", "").strip()
        if not cleaned:
            return None
        try:
            return float(cleaned)
        except ValueError:
            return None
    return None


def _normalize_price_to_cents(value: object) -> float | None:
    parsed = _read_number(value)
    if parsed is None:
        return None
    cents = parsed * 100 if 0 <= parsed <= 1 else parsed
    return round(min(100.0, max(0.0, cents)), 2)


def _normalize_side(value: object) -> str:
    normalized = (_read_string(value) or "NO").strip().lower()
    if normalized == "yes":
        return "YES"
    if normalized == "no":
        return "NO"
    return normalized.upper() or "NO"


def _extract_close_time(value: object) -> str | None:
    raw = _read_string(value)
    if not raw:
        return None
    if len(raw) == 10:
        try:
            date_only = datetime.strptime(raw, "%Y-%m-%d").date()
        except ValueError:
            return None
        close_dt = datetime.combine(
            date_only,
            time(hour=23, minute=59, second=59, tzinfo=_EASTERN_TIMEZONE),
        )
        return close_dt.astimezone(UTC).isoformat()
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC).isoformat()


def _extract_claimable(row: dict[str, object]) -> bool:
    for key in (
        "redeemable",
        "isRedeemable",
        "claimable",
        "isClaimable",
    ):
        value = row.get(key)
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return bool(value)
        if isinstance(value, str):
            normalized = value.strip().lower()
            if normalized in {"true", "1", "yes", "claimable", "redeemable", "won"}:
                return True
            if normalized in {"false", "0", "no", "open"}:
                return False

    claim_text = " ".join(
        value.strip()
        for key in ("action", "status")
        if isinstance((value := row.get(key)), str) and value.strip()
    ).lower()
    return any(token in claim_text for token in ("claim", "redeem", "claimable", "redeemable", "won"))


def _build_market_url(event_slug: str | None) -> str | None:
    if not event_slug:
        return None
    return f"https://polymarket.com/event/{event_slug}"


def _position_yes_no_odds(side: str, current_price_cents: float | None) -> tuple[float | None, float | None]:
    if current_price_cents is None:
        return None, None
    held_side_price = round(current_price_cents, 2)
    opposite_side_price = round(100 - held_side_price, 2)
    if side == "YES":
        return held_side_price, opposite_side_price
    if side == "NO":
        return opposite_side_price, held_side_price
    return None, None


def position_returns_per_day(
    position: ConsoleWalletPosition,
    *,
    now: datetime,
) -> float | None:
    if position.is_claimable or position.current_price_cents is None or not position.close_time:
        return None
    try:
        close_time = datetime.fromisoformat(position.close_time.replace("Z", "+00:00"))
    except ValueError:
        return None
    days_until_close = round((close_time - now).total_seconds() / 86_400, 1)
    if days_until_close <= 0:
        return None
    return round((100 - position.current_price_cents) / days_until_close, 2)


def candidate_returns_per_day(
    market: ScannedMarket,
    *,
    now: datetime,
) -> float | None:
    if market.current_no_odds is None or not market.close_time:
        return None
    try:
        close_time = datetime.fromisoformat(market.close_time.replace("Z", "+00:00"))
    except ValueError:
        return None
    days_until_close = round((close_time - now).total_seconds() / 86_400, 1)
    if days_until_close <= 0:
        return None
    return round((100 - market.current_no_odds) / days_until_close, 2)


def active_position_slug_set(positions: list[ConsoleWalletPosition]) -> set[str]:
    return {position.slug for position in positions if position.slug}


async def read_console_wallet_positions() -> list[ConsoleWalletPosition]:
    parsed = await run_first_bullpen_json(_POSITIONS_COMMAND_VARIANTS, timeout_seconds=30)
    rows = _collect_bullpen_rows(parsed)
    positions: list[ConsoleWalletPosition] = []

    for index, row in enumerate(rows):
        side = _normalize_side(row.get("outcome"))
        market_id = (
            _read_string(row.get("slug"))
            or _read_string(row.get("condition_id"))
            or _read_string(row.get("conditionId"))
            or _read_string(row.get("market"))
            or f"wallet-position-{index + 1}"
        )
        current_price_cents = _normalize_price_to_cents(
            row.get("current_price") or row.get("currentPrice")
        )
        yes_odds, no_odds = _position_yes_no_odds(side, current_price_cents)
        average_price_cents = _normalize_price_to_cents(
            row.get("avg_price") or row.get("avgPrice")
        ) or 0.0
        shares = round(_read_number(row.get("shares")) or 0.0, 6)
        exposure_usd = round(
            (
                _read_number(row.get("invested_usd"))
                or _read_number(row.get("investedUsd"))
                or (shares * (average_price_cents / 100))
            ),
            2,
        )
        event_slug = _read_string(row.get("event_slug") or row.get("eventSlug"))

        positions.append(
            ConsoleWalletPosition(
                market_id=market_id,
                slug=_read_string(row.get("slug")),
                condition_id=_read_string(row.get("condition_id") or row.get("conditionId")),
                market_title=_read_string(row.get("market") or row.get("title")) or market_id,
                market_url=_build_market_url(event_slug),
                side=side,
                shares=shares,
                average_price_cents=round(average_price_cents, 4),
                exposure_usd=exposure_usd,
                current_price_cents=current_price_cents,
                current_yes_odds=yes_odds,
                current_no_odds=no_odds,
                close_time=_extract_close_time(row.get("end_date") or row.get("endDate")),
                theme="Bullpen Wallet",
                is_claimable=_extract_claimable(row),
            )
        )

    return [position for position in positions if position.shares > 0]


def apply_scanned_market_to_position(
    position: ConsoleWalletPosition,
    market: ScannedMarket | None,
) -> ConsoleWalletPosition:
    if market is None:
        return position

    if position.side == "YES":
        current_price_cents = market.current_yes_odds
    elif position.side == "NO":
        current_price_cents = market.current_no_odds
    else:
        current_price_cents = position.current_price_cents

    current_yes_odds = market.current_yes_odds
    current_no_odds = market.current_no_odds
    if current_yes_odds is None and current_no_odds is not None:
        current_yes_odds = round(100 - current_no_odds, 2)
    if current_no_odds is None and current_yes_odds is not None:
        current_no_odds = round(100 - current_yes_odds, 2)

    return replace(
        position,
        market_id=market.market_id or position.market_id,
        slug=market.slug or position.slug,
        market_title=market.question or position.market_title,
        market_url=market.market_url or position.market_url,
        current_price_cents=current_price_cents,
        current_yes_odds=current_yes_odds,
        current_no_odds=current_no_odds,
        close_time=market.close_time or position.close_time,
        theme=market.theme or position.theme,
    )
