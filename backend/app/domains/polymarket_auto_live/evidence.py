from __future__ import annotations

import hashlib
import json
import re
from urllib.parse import urlparse

from app.domains.ai_providers.tools import web_search as web_search_tool
from app.domains.polymarket.stage2_models import (
    EvidencePacketV2,
    Stage2EvidenceClaim,
    Stage2EvidenceSource,
)
from app.domains.polymarket_auto_live.rules import RuleEvaluation
from app.domains.polymarket_auto_live.scanner import ScannedMarket

EvidencePacket = EvidencePacketV2

_GENERIC_HOST_PATTERNS = (
    re.compile(r"wikipedia\.org$", re.I),
)
_OFFICIAL_HOST_PATTERNS = (
    (re.compile(r"\.gov$|\bgov\.", re.I), "official_government"),
    (re.compile(r"\.mil$|\bmil\.", re.I), "official_military"),
)
_MAJOR_NEWS_HOST_PATTERNS = (
    re.compile(r"(reuters|apnews|nytimes|wsj|bloomberg|ft|cnn|bbc)\.", re.I),
)
_SPECIALIST_NEWS_HOST_PATTERNS = (
    re.compile(r"(theverge|techcrunch|defense|axios|politico|aljazeera|haaretz)\.", re.I),
)
_AGGREGATOR_HOST_PATTERNS = (
    re.compile(r"(google\.com|news\.ycombinator|news\.google)\.", re.I),
)
_FINANCE_KEYWORDS = (
    "bitcoin",
    "ethereum",
    "solana",
    "dogecoin",
    "stock",
    "stocks",
    "share price",
    "market cap",
    "nasdaq",
    "nyse",
    "etf",
    "crypto",
)
_NEGATIVE_FINANCE_BOILERPLATE = (
    "not trading advice",
    "no trading advice",
    "this is not trading advice",
)


def _normalize_text(value: str | None) -> str | None:
    if not value:
        return None
    normalized = " ".join(value.split()).strip()
    return normalized or None


def _normalize_url(url: str | None) -> str | None:
    if not url:
        return None
    parsed = urlparse(url.strip())
    if not parsed.scheme or not parsed.netloc:
        return url.strip() or None
    normalized = parsed._replace(query="", fragment="").geturl().rstrip("/")
    return normalized or None


def _content_fingerprint(*values: str | None) -> str | None:
    payload = " | ".join(value.strip() for value in values if value and value.strip())
    if not payload:
        return None
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def _dedupe_queries(values: list[str]) -> list[str]:
    seen: set[str] = set()
    deduped: list[str] = []
    for value in values:
        normalized = _normalize_text(value)
        if not normalized:
            continue
        key = normalized.lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(normalized)
    return deduped


def _extract_date_hint(rules: RuleEvaluation, market: ScannedMarket) -> str | None:
    for value in (rules.deadline_local, rules.deadline_utc, market.close_time):
        normalized = _normalize_text(value)
        if normalized:
            return normalized
    return None


def _extract_action_keywords(rules: RuleEvaluation, market: ScannedMarket) -> list[str]:
    text = " ".join(
        part
        for part in [
            market.question,
            rules.yes_definition or "",
            rules.resolution_criteria or "",
        ]
        if part
    )
    keywords: list[str] = []
    for phrase in (
        "official confirmation",
        "announced",
        "launched",
        "landed",
        "strike",
        "missile",
        "attack",
        "won",
        "filed",
        "approved",
        "interception",
        "sanctions",
    ):
        if re.search(rf"\b{re.escape(phrase)}\b", text, re.I):
            keywords.append(phrase)
    return keywords[:4]


def is_finance_relevant(*, question: str, theme: str | None, rules_text: str | None) -> bool:
    haystack = " ".join(
        part.lower()
        for part in [question, theme or "", rules_text or ""]
        if part
    )
    if any(phrase in haystack for phrase in _NEGATIVE_FINANCE_BOILERPLATE):
        cleaned = haystack
        for phrase in _NEGATIVE_FINANCE_BOILERPLATE:
            cleaned = cleaned.replace(phrase, " ")
        haystack = " ".join(cleaned.split())
    return any(re.search(rf"\b{re.escape(keyword)}\b", haystack) for keyword in _FINANCE_KEYWORDS)


