"""Small, read-only compatibility overlays for the event-trend endpoint."""
from sqlalchemy import JSON, column, func, select
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
        accepted = outputs.get("accepted_candidates") or []
        count = outputs.get("accepted_candidates_count")
        if isinstance(count, (int, float)) and count > len(accepted):
            return True
        reviewed = outputs.get("llm_reviewed_candidates") or []
        reviewed_count = outputs.get("llm_candidate_count")
        if isinstance(reviewed_count, (int, float)) and reviewed_count > len(reviewed):
            return True
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
    return select(func.json_agg(
        aggregate_order_by(projected, stages.c.ordinality), type_=JSON,
    )).select_from(stages).correlate(record).scalar_subquery()
