"""Owner-scoped, per-scorecard selection of immutable Stage 2 run outputs."""
import json
import re
from typing import Annotated, Literal

from fastapi import Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import or_, select

from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import ActivityLog
from app.domains.bottom_fishing import store
from app.domains.jobs.models import Job
from app.domains.jobs.output_contracts.normalize import normalize_output
from app.domains.runs.models import Run, RunJob
from app.domains.runs.run_identity import analysis_run_identity
from app.infrastructure.database.session import get_async_db
from .board import CARDS, read_board
from .screener_library import BUILTINS, CustomId, ScreenerId, Strategy, read_library, router
from .screener_runs import FINISHED
from .universe import utc

Card = Literal["bottom", "technical", "rebalance", "threats", "pairwise"] | CustomId
Id = Annotated[int, Field(gt=0)]
USABLE = {"completed", "partial"}
SYMBOL = re.compile(r"^[A-Z0-9&._-]{1,64}$")


class Selection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=0)
    selected: dict[ScreenerId, Annotated[list[Id], Field(max_length=5)]]


def preference_key(strategy, card):
    return f"screeners.inputs.{strategy}.{card}"


async def check_card(db, owner, strategy, card):
    if strategy == "bfs" and card == "bottom":
        return
    if strategy == "og" and (card in CARDS or card in (await read_board(db, owner))["enabled"]):
        return
    raise HTTPException(404, "This scorecard is unavailable on the selected board.")


def listing(row):
    symbol = str(row.get("symbol") or "").strip().upper()
    exchange = str(row.get("exchange") or "NSE").strip().upper()
    if exchange in ("NSE", "BSE") and SYMBOL.fullmatch(symbol):
        return dict(symbol=symbol, exchange=exchange, name=row.get("name") or symbol)


async def swing_runs(db, owner, ids=None, usable=False):
    query = select(Run.id, Run.prompt_preview, Run.auto_rebalance_label, Run.auto_rebalance_portfolio,
                   Run.updated_at, Run.status).where(Run.user_id == owner,
                   or_(Run.auto_rebalance_portfolio.is_(None), Run.auto_rebalance_portfolio == "india"),
                   or_(Run.auto_rebalance_label.ilike("%swing%"), Run.prompt_preview.ilike("%swing%")))
    if usable:
        query = query.where(Run.status.in_(USABLE))
    if ids is not None:
        query = query.where(Run.id.in_(ids))
    result, before = [], None
    while len(result) < (len(ids) if ids is not None else 5):
        page = (await db.execute((query.where(Run.id < before) if before else query).order_by(Run.id.desc()).limit(32))).all()
        if not page:
            break
        before = page[-1].id
        for r in page:
            identity = analysis_run_identity(r)
            if (identity.stage, identity.market) != ("swing", "india"):
                continue
            result.append(dict(id=r.id, at=utc(r.updated_at).isoformat(), status=r.status.value if hasattr(r.status,"value") else r.status))
            if ids is None and len(result) == 5:
                break
    return result


async def log_runs(db, owner, source, ids=None, *, contents=False, usable=False):
    query = select(ActivityLog.id, ActivityLog.created_at, ActivityLog.details, ActivityLog.action).where(ActivityLog.user_id == owner)
    if source == "bottom":
        query = query.where(ActivityLog.action.in_((store.LIVE, store.REVIEW, store.CYCLE)))
    else:
        query = query.where(ActivityLog.resource_type == source, ActivityLog.action.in_(("screeners.run.pending", "screeners.run.running", FINISHED)))
    if ids is not None:
        query = query.where(ActivityLog.id.in_(ids))
    result, before = [], None
    while len(result) < (len(ids) if ids is not None else 5):
        page = (await db.execute((query.where(ActivityLog.id < before) if before else query)
                                 .order_by(ActivityLog.id.desc()).limit(16))).all()
        if not page:
            break
        before = page[-1].id
        for record in page:
            data = json.loads(record.details)
            state = data.get("state", data)
            if source == "bottom":
                report = state.get("original_results")
                if record.action == store.CYCLE and not any(s.get("at") == state.get("at") for s in state.get("scans", [])):
                    continue
                if report is None and not state.get("at") and not state.get("error"):
                    continue
                rows = report["rows"] if report is not None else [
                    {"exchange": k.split(":")[0], "symbol": k.split(":")[-1]} for k in state.get("screen_symbols", state.get("setups", {}))]
                status = state.get("screen_status") or state.get("status", "failed")
            else:
                rows = data.get("report", {}).get("rows", [])
                status = data["status"]
            if usable and status not in USABLE:
                continue
            item = dict(id=record.id, at=state.get("market_as_of") or state.get("at") or utc(record.created_at).isoformat(),
                        status=status, count=len(rows))
            if contents:
                item["rows"] = [stock for row in rows if (stock := listing(row))]
            result.append(item)
            if ids is None and len(result) == 5:
                break
    return result


