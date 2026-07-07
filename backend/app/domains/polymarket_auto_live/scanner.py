from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx

POLYMARKET_GAMMA_MARKETS_URL = "https://gamma-api.polymarket.com/markets"
POLYMARKET_HTTP_HEADERS = {"User-Agent": "investment-engine-bullpen-auto-live/1.0"}
GAMMA_PAGE_SIZE = 500
SCAN_LIMIT = 1_500

SPORTS_KEYWORDS = (
    "sports",
    "esports",
    "nba",
    "nfl",
    "mlb",
    "nhl",
    "ncaa",
    "soccer",
    "football",
    "baseball",
    "basketball",
    "cricket",
    "tennis",
    "wimbledon",
    "atp",
    "wta",
    "grand slam",
    "roland garros",
    "french open",
    "australian open",
    "davis cup",
    "billie jean king cup",
    "golf",
    "pga",
    "u.s. open",
    "us open",
    "mma",
    "ufc",
    "boxing",
    "formula 1",
    "f1",
    "world cup",
    "premier league",
    "champions league",
    "la liga",
    "dota",
    "dota 2",
    "cs2",
    "counter-strike",
    "counter strike",
    "league of legends",
    "valorant",
    "rocket league",
    "fifa",
    "uefa",
)
WEATHER_KEYWORDS = (
    "weather",
    "temperature",
    "rain",
    "snow",
    "hurricane",
    "storm",
    "tornado",
    "heatwave",
    "forecast",
    "climate",
    "wind",
    "precipitation",
    "monsoon",
)
MARKET_PREDICTION_KEYWORDS = (
    "bitcoin",
    "ethereum",
    "solana",
    "dogecoin",
    "crypto",
    "stock",
    "stocks",
    "share price",
    "nasdaq",
    "s&p",
    "dow",
    "oil",
    "gold",
    "silver",
    "yield",
    "bond",
    "bonds",
    "commodity",
    "commodities",
    "forex",
    "inflation",
    "interest rate",
    "fed",
    "etf",
)
MARKET_PREDICTION_PATTERNS = (
    re.compile(r"\blargest company in the world by market cap\b", re.IGNORECASE),
    re.compile(r"\blargest company by market cap\b", re.IGNORECASE),
)
TWEET_COUNT_KEYWORDS = (
    "tweet",
    "tweets",
    "x post",
    "x posts",
    "posts on x",
    "truth social post",
    "truth social posts",
    "truths",
)
TWEET_COUNT_PATTERNS = (
    re.compile(r"\bhow many (?:tweets?|posts?|truths?)\b", re.IGNORECASE),
    re.compile(r"\bnumber of (?:tweets?|posts?|truths?)\b", re.IGNORECASE),
    re.compile(
        r"\b(?:at least|at most|more than|less than|over|under|between)\s+\d+[\w\s-]*(?:tweets?|posts?|truths?)\b",
        re.IGNORECASE,
    ),
    re.compile(r"\b\d+\s*(?:-|to)\s*\d+\s+(?:tweets?|posts?|truths?)\b", re.IGNORECASE),
    re.compile(r"\b\d+\+?\s+(?:tweets?|posts?|truths?)\b", re.IGNORECASE),
)
INSULT_MARKET_PATTERNS = (
    re.compile(
        r"\b(?:donald\s+)?trump\b.{0,80}\bpublic(?:ly)?\s+insult(?:s|ed|ing)?\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bpublic(?:ly)?\s+insult(?:s|ed|ing)?\s+(?:someone|somebody|anyone)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\binsult(?:s|ed|ing)?\s+(?:someone|somebody|anyone)\b",
        re.IGNORECASE,
    ),
    re.compile(r"\bname[\s-]?calling\b", re.IGNORECASE),
)


@dataclass
class ScannedMarket:
    market_id: str
    question: str
    market_url: str | None
    slug: str | None
    close_time: str | None
    theme: str
    current_yes_odds: float | None
    current_no_odds: float | None
    volume_usd: float | None
    liquidity_usd: float | None
    description: str | None
    outcome_labels: list[str]
    event_slug: str | None
    best_bid_cents: float | None
    best_ask_cents: float | None
    spread_cents: float | None
    force_include: bool = False
    raw: dict[str, Any] | None = None


@dataclass
class ScanRejectedMarket:
    market_id: str
    question: str
    slug: str | None
    market_url: str | None
    reasons: list[str]
    force_included_position: bool = False


@dataclass
class ScanResult:
    source_label: str
    source_url: str
    scanned_at: str
    accepted: list[ScannedMarket]
    rejected: list[ScanRejectedMarket]


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _parse_json_list(value: object) -> list[object]:
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return []
        return parsed if isinstance(parsed, list) else []
    return []


def _parse_float(value: object) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        cleaned = value.replace("$", "").replace(",", "").strip()
        if not cleaned:
            return None
        try:
            return float(cleaned)
        except ValueError:
            return None
    return None


