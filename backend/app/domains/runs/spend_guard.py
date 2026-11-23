"""Run-wide INR admission, using reserved records in the workflow-stage ledger.

A reservation is committed before its transport is called. Uncertain dispatches
keep their entire liability. Estimates and incomplete usage reports cannot
release capacity for another stage or retry.
"""
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256

from sqlalchemy import select, update
from sqlalchemy.exc import SQLAlchemyError

from app.domains.runs.models import AutoRebalanceWorkflow as Workflow, AutoRebalanceWorkflowStage as Stage, Run, RunJob
from app.infrastructure.database.sync_session import SyncSessionLocal

BUDGET_STAGE = "sc1.budget.v1"
MAX_PAISE = 10_000_000


class SpendLimitError(RuntimeError):
    """A provider call cannot be authorized under the workflow budget."""


@dataclass(frozen=True)
class RunBudget:
    root_id: int
    user_id: int
    job_id: int


_active: ContextVar[RunBudget | None] = ContextVar("zerodha_run_budget", default=None)


def budget_active() -> bool:
    return _active.get() is not None


def _amounts(record: dict) -> tuple[int, int]:
    limit, held = record.get("limit_paise"), record.get("held_paise")
    if (record.get("version") != 1 or type(limit) is not int or type(held) is not int
            or not 0 <= held <= limit <= MAX_PAISE):
        raise SpendLimitError("Run spending authorization is invalid; no paid work authorized.")
    return limit, held


def _receipt(record: dict | None) -> dict:
    if record is None:
        return {"max_cost_inr": None, "headroom_inr": None}
    limit, held = _amounts(record)
    return {"max_cost_inr": limit / 100, "headroom_inr": (limit - held) / 100}


def _lookup(user_id: int, sequence: int):
    return select(Stage).join(Workflow, Workflow.id == Stage.workflow_id).where(
        Workflow.user_id == user_id, Workflow.portfolio == "india", Workflow.sequence == sequence,
        Stage.stage == BUDGET_STAGE,
    )


async def attach_budget(db, workflow, *, limit_paise: int | None, parent_sequence: int | None) -> dict:
    """Attach before the transaction that creates the new workflow commits."""
    if parent_sequence is not None:
        parent = await db.scalar(select(Workflow.id).where(
            Workflow.user_id == workflow.user_id, Workflow.portfolio == "india",
            Workflow.sequence == parent_sequence))
        if parent is None:
            raise SpendLimitError("The original workflow was not found for this account.")
        source = await db.scalar(_lookup(workflow.user_id, parent_sequence))
        if source is not None:
            root = source
            if "root_id" in source.summary_json:
                root = await db.scalar(_root_query(source.summary_json["root_id"], workflow.user_id))
            if root is None:
                raise SpendLimitError("Original workflow spending authorization is unavailable.")
            maximum, _ = _amounts(root.summary_json)
            if limit_paise is not None and limit_paise != maximum:
                raise SpendLimitError("A recovery must retain its original whole-run spending limit.")
            await db.flush()
            db.add(Stage(workflow_id=workflow.id, stage=BUDGET_STAGE, status="completed",
                         summary_json={"version": 1, "root_id": root.id}))
            return _receipt(root.summary_json)
    if limit_paise is None:
        return _receipt(None)
    payload = {"version": 1, "limit_paise": limit_paise, "held_paise": 0}
    receipt = _receipt(payload)
    await db.flush()
    db.add(Stage(workflow_id=workflow.id, stage=BUDGET_STAGE, status="completed", summary_json=payload))
    return receipt


def _root_query(root_id, user_id):
    return select(Stage).join(Workflow, Workflow.id == Stage.workflow_id).where(
        Stage.id == root_id, Stage.stage == BUDGET_STAGE, Workflow.portfolio == "india",
        Workflow.user_id == user_id)


async def history_budgets(db, workflows):
    ids = [w.id for w in workflows if w.portfolio == "india"]
    if not ids:
        return {}
    records = list((await db.scalars(select(Stage).where(
        Stage.workflow_id.in_(ids), Stage.stage == BUDGET_STAGE))).all())
    roots = {r.id: r for r in records if "root_id" not in r.summary_json}
    missing = {r.summary_json["root_id"] for r in records if "root_id" in r.summary_json} - set(roots)
    if missing:
        owner = next(w.user_id for w in workflows if w.portfolio == "india")
        rows = await db.scalars(select(Stage).join(Workflow, Workflow.id == Stage.workflow_id).where(
            Stage.id.in_(missing), Stage.stage == BUDGET_STAGE,
            Workflow.user_id == owner, Workflow.portfolio == "india"))
        roots.update({r.id: r for r in rows})
    return {r.workflow_id: _receipt(roots[r.summary_json.get("root_id", r.id)].summary_json) for r in records}


