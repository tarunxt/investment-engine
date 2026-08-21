from __future__ import annotations

import json
import logging
import re
from typing import Any
from urllib.parse import urlencode
from xml.etree import ElementTree

import requests

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
                        "description": "Specific search query, e.g. 'NIFTY 50 live price today' or 'Reliance Industries Q4 2025 results'",
                    },
                    "max_results": {
                        "type": "integer",
                        "description": "Number of results to return (1-8). Default 5.",
                        "default": 5,
                    },
                },
                "required": ["query"],
            },
        },
    },
]


def execute(name: str, args: dict[str, Any]) -> str:
    try:
        if name == "web_search":
            logger.info(f"Executing tool: {name} with args: {args}")
            return _web_search(args["query"], int(args.get("max_results", 5)))
        logger.warning(f"Unknown tool requested: {name}")
        return json.dumps({"error": f"Unknown tool: {name}"})
    except Exception as exc:
        logger.error(f"Error executing tool '{name}': {exc}")
        return json.dumps(
            {
                "query": args.get("query"),
                "answer": None,
                "results": [],
                "errors": [str(exc)],
            },
            ensure_ascii=False,
        )


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
            logger.warning("Tavily search failed for '%s': %s", query, exc)
            errors.append(f"Tavily failed: {exc}")
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
            logger.warning("%s search failed for '%s': %s", search_name, query, exc)
            errors.append(f"{search_name} failed: {exc}")

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
    response = client.search(
        query=query,
        max_results=max_results,
        search_depth="advanced",
        include_answer=True,
    )
    logger.info("Tavily search '%s' returned %d results", query, len(response.get("results", [])))
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

    raw = DDGS().text(query, max_results=max_results)
    logger.info("DuckDuckGo search '%s' returned %d results", query, len(raw))
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
    response = requests.get(url, headers=_SEARCH_HEADERS, timeout=15)
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

    logger.info("Bing RSS search '%s' returned %d results", query, len(results))
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
