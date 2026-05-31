from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
import re
from typing import Any
from zoneinfo import ZoneInfo

from app.domains.jobs.models import Job
from app.domains.zerodha.models import ZerodhaPortfolioSnapshot

THREAT_JOB_MARKER = "[ZERODHA_THREATS]"
THREAT_WEB_SEARCH_MARKER = "[ENABLE_WEB_SEARCH]"
THREAT_ANALYSIS_PROVIDER = "openai"
THREAT_ANALYSIS_MODEL = "gpt-4o-mini"

IST = ZoneInfo("Asia/Kolkata")

THREAT_TABLE_SPECS: list[tuple[str, str]] = [
    ("portfolio_risk_snapshot", "Table 1: Portfolio-Level Risk Snapshot"),
    ("concentration_analysis", "Table 2: Concentration Analysis"),
    ("stock_level_threat_map", "Table 3: Stock-Level Threat Map"),
    ("technical_risk_map", "Table 4: Technical Risk Map"),
    ("event_earnings_risk", "Table 5: Event / Earnings Risk"),
    ("profit_protection_candidates", "Table 6: Profit-Protection Candidates"),
    ("weak_drag_positions", "Table 7: Weak / Drag Positions"),
    ("scenario_risk", "Table 8: Scenario Risk"),
    ("final_risk_ranking", "Table 9: Final Risk Ranking"),
    ("urgent_actionables", "Table 10: Urgent Actionables / Immediate Risk-Control Actions"),
]

SUMMARY_FIELD_LABELS: list[tuple[str, str]] = [
    ("main_portfolio_risk", "Main portfolio risk in one sentence"),
    ("biggest_weakness", "Biggest weakness"),
    ("biggest_near_term_threat", "Biggest near-term threat"),
    ("biggest_position_size_risk", "Biggest position-size risk"),
    ("biggest_profit_protection_candidate", "Biggest profit-protection candidate"),
    ("biggest_weak_drag_position", "Biggest weak/drag position"),
]

