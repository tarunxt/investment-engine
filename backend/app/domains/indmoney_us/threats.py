from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
import re
from typing import Any

from app.domains.indmoney_us.models import IndMoneyUsPortfolioSnapshot
from app.domains.jobs.models import Job
from app.domains.zerodha.threats import (
    IST,
    THREAT_ANALYSIS_MODEL,
    THREAT_ANALYSIS_PROMPT,
    THREAT_ANALYSIS_PROVIDER,
    THREAT_WEB_SEARCH_MARKER,
    parse_zerodha_threat_report,
    parse_zerodha_threat_urgent_actionables,
)

THREAT_JOB_MARKER = "[INDMONEY_US_THREATS]"


@dataclass(frozen=True)
class IndMoneyUsThreatPromptMetadata:
    snapshot_id: int | None
    snapshot_date: date | None
    captured_at: datetime | None


def build_indmoney_us_threat_prompt(snapshot: IndMoneyUsPortfolioSnapshot) -> str:
    captured_at_ist = snapshot.captured_at.astimezone(IST)
    current_value = snapshot.current_value or 0.0
    holdings = sorted(
        list(snapshot.holdings or []),
        key=lambda holding: float(holding.get("current_value") or 0.0),
        reverse=True,
    )
    top_weight = max(
        (
            ((float(holding.get("current_value") or 0.0) / current_value) * 100)
            for holding in holdings
            if current_value > 0 and float(holding.get("current_value") or 0.0) > 0
        ),
        default=0.0,
    )

    prompt_sections = [
        THREAT_JOB_MARKER,
        THREAT_WEB_SEARCH_MARKER,
        "[THREAT_METADATA_DO_NOT_REPEAT]",
        f"[INDMONEY_THREAT_SNAPSHOT_ID={snapshot.id}]",
        f"[THREAT_SNAPSHOT_DATE={snapshot.snapshot_date.isoformat()}]",
        f"[THREAT_CAPTURED_AT={snapshot.captured_at.isoformat()}]",
        "",
        "Use the latest web data before answering. Search for live market data, earnings timing, news flow, sector rotation, index trend, macro conditions, and institutional flow context relevant to these holdings.",
        "Do not repeat the metadata marker lines in the final answer.",
        "Return plain markdown only. No code fences.",
        "Use the exact section order below and keep the heading text unchanged:",
        "## Summary",
        "## Table 1: Portfolio-Level Risk Snapshot",
        "## Table 2: Concentration Analysis",
        "## Table 3: Stock-Level Threat Map",
        "## Table 4: Technical Risk Map",
        "## Table 5: Event / Earnings Risk",
        "## Table 6: Profit-Protection Candidates",
        "## Table 7: Weak / Drag Positions",
        "## Table 8: Scenario Risk",
        "## Table 9: Final Risk Ranking",
        "## Table 10: Urgent Actionables / Immediate Risk-Control Actions",
        "## Bottom Line",
        "",
        "For the summary section, use exactly these six bullet labels:",
        "- Main portfolio risk in one sentence:",
        "- Biggest weakness:",
        "- Biggest near-term threat:",
        "- Biggest position-size risk:",
        "- Biggest profit-protection candidate:",
        "- Biggest weak/drag position:",
        "",
        "If an exact upcoming event date cannot be verified, write 'Not found' or the closest verified timing window instead of guessing.",
        "In Table 5, use the `Exact Date / Timing` column for verified dates.",
        "In Table 10, use the `Exact Date / Deadline` column and never leave it vague when a public event date exists.",
        "For every table row about a single stock, always include Exchange, Stock Symbol, and Stock Name.",
        "Use the pasted stock symbol as authoritative when searching, and determine the verified primary listed exchange in a TradingView-compatible form such as NASDAQ, NYSE, or AMEX.",
        "",
        "Current INDmoney US portfolio snapshot:",
        f"- Snapshot id: {snapshot.id}",
        f"- Snapshot date: {snapshot.snapshot_date.isoformat()}",
        f"- Captured at (IST): {captured_at_ist.strftime('%d %b %Y, %I:%M %p IST')}",
        f"- Source: {snapshot.source}",
        f"- Parse status: {snapshot.parse_status}",
        f"- Parse warnings: {', '.join(snapshot.parse_warnings or []) if snapshot.parse_warnings else 'None'}",
        f"- Reported holdings count: {snapshot.reported_holdings_count if snapshot.reported_holdings_count is not None else 'Not found'}",
        f"- Parsed holdings count: {snapshot.holdings_count}",
        f"- Wallet balance (USD): {_fmt_num(snapshot.wallet_balance)}",
        f"- Current value (USD): {_fmt_num(snapshot.current_value)}",
        f"- Invested value (USD): {_fmt_num(snapshot.invested_value)}",
        f"- 1D return value (USD): {_fmt_num(snapshot.day_return_value)}",
        f"- 1D return (%): {_fmt_pct(snapshot.day_return_percent)}",
        f"- Total return value (USD): {_fmt_num(snapshot.total_return_value)}",
        f"- Total return (%): {_fmt_pct(snapshot.total_return_percent)}",
        f"- Largest single-holding weight (%): {_fmt_pct(top_weight)}",
        "",
        "Market indices table:",
        _build_market_indices_markdown_table(snapshot),
        "",
        "Portfolio holdings table:",
        _build_holdings_markdown_table(snapshot),
        "",
        "Use the analysis brief below verbatim as the core instruction:",
        "",
        THREAT_ANALYSIS_PROMPT,
    ]
    return "\n".join(prompt_sections).strip()


