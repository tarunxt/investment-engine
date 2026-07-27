"""Behaviour coverage for bounded Bullpen console reads."""

from __future__ import annotations

import json

from app.domains.polymarket_auto_live.console_projection import (
    build_history_item,
    build_run_console_projection,
    build_verified_stage1_portfolio_snapshot,
    has_verified_stage1_portfolio,
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
            "accepted_candidates_count": 44,
            "accepted_candidates": [
                {
                    "question_id": f"question-{index}",
                    "market_id": f"market-{index}",
                    "question": f"Will event {index} happen?",
                    "slug": f"market-{index}",
                    "close_time": "2026-08-01T10:00:00+00:00",
                    "current_yes_odds": 40,
                    "current_no_odds": 60,
                    "rules": "Expandable rules are omitted from the live projection.",
                }
                for index in range(44)
            ],
            "active_position_rows_before_llm": 3,
            "console_trade_cash_in_hand_usd": 3.44,
            "console_trade_available_slots": 3,
            "console_trade_max_positions": 10,
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
    assert len(
        projection["stage_results"][0]["outputs"]["accepted_candidates"]
    ) == 44
    assert (
        projection["stage_results"][0]["outputs"][
            "active_position_rows_before_llm"
        ]
        == 3
    )
    assert (
        projection["stage_results"][0]["outputs"][
            "console_trade_cash_in_hand_usd"
        ]
        == 3.44
    )
    assert run.model_dump(mode="json") == frozen_payload


def test_only_fresh_completed_stage1_wallet_rows_verify_a_portfolio() -> None:
    verified = _large_run()
    verified.stage_results[0].outputs.update(
        {
            "active_positions_found": [
                {
                    "market_id": "market-1",
                    "market_title": "Market 1",
                    "classification": "active",
                }
            ],
            "available_for_claim": [
                {
                    "market_id": "claim-1",
                    "market_title": "Claimable Market",
                    "classification": "positive_payout_claimable",
                    "is_claimable": True,
                }
            ],
            "wallet_snapshot_status": "fresh",
            "wallet_freshness_state": "fresh",
            "wallet_position_classifier_version": 3,
            "wallet_account_identity": "wallet-a",
            "wallet_credential_artifact_inode": 11,
            "wallet_credential_artifact_mtime_ns": 22,
            "wallet_credential_artifact_size": 33,
            "console_trade_cash_in_hand_usd": 3.44,
            "console_trade_max_positions": 10,
            "console_trade_amount_usd": 0.38,
        }
    )
    assert has_verified_stage1_portfolio(verified) is True
    snapshot = build_verified_stage1_portfolio_snapshot(verified)
    assert snapshot is not None
    assert snapshot.run_id == verified.id
    assert snapshot.occupied_positions == 1
    assert len(snapshot.claimable_positions) == 1
    assert (
        snapshot.claimable_positions[0]["classification"]
        == "positive_payout_claimable"
    )
    assert snapshot.available_slots == 9
    assert snapshot.cash_in_hand_usd == 3.44
    assert snapshot.position_classifier_version == "3"
    assert snapshot.wallet_account_identity == "wallet-a"
    assert snapshot.wallet_credential_artifact_inode == 11

    candidate_only = verified.model_copy(deep=True)
    candidate_only.stage_results[0].outputs.update(
        {
            "active_positions_found": [],
            "wallet_snapshot_status": "unavailable",
            "stage2_candidate_only": True,
        }
    )
    assert has_verified_stage1_portfolio(candidate_only) is False
    assert build_verified_stage1_portfolio_snapshot(candidate_only) is None

    stale = verified.model_copy(deep=True)
    stale.stage_results[0].outputs["wallet_freshness_state"] = "stale"
    assert has_verified_stage1_portfolio(stale) is False

    missing_lineage = verified.model_copy(deep=True)
    missing_lineage.stage_results[0].outputs.pop("wallet_snapshot_status")
    missing_lineage.stage_results[0].outputs.pop("wallet_freshness_state")
    assert has_verified_stage1_portfolio(missing_lineage) is False
    assert build_verified_stage1_portfolio_snapshot(missing_lineage) is None

    refresh_error = verified.model_copy(deep=True)
    refresh_error.stage_results[0].outputs["wallet_refresh_error"] = (
        "wallet lookup failed"
    )
    assert has_verified_stage1_portfolio(refresh_error) is False

    enrichment_error = verified.model_copy(deep=True)
    enrichment_error.stage_results[0].outputs[
        "wallet_market_enrichment_error"
    ] = "market lookup incomplete"
    assert has_verified_stage1_portfolio(enrichment_error) is False

    failed = verified.model_copy(deep=True)
    failed.stage_results[0].status = "fail"
    assert has_verified_stage1_portfolio(failed) is False

    partial_without_completion = verified.model_copy(deep=True)
    partial_without_completion.stage_results[0].completed_at = None
    partial_without_completion.stage_results[0].outputs["phase_status"] = (
        "partial"
    )
    assert has_verified_stage1_portfolio(partial_without_completion) is False


def test_verified_portfolio_snapshot_is_bounded_and_drops_raw_wallet_fields() -> None:
    run = _large_run()

    def rows(classification: str) -> list[dict[str, object]]:
        return [
            {
                "position_key": f"market-{index}::NO",
                "market_id": f"market-{index}",
                "market_title": "m" * 2_000,
                "side": "NO",
                "shares": 1,
                "classification": classification,
                "classification_reason": "r" * 2_000,
                "raw_response": "secret" * 20_000,
            }
            for index in range(10)
        ]

    run.stage_results[0].outputs.update(
        {
            "wallet_snapshot_status": "fresh",
            "wallet_snapshot_freshness_state": "fresh",
            "active_positions_found": rows("active"),
            "available_for_claim": rows("positive_payout_claimable"),
            "settlement_pending_positions": rows("settlement_pending"),
            "excluded_position_diagnostics": rows("stale_or_unknown"),
        }
    )

    snapshot = build_verified_stage1_portfolio_snapshot(run)
    assert snapshot is not None
    encoded = snapshot.model_dump_json().encode()
    assert len(encoded) < 50_000
    assert b"secret" not in encoded
    assert len(snapshot.active_positions) == 10
    assert len(snapshot.claimable_positions) == 10
    assert len(snapshot.settlement_pending_positions) == 5
    assert len(snapshot.excluded_positions) == 5


def test_verified_portfolio_snapshot_preserves_total_and_occupancy_when_rows_truncate() -> None:
    run = _large_run()
    run.stage_results[0].outputs.update(
        {
            "wallet_snapshot_status": "fresh",
            "wallet_snapshot_freshness_state": "fresh",
            "console_trade_max_positions": 20,
            "console_trade_active_positions": 12,
            "console_trade_occupied_positions": 12,
            "active_positions_found": [
                {
                    "position_key": f"market-{index}::NO",
                    "market_id": f"market-{index}",
                    "market_title": f"Market {index}",
                    "side": "NO",
                    "shares": 1,
                    "classification": "active",
                }
                for index in range(12)
            ],
        }
    )

    snapshot = build_verified_stage1_portfolio_snapshot(run)

    assert snapshot is not None
    assert len(snapshot.active_positions) == 10
    assert snapshot.active_positions_total == 12
    assert snapshot.active_positions_truncated is True
    assert snapshot.occupied_positions == 12
    assert snapshot.available_slots == 8


def test_verified_portfolio_snapshot_uses_largest_additive_position_scalar() -> None:
    run = _large_run()
    run.stage_results[0].outputs.update(
        {
            "wallet_snapshot_status": "fresh",
            "wallet_snapshot_freshness_state": "fresh",
            "active_positions_found": [
                {
                    "position_key": f"market-{index}::NO",
                    "market_id": f"market-{index}",
                    "market_title": f"Market {index}",
                    "side": "NO",
                    "shares": 1,
                    "classification": "active",
                }
                for index in range(4)
            ],
            "active_positions_total": 5,
            "console_trade_active_positions": 11,
            "console_trade_occupied_positions": 12,
            "console_trade_max_positions": 20,
        }
    )

    snapshot = build_verified_stage1_portfolio_snapshot(run)

    assert snapshot is not None
    assert snapshot.active_positions_total == 11
    assert snapshot.occupied_positions == 12
    assert snapshot.available_slots == 8


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


def test_projection_and_history_keep_one_canonical_row_per_workflow_stage() -> None:
    run = _large_run()
    run.stage_results.extend(
        [
            BullpenAutoLiveStageResult(
                stage_number=3,
                stage_name="Stage 3",
                status="warning",
                reason="Durable intents are retrying.",
                outputs={
                    "workflow_stage_key": "invest",
                    "phase_status": "running",
                    "orders_planned": 2,
                    "orders_processed": 2,
                    "orders_submitted": 0,
                },
                started_at="2026-07-26T10:00:06+00:00",
            ),
            BullpenAutoLiveStageResult(
                stage_number=6,
                stage_name="Internal diagnostics",
                status="pass",
                reason="Legacy internal stage.",
                outputs={"diagnostic": True},
                started_at="2026-07-26T10:00:07+00:00",
            ),
        ]
    )

    projection = build_run_console_projection(run)
    history = build_history_item(
        run,
        latest_update_at="2026-07-26T10:00:08+00:00",
        projection_available=True,
    )

    assert [
        stage["outputs"]["workflow_stage_key"]
        for stage in projection["stage_results"]
    ] == ["scan", "invest"]
    assert [stage.key for stage in history.stages] == ["scan", "invest"]
