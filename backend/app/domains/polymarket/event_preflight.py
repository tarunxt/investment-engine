from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from html import unescape
import json
import re
from typing import Any
from zoneinfo import ZoneInfo

import httpx

from app.core.logging import get_logger
from app.domains.ai_providers.tools import web_search as web_search_tool
from app.domains.ai_providers.web_metadata import dedupe_strings
from app.domains.polymarket.stage2_models import (
    EvidencePacketV2,
    Stage2EvidenceClaim,
    Stage2EvidenceSource,
    Stage2FieldProvenance,
    Stage2MarketContext,
)
from app.domains.polymarket_auto_live.rules import (
    contains_yes_resolution_language,
    evaluate_market_rules,
    normalize_resolution_text,
)
from app.domains.polymarket_auto_live.scanner import ScannedMarket
from app.domains.runs.schemas import (
    PreparedPolymarketEventContext,
    PolymarketEventQuestionPayload,
    PolymarketEventRunContext,
)

POLYMARKET_GAMMA_MARKETS_URL = "https://gamma-api.polymarket.com/markets"
POLYMARKET_EVENT_BASE_URL = "https://polymarket.com/event"
POLYMARKET_HTTP_HEADERS = {
    "User-Agent": "investment-engine-polymarket-event-preflight/1.0",
    "Accept": "application/json,text/html,application/xhtml+xml",
}
MARKET_CONTEXT_CAPTURE_CHARS = 40_000
MAX_CONTEXT_UPDATES = 6
MAX_EVENT_SOURCES = 8
MAX_QUERY_RESULTS = 4
MAX_QUERIES_PER_EVENT = 4
ET_ZONE = ZoneInfo("America/New_York")
POLYMARKET_MARKET_CONTEXT_LABEL = (
    "Experimental AI-generated summary referencing Polymarket data."
)
logger = get_logger("app.domains.polymarket.event_preflight")

FINANCE_HINTS = (
    "bitcoin",
    "ethereum",
    "solana",
    "dogecoin",
    "price",
    "market cap",
    "stock",
    "stocks",
    "shares",
    "nasdaq",
    "nyse",
    "public",
    "ipo",
    "trading",
    "etf",
)

STALE_FACT_RULES = (
    {
        "fact_pattern": re.compile(
            r"\b("
            r"went public|has gone public|is publicly traded|started trading|began trading|"
            r"listed on|trades on (?:nasdaq|nyse|amex|tsx|lse|euronext|otc)|public ticker"
            r")\b",
            re.IGNORECASE,
        ),
        "contradiction_pattern": re.compile(
            r"\b("
            r"has not gone public|hasn't gone public|no ipo yet|still private|"
            r"is still private|remains private|not publicly traded|no public ticker"
            r")\b",
            re.IGNORECASE,
        ),
        "reason": (
            "Rationale contradicted verified evidence that already confirmed the company is public."
        ),
    },
    {
        "fact_pattern": re.compile(
            r"\b("
            r"approved|approval granted|launched|went live|started trading|began trading"
            r")\b",
            re.IGNORECASE,
        ),
        "contradiction_pattern": re.compile(
            r"\b("
            r"not approved|has not launched|hasn't launched|not live yet|still awaiting approval"
            r")\b",
            re.IGNORECASE,
        ),
        "reason": (
            "Rationale contradicted verified evidence that the relevant approval or launch already happened."
        ),
    },
)


@dataclass
class GammaMarketLookupResult:
    record: dict[str, Any] | None = None
    matched_gamma_market_id: str | None = None
    match_method: str | None = None
    exact_match_verified: bool = False


def _to_array(value: object) -> list[object]:
    return value if isinstance(value, list) else []


def _parse_json_array(value: object) -> list[object]:
    if isinstance(value, list):
        return value
    if not isinstance(value, str) or not value.strip():
        return []
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return []
    return parsed if isinstance(parsed, list) else []


def _read_string(record: dict[str, Any], keys: list[str]) -> str | None:
    for key in keys:
        value = record.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return str(value)
    return None


def _parse_number(value: object) -> float | None:
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


def _normalize_odds(value: float | None) -> float | None:
    if value is None:
        return None
    normalized = value * 100 if 0 <= value <= 1 else value
    return round(min(100.0, max(0.0, normalized)), 2)


def _normalize_text(value: str | None) -> str | None:
    if not value:
        return None
    normalized = re.sub(r"\s+", " ", value).strip()
    return normalized or None


def _format_ts(date: datetime) -> str:
    return date.strftime("%Y-%m-%d %I:%M:%S %p %Z")


def _format_odds(value: float | None) -> str:
    if value is None:
        return "Unknown"
    return f"{value:.2f}%"


def _format_text(value: str | None, fallback: str = "Not supplied") -> str:
    normalized = _normalize_text(value)
    return normalized or fallback


def _normalize_close_time(value: object) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC).isoformat()


def _canonical_market_slug(record: dict[str, Any], fallback_slug: str | None = None) -> str | None:
    return _read_string(record, ["slug", "marketSlug", "questionSlug"]) or fallback_slug


def _nested_slug(value: object, keys: list[str]) -> str | None:
    for item in [*_to_array(value), *_parse_json_array(value)]:
        if not isinstance(item, dict):
            continue
        slug = _read_string(item, keys)
        if slug:
            return slug
    if isinstance(value, dict):
        return _read_string(value, keys)
    return None


def _canonical_event_slug(record: dict[str, Any], fallback_slug: str | None = None) -> str | None:
    return (
        _read_string(record, ["eventSlug", "urlSlug"])
        or _nested_slug(record.get("events"), ["slug", "eventSlug", "urlSlug"])
        or _nested_slug(record.get("event"), ["slug", "eventSlug", "urlSlug"])
        or _read_string(record, ["seriesSlug"])
        or _nested_slug(record.get("series"), ["slug", "seriesSlug"])
        or fallback_slug
    )


def _event_url(slug: str | None) -> str | None:
    if not slug:
        return None
    return f"{POLYMARKET_EVENT_BASE_URL}/{slug}"


def _read_outcome_odds(record: dict[str, Any]) -> tuple[float | None, float | None]:
    outcomes = _parse_json_array(record.get("outcomes"))
    outcome_labels = []
    for value in outcomes:
        if isinstance(value, str):
            outcome_labels.append(value.strip().lower())
        elif isinstance(value, dict):
            label = _read_string(value, ["name", "label", "title"])
            if label:
                outcome_labels.append(label.lower())
    outcome_prices = [_parse_number(value) for value in _parse_json_array(record.get("outcomePrices"))]

    def _fallback_outcome_odds(index: int) -> float | None:
        if index >= len(outcomes):
            return None
        outcome = outcomes[index]
        if not isinstance(outcome, dict):
            return None
        return _parse_number(outcome.get("price") or outcome.get("probability"))

    yes_odds = None
    no_odds = None
    if "yes" in outcome_labels:
        yes_index = outcome_labels.index("yes")
        yes_odds = _normalize_odds(
            outcome_prices[yes_index] if yes_index < len(outcome_prices) else _fallback_outcome_odds(yes_index)
        )
    if "no" in outcome_labels:
        no_index = outcome_labels.index("no")
        no_odds = _normalize_odds(
            outcome_prices[no_index] if no_index < len(outcome_prices) else _fallback_outcome_odds(no_index)
        )
    return yes_odds, no_odds


