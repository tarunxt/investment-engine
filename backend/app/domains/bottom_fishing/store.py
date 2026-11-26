"""Account-owned settings and immutable paper-cycle snapshots in the existing audit ledger."""
import json
from datetime import datetime
from zoneinfo import ZoneInfo
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import select, func
from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import ActivityLog, User
from app.infrastructure.database.session import get_async_db
from .strategy import WEIGHTS
from .query import FIELDS, compile_query

MANUAL = "bottom_fishing.manual.v1"
REVIEW = "bottom_fishing.review.v1"
CONFIG = "bottom_fishing.settings.v1"
CYCLE = "bottom_fishing.paper.v1"
router = APIRouter(prefix="/runs/scorecards/india/bottom-fishing", tags=["scorecards"])


class Settings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    inputs: list[Literal["bottom"]] = Field(default_factory=lambda:["bottom"], max_length=1)
    capital: int = Field(default=100000, ge=1, le=100000000)
    screen_query: str = Field(default="", max_length=4000)
    latest_results: bool = False
    weights: dict[str,int] = Field(default_factory=lambda:dict(WEIGHTS))

    @model_validator(mode="after")
    def check(self):
        if self.screen_query or self.latest_results:
            compile_query(self.screen_query)
        if set(self.weights)!=set(WEIGHTS) or sum(self.weights.values())!=100 or min(self.weights.values())<0:
            raise ValueError("Eight nonnegative factor weights must total 100")
        if len(set(self.inputs))!=len(self.inputs):
            raise ValueError("Duplicate source")
        return self


class CapturedCompany(BaseModel):
    symbol: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9&._-]+$")
    name: str = Field(min_length=1, max_length=160)


class CapturedResults(BaseModel):
    query: str = Field(min_length=1, max_length=4000)
    latest: bool
    total: int = Field(ge=1, le=5000)
    rows: list[CapturedCompany] = Field(min_length=1, max_length=5000)


class RunInputs(BaseModel):
    capture: CapturedResults | None = None
    version: int | None = Field(default=None, ge=0)


class Change(Settings):
    version: int = Field(ge=0)


async def latest(db, owner, action, default):
    row = (await db.execute(select(ActivityLog.id,ActivityLog.details).where(
        ActivityLog.user_id==owner, ActivityLog.action==action).order_by(ActivityLog.id.desc()).limit(1))).first()
    return (row.id,json.loads(row.details)) if row else (0,default)


async def lock(db, owner):
    await db.scalar(select(User.id).where(User.id==owner).with_for_update())


def append(db, owner, action, data):
    row = ActivityLog(user_id=owner, action=action, resource_type="india", details=json.dumps(data,allow_nan=False))
    db.add(row)
    return row


def public_request(request_id, job):
    fields = ("status", "stage", "requested_at", "started_at", "finished_at", "error", "kite_sync")
    return dict(id=request_id, **{key: job[key] for key in fields if key in job})


async def restore_kite_details(db, owner, review):
    kite = (review or {}).get("state", {}).get("kite_sync")
    if not kite or "holdings" in kite:
        return
    from app.domains.zerodha.models import ZerodhaPortfolioSnapshot as Snapshot
    captured = datetime.fromisoformat(kite["captured_at"])
    row = await db.scalar(select(Snapshot).where(
        Snapshot.user_id == owner, Snapshot.captured_at == captured))
    if row is not None:
        kite.update(holdings=row.holdings, holdings_market_value=row.holdings_market_value,
                    holdings_pnl=row.holdings_pnl, available_margin=row.available_margin)


async def snapshot(db, owner, *, include_review=True):
    version, settings = await latest(db,owner,CONFIG,Settings().model_dump())
    _, state = await latest(db,owner,CYCLE,{})
    manual_id, manual = await latest(db,owner,MANUAL,{})
    _, review = await latest(db,owner,REVIEW,None) if include_review else (0,None)
    await restore_kite_details(db, owner, review)
    live = None
    if include_review:
        from .cloud_screen import LIVE
        _, saved_live = await latest(db,owner,LIVE,{})
        if saved_live.get("version")==version:
            live = saved_live
    return dict(live=live, review=review, version=version, settings=Settings.model_validate(settings).model_dump(),
                query_fields=list(FIELDS), state=state, mode="paper", formula_version=1,
                manual=public_request(manual_id, manual) if manual_id else None)


