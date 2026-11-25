"""Account-owned settings and immutable paper-cycle snapshots in the existing audit ledger."""
import json
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import select
from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import ActivityLog, User
from app.infrastructure.database.session import get_async_db
from .strategy import WEIGHTS

CONFIG = "bottom_fishing.settings.v1"
CYCLE = "bottom_fishing.paper.v1"
router = APIRouter(prefix="/runs/scorecards/india/bottom-fishing", tags=["scorecards"])


class Settings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    inputs: list[Literal["bottom"]] = Field(default_factory=lambda:["bottom"], max_length=1)
    capital: int = Field(default=100000, ge=1, le=100000000)
    weights: dict[str,int] = Field(default_factory=lambda:dict(WEIGHTS))

    @model_validator(mode="after")
    def check(self):
        if set(self.weights)!=set(WEIGHTS) or sum(self.weights.values())!=100 or min(self.weights.values())<0:
            raise ValueError("Eight nonnegative factor weights must total 100")
        if len(set(self.inputs))!=len(self.inputs):
            raise ValueError("Duplicate source")
        return self


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


async def snapshot(db, owner):
    version, settings = await latest(db,owner,CONFIG,Settings().model_dump())
    _, state = await latest(db,owner,CYCLE,{})
    return dict(version=version, settings=settings, state=state, mode="paper", formula_version=1)


@router.get("")
async def read(db=Depends(get_async_db), user=Depends(get_current_user)):
    return await snapshot(db,user.id)


@router.post("/inputs")
async def change(body:Change, db=Depends(get_async_db), user=Depends(get_current_user)):
    await lock(db,user.id)
    current = await snapshot(db,user.id)
    if body.version!=current["version"]:
        raise HTTPException(409,"Settings changed. Reload before saving.")
    append(db,user.id,CONFIG,body.model_dump(exclude={"version"}))
    state = current["state"]
    if state.get("pending"):
        for row in state.get("rows",[]):
            if row.get("reason")=="Paper limit pending":
                row["reason"] = "Paper entry cancelled on settings change"
        state["pending"] = {}
        append(db,user.id,CYCLE,state)
    await db.commit()
    return await snapshot(db,user.id)