def _read_market_identifier(record: dict[str, Any]) -> str | None:
    return _read_string(record, ["id", "marketId", "market_id"])


def _extract_rules_text(record: dict[str, Any]) -> tuple[str | None, str | None]:
    for field_name in ("resolutionCriteria", "resolution_criteria", "rules", "description"):
        value = record.get(field_name)
        if not isinstance(value, str) or not value.strip():
            continue
        normalized = normalize_resolution_text(value)
        if normalized:
            return normalized, field_name
    return None, None


def _extract_resolution_source(record: dict[str, Any], rules_text: str | None) -> str | None:
    direct = _normalize_text(_read_string(record, ["resolutionSource", "resolution_source"]))
    if direct:
        return direct
    if not rules_text:
        return None
    match = re.search(
        r"The resolution source for this market will be.+?(?:\.|$)",
        rules_text,
        flags=re.IGNORECASE,
    )
    return _normalize_text(match.group(0) if match else None)


def _html_to_text(value: str | None) -> str | None:
    if not value:
        return None
    normalized = (
        unescape(
            re.sub(
                r"<[^>]+>",
                " ",
                value.replace("<br>", "\n")
                .replace("<br/>", "\n")
                .replace("<br />", "\n"),
            )
        )
        .replace("\xa0", " ")
        .strip()
    )
    normalized = re.sub(r"[ \t]+\n", "\n", normalized)
    normalized = re.sub(r"\n[ \t]+", "\n", normalized)
    normalized = re.sub(r"[ \t]{2,}", " ", normalized)
    normalized = re.sub(r"\n{3,}", "\n\n", normalized)
    return normalized or None


def _extract_market_context_timeline(panel_slice: str) -> list[str]:
    timeline_entries: list[str] = []
    timeline_pattern = re.compile(
        r"<span[^>]*>(.*?)</span>\s*<p[^>]*>(.*?)</p>\s*<p[^>]*>(.*?)</p>\s*<p[^>]*>(.*?)</p>",
        flags=re.IGNORECASE | re.DOTALL,
    )
    for match in timeline_pattern.finditer(panel_slice):
        parts = [_html_to_text(match.group(index)) for index in range(1, 5)]
        date, headline, odds_move, detail = parts
        if not date or not headline or not detail:
            continue
        line_parts = [f"{date}: {headline}"]
        if odds_move:
            line_parts.append(f"odds: {odds_move}")
        line_parts.append(detail)
        timeline_entries.append(" | ".join(line_parts))
        if len(timeline_entries) >= MAX_CONTEXT_UPDATES:
            break
    return timeline_entries


def _extract_market_context_text(html: str) -> str | None:
    panel_match = re.search(
        r"<(?:div|section)[^>]*\brole=[\"']tabpanel[\"'][^>]*\bid=[\"'][^\"']*-panel-context[\"'][^>]*>",
        html,
        flags=re.IGNORECASE,
    )
    if panel_match:
        panel_slice = html[
            panel_match.start() : panel_match.start() + MARKET_CONTEXT_CAPTURE_CHARS
        ]
    else:
        label_index = html.find(POLYMARKET_MARKET_CONTEXT_LABEL)
        if label_index < 0:
            return None
        panel_slice = html[
            max(0, label_index - 5_000) : label_index + MARKET_CONTEXT_CAPTURE_CHARS
        ]

    article_start = panel_slice.find("<article>")
    article_slice = panel_slice[article_start:] if article_start >= 0 else panel_slice
    summary_match = re.search(r"<p[^>]*>([\s\S]*?)</p>", article_slice, flags=re.IGNORECASE)
    disclaimer_match = re.search(
        r"<small[^>]*>([\s\S]*?)</small>",
        article_slice,
        flags=re.IGNORECASE,
    )
    sections = [
        _html_to_text(summary_match.group(1) if summary_match else None),
        _html_to_text(disclaimer_match.group(1) if disclaimer_match else None),
    ]
    sections = [section for section in sections if section]
    timeline_entries = _extract_market_context_timeline(article_slice)
    if timeline_entries:
        sections.append("Timeline updates:\n- " + "\n- ".join(timeline_entries))
    if sections:
        return "\n\n".join(sections)
    return _html_to_text(article_slice[:12_000])


def _fetch_event_market_context(market_url: str | None) -> str | None:
    if not market_url:
        return None
    try:
        response = httpx.get(
            market_url,
            headers={
                **POLYMARKET_HTTP_HEADERS,
                "Accept": "text/html,application/xhtml+xml",
            },
            timeout=20,
            follow_redirects=True,
        )
        response.raise_for_status()
    except Exception:
        return None
    return _extract_market_context_text(response.text)


def _fetch_gamma_market_records(params: list[tuple[str, str]]) -> list[dict[str, Any]]:
    response = httpx.get(
        POLYMARKET_GAMMA_MARKETS_URL,
        params=params,
        headers=POLYMARKET_HTTP_HEADERS,
        timeout=20,
        follow_redirects=True,
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, list):
        return []
    return [item for item in payload if isinstance(item, dict)]


def _fetch_gamma_market(question: PolymarketEventQuestionPayload) -> GammaMarketLookupResult:
    requested_condition_id = _normalize_lookup_value(question.condition_id)
    requested_market_ids = [
        identifier
        for identifier in (
            _normalize_lookup_value(question.market_id),
            _normalize_lookup_value(question.question_id),
        )
        if identifier
    ]
    requested_market_slug = _normalize_lookup_value(question.market_slug or question.slug)

    query_plan: list[tuple[str, str, str]] = []
    if requested_condition_id:
        query_plan.append(("conditionId", requested_condition_id, "condition_id"))

    seen_market_ids: set[str] = set()
    for market_id in requested_market_ids:
        if market_id in seen_market_ids:
            continue
        seen_market_ids.add(market_id)
        query_plan.append(("id", market_id, "market_id"))

    if requested_market_slug:
        query_plan.append(("slug", requested_market_slug, "slug"))

    for param_name, requested_value, match_method in query_plan:
        payload = _fetch_gamma_market_records([(param_name, requested_value)])
        for item in payload:
            if match_method == "condition_id":
                candidate_value = _normalize_lookup_value(
                    _read_string(item, ["conditionId", "condition_id"])
                )
            elif match_method == "market_id":
                candidate_value = _normalize_lookup_value(_read_market_identifier(item))
            else:
                candidate_value = _normalize_lookup_value(_canonical_market_slug(item))
            if candidate_value != requested_value:
                continue
            return GammaMarketLookupResult(
                record=item,
                matched_gamma_market_id=_read_market_identifier(item),
                match_method=match_method,
                exact_match_verified=True,
            )

    return GammaMarketLookupResult()


