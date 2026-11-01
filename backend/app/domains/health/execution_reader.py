"""Source-only, read-only diagnostic seam. No engine/model/runtime imports.

Caller supplies a dedicated async session factory and the integrated SQLAlchemy
Job/Outbox tables. Never wire this to a public route with a caller-supplied actor.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import math

from sqlalchemy import and_, or_, select, text

from .execution import DurableProjection, summarize_durable

TOPIC = "analysis.dispatch.v1"
ROW_LIMIT = 101
READ_TIMEOUT_SECONDS = 0.45


def projection_query(jobs, outbox, *, actor_id: int, recovery: bool):
    """Project safe scalars only; actor and policy predicates precede LIMIT.

    `jobs` and `outbox` are Table objects, never raw SQL or caller-selected tables.
    No claim token, ID, payload, prompt, full JSON or error column is selected.
    """
    if type(actor_id) is not int or actor_id <= 0:
        raise ValueError("Invalid diagnostic actor")
    j, o = jobs.c, outbox.c
    claim = j.runtime_metadata_json["execution_claim"]
    query = select(
        o.state.label("dispatch_state"), o.created_at.label("created_at"),
        claim["state"].as_string().label("claim_state"),
        claim["expires_at"].as_string().label("claim_expires_at"),
        j.status.label("job_status"),
    ).select_from(outbox.join(jobs, o.job_id == j.id)).where(
        j.user_id == actor_id, o.topic == TOPIC,
    )
    if recovery:
        context = j.request_context_json
        query = query.where(or_(
            and_(j.auto_rebalance_portfolio == "india", or_(
                context.is_(None), and_(
                    context["kind"].as_string() == "equity_output_sources_v1",
                    context["market"].as_string() == "india"))),
            and_(j.auto_rebalance_portfolio == "indmoney_us", or_(
                context.is_(None), and_(
                    context["kind"].as_string() == "equity_output_sources_v1",
                    context["market"].as_string() == "us"))),
        ))
    # UUID primary-key order avoids a payload sort and remains deterministic.
    # LIMIT bounds returned rows, not work; native deadlines bound execution.
    return query.order_by(o.id).limit(ROW_LIMIT)


def _epoch(value):
    if isinstance(value, datetime):
        return (value.replace(tzinfo=timezone.utc) if value.tzinfo is None
                else value.astimezone(timezone.utc)).timestamp()
    if type(value) not in (str, int, float):
        return None
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (ValueError, OverflowError):
        return None


def _unknown():
    result = summarize_durable([], now=0)
    result["read_state"] = "unavailable"
    return result


async def read_durable_projection(session_factory, jobs, outbox, *, actor_id: int,
                                  recovery: bool, now: float):
    """One SELECT; local read-only transaction, native deadlines, no commit.

    The factory must provide a dedicated session, never an existing request/write
    transaction. Outer deadline includes pool acquisition and cleanup. No runtime
    factory is imported or activated here. DB errors are public-safe unknowns.
    """
    async def read():
        query = projection_query(jobs, outbox, actor_id=actor_id, recovery=recovery)
        async with session_factory() as session:
            async with session.begin():
                # PostgreSQL utility statements require static SQLAlchemy text;
                # all data predicates remain bound SQLAlchemy expressions.
                await session.execute(text("SET TRANSACTION READ ONLY"))
                await session.execute(text("SET LOCAL statement_timeout = '150ms'"))
                await session.execute(text("SET LOCAL lock_timeout = '50ms'"))
                result = await session.execute(query)
                rows = result.mappings().fetchmany(ROW_LIMIT)
                projections = [DurableProjection(
                    dispatch_state=row["dispatch_state"],
                    created_at=_epoch(row["created_at"]),
                    claim_state=row["claim_state"],
                    claim_expires_at=_epoch(row["claim_expires_at"]),
                    terminal=row["job_status"] in {"completed", "partial", "failed"},
                ) for row in rows]
                # Never commit even a read transaction; leave no session settings.
                await session.rollback()
                summary = summarize_durable(projections, now=now, complete=False)
                summary["read_state"] = "sampled"
                return summary
    try:
        return await asyncio.wait_for(read(), timeout=READ_TIMEOUT_SECONDS)
    except Exception:
        return _unknown()