THREAT_ANALYSIS_PROMPT = """Act as a top-tier portfolio risk analyst, aggressive swing-trading strategist, technical analyst, macro strategist, and sector-risk manager.

## Objective

Analyse the major short-term threats, weaknesses, vulnerabilities, and downside risks in my current portfolio over the next 1-3 months.

Use the latest available market data, news, earnings updates, sector rotation, macro conditions, technical price action, valuation signals, analyst commentary, and institutional flow indicators.

## Portfolio Style

- I am an aggressive swing trader.
- My investment/trading horizon is 1-3 months.
- I am willing to take risk, but I want to avoid avoidable drawdowns, crowded trades, weak relative-strength stocks, and positions where risk-reward has deteriorated.
- Focus on practical risk management, not long-term investing theory.
- Be direct, decisive, and action-oriented.

## Input

I will paste my current portfolio holdings with some or all of the following data:

- Exchange
- Stock symbol
- Stock name
- Sector
- Live price
- Units
- Average buy price
- Current value
- Current gain/loss %
- Wallet/cash balance, if available

Use the actual holdings, values, weights, and gain/loss data from my pasted portfolio.
Whenever a table row refers to a single stock, return Exchange, Stock Symbol, and Stock Name explicitly in that order before the rest of the row.

---

# Analysis Requirements

## 1. Portfolio-Level Risk

Analyse the portfolio from these angles:

- Sector concentration risk
- Theme concentration risk, such as AI, semiconductors, crypto, defence, PSU, power, banking, smallcap, midcap, etc.
- Top-heavy concentration risk
- Correlation risk among holdings
- Cash buffer / dry powder weakness
- Overexposure to one macro factor
- Overlap between holdings
- Whether the portfolio is genuinely diversified or only appears diversified

## 2. Stock-Level Weakness

For each stock, identify:

- Current technical weakness
- Overextension risk
- Weak relative strength
- Valuation risk
- Earnings/event risk
- News/catalyst risk
- Liquidity risk
- Gap-down risk
- Profit-booking risk
- Whether the stock is a leader, laggard, crowded trade, or opportunity-cost drag

## 3. Technical Risk Analysis

For each important stock, analyse:

- Current trend: bullish, weakening, choppy, or breakdown risk
- Whether it is extended from key moving averages
- Key support and resistance levels
- Breakout failure risk
- Volume confirmation or lack of it
- Whether fresh buying is safe or risky
- Approximate stop-loss / risk-control level

## 4. Macro and Market Risks

Analyse the impact of:

- Interest rates / bond yields
- Inflation expectations
- Central bank policy risk, such as Fed / RBI
- Dollar movement / INR movement, if relevant
- Sector rotation
- Market breadth
- Nasdaq / S&P 500 / Nifty / relevant index weakness
- Risk-off sentiment
- Geopolitical risk
- Crude oil risk, if relevant
- Currency risk, if relevant

## 5. Earnings and Event Calendar Risk

Identify stocks with upcoming:

- Earnings
- Guidance updates
- Investor days
- Product launches
- Regulatory decisions
- Court/legal/regulatory risks
- Policy announcements
- Major sector events

Explain which positions can gap up or gap down around these events.

- If an event date is publicly finalized, capture the exact calendar date.
- Prefer absolute dates like "14 Aug 2026" or "August 14, 2026".
- Do not use vague phrases like "next week", "before earnings", or "soon" when an exact date exists.

## 6. Valuation and Crowding Risk

Identify:

- Stocks priced for perfection
- High P/E or high EV/Sales names
- Stocks vulnerable to multiple compression
- Crowded momentum trades
- Trades where expectations are too high
- Stocks where good news may already be priced in

## 7. Profit Protection

Identify:

- Biggest unrealized profit positions
- Stocks where gains should be protected
- Stocks where trailing stop-loss may be better than fresh buying
- Stocks where partial trimming should be considered
- Stocks where holding is okay but adding is risky

## 8. Weak / Drag Positions

Identify:

- Stocks already in loss despite a strong market
- Stocks underperforming their sector
- Stocks with poor near-term catalysts
- Stocks that may be tying up capital
- Stocks that should be watched for exit if they fail key levels

## 9. Scenario Analysis

Give downside scenarios:

- Mild correction scenario
- Sector rotation scenario
- AI / semiconductor / tech unwind scenario, if relevant
- Midcap / smallcap unwind scenario, if relevant
- Earnings disappointment scenario
- Market-wide risk-off scenario

For each scenario, mention which holdings are most vulnerable and what response is appropriate.

## 10. Risk Ranking

Create a clear ranking of:

- Highest risk due to position size
- Highest risk due to valuation
- Highest risk due to technical weakness
- Highest risk due to event/earnings
- Highest risk due to profit-booking
- Highest opportunity-cost drag

## 11. Urgent Actionables / Immediate Risk-Control Actions

Create a separate urgent action table only for stocks where some action is actually needed.

Do not include stocks where the action is simply "Hold" or "No action".

Include only stocks requiring one of the following actions:

- Urgent Sell
- Sell All
- Trim
- Partial Profit Booking
- Tighten Stop-Loss
- Avoid Fresh Buying
- Watch for Exit
- Reduce Before Earnings/Event
- Shift to Trailing Stop

Be strict. Do not add every holding to this table.

---

# Market-Specific Risk Lens

Apply the correct risk lens depending on the portfolio.

## For US portfolios, pay special attention to:

- AI / semiconductor crowding
- Nasdaq concentration
- High-valuation growth stocks
- US bond yields
- Fed policy
- Dollar movement
- Crypto-beta exposure
- Mega-cap tech concentration
- Earnings/guidance risk
- AI infrastructure and data-centre capex risk

## For Indian portfolios, pay special attention to:

- Midcap/smallcap froth
- PSU / defence / power crowding
- FII/DII flows
- RBI policy
- Election/policy risk
- Crude oil
- INR movement
- Nifty / Bank Nifty / sector rotation
- Valuation froth in momentum stocks
- Liquidity risk in smaller names

---

# Output Format

Start with a short summary:

- Main portfolio risk in one sentence
- Biggest weakness
- Biggest near-term threat
- Biggest position-size risk
- Biggest profit-protection candidate
- Biggest weak/drag position

Then provide the following markdown tables only.

---

## Table 1: Portfolio-Level Risk Snapshot

| Risk Factor | Current Situation | Why It Matters | Severity |
|---|---|---|---|

## Table 2: Concentration Analysis

| Exposure Bucket | Approx. Weight / Exposure | Stocks Included | Risk Comment |
|---|---:|---|---|

## Table 3: Stock-Level Threat Map

| Exchange | Stock Symbol | Stock Name | Current Role | Main Weakness | Key Short-Term Risk | Risk Severity | Action Bias |
|---|---|---|---|---|---|---|---|

## Table 4: Technical Risk Map

| Exchange | Stock Symbol | Stock Name | Trend | Key Support | Key Resistance | Breakdown Trigger | Fresh Buy Risk | Stop-Loss / Risk Control |
|---|---|---|---|---:|---:|---|---|---|

## Table 5: Event / Earnings Risk

| Exchange | Stock Symbol | Stock Name | Upcoming Event / Catalyst | Exact Date / Timing | Possible Positive Impact | Possible Negative Impact | Event Risk |
|---|---|---|---|---|---|---|---|

## Table 6: Profit-Protection Candidates

| Exchange | Stock Symbol | Stock Name | Current Gain % | Why Gains Are at Risk | Suggested Risk Control |
|---|---|---|---:|---|---|

## Table 7: Weak / Drag Positions

| Exchange | Stock Symbol | Stock Name | Current Loss / Weakness | Why It Is a Drag | Exit / Watch Trigger |
|---|---|---|---|---|---|

## Table 8: Scenario Risk

| Scenario | Portfolio Impact | Most Vulnerable Stocks | Suggested Response |
|---|---|---|---|

## Table 9: Final Risk Ranking

| Rank | Risk / Weakness | Stocks Most Exposed | Severity | Practical Interpretation |
|---:|---|---|---|---|

## Table 10: Urgent Actionables / Immediate Risk-Control Actions

Include only stocks where urgent or near-term action is actually needed.

| Exchange | Stock Symbol | Stock Name | Urgent Action Needed | Why Action Is Needed Now | Trigger / Condition | Exact Date / Deadline | Suggested Action Size | Priority | Time Sensitivity |
|---|---|---|---|---|---|---|---|---|---|

Rules for Table 10:

- Include only actionable stocks.
- Do not include every holding.
- Exclude stocks where no immediate risk-control action is required.
- "Avoid Fresh Buying" should be included only if the stock is materially extended, event-risky, or valuation-risky.
- "Tighten Stop-Loss" should be included only where gains are at risk or breakdown risk is near.
- "Trim" or "Partial Profit Booking" should be used only where gains are large, position size is high, or near-term reversal risk is elevated.
- "Urgent Sell" or "Sell All" should be used only for stocks with serious technical breakdown, weak relative strength, poor catalyst outlook, or deteriorated risk-reward.
- If the action is tied to earnings, investor day, product launch, policy event, court decision, regulatory event, or any dated catalyst, the `Exact Date / Deadline` column must contain the verified calendar date.
- When a final event date is known, do not write only "Before Earnings" or "Soon". Write the exact deadline, such as "Before earnings on 14 Aug 2026", and also fill the `Exact Date / Deadline` column.
- If no verified date exists, write `Not found` or the closest verified timing window instead of inventing one.
- Mention whether priority is Very High, High, Medium, or Low.
- Mention whether action is needed Today, Before Earnings/Event, On Breakdown, On Bounce, or Over Next Few Sessions.
- If there are no urgent actionables, write one row saying: "No urgent action required" and explain briefly.

---

# Final Section

Give a clear conclusion in this format:

## Bottom Line

| Point | Conclusion |
|---|---|
| My portfolio is currently strong/weak because |  |
| The biggest short-term danger is |  |
| The biggest mistake to avoid is |  |
| Stocks to protect gains in |  |
| Stocks to avoid adding fresh money to |  |
| Stocks that need close monitoring |  |
| Stocks that are relatively safer holds |  |
| Suggested risk posture for the next 1-3 months |  |

---

# Important Rules

- Do not give generic advice.
- Use the actual holdings and weights from my pasted portfolio.
- Do not invent holdings, prices, weights, catalysts, or levels.
- Use the pasted exchange + stock symbol pair as authoritative when available.
- For Indian stocks, return `NSE` or `BSE`. For US stocks, return the verified primary listed exchange in a TradingView-compatible form such as `NASDAQ`, `NYSE`, or `AMEX`.
- Do not ignore small positions if they carry high risk.
- Do not only focus on losers; also analyse winners where gains can reverse.
- Be direct and practical.
- Mention exact dates wherever available.
- Use absolute calendar dates instead of relative wording whenever a public date exists.
- Mention whether each risk is Low, Medium, High, or Very High.
- Avoid long disclaimers.
- Output should be concise but complete.
- Use fresh data wherever required.
- Prioritise actionable risk management over broad commentary.
- Table 10 must include only stocks where urgent or near-term action is actually needed.
- If no action is needed for a stock, exclude it from Table 10.
- Be decisive in Table 10: mention whether to Sell All, Trim, Partially Book Profit, Tighten Stop-Loss, Avoid Fresh Buying, Watch for Exit, Reduce Before Earnings/Event, or Shift to Trailing Stop."""


