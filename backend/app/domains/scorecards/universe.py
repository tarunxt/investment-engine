"""Build Stage 2 only from the authenticated user's pinned broker and Swing sources."""
import hashlib
import json
import math
import re
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import select
from app.domains.indmoney_us.alpaca_quotes import read_verified_listings
from app.domains.indmoney_us.models import IndMoneyUsPortfolioSnapshot
from app.domains.jobs.models import Job
from app.domains.jobs.output_contracts.normalize import normalize_output
from app.domains.runs.final_us_positions import resolve_listing
from app.domains.runs.models import Run, RunJob
from app.domains.runs.run_identity import analysis_run_identity
from app.domains.zerodha.models import ZerodhaPortfolioSnapshot


def digest(data):
    return hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def utc(stamp):
    return stamp.replace(tzinfo=timezone.utc) if stamp.tzinfo is None else stamp.astimezone(timezone.utc)


def finite(value):
    return value if type(value) in (float, int) and math.isfinite(value) and value >= 0 else None


async def publish_manifest(db, owner, workflow, body):
    india = workflow.portfolio == "india"
    market = "india" if india else "us"
    model = ZerodhaPortfolioSnapshot if india else IndMoneyUsPortfolioSnapshot
    snap = await db.scalar(select(model).where(model.user_id == owner, model.captured_at == body.captured_at,
        *([model.id == body.snapshot_id] if body.snapshot_id is not None else [])))
    if not snap or utc(snap.captured_at) != utc(body.captured_at):
        raise HTTPException(409, "Portfolio snapshot changed. Select the reviewed snapshot again.")
    if len(snap.holdings) != snap.holdings_count or (not india and (snap.parse_status != "parsed" or snap.reported_holdings_count not in (None, len(snap.holdings)))):
        raise HTTPException(422, "Incomplete holdings snapshot")
    selected = sorted(set(body.swing_job_ids))
    jobs = (await db.execute(select(Run, Job).join(RunJob, RunJob.run_id == Run.id).join(Job, Job.id == RunJob.job_id)
        .where(Run.user_id == owner, Job.user_id == owner, Job.id.in_(selected)).order_by(Job.id))).all()
    if len(jobs) != len(selected):
        raise HTTPException(422, "A selected Swing job is unavailable")
    registry = [] if india else read_verified_listings(owner)["listings"]
    listings, evidence, unresolved = {}, [], []
    def listing(venue, ticker, name, origin):
        venue, ticker = str(venue or "").strip().upper(), str(ticker or "").strip().upper()
        identity = f"{venue}:{ticker}"
        if not india:
            (venue, ticker), identity, _ = resolve_listing((venue, ticker), registry)
        valid = (venue in {"NSE", "BSE"} if india else not identity.startswith("unresolved:"))
        if not valid or not re.fullmatch(r"[A-Z0-9&_.-]{1,64}", ticker):
            unresolved.append({"exchange": venue, "symbol": ticker, "origin": origin, "reason": "Listing identity requires verification"})
            return None
        key = f"{venue}:{ticker}"
        return listings.setdefault(key, {"listing": key, "identity": identity, "exchange": venue, "symbol": ticker,
            "name": name or ticker, "origin": "contender", "units": 0, "settled": 0, "average_cost": None,
            "price": None, "value": 0, "weight": 0, "sector": None, "sources": []})
    for holding in snap.holdings:
        symbol = holding.get("tradingsymbol") if india else holding.get("symbol", "")
        venue = holding.get("exchange") if india else (symbol.split(":")[0] if ":" in symbol else "US")
        row = listing(venue, symbol.split(":")[-1] if symbol else "", holding.get("company_name") or holding.get("name"), "holding")
        if not row:
            continue
        if row["origin"] == "holding":
            raise HTTPException(422, f"Ambiguous duplicate holding {row['listing']}")
        settled = finite(holding.get("quantity"))
        t1 = finite(holding.get("t1_quantity", 0)) if india else 0
        units = None if settled is None or t1 is None else settled + t1
        price = finite(holding.get("last_price" if india else "market_price"))
        value = units * price if india and units is not None and price is not None else finite(holding.get("current_value"))
        row.update(origin="holding", units=units, settled=settled, price=price, value=value, sector=holding.get("sector"),
                   average_cost=finite(holding.get("average_price")), weight=holding.get("portfolio_weight_percent"))
    total = sum(row["value"] or 0 for row in listings.values())
    if india:
        for row in listings.values():
            row["weight"] = 100 * row["value"] / total if total and row["value"] is not None else None
    for run, job in jobs:
        if any((i.stage, i.market) != ("swing", market) for i in (analysis_run_identity(run), analysis_run_identity(job))) or not job.response or job.status not in ("partial", "completed"):
            raise HTTPException(422, f"Job {job.id} is not a usable selected Swing source")
        source = normalize_output(job.response, "swing")
        if not source.rows:
            raise HTTPException(422, f"Swing job {job.id} has no readable recommendations")
        for observation in source.rows:
            raw = dict(observation.source_values)
            row = listing(raw.get("exchange_symbol"), raw.get("stock_symbol"), raw.get("stock_name"), "swing")
            if not row:
                continue
            if row["origin"] == "holding":
                row["origin"] = "both"
            if job.id not in row["sources"]:
                row["sources"].append(job.id)
            evidence.append({"listing": row["listing"], "run_id": run.id, "job_id": job.id, "model": job.model,
                             "source_time": utc(job.updated_at).isoformat(), "row": {k: str(v) if v is not None else None for k,v in raw.items()}})
    return {"version": 1, "portfolio": workflow.portfolio, "sequence": workflow.sequence, "market": market,
            "currency": "INR" if india else "USD", "as_of": datetime.now(timezone.utc).isoformat(),
            "snapshot_id": snap.id, "snapshot_at": utc(snap.captured_at).isoformat(), "swing_job_ids": selected,
            "funds": {"type": "available_margin" if india else "wallet_balance", "value": snap.available_margin if india else snap.wallet_balance},
            "stocks": sorted(listings.values(), key=lambda row: row["listing"]), "evidence": evidence, "unresolved": unresolved}

