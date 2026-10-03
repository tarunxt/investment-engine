"""Conservative field validation and explicitly permitted arithmetic only."""

import math
import re
from decimal import Decimal, InvalidOperation, localcontext
from typing import Any, Mapping, Sequence

from .document import MISSING
from .schemas import Column, Finding, METADATA_KEYS, NUMERIC_KEYS, Provenance, SCORE_KEYS

_UNKNOWN = frozenset({"", "null", "none", "unknown", "n/a", "na", "not found", "-", "—", "tbd"})
_NUMBER = re.compile(r"^[+-]?(?:(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$")


def unknown(value: Any) -> bool:
    return value is MISSING or value is None or isinstance(value, str) and value.strip().lower() in _UNKNOWN


def number(value: Any) -> Decimal | None:
    """No booleans, units, currencies, arbitrary letters, infinity or NaN."""
    if isinstance(value, bool) or unknown(value):
        return None
    if isinstance(value, (int, float, Decimal)):
        text = str(value)
    elif isinstance(value, str) and _NUMBER.fullmatch(value.strip()):
        text = value.strip().replace(",", "")
    else:
        return None
    try:
        result = Decimal(text)
    except InvalidOperation:
        return None
    if not result.is_finite():
        return None
    # The surrounding export pipeline uses ordinary finite numeric cells. Refuse
    # values that overflow/underflow that domain instead of silently changing them.
    try:
        finite_value = float(result)
    except (OverflowError, ValueError):
        return None
    if not math.isfinite(finite_value) or finite_value == 0 and result != 0:
        return None
    return Decimal(0) if result == 0 else result


def _sum(left: Decimal, right: Decimal) -> Decimal:
    with localcontext() as context:
        context.prec = max(len(left.as_tuple().digits), len(right.as_tuple().digits)) + abs(left.adjusted() - right.adjusted()) + 2
        return left + right


def _product(left: Decimal, right: Decimal) -> Decimal:
    with localcontext() as context:
        context.prec = len(left.as_tuple().digits) + len(right.as_tuple().digits) + 2
        return left * right


def header_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.lower().replace("%", " percent ").replace("+", " plus ")).strip()


def aliases(columns: Sequence[Column]) -> dict[str, str]:
    result = {header_key(c.label): c.key for c in columns}
    result.update({header_key(c.key): c.key for c in columns})
    result.update({
        "rationale remarks": "rationale_remarks", "score rationale remarks": "score_rationale_cruxx",
        "llm name model": "llm_name_model", "run number": "run_number", "run": "run_number",
        "analyst source": "analyst_source", "upside horizon percent": "upside_horizon",
        "upside horizon percent return": "upside_horizon", "confidence score": "confidence_score",
        "rationale technical setup long term term": "rationale_technical_long_term",
        "currency": "currency", "currency code": "currency",
    })
    return result


def identity(row: Mapping[str, Any]) -> tuple[str, str] | None:
    exchange, symbol = row.get("exchange_symbol"), row.get("stock_symbol")
    if not isinstance(exchange, str) or not isinstance(symbol, str) or unknown(exchange) or unknown(symbol):
        return None
    return exchange.strip().upper(), symbol.strip().upper()


def holding_identity(row: Mapping[str, Any], holdings: Mapping[tuple[str, str], Mapping[str, Any]]) -> tuple[str, str] | None:
    """Match INDmoney's explicit US market identity without inventing its venue.

    That snapshot supplies Exchange=US, not the listing venue. Match a known US
    venue only when the snapshot has one unambiguous market-scoped symbol.
    Concrete exchange identities in other snapshots remain exact.
    """
    key = identity(row)
    if key is None or key in holdings:
        return key
    if key[0] in {"NASDAQ", "NYSE", "NYSEARCA", "NYSEAMERICAN", "AMEX"}:
        market_key = ("US", key[1])
        same_symbol = [item for item in holdings if item[1] == key[1]]
        if same_symbol == [market_key]:
            return market_key
    return key