@dataclass(frozen=True)
class ThreatPromptMetadata:
    snapshot_date: date | None
    captured_at: datetime | None


def build_zerodha_threat_prompt(snapshot: ZerodhaPortfolioSnapshot) -> str:
    captured_at_ist = snapshot.captured_at.astimezone(IST)
    top_weight = 0.0
    if snapshot.holdings_market_value > 0:
        top_weight = max(
            (
                ((holding.get("market_value") or 0.0) / snapshot.holdings_market_value) * 100
                for holding in snapshot.holdings or []
                if (holding.get("quantity") or 0) > 0
            ),
            default=0.0,
        )

    prompt_sections = [
        THREAT_JOB_MARKER,
        THREAT_WEB_SEARCH_MARKER,
        "[THREAT_METADATA_DO_NOT_REPEAT]",
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
        "Use the pasted exchange + stock symbol pair as authoritative when searching; if the pasted stock name is ticker-like, replace it with the official company name when verified.",
        "",
        "Current Zerodha portfolio snapshot:",
        f"- Snapshot date: {snapshot.snapshot_date.isoformat()}",
        f"- Captured at (IST): {captured_at_ist.strftime('%d %b %Y, %I:%M %p IST')}",
        f"- Holdings count: {snapshot.holdings_count}",
        f"- Net positions count: {snapshot.net_positions_count}",
        f"- Holdings market value (INR): {_fmt_num(snapshot.holdings_market_value)}",
        f"- Holdings unrealized PnL (INR): {_fmt_num(snapshot.holdings_pnl)}",
        f"- Holdings day change value (INR): {_fmt_num(snapshot.holdings_day_change_value)}",
        f"- Net positions PnL (INR): {_fmt_num(snapshot.positions_pnl)}",
        f"- Net positions M2M (INR): {_fmt_num(snapshot.positions_m2m)}",
        f"- Largest single-holding weight (%): {_fmt_pct(top_weight)}",
        "- Cash / wallet balance: Not available from the Zerodha snapshot; do not invent it.",
        "- Sector is not present in the snapshot; infer sector/theme only when supported by current public company data.",
        "",
        "Portfolio holdings table:",
        _build_holdings_markdown_table(snapshot),
        "",
        "Net positions table:",
        _build_positions_markdown_table(snapshot),
        "",
        "Use the analysis brief below verbatim as the core instruction:",
        "",
        THREAT_ANALYSIS_PROMPT,
    ]
    return "\n".join(prompt_sections).strip()


