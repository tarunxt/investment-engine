from __future__ import annotations

import json
from typing import Any, Iterable

MAX_WEB_SEARCH_QUERIES = 12
MAX_WEB_SOURCES = 20


def dedupe_strings(
    values: Iterable[str] | None,
    *,
    limit: int | None = None,
) -> list[str]:
    if not values:
        return []

    deduped: list[str] = []
    seen: set[str] = set()

    for raw_value in values:
        if not isinstance(raw_value, str):
            continue
        value = raw_value.strip()
        if not value or value in seen:
            continue
        seen.add(value)
        deduped.append(value)
        if limit is not None and len(deduped) >= limit:
            break

    return deduped


def parse_web_search_payload(payload: str | None) -> dict[str, Any]:
    if not payload:
        return {}

    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError:
        return {}

    return parsed if isinstance(parsed, dict) else {}


def extract_web_search_sources(payload: str | None) -> list[str]:
    parsed = parse_web_search_payload(payload)
    results = parsed.get("results")
    if not isinstance(results, list):
        return []

    sources: list[str] = []
    for result in results:
        if not isinstance(result, dict):
            continue
        source = (
            result.get("url")
            or result.get("uri")
            or result.get("link")
            or result.get("title")
        )
        if isinstance(source, str):
            sources.append(source)

    return dedupe_strings(sources, limit=MAX_WEB_SOURCES)


def merge_web_metadata(
    current_used: bool | None,
    current_queries: list[str] | None,
    current_sources: list[str] | None,
    *,
    response_used: bool | None = None,
    response_queries: list[str] | None = None,
    response_sources: list[str] | None = None,
) -> tuple[bool, list[str], list[str]]:
    merged_queries = dedupe_strings(
        [*(current_queries or []), *(response_queries or [])],
        limit=MAX_WEB_SEARCH_QUERIES,
    )
    merged_sources = dedupe_strings(
        [*(current_sources or []), *(response_sources or [])],
        limit=MAX_WEB_SOURCES,
    )
    merged_used = bool(
        current_used
        or response_used
        or merged_queries
        or merged_sources
    )
    return merged_used, merged_queries, merged_sources
