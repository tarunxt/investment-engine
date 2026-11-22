from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
import json

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select

from app.core.recovery import recovery_http_allowed
from app.domains.jobs.models import Job
from app.domains.runs.models import AutoRebalanceWorkflow, AutoRebalanceWorkflowStage, Run, RunJob
from app.domains.scorecards.router import prepare_saved_swing
from app.domains.zerodha.models import ZerodhaPortfolioSnapshot as Snapshot
from test_auto_rebalance_audit_durability import audit_db, anyio_backend
from test_output_contracts import swing_row


@pytest.mark.anyio
@pytest.mark.parametrize("receipt", [True, False])
async def test_recover_original_holdings_and_jobs_without_dispatch(audit_db, receipt):
    async with audit_db.engine.begin() as conn:
        await conn.run_sync(Snapshot.__table__.create)
    async with audit_db.sessions() as db:
        parent = await db.get(AutoRebalanceWorkflow, 7001)
        at = datetime(2026, 1, 2, 8, tzinfo=timezone.utc)
        parent.created_at = at
        parent.status = "interrupted"
        capture = at + timedelta(seconds=1)
        snapshot = Snapshot(user_id=7, snapshot_date=capture.date(), captured_at=capture,
                            holdings_count=1, holdings=[{"exchange":"NSE", "tradingsymbol":"HOLD", "quantity":1}])
        run = Run(user_id=7, auto_rebalance_portfolio="india", auto_rebalance_sequence=42,
                  auto_rebalance_label="India Run #42 (Swing Scan)", prompt="India swing scan",
                  prompt_preview="India swing scan", status="completed", created_at=at+timedelta(seconds=2))
        db.add_all([snapshot, run])
        await db.flush()
        jobs = [Job(user_id=7, provider="fixture", model="one", status="completed", prompt="India swing scan",
                    response=json.dumps([swing_row(symbol)])) for symbol in ("HOLD", "NEW")]
        db.add_all(jobs)
        await db.flush()
        db.add_all([RunJob(run_id=run.id, job_id=j.id, stage=1) for j in jobs])
        db.add_all([
            AutoRebalanceWorkflowStage(workflow_id=parent.id, stage="sync", status="completed",
                                       summary_json={"final_inputs":{"snapshot_at":capture.isoformat()}} if receipt else {}),
            AutoRebalanceWorkflowStage(workflow_id=parent.id, stage="swing", status="completed", run_id=run.id),
            AutoRebalanceWorkflowStage(workflow_id=parent.id, stage="threats", status="interrupted"),
        ])
        await db.commit()
        user = SimpleNamespace(id=7)
        with pytest.raises(HTTPException, match="Workflow not found"):
            await prepare_saved_swing(42, db, SimpleNamespace(id=8))
        snapshot.captured_at = at + timedelta(minutes=10)
        await db.commit()
        with pytest.raises(HTTPException, match="holdings snapshot"):
            await prepare_saved_swing(42, db, user)
        snapshot.captured_at = capture
        await db.commit()
        result = await prepare_saved_swing(42, db, user)
        assert result == {"id":result["id"], "sequence":42, "listings":2, "snapshot_id":snapshot.id,
                          "swing_job_ids":[job.id for job in jobs]}
        assert await prepare_saved_swing(42, db, user) == result
        assert await db.scalar(select(func.count()).select_from(Job)) == 2
        audit_db.dispatch.assert_not_called()


def test_recovery_path_is_scoped_to_india():
    for market, seq, allowed in [("india", "42", True), ("indmoney_us", "42", False), ("india", "0", False)]:
        assert recovery_http_allowed("POST", f"/runs/scorecards/{market}/workflows/{seq}/prepare-swing-source") == allowed
