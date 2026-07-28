from __future__ import annotations

import json
import traceback

from sqlalchemy import func, select

from app.domains.polymarket_auto_live.models import (
    PolymarketAutoLiveDecisionRecord,
    PolymarketAutoLiveOrderIntentRecord,
    PolymarketAutoLiveRunRecord,
)
from app.infrastructure.database.sync_session import SyncSessionLocal

OUTPUT_KEYS = {
    "workflow_stage_key",
    "phase_status",
    "wallet_snapshot_status",
    "wallet_recovery_status",
    "wallet_refresh_error",
    "stage2_candidate_only",
    "stage2_eligible_rows_total",
    "stage2_reviewed_rows",
    "stage2_skipped_rows",
    "stage2_universe_complete",
    "stage2_universe_blocker_code",
    "stage2_actionable_handoff_used",
    "stage2_actionable_handoff_source",
    "stage2_actionable_exit_count",
    "stage2_actionable_buy_count",
    "stage2_actionable_exit_market_ids",
    "stage2_actionable_buy_market_ids",
    "top_candidate_market_ids",
    "ranking_top_candidate_market_id_order",
    "top_active_keys",
    "active_position_rows",
    "active_position_rows_before_llm",
    "candidate_decision_rows",
    "decisions_count",
    "orders_planned",
    "orders_processed",
    "orders_submitted",
    "event_exit_rows",
    "event_exit_planned",
    "sell_orders_planned",
    "buy_queue_planned",
    "buy_orders_planned",
    "execution_steps",
    "stage2_handoff_checkpoint",
}


def main() -> None:
    with SyncSessionLocal() as session:
        run_record = session.execute(
            select(PolymarketAutoLiveRunRecord)
            .order_by(PolymarketAutoLiveRunRecord.started_at.desc())
            .limit(1)
        ).scalar_one()
        payload = run_record.payload or {}
        stages: list[dict[str, object]] = []
        for stage in payload.get("stage_results", []):
            outputs = stage.get("outputs") or {}
            key = outputs.get("workflow_stage_key")
            if key not in {"scan", "llm", "invest"}:
                continue
            stages.append(
                {
                    "stage_number": stage.get("stage_number"),
                    "status": stage.get("status"),
                    "reason": stage.get("reason"),
                    "completed_at": stage.get("completed_at"),
                    "outputs": {
                        name: outputs.get(name)
                        for name in sorted(OUTPUT_KEYS)
                        if name in outputs
                    },
                }
            )
        decision_count = session.scalar(
            select(func.count())
            .select_from(PolymarketAutoLiveDecisionRecord)
            .where(PolymarketAutoLiveDecisionRecord.run_id == run_record.id)
        )
        intent_rows = session.execute(
            select(
                PolymarketAutoLiveOrderIntentRecord.action,
                PolymarketAutoLiveOrderIntentRecord.status,
                func.count(),
            )
            .where(PolymarketAutoLiveOrderIntentRecord.run_id == run_record.id)
            .group_by(
                PolymarketAutoLiveOrderIntentRecord.action,
                PolymarketAutoLiveOrderIntentRecord.status,
            )
            .order_by(
                PolymarketAutoLiveOrderIntentRecord.action,
                PolymarketAutoLiveOrderIntentRecord.status,
            )
        ).all()
        result = {
            "run": {
                "id": run_record.id,
                "user_id": run_record.user_id,
                "status": run_record.status,
                "started_at": run_record.started_at.isoformat(),
                "completed_at": run_record.completed_at.isoformat()
                if run_record.completed_at
                else None,
                "decisions_count_column": run_record.decisions_count,
                "orders_planned_column": run_record.orders_planned,
                "orders_submitted_column": run_record.orders_submitted,
                "summary": run_record.summary,
                "error_message": run_record.error_message,
            },
            "decision_rows_in_db": decision_count,
            "intent_counts": [
                {"action": action, "status": status, "count": count}
                for action, status, count in intent_rows
            ],
            "stages": stages,
        }
        print(json.dumps(result, sort_keys=True, default=str, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        raise