@router.post("/run", status_code=202)
async def request_run(request: Request, db=Depends(get_async_db), user=Depends(get_current_user), body: RunInputs | None = None):
    from app.domains.zerodha.upstox_quotes import configured_for
    if not configured_for(user.id,user.username):
        raise HTTPException(409,"Market data is unavailable for this account.")
    await lock(db,user.id)
    request_id, manual = await latest(db,user.id,MANUAL,{})
    version, settings = await latest(db,user.id,CONFIG,Settings().model_dump())
    active = manual.get("status") in {"queued","running"}
    if body and body.version is not None:
        if body.version != version:
            raise HTTPException(409,"Settings changed. Reload the query before running.")
        if active and manual.get("version") != version:
            raise HTTPException(409,"A review with earlier inputs is still running.")
    capture = body.capture if body else None
    if capture:
        if active:
            raise HTTPException(409, "A review is already running.")
        if (" ".join(capture.query.split()) != " ".join(settings.get("screen_query","").split())
                or capture.latest != bool(settings.get("latest_results"))
                or len(capture.rows) != capture.total
                or len({r.symbol for r in capture.rows}) != capture.total):
            raise HTTPException(422, "The pasted results must match the saved query, quarter option and full result count.")
    if not active:
        manual = dict(status="queued", requested_at=datetime.now(ZoneInfo("Asia/Kolkata")).isoformat(),
                      version=version, settings=Settings.model_validate(settings).model_dump())
        if capture:
            manual["original_results"] = dict(at=manual["requested_at"], source="Pasted Screener results",
                                               rows=[r.model_dump() for r in capture.rows], total=capture.total, complete=True)
        row = append(db,user.id,MANUAL,manual)
        await db.flush()
        request_id = row.id
    await db.commit()
    if manual["status"] == "queued":
        request.app.state.bottom_review_wake.set()
    return public_request(request_id, manual)


@router.get("")
async def read(db=Depends(get_async_db), user=Depends(get_current_user)):
    return await snapshot(db,user.id)


@router.post("/inputs")
async def change(body:Change, db=Depends(get_async_db), user=Depends(get_current_user)):
    await lock(db,user.id)
    current = await snapshot(db,user.id)
    if body.version!=current["version"]:
        raise HTTPException(409,"Settings changed. Reload before saving.")
    updated = body.model_dump(exclude={"version"})
    for name in ("screen_query", "latest_results"):
        if name not in body.model_fields_set:
            updated[name] = current["settings"][name]
    try:
        Settings.model_validate(updated)
    except ValueError as exc:
        raise HTTPException(422,"Invalid screening query or reporting-period filter.") from exc
    append(db,user.id,CONFIG,updated)
    state = current["state"]
    if state.get("pending"):
        for row in state.get("rows",[]):
            if row.get("reason")=="Paper limit pending":
                row["reason"] = "Paper entry cancelled on settings change"
        state["pending"] = {}
        append(db,user.id,CYCLE,state)
    await db.commit()
    return await snapshot(db,user.id)


async def ready_requests(db, now):
    newest = select(func.max(ActivityLog.id)).where(ActivityLog.action == MANUAL).group_by(ActivityLog.user_id)
    rows = await db.execute(select(ActivityLog.user_id, ActivityLog.id, ActivityLog.details).where(ActivityLog.id.in_(newest)))
    for owner, request_id, details in rows:
        job = json.loads(details)
        if job["status"] == "queued" or (job["status"] == "running" and job["lease_until"] <= now.isoformat()):
            yield owner, request_id


@router.get("/history")
async def history(before: int | None = Query(default=None, gt=0), db=Depends(get_async_db), user=Depends(get_current_user), reviews_only: bool=False):
    query = select(ActivityLog.id, ActivityLog.action, ActivityLog.details).where(
        ActivityLog.user_id == user.id, ActivityLog.action.in_((CYCLE, REVIEW)))
    if reviews_only:
        query = query.where(ActivityLog.action == REVIEW)
    if before is not None:
        query = query.where(ActivityLog.id < before)
    records = (await db.execute(query.order_by(ActivityLog.id.desc()).limit(21))).all()
    items = []
    for key, action, details in records[:20]:
        data = json.loads(details)
        state = data["state"] if action == REVIEW else data
        items.append(dict(id=key, mode="Manual review" if action == REVIEW else "Paper cycle",
                          at=data.get("finished_at") or state.get("attempt") or state.get("at"),
                          kite_captured_at=(state.get("kite_sync") or {}).get("captured_at"),
                          kite_holdings=(state.get("kite_sync") or {}).get("holdings_count"),
                          status=state.get("status"), scored=sum(r.get("score") is not None for r in state.get("rows", [])),
                          candidates=len(state.get("setups", {})), entries=sum(bool(r.get("qty")) for r in state.get("rows", []))))
    return dict(items=items, next_before=items[-1]["id"] if len(records)>20 else None)


@router.get("/history/{record_id}")
async def history_record(record_id:int, db=Depends(get_async_db), user=Depends(get_current_user)):
    record = (await db.execute(select(ActivityLog.action, ActivityLog.details).where(
        ActivityLog.id == record_id, ActivityLog.user_id == user.id, ActivityLog.action.in_((CYCLE, REVIEW))))).first()
    if not record:
        raise HTTPException(404, "Saved run unavailable")
    data = json.loads(record.details)
    if record.action == REVIEW:
        await restore_kite_details(db, user.id, data)
    return data if record.action == REVIEW else dict(state=data, mode="Paper cycle")
