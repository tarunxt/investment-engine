from __future__ import annotations

import re
from typing import Any

EVENT_WEB_SEARCH_MARKER = "[ENABLE_WEB_SEARCH]"
EVENT_ANALYSIS_PROVIDER = "openai"
EVENT_ANALYSIS_MODEL = "gpt-4o-mini"

EVENT_TABLE_COLUMNS = [
    "Date",
    "Exchange",
    "Stock Symbol",
    "Stock Name",
    "Event",
    "Why it may matter",
    "Expected Outcome",
    "Status / Source",
]

EVENT_ANALYSIS_PROMPT = """Act as an equity market calendar analyst for both **Indian equities** and **US equities**.

Using my current portfolio holdings pasted below, create **Table 1 only** listing all upcoming scheduled / announced price-sensitive events for these holdings.
You must cover **every holding in the pasted portfolio**, not just a selected subset.

Prioritize the **nearest 60 calendar days first**. If a holding has no event inside 60 days but has a clearly scheduled event shortly after that, you may still include it.

The portfolio may contain:

* Indian stocks from NSE/BSE / Zerodha holdings
* US stocks from INDmoney US portfolio
* Or both together

Events to include:

* Earnings / quarterly results / board meeting for results
* Investor Day / Analyst Day
* Annual General Meeting / shareholder meeting
* Dividend declaration, ex-dividend date, record date, payment date
* Bonus, split, buyback, rights issue, preferential issue, QIP, merger/demerger, scheme of arrangement
* Major management presentation / investor conference
* Product launch / developer conference / AI event / industry event directly relevant to the company
* Regulatory approval / scheduled court/NCLT/SEC-related event, if clearly scheduled
* Any other clearly scheduled company-specific event that may affect price

For each event, also assess the **expected market outcome at the event** as exactly one of:

* Bullish
* Bearish
* Neutral

Expected Outcome rules:

1. Base the expected outcome on available evidence such as recent results trend, analyst expectations, guidance, management commentary, recent newsflow, sector trend, valuation, recent price action, and event type.
2. Use **Bullish** only where the event has a reasonable chance of positive surprise, favourable guidance, positive corporate action, or strong sector/news support.
3. Use **Bearish** only where the event has a reasonable chance of disappointment, weak guidance, adverse regulatory/corporate action, or negative sector/news support.
4. Use **Neutral** where the event is routine, already priced in, low-impact, mixed, or insufficient evidence is available.
5. Do not overstate certainty. This is an expected event bias, not a guaranteed outcome.
6. The Expected Outcome column must contain only: Bullish, Bearish, or Neutral.

Source rules:

1. Use the latest available online information.
2. Do not rely on stale memory.
3. Treat the pasted exchange + stock symbol pair as authoritative when available and use it in searches.
4. For Indian stocks, prefer NSE corporate announcements, BSE corporate announcements, company investor relations pages, exchange filings, SEBI/NCLT disclosures, and reputable market calendar sources.
5. For US stocks, prefer company IR pages, SEC filings, Nasdaq/NYSE calendars, press releases, and reputable market calendar sources.
6. For Indian stocks, return the exchange as exactly `NSE` or `BSE` using the pasted portfolio data.
7. For US stocks, return the primary listed exchange in a TradingView-compatible form such as `NASDAQ`, `NYSE`, or `AMEX` when it can be verified from current public sources.
8. Always return both the stock symbol and the stock name. If the pasted stock name is only a ticker-like placeholder, replace it with the proper listed company name when verified.
9. If a date is company-confirmed or exchange-confirmed, write “Confirmed” in Status / Source.
10. If a date is only estimated by third-party calendars, write “Estimated / not company-confirmed”.
11. If sources conflict, mention the conflict briefly in Status / Source.
12. Include source name and link/citation in Status / Source.
13. Before concluding there are no events, check at least these categories for every holding, with extra care on the most material holdings: earnings/results date, dividend/ex-date, AGM/shareholder meeting, investor conference / analyst day / product event.
14. Do not treat failure to find one event type as proof that no scheduled event exists.

Strict output rules:

1. Return **only Table 1**.
2. Do not include any introduction, explanation, notes, assumptions, observations, bullets, summary, or conclusion.
3. Use only upcoming events as of today.
4. Do not include past events.
5. Do not invent any event, date, source, explanation, or expected outcome.
6. Return at least one row for every holding in the portfolio.
7. If a holding has multiple distinct material upcoming events, include multiple rows for that holding.
8. If no scheduled event is found for a holding after checking the required categories, include exactly one fallback row for that holding with Date `Not found`, the best available Exchange / Stock Symbol / Stock Name for that holding, Event `No upcoming scheduled price-sensitive event found`, Why it may matter `No scheduled catalyst found in checked sources`, Expected Outcome `Neutral`, and Status / Source `Checked latest available sources`.
9. Every row must include Exchange, Stock Symbol, and Stock Name. For fallback rows, use the pasted exchange and stock symbol where available so every portfolio holding remains visible in the final table.
10. Sort rows by date from nearest to farthest, placing any `Not found` fallback rows after dated rows.
11. Date format must be: DD Mon YYYY.
12. Keep wording concise but meaningful inside cells.
13. Use the exact column structure below.
14. Standardize holding names/tickers where required.
15. If a holding is ambiguous, use the pasted exchange + stock symbol pair as the tie-breaker.
16. If both Indian and US holdings are provided, combine them into the same table and do not create separate tables.
17. Use exact absolute dates whenever available; avoid vague text like “next week”, “soon”, or “upcoming”.

Return only this table:

| Date | Exchange | Stock Symbol | Stock Name | Event | Why it may matter | Expected Outcome | Status / Source |
| ---- | -------- | ------------ | ---------- | ----- | ----------------- | ---------------- | --------------- |"""

