"""Read-only Gamma enrichment for fields absent from a frozen scan export.

Never saves the enriched rows back to the run or changes scan eligibility/odds.
"""
from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from typing import Any

import httpx

from app.domains.polymarket_auto_live.stage_one_excel import encode_scan_export_data, decode_scan_export_data


def enrich_export_rows(rows: list[dict[str, Any]], *, budget_seconds: float = 240) -> None:
    missing = []
    for row in rows:
        data = decode_scan_export_data(row)
        if not data["event"] or not all(key in data["market"] for key in ("id", "outcomes", "volume")):
            missing.append(row)
    if not missing:
        return
    deadline = time.monotonic() + budget_seconds
    timestamp = datetime.now(UTC).isoformat()
    by_id: dict[str, list[dict[str, Any]]] = {}
    for row in missing:
        identity = str(row.get("market_id") or "")
        row["export_metadata"] = {"source": "Historical scan", "fetchedAt": "N/A", "status": "Source fields were not saved; N/A means unavailable or not applicable."}
        if identity.isdigit():
            by_id.setdefault(identity, []).append(row)
    ids = list(by_id)
    batches = [ids[index:index + 500] for index in range(0, len(ids), 500)]
    with httpx.Client(timeout=15, headers={"User-Agent": "investment-engine-stage-one-export/1.0"}) as client:
        def fetch_batch(batch: list[str]) -> tuple[list[str], list[dict[str, Any]], str]:
            if time.monotonic() >= deadline:
                return batch, [], "Enrichment time limit reached"
            try:
                response = client.get("https://gamma-api.polymarket.com/markets", params=[("id", item) for item in batch] + [("limit", str(len(batch)))])
                response.raise_for_status()
                payload = response.json()
                if not isinstance(payload, list):
                    raise ValueError("Unexpected Gamma response")
                return batch, payload, "No exact market match returned"
            except (httpx.HTTPError, ValueError) as exc:
                return batch, [], f"Source lookup unavailable ({type(exc).__name__})"

        with ThreadPoolExecutor(max_workers=4) as executor:
            # Submit only a bounded wave, avoiding thousands of queued requests.
            for offset in range(0, len(batches), 4):
                if time.monotonic() >= deadline:
                    break
                for batch, markets, failure in executor.map(fetch_batch, batches[offset:offset + 4]):
                    matches = {str(market.get("id")): market for market in markets if isinstance(market, dict) and str(market.get("id")) in batch}
                    for identity in batch:
                        market = matches.get(identity)
                        for row in by_id[identity]:
                            if market is None:
                                row["export_metadata"]["status"] = failure
                                continue
                            saved = decode_scan_export_data(row)
                            incoming_events = market.get("events") or []
                            incoming_event = incoming_events[0] if incoming_events and isinstance(incoming_events[0], dict) else {}
                            combined = {**market, **saved["market"]}
                            combined["_export_event"] = {**incoming_event, **saved["event"]}
                            row["scan_export_data"] = encode_scan_export_data(combined)
                            row["export_metadata"] = {
                                "source": "Gamma at export time (not historical scan time)",
                                "fetchedAt": timestamp,
                                "status": "Missing source fields enriched; frozen scan values preserved. N/A means not provided or not applicable.",
                            }