def bind_job_budget(db, job):
    # The run use case copies owner, portfolio and sequence onto every child
    # before enqueue. Standalone Swing jobs carry these same durable fields.
    portfolio = getattr(job, "auto_rebalance_portfolio", None)
    sequence = getattr(job, "auto_rebalance_sequence", None)
    if portfolio != "india" or sequence is None:
        # Older jobs can have the workflow association only on the parent.
        # Only load persisted ORM jobs; pre-persistence test values have no
        # parent relation. Lookup errors on real jobs propagate fail-closed.
        from sqlalchemy import inspect
        from app.domains.jobs.models import Job
        if isinstance(job, Job) and inspect(job).persistent:
            linked = db.scalars(select(Run.auto_rebalance_sequence).join(RunJob, RunJob.run_id == Run.id)
                                .where(RunJob.job_id == job.id, Run.user_id == job.user_id,
                                       Run.auto_rebalance_portfolio == "india",
                                       Run.auto_rebalance_sequence.is_not(None))).all()
            sequences = set(linked)
            if len(sequences) > 1 or (sequences and portfolio not in (None, "india")):
                raise SpendLimitError("Conflicting workflow identity; no paid work authorized.")
            if sequences:
                portfolio, sequence = "india", sequences.pop()
        if portfolio != "india" or sequence is None:
            return _active.set(None)
    row = db.scalar(_lookup(job.user_id, sequence))
    if row is None:  # Existing workflows without a cap retain their dispatch behavior.
        return _active.set(None)
    data = row.summary_json
    if not isinstance(data, dict) or data.get("version") != 1:
        raise SpendLimitError("Invalid workflow spending authorization.")
    return _active.set(RunBudget(data.get("root_id", row.id), job.user_id, job.id))


def reset_job_budget(token):
    if token is not None:
        _active.reset(token)


def _quote(ceilings, provider, model, phase):
    # Each exact operation needs a documented contractual upper bound covering
    # input, output, cached/reasoning tokens, taxes, FX and any bundled tools.
    entry = ceilings.get(f"{provider}:{model or '-'}:{phase}")
    message = f"No verified all-in INR ceiling for {provider}/{model or '-'}/{phase}; dispatch declined."
    if not isinstance(entry, dict):
        raise SpendLimitError(message)
    amount, reference = entry.get("max_paise"), entry.get("contract_ref")
    try:
        expiry = datetime.fromisoformat(entry["valid_until"])
    except (TypeError, ValueError, KeyError):
        raise SpendLimitError(message) from None
    if (expiry.tzinfo is None or expiry <= datetime.now(timezone.utc) or type(amount) is not int
            or amount <= 0 or not isinstance(reference, str) or not reference.strip() or len(reference) > 128):
        raise SpendLimitError(message)
    return amount, reference


def reserve_transport(provider, model, phase, attempt_id, *, session_factory=None):
    context = _active.get()
    if context is None:
        return
    from app.core.config import settings
    amount, reference = _quote(settings.zerodha_run_charge_ceilings, provider, model, phase)
    # The root row serializes workers from every stage and recovery. The
    # compare-and-swap also protects dialects which ignore SELECT FOR UPDATE.
    try:
        with (session_factory or SyncSessionLocal)() as db, db.begin():
            root = db.scalar(_root_query(context.root_id, context.user_id).with_for_update(of=Stage))
            if root is None:
                raise SpendLimitError("Run spending authorization disappeared; dispatch declined.")
            limit, held = _amounts(root.summary_json)
            if held + amount > limit:
                raise SpendLimitError(
                    f"Whole-run spending limit: INR {(limit-held)/100:.2f} remaining; "
                    f"this call needs an INR {amount/100:.2f} reservation.")
            result = db.execute(update(Stage).where(
                Stage.id == root.id, Stage.summary_json["held_paise"].as_integer() == held,
            ).values(summary_json={**root.summary_json, "held_paise": held + amount})
                .execution_options(synchronize_session=False))
            if result.rowcount != 1:
                raise SpendLimitError("Concurrent budget reservation; this call was not dispatched.")
            key = "sc1.inr." + sha256(attempt_id.encode()).hexdigest()[:24]
            db.add(Stage(workflow_id=root.workflow_id, stage=key, job_id=context.job_id, status="completed",
                         summary_json={"version": 1, "attempt_id": attempt_id, "provider": provider,
                                       "model": model, "phase": phase, "held_paise": amount,
                                       "contract_ref": reference}))
    except SQLAlchemyError as exc:
        raise SpendLimitError("Could not confirm the run spending reservation; dispatch declined.") from exc
