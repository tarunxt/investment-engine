"""Account-owned Stage 3 membership, using the same preference ledger as workflow models."""
import json
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator
from sqlalchemy import select

from app.domains.auth.models import ActivityLog, User
from app.domains.runs.models import AutoRebalanceWorkflow as Workflow
from app.domains.runs.schemas import RunModelTarget
from . import storage
from .final import DEFAULT_WEIGHTS
from .prompts import CARDS

ACTION = "scorecards.board_saved"
CustomKey = Annotated[str, Field(pattern=r"^custom-[a-f0-9]{32}$")]
CardId = Literal["rebalance", "technical", "threats", "pairwise"] | CustomKey
Source = Literal["listings", "positions", "swing"]
Label = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4000)]
BASE_COLUMNS = ["Listing", "Score /100"]
INTRO = {
    "rebalance": ("Rebalance", "Assesses each holding and contender for a 2–12 week trade, including action and position sizing."),
    "technical": ("Technical", "Measures trend, momentum, relative strength, volume and setup over a 20-session horizon."),
    "threats": ("Threats", "Checks eight risk categories against dated evidence and scores supported exposures."),
    "pairwise": ("Pairwise", "Compares contenders head to head and ranks listings using evidence-backed judgments."),
}


class Definition(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    id: CustomKey
    name: Label
    summary: Annotated[str, StringConstraints(min_length=1, max_length=320)]
    sources: list[Source] = Field(min_length=1, max_length=3)
    inputs: Text
    prompt: Text
    columns: list[Label] = Field(min_length=2, max_length=16)
    target: RunModelTarget

    @model_validator(mode="after")
    def validate_fields(self):
        if len(set(self.sources)) != len(self.sources):
            raise ValueError("Choose each input source once")
        if self.columns[:2] != BASE_COLUMNS or len({c.casefold() for c in self.columns}) != len(self.columns):
            raise ValueError("Start with Listing and Score /100 and use unique column names")
        if any("|" in c or not c.isprintable() for c in self.columns):
            raise ValueError("Use single-line column names without pipe characters")
        if not self.target.provider.strip() or not self.target.model.strip():
            raise ValueError("Choose a provider and model")
        return self


class BoardChange(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    version: int = Field(ge=0)
    add: CardId | None = None
    definition: Definition | None = None
    weights: dict[CardId, Annotated[Decimal, Field(ge=0, le=100, decimal_places=2)]] = Field(min_length=1, max_length=64)

    @model_validator(mode="after")
    def check_allocation(self):
        if sum(self.weights.values()) != 100:
            raise ValueError("Weights must total exactly 100%")
        if self.definition and self.definition.id != self.add:
            raise ValueError("The definition must match the new scorecard")
        return self


async def read_board(db, owner, portfolio="india"):
    entry = (await db.execute(select(ActivityLog.id, ActivityLog.details).where(
        ActivityLog.user_id == owner, ActivityLog.action == ACTION,
        ActivityLog.resource_type == portfolio).order_by(ActivityLog.id.desc()).limit(1))).first()
    if entry:
        return {"version": entry.id, **json.loads(entry.details)}
    # Legacy Stage 3 always displayed all four cards. A previous final or Stage 3 execution
    # identifies a legacy board, including a board whose first run was only partial.
    stage = storage.Stage
    last = (await db.execute(select(stage.summary_json["result"]["policy"]["weights"]).join(Workflow).where(
        Workflow.user_id == owner, Workflow.portfolio == portfolio, storage.of_kind("final")
    ).order_by(stage.id.desc()).limit(1))).first()
    seen = last or await db.scalar(select(stage.id).join(Workflow).where(
        Workflow.user_id == owner, Workflow.portfolio == portfolio,
        storage.of_kind("attempt") | (stage.stage.in_(CARDS) & stage.status.in_(("completed","processing","partial","failed")))
    ).limit(1))
    weights = (last[0] if last and last[0] else DEFAULT_WEIGHTS) if seen else {}
    return {"version": 0, "enabled": list(CARDS) if seen else [], "weights": weights, "custom": []}


async def save_board(db, owner, change):
    await db.scalar(select(User.id).where(User.id == owner).with_for_update())
    board = await read_board(db, owner)
    if change.version != board["version"]:
        raise HTTPException(409, "Your board changed. Reload its weights and try again.")
    enabled = list(board["enabled"])
    custom = list(board["custom"])
    if change.add:
        if change.add in enabled:
            raise HTTPException(409, "This scorecard is already on your board.")
        if change.add not in CARDS and not change.definition:
            raise HTTPException(422, "Provide the new scorecard definition.")
        enabled.append(change.add)
        if change.definition:
            custom.append(change.definition.model_dump())
    if set(change.weights) != set(enabled):
        raise HTTPException(422, "Include every enabled scorecard and the new scorecard.")
    data = {"enabled": enabled, "weights": {k: float(change.weights[k]) for k in enabled}, "custom": custom}
    entry = ActivityLog(user_id=owner, action=ACTION, resource_type="india", details=json.dumps(data))
    db.add(entry)
    await db.flush()
    version = entry.id
    await db.commit()
    return {"version": version, **data}


def methodology(card):
    from .rebalance_output import instructions
    from .technical_output import COLUMNS, prompt as technical_prompt
    from .prompts import HEADERS, build_prompt
    from types import SimpleNamespace
    rev = SimpleNamespace(id="{revision}", digest="{revision_hash}", manifest={
        "market":"india", "as_of":"{cutoff_time}", "stocks":[], "evidence":[]})
    if card == "rebalance":
        prompt = instructions(rev.id, {"as_of":"{cutoff_time}", "listings":{}})
        inputs = "Frozen holdings and contenders, Swing theses, portfolio capital, dated price evidence and issuer filings."
        columns = HEADERS[card]
    elif card == "technical":
        prompt = technical_prompt(rev, [], {})
        inputs = "Verified listing identities, completed OHLCV sessions, benchmark history and setup evidence IDs."
        columns = COLUMNS
    elif card == "threats":
        prompt = build_prompt(rev, card, [], [], {"threat_version":2,"exposure_required":True})
        inputs = "Frozen listings, issuer disclosures, dated category sources and evidence linking each event to the company."
        columns = HEADERS[card]
    else:
        prompt = build_prompt(rev, card, [], [("A","B")], {"version":2,"packets":{}})
        inputs = "Assigned listing pairs, frozen evidence for each side, benchmark-relative features and dated catalysts."
        columns = ("Listing", "Assigned pairs", "Judged pairs", "Wins", "Ties", "Losses", "Pairwise score /100", "Coverage")
    # The final line is the per-run JSON evidence packet. Retain the shared instructions.
    prompt = "\n".join(line for line in prompt.rsplit("\n", 1)[0].splitlines() if not line.startswith("["))
    return {"id": card, "name": INTRO[card][0], "summary": INTRO[card][1], "inputs": inputs,
            "prompt": prompt.strip(), "columns": list(columns)}


async def present(db, owner, board):
    latest = {}
    if board["custom"]:
        stage = storage.Stage
        card = stage.summary_json["card"].as_string()
        from sqlalchemy import func
        ids = select(func.max(stage.id)).join(Workflow).where(Workflow.user_id == owner, Workflow.portfolio == "india",
            storage.of_kind("attempt"), card.in_([c["id"] for c in board["custom"]])).group_by(card)
        rows = await db.execute(select(card, stage.id, Workflow.sequence, stage.status).join(Workflow).where(stage.id.in_(ids)))
        latest = {key: {"id": i, "sequence": seq, "status": status} for key, i, seq, status in rows}

    return {**board, "latest": latest, "catalog": [{"id": key, "name": name, "summary": intro}
                                for key, (name, intro) in INTRO.items()]}
