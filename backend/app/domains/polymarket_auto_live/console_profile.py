from __future__ import annotations

import asyncio
import json
import os
import re
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

from app.core.logging import get_logger
from app.domains.polymarket.bullpen import run_first_bullpen_json
from app.domains.polymarket.logger import redact_secrets
from app.domains.polymarket.runtime_broker import get_bullpen_runtime_broker
from app.domains.polymarket.position_classification import (
    classify_bullpen_position,
    extract_bullpen_claimable_value_usd,
    extract_bullpen_claimable_flag,
    extract_bullpen_expected_payout_usdc,
    extract_bullpen_resolution_status,
    extract_bullpen_upstream_redeemable_flag,
)
from app.domains.polymarket_auto_live.category import (
    collect_polymarket_record_category_labels,
    format_polymarket_category,
    read_polymarket_theme,
)
from app.domains.polymarket_auto_live.scanner import (
    FILTER_TEXT_KEYS,
    MARKET_PREDICTION_KEYWORDS,
    MARKET_PREDICTION_PATTERNS,
    POLYMARKET_GAMMA_MARKETS_URL,
    TWEET_COUNT_KEYWORDS,
    TWEET_COUNT_PATTERNS,
    WEATHER_KEYWORDS,
    ScanRejectedMarket,
    ScannedMarket,
    _collect_nested_strings,
    build_market_filter_search_text,
    is_insult_market_text,
    is_sports_market_text,
    scan_candidate_markets,
)

CONSOLE_PROFILE_ID = "bullpen_console_top10"
CONSOLE_SCHEDULE_TIMEZONE = ZoneInfo("Asia/Kolkata")
CONSOLE_SCHEDULE_HOURS = (0, 6, 12, 18)
CONSOLE_SCAN_WINDOW_DAYS = 30
CONSOLE_RANKED_EVENT_LIMIT = 10
DEFAULT_CONSOLE_ORDER_USD = 5.0
CONSOLE_MIN_LLM_STRONG_SIDE_ODDS = 80.0
CONSOLE_MIN_MARKET_ODDS = 5.0
CONSOLE_DISCOVER_TIMEOUT_SECONDS = 5
CONSOLE_GAMMA_SCAN_TIMEOUT_SECONDS = 45
CONSOLE_POSITIONS_TIMEOUT_SECONDS = 20
CONSOLE_POSITIONS_TIMEOUT_ENV_VAR = "BULLPEN_CONSOLE_POSITIONS_TIMEOUT_SECONDS"
# The broker may wait for a shared authenticated CLI refresh before it runs the
# positions command.  Keep the overall Stage 1 wait independently bounded so
# a lock owner or auth refresh can never hold the Stage 2 handoff indefinitely.
CONSOLE_STAGE1_WALLET_REFRESH_TIMEOUT_SECONDS = 30
CONSOLE_STAGE1_WALLET_REFRESH_TIMEOUT_ENV_VAR = (
    "BULLPEN_CONSOLE_STAGE1_WALLET_REFRESH_TIMEOUT_SECONDS"
)

_POSITIONS_COMMAND_VARIANTS = [
    ["polymarket", "positions", "--output", "json"],
]
_DISCOVER_COMMAND_VARIANTS = [
    [
        "polymarket",
        "discover",
        "--status",
        "active",
        "--limit",
        "1000",
        "--output",
        "json",
    ],
    [
        "polymarket",
        "discover",
        "--status",
        "active",
        "--sort",
        "newest",
        "--limit",
        "1000",
        "--output",
        "json",
    ],
]
CONSOLE_CLI_SOURCE_LABEL = "Bullpen CLI"
CONSOLE_CLI_SOURCE_URL = (
    "https://app.bullpen.fi/predictions/trending?ref=intrepid-crane-3"
)
CONSOLE_GAMMA_SOURCE_LABEL = "Polymarket Gamma API"
_EASTERN_TIMEZONE = ZoneInfo("America/New_York")
logger = get_logger("app.domains.polymarket_auto_live.console_profile")
_OUTCOME_LABEL_KEYS = ("name", "label", "outcome", "title", "side")
_QUESTION_KEYS = ("question", "title", "name", "eventTitle", "marketQuestion")
_MARKET_SLUG_KEYS = ("slug", "marketSlug", "questionSlug")
_CLOSE_TIME_KEYS = (
    "closeTime",
    "closingTime",
    "endDate",
    "end_date",
    "endTime",
    "resolutionDate",
    "endDateIso",
    "endDateISO",
    "closesAt",
    "closedAt",
    "deadline",
    "expiry",
)
_POSITION_HISTORY_CONTAINER_KEYS = frozenset(
    {
        "activities",
        "activity",
        "history",
        "transactions",
        "trades",
        "redemptions",
    }
)
_POSITION_IDENTIFIER_KEYS = (
    "slug",
    "condition_id",
    "conditionId",
    "market",
    "title",
    "event_slug",
    "eventSlug",
)
_POSITION_SIGNAL_KEYS = (
    "avg_price",
    "avgPrice",
    "current_price",
    "currentPrice",
    "current_value",
    "currentValue",
    "invested_usd",
    "investedUsd",
    "claimableValue",
    "claimable_value",
    "redeemableValue",
    "redeemable_value",
    "redeemable",
    "isRedeemable",
    "claimable",
    "isClaimable",
    "end_date",
    "endDate",
)


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
    current_value_usd: float | None
    current_yes_odds: float | None
    current_no_odds: float | None
    close_time: str | None
    theme: str
    is_claimable: bool
    raw_claimable_flag: bool = False
    upstream_redeemable: bool = False
    classification: str = "active"
    classification_reason: str = "This row still looks like an economically active Bullpen position."
    claimable_value_usd: float | None = None
    expected_payout_usdc: float | None = None
    resolution_status: str | None = None


