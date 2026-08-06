from __future__ import annotations

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    content = read(path)
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f"Expected exactly one match in {path}, found {count}: {old[:120]!r}")
    write(path, content.replace(old, new, 1))


def insert_before(path: str, marker: str, text: str) -> None:
    content = read(path)
    index = content.find(marker)
    if index < 0:
        raise RuntimeError(f"Marker not found in {path}: {marker[:120]!r}")
    write(path, content[:index] + text + content[index:])


def append_once(path: str, marker: str, text: str) -> None:
    content = read(path)
    if marker in content:
        return
    write(path, content.rstrip() + "\n\n" + text.rstrip() + "\n")


# ---------------------------------------------------------------------------
# Backend: durable append-only history model and migration
# ---------------------------------------------------------------------------
replace_once(
    "backend/app/domains/runs/models.py",
    "from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, JSON, String, Text, UniqueConstraint",
    "from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Index, Integer, JSON, String, Text, UniqueConstraint",
)

insert_before(
    "backend/app/domains/runs/models.py",
    "\n\nclass AutoRebalanceWorkflow(Base, TimestampMixin):",
    r'''

class FinalActionableHistory(Base, TimestampMixin):
    """Immutable stock-level action captured for one completed rebalance run.

    Raw LLM output remains in ``jobs.response``.  This projection is deliberately
    append-only and queryable by stock so the dashboard never has to download
    every historical run merely to render one ticker's audit trail.
    """

    __tablename__ = "final_actionable_history"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "market",
            "rebalance_run_id",
            "stock_symbol",
            "formula_version",
            name="uq_final_actionable_history_run_stock_formula",
        ),
        Index(
            "ix_final_actionable_history_lookup",
            "user_id",
            "market",
            "stock_symbol",
            "covered_at",
            "id",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    workflow_id: Mapped[int | None] = mapped_column(
        ForeignKey("auto_rebalance_workflows.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    auto_rebalance_sequence: Mapped[int | None] = mapped_column(
        Integer, nullable=True, index=True
    )
    rebalance_run_id: Mapped[int] = mapped_column(
        ForeignKey("runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    market: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    stock_symbol: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    stock_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    covered_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )
    action: Mapped[str | None] = mapped_column(String(32), nullable=True)
    score: Mapped[float | None] = mapped_column(Float, nullable=True)
    consensus_numerator: Mapped[int | None] = mapped_column(Integer, nullable=True)
    consensus_denominator: Mapped[int | None] = mapped_column(Integer, nullable=True)
    historical_current_units: Mapped[float | None] = mapped_column(Float, nullable=True)
    historical_current_value: Mapped[float | None] = mapped_column(Float, nullable=True)
    action_units: Mapped[float | None] = mapped_column(Float, nullable=True)
    amount: Mapped[float | None] = mapped_column(Float, nullable=True)
    technical_scan_run_id: Mapped[int | None] = mapped_column(
        ForeignKey("runs.id", ondelete="SET NULL"), nullable=True, index=True
    )
    formula_version: Mapped[str] = mapped_column(
        String(64), nullable=False, default="score-matrix-v1"
    )
    formula_inputs_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    source_run_ids_json: Mapped[list | None] = mapped_column(JSON, nullable=True)
    snapshot_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    coverage_status: Mapped[str] = mapped_column(
        String(32), nullable=False, default="suggested", index=True
    )

    user: Mapped[User] = relationship()
''',
)

replace_once(
    "backend/app/models/__init__.py",
    "    AutoRebalanceWorkflowStage,\n    Run,\n    RunJob,\n)",
    "    AutoRebalanceWorkflowStage,\n    FinalActionableHistory,\n    Run,\n    RunJob,\n)",
)
replace_once(
    "backend/app/models/__init__.py",
    '    "AutoRebalanceWorkflowStage",\n    "Run",',
    '    "AutoRebalanceWorkflowStage",\n    "FinalActionableHistory",\n    "Run",',
)

write(
    "backend/alembic/versions/b5c6d7e8f9g0_add_final_actionable_history.py",
    r'''"""add durable final actionable history

Revision ID: b5c6d7e8f9g0
Revises: a4b5c6d7e8f9
Create Date: 2026-08-06
"""

from alembic import op
import sqlalchemy as sa

revision = "b5c6d7e8f9g0"
down_revision = "a4b5c6d7e8f9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "final_actionable_history",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("workflow_id", sa.Integer(), nullable=True),
        sa.Column("auto_rebalance_sequence", sa.Integer(), nullable=True),
        sa.Column("rebalance_run_id", sa.Integer(), nullable=False),
        sa.Column("market", sa.String(length=16), nullable=False),
        sa.Column("stock_symbol", sa.String(length=64), nullable=False),
        sa.Column("stock_name", sa.String(length=255), nullable=True),
        sa.Column("covered_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("action", sa.String(length=32), nullable=True),
        sa.Column("score", sa.Float(), nullable=True),
        sa.Column("consensus_numerator", sa.Integer(), nullable=True),
        sa.Column("consensus_denominator", sa.Integer(), nullable=True),
        sa.Column("historical_current_units", sa.Float(), nullable=True),
        sa.Column("historical_current_value", sa.Float(), nullable=True),
        sa.Column("action_units", sa.Float(), nullable=True),
        sa.Column("amount", sa.Float(), nullable=True),
        sa.Column("technical_scan_run_id", sa.Integer(), nullable=True),
        sa.Column("formula_version", sa.String(length=64), nullable=False),
        sa.Column("formula_inputs_json", sa.JSON(), nullable=True),
        sa.Column("source_run_ids_json", sa.JSON(), nullable=True),
        sa.Column("snapshot_json", sa.JSON(), nullable=True),
        sa.Column("coverage_status", sa.String(length=32), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["rebalance_run_id"], ["runs.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["technical_scan_run_id"], ["runs.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["workflow_id"], ["auto_rebalance_workflows.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id",
            "market",
            "rebalance_run_id",
            "stock_symbol",
            "formula_version",
            name="uq_final_actionable_history_run_stock_formula",
        ),
    )
    op.create_index(
        "ix_final_actionable_history_lookup",
        "final_actionable_history",
        ["user_id", "market", "stock_symbol", "covered_at", "id"],
        unique=False,
    )
    for column in (
        "id",
        "user_id",
        "workflow_id",
        "auto_rebalance_sequence",
        "rebalance_run_id",
        "market",
        "stock_symbol",
        "covered_at",
        "technical_scan_run_id",
        "coverage_status",
    ):
        op.create_index(
            f"ix_final_actionable_history_{column}",
            "final_actionable_history",
            [column],
            unique=False,
        )


def downgrade() -> None:
    op.drop_table("final_actionable_history")
''',
)

