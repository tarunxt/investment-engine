"""Conservative source adapter for new workflow-final calculations.

Ambiguous layouts fail closed. Original responses and client detail are never
rewritten. The accepted Markdown subset has the same cell positions in the UI.
"""
import re
import json
from pathlib import Path
import math
from decimal import Decimal, ROUND_HALF_UP

SETUP_DIRECTIONS = json.loads(Path(__file__).with_name("final_score_setups.json").read_text())

from app.domains.jobs.output_contracts.document import parse_markdown
from app.domains.jobs.output_contracts.schemas import REBALANCE_COLUMNS
from .final_score_math import ACTION_HEADER, normalize_action, numeric


class UnverifiableFinal(ValueError):
    pass


def derived_cell(value):
    # Match the UI's formatNormalizedNumber for derived local display cells.
    if not math.isfinite(value):
        raise UnverifiableFinal("Derived quantity exceeds finite arithmetic")
    if abs(value) >= 1e21:
        return str(float(value))
    if float(value).is_integer():
        return str(int(value))
    rounded = Decimal.from_float(float(value)).quantize(Decimal("0.0000000001"), rounding=ROUND_HALF_UP)
    if not rounded:
        return "0"
    return format(rounded, "f").rstrip("0").rstrip(".") if abs(rounded) >= Decimal("0.000001") else str(float(rounded))


def status(job):
    return str(getattr(job.status, "value", job.status)).lower()


def rebalance_rows(job):
    if status(job) not in {"completed", "partial"} or not job.response:
        return []
    if len(job.response) > 2_000_000:
        raise UnverifiableFinal("Source output exceeds final verification bound")
    blocks, findings = parse_markdown(job.response)
    tables = [block for block in blocks if block.kind == "table"]
    # The frontend's recommendation parser flattens pipe lines. More than one
    # table, empty cells, escaped pipes or links cannot be certified by this
    # positional subset, even where the preserving backend parser reads them.
    if any(block.kind == "text" and "|" in block.text for block in blocks) or len(tables) != 1 or findings or "\\|" in job.response or re.search(r"&(?:#\w+|[a-zA-Z]+);", job.response):
        raise UnverifiableFinal("Rebalance source table cannot be mapped without ambiguity")
    table = tables[0]
    if len(table.rows) > 500:
        raise UnverifiableFinal("Source output exceeds final listing bound")
    labels = {column.label for column in REBALANCE_COLUMNS}
    if (len(set(table.headers)) != len(table.headers) or ACTION_HEADER not in table.headers
            or not {"Exchange Symbol", "Stock Symbol"}.issubset(table.headers)
            or any(header not in labels for header in table.headers)):
        raise UnverifiableFinal("Rebalance source requires unambiguous canonical headers")
    result, identities = [], set()
    for cells in table.rows:
        if any(not isinstance(cell, str) or not cell.strip() for cell in cells):
            raise UnverifiableFinal("Blank source cells have ambiguous frontend positions")
        row = dict(zip(table.headers, cells))
        exchange, symbol = row["Exchange Symbol"], row["Stock Symbol"]
        # Prefix/suffix aliases and decorated symbols require an explicit
        # matching contract; do not silently merge source listing identities.
        if not re.fullmatch(r"[A-Z][A-Z0-9]*", exchange) or not re.fullmatch(r"[A-Z0-9&_.-]+", symbol) or re.search(r"\.(NS|BO|NSE|BSE)$", symbol):
            raise UnverifiableFinal("Rebalance source listing identity needs explicit mapping")
        setup = row.get("Technical Setup", "")
        if setup and (re.fullmatch(r"[-|_=:\s.]+", setup) or setup.strip().lower() == "technical setup"):
            raise UnverifiableFinal("Source row is excluded by the frontend parser and needs explicit review")
        key = (exchange, symbol)
        if key in identities:
            raise UnverifiableFinal("Duplicate source listing within one provider output")
        identities.add(key)
        action = normalize_action(row.get(ACTION_HEADER))
        if action is None:
            raise UnverifiableFinal("Rebalance source action is unavailable")
        row[ACTION_HEADER] = action
        current, change, final, buy = (numeric(row.get(key)) for key in ("Current Units", "Units Change", "Final Units", "Units to Buy"))
        change_changed = False
        # Mirror normalizeRebalanceDerivedCells on local copies only.
        if action == "Buy New" and current is None:
            current = 0
            row["Current Units"] = "0"
        if action == "Hold" and change is None:
            change = 0
            change_changed = True
        if action == "Sell All" and current is not None and change is None:
            change = -abs(current)
            change_changed = True
        if action in {"Add more", "Buy New"} and (change is None or change == 0) and current is not None and final is not None and final > current:
            change = final - current
            change_changed = True
        if action in {"Add more", "Buy New", "Trim"} and change is None and buy is not None:
            change = abs(buy) * (-1 if action == "Trim" else 1)
            change_changed = True
        if change_changed:
            row["Units Change"] = derived_cell(change)
        if not row.get("Units to Buy") and change is not None and change > 0:
            row["Units to Buy"] = derived_cell(change)
        result.append(row)
    return result


def technical_rows(job):
    if status(job) != "completed" or not job.response:
        return []
    if len(job.response) > 2_000_000:
        raise UnverifiableFinal("Source output exceeds final verification bound")
    blocks, findings = parse_markdown(job.response)
    tables = [block for block in blocks if block.kind == "table"]
    required = {"Exchange Symbol", "Stock Symbol", "Primary Setup", "Confidence Score"}
    if len(tables) != 1 or findings or not required.issubset(tables[0].headers):
        raise UnverifiableFinal("Technical source requires an unambiguous canonical table")
    table = tables[0]
    if len(set(table.headers)) != len(table.headers) or "\\|" in job.response or re.search(r"&(?:#\w+|[a-zA-Z]+);", job.response):
        raise UnverifiableFinal("Technical source headers/cells are ambiguous")
    result = []
    for cells in table.rows:
        row = dict(zip(table.headers, cells))
        if (row["Exchange Symbol"] not in {"NSE", "BSE", "NASDAQ", "NYSE", "NYSEARCA", "AMEX", "ARCA"}
                or not re.fullmatch(r"[A-Z0-9&_.-]+", row["Stock Symbol"])
                or re.search(r"\.(NS|BO|NSE|BSE)$", row["Stock Symbol"])):
            raise UnverifiableFinal("Technical source requires exact listing identities")
        # The supported subset has no inline formatting/citations or aliases.
        if any(re.search(r"[`\[\]【】]", cell) for cell in cells):
            raise UnverifiableFinal("Technical source requires explicit undecorated values")
        result.append(row)
    return result


def technical_direction(row, prompt):
    # Captured prompt registry is the exact approved set used by this workflow.
    from app.domains.recommendation_audit.technical import captured_setup_directions
    registry = captured_setup_directions(prompt)
    primary = row.get("Primary Setup", "").strip().casefold()
    direction = registry.get(primary)
    if direction is None or direction != next((value for name, value in SETUP_DIRECTIONS.items() if name.casefold() == primary), None):
        raise UnverifiableFinal("Technical primary setup has no exact captured approved direction")
    return direction