@dataclass(frozen=True)
class ConsoleWalletPositionsSnapshot:
    """Parsed wallet positions together with the broker freshness proof."""

    positions: list[ConsoleWalletPosition]
    source: str
    fetched_at: str
    raw_position_count: int
    diagnostics: dict[str, object]
    raw_positions: list[ConsoleWalletPosition] = field(default_factory=list)


@dataclass
class ConsoleScanResult:
    source_label: str
    source_url: str
    scanned_at: str
    accepted: list[ScannedMarket]
    rejected: list[ScanRejectedMarket]
    total_candidates: int
    warning: str | None = None
    details: str | None = None


@dataclass(frozen=True)
class ConsoleDiscoverRow:
    row: dict[str, object]
    context_theme: str | None
    context_close_time: str | None


def _console_positions_timeout_seconds() -> int:
    configured = os.getenv(CONSOLE_POSITIONS_TIMEOUT_ENV_VAR)
    if configured is None:
        return CONSOLE_POSITIONS_TIMEOUT_SECONDS
    try:
        return max(1, int(configured))
    except ValueError:
        return CONSOLE_POSITIONS_TIMEOUT_SECONDS


def console_stage1_wallet_refresh_timeout_seconds() -> int:
    """Return the end-to-end Stage 1 wait budget for a fresh wallet snapshot.

    This is deliberately distinct from the individual Bullpen positions-command
    timeout.  A fresh request can also wait on the distributed positions and
    authenticated-CLI locks, so the worker needs its own circuit breaker.
    """

    configured = os.getenv(CONSOLE_STAGE1_WALLET_REFRESH_TIMEOUT_ENV_VAR)
    if configured is None:
        return CONSOLE_STAGE1_WALLET_REFRESH_TIMEOUT_SECONDS
    try:
        return max(1, int(configured))
    except ValueError:
        return CONSOLE_STAGE1_WALLET_REFRESH_TIMEOUT_SECONDS


def _parse_console_start_at(value: str | None) -> datetime | None:
    if not value:
        return None
    normalized = value.strip()
    for candidate in (normalized, normalized.replace(" ", "T", 1)):
        try:
            parsed = datetime.fromisoformat(candidate)
            if parsed.tzinfo is None:
                return parsed.replace(tzinfo=CONSOLE_SCHEDULE_TIMEZONE)
            return parsed
        except ValueError:
            continue
    for fmt in (
        "%H:%M:%S %d %B, %Y",
        "%H:%M:%S %d %b, %Y",
        "%H:%M:%S %d %B %Y",
        "%H:%M:%S %d %b %Y",
    ):
        try:
            return datetime.strptime(normalized, fmt).replace(
                tzinfo=CONSOLE_SCHEDULE_TIMEZONE
            )
        except ValueError:
            continue
    return None


