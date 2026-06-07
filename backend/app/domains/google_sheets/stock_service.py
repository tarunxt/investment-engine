import json
import logging
import re
from datetime import datetime
from typing import Any, cast

import json5

logger = logging.getLogger(__name__)

KEY_MAP = {
    "llm name model": "llm_name_model",
    "llm name plus model": "llm_name_model",
    "exchange symbol": "exchange_symbol",
    "stock symbol": "stock_symbol",
    "current units": "current_units",
    "action buy add sell all trim hold buy new": "action",
    "action": "action",
    "units change": "units_change",
    "final units": "final_units",
    "stock name": "stock_name",
    "technical setup": "technical_setup",
    "entry range": "entry_range",
    "stop loss": "stop_loss",
    "stop loss inr": "stop_loss",
    "target": "target",
    "target inr": "target",
    "analyst source": "analyst_source",
    "analyst/source": "analyst_source",
    "analyst": "analyst_source",
    "units to buy": "units_to_buy",
    "price per unit": "price_per_unit",
    "price per unit inr": "price_per_unit",
    "total buy amount": "total_buy_amount",
    "total buy amount inr": "total_buy_amount",
    "upside horizon percent return in weeks": "upside_horizon",
    "upside horizon percent return": "upside_horizon",
    "upside horizon return in weeks": "upside_horizon",
    "upside horizon return": "upside_horizon",
    "upside horizon percent": "upside_horizon",
    "upside horizon": "upside_horizon",
    "weeks": "weeks",
    "confidence score 0 100": "confidence_score",
    "confidence score": "confidence_score",
    "rationale remarks": "rationale_remarks",
    "rationale cruxx": "rationale_remarks",
    "score rationale remarks": "score_rationale_cruxx",
    "score rationale cruxx": "score_rationale_cruxx",
    "rationale technical setup short term 1 3 months": "rationale_technical_short_term",
    "score rationale technical setup short term 1 3 months": "score_rationale_technical_short_term",
    "rationale technical setup medium term": "rationale_technical_medium_term",
    "score rationale technical setup medium term": "score_rationale_technical_medium_term",
    "rationale technical setup long term term": "rationale_technical_long_term",
    "rationale technical setup long term": "rationale_technical_long_term",
    "score rationale technical setup long term": "score_rationale_technical_long_term",
    "rationale fundamentals short term": "rationale_fundamentals_short_term",
    "score rationale fundamentals short term": "score_rationale_fundamentals_short_term",
    "rationale fundamentals medium long term": "rationale_fundamentals_medium_long_term",
    "score rationale fundamentals medium long term": "score_rationale_fundamentals_medium_long_term",
    "run #": "run_number",
    "run number": "run_number",
    "run date": "run_date",
    "run time": "run_time",
}

HEADERLESS_CANONICAL_KEYS = [
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
    "score_rationale_cruxx",
    "rationale_technical_medium_term",
    "score_rationale_technical_medium_term",
    "rationale_technical_long_term",
    "score_rationale_technical_long_term",
    "rationale_fundamentals_short_term",
    "score_rationale_fundamentals_short_term",
    "rationale_fundamentals_medium_long_term",
    "score_rationale_fundamentals_medium_long_term",
    "rationale_technical_short_term",
    "score_rationale_technical_short_term",
    "run_number",
    "run_date",
    "run_time",
]

HEADERLESS_CANONICAL_KEYS_WITH_LLM = [
    *HEADERLESS_CANONICAL_KEYS,
    "llm",
]

HEADERLESS_CANONICAL_KEYS_DEEPSEEK_CODER = [
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
    "score_rationale_cruxx",
    "rationale_technical_medium_term",
    "rationale_fundamentals_short_term",
    "score_rationale_fundamentals_short_term",
    "rationale_fundamentals_medium_long_term",
    "score_rationale_fundamentals_medium_long_term",
    "rationale_technical_short_term",
    "score_rationale_technical_short_term",
    "run_number",
    "run_date",
    "run_time",
]

HEADERLESS_CANONICAL_KEYS_DEEPSEEK_CODER_WITH_LLM = [
    *HEADERLESS_CANONICAL_KEYS_DEEPSEEK_CODER,
    "llm",
]


