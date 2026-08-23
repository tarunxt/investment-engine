from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx

from app.domains.polymarket_auto_live.category import read_polymarket_theme

POLYMARKET_GAMMA_MARKETS_URL = "https://gamma-api.polymarket.com/markets"
POLYMARKET_HTTP_HEADERS = {"User-Agent": "investment-engine-bullpen-auto-live/1.0"}
GAMMA_PAGE_SIZE = 500
DEFAULT_GAMMA_HTTP_TIMEOUT_SECONDS = 20.0

_SHARED_GAMMA_CLIENT: ContextVar[httpx.AsyncClient | None] = ContextVar(
    "polymarket_shared_gamma_client",
    default=None,
)

SPORTS_KEYWORDS = (
    "sports",
    "esports",
    "games",
    "match",
    "tournament",
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
    "lol esports",
    "lck",
    "lpl",
    "msi",
    "mid-season invitational",
    "valorant",
    "rocket league",
    "fifa",
    "uefa",
    "team falcons",
    "xtreme gaming",
    "bilibili gaming",
    "roshan",
    "rampage",
    "ultra kill",
    "first blood",
)
SPORTS_PATTERNS = (
    re.compile(
        r"\b(?:both teams to score|exact score|leading at halftime|draw at halftime|penalty shootout|extra time)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"(?:^|\W)(?:\d+\s*)?\+\s+(?:shots?\s+on\s+target|shots?|assists?|goals?|saves?|tackles?|cards?)(?=$|\W)",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:assists?|rebounds?|points?|blocks?|steals?|threes?|3-pointers?)\s+(?:o\s*\/\s*u|over\s*\/\s*under)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bplayer\s+(?:assists?|rebounds?|points?|blocks?|steals?)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:over|under)\s+\d+(?:\.\d+)?\s+(?:assists?|rebounds?|points?|blocks?|steals?)\b",
        re.IGNORECASE,
    ),
    re.compile(r"\b(?:first|second) half\b", re.IGNORECASE),
    re.compile(r"\bhalftime\b", re.IGNORECASE),
    re.compile(r"\bmap\s+\d+\b", re.IGNORECASE),
    re.compile(r"\bgame\s+\d+\s*:", re.IGNORECASE),
    re.compile(r"\bbest of\s+\d+\b", re.IGNORECASE),
    re.compile(
        r"\b(?:team|player|club|side)\b.{0,80}\bto\s+win\s+\d+\s*-\s*\d+\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b[A-Za-z][A-Za-z0-9 .\'-]{2,50}\s+to\s+win\s+\d+\s*-\s*\d+\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bteam\s+from\s+(?:lck|lpl|lec|lcs)\b.{0,80}\bwin\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b[A-Za-z][A-Za-z .\'-]{2,40}\s+vs\.?\s+[A-Za-z][A-Za-z .\'-]{2,40}\b",
        re.IGNORECASE,
    ),
)
SPORTS_WIN_ON_DATE_PATTERN = re.compile(
    r"\b(?:will\s+)?[A-Za-z][A-Za-z .\'-]{2,40}\s+win(?:s)?\s+on\s+(?:\d{4}-\d{2}-\d{2}|(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:,\s*\d{4})?)\b",
    re.IGNORECASE,
)
SPORTS_WIN_ON_GUARD_KEYWORDS = (
    "award",
    "awards",
    "candidate",
    "coalition",
    "congress",
    "election",
    "emmy",
    "governor",
    "grammy",
    "mayor",
    "minister",
    "oscar",
    "parliament",
    "party",
    "president",
    "presidential",
    "primary",
    "referendum",
    "seat",
    "senate",
    "vote",
    "voter",
)
FILTER_TEXT_KEYS = (
    "category",
    "categoryName",
    "categorySlug",
    "primaryCategory",
    "group",
    "tag",
    "topic",
    "type",
    "tags",
    "categories",
    "question",
    "title",
    "name",
    "eventTitle",
    "marketQuestion",
    "description",
    "groupTitle",
    "groupItemTitle",
    "league",
    "tournament",
    "sport",
    "homeTeam",
    "awayTeam",
    "team",
    "team1",
    "team2",
    "competitor",
    "competitors",
    "slug",
    "marketSlug",
    "questionSlug",
    "eventSlug",
    "urlSlug",
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
RELEASED_BY_EVENT_KEYWORDS = ("released by",)
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


def is_sports_market_text(text: str) -> bool:
    return (
        _includes_any(text, SPORTS_KEYWORDS)
        or any(pattern.search(text) for pattern in SPORTS_PATTERNS)
        or (
            SPORTS_WIN_ON_DATE_PATTERN.search(text) is not None
            and not _includes_any(text, SPORTS_WIN_ON_GUARD_KEYWORDS)
        )
    )


def _build_market_url(event_slug: str | None) -> str | None:
    if not event_slug:
        return None
    return f"https://polymarket.com/event/{event_slug}"


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


def _collect_nested_strings(
    value: object,
    *,
    keys: tuple[str, ...],
    max_nodes: int = 10_000,
    max_values: int = 128,
) -> list[str]:
    if not value:
        return []

    results: list[str] = []
    seen_nodes: set[int] = set()
    stack: list[object] = [value]
    inspected = 0

    while stack and inspected < max_nodes and len(results) < max_values:
        current = stack.pop()
        if not isinstance(current, (dict, list)):
            continue

        current_id = id(current)
        if current_id in seen_nodes:
            continue
        seen_nodes.add(current_id)
        inspected += 1

        if isinstance(current, list):
            stack.extend(reversed(current))
            continue

        for key in keys:
            candidate = current.get(key)
            if isinstance(candidate, str) and candidate.strip():
                results.append(candidate.strip())
            elif isinstance(candidate, (int, float)) and not isinstance(candidate, bool):
                results.append(str(candidate))
            elif isinstance(candidate, list):
                for item in candidate:
                    if isinstance(item, str) and item.strip():
                        results.append(item.strip())
                        if len(results) >= max_values:
                            break
                if len(results) >= max_values:
                    break

        if len(results) >= max_values:
            break

        stack.extend(reversed(list(current.values())))

    return results


def build_market_filter_search_text(market: ScannedMarket) -> str:
    parts = [
        market.question,
        market.theme,
        market.slug,
        market.description,
        " ".join(market.outcome_labels),
        *_collect_nested_strings(market.raw, keys=FILTER_TEXT_KEYS),
    ]
    deduped: list[str] = []
    seen: set[str] = set()
    for part in parts:
        normalized = _normalize_text(part)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        deduped.append(normalized)
    return " ".join(deduped)


def _evaluate_filter_reasons(
    market: ScannedMarket,
    *,
    min_liquidity_usd: float,
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
    if _includes_any(search_text, RELEASED_BY_EVENT_KEYWORDS):
        reasons.append("Excluded release-by event market.")
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
    slug = (
        row.get("slug").strip()
        if isinstance(row.get("slug"), str) and row.get("slug").strip()
        else None
    )
    theme = read_polymarket_theme(
        row,
        inference_texts=(
            question.strip(),
            slug,
            " ".join(_collect_nested_strings(row, keys=FILTER_TEXT_KEYS)),
        ),
    )
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
        slug=slug,
        close_time=_normalize_close_time(row.get("endDate")),
        theme=theme,
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


@asynccontextmanager
async def shared_gamma_market_client(
    *,
    timeout_seconds: float = DEFAULT_GAMMA_HTTP_TIMEOUT_SECONDS,
) -> AsyncIterator[httpx.AsyncClient]:
    """Reuse one bounded HTTP client across a related group of Gamma lookups.

    The context-local binding preserves the existing lookup function
    signatures, including test and adapter monkeypatches, while ensuring a
    portfolio enrichment does not create one connection pool per position.
    """

    existing_client = _SHARED_GAMMA_CLIENT.get()
    if existing_client is not None:
        yield existing_client
        return

    async with httpx.AsyncClient(
        timeout=max(0.1, float(timeout_seconds)),
        headers=POLYMARKET_HTTP_HEADERS,
    ) as client:
        token = _SHARED_GAMMA_CLIENT.set(client)
        try:
            yield client
        finally:
            _SHARED_GAMMA_CLIENT.reset(token)


async def _fetch_market_by_slug_with_client(
    client: httpx.AsyncClient,
    slug: str,
) -> ScannedMarket | None:
    # This lookup is only used to prove that a wallet holding is still a live
    # market. Query the same active-only universe as the main scanner. If the
    # active lookup misses, the caller can still use the unfiltered exact-ID
    # lookup below to classify closed/settled positions without weakening
    # execution safety.
    response = await client.get(
        POLYMARKET_GAMMA_MARKETS_URL,
        params={
            "slug": slug,
            "active": "true",
            "archived": "false",
            "closed": "false",
        },
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, list):
        return None
    requested_slug = slug.strip().lower()
    for row in payload:
        if not isinstance(row, dict):
            continue
        candidate_slug = row.get("slug")
        if (
            not isinstance(candidate_slug, str)
            or candidate_slug.strip().lower() != requested_slug
        ):
            continue
        # Gamma's active/closed filters are themselves authoritative evidence
        # even when those booleans are omitted from a compact response row.
        normalized = _normalize_market(
            {
                **row,
                "active": True,
                "archived": False,
                "closed": False,
            },
            force_include=True,
        )
        if normalized is not None:
            return normalized
    return None


async def fetch_market_by_slug(slug: str) -> ScannedMarket | None:
    shared_client = _SHARED_GAMMA_CLIENT.get()
    if shared_client is not None:
        return await _fetch_market_by_slug_with_client(shared_client, slug)
    async with shared_gamma_market_client() as client:
        return await _fetch_market_by_slug_with_client(client, slug)


def _condition_id_like(value: str | None) -> bool:
    return bool(
        isinstance(value, str)
        and re.fullmatch(r"0x[a-fA-F0-9]{64}", value.strip())
    )


async def _fetch_market_by_exact_identity_with_client(
    client: httpx.AsyncClient,
    *,
    market_id: str | None,
    condition_id: str | None,
) -> ScannedMarket | None:
    """Resolve one wallet position against Gamma's documented exact-ID filters."""

    normalized_market_id = (
        market_id.strip()
        if isinstance(market_id, str) and market_id.strip()
        else None
    )
    normalized_condition_id = (
        condition_id.strip()
        if isinstance(condition_id, str) and condition_id.strip()
        else normalized_market_id
        if _condition_id_like(normalized_market_id)
        else None
    )

    # Gamma's List Markets API documents `condition_ids`, not the response-field
    # spelling `conditionId`. The old query used `conditionId`, so exact wallet
    # condition IDs silently returned no match after a slug lookup missed.
    query_plan: list[tuple[dict[str, str], str, str, bool]] = []
    if normalized_condition_id:
        query_plan.extend(
            [
                (
                    {
                        "condition_ids": normalized_condition_id,
                        "active": "true",
                        "archived": "false",
                        "closed": "false",
                    },
                    normalized_condition_id,
                    "condition_id",
                    True,
                ),
                (
                    {"condition_ids": normalized_condition_id},
                    normalized_condition_id,
                    "condition_id",
                    False,
                ),
            ]
        )
    if (
        normalized_market_id
        and normalized_market_id.isdigit()
        and normalized_market_id != normalized_condition_id
    ):
        query_plan.extend(
            [
                (
                    {
                        "id": normalized_market_id,
                        "active": "true",
                        "archived": "false",
                        "closed": "false",
                    },
                    normalized_market_id,
                    "market_id",
                    True,
                ),
                (
                    {"id": normalized_market_id},
                    normalized_market_id,
                    "market_id",
                    False,
                ),
            ]
        )
    if not query_plan:
        return None

    for params, requested_value, match_kind, active_query in query_plan:
        response = await client.get(
            POLYMARKET_GAMMA_MARKETS_URL,
            params=params,
        )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, list):
            continue
        requested_normalized = requested_value.strip().lower()
        for row in payload:
            if not isinstance(row, dict):
                continue
            if match_kind == "condition_id":
                candidate = row.get("conditionId") or row.get("condition_id")
            else:
                candidate = (
                    row.get("id")
                    or row.get("marketId")
                    or row.get("market_id")
                )
            if str(candidate or "").strip().lower() != requested_normalized:
                continue
            normalized = _normalize_market(
                {
                    **row,
                    **(
                        {
                            "active": True,
                            "archived": False,
                            "closed": False,
                        }
                        if active_query
                        else {}
                    ),
                },
                force_include=True,
            )
            if normalized is not None:
                return normalized
    return None


async def fetch_market_by_exact_identity(
    *,
    market_id: str | None,
    condition_id: str | None,
) -> ScannedMarket | None:
    """Resolve wallet rows by exact condition/market identity."""

    shared_client = _SHARED_GAMMA_CLIENT.get()
    if shared_client is not None:
        return await _fetch_market_by_exact_identity_with_client(
            shared_client,
            market_id=market_id,
            condition_id=condition_id,
        )
    async with shared_gamma_market_client() as client:
        return await _fetch_market_by_exact_identity_with_client(
            client,
            market_id=market_id,
            condition_id=condition_id,
        )


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
        while True:
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
