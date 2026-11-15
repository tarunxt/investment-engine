#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.domains.polymarket_auto_live.models import PolymarketAutoLiveRunRecord  # noqa: E402
from app.domains.polymarket_auto_live.repository import (  # noqa: E402
    SyncPolymarketAutoLiveRepository,
    extract_stage3_decisions_from_run,
    record_to_run,
)
from app.domains.polymarket_auto_live.run_recovery import (  # noqa: E402
    reconcile_running_auto_live_run,
)
from app.infrastructure.database.sync_session import SyncSessionLocal  # noqa: E402


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Safely reconcile one Bullpen Auto-Live run so persisted Stage 3 "
            "decision rows are restored from the run payload without "
            "submitting any new orders."
        )
    )
    parser.add_argument("--run-id", required=True, help="Bullpen Auto-Live run id")
    parser.add_argument(
        "--user-id",
        type=int,
        default=None,
        help="Optional user id guard. The script exits if the run belongs to a different user.",
    )
    return parser.parse_args()


def main() -> int:
    args = _parse_args()

    with SyncSessionLocal() as session:
        repo = SyncPolymarketAutoLiveRepository(session)
        record = session.get(PolymarketAutoLiveRunRecord, args.run_id)
        if record is None:
            print(json.dumps({"ok": False, "error": f"Run {args.run_id} was not found."}))
            return 1

        if args.user_id is not None and record.user_id != args.user_id:
            print(
                json.dumps(
                    {
                        "ok": False,
                        "error": (
                            f"Run {args.run_id} belongs to user {record.user_id}, "
                            f"not {args.user_id}."
                        ),
                    }
                )
            )
            return 1

        user_id = int(record.user_id)
        run = record_to_run(record)
        recovered_running_run = False
        if run.status == "running":
            recovered = reconcile_running_auto_live_run(
                run,
                started_at=record.started_at,
                updated_at=record.updated_at,
            )
            if recovered is not None:
                run = recovered
                repo.save_run(user_id, run)
                recovered_running_run = True

        stored_before = repo.count_decisions_by_run([run.id]).get(run.id, 0)
        payload_decisions = extract_stage3_decisions_from_run(run)
        payload_count = None if payload_decisions is None else len(payload_decisions)
        restored = 0
        if payload_decisions is not None and stored_before < len(payload_decisions):
            restored = repo.replace_run_decisions_from_stage3_payload(user_id, run)

        session.commit()

    print(
        json.dumps(
            {
                "ok": True,
                "run_id": run.id,
                "user_id": user_id,
                "run_status": run.status,
                "recovered_running_run": recovered_running_run,
                "stage3_payload_decisions": payload_count,
                "stored_stage3_decisions_before": stored_before,
                "stored_stage3_decisions_after": max(stored_before, restored),
                "restored_from_payload": restored,
                "safe_no_new_orders_submitted": True,
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
