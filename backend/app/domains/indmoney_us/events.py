from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
import re
from typing import Any

from app.domains.indmoney_us.models import IndMoneyUsPortfolioSnapshot
from app.domains.jobs.models import Job
from app.domains.portfolio_events.common import (
    EVENT_ANALYSIS_MODEL,
    EVENT_ANALYSIS_PROMPT,
    EVENT_ANALYSIS_PROVIDER,
    EVENT_TABLE_COLUMNS,
    EVENT_WEB_SEARCH_MARKER,
    parse_event_calendar_table,
)
from app.domains.zerodha.threats import IST

EVENT_JOB_MARKER = "[INDMONEY_US_EVENTS]"


@dataclass(frozen=True)
class IndMoneyUsEventPromptMetadata:
    snapshot_id: int | None
    snapshot_date: date | None
    captured_at: datetime | None


def build_indmoney_us_events_prompt(snapshot: IndMoneyUsPortfolioSnapshot) -> str:
    captured_at_ist = snapshot.captured_at.astimezone(IST)
    prompt_sections = [
        EVENT_JOB_MARKER,
        EVENT_WEB_SEARCH_MARKER,
        "[EVENT_METADATA_DO_NOT_REPEAT]",
        f"[INDMONEY_EVENT_SNAPSHOT_ID={snapshot.id}]",
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
        "Use the pasted ticker / symbol as authoritative when searching for events.",
        "If no upcoming scheduled event is found for the entire portfolio, still return exactly one data row with Date `Not found`, Holding `All holdings`, Event `No upcoming scheduled price-sensitive event found`, Why it may matter `No scheduled catalyst found in checked sources`, Expected Outcome `Neutral`, and Status / Source `Checked latest available sources`.",
        "",
        "Current INDmoney US portfolio snapshot:",
        f"- Snapshot id: {snapshot.id}",
        f"- Snapshot date: {snapshot.snapshot_date.isoformat()}",
        f"- Captured at (IST): {captured_at_ist.strftime('%d %b %Y, %I:%M %p IST')}",
        f"- Holdings count: {snapshot.holdings_count}",
        f"- Current value (USD): {_fmt_num(snapshot.current_value)}",
        f"- Invested value (USD): {_fmt_num(snapshot.invested_value)}",
        f"- Total return (USD): {_fmt_num(snapshot.total_return_value)}",
        "",
        "Portfolio holdings table:",
        _build_holdings_markdown_table(snapshot),
        "",
        "Use the analysis brief below verbatim as the core instruction:",
        "",
        EVENT_ANALYSIS_PROMPT,
    ]
    return "\n".join(prompt_sections).strip()


def extract_indmoney_us_events_prompt_metadata(prompt: str) -> IndMoneyUsEventPromptMetadata:
    snapshot_id = None
    snapshot_date = None
    captured_at = None

    snapshot_id_match = re.search(r"\[INDMONEY_EVENT_SNAPSHOT_ID=(\d+)\]", prompt or "")
    if snapshot_id_match:
        snapshot_id = int(snapshot_id_match.group(1))

    snapshot_match = re.search(r"\[EVENT_SNAPSHOT_DATE=([0-9]{4}-[0-9]{2}-[0-9]{2})\]", prompt or "")
    if snapshot_match:
        snapshot_date = date.fromisoformat(snapshot_match.group(1))

    captured_match = re.search(r"\[EVENT_CAPTURED_AT=([^\]]+)\]", prompt or "")
    if captured_match:
        try:
            captured_at = datetime.fromisoformat(captured_match.group(1))
        except ValueError:
            captured_at = None

    return IndMoneyUsEventPromptMetadata(
        snapshot_id=snapshot_id,
        snapshot_date=snapshot_date,
        captured_at=captured_at,
    )


def is_indmoney_us_event_job(job: Job | None) -> bool:
    return bool(job and EVENT_JOB_MARKER in (job.prompt or ""))


def parse_indmoney_us_events_table(markdown: str | None) -> dict[str, Any] | None:
    return parse_event_calendar_table(markdown)


def _build_holdings_markdown_table(snapshot: IndMoneyUsPortfolioSnapshot) -> str:
    holdings = sorted(
        list(snapshot.holdings or []),
        key=lambda holding: float(holding.get("current_value") or 0.0),
        reverse=True,
    )
    headers = ["Holding", "Ticker", "Quantity", "Avg Buy", "Market Price", "Current Value"]
    lines = [
        f"| {' | '.join(headers)} |",
        f"| {' | '.join('---' for _ in headers)} |",
    ]

    for holding in holdings:
        lines.append(
            "| "
            + " | ".join(
                [
                    str(holding.get("company_name") or holding.get("symbol") or ""),
                    str(holding.get("symbol") or ""),
                    _fmt_num(holding.get("quantity")),
                    _fmt_num(holding.get("average_price")),
                    _fmt_num(holding.get("market_price")),
                    _fmt_num(holding.get("current_value")),
                ]
            )
            + " |"
        )

    if len(lines) == 2:
        lines.append("| None | None | 0.00 | 0.00 | 0.00 | 0.00 |")

    return "\n".join(lines)


def _fmt_num(value: float | int | None) -> str:
    return f"{float(value or 0.0):,.2f}"