# ---------------------------------------------------------------------------
# Backend schemas and history service
# ---------------------------------------------------------------------------
insert_before(
    "backend/app/domains/runs/schemas.py",
    "\n\nclass RunCreate(BaseModel):",
    r'''

FinalActionableMarket = Literal["india", "us"]
FinalActionableCoverageStatus = Literal[
    "suggested",
    "not_mentioned",
    "not_in_input_universe",
    "run_failed",
    "parse_failed",
]


class FinalActionableHistoryCreateItem(BaseModel):
    workflow_id: int | None = Field(default=None, ge=1)
    auto_rebalance_sequence: int | None = Field(default=None, ge=1)
    rebalance_run_id: int = Field(ge=1)
    market: FinalActionableMarket
    stock_symbol: str = Field(min_length=1, max_length=64)
    stock_name: str | None = Field(default=None, max_length=255)
    covered_at: datetime
    action: str | None = Field(default=None, max_length=32)
    score: float | None = None
    consensus_numerator: int | None = Field(default=None, ge=0)
    consensus_denominator: int | None = Field(default=None, ge=0)
    historical_current_units: float | None = None
    historical_current_value: float | None = None
    action_units: float | None = None
    amount: float | None = None
    technical_scan_run_id: int | None = Field(default=None, ge=1)
    formula_version: str = Field(default="score-matrix-v1", min_length=1, max_length=64)
    formula_inputs_json: dict[str, Any] | None = None
    source_run_ids_json: list[int] = Field(default_factory=list)
    snapshot_json: dict[str, Any] | None = None
    coverage_status: FinalActionableCoverageStatus = "suggested"

    @field_validator("stock_symbol")
    @classmethod
    def normalize_stock_symbol(cls, value: str) -> str:
        normalized = value.strip().upper()
        if not normalized:
            raise ValueError("stock_symbol is required")
        return normalized


class FinalActionableHistoryBulkCreateRequest(BaseModel):
    items: list[FinalActionableHistoryCreateItem] = Field(min_length=1, max_length=500)


class FinalActionableHistoryBulkCreateResponse(BaseModel):
    inserted: int
    skipped: int
    coverage_inserted: int = 0


class FinalActionableHistoryItemResponse(BaseModel):
    id: int
    workflow_id: int | None = None
    auto_rebalance_sequence: int | None = None
    rebalance_run_id: int
    market: FinalActionableMarket
    stock_symbol: str
    stock_name: str | None = None
    covered_at: datetime
    action: str | None = None
    score: float | None = None
    consensus_numerator: int | None = None
    consensus_denominator: int | None = None
    historical_current_units: float | None = None
    historical_current_value: float | None = None
    action_units: float | None = None
    amount: float | None = None
    technical_scan_run_id: int | None = None
    formula_version: str
    formula_inputs_json: dict[str, Any] | None = None
    source_run_ids_json: list[int] | None = None
    snapshot_json: dict[str, Any] | None = None
    coverage_status: FinalActionableCoverageStatus
    created_at: datetime

    model_config = {"from_attributes": True}


class FinalActionableHistoryListResponse(BaseModel):
    items: list[FinalActionableHistoryItemResponse] = Field(default_factory=list)
    next_cursor: str | None = None
    has_more: bool = False


class FinalActionableHistoryBackfillResponse(BaseModel):
    status: Literal["queued", "already_queued"]
    task_id: str | None = None
''',
)

