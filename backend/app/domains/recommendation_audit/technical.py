"""Exact declared table adapter. It certifies structure, never market truth."""
from app.domains.jobs.output_contracts.document import parse_markdown
from .deterministic import digest


def captured_setup_directions(prompt):
    """Read the approved registry actually embedded in the frozen prompt."""
    blocks, _ = parse_markdown(prompt or "")
    direction, registry = None, {}
    for block in blocks:
        if block.kind == "text":
            import re
            headings=re.findall(r"^###\s+(Bullish Setups|Bearish / Sell-Trim Setups)\s*$",block.text,re.M)
            if headings: direction="bullish" if headings[-1]=="Bullish Setups" else "bearish"
        elif block.kind == "table" and direction:
            headers=[str(h).strip().casefold() for h in block.headers]
            if not {"setup","bias","confidence"}.issubset(headers): continue
            for cells in block.rows:
                if len(cells)==len(headers): registry[str(cells[headers.index("setup")]).strip().casefold()]=direction
    return registry


def agreed_technical(outputs, setup_prompt=None):
    """Compare stock values, retaining every independent transport revision."""
    if not outputs or any(o.payload["status"] != "completed" for o in outputs): return {}
    maps = [technical_rows(o.content or "") for o in outputs]
    keys = set().union(*(set(m) for m in maps))
    result = {}
    registry=captured_setup_directions(setup_prompt)
    for key in keys:
        rows = [m.get(key) for m in maps]
        values = [{k:v for k,v in row.items() if k != "source_hash"} if row else None for row in rows]
        if values[0] is not None and all(v == values[0] for v in values):
            result[key] = {**values[0], "source_hashes":[row["source_hash"] for row in rows], "output_ids":[o.id for o in outputs]}
            primary=result[key].get("primary_setup")
            if primary:
                approved=registry.get(primary.strip().casefold())
                result[key]["declared_bias"]=result[key]["bias"]
                if approved: result[key]["bias"]=approved; result[key]["direction_policy"]="exact_captured_approved_setup"
                else: result[key]["policy_error"]="Primary setup has no exact match in the captured approved registry; frontend alias/fallback cannot be certified."
            else: result[key]["policy_error"]="Primary setup is missing or blank; frontend fallback direction cannot be certified."
    return result


def technical_rows(content):
    blocks, _ = parse_markdown(content)
    result = {}
    for block in blocks:
        if block.kind != "table": continue
        headers = [str(h).strip().casefold() for h in block.headers]
        required = {"exchange symbol", "stock symbol", "bias", "confidence score", "premarket trend", "last 5 candles trend", "trigger level", "invalidation level"}
        if not required.issubset(headers): continue
        for cells in block.rows:
            if len(cells) != len(headers): continue
            row = dict(zip(headers, map(str, cells)))
            key = (row["stock symbol"].strip().upper(), row["exchange symbol"].strip().upper())
            if key in result: result[key] = None; continue
            values = {"confidence": row["confidence score"].strip(), "bias": row["bias"].strip().lower(), "premarket": row["premarket trend"].strip(), "last5": row["last 5 candles trend"].strip(), "trigger": row["trigger level"], "invalidation": row["invalidation level"], "primary_setup":row.get("primary setup"), "source_hash": digest(content)}
            result[key] = values
    return result