def _normalize_odds(value: float | None) -> float | None:
    if value is None:
        return None
    normalized = value * 100 if 0 <= value <= 1 else value
    return round(min(100, max(0, normalized)), 2)


def _normalize_close_time(value: object) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip()
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC).isoformat()


def _normalize_text(value: str | None) -> str:
    return " ".join((value or "").strip().lower().split())


def _contains_keyword(text: str, keyword: str) -> bool:
    return (
        re.search(rf"(^|\W){re.escape(keyword)}(?=$|\W)", text, re.IGNORECASE)
        is not None
    )


def _includes_any(text: str, keywords: tuple[str, ...]) -> bool:
    return any(_contains_keyword(text, keyword) for keyword in keywords)


def is_insult_market_text(text: str) -> bool:
    return any(pattern.search(text) for pattern in INSULT_MARKET_PATTERNS)


def _build_market_url(event_slug: str | None) -> str | None:
    if not event_slug:
        return None
    return f"https://polymarket.com/event/{event_slug}"


def _read_label(value: object) -> str | None:
    if isinstance(value, str):
        return value.strip() or None
    if isinstance(value, dict):
        for key in ("label", "name", "title", "slug"):
            child = value.get(key)
            if isinstance(child, str) and child.strip():
                return child.strip()
    return None


def _collect_category_labels(row: dict[str, Any]) -> list[str]:
    labels: list[str] = []

    def add(value: object) -> None:
        label = _read_label(value)
        if label and label.lower() not in {item.lower() for item in labels}:
            labels.append(label)

    for key in (
        "category",
        "categoryName",
        "primaryCategory",
        "group",
        "tag",
        "topic",
        "type",
    ):
        add(row.get(key))
    for key in ("tags", "categories"):
        value = row.get(key)
        if isinstance(value, list):
            for item in value:
                add(item)
    events = row.get("events")
    if isinstance(events, list):
        for event in events:
            if not isinstance(event, dict):
                continue
            for key in (
                "category",
                "categoryName",
                "primaryCategory",
                "group",
                "tag",
                "topic",
                "type",
            ):
                add(event.get(key))
            for key in ("tags", "categories"):
                value = event.get(key)
                if isinstance(value, list):
                    for item in value:
                        add(item)
    return labels


def _read_theme(row: dict[str, Any]) -> str:
    labels = _collect_category_labels(row)
    return " · ".join(labels) if labels else "Uncategorized"


def _read_outcome_labels(row: dict[str, Any]) -> list[str]:
    labels = []
    for item in _parse_json_list(row.get("outcomes")):
        if isinstance(item, str) and item.strip():
            labels.append(item.strip())
    seen: set[str] = set()
    deduped: list[str] = []
    for label in labels:
        normalized = _normalize_text(label)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        deduped.append(label)
    return deduped


def _read_yes_no_prices(
    outcome_labels: list[str], row: dict[str, Any]
) -> tuple[float | None, float | None]:
    normalized_labels = [_normalize_text(label) for label in outcome_labels]
    prices = [_parse_float(item) for item in _parse_json_list(row.get("outcomePrices"))]
    yes_price = None
    no_price = None
    if "yes" in normalized_labels:
        yes_index = normalized_labels.index("yes")
        if yes_index < len(prices):
            yes_price = prices[yes_index]
    if "no" in normalized_labels:
        no_index = normalized_labels.index("no")
        if no_index < len(prices):
            no_price = prices[no_index]
    return _normalize_odds(yes_price), _normalize_odds(no_price)


def _is_binary_yes_no(
    outcome_labels: list[str], yes_odds: float | None, no_odds: float | None
) -> bool:
    if not outcome_labels:
        return yes_odds is not None and no_odds is not None
    normalized = {_normalize_text(label) for label in outcome_labels}
    return len(normalized) == 2 and normalized == {"yes", "no"}


def _search_text(market: ScannedMarket) -> str:
    return " ".join(
        filter(
            None,
            [
                market.question,
                market.theme,
                market.slug,
                " ".join(market.outcome_labels),
            ],
        )
    ).lower()


def _evaluate_filter_reasons(
    market: ScannedMarket,
    *,
    min_liquidity_usd: float,
) -> list[str]:
    reasons: list[str] = []
    search_text = _search_text(market)
    if _includes_any(search_text, SPORTS_KEYWORDS):
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
        market.outcome_labels, market.current_yes_odds, market.current_no_odds
    ):
        reasons.append("Excluded unclear non-binary market.")
    if (
        market.liquidity_usd is not None
        and min_liquidity_usd > 0
        and market.liquidity_usd < min_liquidity_usd
    ):
        reasons.append(
            f"Excluded low-liquidity market ({market.liquidity_usd:.2f} < {min_liquidity_usd:.2f})."
        )
    return reasons