write(
    "backend/app/domains/runs/final_actionable_history.py",
    r'''from __future__ import annotations

import base64
from collections import Counter, defaultdict
from datetime import datetime, timezone
import json
import re
from typing import Iterable, Sequence

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session, selectinload

from app.domains.runs.models import FinalActionableHistory, Run, RunJob
from app.domains.runs.schemas import FinalActionableHistoryCreateItem

USABLE_STATUSES = {"completed", "partial"}
ACTION_HEADER_ALIASES = {
    "action",
    "action buy add sell all trim hold buy new",
    "recommendation",
    "suggested action",
}
ACTION_SCORE = {
    "Sell All": -2.0,
    "Trim": -1.0,
    "Hold": 0.0,
    "Add more": 1.0,
    "Buy New": 2.0,
}
ACTION_PRIORITY = ["Sell All", "Trim", "Hold", "Add more", "Buy New"]


def status_value(value: object) -> str:
    return str(getattr(value, "value", value or "")).lower()


def normalize_stock_symbol(value: str | None) -> str:
    symbol = (value or "").strip().upper()
    symbol = re.sub(r"^(?:NSE|BSE|NASDAQ|NYSE|NYSEARCA|AMEX|ARCA):", "", symbol)
    symbol = re.sub(r"\.(?:NS|BO|NSE|BSE)$", "", symbol)
    return symbol.strip()


def normalize_header(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def split_markdown_row(line: str) -> list[str]:
    return [cell.strip().strip("`") for cell in line.strip().strip("|").split("|")]


def is_separator_row(cells: Sequence[str]) -> bool:
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", cell.replace(" ", "")) for cell in cells)


def parse_markdown_action_rows(text: str | None) -> list[dict[str, str]]:
    """Extract stock/action rows from any markdown table in an LLM response."""
    if not text:
        return []
    lines = text.splitlines()
    output: list[dict[str, str]] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        if "|" not in line:
            index += 1
            continue
        raw_headers = split_markdown_row(line)
        headers = [normalize_header(header) for header in raw_headers]
        has_stock = any(
            header in {"stock symbol", "symbol", "ticker", "stock", "stock name"}
            for header in headers
        )
        has_action = any(
            header in ACTION_HEADER_ALIASES
            or ("action" in header and any(word in header for word in ("buy", "sell", "trim", "hold")))
            for header in headers
        )
        if not has_stock or not has_action:
            index += 1
            continue
        row_index = index + 1
        if row_index < len(lines) and is_separator_row(split_markdown_row(lines[row_index])):
            row_index += 1
        while row_index < len(lines) and "|" in lines[row_index]:
            cells = split_markdown_row(lines[row_index])
            if not is_separator_row(cells) and len(cells) >= 2:
                cells += [""] * max(0, len(headers) - len(cells))
                output.append({headers[i]: cells[i] for i in range(min(len(headers), len(cells)))})
            row_index += 1
        index = max(row_index, index + 1)
    return output


def row_value(row: dict[str, str], *aliases: str) -> str:
    for alias in aliases:
        normalized = normalize_header(alias)
        if normalized in row and row[normalized].strip():
            return row[normalized].strip()
    for key, value in row.items():
        if value.strip() and any(normalize_header(alias) in key for alias in aliases):
            return value.strip()
    return ""


def normalize_action(value: str | None) -> str | None:
    normalized = re.sub(r"[\s_-]+", " ", (value or "").lower()).strip()
    if not normalized:
        return None
    if "sell all" in normalized or normalized == "sell" or "exit" in normalized:
        return "Sell All"
    if "trim" in normalized or "reduce" in normalized:
        return "Trim"
    if "buy new" in normalized or "new buy" in normalized:
        return "Buy New"
    if "add" in normalized or "buy more" in normalized:
        return "Add more"
    if "hold" in normalized:
        return "Hold"
    return None


def parse_number(value: str | None) -> float | None:
    match = re.search(r"-?\d+(?:\.\d+)?", (value or "").replace(",", ""))
    if not match:
        return None
    parsed = float(match.group(0))
    return parsed if parsed == parsed and abs(parsed) != float("inf") else None


def average(values: Iterable[float | None]) -> float | None:
    present = [value for value in values if value is not None]
    return sum(present) / len(present) if present else None


def choose_mode(actions: Sequence[str]) -> str | None:
    if not actions:
        return None
    counts = Counter(actions)
    return max(ACTION_PRIORITY, key=lambda action: (counts[action], -ACTION_PRIORITY.index(action)))


def infer_market(run: Run) -> str | None:
    if run.auto_rebalance_portfolio == "india":
        return "india"
    if run.auto_rebalance_portfolio == "indmoney_us":
        return "us"
    prompt = run.prompt or ""
    if re.search(r"Market:\s*US equities|INDmoney|US portfolio", prompt, re.IGNORECASE):
        return "us"
    if re.search(r"Market:\s*India equities|Zerodha|India portfolio", prompt, re.IGNORECASE):
        return "india"
    return None


def is_rebalance_run(run: Run) -> bool:
    prompt = run.prompt or ""
    label = run.auto_rebalance_label or ""
    if "## Technical Scan Input Bundle" in prompt:
        return False
    return bool(
        "## Rebalance Input Bundle" in prompt
        or "[rebalance_flow:" in prompt
        or re.search(r"rebalance scan", label, re.IGNORECASE)
    )


def encode_history_cursor(covered_at: datetime, row_id: int) -> str:
    raw = json.dumps({"covered_at": covered_at.isoformat(), "id": row_id}, separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def decode_history_cursor(cursor: str) -> tuple[datetime, int]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode()).decode())
        covered_at = datetime.fromisoformat(str(payload["covered_at"]))
        if covered_at.tzinfo is None:
            covered_at = covered_at.replace(tzinfo=timezone.utc)
        return covered_at, int(payload["id"])
    except (ValueError, TypeError, KeyError, json.JSONDecodeError) as exc:
        raise ValueError("Invalid history cursor") from exc


async def persist_history_items(
    db: AsyncSession,
    *,
    user_id: int,
    items: Sequence[FinalActionableHistoryCreateItem],
) -> tuple[int, int, int]:
    run_ids = {item.rebalance_run_id for item in items}
    technical_ids = {item.technical_scan_run_id for item in items if item.technical_scan_run_id}
    all_run_ids = run_ids | technical_ids
    owned_ids = set(
        (await db.execute(select(Run.id).where(Run.user_id == user_id, Run.id.in_(all_run_ids))))
        .scalars()
        .all()
    )
    if owned_ids != all_run_ids:
        raise ValueError("One or more referenced runs do not belong to the current user")

    submitted_keys = {
        (item.market, item.rebalance_run_id, normalize_stock_symbol(item.stock_symbol), item.formula_version)
        for item in items
    }
    existing_rows = (
        await db.execute(
            select(FinalActionableHistory).where(
                FinalActionableHistory.user_id == user_id,
                FinalActionableHistory.rebalance_run_id.in_(run_ids),
            )
        )
    ).scalars().all()
    existing_keys = {
        (row.market, row.rebalance_run_id, row.stock_symbol, row.formula_version)
        for row in existing_rows
    }

    inserted = 0
    skipped = 0
    run_templates: dict[tuple[str, int], FinalActionableHistoryCreateItem] = {}
    submitted_symbols: dict[tuple[str, int], set[str]] = defaultdict(set)
    for item in items:
        symbol = normalize_stock_symbol(item.stock_symbol)
        key = (item.market, item.rebalance_run_id, symbol, item.formula_version)
        run_key = (item.market, item.rebalance_run_id)
        run_templates.setdefault(run_key, item)
        submitted_symbols[run_key].add(symbol)
        if key in existing_keys:
            skipped += 1
            continue
        db.add(
            FinalActionableHistory(
                user_id=user_id,
                workflow_id=item.workflow_id,
                auto_rebalance_sequence=item.auto_rebalance_sequence,
                rebalance_run_id=item.rebalance_run_id,
                market=item.market,
                stock_symbol=symbol,
                stock_name=item.stock_name,
                covered_at=item.covered_at,
                action=item.action,
                score=item.score,
                consensus_numerator=item.consensus_numerator,
                consensus_denominator=item.consensus_denominator,
                historical_current_units=item.historical_current_units,
                historical_current_value=item.historical_current_value,
                action_units=item.action_units,
                amount=item.amount,
                technical_scan_run_id=item.technical_scan_run_id,
                formula_version=item.formula_version,
                formula_inputs_json=item.formula_inputs_json,
                source_run_ids_json=item.source_run_ids_json,
                snapshot_json=item.snapshot_json,
                coverage_status=item.coverage_status,
            )
        )
        existing_keys.add(key)
        inserted += 1

    # Keep an explicit date/run trail for every previously observed symbol.
    # Missing symbols are labelled only as "not mentioned"; the projection does
    # not pretend they were necessarily in that run's input universe.
    known_rows = (
        await db.execute(
            select(FinalActionableHistory.market, FinalActionableHistory.stock_symbol)
            .where(FinalActionableHistory.user_id == user_id)
            .distinct()
        )
    ).all()
    known_by_market: dict[str, set[str]] = defaultdict(set)
    for market, symbol in known_rows:
        known_by_market[market].add(symbol)
    for item in items:
        known_by_market[item.market].add(normalize_stock_symbol(item.stock_symbol))

    coverage_inserted = 0
    for (market, run_id), template in run_templates.items():
        for symbol in sorted(known_by_market[market] - submitted_symbols[(market, run_id)]):
            key = (market, run_id, symbol, "coverage-v1")
            if key in existing_keys:
                continue
            db.add(
                FinalActionableHistory(
                    user_id=user_id,
                    workflow_id=template.workflow_id,
                    auto_rebalance_sequence=template.auto_rebalance_sequence,
                    rebalance_run_id=run_id,
                    market=market,
                    stock_symbol=symbol,
                    covered_at=template.covered_at,
                    formula_version="coverage-v1",
                    source_run_ids_json=[run_id],
                    coverage_status="not_mentioned",
                    snapshot_json={"reason": "Stock was not mentioned in persisted output rows."},
                )
            )
            existing_keys.add(key)
            coverage_inserted += 1

    await db.commit()
    return inserted, skipped, coverage_inserted


async def list_stock_history(
    db: AsyncSession,
    *,
    user_id: int,
    market: str,
    symbol: str,
    limit: int,
    cursor: str | None,
) -> tuple[list[FinalActionableHistory], str | None, bool]:
    normalized_symbol = normalize_stock_symbol(symbol)
    conditions = [
        FinalActionableHistory.user_id == user_id,
        FinalActionableHistory.market == market,
        FinalActionableHistory.stock_symbol == normalized_symbol,
    ]
    if cursor:
        covered_at, row_id = decode_history_cursor(cursor)
        conditions.append(
            or_(
                FinalActionableHistory.covered_at < covered_at,
                and_(
                    FinalActionableHistory.covered_at == covered_at,
                    FinalActionableHistory.id < row_id,
                ),
            )
        )
    rows = list(
        (
            await db.execute(
                select(FinalActionableHistory)
                .where(*conditions)
                .order_by(
                    FinalActionableHistory.covered_at.desc(),
                    FinalActionableHistory.id.desc(),
                )
                .limit(limit + 1)
            )
        )
        .scalars()
        .all()
    )
    has_more = len(rows) > limit
    items = rows[:limit]
    next_cursor = (
        encode_history_cursor(items[-1].covered_at, items[-1].id)
        if has_more and items
        else None
    )
    return items, next_cursor, has_more


def _run_projection(run: Run) -> tuple[dict[str, dict], bool]:
    grouped: dict[str, list[dict]] = defaultdict(list)
    usable_output_seen = False
    for link in run.run_jobs:
        job = link.job
        if not job or status_value(job.status) not in USABLE_STATUSES or not job.response:
            continue
        usable_output_seen = True
        for row in parse_markdown_action_rows(job.response):
            symbol = normalize_stock_symbol(
                row_value(row, "Stock Symbol", "Ticker", "Symbol", "Stock", "Stock Name")
            )
            action = normalize_action(row_value(row, *ACTION_HEADER_ALIASES))
            if not symbol or not action:
                continue
            grouped[symbol].append(
                {
                    "job_id": job.id,
                    "provider": job.provider,
                    "model": job.model,
                    "stock_name": row_value(row, "Stock Name"),
                    "action": action,
                    "score": average(
                        parse_number(value)
                        for key, value in row.items()
                        if key.startswith("score rationale")
                    ),
                    "current_units": parse_number(row_value(row, "Current Units")),
                    "current_value": parse_number(
                        row_value(row, "Current Value", "Current Investment Amount")
                    ),
                    "action_units": parse_number(
                        row_value(row, "Units to Sell Buy", "Units Change", "Units to Buy")
                    ),
                    "amount": parse_number(row_value(row, "Amount", "Total Buy Amount")),
                    "raw": row,
                }
            )

    projection: dict[str, dict] = {}
    for symbol, rows in grouped.items():
        actions = [row["action"] for row in rows]
        action = choose_mode(actions)
        rationale_score = average(row["score"] for row in rows)
        score = rationale_score
        if score is None:
            score = average(ACTION_SCORE.get(row["action"]) for row in rows)
        projection[symbol] = {
            "stock_name": next((row["stock_name"] for row in rows if row["stock_name"]), None),
            "action": action,
            "score": score,
            "consensus_numerator": actions.count(action) if action else None,
            "consensus_denominator": len(actions),
            "historical_current_units": average(row["current_units"] for row in rows),
            "historical_current_value": average(row["current_value"] for row in rows),
            "action_units": average(row["action_units"] for row in rows),
            "amount": average(row["amount"] for row in rows),
            "source_job_ids": sorted({row["job_id"] for row in rows}),
            "rows": rows,
        }
    return projection, usable_output_seen


def backfill_user_history(db: Session, *, user_id: int) -> dict[str, int]:
    runs = list(
        db.execute(
            select(Run)
            .where(Run.user_id == user_id)
            .options(selectinload(Run.run_jobs).selectinload(RunJob.job))
            .order_by(Run.created_at.asc(), Run.id.asc())
        ).scalars().all()
    )
    eligible = [run for run in runs if is_rebalance_run(run) and infer_market(run)]
    projections: list[tuple[Run, str, dict[str, dict], bool]] = []
    known_by_market: dict[str, set[str]] = defaultdict(set)
    for run in eligible:
        market = infer_market(run)
        if not market:
            continue
        projection, usable_output_seen = _run_projection(run)
        known_by_market[market].update(projection)
        projections.append((run, market, projection, usable_output_seen))

    existing = {
        (row.market, row.rebalance_run_id, row.stock_symbol, row.formula_version)
        for row in db.execute(
            select(FinalActionableHistory).where(FinalActionableHistory.user_id == user_id)
        ).scalars().all()
    }
    inserted = 0
    coverage_inserted = 0
    for run, market, projection, usable_output_seen in projections:
        for symbol in sorted(known_by_market[market]):
            data = projection.get(symbol)
            if data:
                formula_version = "legacy-backfill-v1"
                coverage_status = "suggested"
            else:
                formula_version = "coverage-v1"
                if status_value(run.status) == "failed":
                    coverage_status = "run_failed"
                elif usable_output_seen:
                    coverage_status = "not_mentioned"
                else:
                    coverage_status = "parse_failed"
            key = (market, run.id, symbol, formula_version)
            if key in existing:
                continue
            db.add(
                FinalActionableHistory(
                    user_id=user_id,
                    auto_rebalance_sequence=run.auto_rebalance_sequence,
                    rebalance_run_id=run.id,
                    market=market,
                    stock_symbol=symbol,
                    stock_name=data.get("stock_name") if data else None,
                    covered_at=run.created_at,
                    action=data.get("action") if data else None,
                    score=data.get("score") if data else None,
                    consensus_numerator=data.get("consensus_numerator") if data else None,
                    consensus_denominator=data.get("consensus_denominator") if data else None,
                    historical_current_units=data.get("historical_current_units") if data else None,
                    historical_current_value=data.get("historical_current_value") if data else None,
                    action_units=data.get("action_units") if data else None,
                    amount=data.get("amount") if data else None,
                    formula_version=formula_version,
                    formula_inputs_json={
                        "parser": "legacy-markdown-backfill-v1",
                        "source_job_ids": data.get("source_job_ids", []) if data else [],
                    },
                    source_run_ids_json=[run.id],
                    snapshot_json={
                        "source": "legacy-backfill",
                        "rows": data.get("rows", []) if data else [],
                        "reason": None if data else coverage_status,
                    },
                    coverage_status=coverage_status,
                )
            )
            existing.add(key)
            if data:
                inserted += 1
            else:
                coverage_inserted += 1
            if (inserted + coverage_inserted) % 250 == 0:
                db.flush()
    db.commit()
    return {
        "runs_scanned": len(eligible),
        "suggestions_inserted": inserted,
        "coverage_inserted": coverage_inserted,
    }
''',
)

