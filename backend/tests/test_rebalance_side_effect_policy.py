"""Privacy-safe, offline acceptance. All owner/run/job IDs are synthetic fixtures."""
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from test_auto_rebalance_audit_durability import audit_db, anyio_backend, write, email, snapshot, OWNER
from app.domains.runs import router as routes
from app.domains.runs.models import AutoRebalanceWorkflow, Run
from app.domains.jobs.models import Job
from app.domains.runs.schemas import AutoRebalanceRunReservationRequest
from app.domains.runs.side_effect_policy import (
    permits_side_effects, execution_allows_side_effects,
)
from app.domains.runs.use_cases import create_run
from app.shared.types import UserId

POLICY = {"version": 1, "mode": "analysis_only"}


@pytest.mark.parametrize("value,expected", [
    (None, True), ({"version": 1, "mode": "existing_preferences"}, True),
    (POLICY, False), ({}, False), ({"version": 2, "mode": "analysis_only"}, False),
    ({"version": 0, "mode": "existing_preferences"}, False),
    ({"version": 1, "mode": "unknown"}, False),
])
def test_stored_contract_is_backward_compatible_and_unknown_contract_fails_closed(value, expected):
    assert permits_side_effects(value) is expected


@pytest.mark.parametrize("value", [
    {}, {"version": 1}, {"mode": "analysis_only"},
    {"version": "1", "mode": "analysis_only"},
    {"version": True, "mode": "analysis_only"},
    {"version": 1.0, "mode": "analysis_only"},
    {"version": 2, "mode": "analysis_only"},
    {**POLICY, "notifications": True},
])
def test_request_rejects_missing_partial_malformed_or_unknown_policy(value):
    with pytest.raises(ValidationError):
        AutoRebalanceRunReservationRequest(portfolio="india", side_effect_policy=value)


@pytest.mark.anyio
async def test_reservation_freezes_policy_and_returns_it(audit_db, monkeypatch):
    from uuid import uuid4
    from app.domains.rebalance_budget.models import RebalanceSpendScope, RebalanceSpendBinding
    async with audit_db.engine.begin() as connection:
        await connection.run_sync(lambda db: RebalanceSpendScope.metadata.create_all(db,
            tables=[RebalanceSpendScope.__table__, RebalanceSpendBinding.__table__]))
    request_id = str(uuid4())
    monkeypatch.setattr(routes, "_reserve_auto_rebalance_sequence", AsyncMock(side_effect=[43, 44]))
    monkeypatch.setattr(routes, "_get_redis", lambda: SimpleNamespace(aclose=AsyncMock()))
    async with audit_db.sessions() as db:
        response = await routes.reserve_auto_rebalance_label(
            AutoRebalanceRunReservationRequest(portfolio="india", side_effect_policy=POLICY,
                spend_intent="new_workflow", spend_request_id=request_id, spend_observed_revision=0), db, OWNER,
        )
    assert response.side_effect_policy.model_dump() == POLICY
    async with audit_db.sessions() as db:
        replay = await routes.reserve_auto_rebalance_label(
            AutoRebalanceRunReservationRequest(portfolio="india", side_effect_policy={"version": 1, "mode": "existing_preferences"},
                spend_intent="new_workflow", spend_request_id=request_id, spend_observed_revision=0), db, OWNER)
    assert replay.side_effect_policy.model_dump() == POLICY
    assert replay.sequence == response.sequence and replay.spend_scope_id == response.spend_scope_id
    assert replay.reservation_created is False
    async with audit_db.sessions() as db:
        history = await routes._build_auto_rebalance_history(db, user_id=7, portfolio="india", sequences={43})
    assert history[0][0].side_effect_policy.model_dump() == POLICY


async def opt_out(audit_db):
    async with audit_db.sessions() as db:
        workflow = await db.get(AutoRebalanceWorkflow, 7001)
        workflow.side_effect_policy_json = POLICY.copy()
        await db.commit()