def build_evidence_queries(market: ScannedMarket, rules: RuleEvaluation) -> list[str]:
    date_hint = _extract_date_hint(rules, market)
    action_keywords = _extract_action_keywords(rules, market)
    timezone_hint = rules.resolution_timezone_name or rules.resolution_timezone_iana
    queries = [
        market.question,
        f"{market.question} official confirmation",
    ]
    if rules.yes_definition:
        queries.append(rules.yes_definition)
        queries.append(f"{rules.yes_definition} official source")
    if action_keywords:
        queries.append(
            " ".join(
                part
                for part in [
                    market.question,
                    *action_keywords,
                    date_hint or "",
                    timezone_hint or "",
                ]
                if part
            )
        )
    if rules.resolution_source_description:
        queries.append(f"{market.question} {rules.resolution_source_description}")
    if date_hint:
        queries.append(f"{market.question} {date_hint}")
    if is_finance_relevant(
        question=market.question,
        theme=market.theme,
        rules_text=rules.resolution_criteria,
    ):
        queries.append(f"{market.question} price market cap status today")
    return _dedupe_queries(queries)[:5]


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

    parsed: list[dict[str, str | None]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        title = _normalize_text(str(row.get("title") or "").strip())
        url = _normalize_url(str(row.get("url") or "").strip())
        content = _normalize_text(str(row.get("content") or "").strip())
        published_date = _normalize_text(str(row.get("published_date") or "").strip())
        if not title and not url and not content:
            continue
        parsed.append(
            {
                "title": title,
                "url": url,
                "content": content,
                "published_date": published_date,
            }
        )
    return parsed, warnings


def _source_type(domain: str | None) -> str:
    if not domain:
        return "unknown"
    for pattern, label in _OFFICIAL_HOST_PATTERNS:
        if pattern.search(domain):
            return label
    if any(pattern.search(domain) for pattern in _MAJOR_NEWS_HOST_PATTERNS):
        return "major_news"
    if any(pattern.search(domain) for pattern in _SPECIALIST_NEWS_HOST_PATTERNS):
        return "specialist_news"
    if any(pattern.search(domain) for pattern in _AGGREGATOR_HOST_PATTERNS):
        return "aggregator"
    return "unknown"


def _is_generic_landing_page(title: str | None, url: str | None, content: str | None, market: ScannedMarket) -> bool:
    domain = urlparse(url or "").netloc.lower()
    path = urlparse(url or "").path.strip("/")
    if any(pattern.search(domain) for pattern in _GENERIC_HOST_PATTERNS):
        return True
    if not path:
        return True
    normalized_title = (title or "").lower()
    if normalized_title in {"home", "homepage"}:
        return True
    question_terms = {
        token
        for token in re.findall(r"[A-Za-z0-9]{4,}", market.question.lower())
        if token not in {"will", "what", "when", "from", "with", "this", "that"}
    }
    haystack = " ".join(part for part in [normalized_title, (content or "").lower(), path.lower()] if part)
    if question_terms and not any(term in haystack for term in list(question_terms)[:5]):
        return True
    return False


def _relevance_score(market: ScannedMarket, rules: RuleEvaluation, title: str | None, content: str | None) -> float:
    haystack = " ".join(part.lower() for part in [title or "", content or ""] if part)
    score = 0.15
    question_terms = {
        token
        for token in re.findall(r"[A-Za-z0-9]{4,}", market.question.lower())
        if token not in {"will", "what", "when", "from", "with", "this", "that"}
    }
    if question_terms:
        matches = sum(1 for token in question_terms if token in haystack)
        score += min(0.4, matches * 0.08)
    if rules.yes_definition and any(
        token in haystack for token in re.findall(r"[A-Za-z0-9]{4,}", rules.yes_definition.lower())
    ):
        score += 0.2
    if rules.resolution_date_window and rules.resolution_date_window.lower() in haystack:
        score += 0.15
    return round(min(1.0, score), 2)


def _build_source(
    *,
    source_id: str,
    market: ScannedMarket,
    rules: RuleEvaluation,
    row: dict[str, str | None],
    built_at: str,
) -> Stage2EvidenceSource:
    url = row.get("url")
    domain = urlparse(url or "").netloc.lower() or None
    source_type = _source_type(domain)
    generic = _is_generic_landing_page(
        row.get("title"),
        url,
        row.get("content"),
        market,
    )
    if generic:
        source_type = "generic_landing_page"
    relevance = _relevance_score(
        market,
        rules,
        row.get("title"),
        row.get("content"),
    )
    snippet = row.get("content")
    fingerprint = _content_fingerprint(row.get("title"), url, snippet)
    return Stage2EvidenceSource(
        source_id=source_id,
        title=row.get("title"),
        url=url,
        publisher=domain,
        domain=domain,
        published_at=row.get("published_date"),
        fetched_at=built_at,
        source_type=source_type,  # type: ignore[arg-type]
        relevance_score=min(relevance, 0.35 if generic else relevance),
        entity_match=bool(
            row.get("title")
            and any(
                token in (row.get("title") or "").lower()
                for token in re.findall(r"[A-Za-z0-9]{4,}", market.question.lower())[:3]
            )
        ),
        event_date_match=bool(
            rules.resolution_date_window
            and rules.resolution_date_window.lower()
            in ((row.get("content") or "").lower() + " " + (row.get("title") or "").lower())
        ),
        resolution_criterion_match=bool(
            rules.yes_definition
            and any(
                token in ((row.get("content") or "").lower() + " " + (row.get("title") or "").lower())
                for token in re.findall(r"[A-Za-z0-9]{4,}", rules.yes_definition.lower())[:4]
            )
        ),
        is_generic_landing_page=generic,
        snippet=snippet,
        extracted_claims=[snippet] if snippet else [],
        source_warning="Generic landing page was down-ranked." if generic else None,
        content_fingerprint=fingerprint,
    )


def _build_claims(sources: list[Stage2EvidenceSource]) -> list[Stage2EvidenceClaim]:
    claims: list[Stage2EvidenceClaim] = []
    for source in sources:
        if not source.snippet:
            continue
        claims.append(
            Stage2EvidenceClaim(
                claim_id=f"C{len(claims) + 1}",
                claim_text=source.snippet,
                supporting_source_ids=[source.source_id],
                verification_status=(
                    "supported"
                    if source.source_type.startswith("official_")
                    else "unverified"
                    if source.is_generic_landing_page
                    else "supported"
                ),
                confidence=max(0.2, min(0.95, source.relevance_score)),
            )
        )
    return claims


def build_evidence_packet(
    market: ScannedMarket,
    rules: RuleEvaluation,
    *,
    built_at: str,
) -> EvidencePacket:
    queries = build_evidence_queries(market, rules)
    warnings: list[str] = []
    sources: list[Stage2EvidenceSource] = []
    seen_keys: set[str] = set()
    for query in queries:
        payload = web_search_tool.execute("web_search", {"query": query, "max_results": 4})
        query_results, query_warnings = _parse_search_payload(payload)
        warnings.extend(query_warnings)
        for row in query_results:
            normalized_url = _normalize_url(row.get("url"))
            fingerprint = _content_fingerprint(row.get("title"), normalized_url, row.get("content"))
            dedupe_key = normalized_url or fingerprint
            if not dedupe_key or dedupe_key in seen_keys:
                continue
            seen_keys.add(dedupe_key)
            sources.append(
                _build_source(
                    source_id=f"S{len(sources) + 1}",
                    market=market,
                    rules=rules,
                    row=row,
                    built_at=built_at,
                )
            )
            if len(sources) >= 8:
                break
        if len(sources) >= 8:
            break

    claims = _build_claims(sources)
    sufficiency_status = (
        "sufficient"
        if any(
            not source.is_generic_landing_page and source.relevance_score >= 0.45
            for source in sources
        )
        else "insufficient"
        if sources
        else "missing"
    )
    if not sources:
        warnings.append("No relevant external evidence sources were captured.")

    return EvidencePacket(
        built_at_utc=built_at,
        event_id=market.market_id,
        exact_resolution_question=market.question,
        search_objective=rules.yes_definition or market.question,
        queries=queries,
        sources=sources,
        claims=claims,
        warnings=_dedupe_queries(warnings),
        sufficiency_status=sufficiency_status,  # type: ignore[arg-type]
    )
