from __future__ import annotations

import base64
from collections import Counter, defaultdict
from datetime import datetime, timezone
import json
import re
from typing import Iterable, Sequence

from sqlalchemy import and_, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
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

    existing_rows = list(
        (
            await db.execute(
                select(FinalActionableHistory).where(
                    FinalActionableHistory.user_id == user_id,
                    FinalActionableHistory.rebalance_run_id.in_(run_ids),
                )
            )
        )
        .scalars()
        .all()
    )
    existing_by_key = {
        (row.market, row.rebalance_run_id, row.stock_symbol): row.coverage_status
        for row in existing_rows
    }

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

    payload_by_key: dict[tuple[str, int, str], dict] = {}
    run_templates: dict[tuple[str, int], FinalActionableHistoryCreateItem] = {}
    submitted_symbols: dict[tuple[str, int], set[str]] = defaultdict(set)
    for item in items:
        symbol = normalize_stock_symbol(item.stock_symbol)
        key = (item.market, item.rebalance_run_id, symbol)
        run_key = (item.market, item.rebalance_run_id)
        run_templates.setdefault(run_key, item)
        submitted_symbols[run_key].add(symbol)
        known_by_market[item.market].add(symbol)
        payload_by_key[key] = {
            "user_id": user_id,
            "workflow_id": item.workflow_id,
            "auto_rebalance_sequence": item.auto_rebalance_sequence,
            "rebalance_run_id": item.rebalance_run_id,
            "market": item.market,
            "stock_symbol": symbol,
            "stock_name": item.stock_name,
            "covered_at": item.covered_at,
            "action": item.action,
            "score": item.score,
            "consensus_numerator": item.consensus_numerator,
            "consensus_denominator": item.consensus_denominator,
            "historical_current_units": item.historical_current_units,
            "historical_current_value": item.historical_current_value,
            "action_units": item.action_units,
            "amount": item.amount,
            "technical_scan_run_id": item.technical_scan_run_id,
            "formula_version": item.formula_version,
            "formula_inputs_json": item.formula_inputs_json,
            "source_run_ids_json": item.source_run_ids_json,
            "snapshot_json": item.snapshot_json,
            "coverage_status": item.coverage_status,
        }

    # Keep explicit gaps for symbols already known at the time of this write.
    # setdefault ensures a real suggestion always wins over a generated gap,
    # even when a large run is retried or split across request batches.
    for (market, run_id), template in run_templates.items():
        for symbol in sorted(known_by_market[market] - submitted_symbols[(market, run_id)]):
            key = (market, run_id, symbol)
            payload_by_key.setdefault(
                key,
                {
                    "user_id": user_id,
                    "workflow_id": template.workflow_id,
                    "auto_rebalance_sequence": template.auto_rebalance_sequence,
                    "rebalance_run_id": run_id,
                    "market": market,
                    "stock_symbol": symbol,
                    "covered_at": template.covered_at,
                    "formula_version": "coverage-v1",
                    "source_run_ids_json": [run_id],
                    "coverage_status": "not_mentioned",
                    "snapshot_json": {
                        "reason": "Stock was not mentioned in persisted output rows."
                    },
                },
            )

    payloads = list(payload_by_key.values())
    if not payloads:
        return 0, 0, 0

    statement = pg_insert(FinalActionableHistory).values(payloads)
    excluded = statement.excluded
    update_columns = (
        "workflow_id",
        "auto_rebalance_sequence",
        "stock_name",
        "covered_at",
        "action",
        "score",
        "consensus_numerator",
        "consensus_denominator",
        "historical_current_units",
        "historical_current_value",
        "action_units",
        "amount",
        "technical_scan_run_id",
        "formula_version",
        "formula_inputs_json",
        "source_run_ids_json",
        "snapshot_json",
        "coverage_status",
        "updated_at",
    )
    statement = statement.on_conflict_do_update(
        constraint="uq_final_actionable_history_run_stock",
        set_={column: getattr(excluded, column) for column in update_columns},
        where=and_(
            FinalActionableHistory.coverage_status != "suggested",
            excluded.coverage_status == "suggested",
        ),
    )
    await db.execute(statement)
    await db.commit()

    new_rows = sum(key not in existing_by_key for key in payload_by_key)
    upgrades = sum(
        key in existing_by_key
        and existing_by_key[key] != "suggested"
        and payload_by_key[key].get("coverage_status") == "suggested"
        for key in payload_by_key
    )
    persisted = new_rows + upgrades
    skipped = len(payload_by_key) - persisted
    coverage_inserted = sum(
        key not in existing_by_key
        and payload.get("coverage_status") != "suggested"
        for key, payload in payload_by_key.items()
    )
    return persisted, skipped, coverage_inserted


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
    existing_by_key = {
        (row.market, row.rebalance_run_id, row.stock_symbol): row
        for row in db.execute(
            select(FinalActionableHistory).where(FinalActionableHistory.user_id == user_id)
        ).scalars().all()
    }

    inserted = 0
    upgraded = 0
    coverage_inserted = 0
    seen_by_market: dict[str, set[str]] = defaultdict(set)
    for run in eligible:
        market = infer_market(run)
        if not market:
            continue
        projection, usable_output_seen = _run_projection(run)
        seen_by_market[market].update(projection)

        for symbol in sorted(seen_by_market[market]):
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

            key = (market, run.id, symbol)
            existing = existing_by_key.get(key)
            if existing is not None:
                if data and existing.coverage_status != "suggested":
                    existing.stock_name = data.get("stock_name")
                    existing.action = data.get("action")
                    existing.score = data.get("score")
                    existing.consensus_numerator = data.get("consensus_numerator")
                    existing.consensus_denominator = data.get("consensus_denominator")
                    existing.historical_current_units = data.get("historical_current_units")
                    existing.historical_current_value = data.get("historical_current_value")
                    existing.action_units = data.get("action_units")
                    existing.amount = data.get("amount")
                    existing.formula_version = formula_version
                    existing.formula_inputs_json = {
                        "parser": "legacy-markdown-backfill-v1",
                        "source_job_ids": data.get("source_job_ids", []),
                    }
                    existing.source_run_ids_json = [run.id]
                    existing.snapshot_json = {
                        "source": "legacy-backfill",
                        "rows": data.get("rows", []),
                    }
                    existing.coverage_status = "suggested"
                    upgraded += 1
                continue

            record = FinalActionableHistory(
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
            db.add(record)
            existing_by_key[key] = record
            if data:
                inserted += 1
            else:
                coverage_inserted += 1
            if (inserted + upgraded + coverage_inserted) % 250 == 0:
                db.flush()

    db.commit()
    return {
        "runs_scanned": len(eligible),
        "suggestions_inserted": inserted,
        "suggestions_upgraded": upgraded,
        "coverage_inserted": coverage_inserted,
    }
