from __future__ import annotations

from datetime import UTC, datetime
from html import unescape
import json
import re
from typing import Any
from zoneinfo import ZoneInfo

import httpx

from app.domains.ai_providers.tools import web_search as web_search_tool
from app.domains.ai_providers.web_metadata import dedupe_strings
from app.domains.runs.schemas import (
    PolymarketEventQuestionPayload,
    PolymarketEventRunContext,
)

POLYMARKET_GAMMA_MARKETS_URL = "https://gamma-api.polymarket.com/markets"
POLYMARKET_EVENT_BASE_URL = "https://polymarket.com/event"
POLYMARKET_HTTP_HEADERS = {
    "User-Agent": "investor-polymarket-event-preflight/1.0",
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


def _extract_rules_text(record: dict[str, Any]) -> str | None:
    return _normalize_text(_read_string(record, ["description", "rules"]))


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


def _fetch_gamma_market(question: PolymarketEventQuestionPayload) -> dict[str, Any] | None:
    params: list[tuple[str, str]] = []
    if question.question_id.strip().isdigit():
        params.append(("id", question.question_id.strip()))
    if question.slug:
        params.append(("slug", question.slug.strip()))
    if not params:
        return None

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
        return None

    for item in payload:
        if not isinstance(item, dict):
            continue
        item_id = _read_string(item, ["id"])
        item_slug = _canonical_market_slug(item)
        if item_id == question.question_id or (
            question.slug and item_slug == question.slug
        ):
            return item
    for item in payload:
        if isinstance(item, dict):
            return item
    return None


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
    return any(hint in haystack for hint in FINANCE_HINTS)


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
) -> list[str]:
    queries = [
        refreshed_question,
        f"{refreshed_question} official source",
        f"{refreshed_question} latest news",
    ]
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
        "Verified current facts:",
        f"- question_ref: {question.question_ref}",
        f"- question_id: {question.question_id}",
        f"- category: {_format_text(question.category, 'Unknown')}",
        f"- current time (UTC): {current_time_utc}",
        f"- current time (ET): {current_time_et}",
        f"- close time: {_format_text(question.close_time, 'Unknown')}",
        f"- close time (ET): {_format_text(question.close_time_et, 'Unknown')}",
        f"- deadline (ET): {_format_text(question.deadline_et, 'Unknown')}",
        f"- hours remaining: {question.hours_remaining if question.hours_remaining is not None else 'Unknown'}",
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


