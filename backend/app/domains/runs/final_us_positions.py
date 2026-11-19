"""Bind US holdings to the saved Stage 3 snapshot and Technical listing registry."""
import json
import math
from datetime import timezone

from sqlalchemy import select
from app.domains.indmoney_us.models import IndMoneyUsPortfolioSnapshot
from app.domains.indmoney_us.threats import extract_indmoney_us_threat_prompt_metadata
from .final_source_rows import UnverifiableFinal

US_POSITION_POLICY = "indmoney-verified-snapshot-v1"


def utc(stamp):
    return stamp.replace(tzinfo=timezone.utc) if stamp.tzinfo is None else stamp.astimezone(timezone.utc)


async def load_us_snapshot(db, user_id, prompt):
    meta = extract_indmoney_us_threat_prompt_metadata(prompt)
    snapshot = await db.scalar(select(IndMoneyUsPortfolioSnapshot).where(
        IndMoneyUsPortfolioSnapshot.id == meta.snapshot_id, IndMoneyUsPortfolioSnapshot.user_id == user_id))
    if not snapshot or not meta.captured_at or utc(snapshot.captured_at) != utc(meta.captured_at):
        raise UnverifiableFinal("Stage 3 US snapshot identity or capture time differs")
    return snapshot


def resolve_listing(key, listings):
    venue, symbol = key
    venue = {"AMEX": "NYSEAMERICAN", "ARCA": "NYSEARCA"}.get(venue, venue)
    matches = [row for row in listings if row["symbol"] == symbol]
    selected = [row for row in matches if venue == "US" or row["instrument"] == f"{venue}:{symbol}"]
    if len(selected) != 1:
        return (venue, symbol), f"unresolved:{venue}:{symbol}:?", False
    row = selected[0]
    identity = json.dumps([row["security_id"], row["listing_mic"], row["share_class"]], separators=(",", ":"), ensure_ascii=False)
    return (row["instrument"].split(":")[0], symbol), "us:" + identity, len(matches) == 1


def holding(snapshot, key, safe):
    rows = snapshot.holdings
    if (not safe or snapshot.parse_status != "parsed" or not isinstance(rows, list)
            or snapshot.holdings_count != len(rows) or snapshot.reported_holdings_count not in (None, len(rows))):
        return None, None, "unresolved"
    matches = [row for row in rows if str(row.get("symbol", "")).upper().split(":")[-1] == key[1]]
    if len(matches) > 1:
        return None, None, "unresolved"
    if not matches:
        return 0, 0, "absent"
    def field(name):
        value = matches[0].get(name)
        return value if type(value) in (int, float) and math.isfinite(value) and value >= 0 else None
    return field("quantity"), field("current_value"), "matched"