def prepare_holdings(holdings: Sequence[Mapping[str, Any]] | None) -> tuple[dict[tuple[str, str], Mapping[str, Any]], list[Finding]]:
    result: dict[tuple[str, str], Mapping[str, Any]] = {}
    findings: list[Finding] = []
    if holdings is None:
        return result, [Finding("missing_snapshot", "Authoritative holdings snapshot is required (use [] only for a verified empty portfolio).")]
    for holding in holdings:
        if not isinstance(holding, Mapping):
            findings.append(Finding("invalid_holding", "Snapshot holding must be an object."))
            continue
        key = identity(holding)
        units = number(holding.get("current_units"))
        if key is None or units is None or units < 0:
            findings.append(Finding("invalid_holding", "Snapshot requires exchange, symbol and finite nonnegative current_units."))
            continue
        if key in result:
            findings.append(Finding("duplicate_holding", f"Ambiguous repeated snapshot identity {key[0]}:{key[1]}."))
        else:
            result[key] = holding
    for exchange, symbol in result:
        if exchange == "US" and sum(key[1] == symbol for key in result) > 1:
            findings.append(Finding("ambiguous_holding", f"Market-scoped US symbol {symbol} also has a venue-specific snapshot entry."))
    return result, findings


def validate_row(
    source_values: Mapping[str, Any], columns: Sequence[Column], source: Provenance,
    metadata: Mapping[str, Any], holdings: Mapping[tuple[str, str], Mapping[str, Any]],
    kind: str, *, derive_arithmetic: bool,
) -> tuple[dict[str, Any], tuple[str, ...], list[Finding]]:
    row = dict(source_values)
    findings: list[Finding] = []
    filled: list[str] = []

    def error(code: str, message: str, field: str | None = None) -> None:
        findings.append(Finding(code, message, source=source, field=field))

    def fill(key: str, value: Any, reason: str) -> None:
        row[key] = value
        filled.append(key)
        findings.append(Finding("authoritative_fill", reason, "info", source, key))

    for key in METADATA_KEYS.intersection(c.key for c in columns):
        # Explicit null/unknown stays unknown. Only absent or empty metadata is filled.
        if (row.get(key, MISSING) is MISSING or row.get(key) == "") and key in metadata:
            fill(key, metadata[key], "Filled from caller-supplied run/model/time metadata.")
    key = holding_identity(row, holdings)
    holding = holdings.get(key) if key is not None else None
    if kind == "rebalance" and holding is not None:
        if row.get("current_units", MISSING) is MISSING or row.get("current_units") == "":
            fill("current_units", holding["current_units"], "Copied current units from the supplied snapshot.")
        elif number(row.get("current_units")) != number(holding["current_units"]):
            error("holding_units_mismatch", "Current units contradict the supplied snapshot.", "current_units")
        if "currency" in holding and "currency" in row and row["currency"] != holding["currency"]:
            error("currency_mismatch", "Row currency contradicts the supplied snapshot.", "currency")
    if kind == "rebalance" and derive_arithmetic:
        current, delta = number(row.get("current_units")), number(row.get("units_change"))
        # Do not infer signed quantities, action labels or missing zeroes from actions.
        if row.get("final_units", MISSING) is MISSING or row.get("final_units") == "":
            if current is not None and delta is not None:
                fill("final_units", str(_sum(current, delta)), "Computed Final Units = Current Units + Units Change.")

    for column in columns:
        field, value = column.key, row.get(column.key, MISSING)
        if unknown(value):
            error("required_field_unknown", f"Required field {column.label!r} is missing or unknown.", field)
            continue
        if field in NUMERIC_KEYS:
            numeric = number(value)
            if numeric is None:
                error("invalid_number", f"{column.label} must be finite numeric-only data; booleans are invalid.", field)
            elif field in SCORE_KEYS:
                if isinstance(value, float) or not re.fullmatch(r"[+-]?[0-3]", str(value).strip()):
                    error("invalid_rationale_score", "Rationale scores must be one of the seven integers -3 through 3.", field)
            elif field == "confidence_score" and not 0 <= numeric <= 100:
                error("invalid_confidence", "Confidence must be between 0 and 100.", field)
            elif field not in {"upside_horizon", "units_change"} and numeric < 0:
                error("negative_value", f"{column.label} cannot be negative.", field)
        elif field == "entry_range":
            if number(value) is not None:
                if number(value) < 0:
                    error("invalid_entry", "Entry price cannot be negative.", field)
            elif isinstance(value, str):
                parts = re.split(r"\s*[–-]\s*", value.strip())
                prices = [number(part) for part in parts]
                if len(prices) != 2 or any(p is None or p < 0 for p in prices) or prices[0] > prices[1]:
                    error("invalid_entry", "Entry must be an explicit nonnegative price or ordered price range.", field)
            else:
                error("invalid_entry", "Entry must be a price or price range.", field)
        elif field == "run_number":
            numeric = number(value)
            if numeric is None or numeric < 0 or numeric != numeric.to_integral_value():
                error("invalid_run_number", "Run number must be a nonnegative integer.", field)
        elif not isinstance(value, str):
            error("invalid_text", f"{column.label} must contain supplied text.", field)

    for field, value in row.items():
        if isinstance(value, (dict, list, tuple)) or isinstance(value, float) and not math.isfinite(value):
            error("unsupported_cell", "Structured or non-finite cells require the original document; they cannot be safely flattened.", field)
    amount, price, buy = (number(row.get(key)) for key in ("total_buy_amount", "price_per_unit", "units_to_buy"))
    if amount is not None and price is not None and buy is not None and _sum(amount, _product(buy, price).copy_negate()).copy_abs() > Decimal("0.005"):
        error("amount_arithmetic", "Total Buy Amount contradicts Units to Buy × Price per Unit at currency-cent precision.", "total_buy_amount")
    if kind == "rebalance":
        _validate_action(row, holding, error)
    return row, tuple(filled), findings