def extract_threat_prompt_metadata(prompt: str) -> ThreatPromptMetadata:
    snapshot_date = None
    captured_at = None
    snapshot_match = re.search(r"\[THREAT_SNAPSHOT_DATE=([0-9]{4}-[0-9]{2}-[0-9]{2})\]", prompt or "")
    if snapshot_match:
        snapshot_date = date.fromisoformat(snapshot_match.group(1))

    captured_match = re.search(r"\[THREAT_CAPTURED_AT=([^\]]+)\]", prompt or "")
    if captured_match:
        try:
            captured_at = datetime.fromisoformat(captured_match.group(1))
        except ValueError:
            captured_at = None

    return ThreatPromptMetadata(snapshot_date=snapshot_date, captured_at=captured_at)


def is_zerodha_threat_job(job: Job | None) -> bool:
    return bool(job and THREAT_JOB_MARKER in (job.prompt or ""))


def parse_zerodha_threat_report(markdown: str | None) -> dict[str, Any] | None:
    text = (markdown or "").strip()
    if not text:
        return None

    sections = _split_markdown_sections(text)
    preamble = sections.pop("__preamble__", "")
    summary_text = sections.get("summary", preamble)
    summary_values = _parse_summary(summary_text)

    summary_items = [
        {"label": label, "value": summary_values.get(key, "")}
        for key, label in SUMMARY_FIELD_LABELS
        if summary_values.get(key, "")
    ]

    tables = []
    for key, title in THREAT_TABLE_SPECS:
        rows = _parse_markdown_table(sections.get(_normalize_heading(title), ""))
        if not rows["columns"] and not rows["rows"]:
            continue
        tables.append(
            {
                "key": key,
                "title": title,
                "columns": rows["columns"],
                "rows": rows["rows"],
            }
        )

    bottom_line_table = _parse_markdown_table(sections.get("bottom_line", ""))
    bottom_line = []
    for row in bottom_line_table["rows"]:
        point = row.get("Point") or row.get("point") or next(iter(row.values()), "")
        conclusion = row.get("Conclusion") or row.get("conclusion") or ""
        if point or conclusion:
            bottom_line.append({"label": point, "value": conclusion})

    return {
        "summary": {key: summary_values.get(key) for key, _label in SUMMARY_FIELD_LABELS},
        "summary_items": summary_items,
        "tables": tables,
        "bottom_line": bottom_line,
        "raw_markdown": text,
    }


