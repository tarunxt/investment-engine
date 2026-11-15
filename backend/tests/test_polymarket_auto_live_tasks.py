from app.domains.polymarket_auto_live.schemas import (
        BullpenAutoLiveRun,
        BullpenAutoLiveState,
        BullpenAutoLiveStageResult,
)
from app.domains.polymarket_auto_live.tasks import (
    _finalize_failed_run_progress,
    persist_auto_live_progress_sync,
)


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


def _stage3_decision_row(
    *,
    market_id: str = "market-stage3-1",
    stage3_result: str = "SELECTED",
    stage3_final_rank: int | None = 1,
) -> dict[str, object]:
    return {
        "id": f"decision-{market_id}",
        "run_id": "run-stage3-progress",
        "created_at": "2026-07-01T12:01:00+00:00",
        "updated_at": "2026-07-01T12:01:30+00:00",
        "market_id": market_id,
        "market_title": "Will stage 3 persist?",
        "market_url": f"https://example.com/{market_id}",
        "slug": market_id,
        "close_time": "2026-07-07T12:00:00+00:00",
        "theme": "Macro",
        "side": "NO",
        "decision": "BUY_NEW" if stage3_result == "SELECTED" else "SKIP",
        "risk_status": "Ready" if stage3_result == "SELECTED" else "Blocked",
        "price_cents": 82.0,
        "current_yes_odds": 18.0,
        "current_no_odds": 82.0,
        "fair_probability_pct": 82.0,
        "fair_yes_probability_pct": 18.0,
        "fair_no_probability_pct": 82.0,
        "edge_pp": 0.0,
        "score": 5.0,
        "confidence": "High",
        "evidence_status": "Strong",
        "adjudication_required": False,
        "current_exposure_usd": 0.0,
        "target_exposure_usd": 5.0 if stage3_result == "SELECTED" else 0.0,
        "key_evidence": [],
        "red_flags": [],
        "reason": "Persisted from Stage 3 progress.",
        "summary": "Persisted from Stage 3 progress.",
        "stage3_result": stage3_result,
        "stage3_result_reason": "Persisted from Stage 3 progress.",
        "stage3_final_rank": stage3_final_rank,
        "stage3_max_positions": 10,
        "order_plan": {
            "id": f"order-{market_id}",
            "action": "buy",
            "side": "NO",
            "order_type": "limit",
            "status": "planned",
            "market_id": market_id,
            "market_title": "Will stage 3 persist?",
            "order_size_usd": 5.0,
            "shares": 6.097561,
            "limit_price_cents": 82.0,
            "max_slippage_cents": 2.0,
            "dry_run": False,
            "detail": "Order planned but not executed yet.",
            "execution_response": None,
            "created_at": "2026-07-01T12:01:00+00:00",
            "executed_at": None,
        },
        "exit_signals": [],
        "exit_state": "ACTIVE",
        "llm_outputs": [],
        "stage_results": [],
        "guardrail_checks": [],
    }


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
        == "Auto-Live run failed during Stage 3 · Exit and Invest: Future attached to a different loop"
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


def test_persist_auto_live_progress_sync_backfills_stage3_decisions_from_run_payload():
    run = BullpenAutoLiveRun(
        id="run-stage3-progress",
        triggered_by="manual",
        status="running",
        dry_run=False,
        started_at="2026-07-01T12:00:00+00:00",
        summary="Stage 3 reviewed row 1 of 1.",
        stage_results=[
            _stage_result(
                stage_number=3,
                reason="Stage 3 reviewed row 1 of 1.",
                outputs={
                    "workflow_stage_key": "invest",
                    "phase_status": "running",
                    "decision_rows": [_stage3_decision_row()],
                },
                completed_at=None,
            ),
        ],
    )
    state = BullpenAutoLiveState(last_run_id=run.id)

    class _FakeRepo:
        def __init__(self) -> None:
            self.calls: list[tuple[str, object]] = []

        def save_run(self, user_id: int, next_run: BullpenAutoLiveRun) -> None:
            self.calls.append(("save_run", user_id, next_run.id))

        def replace_run_decisions_from_stage3_payload(
            self,
            user_id: int,
            next_run: BullpenAutoLiveRun,
        ) -> int:
            self.calls.append(("replace_run_decisions_from_stage3_payload", user_id, next_run.id))
            return 1

        def save_state(self, user_id: int, next_state: BullpenAutoLiveState) -> None:
            self.calls.append(("save_state", user_id, next_state.last_run_id))

    class _FakeSession:
        def __init__(self) -> None:
            self.commits = 0

        def commit(self) -> None:
            self.commits += 1

    repo = _FakeRepo()
    session = _FakeSession()

    persist_auto_live_progress_sync(
        user_id=7,
        repo=repo,  # type: ignore[arg-type]
        session=session,
        run=run,
        state=state,
    )

    assert repo.calls == [
        ("save_run", 7, "run-stage3-progress"),
        ("replace_run_decisions_from_stage3_payload", 7, "run-stage3-progress"),
        ("save_state", 7, "run-stage3-progress"),
    ]
    assert session.commits == 1
