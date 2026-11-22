"""Resolve punctuation aliases only with an unambiguous same-venue instrument and issuer."""
import re
from collections import defaultdict

import httpx

from app.domains.zerodha.upstox_quotes import technical_instruments


def issuer_name(name):
    clean = re.sub(r"\b(limited|ltd|equity)\b", "", (name or "").lower())
    return re.sub(r"[^a-z0-9]", "", clean.replace("&", "and"))


def aliases(stocks, master):
    candidates = defaultdict(list)
    for key, meta in master.items():
        if re.fullmatch(r"IN[A-Z0-9]{10}", meta.get("isin") or ""):
            candidates[re.sub(r"[^A-Z0-9:]", "", key)].append(key)
    found = {}
    for stock in stocks:
        key = stock["listing"]
        if key in master or "_" not in key:
            continue
        choices = candidates[re.sub(r"[^A-Z0-9:]", "", key)]
        if len(choices) == 1 and issuer_name(stock.get("name")) and issuer_name(stock["name"]) == issuer_name(master[choices[0]].get("name")):
            found[key] = choices[0]
    return found


async def publication_aliases(listings, evidence):
    if not any("_" in k for k in listings):
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
