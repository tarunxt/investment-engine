"""Behaviour coverage for bounded Bullpen console reads."""

from __future__ import annotations

import json

from app.domains.polymarket_auto_live.console_projection import (
    build_history_item,
    build_run_console_projection,
    projected_run_payload,
)
from app.domains.polymarket_auto_live.schemas import (
    BullpenAutoLiveRun,
    BullpenAutoLiveStageResult,
)


def _large_run() -> BullpenAutoLiveRun:
    stage = BullpenAutoLiveStageResult(
        stage_number=1,
        stage_name="Stage 1",
        status="pass",
        reason="Scanned candidates.",
        inputs={
            "workflow_stage_key": "scan",
            "candidate_rows": [{"raw": "x" * 20_000} for _ in range(100)],
        },
        outputs={
            "workflow_stage_key": "scan",
            "phase_status": "completed",
            "scanned_candidates": 100,
            "accepted_candidates_count": 25,
            "raw_response": "secret-provider-output" * 20_000,
            "llm_reviewed_candidates": [
                {"market_id": f"market-{index}", "rationale": "r" * 5_000}
                for index in range(100)
            ],
        },
        started_at="2026-07-26T10:00:00+00:00",
        completed_at="2026-07-26T10:00:05+00:00",
    )
    return BullpenAutoLiveRun(
        id="run-large",
        triggered_by="scheduler",
        status="completed",
        dry_run=True,
        started_at="2026-07-26T10:00:00+00:00",
        completed_at="2026-07-26T10:00:05+00:00",
        summary="Completed.",
        decisions_count=25,
        stage_results=[stage],
    )


def test_console_projection_is_bounded_and_does_not_mutate_frozen_run() -> None:
    run = _large_run()
    frozen_payload = run.model_dump(mode="json")

    projection = build_run_console_projection(run)
    encoded = json.dumps(projection, separators=(",", ":")).encode()

    assert len(encoded) < 150_000
    assert "secret-provider-output" not in encoded.decode()
    assert len(
        projection["stage_results"][0]["outputs"]["llm_reviewed_candidates"]
    ) == 10
    assert run.model_dump(mode="json") == frozen_payload


def test_legacy_projected_row_is_explicitly_degraded_without_fabricated_stages() -> None:
    run = _large_run()

    payload, projection_available = projected_run_payload(
        projection=None,
        id=run.id,
        triggered_by=run.triggered_by,
        status=run.status,
        dry_run=run.dry_run,
        started_at=run.started_at,
        completed_at=run.completed_at,
        summary=run.summary,
        live_execution_requested=False,
        live_execution_attempted=False,
        decisions_count=run.decisions_count,
        orders_planned=0,
        orders_submitted=0,
        error_message=None,
    )
    projected = BullpenAutoLiveRun.model_validate(payload)
    history = build_history_item(
        projected,
        latest_update_at="2026-07-26T10:00:06+00:00",
        projection_available=projection_available,
    )

    assert projection_available is False
    assert history.projection_available is False
    assert history.stages == []
    assert history.decisions_count == 25


def test_history_item_exposes_stage_counts_and_frozen_duration() -> None:
    history = build_history_item(
        _large_run(),
        latest_update_at="2026-07-26T10:00:06+00:00",
        projection_available=True,
    )

    assert history.duration_seconds == 5
    assert history.stages[0].key == "scan"
    assert history.stages[0].processed_count == 100
    assert history.stages[0].succeeded_count == 25