# ---------------------------------------------------------------------------
# Backend routes and task
# ---------------------------------------------------------------------------
replace_once(
    "backend/app/domains/runs/router.py",
    "    AutoRebalanceWorkflowStage,\n    Run,\n    RunJob,\n)",
    "    AutoRebalanceWorkflowStage,\n    FinalActionableHistory,\n    Run,\n    RunJob,\n)",
)
replace_once(
    "backend/app/domains/runs/router.py",
    "    AutoRebalanceStageUpdateRequest,\n    RunCreate,",
    "    AutoRebalanceStageUpdateRequest,\n    FinalActionableHistoryBackfillResponse,\n    FinalActionableHistoryBulkCreateRequest,\n    FinalActionableHistoryBulkCreateResponse,\n    FinalActionableHistoryListResponse,\n    RunCreate,",
)
insert_before(
    "backend/app/domains/runs/router.py",
    "from app.domains.runs.use_cases.create_run import (",
    "from app.domains.runs.final_actionable_history import (\n"
    "    list_stock_history,\n"
    "    persist_history_items,\n"
    ")\n",
)

insert_before(
    "backend/app/domains/runs/router.py",
    '\n\n@router.post("/auto-rebalance-label"',
    r'''

@router.get(
    "/final-actionables/history",
    response_model=FinalActionableHistoryListResponse,
)
async def get_final_actionable_history(
    market: str = Query(..., pattern="^(india|us)$"),
    symbol: str = Query(..., min_length=1, max_length=64),
    limit: int = Query(default=50, ge=1, le=200),
    cursor: str | None = Query(default=None),
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    try:
        items, next_cursor, has_more = await list_stock_history(
            db,
            user_id=current_user.id,
            market=market,
            symbol=symbol,
            limit=limit,
            cursor=cursor,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return FinalActionableHistoryListResponse(
        items=items,
        next_cursor=next_cursor,
        has_more=has_more,
    )


@router.post(
    "/final-actionables/history",
    response_model=FinalActionableHistoryBulkCreateResponse,
)
async def save_final_actionable_history(
    body: FinalActionableHistoryBulkCreateRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    try:
        inserted, skipped, coverage_inserted = await persist_history_items(
            db,
            user_id=current_user.id,
            items=body.items,
        )
    except ValueError as exc:
        await db.rollback()
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return FinalActionableHistoryBulkCreateResponse(
        inserted=inserted,
        skipped=skipped,
        coverage_inserted=coverage_inserted,
    )


@router.post(
    "/final-actionables/history/backfill",
    response_model=FinalActionableHistoryBackfillResponse,
)
async def queue_final_actionable_history_backfill(
    current_user: User = Depends(get_current_user),
):
    redis = _get_redis()
    dedupe_key = f"final_actionable_history_backfill:{current_user.id}"
    try:
        queued = await redis.set(dedupe_key, "1", nx=True, ex=60 * 60)
    finally:
        await redis.aclose()
    if not queued:
        return FinalActionableHistoryBackfillResponse(status="already_queued")

    from app.domains.runs.tasks import backfill_final_actionable_history_task

    task = backfill_final_actionable_history_task.delay(current_user.id)
    return FinalActionableHistoryBackfillResponse(status="queued", task_id=task.id)
''',
)