def _build_holdings_markdown_table(snapshot: ZerodhaPortfolioSnapshot) -> str:
    holdings = sorted(
        [
            holding
            for holding in (snapshot.holdings or [])
            if (holding.get("quantity") or 0) > 0 or abs(float(holding.get("market_value") or 0.0)) > 0
        ],
        key=lambda holding: float(holding.get("market_value") or 0.0),
        reverse=True,
    )
    headers = [
        "Exchange",
        "Stock Symbol",
        "Stock Name",
        "Units",
        "Avg Buy",
        "Live Price",
        "Invested Value",
        "Current Value",
        "PnL",
        "PnL %",
        "Weight %",
        "Day Change %",
        "Day Change Value",
    ]
    lines = [
        f"| {' | '.join(headers)} |",
        f"| {' | '.join('---' for _ in headers)} |",
    ]
    total_market_value = snapshot.holdings_market_value or 0.0
    for holding in holdings:
        invested_value = float(holding.get("invested_value") or 0.0)
        market_value = float(holding.get("market_value") or 0.0)
        pnl = float(holding.get("pnl") or 0.0)
        day_change_pct = float(holding.get("day_change_percentage") or 0.0)
        weight_pct = ((market_value / total_market_value) * 100) if total_market_value > 0 else 0.0
        pnl_pct = ((pnl / invested_value) * 100) if invested_value > 0 else 0.0
        lines.append(
            "| "
            + " | ".join(
                [
                    str(holding.get("exchange") or ""),
                    str(holding.get("tradingsymbol") or ""),
                    str(holding.get("tradingsymbol") or ""),
                    str(int(holding.get("quantity") or 0)),
                    _fmt_num(float(holding.get("average_price") or 0.0)),
                    _fmt_num(float(holding.get("last_price") or 0.0)),
                    _fmt_num(invested_value),
                    _fmt_num(market_value),
                    _fmt_num(pnl),
                    _fmt_pct(pnl_pct),
                    _fmt_pct(weight_pct),
                    _fmt_pct(day_change_pct),
                    _fmt_num(float(holding.get("day_change_value") or 0.0)),
                ]
            )
            + " |"
        )
    return "\n".join(lines)