async def history(db, owner, source, ids=None, usable=False):
    return await swing_runs(db, owner, ids, usable) if source == "swing" else await log_runs(db, owner, source, ids, usable=usable)


async def groups(db, owner, strategy, card):
    _, lib = await read_library(db, owner)
    version, saved = await store.latest(db, owner, preference_key(strategy, card), {})
    if strategy == "bfs" and not version:
        _, config = await store.latest(db, owner, store.CONFIG, {})
        if config.get("inputs") == []:
            saved = {"bottom": []}
    names = {item["id"]: item["name"] for item in BUILTINS + lib["custom"]}
    result = []
    for key in lib["assigned"][strategy]:
        recent = await history(db, owner, key)
        pinned = saved.get(key)
        automatic = [r["id"] for r in recent if r["status"] in USABLE][:1]
        if recent and not automatic:
            automatic = [r["id"] for r in (await history(db, owner, key, usable=True))[:1]]
        selected = automatic if pinned is None else pinned
        older = set(selected) - {r["id"] for r in recent}
        result.append(dict(id=key, name=names[key], runs=recent, pinned_older=await history(db, owner, key, older) if older else [],
                           automatic=pinned is None, selected=selected, latest=automatic))
    return dict(version=version, groups=result)


@router.get("/inputs/{strategy}/{card}")
async def inputs(strategy: Strategy, card: Card, db=Depends(get_async_db), user=Depends(get_current_user)):
    await check_card(db, user.id, strategy, card)
    return await groups(db, user.id, strategy, card)


@router.post("/inputs/{strategy}/{card}")
async def save_inputs(strategy: Strategy, card: Card, body: Selection, db=Depends(get_async_db), user=Depends(get_current_user)):
    await store.lock(db, user.id)
    current = await inputs(strategy, card, db, user)
    if current["version"] != body.version:
        raise HTTPException(409, "These inputs changed. Reload before saving.")
    available = {g["id"]: {r["id"] for r in g["runs"] + g["pinned_older"] if r["status"] in USABLE}
                 for g in current["groups"]}
    for source, ids in body.selected.items():
        if source not in available or not set(ids) <= available[source] or len(ids) != len(set(ids)):
            raise HTTPException(422, "Choose available completed runs from this screener.")
    store.append(db, user.id, preference_key(strategy, card), body.selected)
    await db.commit()
    return await groups(db, user.id, strategy, card)


async def swing_output(db, owner, ids):
    jobs = (await db.execute(select(RunJob.run_id, Job).join(Job, Job.id == RunJob.job_id)
        .join(Run, Run.id == RunJob.run_id).where(Run.user_id == owner, Job.user_id == owner,
        RunJob.run_id.in_(ids), Job.status.in_(USABLE), Job.response.is_not(None)).order_by(Job.id))).all()
    outputs = {key: dict(rows=[], jobs=[]) for key in ids}
    for run_id, job in jobs:
        identity = analysis_run_identity(job)
        if (identity.stage, identity.market) != ("swing", "india"):
            continue
        observations = normalize_output(job.response, "swing").rows
        if observations:
            outputs[run_id]["jobs"].append(job.id)
        for item in observations:
            raw = dict(item.source_values)
            row = listing(dict(symbol=raw.get("stock_symbol"), exchange=raw.get("exchange_symbol"), name=raw.get("stock_name")))
            if row:
                outputs[run_id]["rows"].append(row)
    return outputs


async def source_outputs(db, owner, source, ids):
    if not ids:
        return {}
    if source == "swing":
        return await swing_output(db, owner, ids)
    return {r["id"]: dict(rows=r["rows"], jobs=[]) for r in await log_runs(db, owner, source, ids, contents=True) if r["status"] in USABLE}


async def selections(db, owner, strategy, cards, *, live_bottom=False):
    _, library = await read_library(db, owner)
    assigned = library["assigned"][strategy]
    saved = {card:(await store.latest(db, owner, preference_key(strategy, card), {}))[1] for card in cards}
    choices = {card:{} for card in cards}
    outputs = {}
    for source in assigned:
        defaults = []
        if any(source not in prefs for prefs in saved.values()) and not (live_bottom and source == "bottom"):
            defaults = [r["id"] for r in await history(db, owner, source, usable=True) if r["status"] in USABLE][:1]
        for card in cards:
            choices[card][source] = saved[card].get(source, defaults)
        ids = {key for card in cards for key in choices[card][source]}
        outputs[source] = await source_outputs(db, owner, source, ids)
    return choices, outputs, saved
