"""Freeze all selected screener outputs in one publication and project each scorecard's inputs."""
from . import board
from .screener_inputs import selections
from .universe import publish_manifest


async def publish_with_screeners(db, owner, workflow, body):
    installed = await board.read_board(db, owner)
    cards = list(dict.fromkeys([*board.CARDS, *installed["enabled"]]))
    choices, outputs, _ = await selections(db, owner, "og", cards)
    jobs = sorted({job for run in outputs.get("swing", {}).values() for job in run["jobs"]})
    manifest = await publish_manifest(db, owner, workflow, body.model_copy(update={"swing_job_ids": jobs}))
    stocks = {s["listing"]: s for s in manifest["stocks"]}
    refs = {}
    for screener, runs in outputs.items():
        for run_id, output in runs.items():
            key = f"{screener}:{run_id}"
            refs[key] = {"jobs": output["jobs"]}
            for row in output["rows"]:
                symbol = row["exchange"] + ":" + row["symbol"]
                symbol = manifest.get("listing_aliases", {}).get(symbol, symbol)
                if symbol not in stocks:
                    stocks[symbol] = dict(listing=symbol, identity=symbol, exchange=row["exchange"], symbol=row["symbol"],
                        name=row["name"], origin="contender", units=0, settled=0, average_cost=None, price=None,
                        value=0, weight=0, sector=None, sources=[], currency="INR", position_status="absent")
                stock = stocks[symbol]
                if stock["origin"] == "holding":
                    stock["origin"] = "both"
                sources = stock.setdefault("screener_runs", [])
                if key not in sources:
                    sources.append(key)
    manifest.update(stocks=[stocks[k] for k in sorted(stocks)], screener_inputs=choices, screener_runs=refs,
                    requested_swing_jobs=sorted(set(body.swing_job_ids)))
    return manifest


def project(manifest, card):
    plans = manifest.get("screener_inputs")
    if plans is None or card is None:
        return manifest
    plan = plans.get(card, {})
    selected = {f"{source}:{run_id}" for source, ids in plan.items() for run_id in ids}
    jobs = {j for ref in selected for j in manifest["screener_runs"].get(ref, {}).get("jobs", [])}
    stocks = []
    for row in manifest["stocks"]:
        matches = [ref for ref in row.get("screener_runs", []) if ref in selected]
        if matches or row["origin"] in ("holding", "both"):
            stocks.append({**row, "screener_runs": matches, "sources": [j for j in row["sources"] if j in jobs],
                           "origin": "holding" if row["origin"] == "both" and not matches else row["origin"]})
    return {**manifest, "stocks": stocks, "swing_job_ids": sorted(jobs), "screener_inputs": {card: plan},
            "screener_runs": {k:v for k,v in manifest["screener_runs"].items() if k in selected},
            "evidence": [r for r in manifest["evidence"] if r["job_id"] in jobs]}


async def refresh(db, user, revision_id):
    from datetime import datetime
    from . import storage
    from .router import Publication, owned, workflow
    from .universe import digest

    original = await owned(db, user.id, "india", "revision", revision_id)
    previous = original.manifest
    parent = await workflow(db, user.id, "india", previous["sequence"])
    body = Publication(use_screeners=True, sequence=parent.sequence, request_key="refresh-inputs",
                       snapshot_id=previous["snapshot_id"], captured_at=datetime.fromisoformat(previous["snapshot_at"]),
                       swing_job_ids=[])
    manifest = await publish_with_screeners(db, user.id, parent, body)
    if previous.get("screener_inputs") == manifest["screener_inputs"] and previous.get("screener_runs") == manifest["screener_runs"]:
        return original.id
    key = "inputs-" + digest([previous["snapshot_id"], manifest["screener_inputs"], manifest["screener_runs"]])
    found = await storage.by_key(db, "revision", key, workflow_id=parent.id)
    if found:
        return found.id
    revision = await storage.append(db, parent.id, "revision", key, {"manifest":manifest, "digest":digest(manifest)})
    record_id = revision.id
    await db.commit()
    return record_id