def next_custom_console_schedule_time(
    reference_time: datetime,
    *,
    start_at: str | None = None,
    refresh_minutes: int | None = None,
) -> datetime:
    if not start_at or not refresh_minutes or refresh_minutes < 1:
        return next_console_schedule_time(reference_time)
    start = _parse_console_start_at(start_at)
    if start is None:
        return next_console_schedule_time(reference_time)
    start_utc = start.astimezone(UTC)
    reference_utc = reference_time.astimezone(UTC)
    if start_utc > reference_utc:
        return start_utc
    interval = timedelta(minutes=refresh_minutes)
    elapsed = reference_utc - start_utc
    intervals_elapsed = int(elapsed.total_seconds() // interval.total_seconds()) + 1
    return start_utc + (interval * intervals_elapsed)


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


def _read_string(
    value: object, keys: tuple[str, ...] | list[str] | None = None
) -> str | None:
    if keys is not None:
        if not isinstance(value, dict):
            return None
        for key in keys:
            parsed = _read_string(value.get(key))
            if parsed:
                return parsed
        return None
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


def _parse_close_time_utc(value: object) -> datetime | None:
    raw = _read_string(value)
    if not raw:
        return None
    if len(raw) == 10:
        try:
            date_only = datetime.strptime(raw, "%Y-%m-%d").date()
        except ValueError:
            return None
        return datetime.combine(
            date_only,
            time(hour=23, minute=59, second=59, tzinfo=_EASTERN_TIMEZONE),
        ).astimezone(UTC)
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _extract_close_time(value: object) -> str | None:
    parsed = _parse_close_time_utc(value)
    return parsed.isoformat() if parsed is not None else None


def _extract_claimable(row: dict[str, object]) -> bool:
    return extract_bullpen_claimable_flag(row)


def _build_market_url(event_slug: str | None) -> str | None:
    if not event_slug:
        return None
    return f"https://polymarket.com/event/{event_slug}"


def _parse_json_list(value: object) -> list[object]:
    if isinstance(value, list):
        return value
    if not isinstance(value, str) or not value.strip():
        return []
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return []
    return parsed if isinstance(parsed, list) else []


def _iter_list_like(value: object) -> list[object]:
    if isinstance(value, list):
        return value
    return _parse_json_list(value)


def _looks_like_console_position_row(value: object) -> bool:
    if not isinstance(value, dict):
        return False

    has_identifier = any(_read_string(value.get(key)) for key in _POSITION_IDENTIFIER_KEYS)
    has_position_signal = any(key in value for key in _POSITION_SIGNAL_KEYS)
    return has_identifier and has_position_signal


def _collect_console_position_rows(value: object) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    seen_object_ids: set[int] = set()

    def walk(current: object) -> None:
        if isinstance(current, list):
            for item in current:
                walk(item)
            return
        if not isinstance(current, dict):
            return

        object_id = id(current)
        if object_id in seen_object_ids:
            return
        seen_object_ids.add(object_id)

        if _looks_like_console_position_row(current):
            rows.append(current)
            return

        for key, nested in current.items():
            if key in _POSITION_HISTORY_CONTAINER_KEYS:
                continue
            if isinstance(nested, (dict, list)):
                walk(nested)

    walk(value)
    return rows


def _read_nested_number(
    record: dict[str, object], keys: tuple[str, ...]
) -> float | None:
    for key in keys:
        parsed = _read_number(record.get(key))
        if parsed is not None:
            return parsed
    return None


def _normalize_console_odds(value: object) -> float | None:
    parsed = _read_number(value)
    if parsed is None:
        return None
    normalized = parsed * 100 if 0 <= parsed <= 1 else parsed
    return round(min(100.0, max(0.0, normalized)), 2)


def _normalize_text(value: str | None) -> str:
    return " ".join((value or "").strip().lower().split())


def _contains_keyword(text: str, keyword: str) -> bool:
    return (
        re.search(rf"(^|\W){re.escape(keyword)}(?=$|\W)", text, re.IGNORECASE)
        is not None
    )


def _includes_any(text: str, keywords: tuple[str, ...]) -> bool:
    return any(_contains_keyword(text, keyword) for keyword in keywords)


def _read_outcome_labels(row: dict[str, object]) -> list[str]:
    labels: list[str] = []
    for collection_name in ("outcomes", "options", "tokens", "markets"):
        for item in _iter_list_like(row.get(collection_name)):
            if isinstance(item, str) and item.strip():
                labels.append(item.strip())
                continue
            if not isinstance(item, dict):
                continue
            label = _read_string(item, _OUTCOME_LABEL_KEYS)
            if label:
                labels.append(label)
    deduped: list[str] = []
    seen: set[str] = set()
    for label in labels:
        normalized = _normalize_text(label)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        deduped.append(label.strip())
    return deduped


def _read_yes_no_prices(
    row: dict[str, object], outcome_labels: list[str]
) -> tuple[float | None, float | None]:
    normalized_labels = [_normalize_text(label) for label in outcome_labels]
    outcome_prices = [
        _read_number(value) for value in _iter_list_like(row.get("outcomePrices"))
    ]

    yes_price = None
    no_price = None
    if "yes" in normalized_labels:
        yes_index = normalized_labels.index("yes")
        if yes_index < len(outcome_prices):
            yes_price = outcome_prices[yes_index]
    if "no" in normalized_labels:
        no_index = normalized_labels.index("no")
        if no_index < len(outcome_prices):
            no_price = outcome_prices[no_index]

    nested_price_keys = (
        "odds",
        "decimalOdds",
        "price",
        "lastPrice",
        "bestAsk",
        "bestBid",
        "probability",
        "probabilityValue",
    )
    if yes_price is None or no_price is None:
        for collection_name in ("outcomes", "options", "tokens", "markets"):
            for item in _iter_list_like(row.get(collection_name)):
                if not isinstance(item, dict):
                    continue
                label = _read_string(item, _OUTCOME_LABEL_KEYS)
                if not label:
                    continue
                normalized_label = _normalize_text(label)
                if normalized_label == "yes" and yes_price is None:
                    yes_price = _read_nested_number(item, nested_price_keys)
                elif normalized_label == "no" and no_price is None:
                    no_price = _read_nested_number(item, nested_price_keys)

    if yes_price is None:
        yes_price = _read_nested_number(
            row,
            (
                "yesOdds",
                "yes_odd",
                "yesDecimalOdds",
                "yesPrice",
                "yes",
                "bestYesOdds",
                "probabilityYes",
                "yesProbability",
            ),
        )
    if no_price is None:
        no_price = _read_nested_number(
            row,
            (
                "noOdds",
                "no_odd",
                "noDecimalOdds",
                "noPrice",
                "no",
                "bestNoOdds",
                "probabilityNo",
                "noProbability",
            ),
        )

    return _normalize_console_odds(yes_price), _normalize_console_odds(no_price)


def _is_binary_yes_no(
    outcome_labels: list[str],
    yes_odds: float | None,
    no_odds: float | None,
) -> bool:
    if not outcome_labels:
        return yes_odds is not None and no_odds is not None
    normalized = {_normalize_text(label) for label in outcome_labels}
    return len(normalized) == 2 and normalized == {"yes", "no"}


def console_market_filter_reasons(
    market: ScannedMarket,
    *,
    now: datetime,
) -> list[str]:
    reasons: list[str] = []
    search_text = build_market_filter_search_text(market)
    if is_sports_market_text(search_text):
        reasons.append("Excluded sports market.")
    if _includes_any(search_text, WEATHER_KEYWORDS):
        reasons.append("Excluded weather market.")
    if _includes_any(search_text, MARKET_PREDICTION_KEYWORDS) or any(
        pattern.search(search_text) for pattern in MARKET_PREDICTION_PATTERNS
    ):
        reasons.append("Excluded market-prediction or finance market.")
    if _includes_any(search_text, TWEET_COUNT_KEYWORDS) and any(
        pattern.search(search_text) for pattern in TWEET_COUNT_PATTERNS
    ):
        reasons.append("Excluded tweet-count or social-post-count market.")
    if is_insult_market_text(search_text):
        reasons.append("Excluded insult or name-calling market.")
    if not _is_binary_yes_no(
        market.outcome_labels,
        market.current_yes_odds,
        market.current_no_odds,
    ):
        reasons.append("Excluded unclear non-binary market.")
    if market.current_yes_odds is None or market.current_no_odds is None:
        reasons.append("Excluded market without both Yes and No odds.")
    elif (
        market.current_yes_odds < CONSOLE_MIN_MARKET_ODDS
        or market.current_no_odds < CONSOLE_MIN_MARKET_ODDS
    ):
        reasons.append(
            f"Excluded market below the {CONSOLE_MIN_MARKET_ODDS:.0f}% Yes/No odds floor."
        )
    if not market.close_time:
        reasons.append("Excluded market without a close time.")
    else:
        close_time = _parse_close_time_utc(market.close_time)
        if close_time is None:
            reasons.append("Excluded market with an invalid close time.")
        else:
            days_until_close = (close_time - now).total_seconds() / 86_400
            if days_until_close <= 0:
                reasons.append("Excluded market that is already closed.")
            elif days_until_close > CONSOLE_SCAN_WINDOW_DAYS:
                reasons.append(
                    f"Excluded market outside the {CONSOLE_SCAN_WINDOW_DAYS}-day Bullpen window."
                )
    return reasons


def _normalize_console_market(
    row: dict[str, object],
    *,
    context_theme: str | None = None,
    context_close_time: str | None = None,
) -> ScannedMarket | None:
    question = _read_string(row, _QUESTION_KEYS)
    if not question or len(question) < 8:
        return None

    market_id = (
        _read_string(row, ("id", *_MARKET_SLUG_KEYS, "marketId", "conditionId"))
        or question
    )
    slug = _read_string(row, _MARKET_SLUG_KEYS)
    outcome_labels = _read_outcome_labels(row)
    current_yes_odds, current_no_odds = _read_yes_no_prices(row, outcome_labels)

    event_slug = None
    events = row.get("events")
    if isinstance(events, list):
        for event in events:
            if not isinstance(event, dict):
                continue
            candidate_slug = _read_string(event, ("slug",))
            if candidate_slug:
                event_slug = candidate_slug
                break
    event_slug = event_slug or _read_string(row, ("eventSlug", "urlSlug"))
    close_time = _read_string(row, _CLOSE_TIME_KEYS) or context_close_time
    theme = read_polymarket_theme(
        row,
        context_category=context_theme,
        inference_texts=(
            question,
            slug,
            " ".join(_collect_nested_strings(row, keys=FILTER_TEXT_KEYS)),
        ),
    )

    return ScannedMarket(
        market_id=market_id,
        question=question,
        market_url=_build_market_url(event_slug),
        slug=slug,
        close_time=_extract_close_time(close_time),
        theme=theme,
        current_yes_odds=current_yes_odds,
        current_no_odds=current_no_odds,
        volume_usd=_read_nested_number(
            row,
            (
                "volume",
                "volume24hr",
                "volume24h",
                "totalVolume",
                "volumeNum",
                "volumeUsd",
                "volumeUSD",
                "dollarVolume",
            ),
        ),
        liquidity_usd=_read_nested_number(
            row,
            ("liquidity", "liquidityNum", "liquidityUsd", "liquidityUSD"),
        ),
        description=_read_string(row, ("description",)),
        outcome_labels=outcome_labels,
        event_slug=event_slug,
        best_bid_cents=_normalize_console_odds(row.get("bestBid")),
        best_ask_cents=_normalize_console_odds(row.get("bestAsk")),
        spread_cents=_normalize_console_odds(row.get("spread")),
        force_include=False,
        raw=row,
    )


def _collect_console_discover_rows(value: object) -> list[ConsoleDiscoverRow]:
    """Walk the full Bullpen discover payload, matching the manual scan parser.

    Bullpen CLI discover can return nested sections where only a small top-level
    collection is exposed as rows. Manual Scan walks every embedded object and
    normalizes records with question/title fields, so Auto Scan must do the same
    before applying filters.
    """
    rows: list[ConsoleDiscoverRow] = []
    seen_object_ids: set[int] = set()

    def walk(
        current: object,
        *,
        context_theme: str | None = None,
        context_close_time: str | None = None,
    ) -> None:
        if isinstance(current, list):
            for item in current:
                walk(
                    item,
                    context_theme=context_theme,
                    context_close_time=context_close_time,
                )
            return
        if not isinstance(current, dict):
            return
        object_id = id(current)
        if object_id in seen_object_ids:
            return
        seen_object_ids.add(object_id)
        next_context_theme = (
            format_polymarket_category(
                collect_polymarket_record_category_labels(
                    current,
                    context_category=context_theme,
                )
            )
            or context_theme
        )
        next_context_close_time = _read_string(current, _CLOSE_TIME_KEYS) or context_close_time
        if _read_string(current, _QUESTION_KEYS):
            rows.append(
                ConsoleDiscoverRow(
                    row=current,
                    context_theme=next_context_theme,
                    context_close_time=next_context_close_time,
                )
            )
        for child in current.values():
            if isinstance(child, (dict, list)):
                walk(
                    child,
                    context_theme=next_context_theme,
                    context_close_time=next_context_close_time,
                )

    walk(value)
    return rows


def _build_cli_console_scan_result(
    rows: list[ConsoleDiscoverRow],
    *,
    now: datetime,
    scanned_at: str,
) -> ConsoleScanResult:
    normalized_by_market_id: dict[str, ScannedMarket] = {}
    for discovered in rows:
        market = _normalize_console_market(
            discovered.row,
            context_theme=discovered.context_theme,
            context_close_time=discovered.context_close_time,
        )
        if market is None or market.market_id in normalized_by_market_id:
            continue
        normalized_by_market_id[market.market_id] = market

    accepted: list[ScannedMarket] = []
    rejected: list[ScanRejectedMarket] = []
    for market in normalized_by_market_id.values():
        reasons = console_market_filter_reasons(market, now=now)
        if reasons:
            rejected.append(
                ScanRejectedMarket(
                    market_id=market.market_id,
                    question=market.question,
                    slug=market.slug,
                    market_url=market.market_url,
                    reasons=reasons,
                )
            )
            continue
        accepted.append(market)

    accepted.sort(key=lambda market: (market.close_time or "", market.question))
    rejected.sort(key=lambda market: (market.question, market.market_id))
    return ConsoleScanResult(
        source_label=CONSOLE_CLI_SOURCE_LABEL,
        source_url=CONSOLE_CLI_SOURCE_URL,
        scanned_at=scanned_at,
        accepted=accepted,
        rejected=rejected,
        total_candidates=len(normalized_by_market_id),
    )


async def scan_console_profile_markets(*, now: datetime) -> ConsoleScanResult:
    scanned_at = datetime.now(UTC).isoformat()
    try:
        parsed = await run_first_bullpen_json(
            _DISCOVER_COMMAND_VARIANTS,
            timeout_seconds=CONSOLE_DISCOVER_TIMEOUT_SECONDS,
            wait_for_login=False,
        )
        return _build_cli_console_scan_result(
            _collect_console_discover_rows(parsed),
            now=now,
            scanned_at=scanned_at,
        )
    except Exception as cli_exc:
        try:
            gamma_scan = await asyncio.wait_for(
                scan_candidate_markets(
                    min_liquidity_usd=0,
                    existing_position_slugs=set(),
                ),
                timeout=CONSOLE_GAMMA_SCAN_TIMEOUT_SECONDS,
            )
        except Exception as gamma_exc:
            # A scan failure is safe to degrade to an empty candidate set: no
            # Stage 2 rows means no LLM calls or orders.  Most importantly,
            # do not leave the shared Auto-Live worker parked in Stage 1 while
            # an upstream API or subprocess is unavailable.
            logger.warning(
                "Bullpen console scan failed through both CLI and Gamma fallback; "
                "continuing with an empty candidate set. cli_error=%s gamma_error=%s",
                cli_exc,
                gamma_exc,
                exc_info=True,
            )
            return ConsoleScanResult(
                source_label=CONSOLE_GAMMA_SOURCE_LABEL,
                source_url=POLYMARKET_GAMMA_MARKETS_URL,
                scanned_at=scanned_at,
                accepted=[],
                rejected=[],
                total_candidates=0,
                warning=(
                    "Bullpen CLI and Gamma scan failed; continuing with no Stage 1 candidates."
                ),
                details=redact_secrets(
                    f"CLI error: {cli_exc}; Gamma error: {gamma_exc}"
                ),
            )
        accepted: list[ScannedMarket] = []
        rejected = list(gamma_scan.rejected)
        for market in gamma_scan.accepted:
            reasons = console_market_filter_reasons(market, now=now)
            if reasons:
                rejected.append(
                    ScanRejectedMarket(
                        market_id=market.market_id,
                        question=market.question,
                        slug=market.slug,
                        market_url=market.market_url,
                        reasons=reasons,
                    )
                )
                continue
            accepted.append(market)
        accepted.sort(key=lambda market: (market.close_time or "", market.question))
        return ConsoleScanResult(
            source_label=CONSOLE_GAMMA_SOURCE_LABEL,
            source_url=gamma_scan.source_url,
            scanned_at=gamma_scan.scanned_at,
            accepted=accepted,
            rejected=rejected,
            total_candidates=len(gamma_scan.accepted) + len(gamma_scan.rejected),
            warning=(
                "Using Polymarket Gamma API fallback because the Bullpen CLI scan failed."
            ),
            details=redact_secrets(str(cli_exc)),
        )


def _position_yes_no_odds(
    side: str, current_price_cents: float | None
) -> tuple[float | None, float | None]:
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
    if (
        position.is_claimable
        or position.current_price_cents is None
        or not position.close_time
    ):
        return None
    close_time = _parse_close_time_utc(position.close_time)
    if close_time is None:
        return None
    days_until_close = round((close_time - now).total_seconds() / 86_400, 1)
    if days_until_close <= 0:
        return None
    return round((100 - position.current_price_cents) / days_until_close, 2)


def llm_returns_per_day(
    *,
    llm_yes_odds: float | None,
    llm_no_odds: float | None,
    close_time: str | None,
    now: datetime,
    current_yes_odds: float | None = None,
    current_no_odds: float | None = None,
) -> float | None:
    if current_yes_odds is None and current_no_odds is None:
        return None
    if not close_time:
        return None
    parsed_close_time = _parse_close_time_utc(close_time)
    if parsed_close_time is None:
        return None
    days_until_close = round((parsed_close_time - now).total_seconds() / 86_400, 1)
    if days_until_close <= 0:
        return None
    if llm_yes_odds is None or llm_no_odds is None:
        return None
    current_odds_for_strongest_llm_side = (
        current_yes_odds if llm_yes_odds >= llm_no_odds else current_no_odds
    )
    if current_odds_for_strongest_llm_side is None:
        return None
    return round((100 - current_odds_for_strongest_llm_side) / days_until_close, 2)


def candidate_returns_per_day(
    market: ScannedMarket,
    *,
    now: datetime,
) -> float | None:
    if market.current_yes_odds is None and market.current_no_odds is None:
        return None
    if not market.close_time:
        return None
    close_time = _parse_close_time_utc(market.close_time)
    if close_time is None:
        return None
    days_until_close = round((close_time - now).total_seconds() / 86_400, 1)
    if days_until_close <= 0:
        return None
    strongest_current_odds = max(
        market.current_yes_odds if market.current_yes_odds is not None else float("-inf"),
        market.current_no_odds if market.current_no_odds is not None else float("-inf"),
    )
    if strongest_current_odds == float("-inf"):
        return None
    return round((100 - strongest_current_odds) / days_until_close, 2)


def active_position_slug_set(positions: list[ConsoleWalletPosition]) -> set[str]:
    return {position.slug for position in positions if position.slug}


def _position_aliases(position: ConsoleWalletPosition) -> list[str]:
    aliases = [
        position.slug,
        position.condition_id,
        position.market_id,
        position.market_title,
    ]
    deduped_aliases: list[str] = []
    seen: set[str] = set()
    for alias in aliases:
        if not alias or alias in seen:
            continue
        seen.add(alias)
        deduped_aliases.append(alias)
    return deduped_aliases


def _classify_console_wallet_position(
    position: ConsoleWalletPosition,
    *,
    authoritative_market_is_open: bool | None = None,
):
    return classify_bullpen_position(
        {
            "shares": position.shares,
            "resolution_status": position.resolution_status,
        },
        shares=position.shares,
        current_price=position.current_price_cents,
        current_value=position.current_value_usd,
        close_time=position.close_time,
        claimable_flag=position.raw_claimable_flag,
        upstream_redeemable_flag=position.upstream_redeemable,
        expected_payout_usdc=position.expected_payout_usdc,
        claimable_value_usd=position.claimable_value_usd,
        authoritative_market_is_open=authoritative_market_is_open,
    )


def _apply_console_wallet_position_classification(
    position: ConsoleWalletPosition,
    *,
    authoritative_market_is_open: bool | None = None,
) -> ConsoleWalletPosition:
    classification = _classify_console_wallet_position(
        position,
        authoritative_market_is_open=authoritative_market_is_open,
    )
    return replace(
        position,
        is_claimable=classification.is_claimable,
        classification=classification.state,
        classification_reason=classification.reason,
        claimable_value_usd=classification.claimable_value_usd,
        expected_payout_usdc=classification.expected_payout_usdc,
        resolution_status=classification.resolution_status,
    )


def _merge_console_wallet_position(
    existing: ConsoleWalletPosition,
    incoming: ConsoleWalletPosition,
) -> ConsoleWalletPosition:
    total_shares = round(existing.shares + incoming.shares, 6)
    total_exposure_usd = round(existing.exposure_usd + incoming.exposure_usd, 2)

    average_price_cents = existing.average_price_cents
    if total_shares > 0:
        average_price_cents = round((total_exposure_usd / total_shares) * 100, 4)

    priced_lots = [
        lot
        for lot in (existing, incoming)
        if lot.current_price_cents is not None and lot.shares > 0
    ]
    current_price_cents: float | None = None
    if priced_lots:
        total_current_value_usd = sum(
            lot.shares * (float(lot.current_price_cents) / 100) for lot in priced_lots
        )
        total_priced_shares = sum(lot.shares for lot in priced_lots)
        if total_priced_shares > 0:
            current_price_cents = round(
                (total_current_value_usd / total_priced_shares) * 100,
                4,
            )
    current_value_usd = (
        round(
            sum(
                lot.current_value_usd or 0.0
                for lot in (existing, incoming)
                if lot.current_value_usd is not None
            ),
            2,
        )
        if existing.current_value_usd is not None or incoming.current_value_usd is not None
        else (
            round(total_shares * (current_price_cents / 100), 2)
            if current_price_cents is not None
            else None
        )
    )
    claimable_value_usd = (
        round(
            (existing.claimable_value_usd or 0.0) + (incoming.claimable_value_usd or 0.0),
            2,
        )
        if existing.claimable_value_usd is not None or incoming.claimable_value_usd is not None
        else None
    )

    yes_odds, no_odds = _position_yes_no_odds(existing.side, current_price_cents)
    merged_position = ConsoleWalletPosition(
        market_id=existing.market_id or incoming.market_id,
        slug=existing.slug or incoming.slug,
        condition_id=existing.condition_id or incoming.condition_id,
        market_title=(
            existing.market_title
            if existing.market_title and existing.market_title != existing.market_id
            else incoming.market_title or existing.market_title
        ),
        market_url=existing.market_url or incoming.market_url,
        side=existing.side,
        shares=total_shares,
        average_price_cents=average_price_cents,
        exposure_usd=total_exposure_usd,
        current_price_cents=current_price_cents,
        current_value_usd=current_value_usd,
        current_yes_odds=(
            yes_odds if yes_odds is not None else existing.current_yes_odds
        ),
        current_no_odds=no_odds if no_odds is not None else existing.current_no_odds,
        close_time=existing.close_time or incoming.close_time,
        theme=existing.theme or incoming.theme,
        is_claimable=False,
        raw_claimable_flag=existing.raw_claimable_flag or incoming.raw_claimable_flag,
        upstream_redeemable=existing.upstream_redeemable or incoming.upstream_redeemable,
        claimable_value_usd=claimable_value_usd,
        expected_payout_usdc=(
            existing.expected_payout_usdc
            if existing.expected_payout_usdc is not None
            else incoming.expected_payout_usdc
        ),
        resolution_status=existing.resolution_status or incoming.resolution_status,
    )
    return _apply_console_wallet_position_classification(merged_position)


def _aggregate_console_wallet_positions(
    positions: list[ConsoleWalletPosition],
) -> list[ConsoleWalletPosition]:
    grouped_positions: dict[str, ConsoleWalletPosition] = {}
    alias_to_group_key: dict[tuple[str, str, bool], str] = {}

    for position in positions:
        aliases = _position_aliases(position)
        group_key = next(
            (
                alias_to_group_key[(alias, position.side, position.is_claimable)]
                for alias in aliases
                if (alias, position.side, position.is_claimable) in alias_to_group_key
            ),
            None,
        )
        if group_key is None:
            group_key = aliases[0] if aliases else position.market_id
            grouped_positions[group_key] = position
        else:
            grouped_positions[group_key] = _merge_console_wallet_position(
                grouped_positions[group_key],
                position,
            )

        for alias in aliases or [group_key]:
            alias_to_group_key[(alias, position.side, position.is_claimable)] = (
                group_key
            )

    return list(grouped_positions.values())


def parse_console_wallet_positions_payload(
    parsed: object,
    *,
    aggregate: bool = True,
) -> list[ConsoleWalletPosition]:
    rows = _collect_console_position_rows(parsed)
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
        raw_current_price = row.get("current_price")
        if raw_current_price is None:
            raw_current_price = row.get("currentPrice")
        current_price_cents = _normalize_price_to_cents(raw_current_price)
        yes_odds, no_odds = _position_yes_no_odds(side, current_price_cents)
        raw_average_price = row.get("avg_price")
        if raw_average_price is None:
            raw_average_price = row.get("avgPrice")
        average_price_cents = _normalize_price_to_cents(raw_average_price) or 0.0
        shares = round(_read_number(row.get("shares")) or 0.0, 6)
        exposure_usd = round(
            (
                _read_number(row.get("invested_usd"))
                or _read_number(row.get("investedUsd"))
                or (shares * (average_price_cents / 100))
            ),
            2,
        )
        raw_current_value = row.get("current_value")
        if raw_current_value is None:
            raw_current_value = row.get("currentValue")
        current_value_usd = _read_number(raw_current_value)
        if current_value_usd is None and current_price_cents is not None:
            current_value_usd = round(shares * (current_price_cents / 100), 2)
        event_slug = _read_string(row.get("event_slug") or row.get("eventSlug"))
        close_time = _extract_close_time(row.get("end_date") or row.get("endDate"))
        raw_claimable_flag = extract_bullpen_claimable_flag(row)
        upstream_redeemable = extract_bullpen_upstream_redeemable_flag(row)
        claimable_value_usd = extract_bullpen_claimable_value_usd(row)
        expected_payout_usdc = extract_bullpen_expected_payout_usdc(row)
        resolution_status = extract_bullpen_resolution_status(row)

        positions.append(
            ConsoleWalletPosition(
                market_id=market_id,
                slug=_read_string(row.get("slug")),
                condition_id=_read_string(
                    row.get("condition_id") or row.get("conditionId")
                ),
                market_title=_read_string(row.get("market") or row.get("title"))
                or market_id,
                market_url=_build_market_url(event_slug),
                side=side,
                shares=shares,
                average_price_cents=round(average_price_cents, 4),
                exposure_usd=exposure_usd,
                current_price_cents=current_price_cents,
                current_value_usd=current_value_usd,
                current_yes_odds=yes_odds,
                current_no_odds=no_odds,
                close_time=close_time,
                theme="Bullpen Wallet",
                is_claimable=False,
                raw_claimable_flag=raw_claimable_flag,
                upstream_redeemable=upstream_redeemable,
                claimable_value_usd=claimable_value_usd,
                expected_payout_usdc=expected_payout_usdc,
                resolution_status=resolution_status,
            )
        )

    classified_positions = [
        _apply_console_wallet_position_classification(position) for position in positions
    ]
    eligible_positions = [
        position
        for position in classified_positions
        if position.shares > 0 or position.classification != "closed"
    ]
    return (
        _aggregate_console_wallet_positions(eligible_positions)
        if aggregate
        else classified_positions
    )


async def read_console_wallet_positions(
    *,
    force_fresh: bool = True,
    caller_source: str = "console-wallet",
    snapshot_payload: object | None = None,
    max_age_seconds: int = CONSOLE_POSITIONS_TIMEOUT_SECONDS,
) -> list[ConsoleWalletPosition]:
    snapshot = await read_console_wallet_positions_snapshot(
        force_fresh=force_fresh,
        caller_source=caller_source,
        snapshot_payload=snapshot_payload,
        max_age_seconds=max_age_seconds,
    )
    return snapshot.positions


async def read_console_wallet_positions_snapshot(
    *,
    force_fresh: bool = True,
    caller_source: str = "console-wallet",
    snapshot_payload: object | None = None,
    max_age_seconds: int = CONSOLE_POSITIONS_TIMEOUT_SECONDS,
) -> ConsoleWalletPositionsSnapshot:
    broker_snapshot = None
    if snapshot_payload is None:
        broker_snapshot = await get_bullpen_runtime_broker().get_positions_snapshot(
            force_fresh=force_fresh,
            caller_source=caller_source,
            max_age_seconds=max_age_seconds,
            timeout_seconds=_console_positions_timeout_seconds(),
        )
        parsed = broker_snapshot.payload
    else:
        parsed = snapshot_payload

    raw_positions = parse_console_wallet_positions_payload(parsed, aggregate=False)
    positions = _aggregate_console_wallet_positions(
        [
            position
            for position in raw_positions
            if position.shares > 0 or position.classification != "closed"
        ]
    )
    return ConsoleWalletPositionsSnapshot(
        positions=positions,
        source=broker_snapshot.source if broker_snapshot is not None else "provided-payload",
        fetched_at=broker_snapshot.fetched_at if broker_snapshot is not None else datetime.now(UTC).isoformat(),
        raw_position_count=len(_collect_console_position_rows(parsed)),
        diagnostics=(
            broker_snapshot.diagnostics.model_dump(mode="json")
            if broker_snapshot is not None
            else {"source": "provided-payload"}
        ),
        raw_positions=raw_positions,
    )


def apply_scanned_market_to_position(
    position: ConsoleWalletPosition,
    market: ScannedMarket | None,
) -> ConsoleWalletPosition:
    if market is None:
        return position

    authoritative_market_is_open = not (
        isinstance(market.raw, dict) and market.raw.get("wallet_position_fallback")
    )

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

    enriched_position = replace(
        position,
        market_id=market.market_id or position.market_id,
        slug=market.slug or position.slug,
        market_title=market.question or position.market_title,
        market_url=market.market_url or position.market_url,
        current_price_cents=current_price_cents,
        current_value_usd=(
            round(position.shares * (current_price_cents / 100), 2)
            if current_price_cents is not None
            else position.current_value_usd
        ),
        current_yes_odds=current_yes_odds,
        current_no_odds=current_no_odds,
        close_time=market.close_time or position.close_time,
        theme=market.theme or position.theme,
    )
    return _apply_console_wallet_position_classification(
        enriched_position,
        authoritative_market_is_open=authoritative_market_is_open,
    )
