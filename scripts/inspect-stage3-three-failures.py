from __future__ import annotations

import json
from typing import Any

from sqlalchemy import text

from app.infrastructure.database.sync_session import sync_engine

RUN_ID = "211488a5-1233-4088-9118-21fe22ff074c"

STAGE_OUTPUT_KEYS = {
    "workflow_stage_key",
    "phase_status",
    "wallet_snapshot_status",
    "wallet_refresh_error",
    "wallet_market_enrichment_error",
    "wallet_market_enrichment_degraded",
    "stage2_candidate_only",
    "stage2_universe_complete",
    "stage2_actionable_contract_version",
    "stage2_actionable_contract_authoritative",
    "stage2_actionable_contract_execution_mode",
    "stage2_actionable_handoff_used",
    "stage2_actionable_handoff_source",
    "stage2_actionable_exit_market_ids",
    "stage2_actionable_buy_market_ids",
    "stage2_actionable_exit_count",
    "stage2_actionable_buy_count",
    "top_candidate_market_ids",
    "ranking_top_candidate_market_id_order",
    "top_active_keys",
    "orders_planned",
    "orders_processed",
    "orders_submitted",
    "sell_orders_planned",
    "buy_orders_planned",
    "event_exit_planned",
    "buy_queue_planned",
    "execution_steps",
    "stage2_handoff_checkpoint",
    "order_failure_count",
    "order_failures",
    "worker_error",
    "latest_worker_error",
    "blocked_by_stage1_wallet_refresh",
    "decisions_count",
}

DECISION_PAYLOAD_KEYS = {
    "decision",
    "reason",
    "risk_status",
    "stage3_final_rank",
    "order_plan",
    "order_status",
    "execution_status",
    "execution_error",
    "error",
    "action",
    "selected_for_stage3",
    "stage2_actionable",
    "stage2_actionable_source",
    "stage2_actionable_contract_authoritative",
    "stage2_actionable_contract_version",
}


def compact_payload(payload: Any, keys: set[str]) -> Any:
    if not isinstance(payload, dict):
        return payload
    result: dict[str, Any] = {}
    for key, value in payload.items():
        if key in keys:
            result[key] = value
    return result


def main() -> None:
    with sync_engine.connect() as conn:
        run = conn.execute(
            text(
                """
                SELECT id, user_id, status, triggered_by, dry_run,
                       live_execution_requested, live_execution_attempted,
                       started_at, completed_at, decisions_count,
                       orders_planned, orders_submitted, summary, error_message,
                       payload, console_projection
                FROM polymarket_auto_live_runs
                WHERE id = :run_id
                """
            ),
            {"run_id": RUN_ID},
        ).mappings().one()

        stage_results = []
        for stage in (run["payload"] or {}).get("stage_results", []):
            outputs = stage.get("outputs") or {}
            stage_results.append(
                {
                    "stage_number": stage.get("stage_number"),
                    "status": stage.get("status"),
                    "reason": stage.get("reason"),
                    "completed_items": stage.get("completed_items"),
                    "total_items": stage.get("total_items"),
                    "started_at": stage.get("started_at"),
                    "completed_at": stage.get("completed_at"),
                    "outputs": {
                        key: outputs.get(key)
                        for key in sorted(STAGE_OUTPUT_KEYS)
                        if key in outputs
                    },
                }
            )

        decisions = []
        for row in conn.execute(
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
        ).mappings():
            decisions.append(
                {
                    "id": row["id"],
                    "market_id": row["market_id"],
                    "slug": row["slug"],
                    "market_title": row["market_title"],
                    "side": row["side"],
                    "decision": row["decision"],
                    "risk_status": row["risk_status"],
                    "edge_pp": row["edge_pp"],
                    "score": row["score"],
                    "payload": compact_payload(row["payload"] or {}, DECISION_PAYLOAD_KEYS),
                    "console_projection": row["console_projection"],
                    "created_at": row["created_at"],
                    "updated_at": row["updated_at"],
                }
            )

        intents = []
        intent_rows = conn.execute(
            text(
                """
                SELECT id, decision_id, dependency_group, action, market_id, slug,
                       condition_id, side, requested_order_usd, requested_shares,
                       requested_limit_price_cents, current_order_usd,
                       current_shares, current_limit_price_cents, status,
                       error_class, last_error_code, last_error_message,
                       retryable, attempt_count, max_attempts, next_attempt_at,
                       priority, remote_order_id, remote_transaction_hash,
                       expected_release_usd, confirmed_release_usd, filled_shares,
                       remaining_shares, dependency_metadata_json,
                       execution_metadata_json, first_submitted_at,
                       last_submitted_at, confirmed_at, terminal_at,
                       created_at, updated_at
                FROM polymarket_auto_live_order_intents
                WHERE run_id = :run_id
                ORDER BY created_at, id
                """
            ),
            {"run_id": RUN_ID},
        ).mappings().all()
        for row in intent_rows:
            attempts = [
                dict(attempt)
                for attempt in conn.execute(
                    text(
                        """
                        SELECT attempt_number, worker_task_id, rpc_provider,
                               executor_path, started_at, completed_at,
                               result_status, error_code, error_message,
                               retry_after_seconds, remote_order_id,
                               remote_transaction_hash, sanitized_request_json,
                               sanitized_response_json, reconciliation_json
                        FROM polymarket_auto_live_order_attempts
                        WHERE intent_id = :intent_id
                        ORDER BY attempt_number
                        """
                    ),
                    {"intent_id": row["id"]},
                ).mappings()
            ]
            item = dict(row)
            item["attempts"] = attempts
            intents.append(item)

        output = {
            "run": {
                key: value
                for key, value in dict(run).items()
                if key not in {"payload", "console_projection"}
            },
            "run_payload_keys": sorted((run["payload"] or {}).keys()),
            "console_projection": run["console_projection"],
            "stage_results": stage_results,
            "decisions": decisions,
            "intents": intents,
        }
        print(json.dumps(output, default=str, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