_HEADER_ALIASES = {
    "date": "Date",
    "exchange": "Exchange",
    "exchange_name": "Exchange",
    "market": "Exchange",
    "market_exchange": "Exchange",
    "stock_symbol": "Stock Symbol",
    "symbol": "Stock Symbol",
    "ticker": "Stock Symbol",
    "ticker_symbol": "Stock Symbol",
    "tradingsymbol": "Stock Symbol",
    "stock_name": "Stock Name",
    "holding": "Stock Name",
    "company": "Stock Name",
    "company_name": "Stock Name",
    "event": "Event",
    "why_it_may_matter": "Why it may matter",
    "why_it_matter": "Why it may matter",
    "expected_outcome": "Expected Outcome",
    "status_source": "Status / Source",
    "status_and_source": "Status / Source",
}

_OUTCOME_ALIASES = {
    "bullish": "Bullish",
    "bearish": "Bearish",
    "neutral": "Neutral",
}


def parse_event_calendar_table(markdown: str | None) -> dict[str, Any] | None:
    text = (markdown or "").strip()
    if not text:
        return None

    table_text = _extract_first_markdown_table(text)
    if not table_text:
        return {
            "columns": EVENT_TABLE_COLUMNS,
            "rows": [],
            "raw_markdown": text,
        }

    parsed = _parse_markdown_table(table_text)
    rows = _normalize_rows(parsed["columns"], parsed["rows"])

    return {
        "columns": EVENT_TABLE_COLUMNS,
        "rows": rows,
        "raw_markdown": text,
    }


def ensure_event_table_covers_prompt_holdings(
    prompt: str | None,
    parsed: dict[str, Any] | None,
) -> dict[str, Any] | None:
    if parsed is None:
        return None

    expected_holdings = _extract_prompt_holdings(prompt or "")
    if not expected_holdings:
        return parsed

    rows = [
        row
        for row in list(parsed.get("rows") or [])
        if not _is_portfolio_wide_placeholder_row(row)
    ]
    missing_rows: list[dict[str, str]] = []

    for expected in expected_holdings:
        if any(_row_matches_expected_holding(row, expected) for row in rows):
            continue

        label = expected["stock_name"] or expected["stock_symbol"] or "Unknown holding"
        missing_rows.append(
            {
                "Date": "Not found",
                "Exchange": expected["exchange"],
                "Stock Symbol": expected["stock_symbol"],
                "Stock Name": label,
                "Event": "No upcoming scheduled price-sensitive event found",
                "Why it may matter": "No scheduled catalyst found in checked sources",
                "Expected Outcome": "Neutral",
                "Status / Source": "Checked latest available sources",
            }
        )

    if not missing_rows:
        return parsed

    return {
        **parsed,
        "rows": rows + missing_rows,
    }


def _extract_first_markdown_table(text: str) -> str:
    lines = [line.rstrip() for line in text.splitlines()]
    table_lines: list[str] = []
    started = False

    for line in lines:
        if line.count("|") >= 2:
            table_lines.append(line.strip())
            started = True
            continue
        if started:
            break

    return "\n".join(table_lines).strip()


def _extract_prompt_holdings(prompt: str) -> list[dict[str, str]]:
    marker = "Portfolio holdings table:"
    marker_index = prompt.find(marker)
    if marker_index >= 0:
        prompt = prompt[marker_index + len(marker):]

    table_text = _extract_first_markdown_table(prompt)
    parsed = _parse_markdown_table(table_text)
    if not parsed["columns"]:
        return []

    headers = {_normalize_header(column): column for column in parsed["columns"]}
    exchange_column = headers.get("exchange") or headers.get("market")
    stock_name_column = headers.get("stock_name") or headers.get("holding") or headers.get("company")
    stock_symbol_column = headers.get("stock_symbol") or headers.get("ticker") or headers.get("symbol") or headers.get("tradingsymbol")
    if not stock_name_column and not stock_symbol_column:
        return []

    holdings: list[dict[str, str]] = []
    seen: set[tuple[str, str, str]] = set()

    for row in parsed["rows"]:
        exchange = _clean_prompt_holding_value(row.get(exchange_column or "", ""))
        stock_name = _clean_prompt_holding_value(row.get(stock_name_column or "", ""))
        stock_symbol = _clean_prompt_holding_value(row.get(stock_symbol_column or "", ""))
        if not stock_name and not stock_symbol:
            continue

        key = (exchange.lower(), stock_symbol.lower(), stock_name.lower())
        if key in seen:
            continue
        seen.add(key)
        holdings.append(
            {
                "exchange": exchange,
                "stock_symbol": stock_symbol,
                "stock_name": stock_name,
            }
        )

    return holdings


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


