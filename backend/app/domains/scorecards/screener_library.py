"""Shared, account-owned Stage 2 screener definitions and per-strategy membership."""
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.domains.auth.dependencies import get_current_user
from app.domains.bottom_fishing import store
from app.domains.bottom_fishing.query import FIELDS, compile_query
from app.infrastructure.database.session import get_async_db

router = APIRouter(prefix="/runs/scorecards/india/screeners", tags=["equity-screeners"])
ACTION = "india.screener_library.v1"
BUILTINS = [
    dict(id="swing", name="Swing Scan", summary="Find Indian swing-trade contenders using the configured research models and prompts."),
    dict(id="bottom", name="Bottom Fishing Screen", summary="Screen NSE and BSE equities with your saved query and inspect the bottom-fishing discovery filters."),
]
Strategy = Literal["og", "bfs"]
CustomId = Annotated[str, Field(pattern=r"^custom-[a-f0-9]{32}$")]
ScreenerId = Literal["swing", "bottom"] | CustomId


class Definition(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=80)
    summary: str = Field(min_length=1, max_length=320)
    query: str = Field(min_length=1, max_length=4000)
    latest_results: bool = False

    @field_validator("query")
    @classmethod
    def valid_query(cls, query):
        compile_query(query)
        return query


class AddScreener(BaseModel):
    model_config = ConfigDict(extra="forbid")
    strategy: Strategy
    version: int = Field(ge=0)
    existing: ScreenerId | None = None
    definition: Definition | None = None

    @model_validator(mode="after")
    def one_source(self):
        if bool(self.existing) == bool(self.definition):
            raise ValueError("Choose one existing screener or enter a new definition.")
        return self


async def read_library(db, owner):
    version, data = await store.latest(db, owner, ACTION, {
        "assigned": {"og": ["swing"], "bfs": ["bottom"]}, "custom": [],
    })
    return version, data


def present(version, data):
    return dict(version=version, assigned=data["assigned"], screeners=BUILTINS + data["custom"], fields=list(FIELDS))


@router.get("")
async def library(db=Depends(get_async_db), user=Depends(get_current_user)):
    return present(*await read_library(db, user.id))


@router.post("")
async def add(body: AddScreener, db=Depends(get_async_db), user=Depends(get_current_user)):
    await store.lock(db, user.id)
    version, data = await read_library(db, user.id)
    if body.version != version:
        raise HTTPException(409, "Your screener library changed. Reload it and try again.")
    cards = BUILTINS + data["custom"]
    if body.definition:
        if any(card["name"].casefold() == body.definition.name.casefold() for card in cards):
            raise HTTPException(422, "A screener with that name already exists.")
        key = "custom-" + uuid4().hex
        data["custom"].append(dict(id=key, **body.definition.model_dump()))
    else:
        key = body.existing
        if not any(card["id"] == key for card in cards):
            raise HTTPException(404, "This screener is unavailable.")
    assigned = data["assigned"][body.strategy]
    if key in assigned:
        return present(version, data)
    assigned.append(key)
    record = store.append(db, user.id, ACTION, data)
    await db.flush()
    result = present(record.id, data)
    await db.commit()
    return result