def extract_indmoney_us_threat_prompt_metadata(prompt: str) -> IndMoneyUsThreatPromptMetadata:
    snapshot_id = None
    snapshot_date = None
    captured_at = None

    snapshot_id_match = re.search(r"\[INDMONEY_THREAT_SNAPSHOT_ID=(\d+)\]", prompt or "")
    if snapshot_id_match:
        snapshot_id = int(snapshot_id_match.group(1))

    snapshot_match = re.search(r"\[THREAT_SNAPSHOT_DATE=([0-9]{4}-[0-9]{2}-[0-9]{2})\]", prompt or "")
    if snapshot_match:
        snapshot_date = date.fromisoformat(snapshot_match.group(1))

    captured_match = re.search(r"\[THREAT_CAPTURED_AT=([^\]]+)\]", prompt or "")
    if captured_match:
        try:
            captured_at = datetime.fromisoformat(captured_match.group(1))
        except ValueError:
            captured_at = None

    return IndMoneyUsThreatPromptMetadata(
        snapshot_id=snapshot_id,
        snapshot_date=snapshot_date,
        captured_at=captured_at,
    )


def is_indmoney_us_threat_job(job: Job | None) -> bool:
    return bool(job and THREAT_JOB_MARKER in (job.prompt or ""))


def parse_indmoney_us_threat_report(markdown: str | None) -> dict[str, Any] | None:
    return parse_zerodha_threat_report(markdown)


def parse_indmoney_us_threat_urgent_actionables(
    markdown: str | None,
) -> dict[str, Any] | None:
    return parse_zerodha_threat_urgent_actionables(markdown)


def _build_market_indices_markdown_table(snapshot: IndMoneyUsPortfolioSnapshot) -> str:
    indices = list(snapshot.market_indices or [])
    headers = ["Index", "Value", "Change Value", "Change %", "Raw Change Text"]
    lines = [
        f"| {' | '.join(headers)} |",
        f"| {' | '.join('---' for _ in headers)} |",
    ]

    if not indices:
        lines.append("| None | 0.00 | 0.00 | 0.00 | Not available |")
        return "\n".join(lines)

    for index in indices:
        lines.append(
            "| "
            + " | ".join(
                [
                    str(index.get("name") or ""),
                    _fmt_num(index.get("value")),
                    _fmt_num(index.get("change_value")),
                    _fmt_pct(index.get("change_percent")),
                    str(index.get("raw_change_text") or ""),
                ]
            )
            + " |"
        )
    return "\n".join(lines)


def _build_holdings_markdown_table(snapshot: IndMoneyUsPortfolioSnapshot) -> str:
    holdings = sorted(
        list(snapshot.holdings or []),
        key=lambda holding: float(holding.get("current_value") or 0.0),
        reverse=True,
    )
    headers = [
        "Exchange",
        "Stock Symbol",
        "Stock Name",
        "Quantity",
        "Avg Buy",
        "Market Price",
        "Invested Value",
        "Current Value",
        "PnL",
        "PnL %",
        "Weight %",
        "Price vs Avg %",
        "1D Change %",
    ]
    lines = [
        f"| {' | '.join(headers)} |",
        f"| {' | '.join('---' for _ in headers)} |",
    ]

    if not holdings:
        lines.append("| - | None | None | 0 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |")
        return "\n".join(lines)

    current_value = snapshot.current_value or 0.0
    for holding in holdings:
        holding_current_value = float(holding.get("current_value") or 0.0)
        weight_pct = (holding_current_value / current_value) * 100 if current_value > 0 else 0.0
        lines.append(
            "| "
            + " | ".join(
                [
                    "-",
                    str(holding.get("symbol") or ""),
                    str(holding.get("company_name") or holding.get("symbol") or ""),
                    _fmt_num(holding.get("quantity")),
                    _fmt_num(holding.get("average_price")),
                    _fmt_num(holding.get("market_price")),
                    _fmt_num(holding.get("invested_value")),
                    _fmt_num(holding_current_value),
                    _fmt_num(holding.get("total_pnl")),
                    _fmt_pct(holding.get("total_pnl_percent")),
                    _fmt_pct(weight_pct),
                    _fmt_pct(holding.get("price_vs_average_percent")),
                    _fmt_pct(holding.get("market_change_percent")),
                ]
            )
            + " |"
        )
    return "\n".join(lines)


def _fmt_num(value: float | int | None) -> str:
    return f"{float(value or 0.0):,.2f}"


def _fmt_pct(value: float | int | None) -> str:
    return f"{float(value or 0.0):.2f}"
