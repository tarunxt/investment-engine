from app.domains.polymarket_auto_live.schemas import (
    BullpenAutoLiveRun,
    BullpenAutoLiveStageResult,
)
from app.domains.polymarket_auto_live.tasks import _finalize_failed_run_progress


def _stage_result(
    *,
    stage_number: int,
    reason: str,
    outputs: dict[str, object],
    completed_at: str | None,
) -> BullpenAutoLiveStageResult:
    return BullpenAutoLiveStageResult(
        stage_number=stage_number,
        stage_name=f"Stage {stage_number}",
        status="pass",
        reason=reason,
        outputs=outputs,
        started_at="2026-07-01T12:00:00+00:00",
        completed_at=completed_at,
    )


def test_finalize_failed_run_progress_marks_inflight_stage3_orders_as_failed():
    run = BullpenAutoLiveRun(
        id="run-stage3-failure",
        triggered_by="manual",
        status="running",
        dry_run=False,
        started_at="2026-07-01T12:00:00+00:00",
        summary="Stage 3 is still running.",
        live_execution_requested=True,
        live_execution_attempted=True,
        decisions_count=2,
        orders_planned=2,
        orders_submitted=1,
        stage_results=[
            _stage_result(
                stage_number=1,
                reason="Bullpen scan finished.",
                outputs={
                    "workflow_stage_key": "scan",
                    "phase_status": "completed",
                },
                completed_at="2026-07-01T12:00:10+00:00",
            ),
            _stage_result(
                stage_number=3,
                reason="Stage 3 submitted 1 of 2 planned orders. Latest: Market two",
                outputs={
                    "workflow_stage_key": "invest",
                    "phase_status": "running",
                    "orders_planned": 2,
                    "orders_submitted": 1,
                    "orders_processed": 1,
                    "decision_rows": [
                        {
                            "market_title": "Market one",
                            "order_plan": {
                                "status": "submitted",
                                "detail": "Limit order submitted successfully.",
                            },
                        },
                        {
                            "market_title": "Market two",
                            "order_plan": {
                                "status": "planned",
                                "detail": "Order planned but not executed yet.",
                            },
                        },
                    ],
                },
                completed_at=None,
            ),
        ],
    )

    summary = _finalize_failed_run_progress(
        run,
        failure_message="Future attached to a different loop",
        completed_at="2026-07-01T12:04:23+00:00",
    )

    assert (
        summary
        == "Auto-Live run failed during Stage 3 · Rebalance and Invest: Future attached to a different loop"
    )
    invest_stage = run.stage_results[-1]
    assert invest_stage.status == "fail"
    assert invest_stage.completed_at == "2026-07-01T12:04:23+00:00"
    assert invest_stage.outputs["phase_status"] == "failed"
    assert invest_stage.outputs["error_message"] == "Future attached to a different loop"
    assert invest_stage.outputs["orders_failed"] == 1
    assert invest_stage.outputs["orders_processed"] == 2
    decision_rows = invest_stage.outputs["decision_rows"]
    assert isinstance(decision_rows, list)
    assert decision_rows[0]["order_plan"]["status"] == "submitted"
    assert decision_rows[1]["order_plan"]["status"] == "failed"
    assert decision_rows[1]["order_plan"]["detail"] == "Future attached to a different loop"
    assert "Worker error: Future attached to a different loop" in invest_stage.reason
