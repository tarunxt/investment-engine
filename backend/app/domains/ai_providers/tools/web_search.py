from __future__ import annotations

import json
import logging
from typing import Any


from app.core.config import settings

logger = logging.getLogger("app")

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
        return _ddg_search(args["query"], int(args.get("max_results", 5)))


def _web_search(query: str, max_results: int = 5) -> str:
    max_results = max(1, min(max_results, 8))
    if settings.tavily_api_key:
        return _tavily_search(query, max_results)
    logger.warning("TAVILY_API_KEY not configured — falling back to DuckDuckGo")
    return _ddg_search(query, max_results)


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