def _normalize_market(
    row: dict[str, Any], *, force_include: bool = False
) -> ScannedMarket | None:
    question = row.get("question")
    market_id = row.get("id") or row.get("slug") or row.get("conditionId")
    if not isinstance(question, str) or not question.strip():
        return None
    if not isinstance(market_id, str) or not market_id.strip():
        market_id = question.strip()

    outcome_labels = _read_outcome_labels(row)
    yes_odds, no_odds = _read_yes_no_prices(outcome_labels, row)
    event_slug = None
    events = row.get("events")
    if isinstance(events, list):
        for event in events:
            if isinstance(event, dict):
                candidate_slug = event.get("slug")
                if isinstance(candidate_slug, str) and candidate_slug.strip():
                    event_slug = candidate_slug.strip()
                    break
    spread = _parse_float(row.get("spread"))
    return ScannedMarket(
        market_id=str(market_id).strip(),
        question=question.strip(),
        market_url=_build_market_url(event_slug),
        slug=(
            row.get("slug").strip()
            if isinstance(row.get("slug"), str) and row.get("slug").strip()
            else None
        ),
        close_time=_normalize_close_time(row.get("endDate")),
        theme=_read_theme(row),
        current_yes_odds=yes_odds,
        current_no_odds=no_odds,
        volume_usd=_parse_float(row.get("volumeNum") or row.get("volume")),
        liquidity_usd=_parse_float(row.get("liquidityNum") or row.get("liquidity")),
        description=(
            row.get("description").strip()
            if isinstance(row.get("description"), str)
            and row.get("description").strip()
            else None
        ),
        outcome_labels=outcome_labels,
        event_slug=event_slug,
        best_bid_cents=_normalize_odds(_parse_float(row.get("bestBid"))),
        best_ask_cents=_normalize_odds(_parse_float(row.get("bestAsk"))),
        spread_cents=round(spread * 100, 2) if spread is not None else None,
        force_include=force_include,
        raw=row,
    )


async def _fetch_gamma_page(
    client: httpx.AsyncClient,
    *,
    offset: int,
) -> list[dict[str, Any]]:
    response = await client.get(
        POLYMARKET_GAMMA_MARKETS_URL,
        params={
            "active": "true",
            "archived": "false",
            "closed": "false",
            "limit": str(GAMMA_PAGE_SIZE),
            "offset": str(offset),
            "order": "endDate",
            "ascending": "true",
        },
    )
    response.raise_for_status()
    payload = response.json()
    return payload if isinstance(payload, list) else []


async def fetch_market_by_slug(slug: str) -> ScannedMarket | None:
    async with httpx.AsyncClient(
        timeout=20,
        headers=POLYMARKET_HTTP_HEADERS,
    ) as client:
        response = await client.get(POLYMARKET_GAMMA_MARKETS_URL, params={"slug": slug})
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, list):
            return None
        for row in payload:
            if isinstance(row, dict):
                return _normalize_market(row, force_include=True)
    return None


async def scan_candidate_markets(
    *,
    min_liquidity_usd: float,
    existing_position_slugs: set[str] | None = None,
) -> ScanResult:
    existing_position_slugs = existing_position_slugs or set()
    accepted: list[ScannedMarket] = []
    rejected: list[ScanRejectedMarket] = []
    seen_market_ids: set[str] = set()

    async with httpx.AsyncClient(
        timeout=20,
        headers=POLYMARKET_HTTP_HEADERS,
    ) as client:
        offset = 0
        while offset < SCAN_LIMIT:
            rows = await _fetch_gamma_page(client, offset=offset)
            for row in rows:
                if not isinstance(row, dict):
                    continue
                normalized = _normalize_market(
                    row,
                    force_include=bool(
                        isinstance(row.get("slug"), str)
                        and row["slug"] in existing_position_slugs
                    ),
                )
                if normalized is None or normalized.market_id in seen_market_ids:
                    continue
                seen_market_ids.add(normalized.market_id)
                reasons = _evaluate_filter_reasons(
                    normalized,
                    min_liquidity_usd=min_liquidity_usd,
                )
                if reasons and not normalized.force_include:
                    rejected.append(
                        ScanRejectedMarket(
                            market_id=normalized.market_id,
                            question=normalized.question,
                            slug=normalized.slug,
                            market_url=normalized.market_url,
                            reasons=reasons,
                        )
                    )
                    continue
                accepted.append(normalized)
            if len(rows) < GAMMA_PAGE_SIZE:
                break
            offset += GAMMA_PAGE_SIZE

    for slug in sorted(existing_position_slugs):
        if slug in {market.slug for market in accepted if market.slug}:
            continue
        extra_market = await fetch_market_by_slug(slug)
        if extra_market is None or extra_market.market_id in seen_market_ids:
            continue
        seen_market_ids.add(extra_market.market_id)
        accepted.append(extra_market)

    return ScanResult(
        source_label="Polymarket Gamma API",
        source_url=POLYMARKET_GAMMA_MARKETS_URL,
        scanned_at=_now_iso(),
        accepted=accepted,
        rejected=rejected,
    )