replace_once(
    "backend/app/domains/runs/tasks.py",
    "from app.domains.runs.models import Run, RunJob",
    "from app.domains.runs.final_actionable_history import backfill_user_history\nfrom app.domains.runs.models import Run, RunJob",
)
append_once(
    "backend/app/domains/runs/tasks.py",
    "def backfill_final_actionable_history_task(",
    r'''
@celery.task(
    bind=True,
    max_retries=1,
    default_retry_delay=120,
    name="app.domains.runs.tasks.backfill_final_actionable_history_task",
    queue="ai",
)
def backfill_final_actionable_history_task(self, user_id: int) -> dict[str, int]:
    with SyncSessionLocal() as db:
        try:
            result = backfill_user_history(db, user_id=user_id)
            logger.info("Final actionable history backfill completed for user %s: %s", user_id, result)
            return result
        except Exception as exc:
            db.rollback()
            logger.exception("Final actionable history backfill failed for user %s", user_id)
            raise self.retry(exc=exc)
''',
)
replace_once(
    "backend/app/infrastructure/messaging/celery_app.py",
    '    "app.domains.runs.tasks.*": {"queue": "email"},',
    '    "app.domains.runs.tasks.backfill_final_actionable_history_task": {"queue": "ai"},\n'
    '    "app.domains.runs.tasks.*": {"queue": "email"},',
)

# ---------------------------------------------------------------------------
# Frontend API contracts
# ---------------------------------------------------------------------------
append_once(
    "frontend/types/api.ts",
    "export type FinalActionableHistoryCoverageStatus",
    r'''
export type FinalActionableHistoryCoverageStatus =
  | "suggested"
  | "not_mentioned"
  | "not_in_input_universe"
  | "run_failed"
  | "parse_failed";

export type FinalActionableHistoryItem = {
  id: number;
  workflow_id: number | null;
  auto_rebalance_sequence: number | null;
  rebalance_run_id: number;
  market: "india" | "us";
  stock_symbol: string;
  stock_name: string | null;
  covered_at: string;
  action: string | null;
  score: number | null;
  consensus_numerator: number | null;
  consensus_denominator: number | null;
  historical_current_units: number | null;
  historical_current_value: number | null;
  action_units: number | null;
  amount: number | null;
  technical_scan_run_id: number | null;
  formula_version: string;
  formula_inputs_json: Record<string, unknown> | null;
  source_run_ids_json: number[] | null;
  snapshot_json: Record<string, unknown> | null;
  coverage_status: FinalActionableHistoryCoverageStatus;
  created_at: string;
};

export type FinalActionableHistoryListResponse = {
  items: FinalActionableHistoryItem[];
  next_cursor: string | null;
  has_more: boolean;
};

export type FinalActionableHistoryCreateItem = Omit<
  FinalActionableHistoryItem,
  "id" | "created_at"
>;

export type FinalActionableHistoryBulkCreateRequest = {
  items: FinalActionableHistoryCreateItem[];
};

export type FinalActionableHistoryBulkCreateResponse = {
  inserted: number;
  skipped: number;
  coverage_inserted: number;
};

export type FinalActionableHistoryBackfillResponse = {
  status: "queued" | "already_queued";
  task_id: string | null;
};
''',
)

