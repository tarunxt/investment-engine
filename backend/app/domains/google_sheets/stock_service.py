import json
import logging
from datetime import datetime
from typing import Any, cast

import json5

logger = logging.getLogger(__name__)


def parse_stock_recommendations(response_text: str) -> list[dict[str, Any]]:
    """
    Parse AI-generated investment advice response to extract stock recommendations.
    Handles both JSON and JSON5 formats with fallback to text parsing.
    """
    stocks: list[dict[str, Any]] = []

    # Try parsing as JSON first
    try:
        data = json.loads(response_text)
        if isinstance(data, dict) and "stocks" in data:
            stocks = data.get("stocks", [])
        elif isinstance(data, list):
            stocks = data
        return stocks
    except json.JSONDecodeError:
        pass

    # Try JSON5 (more lenient)
    try:
        data = json5.loads(response_text)
        if isinstance(data, dict) and "stocks" in data:
            stocks_data = data.get("stocks", [])
            stocks = cast(list[dict[str, Any]], stocks_data)
        elif isinstance(data, list):
            stocks = cast(list[dict[str, Any]], data)
        if stocks:
            return stocks
    except Exception:
        pass

    # Fallback: Try to find JSON array in the response
    try:
        import re

        # Find JSON array pattern
        pattern = r"\[[\s\S]*\]"
        match = re.search(pattern, response_text)
        if match:
            json_str = match.group(0)
            stocks = json.loads(json_str)
            if isinstance(stocks, list):
                return stocks
    except Exception:
        pass

    # Fallback: Parse markdown table output
    try:
        import re

        lines = [line.strip() for line in response_text.splitlines() if line.strip()]
        table_lines = [line for line in lines if line.count("|") >= 3]
        if table_lines:
            header_line = table_lines[0].strip("|")
            headers = [h.strip() for h in header_line.split("|")]
            rows = []
            for line in table_lines[1:]:
                # Skip markdown separator rows like |---|---|
                if re.fullmatch(r"\|?[\s:\-|\t]+\|?", line):
                    continue
                cols = [c.strip() for c in line.strip("|").split("|")]
                if len(cols) < len(headers):
                    cols += [""] * (len(headers) - len(cols))
                rows.append(cols[: len(headers)])

            if rows:
                key_map = {
                    "stock name": "stock_name",
                    "technical setup": "technical_setup",
                    "entry range": "entry_range",
                    "stop loss": "stop_loss",
                    "target": "target",
                    "analyst/source": "analyst_source",
                    "analyst source": "analyst_source",
                    "units to buy": "units_to_buy",
                    "price per unit": "price_per_unit",
                    "total buy amount": "total_buy_amount",
                    "upside horizon (%) return in weeks": "upside_horizon",
                    "upside horizon": "upside_horizon",
                    "confidence score (0-100)": "confidence_score",
                    "confidence score": "confidence_score",
                    "rationale remarks": "rationale_remarks",
                    "rationale/remarks": "rationale_remarks",
                }

                normalized_headers = [
                    key_map.get(" ".join(h.lower().split()), " ".join(h.lower().split()))
                    for h in headers
                ]
                parsed_rows: list[dict[str, Any]] = []
                for row in rows:
                    item = {normalized_headers[i]: row[i] for i in range(len(normalized_headers))}
                    if item.get("stock_name"):
                        parsed_rows.append(item)
                if parsed_rows:
                    return parsed_rows
    except Exception:
        pass

    logger.warning("Could not parse stock recommendations from response")
    return []


def format_sheet_title(date: datetime, investment_amount: str) -> str:
    """Format the Google Sheet title with date and investment amount."""
    date_str = date.strftime("%d %B %Y")  # e.g., "21 May 2026"
    return f"{date_str} | How to Invest {investment_amount}"


def format_stocks_for_sheet(stocks: list[dict[str, Any]]) -> tuple[list[str], list[list[str]]]:
    """
    Format stock recommendations for Google Sheets export.
    Returns (headers, rows). Includes stage info if present in stock data.
    """
    # Include Stage column if any stock has stage info
    has_stage = any(stock.get("stage") is not None for stock in stocks)

    headers = [
        "Stage",
        "Stock Name",
        "Technical Setup",
        "Entry Range",
        "Stop Loss",
        "Target",
        "Analyst Source",
        "Units to Buy",
        "Price per Unit",
        "Total Buy Amount",
        "Upside Horizon",
        "Confidence Score",
        "Rationale/Remarks",
    ] if has_stage else [
        "Stock Name",
        "Technical Setup",
        "Entry Range",
        "Stop Loss",
        "Target",
        "Analyst Source",
        "Units to Buy",
        "Price per Unit",
        "Total Buy Amount",
        "Upside Horizon",
        "Confidence Score",
        "Rationale/Remarks",
    ]

    rows: list[list[str]] = []

    for stock in stocks:
        row_data = []
        if has_stage:
            row_data.append(str(stock.get("stage", "")).strip())

        row_data.extend([
            str(stock.get("stock_name", "")).strip(),
            str(stock.get("technical_setup", "")).strip(),
            str(stock.get("entry_range", "")).strip(),
            str(stock.get("stop_loss", "")).strip(),
            str(stock.get("target", "")).strip(),
            str(stock.get("analyst_source", "")).strip(),
            str(stock.get("units_to_buy", "")).strip(),
            str(stock.get("price_per_unit", "")).strip(),
            str(stock.get("total_buy_amount", "")).strip(),
            str(stock.get("upside_horizon", "")).strip(),
            str(stock.get("confidence_score", "")).strip(),
            str(stock.get("rationale_remarks", "")).strip(),
        ])
        rows.append(row_data)

    return headers, rows
