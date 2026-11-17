from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from app.domains.runs import swing_reconciliation as recovery
from app.shared.types import JobStatus


def child(**changes):
    claim = {"state": "owned", "expires_at": 100, "provider_started": True, "pending_calls": 0}
    return SimpleNamespace(status=JobStatus.PROCESSING, response="saved rows", scheduled_at=None,
                           runtime_metadata_json={"execution_claim": {**claim, **changes}})


@pytest.mark.parametrize("changes", [{"expires_at": 201}, {"pending_calls": 1},
                                     {"provider_started": False}, {"state": "retrying"}])
def test_live_or_uncertain_job_is_preserved(changes):
    assert not recovery.returned_after_owner_expiry(child(**changes), 200)


@pytest.mark.asyncio
@pytest.mark.parametrize("pending, outcome", [(0, JobStatus.PARTIAL), (1, JobStatus.FAILED)])
async def test_one_pass_one_recovered_partial(monkeypatch, pending, outcome):
    passed, partial = child(), child(state="reconciliation_needed", pending_calls=pending)
    passed.status = JobStatus.COMPLETED
    run = SimpleNamespace(id=488, current_stage=1, status=JobStatus.PROCESSING,
                          auto_rebalance_sequence=225, auto_rebalance_label="India Run #225 (Swing Scan)",
                          run_jobs=[SimpleNamespace(stage=1, job=j) for j in (passed, partial)])
    db = AsyncMock()
    locked, rows = Mock(), Mock()
    locked.one.return_value = SimpleNamespace(status=run.status, current_stage=1)
    rows.scalars.return_value.all.return_value = [passed, partial]
    db.execute.side_effect = [locked, rows]
    monkeypatch.setattr(recovery, "configure_output_context", lambda *args: None)
    monkeypatch.setattr(recovery, "output_validation_metadata", lambda s: {"safe_to_render": True})
    await recovery.reconcile_swing(db, run)
    await recovery.reconcile_swing(db, run)
    assert passed.status == JobStatus.COMPLETED
    assert partial.status == outcome
    assert run.status == JobStatus.PARTIAL
    db.commit.assert_awaited_once()
