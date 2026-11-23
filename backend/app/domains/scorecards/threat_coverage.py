"""Plan supported category assessments independently of consolidated score eligibility."""
from .prompts import CATEGORIES

CODES = tuple(f"C{n}" for n in range(1, 9))
CONFIDENCE_CONTRACT = ('confidence must be one of the JSON strings "low", "medium", "high". '
                       'Historical 0–1 confidence maps to low below 0.50, medium below 0.75, otherwise high.')


def confidence_label(value):
    if isinstance(value, bool):
        return ""
    text = str(value).strip().lower()
    if text in {"low", "medium", "high", "moderate"}:
        return "medium" if text == "moderate" else text
    try:
        number = float(text)
    except (TypeError, ValueError):
        return ""
    if not 0 <= number <= 1:
        return ""
    return "high" if number >= .75 else "medium" if number >= .50 else "low"


def verified(row):
    return {code for code, label in zip(CODES, CATEGORIES) if row.get("categories", {}).get(label) is not None}


def available_categories(packet, key):
    issuer = packet.get("issuer_sources", {}).get(key, [])
    return {cat for cat, ids in packet.get("matrix", {}).get(key, {}).items()
            if any(sid in packet["sources"] and (not packet.get("exposure_required") or issuer
                   or packet["sources"][sid].get("kind") != "official_release") for sid in ids)}


def plan(packet, prior_rows=()):
    prior = {row["listing"]: row for row in prior_rows}
    ready = {}
    for key, targets in packet["targets"].items():
        row = prior.get(key, {})
        accepted = verified(row)
        possible = available_categories(packet, key)
        available = [cat for cat in targets if cat not in accepted and cat in possible]
        if available:
            ready[key] = available
    return ready


def diagnostics(rows):
    rejected = normalized = scoreable = without_sources = usable = assessed = 0
    for row in rows:
        sources = row.get("source_ids", {})
        available = {cat for cat, ids in sources.items() if ids}
        without_sources += not available
        accepted = verified(row)
        supported = accepted | set(row.get("sourced_categories", available))
        usable += bool(supported)
        assessed += bool(accepted)
        scoreable += len(supported) >= 3
        for event in row.get("evidence", []):
            rejected += event.get("Disposition") == "Excluded: Confidence unavailable"
            normalized += event.get("Disposition") == "Accepted" and event.get("Confidence normalized", False)
    return dict(usable=usable, assessed=assessed, without_sources=without_sources, scoreable=scoreable, confidence_rejected=rejected,
                confidence_recovered=normalized)


def annotate(result, packet):
    for row in result["rows"]:
        key = row["listing"]
        if key in packet.get("issuer_trace", {}):
            row["issuer_trace"] = packet["issuer_trace"][key]
        sources = row.setdefault("source_ids", {})
        for cat, ids in packet.get("matrix", {}).get(key, {}).items():
            if ids:
                sources[cat] = sorted(set(sources.get(cat, [])) | set(ids))
        if key in packet.get("matrix", {}):
            possible = set(row.get("sourced_categories", []))
            possible.update(available_categories(packet, key))
            row["sourced_categories"] = sorted(possible)
            if "C8" in possible:
                row.pop("history_gap", None)
        if key in packet.get("history_gaps", {}):
            row["history_gap"] = packet["history_gaps"][key]
    result["threat_diagnostics"] = diagnostics(result["rows"])
    return result
