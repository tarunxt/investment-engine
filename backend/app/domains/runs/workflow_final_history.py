"""Read the published Zerodha workflow final, once per workflow and exact listing."""
from datetime import datetime, timezone
import math

from sqlalchemy import func, select

from app.domains.scorecards.storage import of_kind
from .models import AutoRebalanceWorkflow as Workflow, AutoRebalanceWorkflowStage as Stage


def numeric(value):
    return type(value) in (int, float) and math.isfinite(value)


def frozen_scores(record):
    """Older workflow finals store the same displayed /100 score in signed form."""
    ranking = record.get("actionable_ranking")
    if isinstance(ranking, dict) and isinstance(ranking.get("rows"), list):
        return [(row.get("listing"), row.get("score")) for row in ranking["rows"] if isinstance(row, dict)]
    scores = []
    for row in record.get("rows", []):
        if not isinstance(row, dict):
            continue
        signed = row.get("effectiveScore") if record["schema"] == "workflow-final-v2" else row.get("score")
        value = (max(-3, min(3, signed)) + 3) * 100 / 6 if numeric(signed) else None
        scores.append((f"{row.get('exchange')}:{row.get('symbol')}", value))
    return scores


def workflow_final_history(session, user_id, symbols, start, end):
    owner = (Workflow.user_id == user_id, Workflow.portfolio == "india")
    # Stage.created_at is naive UTC. Stage.completed_at is TIMESTAMPTZ.
    newest = select(func.max(Stage.id)).join(Workflow).where(
        *owner, of_kind("final"), Stage.status == "completed",
        Stage.created_at > start.replace(tzinfo=None), Stage.created_at <= end.replace(tzinfo=None),
    ).group_by(Stage.workflow_id)
    independent = session.execute(select(
        Workflow.sequence, Stage.created_at, Stage.summary_json["result"]["rows"],
    ).join(Workflow).where(Stage.id.in_(newest)).limit(1001)).all()
    legacy = session.execute(select(
        Workflow.sequence, Stage.completed_at, Stage.status, Stage.summary_json["frozen_final"],
        Stage.summary_json["corrected_final_v2"],
    ).join(Workflow).where(*owner, Stage.stage == "actionables",
        Stage.completed_at > start, Stage.completed_at <= end,
    ).limit(1001)).all()

    if len(independent) > 1000 or len(legacy) > 1000:
        return [], True
    observations = []
    def collect(sequence, when, scores):
        when = when.replace(tzinfo=timezone.utc) if when.tzinfo is None else when
        listings = {}
        for listing, score in scores:
            if not isinstance(listing, str) or ":" not in listing:
                continue
            exchange, symbol = listing.upper().split(":", 1)
            if exchange in {"NSE", "BSE"} and symbol in symbols:
                key = (exchange, symbol)
                listings[key] = None if key in listings else score
        for (exchange, symbol), score in listings.items():
            if numeric(score) and 0 <= score <= 100:
                observations.append(dict(sequence=sequence, exchange=exchange, symbol=symbol,
                                         covered_at=when.isoformat(), score=score))

    handled = set()
    for sequence, when, rows in independent:
        handled.add(sequence)
        collect(sequence, when, ((r.get("listing"), r.get("final")) for r in (rows or []) if isinstance(r, dict)))
    for sequence, when, status, original, corrected in legacy:
        if sequence in handled:
            continue
        record = original if status == "completed" else None
        if isinstance(corrected, dict):
            try:
                captured = datetime.fromisoformat(corrected["captured_at"])
                if captured.tzinfo and captured <= end:
                    record = corrected
            except (KeyError, TypeError, ValueError):
                pass
        if isinstance(record, dict) and record.get("schema") in {"workflow-final-v1", "workflow-final-v2"}:
            collect(sequence, when, frozen_scores(record))
    return sorted(observations, key=lambda r: (r["covered_at"], r["sequence"], r["exchange"], r["symbol"])), False