def build_polymarket_event_prompt_and_metadata(
    context: PolymarketEventRunContext,
    *,
    provider_name: str,
) -> tuple[str, dict[str, Any]]:
    if not context.evidence_options.require_fresh_internet_evidence:
        payload = [question.model_dump(mode="json") for question in context.question_payload]
        prompt = _build_prompt(context.prompt_template, payload)
        return prompt, {
            "kind": context.kind,
            "require_fresh_internet_evidence": False,
            "allow_evidence_grounded_non_web_models": context.evidence_options.allow_evidence_grounded_non_web_models,
            "web_search_used": False,
            "web_search_queries": [],
            "web_sources": [],
            "evidence_block_used": any(
                bool((question.preflight_evidence_block or "").strip())
                for question in context.question_payload
            ),
            "internet_verified": False,
            "stale_fact_detected": False,
            "invalid_reason": None,
            "question_runtime": {
                question.question_id: {
                    "question_ref": question.question_ref,
                    "question_id": question.question_id,
                    "question": question.question,
                    "web_search_used": False,
                    "web_search_queries": [],
                    "web_sources": [],
                    "evidence_block_used": bool(
                        (question.preflight_evidence_block or "").strip()
                    ),
                    "internet_verified": False,
                    "stale_fact_detected": False,
                    "invalid_reason": None,
                    "preflight_evidence_block": question.preflight_evidence_block,
                }
                for question in context.question_payload
            },
            "warnings": [],
        }

    now_utc = datetime.now(UTC)
    now_et = now_utc.astimezone(ET_ZONE)
    refreshed_payload: list[dict[str, Any]] = []
    question_runtime: dict[str, dict[str, Any]] = {}
    all_queries: list[str] = []
    all_sources: list[str] = []
    all_warnings: list[str] = []

    for question in context.question_payload:
        refreshed_question = question.question
        refreshed_market_url = question.market_url
        refreshed_slug = question.slug
        refreshed_yes_odds = question.current_yes_odds
        refreshed_no_odds = question.current_no_odds
        refreshed_rules = question.polymarket_rules
        refreshed_market_context = question.polymarket_market_context
        refreshed_resolution_source = question.polymarket_resolution_source
        question_warnings: list[str] = []

        try:
            gamma_record = _fetch_gamma_market(question)
        except Exception as exc:
            gamma_record = None
            question_warnings.append(f"Polymarket Gamma refresh failed: {exc}")

        if gamma_record:
            refreshed_question = _read_string(
                gamma_record,
                ["question", "title", "name", "marketQuestion"],
            ) or refreshed_question
            refreshed_slug = _canonical_market_slug(gamma_record, refreshed_slug)
            event_slug = _canonical_event_slug(gamma_record, refreshed_slug)
            refreshed_market_url = _event_url(event_slug) or refreshed_market_url
            refreshed_yes_odds, refreshed_no_odds = _read_outcome_odds(gamma_record)
            refreshed_rules = _extract_rules_text(gamma_record) or refreshed_rules
            refreshed_resolution_source = (
                _extract_resolution_source(gamma_record, refreshed_rules)
                or refreshed_resolution_source
            )
            fetched_market_context = _fetch_event_market_context(refreshed_market_url)
            refreshed_market_context = fetched_market_context or refreshed_market_context

        search_queries = _build_search_queries(
            question,
            refreshed_question=refreshed_question,
            rules_text=refreshed_rules,
            resolution_source=refreshed_resolution_source,
            market_context=refreshed_market_context,
        )
        search_results: list[dict[str, str | None]] = []
        for query in search_queries:
            raw_payload = web_search_tool.execute(
                "web_search",
                {"query": query, "max_results": MAX_QUERY_RESULTS},
            )
            parsed_results, query_warnings = _parse_search_payload(raw_payload)
            search_results.extend(parsed_results)
            question_warnings.extend(query_warnings)
            all_queries.append(query)

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
            slug=refreshed_slug,
            current_yes_odds=refreshed_yes_odds,
            current_no_odds=refreshed_no_odds,
            rules_text=refreshed_rules,
            market_context=refreshed_market_context,
            resolution_source=refreshed_resolution_source,
            search_queries=search_queries,
            search_results=search_results,
            warnings=question_warnings,
        )

        refreshed_payload.append(
            question.model_copy(
                update={
                    "question": refreshed_question,
                    "current_time_utc": now_utc.isoformat(),
                    "current_time_et": _format_ts(now_et),
                    "market_url": refreshed_market_url,
                    "slug": refreshed_slug,
                    "current_yes_odds": refreshed_yes_odds,
                    "current_no_odds": refreshed_no_odds,
                    "polymarket_rules": refreshed_rules,
                    "polymarket_market_context": refreshed_market_context,
                    "polymarket_resolution_source": refreshed_resolution_source,
                    "preflight_evidence_block": verified_block,
                }
            ).model_dump(mode="json")
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
        }

    prompt = _build_prompt(context.prompt_template, refreshed_payload)
    if context.evidence_options.require_fresh_internet_evidence and provider_name == "openai":
        prompt = _prepend_openai_search_token(prompt)
    if context.evidence_options.require_fresh_internet_evidence:
        prompt = _append_required_search_instruction(prompt, provider_name)

    runtime_metadata = {
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
        "warnings": dedupe_strings(all_warnings, limit=MAX_EVENT_SOURCES * 2),
    }
    return prompt, runtime_metadata


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
    requires_model_side_search = provider_name in {"gemini", "deepseek"} and require_fresh

    for question_id, entry in question_runtime.items():
        evidence_block_used = bool(entry.get("evidence_block_used"))
        question_web_used = bool(entry.get("web_search_used"))
        if requires_model_side_search and not model_web_search_used:
            entry["invalid_reason"] = (
                "Required model-side search/tool usage did not run before the final answer."
            )
        elif require_fresh and not question_web_used and not evidence_block_used:
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
