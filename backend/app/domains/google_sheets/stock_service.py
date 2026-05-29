import json
import logging
import re
from datetime import datetime
from typing import Any, cast

import json5

logger = logging.getLogger(__name__)


def _normalize_header(value: str) -> str:
    cleaned = (
        value.replace("’", "'")
        .replace("%", " percent ")
        .replace("+", " plus ")
        .replace("/", " ")
        .replace("-", " ")
        .replace("(", " ")
        .replace(")", " ")
    )
    return " ".join(cleaned.lower().split())


def _is_separator_token(value: str) -> bool:
    stripped = value.replace(":", "").replace("-", "").strip()
    return stripped == ""


def _is_header_like_row(row: list[str], headers: list[str]) -> bool:
    if not row or not headers:
        return False
    normalized_row = [_normalize_header(v) for v in row]
    normalized_headers = [_normalize_header(v) for v in headers]
    matches = sum(1 for i in range(min(len(normalized_row), len(normalized_headers))) if normalized_row[i] == normalized_headers[i])
    return matches >= max(3, len(normalized_headers) // 2)


def _looks_like_data_row(item: dict[str, Any]) -> bool:
    symbol = str(item.get("stock_symbol", "")).strip()
    name = str(item.get("stock_name", "")).strip()
    technical = str(item.get("technical_setup", "")).strip()
    # Avoid accepting duplicated header/separator rows as data.
    if _normalize_header(symbol) == "stock_symbol":
        return False
    if _normalize_header(name) in {"stock_name", "stock_symbol"}:
        return False
    if technical and set(technical.replace("-", "").replace(" ", "")) == set():
        return False
    return bool(symbol)


def _to_number(value: Any) -> int | float | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    text = text.replace(",", "")
    text = re.sub(r"[^\d.\-]", "", text)
    if not text or text in {"-", ".", "-."}:
        return None
    try:
        number = float(text)
        if number.is_integer():
            return int(number)
        return number
    except ValueError:
        return None


def _parse_upside_horizon_and_weeks(value: Any) -> tuple[int | float | None, int | float | None]:
    text = str(value or "").strip().lower()
    if not text:
        return None, None

    # Handles: "12.5% in 6-8 weeks", "12% in 10 weeks", "11.8 in 8–10"
    horizon_match = re.search(r"(-?\d+(?:\.\d+)?)\s*%?", text)
    horizon = _to_number(horizon_match.group(1)) if horizon_match else None

    week_range = re.search(r"in\s*(\d+(?:\.\d+)?)\s*[-–to]+\s*(\d+(?:\.\d+)?)\s*weeks?", text)
    if week_range:
        low = _to_number(week_range.group(1))
        high = _to_number(week_range.group(2))
        if isinstance(low, (int, float)) and isinstance(high, (int, float)):
            return horizon, round((low + high) / 2, 2)

    week_single = re.search(r"in\s*(\d+(?:\.\d+)?)\s*weeks?", text)
    if week_single:
        return horizon, _to_number(week_single.group(1))

    # If nothing parsed for weeks, keep horizon only.
    return horizon, None


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
                if _is_header_like_row(cols, headers):
                    continue
                if len(cols) < len(headers):
                    cols += [""] * (len(headers) - len(cols))
                rows.append(cols[: len(headers)])

            if rows:
                key_map = {
                    "llm name model": "llm_name_model",
                    "exchange symbol": "exchange_symbol",
                    "stock symbol": "stock_symbol",
                    "stock name": "stock_name",
                    "technical setup": "technical_setup",
                    "entry range": "entry_range",
                    "stop loss": "stop_loss",
                    "target": "target",
                    "analyst source": "analyst_source",
                    "units to buy": "units_to_buy",
                    "price per unit": "price_per_unit",
                    "total buy amount": "total_buy_amount",
                    "upside horizon percent return in weeks": "upside_horizon",
                    "upside horizon return in weeks": "upside_horizon",
                    "upside horizon": "upside_horizon",
                    "weeks": "weeks",
                    "confidence score 0 100": "confidence_score",
                    "confidence score": "confidence_score",
                    "rationale remarks": "rationale_remarks",
                    "rationale technical setup short term 1 3 months": "rationale_technical_short_term",
                    "rationale technical setup medium term": "rationale_technical_medium_term",
                    "rationale technical setup long term term": "rationale_technical_long_term",
                    "rationale technical setup long term": "rationale_technical_long_term",
                    "rationale fundamentals short term": "rationale_fundamentals_short_term",
                    "rationale fundamentals medium long term": "rationale_fundamentals_medium_long_term",
                }

                normalized_headers = [key_map.get(_normalize_header(h), _normalize_header(h).replace(" ", "_")) for h in headers]
                parsed_rows: list[dict[str, Any]] = []
                for row in rows:
                    item = {normalized_headers[i]: row[i] for i in range(len(normalized_headers))}
                    upside, weeks = _parse_upside_horizon_and_weeks(item.get("upside_horizon"))
                    if upside is not None:
                        item["upside_horizon"] = upside
                    if weeks is not None and not item.get("weeks"):
                        item["weeks"] = weeks
                    if _looks_like_data_row(item):
                        parsed_rows.append(item)
                if parsed_rows:
                    return parsed_rows
    except Exception:
        pass

    # Fallback: Parse single-line pipe table output
    try:
        line = " ".join(response_text.split())
        if "|" in line and "llm name + model" in line.lower():
            tokens = [token.strip() for token in line.split("|") if token.strip()]
            sep_idx = next((i for i, token in enumerate(tokens) if _is_separator_token(token)), -1)
            if sep_idx > 0:
                headers = tokens[:sep_idx]
                data_tokens = tokens[sep_idx:]
                while data_tokens and _is_separator_token(data_tokens[0]):
                    data_tokens.pop(0)

                key_map = {
                    "llm name model": "llm_name_model",
                    "exchange symbol": "exchange_symbol",
                    "stock symbol": "stock_symbol",
                    "stock name": "stock_name",
                    "technical setup": "technical_setup",
                    "entry range": "entry_range",
                    "stop loss": "stop_loss",
                    "target": "target",
                    "analyst source": "analyst_source",
                    "units to buy": "units_to_buy",
                    "price per unit": "price_per_unit",
                    "total buy amount": "total_buy_amount",
                    "upside horizon percent return in weeks": "upside_horizon",
                    "upside horizon return in weeks": "upside_horizon",
                    "upside horizon": "upside_horizon",
                    "weeks": "weeks",
                    "confidence score 0 100": "confidence_score",
                    "confidence score": "confidence_score",
                    "rationale remarks": "rationale_remarks",
                    "rationale technical setup short term 1 3 months": "rationale_technical_short_term",
                    "rationale technical setup medium term": "rationale_technical_medium_term",
                    "rationale technical setup long term term": "rationale_technical_long_term",
                    "rationale technical setup long term": "rationale_technical_long_term",
                    "rationale fundamentals short term": "rationale_fundamentals_short_term",
                    "rationale fundamentals medium long term": "rationale_fundamentals_medium_long_term",
                }
                normalized_headers = [key_map.get(_normalize_header(h), _normalize_header(h).replace(" ", "_")) for h in headers]
                n_cols = len(normalized_headers)
                rows = [data_tokens[i : i + n_cols] for i in range(0, len(data_tokens), n_cols) if len(data_tokens[i : i + n_cols]) == n_cols]
                parsed_rows: list[dict[str, Any]] = []
                for row in rows:
                    if _is_header_like_row(row, headers):
                        continue
                    item = {normalized_headers[i]: row[i] for i in range(n_cols)}
                    upside, weeks = _parse_upside_horizon_and_weeks(item.get("upside_horizon"))
                    if upside is not None:
                        item["upside_horizon"] = upside
                    if weeks is not None and not item.get("weeks"):
                        item["weeks"] = weeks
                    if _looks_like_data_row(item):
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


def format_stocks_for_sheet(stocks: list[dict[str, Any]]) -> tuple[list[str], list[list[Any]]]:
    """
    Format stock recommendations for Google Sheets export.
    Returns (headers, rows). Includes stage info if present in stock data.
    """
    # Include Stage column if any stock has stage info
    has_stage = any(stock.get("stage") is not None for stock in stocks)
    present_keys = {key for stock in stocks for key in stock.keys() if key != "stage"}

    preferred_key_order = [
        "llm_name_model",
        "exchange_symbol",
        "stock_symbol",
        "stock_name",
        "technical_setup",
        "entry_range",
        "stop_loss",
        "target",
        "analyst_source",
        "units_to_buy",
        "price_per_unit",
        "total_buy_amount",
        "upside_horizon",
        "weeks",
        "confidence_score",
        "rationale_remarks",
        "rationale_technical_short_term",
        "rationale_technical_medium_term",
        "rationale_technical_long_term",
        "rationale_fundamentals_short_term",
        "rationale_fundamentals_medium_long_term",
    ]

    header_labels = {
        "llm_name_model": "LLM Name + Model",
        "exchange_symbol": "Exchange Symbol",
        "stock_symbol": "Stock Symbol",
        "stock_name": "Stock Name",
        "technical_setup": "Technical Setup",
        "entry_range": "Entry Range",
        "stop_loss": "Stop Loss",
        "target": "Target",
        "analyst_source": "Analyst Source",
        "units_to_buy": "Units to Buy",
        "price_per_unit": "Price per Unit",
        "total_buy_amount": "Total Buy Amount",
        "upside_horizon": "Upside Horizon (%)",
        "weeks": "Weeks",
        "confidence_score": "Confidence Score (0-100)",
        "rationale_remarks": "Rationale Remarks",
        "rationale_technical_short_term": "Rationale - Technical Setup (Short Term 1-3 Months)",
        "rationale_technical_medium_term": "Rationale - Technical Setup (Medium Term)",
        "rationale_technical_long_term": "Rationale - Technical Setup (Long Term)",
        "rationale_fundamentals_short_term": "Rationale - Fundamentals Short Term",
        "rationale_fundamentals_medium_long_term": "Rationale - Fundamentals Medium/Long Term",
    }

    selected_keys = [key for key in preferred_key_order if key in present_keys]
    extra_keys = [key for key in sorted(present_keys) if key not in selected_keys]
    selected_keys.extend(extra_keys)

    headers = ["Stage"] if has_stage else []
    headers.extend(header_labels.get(key, key.replace("_", " ").title()) for key in selected_keys)

    numeric_keys = {
        "units_to_buy",
        "price_per_unit",
        "total_buy_amount",
        "upside_horizon",
        "weeks",
        "confidence_score",
    }

    rows: list[list[Any]] = []

    for stock in stocks:
        row_data = []
        if has_stage:
            row_data.append(str(stock.get("stage", "")).strip())

        for key in selected_keys:
            value = stock.get(key, "")
            if key in numeric_keys:
                parsed = _to_number(value)
                row_data.append(parsed if parsed is not None else "")
            else:
                row_data.append(str(value).strip())
        rows.append(row_data)

    return headers, rows