@pytest.mark.anyio
@pytest.mark.parametrize("status", ["completed", "partial", "failed", "paused", "interrupted", "cancelled", "skipped"])
async def test_stage_updates_and_repeated_completion_requests_cannot_send(audit_db, status):
    await opt_out(audit_db)
    await write(audit_db, "sync", status, summary={"side_effect_policy": {"version": 1, "mode": "existing_preferences"}})
    await write(audit_db, "sync", status)
    assert await email(audit_db) == {"status": "suppressed", "reason": "run_side_effect_policy"}
    assert await email(audit_db) == {"status": "suppressed", "reason": "run_side_effect_policy"}
    workflow, count, events = await snapshot(audit_db)
    assert workflow.side_effect_policy_json == POLICY
    assert count == 1
    assert events == 0
    audit_db.dispatch.assert_not_called()


@pytest.mark.anyio
async def test_policy_lookup_preserves_owner_market_and_sequence_boundaries(audit_db):
    await opt_out(audit_db)
    async with audit_db.sessions() as db:
        for owner, market, sequence, expected in [
            (7, "india", 42, False), (8, "india", 42, True),
            (7, "indmoney_us", 42, True), (7, "india", 0, True),
            (7, "india", None, True),
        ]:
            execution = SimpleNamespace(user_id=owner, auto_rebalance_portfolio=market, auto_rebalance_sequence=sequence)
            assert await execution_allows_side_effects(db, execution) is expected


@pytest.mark.anyio
@pytest.mark.parametrize("opted_out,recovery,expected", [(True, False, False), (False, False, True), (False, True, False), (True, True, False)])
async def test_run_creation_disables_exports_before_any_provider_or_profile_lookup(audit_db, monkeypatch, opted_out, recovery, expected):
    if opted_out:
        await opt_out(audit_db)
    monkeypatch.setattr(create_run, "require_equity_analysis", lambda *args: None)
    monkeypatch.setattr(create_run, "recovery_mode", lambda: recovery)
    freeze = AsyncMock(side_effect=RuntimeError("stop before provider lookup"))
    monkeypatch.setattr(create_run, "freeze_output_source_context", freeze)
    cmd = create_run.CreateRunCommand(prompt="Synthetic", targets=[create_run.RunModelTarget("synthetic", "fixture")],
        user_id=UserId(7), auto_export_enabled=True, auto_rebalance_portfolio="india", auto_rebalance_sequence=42)
    async with audit_db.sessions() as db:
        with pytest.raises(RuntimeError, match="stop before provider lookup"):
            await create_run.CreateRunUseCase(db, None).execute(cmd)
    assert freeze.call_args.kwargs["target"].auto_export_enabled is expected
    assert cmd.auto_export_enabled is True  # The caller and user preferences are unchanged.


@pytest.mark.anyio
@pytest.mark.parametrize("kind", ["job", "run"])
async def test_export_workers_suppress_repeated_queued_requests_before_credentials(audit_db, monkeypatch, kind):
    await opt_out(audit_db)
    from app.domains.google_sheets import tasks
    engine = create_engine(audit_db.sync_url)
    with Session(engine) as db:
        model = Job if kind == "job" else Run
        values = {"id": 123, "user_id": 7, "prompt": "Synthetic", "auto_rebalance_portfolio": "india", "auto_rebalance_sequence": 42}
        if kind == "job":
            values.update(provider="synthetic", model="fixture")
        else:
            values.update(prompt_preview="Synthetic")
        db.add(model(**values))
        db.commit()
    monkeypatch.setattr(tasks, "SyncSessionLocal", lambda: Session(engine))
    monkeypatch.setattr(tasks, "decrypt_token", lambda *_: pytest.fail("must not access credentials"))
    task = tasks.export_job_to_sheets_task if kind == "job" else tasks.export_run_to_sheets_task
    for _ in range(2):
        assert task.run(7, 123, None) == {"status": "suppressed", "reason": "run_side_effect_policy"}
    engine.dispose()