replace_once(
    "frontend/lib/urls.ts",
    "    autoRebalanceCompletionEmail: () => `${resolveApiBaseUrl()}/runs/auto-rebalance-completion-email`,",
    "    autoRebalanceCompletionEmail: () => `${resolveApiBaseUrl()}/runs/auto-rebalance-completion-email`,\n"
    "    finalActionableHistory: () => `${resolveApiBaseUrl()}/runs/final-actionables/history`,\n"
    "    finalActionableHistoryBackfill: () => `${resolveApiBaseUrl()}/runs/final-actionables/history/backfill`,",
)

# Add imports to both service files.
for api_path in ("frontend/services/api.ts", "frontend/services/api.types.ts"):
    replace_once(
        api_path,
        "    AutoRebalanceStageUpdateRequest,",
        "    AutoRebalanceStageUpdateRequest,\n"
        "    FinalActionableHistoryBackfillResponse,\n"
        "    FinalActionableHistoryBulkCreateRequest,\n"
        "    FinalActionableHistoryBulkCreateResponse,\n"
        "    FinalActionableHistoryListResponse,",
    )

insert_before(
    "frontend/services/api.types.ts",
    "    getAutoRebalanceHistory(\n",
    r'''    getFinalActionableHistory(params: {
        market: "india" | "us";
        symbol: string;
        limit?: number;
        cursor?: string | null;
    }): Promise<FinalActionableHistoryListResponse>;
    saveFinalActionableHistory(
        data: FinalActionableHistoryBulkCreateRequest,
    ): Promise<FinalActionableHistoryBulkCreateResponse>;
    queueFinalActionableHistoryBackfill(): Promise<FinalActionableHistoryBackfillResponse>;
''',
)

# Insert class methods immediately before the existing auto-rebalance history method.
insert_before(
    "frontend/services/api.ts",
    "  async getAutoRebalanceHistory(\n",
    r'''  async getFinalActionableHistory(params: {
    market: "india" | "us";
    symbol: string;
    limit?: number;
    cursor?: string | null;
  }): Promise<FinalActionableHistoryListResponse> {
    const query = new URLSearchParams({
      market: params.market,
      symbol: params.symbol,
      limit: String(params.limit ?? 50),
    });
    if (params.cursor) query.set("cursor", params.cursor);
    return this.fetch<FinalActionableHistoryListResponse>(
      `${URLs.runs.finalActionableHistory()}?${query.toString()}`,
    );
  }

  async saveFinalActionableHistory(
    data: FinalActionableHistoryBulkCreateRequest,
  ): Promise<FinalActionableHistoryBulkCreateResponse> {
    return this.fetch<FinalActionableHistoryBulkCreateResponse>(
      URLs.runs.finalActionableHistory(),
      { method: "POST", body: JSON.stringify(data) },
    );
  }

  async queueFinalActionableHistoryBackfill(): Promise<FinalActionableHistoryBackfillResponse> {
    return this.fetch<FinalActionableHistoryBackfillResponse>(
      URLs.runs.finalActionableHistoryBackfill(),
      { method: "POST" },
    );
  }

''',
)

# ---------------------------------------------------------------------------
# Frontend history persistence, cache merging, and stock-specific pagination
# ---------------------------------------------------------------------------
replace_once(
    "frontend/app/console/_components/FinalActionablesConsole.tsx",
    "  IndMoneyUsThreatAnalysis,\n  PortfolioAnalysisHistoryItem,",
    "  IndMoneyUsThreatAnalysis,\n"
    "  FinalActionableHistoryCreateItem,\n"
    "  FinalActionableHistoryItem,\n"
    "  PortfolioAnalysisHistoryItem,",
)
replace_once(
    "frontend/app/console/_components/FinalActionablesConsole.tsx",
    "const HISTORICAL_ACTION_ROWS_CACHE_VERSION = 1;",
    "const HISTORICAL_ACTION_ROWS_CACHE_VERSION = 2;",
)

insert_before(
    "frontend/app/console/_components/FinalActionablesConsole.tsx",
    "\nfunction writeHistoricalActionRowsCache(market: SwingTradeMarket, rows: HistoricalDashboardActionRow[]) {",
    r'''
function getHistoricalActionRowCacheId(row: HistoricalDashboardActionRow) {
  return `${row.market}:${row.runId}:${normalizeStockSymbol(row.stock.symbol || row.stock.key)}`;
}

function mergeHistoricalActionRows(
  ...rowGroups: HistoricalDashboardActionRow[][]
) {
  const merged = new Map<string, HistoricalDashboardActionRow>();
  rowGroups.flat().forEach((row) => {
    const key = getHistoricalActionRowCacheId(row);
    const existing = merged.get(key);
    if (!existing || parseTimestampMs(row.coveredAt) >= parseTimestampMs(existing.coveredAt)) {
      merged.set(key, row);
    }
  });
  return Array.from(merged.values()).sort(
    (left, right) => parseTimestampMs(right.coveredAt) - parseTimestampMs(left.coveredAt),
  );
}
''',
)
replace_once(
    "frontend/app/console/_components/FinalActionablesConsole.tsx",
    "    const cacheableRows = rows.slice(0, HISTORICAL_ACTION_ROWS_CACHE_LIMIT);",
    "    const cacheableRows = mergeHistoricalActionRows(\n"
    "      rows,\n"
    "      readHistoricalActionRowsCache(market),\n"
    "    ).slice(0, HISTORICAL_ACTION_ROWS_CACHE_LIMIT);",
)
replace_once(
    "frontend/app/console/_components/FinalActionablesConsole.tsx",
    "  const effectiveHistoricalRows = useMemo(\n    () => (historicalRows.length ? historicalRows : readHistoricalActionRowsCache(market)),\n    [historicalRows, market],\n  );",
    "  const effectiveHistoricalRows = useMemo(\n"
    "    () => mergeHistoricalActionRows(historicalRows, readHistoricalActionRowsCache(market)),\n"
    "    [historicalRows, market],\n"
    "  );",
)

# Stock popup state and stock-specific history loader.
replace_once(
    "frontend/app/console/_components/FinalActionablesConsole.tsx",
    "  const [zerodhaOrdersError, setZerodhaOrdersError] = useState<string | null>(null);\n  const { dragHandleProps, draggableStyle } = useDraggablePopup();",
    "  const [zerodhaOrdersError, setZerodhaOrdersError] = useState<string | null>(null);\n"
    "  const [persistedHistory, setPersistedHistory] = useState<FinalActionableHistoryItem[]>([]);\n"
    "  const [historyCursor, setHistoryCursor] = useState<string | null>(null);\n"
    "  const [historyHasMore, setHistoryHasMore] = useState(false);\n"
    "  const [historyLoading, setHistoryLoading] = useState(false);\n"
    "  const [historyError, setHistoryError] = useState<string | null>(null);\n"
    "  const { dragHandleProps, draggableStyle } = useDraggablePopup();",
)

