"""Settled Zerodha positions from the workflow's immutable Stage 3 prompt."""
import math
import re
from datetime import datetime

from .final_source_rows import UnverifiableFinal

POSITION_POLICY = "zerodha-settled-snapshot-v1"


def captured_positions(prompt):
    marker = re.search(r"^\[THREAT_CAPTURED_AT=([^\]]+)\]$", prompt, re.M)
    count = re.search(r"^- Holdings count: (\d+)$", prompt, re.M)
    table = re.search(r"^Portfolio holdings table:\n((?:\|[^\n]+\|(?:\n|$))+)", prompt, re.M)
    if not (marker and count and table):
        raise UnverifiableFinal("Frozen Zerodha holdings table or capture time missing")
    try:
        captured = marker[1]
        if datetime.fromisoformat(captured).tzinfo is None:
            raise ValueError
        lines = [[cell.strip() for cell in line.strip("|").split("|")] for line in table[1].splitlines()]
        header = lines[0]
        positions = {}
        for cells in lines[2:]:
            row = dict(zip(header, cells, strict=True))
            key = (row["Exchange"].upper(), row["Stock Symbol"].upper())
            units = int(row["Settled Units"])
            price = float(row["Live Price"].replace(",", ""))
            if not all(key) or key in positions or units < 0 or not math.isfinite(price) or price < 0:
                raise ValueError
            positions[key] = (units, price if price > 0 else None)
        if len(positions) != int(count[1]):
            raise ValueError
    except (KeyError, ValueError) as exc:
        raise UnverifiableFinal("Incomplete or ambiguous frozen Zerodha holding") from exc
    return captured, positions