def _parse_search_payload(raw: str) -> tuple[list[dict[str, str | None]], list[str]]:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        return [], [f"Search payload was not valid JSON: {exc}"]

    warnings: list[str] = []
    if isinstance(payload, dict):
        errors = payload.get("errors")
        if isinstance(errors, list):
            warnings.extend(str(item) for item in errors if item is not None)

    rows = payload.get("results") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        return [], warnings

    results: list[dict[str, str | None]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        title = _normalize_text(str(row.get("title") or "").strip())
        url = _normalize_text(str(row.get("url") or "").strip())
        content = _normalize_text(str(row.get("content") or "").strip())
        published_date = _normalize_text(str(row.get("published_date") or "").strip())
        if not title and not url and not content:
            continue
        results.append(
            {
                "title": title,
                "url": url,
                "content": content,
                "published_date": published_date,
            }
        )
    return results, warnings


def _is_finance_relevant(question: PolymarketEventQuestionPayload, context_text: str | None) -> bool:
    haystack = " ".join(
        part.lower()
        for part in [
            question.question,
            question.category,
            context_text or "",
        ]
        if part
    )
    for phrase in ("not trading advice", "no trading advice", "this is not trading advice"):
        haystack = haystack.replace(phrase, " ")
    return any(re.search(rf"\b{re.escape(hint)}\b", haystack) for hint in FINANCE_HINTS)


def _dedupe_queries(values: list[str]) -> list[str]:
    seen: set[str] = set()
    deduped: list[str] = []
    for value in values:
        normalized = re.sub(r"\s+", " ", value).strip()
        key = normalized.lower()
        if not normalized or key in seen:
            continue
        seen.add(key)
        deduped.append(normalized)
        if len(deduped) >= MAX_QUERIES_PER_EVENT:
            break
    return deduped


def _build_search_queries(
    question: PolymarketEventQuestionPayload,
    *,
    refreshed_question: str,
    rules_text: str | None,
    resolution_source: str | None,
    market_context: str | None,
    deadline_hint: str | None = None,
    timezone_hint: str | None = None,
    yes_definition: str | None = None,
) -> list[str]:
    queries = [
        refreshed_question,
        f"{refreshed_question} official source",
    ]
    if yes_definition:
        queries.append(yes_definition)
        queries.append(f"{yes_definition} official confirmation")
    if deadline_hint:
        queries.append(
            " ".join(
                part
                for part in [refreshed_question, deadline_hint, timezone_hint or ""]
                if part
            )
        )
    if resolution_source:
        queries.append(f"{refreshed_question} {resolution_source}")
    if _is_finance_relevant(question, market_context or rules_text):
        queries.append(f"{refreshed_question} price market cap status today")
    return _dedupe_queries(queries)


def _build_evidence_highlights(results: list[dict[str, str | None]]) -> list[str]:
    highlights: list[str] = []
    for result in results:
        title = result.get("title") or "Untitled source"
        date_part = f"[{result['published_date']}] " if result.get("published_date") else ""
        snippet = result.get("content") or "No snippet returned."
        url = result.get("url") or "No URL returned."
        highlights.append(f"- {date_part}{title} | {snippet} | {url}")
        if len(highlights) >= MAX_EVENT_SOURCES:
            break
    return highlights


def _normalize_url(url: str | None) -> str | None:
    if not url:
        return None
    normalized = url.strip().rstrip("/")
    return normalized or None


def _content_fingerprint(*values: str | None) -> str | None:
    payload = " | ".join(value.strip() for value in values if value and value.strip())
    if not payload:
        return None
    import hashlib

    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def _source_domain(url: str | None) -> str | None:
    if not url:
        return None
    match = re.match(r"https?://([^/]+)", url)
    return match.group(1).lower() if match else None


def _classify_source_type(domain: str | None) -> str:
    if not domain:
        return "unknown"
    if re.search(r"\.gov$|\bgov\.", domain, re.I):
        return "official_government"
    if re.search(r"\.mil$|\bmil\.", domain, re.I):
        return "official_military"
    if re.search(r"(reuters|apnews|nytimes|wsj|bloomberg|ft|bbc)\.", domain, re.I):
        return "major_news"
    if re.search(r"(defense|politico|axios|aljazeera|haaretz|techcrunch|theverge)\.", domain, re.I):
        return "specialist_news"
    if re.search(r"(google\.com|news\.google|wikipedia\.org)\.", domain, re.I):
        return "aggregator"
    return "unknown"


def _is_generic_landing_page(
    *,
    title: str | None,
    url: str | None,
    content: str | None,
    question_text: str,
) -> bool:
    domain = _source_domain(url) or ""
    if "wikipedia.org" in domain:
        return True
    if url and re.fullmatch(r"https?://[^/]+/?", url.strip()):
        return True
    question_tokens = [
        token
        for token in re.findall(r"[A-Za-z0-9]{4,}", question_text.lower())
        if token not in {"will", "what", "when", "with", "this", "that", "from"}
    ]
    haystack = " ".join(part for part in [(title or "").lower(), (content or "").lower(), (url or "").lower()] if part)
    if question_tokens and not any(token in haystack for token in question_tokens[:5]):
        return True
    return False


def _build_evidence_packet_v2(
    *,
    event_id: str,
    question_text: str,
    search_objective: str | None,
    search_queries: list[str],
    search_results: list[dict[str, str | None]],
    warnings: list[str],
    built_at_utc: str,
) -> EvidencePacketV2:
    sources: list[Stage2EvidenceSource] = []
    claims: list[Stage2EvidenceClaim] = []
    seen_source_keys: set[str] = set()
    for result in search_results:
        normalized_url = _normalize_url(result.get("url"))
        fingerprint = _content_fingerprint(
            result.get("title"),
            normalized_url,
            result.get("content"),
        )
        dedupe_key = normalized_url or fingerprint
        if not dedupe_key or dedupe_key in seen_source_keys:
            continue
        seen_source_keys.add(dedupe_key)
        domain = _source_domain(normalized_url)
        generic = _is_generic_landing_page(
            title=result.get("title"),
            url=normalized_url,
            content=result.get("content"),
            question_text=question_text,
        )
        source_type = (
            "generic_landing_page"
            if generic
            else _classify_source_type(domain)
        )
        source = Stage2EvidenceSource(
            source_id=f"S{len(sources) + 1}",
            title=result.get("title"),
            url=normalized_url,
            publisher=domain,
            domain=domain,
            published_at=result.get("published_date"),
            fetched_at=built_at_utc,
            source_type=source_type,  # type: ignore[arg-type]
            relevance_score=0.25 if generic else 0.65,
            entity_match=bool(result.get("title")),
            event_date_match=False,
            resolution_criterion_match=bool(search_objective),
            is_generic_landing_page=generic,
            snippet=result.get("content"),
            extracted_claims=[result["content"]] if result.get("content") else [],
            source_warning="Generic landing page was down-ranked." if generic else None,
            content_fingerprint=fingerprint,
        )
        sources.append(source)
        if result.get("content"):
            claims.append(
                Stage2EvidenceClaim(
                    claim_id=f"C{len(claims) + 1}",
                    claim_text=result["content"],
                    supporting_source_ids=[source.source_id],
                    verification_status=(
                        "supported"
                        if source_type != "generic_landing_page"
                        else "unverified"
                    ),
                    confidence=0.3 if generic else 0.7,
                )
            )
        if len(sources) >= MAX_EVENT_SOURCES:
            break
    sufficiency_status = (
        "sufficient"
        if any(not source.is_generic_landing_page for source in sources)
        else "insufficient"
        if sources
        else "missing"
    )
    packet_warnings = list(warnings)
    if not sources:
        packet_warnings.append("No relevant external evidence sources were captured.")
    return EvidencePacketV2(
        built_at_utc=built_at_utc,
        event_id=event_id,
        exact_resolution_question=question_text,
        search_objective=search_objective,
        queries=search_queries,
        sources=sources,
        claims=claims,
        warnings=dedupe_strings(packet_warnings, limit=MAX_EVENT_SOURCES * 2),
        sufficiency_status=sufficiency_status,  # type: ignore[arg-type]
    )


def _build_verified_evidence_block(
    question: PolymarketEventQuestionPayload,
    *,
    refreshed_question: str,
    current_time_utc: str,
    current_time_et: str,
    market_url: str | None,
    slug: str | None,
    current_yes_odds: float | None,
    current_no_odds: float | None,
    close_time: str | None,
    close_time_et: str | None,
    deadline_et: str | None,
    hours_remaining: float | None,
    rules_text: str | None,
    market_context: str | None,
    resolution_source: str | None,
    search_queries: list[str],
    search_results: list[dict[str, str | None]],
    warnings: list[str],
) -> str:
    highlight_lines = _build_evidence_highlights(search_results)
    source_urls = dedupe_strings(
        [result.get("url") or "" for result in search_results],
        limit=MAX_EVENT_SOURCES,
    )
    block_lines = [
        "Verified Evidence Block:",
        "Market:",
        refreshed_question,
        "",
        "Rules:",
        _format_text(rules_text),
        "",
        "Verified current facts:",
        f"- question_ref: {question.question_ref}",
        f"- question_id: {question.question_id}",
        f"- category: {_format_text(question.category, 'Unknown')}",
        f"- current time (UTC): {current_time_utc}",
        f"- current time (ET): {current_time_et}",
        f"- close time: {_format_text(close_time, 'Unknown')}",
        f"- close time (ET): {_format_text(close_time_et, 'Unknown')}",
        f"- deadline (ET): {_format_text(deadline_et, 'Unknown')}",
        f"- hours remaining: {hours_remaining if hours_remaining is not None else 'Unknown'}",
        f"- current yes odds: {_format_odds(current_yes_odds)}",
        f"- current no odds: {_format_odds(current_no_odds)}",
        f"- market URL: {_format_text(market_url)}",
        f"- slug: {_format_text(slug)}",
        f"- Polymarket rules: {_format_text(rules_text)}",
        f"- detailed market context: {_format_text(market_context)}",
        f"- resolution source: {_format_text(resolution_source)}",
        f"- source count: {len(source_urls)}",
        f"- search queries: {' | '.join(search_queries) if search_queries else 'None'}",
    ]
    if source_urls:
        block_lines.append(f"- official/current sources: {' | '.join(source_urls)}")
    block_lines.extend(
        [
            "",
            "Latest search results:",
            *(
                highlight_lines
                or ["- No current search results were returned. Treat unresolved facts as uncertain."]
            ),
        ]
    )
    if warnings:
        block_lines.extend(["", "Warnings:", *[f"- {warning}" for warning in warnings]])
    block_lines.extend(
        [
            "",
            "Instruction:",
            (
                "Treat every populated fact above as verified fresh context for this run. "
                "Do not contradict it. Only estimate the unresolved condition that remains "
                "after accepting the exact Polymarket rules and this verified evidence."
            ),
        ]
    )
    return "\n".join(block_lines)


def _build_prompt(template: str, question_payload: list[dict[str, Any]]) -> str:
    selected_questions_json = json.dumps(question_payload, ensure_ascii=False, indent=2)
    placeholder = "{{SELECTED_QUESTIONS}}"
    normalized_template = template.strip()
    has_stage2_context = any(
        isinstance(item, dict) and isinstance(item.get("stage2_context"), dict)
        for item in question_payload
    )
    if has_stage2_context and "[stage2_shared_evidence_only]" not in normalized_template.lower():
        normalized_template = (
            "[STAGE2_SHARED_EVIDENCE_ONLY]\n"
            f"{normalized_template}"
        )
    if placeholder in normalized_template:
        return normalized_template.replace(placeholder, selected_questions_json)
    return f"{normalized_template}\n\nSelected questions:\n{selected_questions_json}"


def _prepend_openai_search_token(prompt: str) -> str:
    normalized = prompt.lstrip()
    if normalized.lower().startswith("[enable_web_search]"):
        return prompt
    return f"[enable_web_search]\n{prompt}"


def _append_required_search_instruction(prompt: str, provider_name: str) -> str:
    if provider_name not in {"gemini", "deepseek"}:
        return prompt
    return (
        f"{prompt}\n\n"
        "[REQUIRE_MODEL_WEB_SEARCH]\n"
        "Before your final answer, you must use live search or web tools at least once for this event run. "
        "If a required fact is still unresolved, search again before concluding."
    )


def _extract_json_value_from_text(text: str) -> object | None:
    trimmed = (text or "").strip()
    if not trimmed:
        return None

    candidates: list[str] = []

    def _register(candidate: str | None) -> None:
        if not candidate:
            return
        normalized = candidate.strip()
        if normalized and normalized not in candidates:
            candidates.append(normalized)

    for match in re.finditer(r"```(?:json)?\s*([\s\S]*?)```", trimmed, flags=re.IGNORECASE):
        _register(match.group(1))
    _register(trimmed)

    object_start = trimmed.find("{")
    object_end = trimmed.rfind("}")
    if object_start >= 0 and object_end > object_start:
        _register(trimmed[object_start : object_end + 1])

    array_start = trimmed.find("[")
    array_end = trimmed.rfind("]")
    if array_start >= 0 and array_end > array_start:
        _register(trimmed[array_start : array_end + 1])

    for candidate in candidates:
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue
    return None


def _read_rationale(record: dict[str, Any]) -> str | None:
    for key in (
        "rationale",
        "reasoning",
        "notes",
        "note",
        "explanation",
        "summary",
    ):
        value = record.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _normalize_lookup_value(value: str | None) -> str | None:
    if not value:
        return None
    normalized = re.sub(r"\s+", " ", value).strip().lower()
    return normalized or None


def _extract_fact_map(preflight_evidence_block: str | None) -> dict[str, str]:
    if not preflight_evidence_block:
        return {}
    match = re.split(r"Verified current facts:\s*", preflight_evidence_block, flags=re.IGNORECASE)
    if len(match) < 2:
        return {}
    facts_section = re.split(r"\n\s*Latest search results:\s*", match[1], maxsplit=1, flags=re.IGNORECASE)[0]
    fact_map: dict[str, str] = {}
    for raw_line in facts_section.splitlines():
        line = raw_line.strip()
        fact_match = re.match(r"^- ([^:]+):\s*(.+)$", line)
        if not fact_match:
            continue
        key = _normalize_lookup_value(fact_match.group(1))
        value = (fact_match.group(2) or "").strip()
        if not key or not value or value in {"Not supplied", "Unknown"}:
            continue
        fact_map[key] = value
    return fact_map


def detect_stale_fact(
    preflight_evidence_block: str | None,
    rationale: str | None,
) -> tuple[bool, str | None]:
    if not rationale or not rationale.strip():
        return False, None
    fact_map = _extract_fact_map(preflight_evidence_block)
    authoritative_context = "\n".join(
        value
        for value in [
            fact_map.get("detailed market context"),
            fact_map.get("resolution source"),
        ]
        if value
    )
    if not authoritative_context:
        return False, None
    for rule in STALE_FACT_RULES:
        if (
            rule["fact_pattern"].search(authoritative_context)
            and rule["contradiction_pattern"].search(rationale)
        ):
            return True, str(rule["reason"])
    return False, None


def prepare_polymarket_event_context(
    context: PolymarketEventRunContext,
) -> PreparedPolymarketEventContext:
    now_utc = datetime.now(UTC)
    now_et = now_utc.astimezone(ET_ZONE)
    refreshed_payload: list[PolymarketEventQuestionPayload] = []
    question_runtime: dict[str, dict[str, Any]] = {}
    all_queries: list[str] = []
    all_sources: list[str] = []
    all_warnings: list[str] = []
    canonical_contexts: dict[str, dict[str, Any]] = {}

    for index, question in enumerate(context.question_payload):
        event_id = (
            _normalize_lookup_value(question.question_id)
            or _normalize_lookup_value(question.market_id)
            or _normalize_lookup_value(question.question_ref)
            or f"event-{index + 1}"
        )
        refreshed_question = question.question
        refreshed_market_id = question.market_id or question.question_id
        refreshed_market_url = question.market_url
        refreshed_slug = question.slug
        refreshed_market_slug = question.market_slug or question.slug
        refreshed_event_slug = question.event_slug
        refreshed_yes_odds = question.current_yes_odds
        refreshed_no_odds = question.current_no_odds
        refreshed_rules = normalize_resolution_text(question.polymarket_rules)
        refreshed_rule_source_field = "legacy_payload" if refreshed_rules else None
        refreshed_market_context = question.polymarket_market_context
        refreshed_resolution_source = question.polymarket_resolution_source
        refreshed_condition_id = question.condition_id
        refreshed_volume = None
        refreshed_liquidity = None
        refreshed_best_bid = None
        refreshed_best_ask = None
        refreshed_spread = None
        refreshed_close_time = question.close_time or question.closing_time
        question_warnings: list[str] = []
        field_provenance: dict[str, Stage2FieldProvenance] = {}

        def note_provenance(
            field_name: str,
            *,
            source: str,
            validation_status: str | None = None,
            note: str | None = None,
        ) -> None:
            notes = [note] if note else []
            field_provenance[field_name] = Stage2FieldProvenance(
                source=source,
                fetched_at_utc=now_utc.isoformat(),
                validation_status=validation_status,
                notes=notes,
            )

        try:
            gamma_lookup = _fetch_gamma_market(question)
        except Exception as exc:
            gamma_lookup = GammaMarketLookupResult()
            question_warnings.append(f"Polymarket Gamma refresh failed: {exc}")
        gamma_record = gamma_lookup.record

        if gamma_record:
            refreshed_market_id = _read_market_identifier(gamma_record) or refreshed_market_id
            refreshed_question = _read_string(
                gamma_record,
                ["question", "title", "name", "marketQuestion"],
            ) or refreshed_question
            refreshed_close_time = _normalize_close_time(
                _read_string(
                    gamma_record,
                    ["endDate", "end_date", "closeTime", "close_time", "closingTime"],
                )
            ) or refreshed_close_time
            refreshed_market_slug = _canonical_market_slug(
                gamma_record,
                refreshed_market_slug,
            )
            refreshed_event_slug = _canonical_event_slug(
                gamma_record,
                refreshed_event_slug or refreshed_market_slug,
            )
            refreshed_slug = refreshed_market_slug or refreshed_slug
            refreshed_market_url = _event_url(refreshed_event_slug) or refreshed_market_url
            refreshed_yes_odds, refreshed_no_odds = _read_outcome_odds(gamma_record)
            refreshed_rules, refreshed_rule_source_field = _extract_rules_text(gamma_record)
            refreshed_resolution_source = (
                _extract_resolution_source(gamma_record, refreshed_rules)
                or refreshed_resolution_source
            )
            refreshed_condition_id = _read_string(
                gamma_record,
                ["conditionId", "condition_id"],
            ) or refreshed_condition_id
            refreshed_volume = _parse_number(gamma_record.get("volume"))
            refreshed_liquidity = _parse_number(gamma_record.get("liquidity"))
            refreshed_best_bid = _parse_number(
                gamma_record.get("bestBid") or gamma_record.get("best_bid")
            )
            refreshed_best_ask = _parse_number(
                gamma_record.get("bestAsk") or gamma_record.get("best_ask")
            )
            if refreshed_best_bid is not None and refreshed_best_ask is not None:
                refreshed_spread = round(max(0.0, refreshed_best_ask - refreshed_best_bid), 4)
            fetched_market_context = _fetch_event_market_context(refreshed_market_url)
            refreshed_market_context = fetched_market_context or refreshed_market_context
            note_provenance("question", source="gamma", validation_status="matched")
            note_provenance("canonical_market_slug", source="gamma", validation_status="matched")
            note_provenance("canonical_event_slug", source="gamma", validation_status="matched")
            note_provenance("matched_gamma_market_id", source="gamma", validation_status="matched")
            note_provenance(
                "canonical_market_url",
                source="gamma",
                validation_status="matched" if refreshed_market_url else "missing",
            )
            note_provenance(
                "exact_resolution_rules",
                source=(
                    f"gamma.{refreshed_rule_source_field}"
                    if refreshed_rule_source_field
                    else "gamma"
                ),
                validation_status="matched" if refreshed_rules else "missing",
                note=(
                    None
                    if refreshed_rules
                    else "Exact Gamma child market matched, but direct rules fields were empty."
                ),
            )
            note_provenance("close_time", source="gamma", validation_status="matched")
            if refreshed_market_context:
                note_provenance(
                    "background_market_context",
                    source="polymarket_event_page",
                    validation_status="background_only",
                    note="Experimental AI-generated Polymarket summary is background context only.",
                )
            if not refreshed_rules:
                question_warnings.append(
                    "Exact Polymarket Gamma child market matched, but direct description/rules/resolutionCriteria fields were empty."
                )
        else:
            question_warnings.append(
                "No exact Polymarket Gamma child market matched the saved condition ID / market ID / slug; kept the original scanner values but blocked Stage 3 from trusting unmatched rules."
            )
            note_provenance(
                "canonical_market_url",
                source="legacy_payload",
                validation_status="unresolved",
                note="Gamma refresh did not return a verified market match.",
            )
            note_provenance(
                "exact_resolution_rules",
                source="legacy_payload",
                validation_status="unresolved",
                note="Original scanner rules were kept only as a fallback because no exact Gamma child market was verified.",
            )

        temp_market = ScannedMarket(
            market_id=refreshed_market_id,
            question=refreshed_question,
            market_url=refreshed_market_url,
            slug=refreshed_market_slug or refreshed_slug,
            close_time=refreshed_close_time,
            theme=question.category,
            current_yes_odds=refreshed_yes_odds,
            current_no_odds=refreshed_no_odds,
            volume_usd=refreshed_volume,
            liquidity_usd=refreshed_liquidity,
            description=refreshed_rules,
            outcome_labels=list(question.outcomes),
            event_slug=refreshed_event_slug,
            best_bid_cents=refreshed_best_bid,
            best_ask_cents=refreshed_best_ask,
            spread_cents=refreshed_spread,
            raw={
                "market_context": refreshed_market_context,
                "resolution_source": refreshed_resolution_source,
                "condition_id": refreshed_condition_id,
                "matched_gamma_market_id": gamma_lookup.matched_gamma_market_id,
                "gamma_match_method": gamma_lookup.match_method,
                "exact_gamma_market_verified": gamma_lookup.exact_match_verified,
                "authoritative_rule_source_field": refreshed_rule_source_field,
            },
        )
        refreshed_rule_evaluation = evaluate_market_rules(
            temp_market,
            now=now_utc,
            resolution_text=refreshed_rules,
            exact_market_match_verified=gamma_lookup.exact_match_verified,
        )
        if not gamma_lookup.exact_match_verified:
            refreshed_rule_evaluation.yes_definition = None
            refreshed_rule_evaluation.ambiguous = True
            refreshed_rule_evaluation.fail_reason = "Exact Gamma market match is unavailable."
            refreshed_rule_evaluation.rule_gate_result = "blocked"
        if refreshed_rule_evaluation.rule_gate_result == "bypassed_verified_binary_rules":
            note_provenance(
                "exact_yes_definition",
                source="rules_parser",
                validation_status="bypassed_verified_binary_rules",
                note=(
                    "Verified binary YES/NO rules safely bypassed the strict deterministic YES extractor."
                ),
            )
        elif refreshed_rule_evaluation.yes_definition:
            note_provenance(
                "exact_yes_definition",
                source="rules_parser",
                validation_status="matched",
                note=refreshed_rule_evaluation.yes_definition_extraction_method,
            )
        else:
            note_provenance(
                "exact_yes_definition",
                source="rules_parser",
                validation_status="blocked",
                note=refreshed_rule_evaluation.fail_reason,
            )
        if (
            not refreshed_rule_evaluation.yes_resolution_language_detected
            and contains_yes_resolution_language(refreshed_rules)
        ):
            question_warnings.append(
                "Rules mention YES resolution language, but no deterministic clause could be preserved."
            )
        logger.info(
            "Polymarket rule gate question_id=%s market_id=%s condition_id=%s matched_gamma_market_id=%s match_method=%s rule_source_field=%s extraction_method=%s extraction_confidence=%s gate_result=%s normalized_rules=%s",
            question.question_id,
            refreshed_market_id,
            refreshed_condition_id,
            gamma_lookup.matched_gamma_market_id,
            gamma_lookup.match_method,
            refreshed_rule_source_field,
            refreshed_rule_evaluation.yes_definition_extraction_method,
            refreshed_rule_evaluation.yes_definition_extraction_confidence,
            refreshed_rule_evaluation.rule_gate_result,
            refreshed_rules,
        )

        search_results: list[dict[str, str | None]] = []
        search_queries: list[str] = []
        evidence_packet: EvidencePacketV2 | None = None
        if context.evidence_options.require_fresh_internet_evidence:
            search_queries = _build_search_queries(
                question,
                refreshed_question=refreshed_question,
                rules_text=refreshed_rules,
                resolution_source=refreshed_resolution_source,
                market_context=refreshed_market_context,
                deadline_hint=refreshed_rule_evaluation.resolution_date_window,
                timezone_hint=(
                    refreshed_rule_evaluation.resolution_timezone_name
                    or refreshed_rule_evaluation.resolution_timezone_iana
                ),
                yes_definition=refreshed_rule_evaluation.yes_definition,
            )
            seen_result_keys: set[str] = set()
            for query in search_queries:
                raw_payload = web_search_tool.execute(
                    "web_search",
                    {"query": query, "max_results": MAX_QUERY_RESULTS},
                )
                parsed_results, query_warnings = _parse_search_payload(raw_payload)
                question_warnings.extend(query_warnings)
                all_queries.append(query)
                for parsed in parsed_results:
                    result_key = _normalize_url(parsed.get("url")) or _content_fingerprint(
                        parsed.get("title"),
                        parsed.get("content"),
                    )
                    if not result_key or result_key in seen_result_keys:
                        continue
                    seen_result_keys.add(result_key)
                    search_results.append(parsed)
            evidence_packet = _build_evidence_packet_v2(
                event_id=event_id,
                question_text=refreshed_question,
                search_objective=refreshed_rule_evaluation.yes_definition
                or refreshed_question,
                search_queries=search_queries,
                search_results=search_results,
                warnings=question_warnings,
                built_at_utc=now_utc.isoformat(),
            )

        question_sources = dedupe_strings(
            [result.get("url") or "" for result in search_results],
            limit=MAX_EVENT_SOURCES,
        )
        all_sources.extend(question_sources)
        all_warnings.extend(question_warnings)

        verified_block = _build_verified_evidence_block(
            question,
            refreshed_question=refreshed_question,
            current_time_utc=now_utc.isoformat(),
            current_time_et=_format_ts(now_et),
            market_url=refreshed_market_url,
            slug=refreshed_market_slug or refreshed_slug,
            current_yes_odds=refreshed_yes_odds,
            current_no_odds=refreshed_no_odds,
            close_time=refreshed_close_time,
            close_time_et=refreshed_rule_evaluation.deadline_et,
            deadline_et=refreshed_rule_evaluation.deadline_et,
            hours_remaining=refreshed_rule_evaluation.hours_remaining,
            rules_text=refreshed_rules,
            market_context=refreshed_market_context,
            resolution_source=refreshed_resolution_source,
            search_queries=search_queries,
            search_results=search_results,
            warnings=question_warnings,
        )
        if evidence_packet is not None:
            evidence_packet.legacy_preflight_evidence_block = verified_block

        canonical_context = Stage2MarketContext(
            event_id=event_id,
            question_ref=question.question_ref,
            question_id=question.question_id,
            market_id=refreshed_market_id,
            condition_id=refreshed_condition_id,
            question=refreshed_question,
            canonical_market_url=refreshed_market_url,
            canonical_market_slug=refreshed_market_slug or refreshed_slug,
            canonical_event_slug=refreshed_event_slug,
            category=question.category,
            theme=question.category,
            outcome_labels=list(question.outcomes),
            current_yes_odds=refreshed_yes_odds,
            current_no_odds=refreshed_no_odds,
            best_bid_cents=refreshed_best_bid,
            best_ask_cents=refreshed_best_ask,
            spread_cents=refreshed_spread,
            volume_usd=refreshed_volume,
            liquidity_usd=refreshed_liquidity,
            exact_resolution_rules=refreshed_rules,
            exact_yes_definition=refreshed_rule_evaluation.yes_definition,
            matched_gamma_market_id=gamma_lookup.matched_gamma_market_id,
            gamma_match_method=gamma_lookup.match_method,
            exact_gamma_market_verified=gamma_lookup.exact_match_verified,
            authoritative_rule_source_field=refreshed_rule_source_field,
            yes_definition_supporting_text=refreshed_rule_evaluation.yes_definition_supporting_text,
            yes_definition_extraction_method=refreshed_rule_evaluation.yes_definition_extraction_method,
            yes_definition_extraction_confidence=refreshed_rule_evaluation.yes_definition_extraction_confidence,
            yes_resolution_language_detected=refreshed_rule_evaluation.yes_resolution_language_detected,
            final_rule_gate_result=refreshed_rule_evaluation.rule_gate_result,
            resolution_source_description=refreshed_resolution_source,
            background_market_context=refreshed_market_context,
            background_context_warning=(
                "Experimental AI-generated Polymarket summary is background context only."
                if refreshed_market_context
                and POLYMARKET_MARKET_CONTEXT_LABEL.lower()
                in refreshed_market_context.lower()
                else None
            ),
            resolution_timezone_name=refreshed_rule_evaluation.resolution_timezone_name,
            resolution_timezone_iana=refreshed_rule_evaluation.resolution_timezone_iana,
            deadline_local=refreshed_rule_evaluation.deadline_local,
            deadline_utc=refreshed_rule_evaluation.deadline_utc,
            hours_remaining=refreshed_rule_evaluation.hours_remaining,
            deadline_source=refreshed_rule_evaluation.deadline_source,
            deadline_confidence=refreshed_rule_evaluation.deadline_confidence,
            current_time_utc=now_utc.isoformat(),
            rule_quality_status=refreshed_rule_evaluation.rule_quality_status,
            url_validation_status=(
                "matched"
                if gamma_record is not None and refreshed_market_url
                else "unresolved"
            ),
            warnings=dedupe_strings(
                [
                    *question_warnings,
                    *(refreshed_rule_evaluation.warnings or []),
                ],
                limit=MAX_EVENT_SOURCES * 2,
            ),
            field_provenance=field_provenance,
            field_fetched_at={
                key: now_utc.isoformat()
                for key in (
                    "canonical_market_url",
                    "canonical_market_slug",
                    "canonical_event_slug",
                    "matched_gamma_market_id",
                    "current_yes_odds",
                    "current_no_odds",
                    "close_time",
                    "exact_resolution_rules",
                    "exact_yes_definition",
                    "resolution_source_description",
                )
            },
            evidence_packet=evidence_packet,
            legacy_preflight_evidence_block=verified_block,
        )
        canonical_contexts[question.question_id] = canonical_context.model_dump(
            mode="json"
        )

        refreshed_payload.append(
            question.model_copy(
                update={
                    "question": refreshed_question,
                    "current_time_utc": now_utc.isoformat(),
                    "current_time_et": _format_ts(now_et),
                    "market_url": refreshed_market_url,
                    "slug": refreshed_market_slug or refreshed_slug,
                    "market_slug": refreshed_market_slug or refreshed_slug,
                    "event_slug": refreshed_event_slug,
                    "market_id": refreshed_market_id,
                    "condition_id": refreshed_condition_id,
                    "current_yes_odds": refreshed_yes_odds,
                    "current_no_odds": refreshed_no_odds,
                    "polymarket_rules": refreshed_rules,
                    "polymarket_market_context": refreshed_market_context,
                    "polymarket_resolution_source": refreshed_resolution_source,
                    "close_time": refreshed_close_time,
                    "closing_time": refreshed_close_time,
                    "preflight_evidence_block": verified_block,
                    "evidence_packet_v2": evidence_packet,
                    "stage2_context": canonical_context,
                    "close_time_et": refreshed_rule_evaluation.deadline_et,
                    "deadline_et": refreshed_rule_evaluation.deadline_et,
                    "hours_remaining": refreshed_rule_evaluation.hours_remaining,
                    "deadline_source": refreshed_rule_evaluation.deadline_source,
                }
            )
        )
        question_runtime[question.question_id] = {
            "question_ref": question.question_ref,
            "question_id": question.question_id,
            "question": refreshed_question,
            "web_search_used": bool(search_queries or question_sources),
            "web_search_queries": search_queries,
            "web_sources": question_sources,
            "evidence_block_used": bool(verified_block.strip()),
            "internet_verified": bool(
                question_sources
                or refreshed_market_url
                or refreshed_rules
                or refreshed_market_context
                or refreshed_resolution_source
            ),
            "stale_fact_detected": False,
            "invalid_reason": None,
            "preflight_evidence_block": verified_block,
            "stage2_context": canonical_context.model_dump(mode="json"),
            "evidence_packet_v2": (
                evidence_packet.model_dump(mode="json") if evidence_packet is not None else None
            ),
            "rule_quality_status": refreshed_rule_evaluation.rule_quality_status,
            "rule_fail_reason": refreshed_rule_evaluation.fail_reason,
            "matched_gamma_market_id": gamma_lookup.matched_gamma_market_id,
            "gamma_match_method": gamma_lookup.match_method,
            "exact_gamma_market_verified": gamma_lookup.exact_match_verified,
            "authoritative_rule_source_field": refreshed_rule_source_field,
            "yes_definition_extraction_method": refreshed_rule_evaluation.yes_definition_extraction_method,
            "yes_definition_extraction_confidence": refreshed_rule_evaluation.yes_definition_extraction_confidence,
            "final_rule_gate_result": refreshed_rule_evaluation.rule_gate_result,
        }

    return PreparedPolymarketEventContext(
        question_payload=refreshed_payload,
        runtime_metadata={
            "kind": context.kind,
            "require_fresh_internet_evidence": context.evidence_options.require_fresh_internet_evidence,
            "allow_evidence_grounded_non_web_models": context.evidence_options.allow_evidence_grounded_non_web_models,
            "web_search_used": bool(all_queries or all_sources),
            "web_search_queries": dedupe_strings(all_queries, limit=MAX_EVENT_SOURCES * 2),
            "web_sources": dedupe_strings(all_sources, limit=MAX_EVENT_SOURCES * 2),
            "evidence_block_used": bool(question_runtime),
            "internet_verified": all(
                bool(item.get("internet_verified")) for item in question_runtime.values()
            )
            if question_runtime
            else False,
            "stale_fact_detected": False,
            "invalid_reason": None,
            "question_runtime": question_runtime,
            "canonical_stage2_contexts": canonical_contexts,
            "schema_version": 2,
            "warnings": dedupe_strings(all_warnings, limit=MAX_EVENT_SOURCES * 2),
        },
    )


def build_polymarket_event_prompt_from_prepared_context(
    context: PolymarketEventRunContext,
    prepared_context: PreparedPolymarketEventContext,
    *,
    provider_name: str,
) -> tuple[str, dict[str, Any]]:
    prompt_payload: list[dict[str, Any]] = []
    for question in prepared_context.question_payload:
        if question.stage2_context is not None:
            prompt_payload.append(
                {
                    "event_id": question.stage2_context.event_id,
                    "question_ref": question.question_ref,
                    "question_id": question.question_id,
                    "market_id": question.market_id,
                    "condition_id": question.condition_id,
                    "market_slug": question.market_slug,
                    "event_slug": question.event_slug,
                    "question": question.question,
                    "preflight_evidence_block": question.preflight_evidence_block,
                    "stage2_context": question.stage2_context.model_dump(mode="json"),
                }
            )
            continue
        prompt_payload.append(question.model_dump(mode="json"))
    prompt = _build_prompt(
        context.prompt_template,
        prompt_payload,
    )
    return prompt, dict(prepared_context.runtime_metadata)


def build_polymarket_event_prompt_and_metadata(
    context: PolymarketEventRunContext,
    *,
    provider_name: str,
) -> tuple[str, dict[str, Any]]:
    prepared_context = (
        context.prepared_context if context.prepared_context is not None else prepare_polymarket_event_context(context)
    )
    return build_polymarket_event_prompt_from_prepared_context(
        context,
        prepared_context,
        provider_name=provider_name,
    )


def finalize_polymarket_event_runtime_metadata(
    context: PolymarketEventRunContext,
    *,
    provider_name: str,
    content: str,
    model_web_search_used: bool,
    model_web_search_queries: list[str] | None,
    model_web_sources: list[str] | None,
    runtime_metadata: dict[str, Any],
) -> dict[str, Any]:
    question_runtime = {
        question_id: dict(value)
        for question_id, value in (runtime_metadata.get("question_runtime") or {}).items()
        if isinstance(value, dict)
    }

    question_lookup: dict[str, str] = {}
    for question in context.question_payload:
        for alias in (
            question.question_id,
            question.question_ref,
            question.question,
        ):
            normalized = _normalize_lookup_value(alias)
            if normalized:
                question_lookup.setdefault(normalized, question.question_id)

    parsed = _extract_json_value_from_text(content)
    markets = parsed.get("markets") if isinstance(parsed, dict) else None
    if isinstance(markets, list):
        for item in markets:
            if not isinstance(item, dict):
                continue
            question_id = None
            for key in ("question_id", "question_ref", "question"):
                normalized = _normalize_lookup_value(
                    item.get(key) if isinstance(item.get(key), str) else None
                )
                if normalized and normalized in question_lookup:
                    question_id = question_lookup[normalized]
                    break
            if not question_id or question_id not in question_runtime:
                continue
            rationale = _read_rationale(item)
            stale_fact_detected, stale_reason = detect_stale_fact(
                question_runtime[question_id].get("preflight_evidence_block"),
                rationale,
            )
            question_runtime[question_id]["stale_fact_detected"] = stale_fact_detected
            if stale_fact_detected:
                question_runtime[question_id]["invalid_reason"] = stale_reason

    require_fresh = context.evidence_options.require_fresh_internet_evidence

    for question_id, entry in question_runtime.items():
        evidence_block_used = bool(entry.get("evidence_block_used"))
        question_web_used = bool(entry.get("web_search_used"))
        if require_fresh and not question_web_used and not evidence_block_used:
            entry["invalid_reason"] = (
                "Fresh internet evidence was required, but no verified evidence block or web usage was recorded."
            )

    invalid_reasons = [
        str(entry.get("invalid_reason"))
        for entry in question_runtime.values()
        if entry.get("invalid_reason")
    ]
    stale_detected = any(
        bool(entry.get("stale_fact_detected")) for entry in question_runtime.values()
    )
    merged_queries = dedupe_strings(
        [
            *(runtime_metadata.get("web_search_queries") or []),
            *(model_web_search_queries or []),
        ],
        limit=MAX_EVENT_SOURCES * 2,
    )
    merged_sources = dedupe_strings(
        [
            *(runtime_metadata.get("web_sources") or []),
            *(model_web_sources or []),
        ],
        limit=MAX_EVENT_SOURCES * 2,
    )
    return {
        **runtime_metadata,
        "web_search_used": bool(
            runtime_metadata.get("web_search_used")
            or model_web_search_used
            or merged_queries
            or merged_sources
        ),
        "web_search_queries": merged_queries,
        "web_sources": merged_sources,
        "model_side_search_used": bool(model_web_search_used),
        "internet_verified": all(
            bool(entry.get("internet_verified")) for entry in question_runtime.values()
        )
        if question_runtime
        else False,
        "stale_fact_detected": stale_detected,
        "invalid_reason": invalid_reasons[0] if invalid_reasons else None,
        "question_runtime": question_runtime,
    }
