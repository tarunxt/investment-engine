"""Bounded, offline-testable Cost Explorer normalization (account scope only)."""
from decimal import Decimal
from typing import Any

MAX_PAGES_PER_QUERY = 10


def collect_query(client: Any, request: dict, meter: dict) -> tuple[list[dict], dict]:
    results, seen_tokens, seen_rows = [], set(), set()
    coverage = {"pagesReceived": 0, "complete": False, "reason": None}
    token = None
    for _ in range(MAX_PAGES_PER_QUERY):
        meter["requests"] += 1  # includes failed requests; SDK retries disabled
        try:
            response = client.get_cost_and_usage(**request, **({"NextPageToken": token} if token else {}))
        except Exception as exc:
            coverage["reason"] = type(exc).__name__
            break
        coverage["pagesReceived"] += 1
        for window in response.get("ResultsByTime", []):
            row = dict(window)
            groups = []
            for group in row.get("Groups", []):
                identity = (str(row.get("TimePeriod")), tuple(group["Keys"]))
                if identity in seen_rows:
                    coverage["reason"] = "duplicate_group"
                    continue
                seen_rows.add(identity)
                groups.append(group)
            row["Groups"] = groups
            # Daily totals can also be repeated by a broken provider page.
            if not window.get("Groups"):
                identity = (str(row.get("TimePeriod")), "total")
                if identity in seen_rows:
                    coverage["reason"] = "duplicate_total"
                    continue
                seen_rows.add(identity)
            results.append(row)
        token = response.get("NextPageToken")
        if not token:
            coverage["complete"] = coverage["reason"] is None
            break
        if token in seen_tokens:
            coverage["reason"] = "repeated_token"
            break
        seen_tokens.add(token)
    else:
        coverage["reason"] = "page_cap"
    return results, coverage


def amount(metric: dict) -> Decimal:
    value = Decimal(metric["Amount"])
    if not value.is_finite():
        raise ValueError("Nonfinite billing amount")
    return value


def grouped_rows(windows: list[dict], currencies: set[str]) -> list[dict]:
    aggregates = {}
    for window in windows:
        for group in window.get("Groups", []):
            metrics = group["Metrics"]
            cost, usage = metrics["UnblendedCost"], metrics["UsageQuantity"]
            currencies.add(cost.get("Unit", "unknown"))
            name, unit = group["Keys"][0], usage.get("Unit", "unknown")
            if name in aggregates and aggregates[name][2] != unit:
                raise ValueError("Incompatible usage units")
            old = aggregates.get(name, (Decimal(0), Decimal(0), unit))
            aggregates[name] = (old[0] + amount(cost), old[1] + amount(usage), unit)
    return sorted([
        {"name": name, "cost": float(cost), "rawCost": str(cost),
         "usageQuantity": float(qty), "rawUsageQuantity": str(qty), "unit": unit}
        for name, (cost, qty, unit) in aggregates.items() if cost != 0 or qty != 0
    ], key=lambda row: row["cost"], reverse=True)
