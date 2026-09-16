"""Small, read-only compatibility overlays for the event-trend endpoint."""
from sqlalchemy import JSON, case, column, func, select
from sqlalchemy.dialects.postgresql import aggregate_order_by


def needs_frozen_trend_overlay(stages):
    if not isinstance(stages, list) or not stages:
        return True
    for stage in stages:
        if not isinstance(stage, dict):
            continue
        outputs = stage.get("outputs") or {}
        if not isinstance(outputs, dict):
            continue
        phase_status = str(outputs.get("phase_status") or "").strip().lower()
        # A running stage deliberately publishes its count before the bounded
        # candidate rows are complete. Treating that temporary difference as a
        # legacy projection makes the History request inspect the immutable,
        # full run payload while Stage 1/2 is still writing it. Sports scans can
        # make that payload very large, so the compatibility read can consume
        # the whole HTTP timeout even though the current console projection
        # already contains the completed Stage 1 shortlist.
        stage_is_in_progress = phase_status in {
            "queued", "running", "working", "confirming", "pending",
        }
        accepted = outputs.get("accepted_candidates") or []
        count = outputs.get("accepted_candidates_count")
        if (
            not stage_is_in_progress
            and isinstance(count, (int, float))
            and count > len(accepted)
        ):
            return True
        reviewed = outputs.get("llm_reviewed_candidates") or []
        reviewed_count = outputs.get("llm_candidate_count")
        if (
            not stage_is_in_progress
            and isinstance(reviewed_count, (int, float))
            and reviewed_count > len(reviewed)
        ):
            return True
        if not stage_is_in_progress:
            for candidate in reviewed:
                if isinstance(candidate, dict) and not candidate.get("llm_outputs"):
                    return True
    return False


def frozen_trend_stages(record):
    """Project in PostgreSQL before transferring or decoding scan JSON in Python.

    Frozen rejected rows, export sources and execution inputs are irrelevant to
    trends. Never transfer those full-universe arrays to an HTTP process.
    """
    stages = func.json_array_elements(record.payload["stage_results"]).table_valued(
        column("value", JSON), with_ordinality="ordinality"
    ).render_derived(name="trend_stage")
    stage = stages.c.value
    outputs = stage["outputs"]
    projected_outputs = func.json_build_object(*[
        item for key in (
            "workflow_stage_key", "phase_status", "accepted_candidates_count",
            "accepted_candidates", "llm_reviewed_candidates",
        ) for item in (key, outputs[key])
    ])
    projected = func.json_build_object(*[
        item for key in (
            "stage_number", "stage_name", "status", "reason",
            "started_at", "completed_at",
        ) for item in (key, stage[key])
    ], "outputs", projected_outputs)
    overlay = select(func.json_agg(
        aggregate_order_by(projected, stages.c.ordinality), type_=JSON,
    )).select_from(stages).correlate(record).scalar_subquery()
    # A single full-universe JSON value can require gigabytes to expand in
    # PostgreSQL even though the projected response is small. Inspect its stored
    # size BEFORE any JSON extraction; WHERE alone does not guarantee evaluation
    # order. Oversized legacy runs keep their existing bounded console projection.
    return case((func.pg_column_size(record.payload) <= 262_144, overlay), else_=None)
