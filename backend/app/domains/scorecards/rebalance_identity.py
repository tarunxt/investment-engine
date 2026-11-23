"""Resolve punctuation aliases only with an unambiguous same-venue instrument and issuer."""
import re
from collections import defaultdict

import httpx

from app.domains.zerodha.upstox_quotes import technical_instruments


def issuer_name(name):
    clean = re.sub(r"\b(limited|ltd|equity)\b", "", (name or "").lower())
    return re.sub(r"[^a-z0-9]", "", clean.replace("&", "and"))


# NSE listing circular for Siemens Energy India Ltd. The Swing feed sometimes
# reports the issuer under a descriptive ticker. Verify the active instrument too.
SIEMENS_ALIAS = "NSE:SIEMENSENRGY"
SIEMENS_IDENTITY = ("NSE:ENRIN", "INE1NPP01017", "https://nsearchives.nseindia.com/web/pressrelease/2025-06/PR_List_17062025_20250617191748.pdf")


# Reported Swing symbols are hints. The frozen issuer and a current NSE EQ
# instrument must corroborate the exchange's published canonical identity.
SWING_IDENTITIES = {
    "NSE:ICICIBC": ("NSE:ICICIBANK", "INE090A01021", "https://nsearchives.nseindia.com/content/circulars/CML74453.pdf"),
    "NSE:PBFINTECH": ("NSE:POLICYBZR", "INE417T01026", "https://nsearchives.nseindia.com/content/circulars/CML77493.pdf"),
    "NSE:RIL": ("NSE:RELIANCE", "INE002A01018", "https://nsearchives.nseindia.com/content/circulars/CML61328.pdf"),
}


def documented_alias(stock, master):
    key = stock["listing"]
    if key in SWING_IDENTITIES:
        target, isin, _ = SWING_IDENTITIES[key]
        instrument = master.get(target, {})
        if (key in master or stock.get("origin") != "contender" or instrument.get("isin") != isin
                or instrument.get("series") != "EQ" or stock.get("isin") not in (None, "", isin)):
            return None
        reported = issuer_name(stock.get("name"))
        if stock.get("isin") == isin or (reported and reported == issuer_name(instrument.get("name"))):
            return target
        return None
    target, isin, _ = SIEMENS_IDENTITY
    if key != SIEMENS_ALIAS or key in master or master.get(target, {}).get("isin") != isin:
        return None
    if stock.get("isin") and stock["isin"] != isin:
        return None
    if stock.get("isin") == isin or issuer_name(stock.get("name")) == "siemensenergyindia":
        return target
    return None


def aliases(stocks, master):
    candidates = defaultdict(list)
    for key, meta in master.items():
        if re.fullmatch(r"IN[A-Z0-9]{10}", meta.get("isin") or ""):
            candidates[re.sub(r"[^A-Z0-9:]", "", key)].append(key)
    found = {}
    for stock in stocks:
        key = stock["listing"]
        verified = documented_alias(stock, master)
        if verified and stock.get("origin") == "contender":
            found[key] = verified
            continue
        if key in master or "_" not in key:
            continue
        choices = candidates[re.sub(r"[^A-Z0-9:]", "", key)]
        if len(choices) == 1 and issuer_name(stock.get("name")) and issuer_name(stock["name"]) == issuer_name(master[choices[0]].get("name")):
            found[key] = choices[0]
    return found


async def publication_aliases(listings, evidence):
    if not any("_" in k or k == SIEMENS_ALIAS or k in SWING_IDENTITIES for k in listings):
        return {}
    try:
        async with httpx.AsyncClient(timeout=4) as client:
            found = aliases(listings.values(), await technical_instruments(client))
    except (httpx.HTTPError, OSError, ValueError, RuntimeError):
        return {}
    for old, new in list(found.items()):
        row = listings[old]
        existing = listings.get(new)
        if existing and row["origin"] != "contender" and existing["origin"] != "contender":
            del found[old]  # Each reported broker holding retains its own quantity.
            continue
        listings.pop(old)
        merged = row if not existing or row["origin"] != "contender" else existing
        merged.update(listing=new, identity=new, symbol=new.split(":",1)[1])
        if existing:
            merged["sources"] = sorted(set(row["sources"] + existing["sources"]))
            if merged["sources"] and merged["origin"] == "holding":
                merged["origin"] = "both"
        listings[new] = merged
        for observation in evidence:
            if observation["listing"] == old:
                observation.update(listing=new, reported_listing=old)
    return found