replace_once(
    "frontend/app/console/_components/FinalActionablesConsole.tsx",
    "  const matchingHistoricalRows = useMemo(\n    () => effectiveHistoricalRows.filter((row) => stockConsensusMatches(row.stock, stock)),\n    [effectiveHistoricalRows, stock],\n  );",
    r'''  const persistedRunIds = useMemo(
    () => new Set(persistedHistory.map((item) => item.rebalance_run_id)),
    [persistedHistory],
  );
  const matchingHistoricalRows = useMemo(
    () => effectiveHistoricalRows.filter(
      (row) => stockConsensusMatches(row.stock, stock) && !persistedRunIds.has(row.runId),
    ),
    [effectiveHistoricalRows, persistedRunIds, stock],
  );
  const loadPersistedHistory = useCallback(async (cursor: string | null, append: boolean) => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const response = await apiService.getFinalActionableHistory({
        market,
        symbol: stock.symbol,
        limit: 50,
        cursor,
      });
      setPersistedHistory((current) => append ? [...current, ...response.items] : response.items);
      setHistoryCursor(response.next_cursor);
      setHistoryHasMore(response.has_more);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "Unable to load complete stock history.");
    } finally {
      setHistoryLoading(false);
    }
  }, [market, stock.symbol]);
''',
)

# Add opening effect before Zerodha order effect.
insert_before(
    "frontend/app/console/_components/FinalActionablesConsole.tsx",
    "  useEffect(() => {\n    if (!open || market !== \"india\" || !zerodhaHolding) return;",
    r'''  useEffect(() => {
    if (!open) return;
    setPersistedHistory([]);
    setHistoryCursor(null);
    setHistoryHasMore(false);
    void loadPersistedHistory(null, false);
  }, [loadPersistedHistory, open]);

''',
)

# Add server history table directly beneath the section heading.
replace_once(
    "frontend/app/console/_components/FinalActionablesConsole.tsx",
    '                <h3 className="mb-3 font-semibold text-slate-950">Historical LLM suggestions</h3>\n                {matchingHistoricalRows.length ? (',
    r'''                <h3 className="mb-3 font-semibold text-slate-950">Historical LLM suggestions</h3>
                {historyError ? (
                  <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-800">
                    Complete server history could not be loaded: {historyError}. Recent locally reconstructed rows remain below.
                  </div>
                ) : null}
                {historyLoading && persistedHistory.length === 0 ? (
                  <div className="mb-3 rounded-lg border border-slate-200 bg-white p-3 text-slate-500">
                    Loading complete historical suggestions…
                  </div>
                ) : null}
                {persistedHistory.length ? (
                  <div className="mb-3 overflow-x-auto rounded-lg border border-slate-200 bg-white/90">
                    <table className="min-w-[72rem] text-xs">
                      <thead>
                        <tr className="border-b border-gray-200 bg-slate-50 text-left text-[11px] uppercase tracking-wide text-gray-500">
                          <th className="px-3 py-2 font-semibold">Stock</th>
                          <th className="px-3 py-2 font-semibold">Timestamp covered</th>
                          <th className="px-3 py-2 font-semibold">Coverage</th>
                          <th className="px-3 py-2 font-semibold">Action</th>
                          <th className="px-3 py-2 font-semibold">Score</th>
                          <th className="px-3 py-2 font-semibold">Consensus</th>
                          <th className="px-3 py-2 font-semibold">Historical value</th>
                          <th className="px-3 py-2 font-semibold">Action/current units</th>
                          <th className="px-3 py-2 font-semibold">Amount</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {persistedHistory.map((item) => (
                          <tr key={item.id} className={item.coverage_status === "suggested" ? "bg-white" : "bg-slate-50/70"}>
                            <td className="whitespace-nowrap px-3 py-2 font-medium text-slate-900">{item.stock_symbol}</td>
                            <td className="whitespace-nowrap px-3 py-2 text-gray-700">
                              <RunJobLink runId={item.rebalance_run_id}>{formatDateTime(item.covered_at)}</RunJobLink>
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 capitalize text-gray-600">{item.coverage_status.replaceAll("_", " ")}</td>
                            <td className="px-3 py-2"><FinalActionValue value={item.action} /></td>
                            <td className="whitespace-nowrap px-3 py-2 text-gray-700">{formatScoreValue(item.score)}</td>
                            <td className="whitespace-nowrap px-3 py-2 text-gray-700">
                              {item.consensus_numerator !== null && item.consensus_denominator !== null
                                ? `${item.consensus_numerator}/${item.consensus_denominator}`
                                : "—"}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 text-gray-700">{formatDisplayAmount(item.historical_current_value, market)}</td>
                            <td className="whitespace-nowrap px-3 py-2 text-gray-700">
                              {`${formatQuantity(item.action_units)}/${formatQuantity(item.historical_current_units)}`}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 text-gray-700">{formatDisplayAmount(item.amount, market)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {historyHasMore ? (
                      <div className="border-t border-slate-200 p-3 text-center">
                        <Button
                          type="button"
                          variant="outline"
                          disabled={historyLoading || !historyCursor}
                          onClick={() => void loadPersistedHistory(historyCursor, true)}
                        >
                          {historyLoading ? "Loading…" : "Load older suggestions"}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {matchingHistoricalRows.length ? (''',
)

