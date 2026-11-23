"""Reuse contemporaneous, same-revision evidence in the Indian Threats scan."""
import hashlib
import math
from datetime import datetime, timedelta
from sqlalchemy import select

from . import storage


async def saved_inputs(db, revision):
    research = storage.Stage.summary_json["research"]
    # Several partial Technical collections can coexist for the same revision.
    # Exact-listing candles are validated by the consumer against the decision time.
    history = {}
    listings = {}
    packets = await db.execute(select(research["listings"], research["technical"]).where(
        storage.of_kind("packet", revision), research["version"].as_integer()==3
    ).order_by(storage.Stage.id.desc()).limit(5))
    for rows, ledgers in packets:
        for key, candles in (rows or {}).items():
            ledger = (ledgers or {}).get(key) or {}
            source = ledger.get("sources", {}).get("stock", {})
            for candle in candles:
                listings.setdefault(key, []).append((candle, source, ledger.get("canonical_listing", key)))
    history["listings"] = listings
    reports = await db.scalars(select(research["packets"]).where(
        storage.of_kind("packet", revision), research["version"].as_integer()==4
    ).order_by(storage.Stage.id.desc()).limit(4))
    filings = {}
    for packet in reports:
        for key, listing in (packet or {}).items():
            if listing.get("verified_listing", key) != key:
                continue
            for doc in listing.get("refs", {}).values():
                if doc.get("kind") == "results":
                    filings.setdefault(key, {})[doc["url"]] = doc
    history["issuer_filings"] = filings
    return history


def technical_sessions(records, key, days, cutoff):
    """Return unambiguous same-venue raw observations and a reason for every missing day."""
    candidates, reasons = {}, {}
    for item in records:
        row, source, canonical = item if isinstance(item, tuple) else (item, {}, key)
        day = str(row.get("as_of", ""))[:10]
        if row.get("kind") != "daily_bar" or day not in days:
            continue
        try:
            if canonical.split(":")[0] != key.split(":")[0] or row.get("isin") and source.get("instrument") and row["isin"] != source["instrument"]:
                raise ValueError("instrument mismatch")
            if not row.get("url") or datetime.fromisoformat(row["as_of"]) > cutoff:
                raise ValueError("missing source or post-cutoff session")
            vintage = row.get("published_at") or row.get("received_at")
            if vintage and datetime.fromisoformat(vintage) > cutoff:
                raise ValueError("observation after cutoff")
            if row.get("basis") not in (None, "venue-raw"):
                if (row.get("basis") != "unverified-provider" or not vintage or not source.get("instrument")
                        or not source.get("action_url") or not isinstance(source.get("actions"), list)
                        or any(days[0] < a["date"] <= days[-1] for a in source["actions"])):
                    raise ValueError("price basis unverified")
            values = tuple(float(row[k]) for k in ("open", "high", "low", "close", "volume"))
            op, hi, lo, cl, vol = values
            if not all(map(math.isfinite, values)) or not 0 < lo <= min(op, cl) <= max(op, cl) <= hi or vol < 0:
                raise ValueError("invalid price or volume")
            candidates.setdefault(day, {})[values] = row
        except (ValueError, TypeError, KeyError) as error:
            reasons[day] = str(error) if isinstance(error, ValueError) else "incomplete observation"
    accepted = {}
    for day in days:
        options = candidates.get(day, {})
        if len(options) == 1:
            accepted[day] = next(iter(options.values()))
            reasons.pop(day, None)
        elif options:
            reasons[day] = "conflicting observations"
        else:
            reasons.setdefault(day, "no saved Technical observation")
    return accepted, reasons


def filing_facts(doc, cutoff):
    """Present an individual filing's reported figures with period, unit and source."""
    from .threat_sources import public_document
    if not public_document(doc.get("url", "")) or doc.get("comparison_source"):
        return None
    try:
        published = datetime.fromisoformat(doc["as_of"])
        if not published.tzinfo or not cutoff-timedelta(days=90) <= published <= cutoff:
            return None
    except (KeyError, TypeError, ValueError):
        return None
    lines = []
    for fact in doc.get("facts", []):
        start, end = fact["period"]
        if end > published.date().isoformat():
            continue
        for label, (value, unit) in fact["values"].items():
            if type(value) in (int, float) and math.isfinite(value) and unit:
                lines.append(f"{start} to {end}: {label} = {value} {unit}")
    if not lines:
        return None
    body = "\n".join(lines)[:1800]
    return {"kind":"exchange_notice", "title":"Filed financial results", "as_of":doc["as_of"],
            "url":doc["url"], "excerpt":body, "document_hash":hashlib.sha256(body.encode()).hexdigest()}
