from __future__ import annotations

import json
import logging
import math
import re
from typing import Any
from urllib.parse import urlencode
from xml.etree import ElementTree

import requests

from app.domains.api_usage.metering import ApiAttempt, metered_call
from app.core.config import settings

logger = logging.getLogger("app")

_SEARCH_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}

TOOL_DEFINITIONS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": (
                "Search the web for real-time information: live stock prices, market indices, "
                "breaking news, economic data, company announcements, or any current data "
                "needed for analysis. Always prefer this over training-data knowledge when "
                "current figures are required."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 512,
                        "description": "Specific search query, e.g. 'NIFTY 50 live price today' or 'Reliance Industries Q4 2025 results'",
                    },
                    "max_results": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 8,
                        "description": "Number of results to return (1-8). Default 5.",
                        "default": 5,
                    },
                },
                "required": ["query"],
                "additionalProperties": False,
            },
        },
    },
]


def execute(name: str, args: dict[str, Any]) -> str:
    # Tool arguments are model-authored data, not permission to invoke a tool.
    # This shape check does NOT establish that free-text query content is public.
    if name != "web_search":
        return _tool_error("Unknown tool")
    if not isinstance(args, dict) or set(args) - {"query", "max_results"}:
        return _tool_error("Invalid search arguments")
    query = args.get("query")
    count = args.get("max_results", 5)
    if (not isinstance(query, str) or not query.strip() or len(query) > 512
            or any(ord(char) < 32 for char in query)
            or type(count) is not int or not 1 <= count <= 8):
        return _tool_error("Invalid search arguments")
    try:
        logger.info("Executing web_search tool")
        return _bounded_tool_result(_web_search(query, count), query, count)
    except Exception as exc:
        logger.error("Search tool failed (%s)", type(exc).__name__)
        return _tool_error("Search unavailable")


def _tool_error(message: str) -> str:
    # Never echo rejected arguments, tool names, or provider exception bodies.
    return json.dumps({"answer": None, "results": [], "errors": [message]})


def _bounded_tool_result(payload: str, query: str, count: int) -> str:
    """Bound data sent back to the model without treating retrieval as authority.

    URLs and dates remain whole; oversized provenance is omitted explicitly.
    Truncation is visible and is never represented as complete source evidence.
    """
    if not isinstance(payload, str) or len(payload) > 1_000_000:
        return _tool_error("Invalid search response")
    parsed = json.loads(payload)
    if not isinstance(parsed, dict) or not isinstance(parsed.get("results"), list):
        return _tool_error("Invalid search response")
    truncated = len(parsed["results"]) > count

    def text(value: object, limit: int, *, whole: bool = False):
        nonlocal truncated
        if not isinstance(value, str):
            return None
        if len(value) > limit:
            truncated = True
            return None if whole else value[:limit]
        return value

    results = []
    for result in parsed["results"][:count]:
        if not isinstance(result, dict):
            truncated = True
            continue
        results.append({
            "title": text(result.get("title"), 512),
            "url": text(result.get("url"), 2048, whole=True),
            "content": text(result.get("content"), 4096),
            "published_date": text(result.get("published_date"), 128, whole=True),
        })
        score = result.get("score")
        if type(score) in (int, float) and math.isfinite(score):
            results[-1]["score"] = score
    answer = text(parsed.get("answer"), 4096)
    output = {"query": query, "answer": answer, "results": results,
              "trust": "untrusted_external_data", "truncated": truncated}
    if parsed.get("errors"):
        output.pop("query", None)
        output["errors"] = ["Search incomplete or unavailable"]
    return json.dumps(output, ensure_ascii=False)