def _build_positions_markdown_table(snapshot: ZerodhaPortfolioSnapshot) -> str:
    positions = sorted(
        [
            position
            for position in (snapshot.net_positions or [])
            if (position.get("quantity") or 0) != 0 or abs(float(position.get("value") or 0.0)) > 0
        ],
        key=lambda position: abs(float(position.get("value") or 0.0)),
        reverse=True,
    )
    headers = ["Ticker", "Exchange", "Product", "Quantity", "Avg Price", "Last Price", "Value", "PnL", "M2M"]
    lines = [
        f"| {' | '.join(headers)} |",
        f"| {' | '.join('---' for _ in headers)} |",
    ]
    if not positions:
        lines.append("| None | - | - | 0 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |")
        return "\n".join(lines)

    for position in positions:
        lines.append(
            "| "
            + " | ".join(
                [
                    str(position.get("tradingsymbol") or ""),
                    str(position.get("exchange") or ""),
                    str(position.get("product") or ""),
                    str(int(position.get("quantity") or 0)),
                    _fmt_num(float(position.get("average_price") or 0.0)),
                    _fmt_num(float(position.get("last_price") or 0.0)),
                    _fmt_num(float(position.get("value") or 0.0)),
                    _fmt_num(float(position.get("pnl") or 0.0)),
                    _fmt_num(float(position.get("m2m") or 0.0)),
                ]
            )
            + " |"
        )
    return "\n".join(lines)


def _split_markdown_sections(text: str) -> dict[str, str]:
    sections: dict[str, list[str]] = {"__preamble__": []}
    current = "__preamble__"
    for raw_line in text.splitlines():
        line = raw_line.rstrip()
        if line.startswith("## "):
            current = _normalize_heading(line[3:])
            sections.setdefault(current, [])
            continue
        sections.setdefault(current, []).append(line)
    return {key: "\n".join(lines).strip() for key, lines in sections.items()}


def _parse_summary(text: str) -> dict[str, str]:
    results: dict[str, str] = {}
    label_map = {_normalize_label(label): key for key, label in SUMMARY_FIELD_LABELS}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line.startswith(("-", "*")):
            continue
        cleaned = re.sub(r"^[\-*]\s*", "", line)
        if ":" not in cleaned:
            continue
        label, value = cleaned.split(":", 1)
        key = label_map.get(_normalize_label(label))
        if key:
            results[key] = value.strip()
    return results


def _parse_markdown_table(text: str) -> dict[str, list[Any]]:
    lines = [line.strip() for line in (text or "").splitlines() if line.strip()]
    table_lines = [line for line in lines if line.count("|") >= 2]
    if len(table_lines) < 2:
        return {"columns": [], "rows": []}

    headers = [cell.strip() for cell in table_lines[0].strip("|").split("|")]
    rows: list[dict[str, str]] = []
    for line in table_lines[1:]:
        if re.fullmatch(r"\|?[\s:\-|\t]+\|?", line):
            continue
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        if len(cells) < len(headers):
            cells.extend([""] * (len(headers) - len(cells)))
        row = {headers[idx]: cells[idx] for idx in range(len(headers))}
        rows.append(row)
    return {"columns": headers, "rows": rows}


def _normalize_heading(value: str) -> str:
    normalized = value.strip().lower()
    normalized = normalized.replace("&", "and")
    normalized = re.sub(r"[^a-z0-9]+", "_", normalized)
    return normalized.strip("_")


def _normalize_label(value: str) -> str:
    normalized = value.strip().lower()
    normalized = normalized.replace("&", "and")
    normalized = normalized.replace("\u2013", "-")
    normalized = re.sub(r"\s+", " ", normalized)
    return normalized.strip(" :*-")


def _fmt_num(value: float) -> str:
    return f"{value:,.2f}"


def _fmt_pct(value: float) -> str:
    return f"{value:.2f}"