def _validate_action(row: Mapping[str, Any], holding: Mapping[str, Any] | None, error: Any) -> None:
    action = row.get("action")
    allowed = {"Buy", "Add", "Buy/Add", "Add more", "Buy New", "Sell All", "Trim", "Hold"}
    if not isinstance(action, str) or action not in allowed:
        error("invalid_action", "Action must be an explicit supported decision label.", "action")
        return
    if holding is None and action != "Buy New":
        error("holding_not_in_snapshot", "Existing-position decision has no exact exchange/symbol match in the snapshot.", "current_units")
    if holding is not None and action == "Buy New":
        error("buy_new_existing_holding", "Buy New contradicts an existing snapshot holding.", "action")
    numbers = {key: number(row.get(key)) for key in ("current_units", "units_change", "final_units", "units_to_buy")}
    if any(value is None for value in numbers.values()):
        return
    current, delta, final, buy = (numbers[key] for key in numbers)
    if final != _sum(current, delta):
        error("unit_arithmetic", "Final Units must equal Current Units + Units Change.", "final_units")
    if action in {"Buy", "Add", "Buy/Add", "Add more", "Buy New"}:
        if delta <= 0 or buy != delta:
            error("action_units", "Buy/Add requires positive Units Change equal to Units to Buy.", "units_change")
        if action == "Buy New" and current != 0:
            error("action_units", "Buy New requires explicit zero Current Units.", "current_units")
    elif action == "Hold" and (delta != 0 or final != current or buy != 0):
        error("action_units", "Hold requires zero unit change/buy quantity and unchanged final units.", "units_change")
    elif action == "Sell All" and (delta != current.copy_negate() or current <= 0 or final != 0 or buy != 0):
        error("action_units", "Sell All requires selling all positive current units, zero final units and zero buy quantity.", "units_change")
    elif action == "Trim" and (delta >= 0 or final <= 0 or final >= current or buy != 0):
        error("action_units", "Trim requires a negative change, a remaining positive position and zero buy quantity.", "units_change")
