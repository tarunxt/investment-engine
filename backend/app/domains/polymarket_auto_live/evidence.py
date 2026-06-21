from __future__ import annotations

import json
from dataclasses import dataclass

from app.domains.ai_providers.tools import web_search as web_search_tool
from app.domains.polymarket_auto_live.rules import RuleEvaluation
from app.domains.polymarket_auto_live.scanner import ScannedMarket


@dataclass
class EvidenceResult:
    title: str
    url: str
    content: str
    published_date: str | None = None


@dataclass
class EvidencePacket:
    built_at: str
    queries: list[str]
    results: list[EvidenceResult]
    warnings: list[str]


def _dedupe_queries(values: list[str]) -> list[str]:
    seen: set[str] = set()
    deduped: list[str] = []
    for value in values:
        normalized = " ".join(value.split()).strip()
        key = normalized.lower()
        if not normalized or key in seen:
            continue
        seen.add(key)
        deduped.append(normalized)
    return deduped


def build_evidence_queries(market: ScannedMarket, rules: RuleEvaluation) -> list[str]:
    queries = [
        market.question,
        f"{market.question} official source",
    ]
    if rules.yes_definition:
        queries.append(rules.yes_definition)
    return _dedupe_queries(queries)[:3]


def _parse_search_payload(raw: str) -> tuple[list[EvidenceResult], list[str]]:
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

    parsed: list[EvidenceResult] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        title = str(row.get("title") or "").strip()
        url = str(row.get("url") or "").strip()
        content = str(row.get("content") or "").strip()
        if not title and not url and not content:
            continue
        parsed.append(
            EvidenceResult(
                title=title or url or "Untitled source",
                url=url,
                content=content,
                published_date=str(row.get("published_date")).strip()
                if row.get("published_date") is not None
                else None,
            )
        )
    return parsed, warnings


def build_evidence_packet(
    market: ScannedMarket,
    rules: RuleEvaluation,
    *,
    built_at: str,
) -> EvidencePacket:
    queries = build_evidence_queries(market, rules)
    results: list[EvidenceResult] = []
    warnings: list[str] = []
    seen_urls: set[str] = set()
    for query in queries:
        payload = web_search_tool.execute("web_search", {"query": query, "max_results": 4})
        query_results, query_warnings = _parse_search_payload(payload)
        warnings.extend(query_warnings)
        for item in query_results:
            key = item.url or item.title
            if key in seen_urls:
                continue
            seen_urls.add(key)
            results.append(item)
            if len(results) >= 8:
                break
        if len(results) >= 8:
            break

    return EvidencePacket(
        built_at=built_at,
        queries=queries,
        results=results,
        warnings=warnings,
    )