HEADERLESS_CANONICAL_KEYS_LEGACY = [
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
    "rationale_technical_medium_term",
    "rationale_technical_long_term",
    "rationale_fundamentals_short_term",
    "rationale_fundamentals_medium_long_term",
    "rationale_technical_short_term",
    "run_number",
    "run_date",
    "run_time",
]

HEADERLESS_CANONICAL_KEYS_LEGACY_WITH_LLM = [
    *HEADERLESS_CANONICAL_KEYS_LEGACY,
    "llm",
]

HEADERLESS_CANONICAL_KEYS_DEEPSEEK_CODER_LEGACY = [
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
    "rationale_technical_medium_term",
    "rationale_fundamentals_short_term",
    "rationale_fundamentals_medium_long_term",
    "rationale_technical_short_term",
    "run_number",
    "run_date",
    "run_time",
]

HEADERLESS_CANONICAL_KEYS_DEEPSEEK_CODER_LEGACY_WITH_LLM = [
    *HEADERLESS_CANONICAL_KEYS_DEEPSEEK_CODER_LEGACY,
    "llm",
]

HEADERLESS_CANONICAL_KEY_VARIANTS = (
    HEADERLESS_CANONICAL_KEYS_WITH_LLM,
    HEADERLESS_CANONICAL_KEYS,
    HEADERLESS_CANONICAL_KEYS_LEGACY_WITH_LLM,
    HEADERLESS_CANONICAL_KEYS_LEGACY,
    HEADERLESS_CANONICAL_KEYS_DEEPSEEK_CODER_WITH_LLM,
    HEADERLESS_CANONICAL_KEYS_DEEPSEEK_CODER,
    HEADERLESS_CANONICAL_KEYS_DEEPSEEK_CODER_LEGACY_WITH_LLM,
    HEADERLESS_CANONICAL_KEYS_DEEPSEEK_CODER_LEGACY,
)

STOCK_SHEET_KEY_ORDER = [
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
    "score_rationale_cruxx",
    "rationale_technical_medium_term",
    "score_rationale_technical_medium_term",
    "rationale_technical_long_term",
    "score_rationale_technical_long_term",
    "rationale_fundamentals_short_term",
    "score_rationale_fundamentals_short_term",
    "rationale_fundamentals_medium_long_term",
    "score_rationale_fundamentals_medium_long_term",
    "rationale_technical_short_term",
    "score_rationale_technical_short_term",
]

REBALANCE_SHEET_KEY_ORDER = [
    "exchange_symbol",
    "stock_symbol",
    "current_units",
    "action",
    "units_change",
    "final_units",
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
    "score_rationale_cruxx",
    "rationale_technical_short_term",
    "score_rationale_technical_short_term",
    "rationale_technical_medium_term",
    "score_rationale_technical_medium_term",
    "rationale_technical_long_term",
    "score_rationale_technical_long_term",
    "rationale_fundamentals_short_term",
    "score_rationale_fundamentals_short_term",
    "rationale_fundamentals_medium_long_term",
    "score_rationale_fundamentals_medium_long_term",
]
STOCK_SHEET_NUMERIC_KEYS = {
    "current_units",
    "units_change",
    "final_units",
    "units_to_buy",
    "price_per_unit",
    "total_buy_amount",
    "upside_horizon",
    "weeks",
    "confidence_score",
    "score_rationale_cruxx",
    "score_rationale_technical_short_term",
    "score_rationale_technical_medium_term",
    "score_rationale_technical_long_term",
    "score_rationale_fundamentals_short_term",
    "score_rationale_fundamentals_medium_long_term",
}


def _normalize_header(value: str) -> str:
    cleaned = (
        value.replace("’", "'")
        .replace("%", " percent ")
        .replace("+", " plus ")
        .replace("/", " ")
        .replace("-", " ")
        .replace("–", " ")
        .replace("—", " ")
        .replace("(", " ")
        .replace(")", " ")
    )
    return " ".join(cleaned.lower().split())


def _is_separator_token(value: str) -> bool:
    stripped = value.replace(":", "").replace("-", "").strip()
    return stripped == ""