def _normalize_rows(columns: list[str], rows: list[dict[str, str]]) -> list[dict[str, str]]:
    if not columns:
        return []

    mapped_columns = {_HEADER_ALIASES.get(_normalize_header(column), column): column for column in columns}
    normalized_rows: list[dict[str, str]] = []

    for row in rows:
        normalized_row: dict[str, str] = {}
        for canonical in EVENT_TABLE_COLUMNS:
            source_column = mapped_columns.get(canonical)
            value = (row.get(source_column or "", "") or "").strip()
            if canonical == "Expected Outcome":
                value = _normalize_outcome(value)
            normalized_row[canonical] = value

        _backfill_structured_stock_fields(normalized_row)

        if any(value for value in normalized_row.values()):
            normalized_rows.append(normalized_row)

    return normalized_rows


def _clean_prompt_holding_value(value: str) -> str:
    cleaned = (value or "").strip()
    if cleaned.lower() in {"", "-", "none", "all holdings"}:
        return ""
    return cleaned


def _row_matches_expected_holding(row: dict[str, str], expected: dict[str, str]) -> bool:
    row_symbol = _normalize_holding_token(row.get("Stock Symbol", ""))
    row_name = _normalize_holding_token(row.get("Stock Name", ""))
    row_exchange = _normalize_holding_token(row.get("Exchange", ""))

    if row_symbol and _holding_alias_matches(row_symbol, expected.get("stock_symbol", "")):
        if row_exchange and expected.get("exchange"):
            return _holding_alias_matches(row_exchange, expected.get("exchange", ""))
        return True

    aliases = [expected.get("stock_name", ""), expected.get("stock_symbol", "")]
    return any(_holding_alias_matches(row_name, alias) for alias in aliases)


def _is_portfolio_wide_placeholder_row(row: dict[str, str]) -> bool:
    stock_name = _normalize_holding_token(row.get("Stock Name", ""))
    stock_symbol = _normalize_holding_token(row.get("Stock Symbol", ""))
    event = _normalize_holding_token(row.get("Event", ""))
    return (
        "noupcomingscheduledpricesensitiveeventfound" in event
        and (stock_name == "allholdings" or stock_symbol == "allholdings")
    )


def _holding_alias_matches(row_holding: str, alias: str) -> bool:
    alias_normalized = _normalize_holding_token(alias)
    if not alias_normalized:
        return False
    if row_holding == alias_normalized:
        return True
    if len(alias_normalized) > 5 and (
        row_holding in alias_normalized or alias_normalized in row_holding
    ):
        return True
    return False


def _normalize_holding_token(value: str) -> str:
    normalized = (value or "").strip().lower()
    return re.sub(r"[^a-z0-9]+", "", normalized)


def _normalize_header(value: str) -> str:
    normalized = value.strip().lower()
    normalized = normalized.replace("&", "and")
    normalized = normalized.replace("/", "_")
    normalized = re.sub(r"[^a-z0-9]+", "_", normalized)
    return normalized.strip("_")


def _normalize_outcome(value: str) -> str:
    normalized = value.strip().lower()
    for key, label in _OUTCOME_ALIASES.items():
        if key == normalized or key in normalized:
            return label
    return value


def _backfill_structured_stock_fields(row: dict[str, str]) -> None:
    stock_name = row.get("Stock Name", "").strip()
    stock_symbol = row.get("Stock Symbol", "").strip()

    if stock_name and not stock_symbol:
        extracted_name, extracted_symbol = _split_legacy_holding_value(stock_name)
        if extracted_symbol:
            row["Stock Name"] = extracted_name or stock_name
            row["Stock Symbol"] = extracted_symbol
            stock_name = row["Stock Name"]
            stock_symbol = row["Stock Symbol"]

    if stock_symbol and not stock_name:
        row["Stock Name"] = stock_symbol
        stock_name = stock_symbol

    if stock_name and not stock_symbol and _looks_like_symbol(stock_name):
        row["Stock Symbol"] = stock_name


def _split_legacy_holding_value(value: str) -> tuple[str, str]:
    text = value.strip()
    match = re.match(r"^(?P<name>.+?)\s*\((?P<symbol>[A-Z0-9.&_-]{1,24})\)$", text)
    if match:
        return match.group("name").strip(), match.group("symbol").strip()
    return text, ""


def _looks_like_symbol(value: str) -> bool:
    return bool(re.fullmatch(r"[A-Z0-9][A-Z0-9.&_-]{0,24}", value.strip()))
