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
    packets = await db.scalars(select(research["listings"]).where(
        storage.of_kind("packet", revision), research["version"].as_integer()==3
    ).order_by(storage.Stage.id.desc()).limit(5))
    for rows in packets:
        for key, candles in (rows or {}).items():
            listings.setdefault(key, []).extend(candles)
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
