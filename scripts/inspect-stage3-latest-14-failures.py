from __future__ import annotations

import json
import traceback
from typing import Any

from sqlalchemy import text

from app.infrastructure.database.sync_session import sync_engine

RUN_ID = "235062c3-efd1-41c9-9f33-6283c5e74769"

STAGE_KEYS = {
    "workflow_stage_key",
    "phase_status",
    "progress_commentary",
    "error_message",
    "failure_category",
    "current_blockage",
    "how_to_resolve",
    "execution_gate_reason",
    "stage2_candidate_only",
    "stage2_universe_complete",
    "stage2_universe_status",
    "stage2_universe_blocker_code",
    "stage2_actionable_contract_version",
    "stage2_actionable_contract_authoritative",
    "stage2_actionable_contract_execution_mode",
    "stage2_actionable_handoff_used",
    "stage2_actionable_handoff_source",
    "stage2_actionable_exit_market_ids",
    "stage2_actionable_buy_market_ids",
    "stage2_actionable_exit_count",
    "stage2_actionable_buy_count",
    "missing_stage2_actionable_exit_market_ids",
    "missing_stage2_actionable_buy_market_ids",
    "stage2_handoff_checkpoint",
    "orders_planned",
    "orders_processed",
    "orders_submitted",
    "event_exit_rows",
    "event_exit_planned",
    "event_exit_processed",
    "event_exit_submitted",
    "sell_orders_planned",
    "buy_queue_planned",
    "buy_orders_planned",
    "persisted_execution_counters",
    "execution_steps",
    "post_exit_snapshot_source",
    "post_exit_snapshot_fetched_at",
    "post_exit_snapshot_freshness_state",
    "post_exit_snapshot_lineage",
    "post_exit_snapshot_lineage_comparison",
    "slot_allocation",
}


def compact_stage_results(payload: object) -> list[dict[str, object]]:
    if not isinstance(payload, dict):
        return []
    rows: list[dict[str, object]] = []
    for stage in payload.get("stage_results", []):
        if not isinstance(stage, dict):
            continue
        outputs = stage.get("outputs")
        if not isinstance(outputs, dict):
            outputs = {}
        workflow_key = outputs.get("workflow_stage_key")
        if workflow_key not in {"scan", "llm", "invest"}:
            continue
        rows.append(
            {
                "stage_number": stage.get("stage_number"),
                "stage_name": stage.get("stage_name"),
                "status": stage.get("status"),
                "reason": stage.get("reason"),
                "hard_block": stage.get("hard_block"),
                "started_at": stage.get("started_at"),
                "completed_at": stage.get("completed_at"),
                "outputs": {
                    key: outputs.get(key)
                    for key in sorted(STAGE_KEYS)
                    if key in outputs
                },
            }
        )
    return rows


def compact_decision_payload(payload: object) -> dict[str, object]:
    if not isinstance(payload, dict):
        return {}
    plan = payload.get("order_plan")
    compact_plan: dict[str, object] | None = None
    if isinstance(plan, dict):
        compact_plan = {
            key: plan.get(key)
            for key in (
                "id",
                "action",
                "side",
                "status",
                "stage3_status",
                "market_id",
                "dependency_group",
                "order_size_usd",
                "shares",
                "limit_price_cents",
                "detail",
                "retryable",
                "attempt_count",
                "next_retry_at",
                "current_blockage",
                "actionable_resolution",
                "latest_error_code",
                "remote_order_id",
                "remote_transaction_hash",
                "executed_at",
                "confirmed_at",
                "terminal_at",
            )
            if key in plan
        }
    return {
        key: payload.get(key)
        for key in (
            "id",
            "market_id",
            "market_title",
            "slug",
            "side",
            "decision",
            "risk_status",
            "stage3_result",
            "stage3_result_reason",
            "stage3_final_rank",
            "stage3_status",
            "stage3_blocker",
            "selected_for_auto_invest",
            "selection_block_reason",
            "target_exposure_usd",
            "reason",
            "summary",
            "exit_state",
        )
        if key in payload
    } | {"order_plan": compact_plan}