def _web_search(query: str, max_results: int = 5) -> str:
    max_results = max(1, min(max_results, 8))
    errors: list[str] = []

    if settings.tavily_api_key:
        try:
            tavily_payload = _tavily_search(query, max_results)
            if _payload_has_results(tavily_payload):
                return tavily_payload
            errors.append("Tavily returned no results")
        except Exception as exc:
            logger.warning("Tavily search failed (%s)", type(exc).__name__)
            errors.append("Tavily failed")
    else:
        logger.warning("TAVILY_API_KEY not configured — falling back to alternative search providers")
        errors.append("Tavily not configured")

    for search_name, search_fn in (
        ("DuckDuckGo", _ddg_search),
        ("Bing RSS", _bing_rss_search),
    ):
        try:
            payload = search_fn(query, max_results)
            if _payload_has_results(payload):
                return payload
            errors.append(f"{search_name} returned no results")
        except Exception as exc:
            logger.warning("%s search failed (%s)", search_name, type(exc).__name__)
            errors.append(f"{search_name} failed")

    return json.dumps(
        {
            "query": query,
            "answer": None,
            "results": [],
            "errors": errors,
        },
        ensure_ascii=False,
    )


def _tavily_search(query: str, max_results: int) -> str:
    from tavily import TavilyClient

    client = TavilyClient(api_key=settings.tavily_api_key)
    response = metered_call(
        client.search, provider="tavily", meter_model=None, phase="search",
        query=query,
        max_results=max_results,
        search_depth="advanced",
        include_answer=True,
        include_usage=True,
    )
    logger.info("Tavily search returned %d results", len(response.get("results", [])))
    results = [
        {
            "title": r.get("title"),
            "url": r.get("url"),
            "content": r.get("content"),
            "published_date": r.get("published_date"),
            "score": round(r.get("score", 0), 3),
        }
        for r in response.get("results", [])
    ]
    return json.dumps(
        {"query": query, "answer": response.get("answer"), "results": results},
        ensure_ascii=False,
    )


def _ddg_search(query: str, max_results: int) -> str:
    from duckduckgo_search import DDGS

    raw = metered_call(
        DDGS().text, query, provider="duckduckgo", meter_model=None, phase="search",
        max_results=max_results,
    )
    logger.info("DuckDuckGo search returned %d results", len(raw))
    results = [
        {"title": r.get("title"), "url": r.get("href"), "content": r.get("body")}
        for r in (raw or [])
    ]
    return json.dumps(
        {"query": query, "answer": None, "results": results},
        ensure_ascii=False,
    )


def _bing_rss_search(query: str, max_results: int) -> str:
    url = f"https://www.bing.com/search?{urlencode({'format': 'rss', 'q': query})}"
    with ApiAttempt(
        provider="bing", model=None, request={"query": query, "max_results": max_results},
        phase="search", instrumentation_scope="http_call_redirects_unmeasured",
    ) as attempt:
        response = requests.get(url, headers=_SEARCH_HEADERS, timeout=15)
        attempt.observe(response)
        response.raise_for_status()

        root = ElementTree.fromstring(response.text)
        items = root.findall("./channel/item")
        results = []
        for item in items[:max_results]:
            title = _clean_xml_text(item.findtext("title"))
            link = _clean_xml_text(item.findtext("link"))
            description = _strip_html(_clean_xml_text(item.findtext("description")))
            published_date = _clean_xml_text(item.findtext("pubDate"))
            if not title and not link and not description:
                continue
            results.append(
                {
                    "title": title,
                    "url": link,
                    "content": description,
                    "published_date": published_date,
                }
            )
        attempt.observe_search_results(len(results))

    logger.info("Bing RSS search returned %d results", len(results))
    return json.dumps(
        {"query": query, "answer": None, "results": results},
        ensure_ascii=False,
    )


def _payload_has_results(payload: str) -> bool:
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError:
        return False

    results = parsed.get("results")
    return isinstance(results, list) and len(results) > 0


def _clean_xml_text(value: str | None) -> str:
    return (value or "").strip()


def _strip_html(value: str) -> str:
    text = re.sub(r"<[^>]+>", " ", value or "")
    text = re.sub(r"\s+", " ", text)
    return text.strip()