# Serialize immutable history snapshots from client calculations.
insert_before(
    "frontend/app/console/_components/FinalActionablesConsole.tsx",
    "\nfunction getDefaultDashboardActionSortState(action: ActionCategory): DashboardActionSortState {",
    r'''
function buildFinalActionableHistoryItems(
  rows: HistoricalDashboardActionRow[],
  runs: RunResponse[],
): FinalActionableHistoryCreateItem[] {
  const runsById = new Map(runs.map((run) => [run.id, run]));
  return rows.map((row) => {
    const sourceRun = runsById.get(row.runId);
    const action = row.formulaAction;
    const estimate = row.formulaEstimate;
    const sourceRunIds = Array.from(new Set([
      row.runId,
      ...row.stock.rows.map((stockRow) => stockRow.meta.runId),
      ...(row.detail.technicalScanSourceRunId ? [row.detail.technicalScanSourceRunId] : []),
    ]));
    return {
      workflow_id: null,
      auto_rebalance_sequence: sourceRun?.auto_rebalance_sequence ?? null,
      rebalance_run_id: row.runId,
      market: row.market,
      stock_symbol: normalizeStockSymbol(row.stock.symbol || row.stock.key),
      stock_name: row.stock.representative["Stock Name"] || row.stock.symbol || null,
      covered_at: row.coveredAt,
      action,
      score: row.formulaScore,
      consensus_numerator: row.stock.actionCounts[action],
      consensus_denominator: row.stock.totalSuggestions,
      historical_current_units: estimate.currentUnits,
      historical_current_value: estimate.currentInvestmentAmount,
      action_units: estimate.units,
      amount: estimate.amount,
      technical_scan_run_id: row.detail.technicalScanSourceRunId,
      formula_version: "score-matrix-v1",
      formula_inputs_json: row.detail as unknown as Record<string, unknown>,
      source_run_ids_json: sourceRunIds,
      snapshot_json: {
        representative: row.stock.representative,
        action_counts: row.stock.actionCounts,
        formula_action: row.formulaAction,
        formula_score: row.formulaScore,
        formula_estimate: row.formulaEstimate,
      },
      coverage_status: "suggested",
    };
  });
}

async function persistFinalActionableHistoryRows(
  rows: HistoricalDashboardActionRow[],
  runs: RunResponse[],
) {
  const items = buildFinalActionableHistoryItems(rows, runs);
  for (let index = 0; index < items.length; index += 100) {
    await apiService.saveFinalActionableHistory({ items: items.slice(index, index + 100) });
  }
}
''',
)

# Dashboard persistence and backfill queue effect after current cache effect.
replace_once(
    "frontend/app/console/_components/FinalActionablesConsole.tsx",
    "  useEffect(() => {\n    if (!runs.length) return;\n    writeHistoricalActionRowsCache(\"india\", historicalActionRowsByMarket.india);\n    writeHistoricalActionRowsCache(\"us\", historicalActionRowsByMarket.us);\n  }, [historicalActionRowsByMarket, runs.length]);",
    r'''  useEffect(() => {
    if (!runs.length) return;
    writeHistoricalActionRowsCache("india", historicalActionRowsByMarket.india);
    writeHistoricalActionRowsCache("us", historicalActionRowsByMarket.us);
    const allRows = [
      ...historicalActionRowsByMarket.india,
      ...historicalActionRowsByMarket.us,
    ];
    if (allRows.length) {
      void persistFinalActionableHistoryRows(allRows, runs).catch((error) => {
        console.warn("Failed to persist immutable final actionables history:", error);
      });
    }
    void apiService.queueFinalActionableHistoryBackfill().catch((error) => {
      console.warn("Unable to queue legacy final actionables history backfill:", error);
    });
  }, [historicalActionRowsByMarket, runs]);''',
)

# Full history page persistence effect.
replace_once(
    "frontend/app/console/_components/FinalActionablesConsole.tsx",
    "  useEffect(() => {\n    if (!runs.length) return;\n    writeHistoricalActionRowsCache(market, historicalActionRows);\n  }, [historicalActionRows, market, runs.length]);",
    r'''  useEffect(() => {
    if (!runs.length) return;
    writeHistoricalActionRowsCache(market, historicalActionRows);
    if (historicalActionRows.length) {
      void persistFinalActionableHistoryRows(historicalActionRows, runs).catch((error) => {
        console.warn("Failed to persist immutable final actionables history:", error);
      });
    }
    void apiService.queueFinalActionableHistoryBackfill().catch((error) => {
      console.warn("Unable to queue legacy final actionables history backfill:", error);
    });
  }, [historicalActionRows, market, runs]);''',
)

# ---------------------------------------------------------------------------
# Focused regression tests
# ---------------------------------------------------------------------------
write(
    "backend/tests/test_final_actionable_history_parser.py",
    r'''from datetime import datetime, timezone

from app.domains.runs.final_actionable_history import (
    decode_history_cursor,
    encode_history_cursor,
    normalize_action,
    normalize_stock_symbol,
    parse_markdown_action_rows,
)


def test_parser_extracts_stock_action_rows() -> None:
    response = """
| Exchange Symbol | Stock Symbol | Stock Name | Action (Buy/Add/Sell All/Trim/Hold/Buy New) | Current Units |
|---|---|---|---|---:|
| NSE | SUZLON | Suzlon Energy | Trim | 243 |
| NSE | INFY | Infosys | Hold | 10 |
"""
    rows = parse_markdown_action_rows(response)
    assert len(rows) == 2
    assert rows[0]["stock symbol"] == "SUZLON"
    assert normalize_action(rows[0]["action buy add sell all trim hold buy new"]) == "Trim"


def test_symbol_and_cursor_are_stable() -> None:
    assert normalize_stock_symbol("NSE:SUZLON.NS") == "SUZLON"
    covered_at = datetime(2026, 8, 6, 9, 56, tzinfo=timezone.utc)
    assert decode_history_cursor(encode_history_cursor(covered_at, 42)) == (covered_at, 42)
''',
)

write(
    "frontend/tests/final-actionables-history-persistence.test.mjs",
    r'''import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../app/console/_components/FinalActionablesConsole.tsx", import.meta.url),
  "utf8",
);
const apiSource = readFileSync(new URL("../services/api.ts", import.meta.url), "utf8");
const routerSource = readFileSync(
  new URL("../../backend/app/domains/runs/router.py", import.meta.url),
  "utf8",
);

test("stock details loads cursor-paginated durable history", () => {
  assert.match(source, /apiService\.getFinalActionableHistory\(/);
  assert.match(source, /Load older suggestions/);
  assert.match(apiSource, /finalActionableHistory\(\)/);
  assert.match(routerSource, /"\/final-actionables\/history"/);
});

test("historical cache merges rather than replacing older rows", () => {
  assert.match(source, /HISTORICAL_ACTION_ROWS_CACHE_VERSION = 2/);
  assert.match(source, /mergeHistoricalActionRows\(\s*rows,\s*readHistoricalActionRowsCache\(market\)/);
  assert.match(source, /mergeHistoricalActionRows\(historicalRows, readHistoricalActionRowsCache\(market\)\)/);
});

test("dashboard remains bounded while history persists separately", () => {
  assert.match(source, /DASHBOARD_RECENT_RUN_DETAIL_LIMIT = 24/);
  assert.match(source, /apiService\.saveFinalActionableHistory\(/);
  assert.match(source, /queueFinalActionableHistoryBackfill\(/);
});
''',
)

# Remove the one-shot patch machinery from the resulting implementation commit.
(ROOT / ".github/workflows/apply-final-actionable-history.yml").unlink(missing_ok=True)
Path(__file__).unlink(missing_ok=True)