def main() -> None:
    with sync_engine.connect() as connection:
        run = connection.execute(
            text(
                """
                SELECT id, user_id, status, triggered_by, dry_run, started_at,
                       completed_at, live_execution_requested,
                       live_execution_attempted, decisions_count, orders_planned,
                       orders_submitted, summary, error_message, payload,
                       console_projection
                FROM polymarket_auto_live_runs
                WHERE id = :run_id
                """
            ),
            {"run_id": RUN_ID},
        ).mappings().one()

        settings = connection.execute(
            text(
                """
                SELECT payload
                FROM polymarket_auto_live_settings
                WHERE user_id = :user_id
                """
            ),
            {"user_id": run["user_id"]},
        ).mappings().one_or_none()
        state = connection.execute(
            text(
                """
                SELECT running, paused, status, mode, last_run_at, next_run_at, payload
                FROM polymarket_auto_live_states
                WHERE user_id = :user_id
                """
            ),
            {"user_id": run["user_id"]},
        ).mappings().one_or_none()

        decisions = connection.execute(
            text(
                """
                SELECT id, market_id, slug, market_title, side, decision,
                       risk_status, edge_pp, score, payload, console_projection,
                       created_at, updated_at
                FROM polymarket_auto_live_decisions
                WHERE run_id = :run_id
                ORDER BY created_at, id
                """
            ),
            {"run_id": RUN_ID},
        ).mappings().all()

        intents = connection.execute(
            text(
                """
                SELECT id, decision_id, dependency_group, action, market_id, slug,
                       condition_id, side, requested_order_usd, requested_shares,
                       requested_limit_price_cents, current_order_usd, current_shares,
                       current_limit_price_cents, max_slippage_cents, status,
                       error_class, last_error_code, last_error_message, retryable,
                       attempt_count, max_attempts, next_attempt_at, priority,
                       remote_order_id, remote_transaction_hash, reserved_cash_usd,
                       expected_release_usd, confirmed_release_usd, filled_shares,
                       remaining_shares, average_fill_price_cents,
                       dependency_metadata_json, execution_metadata_json,
                       first_submitted_at, last_submitted_at, confirmed_at,
                       terminal_at, created_at, updated_at
                FROM polymarket_auto_live_order_intents
                WHERE run_id = :run_id
                ORDER BY created_at, id
                """
            ),
            {"run_id": RUN_ID},
        ).mappings().all()

        attempts = connection.execute(
            text(
                """
                SELECT a.intent_id, a.attempt_number, a.worker_task_id,
                       a.rpc_provider, a.executor_path, a.started_at, a.completed_at,
                       a.result_status, a.error_code, a.error_message,
                       a.retry_after_seconds, a.remote_order_id,
                       a.remote_transaction_hash, a.sanitized_request_json,
                       a.sanitized_response_json, a.reconciliation_json
                FROM polymarket_auto_live_order_attempts a
                JOIN polymarket_auto_live_order_intents i ON i.id = a.intent_id
                WHERE i.run_id = :run_id
                ORDER BY a.intent_id, a.attempt_number
                """
            ),
            {"run_id": RUN_ID},
        ).mappings().all()

        relevant_settings: dict[str, object] = {}
        if settings and isinstance(settings["payload"], dict):
            relevant_settings = {
                key: settings["payload"].get(key)
                for key in (
                    "auto_live_enabled",
                    "dry_run",
                    "require_manual_confirmation",
                    "allow_live_execution",
                    "limit_orders_only",
                    "min_order_usd",
                    "max_order_usd",
                    "console_order_usd",
                    "max_new_markets_per_rebalance",
                    "pause_after_consecutive_failed_orders",
                    "pause_if_balance_unavailable",
                    "pause_if_doctor_fails",
                    "emergency_stop",
                    "stage3_capacity_override",
                )
                if key in settings["payload"]
            }

        result: dict[str, Any] = {
            "run": {
                key: run[key]
                for key in (
                    "id",
                    "user_id",
                    "status",
                    "triggered_by",
                    "dry_run",
                    "started_at",
                    "completed_at",
                    "live_execution_requested",
                    "live_execution_attempted",
                    "decisions_count",
                    "orders_planned",
                    "orders_submitted",
                    "summary",
                    "error_message",
                )
            },
            "settings": relevant_settings,
            "runtime_state": dict(state) if state else None,
            "full_stage_results": compact_stage_results(run["payload"]),
            "console_projection_stage_results": compact_stage_results(
                run["console_projection"]
            ),
            "decisions": [
                {
                    "record": {
                        key: decision[key]
                        for key in (
                            "id",
                            "market_id",
                            "slug",
                            "market_title",
                            "side",
                            "decision",
                            "risk_status",
                            "edge_pp",
                            "score",
                            "created_at",
                            "updated_at",
                        )
                    },
                    "payload": compact_decision_payload(decision["payload"]),
                    "console_projection": compact_decision_payload(
                        decision["console_projection"]
                    ),
                }
                for decision in decisions
            ],
            "intents": [dict(row) for row in intents],
            "attempts": [dict(row) for row in attempts],
        }
        print(json.dumps(result, indent=2, sort_keys=True, default=str))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        raise
