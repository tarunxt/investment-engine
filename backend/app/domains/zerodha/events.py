from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
import re
from typing import Any

from app.domains.jobs.models import Job
from app.domains.portfolio_events.common import (
    EVENT_ANALYSIS_MODEL,
    EVENT_ANALYSIS_PROMPT,
    EVENT_ANALYSIS_PROVIDER,
    EVENT_TABLE_COLUMNS,
    EVENT_WEB_SEARCH_MARKER,
    parse_event_calendar_table,
)
from app.domains.zerodha.models import ZerodhaPortfolioSnapshot
from app.domains.zerodha.threats import IST

EVENT_JOB_MARKER = "[ZERODHA_EVENTS]"


@dataclass(frozen=True)
class ZerodhaEventPromptMetadata:
    snapshot_date: date | None
    captured_at: datetime | None


def build_zerodha_events_prompt(snapshot: ZerodhaPortfolioSnapshot) -> str:
    captured_at_ist = snapshot.captured_at.astimezone(IST)
    prompt_sections = [
        EVENT_JOB_MARKER,
        EVENT_WEB_SEARCH_MARKER,
        "[EVENT_METADATA_DO_NOT_REPEAT]",
        f"[EVENT_SNAPSHOT_DATE={snapshot.snapshot_date.isoformat()}]",
        f"[EVENT_CAPTURED_AT={snapshot.captured_at.isoformat()}]",
        "",
        "Use live web data before answering.",
        f"Treat {snapshot.snapshot_date.isoformat()} as the reference 'today' date when deciding whether an event is upcoming.",
        "Do not repeat the metadata marker lines in the final answer.",
        "Return ONLY one markdown table.",
        "Do not return any introduction, explanation, notes, code fences, bullets, summary, or conclusion.",
        f"Use exactly these columns in this order: | {' | '.join(EVENT_TABLE_COLUMNS)} |",
        "The `Expected Outcome` column must contain only Bullish, Bearish, or Neutral.",
        "Date format must be DD Mon YYYY.",
        "Every output row must include Exchange, Stock Symbol, and Stock Name in addition to the event details.",
        "Use the pasted exchange + tradingsymbol pair as authoritative when searching for events.",
        "If the pasted stock name looks like only a ticker placeholder, replace it with the official listed company name when verified.",
        "If no upcoming scheduled event is found for the entire portfolio, still return exactly one data row with Date `Not found`, Exchange `Not found`, Stock Symbol `All holdings`, Stock Name `All holdings`, Event `No upcoming scheduled price-sensitive event found`, Why it may matter `No scheduled catalyst found in checked sources`, Expected Outcome `Neutral`, and Status / Source `Checked latest available sources`.",
        "",
        "Current Zerodha portfolio snapshot:",
        f"- Snapshot date: {snapshot.snapshot_date.isoformat()}",
        f"- Captured at (IST): {captured_at_ist.strftime('%d %b %Y, %I:%M %p IST')}",
        f"- Holdings count: {snapshot.holdings_count}",
        f"- Holdings market value (INR): {_fmt_num(snapshot.holdings_market_value)}",
        f"- Holdings unrealized PnL (INR): {_fmt_num(snapshot.holdings_pnl)}",
        "",
        "Portfolio holdings table:",
        _build_holdings_markdown_table(snapshot),
        "",
        "Use the analysis brief below verbatim as the core instruction:",
        "",
        EVENT_ANALYSIS_PROMPT,
    ]
    return "\n".join(prompt_sections).strip()


def extract_zerodha_events_prompt_metadata(prompt: str) -> ZerodhaEventPromptMetadata:
    snapshot_date = None
    captured_at = None

    snapshot_match = re.search(r"\[EVENT_SNAPSHOT_DATE=([0-9]{4}-[0-9]{2}-[0-9]{2})\]", prompt or "")
    if snapshot_match:
        snapshot_date = date.fromisoformat(snapshot_match.group(1))

    captured_match = re.search(r"\[EVENT_CAPTURED_AT=([^\]]+)\]", prompt or "")
    if captured_match:
        try:
            captured_at = datetime.fromisoformat(captured_match.group(1))
        except ValueError:
            captured_at = None

    return ZerodhaEventPromptMetadata(snapshot_date=snapshot_date, captured_at=captured_at)


def is_zerodha_event_job(job: Job | None) -> bool:
    return bool(job and EVENT_JOB_MARKER in (job.prompt or ""))


def parse_zerodha_events_table(markdown: str | None) -> dict[str, Any] | None:
    return parse_event_calendar_table(markdown)


def _build_holdings_markdown_table(snapshot: ZerodhaPortfolioSnapshot) -> str:
    holdings = sorted(
        [
            holding
            for holding in (snapshot.holdings or [])
            if (holding.get("quantity") or 0) > 0
        ],
        key=lambda holding: float(holding.get("market_value") or 0.0),
        reverse=True,
    )
    headers = ["Exchange", "Stock Symbol", "Stock Name", "ISIN", "Quantity", "Avg Buy", "Live Price", "Current Value"]
    lines = [
        f"| {' | '.join(headers)} |",
        f"| {' | '.join('---' for _ in headers)} |",
    ]

    for holding in holdings:
        lines.append(
            "| "
            + " | ".join(
                [
                    str(holding.get("exchange") or ""),
                    str(holding.get("tradingsymbol") or ""),
                    str(holding.get("tradingsymbol") or ""),
                    str(holding.get("isin") or ""),
                    str(int(holding.get("quantity") or 0)),
                    _fmt_num(float(holding.get("average_price") or 0.0)),
                    _fmt_num(float(holding.get("last_price") or 0.0)),
                    _fmt_num(float(holding.get("market_value") or 0.0)),
                ]
            )
            + " |"
        )

    if len(lines) == 2:
        lines.append("| - | None | None | - | 0 | 0.00 | 0.00 | 0.00 |")

    return "\n".join(lines)


def _fmt_num(value: float | None) -> str:
    return f"{float(value or 0.0):,.2f}"