def _looks_like_stock_table_header_tokens(tokens: list[str]) -> bool:
    normalized = [_normalize_header(t) for t in tokens]
    required_markers = {"stock symbol", "stock name", "entry range"}
    optional_markers = {"llm name model", "llm name plus model", "technical setup", "units to buy"}
    marker_hits = set()
    for token in normalized:
        if token in required_markers or token in optional_markers:
            marker_hits.add(token)
    # Require at least core markers + one extra table marker.
    return (
        len(required_markers.intersection(marker_hits)) >= 2
        and len(marker_hits) >= 3
    )


def _is_header_like_row(row: list[str], headers: list[str]) -> bool:
    if not row or not headers:
        return False
    normalized_row = [_normalize_header(v) for v in row]
    normalized_headers = [_normalize_header(v) for v in headers]
    matches = sum(1 for i in range(min(len(normalized_row), len(normalized_headers))) if normalized_row[i] == normalized_headers[i])
    return matches >= max(3, len(normalized_headers) // 2)


def _looks_like_data_row(item: dict[str, Any]) -> bool:
    symbol = str(item.get("stock_symbol", "")).strip()
    exchange_symbol = str(item.get("exchange_symbol", "")).strip()
    name = str(item.get("stock_name", "")).strip()
    technical = str(item.get("technical_setup", "")).strip()
    # Avoid accepting duplicated header/separator rows as data.
    if _normalize_header(symbol) == "stock_symbol":
        return False
    if _normalize_header(name) in {"stock_name", "stock_symbol"}:
        return False
    if technical and set(technical.replace("-", "").replace(" ", "")) == set():
        return False
    return bool(symbol or exchange_symbol or name)


def _looks_like_headerless_canonical_row(tokens: list[str], keys: list[str]) -> bool:
    if len(tokens) != len(keys):
        return False

    exchange_symbol = tokens[keys.index("exchange_symbol")].strip().upper()
    stock_symbol = tokens[keys.index("stock_symbol")].strip()
    stock_name = tokens[keys.index("stock_name")].strip()
    entry_range = tokens[keys.index("entry_range")].strip()
    run_date = tokens[keys.index("run_date")].strip()
    run_time = tokens[keys.index("run_time")].strip()

    if exchange_symbol not in {"NSE", "BSE"}:
        return False
    if not stock_symbol or len(stock_symbol) > 20:
        return False
    if not stock_name:
        return False
    if not re.search(r"\d", entry_range):
        return False
    if not run_date or not re.search(r"\d{2,4}", run_date):
        return False
    if not run_time or ":" not in run_time:
        return False

    numeric_hits = sum(
        1
        for field in (
            "units_to_buy",
            "price_per_unit",
            "total_buy_amount",
            "upside_horizon",
            "weeks",
            "confidence_score",
        )
        if _to_number(tokens[keys.index(field)]) is not None
    )
    return numeric_hits >= 5


def _parse_headerless_canonical_items(tokens: list[str]) -> list[dict[str, str]]:
    for keys in HEADERLESS_CANONICAL_KEY_VARIANTS:
        if len(tokens) < len(keys) or len(tokens) % len(keys) != 0:
            continue

        items: list[dict[str, str]] = []
        for offset in range(0, len(tokens), len(keys)):
            chunk = tokens[offset : offset + len(keys)]
            if not _looks_like_headerless_canonical_row(chunk, keys):
                items = []
                break
            items.append({keys[i]: chunk[i] for i in range(len(keys))})

        if items:
            return items

    return []


def normalize_stock_rows(stocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Normalize keys and drop non-stock/preamble rows before Sheet export."""
    normalized: list[dict[str, Any]] = []
    for stock in stocks:
        item: dict[str, Any] = {}
        for key, value in stock.items():
            canonical_key = KEY_MAP.get(_normalize_header(str(key)), _normalize_header(str(key)).replace(" ", "_"))
            item[canonical_key] = value

        llm_name_model = str(item.get("llm_name_model", "")).strip().lower()
        if llm_name_model in {"llm name + model", "llm name model"}:
            item["llm_name_model"] = ""

        # Preamble rows usually have no stock identity and no entry details.
        if not _looks_like_data_row(item):
            continue
        if not str(item.get("entry_range", "")).strip() and not str(item.get("technical_setup", "")).strip():
            continue

        upside, weeks = _parse_upside_horizon_and_weeks(item.get("upside_horizon"))
        if upside is not None:
            item["upside_horizon"] = upside
        if weeks is not None and not item.get("weeks"):
            item["weeks"] = weeks

        normalized.append(item)
    return normalized


def _is_rebalance_row(stock: dict[str, Any]) -> bool:
    return bool(
        str(stock.get("action", "")).strip()
        or str(stock.get("current_units", "")).strip()
        or str(stock.get("final_units", "")).strip()
        or str(stock.get("units_change", "")).strip()
    )


def _required_keys_for_row(stock: dict[str, Any]) -> list[str]:
    return REBALANCE_SHEET_KEY_ORDER if _is_rebalance_row(stock) else STOCK_SHEET_KEY_ORDER


def is_complete_stock_row(stock: dict[str, Any]) -> bool:
    """Return True when every export column is populated with a usable value."""
    for key in _required_keys_for_row(stock):
        value = stock.get(key)
        if key.startswith("score_rationale_") and not str(value or "").strip():
            # Backward compatibility: older completed runs did not include adjacent rationale score columns.
            continue
        if key in STOCK_SHEET_NUMERIC_KEYS:
            if _to_number(value) is None:
                return False
        elif not str(value or "").strip():
            return False
    return True


def filter_complete_stock_rows(stocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Normalize rows, require all export columns, and dedupe by stock symbol."""
    complete_rows: list[dict[str, Any]] = []
    seen_symbols: set[str] = set()

    for stock in normalize_stock_rows(stocks):
        symbol = str(stock.get("stock_symbol", "")).strip().upper()
        if symbol and symbol in seen_symbols:
            continue
        if not is_complete_stock_row(stock):
            continue
        complete_rows.append(stock)
        if symbol:
            seen_symbols.add(symbol)

    return complete_rows


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
        table_lines = [line for line in lines if line.count("|") >= 3 and not line.lstrip().startswith("#")]
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
                normalized_headers = [KEY_MAP.get(_normalize_header(h), _normalize_header(h).replace(" ", "_")) for h in headers]
                parsed_rows: list[dict[str, Any]] = []
                for row in rows:
                    item = {normalized_headers[i]: row[i] for i in range(len(normalized_headers))}
                    parsed_rows.extend(normalize_stock_rows([item]))
                if parsed_rows:
                    return parsed_rows
    except Exception:
        pass

    # Fallback: Parse single-line pipe table output
    try:
        line = " ".join(response_text.split())
        if "|" in line:
            tokens = [token.strip() for token in line.split("|") if token.strip()]
            if len(tokens) >= 10 and _looks_like_stock_table_header_tokens(tokens[:16]):
                sep_idx = next((i for i, token in enumerate(tokens) if _is_separator_token(token)), -1)
                if sep_idx > 0:
                    headers = tokens[:sep_idx]
                    data_tokens = tokens[sep_idx:]
                    while data_tokens and _is_separator_token(data_tokens[0]):
                        data_tokens.pop(0)

                    normalized_headers = [KEY_MAP.get(_normalize_header(h), _normalize_header(h).replace(" ", "_")) for h in headers]
                    n_cols = len(normalized_headers)
                    rows = [data_tokens[i : i + n_cols] for i in range(0, len(data_tokens), n_cols) if len(data_tokens[i : i + n_cols]) == n_cols]
                    parsed_rows: list[dict[str, Any]] = []
                    for row in rows:
                        if _is_header_like_row(row, headers):
                            continue
                        item = {normalized_headers[i]: row[i] for i in range(n_cols)}
                        parsed_rows.extend(normalize_stock_rows([item]))
                    if parsed_rows:
                        return parsed_rows
    except Exception:
        pass

    # Fallback: Parse headerless pipe rows already emitted in canonical column order
    try:
        parsed_rows = []
        for line in [line.strip() for line in response_text.splitlines() if line.strip()]:
            if line.count("|") < min(len(keys) for keys in HEADERLESS_CANONICAL_KEY_VARIANTS) - 2:
                continue
            tokens = [token.strip() for token in line.strip("|").split("|")]
            if len(tokens) < min(len(keys) for keys in HEADERLESS_CANONICAL_KEY_VARIANTS):
                continue

            for item in _parse_headerless_canonical_items(tokens):
                parsed_rows.extend(normalize_stock_rows([item]))
        if parsed_rows:
            return parsed_rows
    except Exception:
        pass

    logger.warning("Could not parse stock recommendations from response")
    return []


def parse_complete_stock_recommendations(response_text: str) -> list[dict[str, Any]]:
    """Parse AI output and keep only complete, export-ready stock rows."""
    return filter_complete_stock_rows(parse_stock_recommendations(response_text))


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

    reserved_metadata_keys = {"run_number", "run_date", "run_time", "llm"}

    header_labels = {
        "llm_name_model": "LLM Name + Model",
        "exchange_symbol": "Exchange Symbol",
        "stock_symbol": "Stock Symbol",
        "stock_name": "Stock Name",
        "current_units": "Current Units",
        "action": "Action (Buy/Add/Sell All/Trim/Hold/Buy New)",
        "units_change": "Units Change",
        "final_units": "Final Units",
        "technical_setup": "Technical Setup",
        "entry_range": "Entry Range",
        "stop_loss": "Stop Loss",
        "target": "Target",
        "analyst_source": "Analyst/Source",
        "units_to_buy": "Units to Buy",
        "price_per_unit": "Price Per Unit",
        "total_buy_amount": "Total Buy Amount",
        "upside_horizon": "Upside Horizon (% return)",
        "weeks": "Weeks",
        "confidence_score": "Confidence Score (0-100)",
        "rationale_remarks": "Rationale Cruxx",
        "score_rationale_cruxx": "Score Rationale Cruxx",
        "rationale_technical_short_term": "Rationale Technical Setup Short Term 1–3 Months",
        "score_rationale_technical_short_term": "Score Rationale Technical Setup Short Term 1–3 Months",
        "rationale_technical_medium_term": "Rationale - Technical Setup (Medium Term)",
        "score_rationale_technical_medium_term": "Score Rationale - Technical Setup (Medium Term)",
        "rationale_technical_long_term": "Rationale - Technical Setup (Long Term)",
        "score_rationale_technical_long_term": "Score Rationale - Technical Setup (Long Term)",
        "rationale_fundamentals_short_term": "Rationale - Fundamentals Short Term",
        "score_rationale_fundamentals_short_term": "Score Rationale - Fundamentals Short Term",
        "rationale_fundamentals_medium_long_term": "Rationale - Fundamentals Medium/Long Term",
        "score_rationale_fundamentals_medium_long_term": "Score Rationale - Fundamentals Medium/Long Term",
        "run_number": "Run #",
        "run_date": "Run Date",
        "run_time": "Run Time",
    }

    # Keep a stable, exact column sequence across all exports.
    # Missing fields are exported as blank cells rather than dropping headers.
    is_rebalance_export = any(_is_rebalance_row(stock) for stock in stocks)
    if not is_rebalance_export:
        header_labels.update({
            "analyst_source": "Analyst Source",
            "price_per_unit": "Price per Unit",
            "upside_horizon": "Upside Horizon (%)",
            "rationale_technical_short_term": "Rationale Technical Setup Short Term 1–3 Months",
            "rationale_technical_medium_term": "Rationale - Technical Setup (Medium Term)",
            "rationale_technical_long_term": "Rationale - Technical Setup (Long Term)",
            "rationale_fundamentals_short_term": "Rationale - Fundamentals Short Term",
        })
    base_key_order = REBALANCE_SHEET_KEY_ORDER if is_rebalance_export else STOCK_SHEET_KEY_ORDER
    selected_keys = list(base_key_order)
    extra_keys = [
        key for key in sorted(present_keys) if key not in selected_keys and key not in reserved_metadata_keys
    ]
    selected_keys.extend(extra_keys)

    headers = ["Stage"] if has_stage else []
    headers.extend(header_labels.get(key, key.replace("_", " ").title()) for key in selected_keys)

    rows: list[list[Any]] = []

    for stock in stocks:
        row_data = []
        if has_stage:
            row_data.append(str(stock.get("stage", "")).strip())

        for key in selected_keys:
            value = stock.get(key, "")
            if key in STOCK_SHEET_NUMERIC_KEYS:
                parsed = _to_number(value)
                row_data.append(parsed if parsed is not None else "")
            else:
                row_data.append(str(value).strip())
        rows.append(row_data)

    return headers, rows
