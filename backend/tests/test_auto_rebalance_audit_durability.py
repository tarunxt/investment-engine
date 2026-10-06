"""Offline route regressions against real SQLAlchemy/SQLite transactions.

External sockets and task dispatch are disabled. PostgreSQL locking has a
separate, explicitly opted-in integration suite.
"""
import json
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from sqlalchemy import event, func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import app.models  # noqa: F401 - register mapped relationship targets
from app.domains.auth.models import ActivityLog, User
from app.domains.jobs.models import Job
from app.domains.prompts.models import Prompt
from app.domains.runs import router as routes
from app.domains.runs.models import AutoRebalanceWorkflow, AutoRebalanceWorkflowStage, Run, RunJob
from app.domains.runs.schemas import AutoRebalanceCompletionEmailRequest, AutoRebalanceStageUpdateRequest
from app.infrastructure.database.base import Base
from app.shared.types import JobStatus

TABLES = [model.__table__ for model in (
    User, Prompt, Job, Run, RunJob, AutoRebalanceWorkflow,
    AutoRebalanceWorkflowStage, ActivityLog,
)]
OWNER = SimpleNamespace(id=7)
START = datetime(2026, 1, 2, 8, 0, tzinfo=timezone.utc)
FINISH = datetime(2026, 1, 2, 8, 2, tzinfo=timezone.utc)
LATE = datetime(2026, 1, 2, 8, 5, tzinfo=timezone.utc)


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def audit_db(monkeypatch, tmp_path):
    monkeypatch.setattr("socket.socket.connect", Mock(side_effect=AssertionError("offline audit test")))
    monkeypatch.setattr("socket.socket.connect_ex", Mock(side_effect=AssertionError("offline audit test")))
    monkeypatch.setattr("socket.create_connection", Mock(side_effect=AssertionError("offline audit test")))
    dispatch = Mock()
    monkeypatch.setattr("app.domains.mails.tasks.deliver_completion_email.delay", dispatch)
    database_path = tmp_path / "audit.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{database_path}")
    async with engine.begin() as connection:
        await connection.exec_driver_sql("PRAGMA foreign_keys=ON")
        await connection.run_sync(lambda db: Base.metadata.create_all(db, tables=TABLES))
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as db:
        db.add_all([
            User(id=7, email="owner@example.test", username="owner", password_hash="unused"),
            User(id=8, email="other@example.test", username="other", password_hash="unused"),
            AutoRebalanceWorkflow(id=7001, user_id=7, portfolio="india", sequence=42, label="India Run #42"),
        ])
        await db.commit()
    yield SimpleNamespace(engine=engine, sessions=sessions, dispatch=dispatch, sync_url=f"sqlite:///{database_path}")
    await engine.dispose()


def response_facts(response):
    facts = response.model_dump()
    for field in ("started_at", "completed_at"):
        if facts[field] is not None:
            facts[field] = facts[field].replace(tzinfo=timezone.utc)
    return facts


async def write(audit_db, stage, status, *, user=OWNER, **fields):
    async with audit_db.sessions() as db:
        return await routes.update_auto_rebalance_stage(
            "india", 42, stage, AutoRebalanceStageUpdateRequest(status=status, **fields), db, user,
        )


async def snapshot(audit_db):
    async with audit_db.sessions() as db:
        workflow = await db.get(AutoRebalanceWorkflow, 7001)
        count = await db.scalar(select(func.count()).select_from(AutoRebalanceWorkflowStage))
        events = await db.scalar(select(func.count()).select_from(ActivityLog))
        return workflow, count, events


async def email(audit_db, **fields):
    async with audit_db.sessions() as db:
        user = fields.pop("user", OWNER)
        return await routes.queue_auto_rebalance_completion_email(
            AutoRebalanceCompletionEmailRequest(
                portfolio="india", sequence=42, label="Untrusted client label", completed_at=LATE,
                stages_completed=["Unpersisted client claim"], **fields,
            ), user, db,
        )


@pytest.fixture
def email_queue(monkeypatch):
    class FakeRedis:
        def __init__(self):
            self.keys = set()
            self.calls = []
            self.closed = 0

        async def get(self, key):
            self.calls.append(key)
            return "1" if key in self.keys else None

        async def aclose(self):
            self.closed += 1

    redis = FakeRedis()
    factory = Mock(return_value=redis)
    send = Mock()
    monkeypatch.setattr(routes, "_get_redis", factory)
    monkeypatch.setattr("app.domains.runs.tasks.send_auto_rebalance_success_email_task.delay", send)
    return SimpleNamespace(redis=redis, factory=factory, send=send)


@pytest.mark.anyio
@pytest.mark.parametrize("stage", routes.AUTO_REBALANCE_STAGE_ORDER)
async def test_first_write_serializes_and_persists_each_stage(audit_db, stage):
    app = FastAPI()
    app.include_router(routes.router)

    async def get_db():
        async with audit_db.sessions() as db:
            yield db

    app.dependency_overrides[routes.get_async_db] = get_db
    app.dependency_overrides[routes.get_current_user] = lambda: OWNER
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.patch(
            f"/runs/auto-rebalance-history/india/42/stages/{stage}", json={"status": "processing"},
        )
    assert response.status_code == 200, response.text
    assert response.json()["stage"] == stage
    assert response.json()["status"] == "processing"
    workflow, count, events = await snapshot(audit_db)
    assert (workflow.status, workflow.current_stage, count, events) == ("processing", stage, 1, 0)


@pytest.mark.anyio
@pytest.mark.parametrize("status", sorted(routes.AUTO_REBALANCE_TERMINAL_STATUSES))
async def test_first_terminal_write_and_retry_preserve_outcome(audit_db, status):
    first = await write(audit_db, "sync", status, started_at=START, completed_at=FINISH, error_message="original")
    replay = await write(audit_db, "sync", "processing", started_at=LATE, completed_at=LATE, error_message="stale")
    assert response_facts(replay) == response_facts(first)
    _, count, events = await snapshot(audit_db)
    expected_events = int(status in {"completed", "partial"})
    assert (count, events) == (1, expected_events)
    assert audit_db.dispatch.call_count == expected_events


@pytest.mark.anyio
async def test_processing_completion_retry_preserves_execution_link(audit_db):
    async with audit_db.sessions() as db:
        db.add(Run(id=9001, user_id=7, prompt="scan", prompt_preview="scan", status=JobStatus.COMPLETED,
                   auto_rebalance_portfolio="india", auto_rebalance_sequence=42,
                   auto_rebalance_label="India Run #42 (Swing Scan)"))
        await db.commit()
    await write(audit_db, "swing", "processing", started_at=START)
    first = await write(audit_db, "swing", "completed", run_id=9001, completed_at=FINISH, summary={"stocks": 3})
    replay = await write(audit_db, "swing", "completed", completed_at=LATE, summary={"stocks": 3})
    assert response_facts(replay) == response_facts(first)
    linked = await write(audit_db, "swing", "processing", run_id=9001)
    assert linked.status == "completed" and linked.run_id == 9001
    assert linked.completed_at.replace(tzinfo=timezone.utc) == first.completed_at.replace(tzinfo=timezone.utc)
    _, count, events = await snapshot(audit_db)
    assert (count, events, audit_db.dispatch.call_count) == (1, 1, 1)


@pytest.mark.anyio
async def test_queued_retry_cannot_regress_processing_or_earlier_parent_stage(audit_db):
    await write(audit_db, "sync", "processing", started_at=START)
    await write(audit_db, "technical", "processing")
    retry = await write(audit_db, "sync", "queued", completed_at=LATE)
    workflow, _, _ = await snapshot(audit_db)
    assert retry.status == "processing" and retry.completed_at is None
    assert (workflow.status, workflow.current_stage, workflow.completed_at) == ("processing", "technical", None)


@pytest.mark.anyio
@pytest.mark.parametrize("status", ["completed", "partial", "failed", "paused", "cancelled", "interrupted"])
async def test_terminal_parent_cannot_be_reopened_by_delayed_stage(audit_db, status):
    for stage in ("sync", "threats", "swing", "rebalance", "technical"):
        await write(audit_db, stage, "skipped", completed_at=START)
    await write(audit_db, "actionables", status, completed_at=FINISH, error_message="original")
    before, _, _ = await snapshot(audit_db)
    await write(audit_db, "sync", "processing", completed_at=LATE, error_message="stale")
    # A terminal update to another stage also cannot overwrite the parent.
    await write(audit_db, "threats", "failed", completed_at=LATE)
    after, _, _ = await snapshot(audit_db)
    assert (after.status, after.current_stage, after.completed_at, after.error_message) == (
        before.status, before.current_stage, before.completed_at, before.error_message,
    )
    async with audit_db.sessions() as db:
        history = await routes.get_auto_rebalance_history_detail("india", 42, db, OWNER)
    assert (history.status, history.current_stage, history.error_message) == (
        before.status, before.current_stage, before.error_message,
    )


@pytest.mark.anyio
@pytest.mark.parametrize("status", ["failed", "paused", "cancelled", "interrupted"])
async def test_failure_and_manual_stop_preserve_parent_reason(audit_db, status):
    await write(audit_db, "swing", status, error_message="Stopped here", completed_at=FINISH)
    await write(audit_db, "actionables", "completed", completed_at=LATE)
    workflow, _, _ = await snapshot(audit_db)
    assert (workflow.status, workflow.current_stage, workflow.error_message) == (status, "swing", "Stopped here")
    assert workflow.completed_at.replace(tzinfo=timezone.utc) == FINISH


@pytest.mark.anyio
async def test_history_uses_durable_parent_and_keeps_completed_outputs(audit_db):
    await write(audit_db, "sync", "completed", completed_at=START)
    async with audit_db.sessions() as db:
        db.add(Run(id=9001, user_id=7, prompt="scan output", prompt_preview="scan", status=JobStatus.COMPLETED,
                   auto_rebalance_portfolio="india", auto_rebalance_sequence=42))
        await db.commit()
        result = await routes.get_auto_rebalance_history_detail("india", 42, db, OWNER)
    assert result.status == "processing" and result.current_stage == "sync" and result.completed_at is None
    assert [run.id for run in result.runs] == [9001]
    assert result.runs[0].prompt == "scan output"


@pytest.mark.anyio
async def test_history_still_derives_legacy_run_without_parent(audit_db):
    async with audit_db.sessions() as db:
        run = Run(id=9002, user_id=7, prompt="legacy", prompt_preview="legacy", status=JobStatus.COMPLETED,
                  auto_rebalance_portfolio="india", auto_rebalance_sequence=43)
        job = Job(id=8001, user_id=7, prompt="legacy", provider="test", model="test", status=JobStatus.COMPLETED)
        db.add_all([run, job, RunJob(run=run, job=job)])
        await db.commit()
        result = await routes.get_auto_rebalance_history_detail("india", 43, db, OWNER)
    assert result.status == "completed" and result.current_stage == "swing"
    assert result.runs[0].jobs[0].id == 8001


@pytest.mark.anyio
async def test_database_failure_rolls_back_stage_parent_and_completion_event(audit_db):
    def fail_stage_insert(connection, cursor, statement, parameters, context, many):
        if statement.startswith("INSERT INTO auto_rebalance_workflow_stages"):
            raise RuntimeError("simulated audit database failure")

    event.listen(audit_db.engine.sync_engine, "before_cursor_execute", fail_stage_insert)
    try:
        with pytest.raises(RuntimeError, match="audit database failure"):
            await write(audit_db, "actionables", "completed", completed_at=FINISH)
    finally:
        event.remove(audit_db.engine.sync_engine, "before_cursor_execute", fail_stage_insert)
    workflow, count, events = await snapshot(audit_db)
    assert (workflow.status, workflow.current_stage, count, events) == ("queued", "sync", 0, 0)
    audit_db.dispatch.assert_not_called()


@pytest.mark.anyio
@pytest.mark.parametrize("reference", ["run_id", "job_id"])
@pytest.mark.parametrize("case,expected", [("missing", 404), ("owner", 404), ("sequence", 422), ("portfolio", 422)])
async def test_referenced_records_must_exist_and_match_owner_and_workflow(audit_db, reference, case, expected):
    if case != "missing":
        fields = dict(id=9001, user_id=8 if case == "owner" else 7, prompt="scan",
                      auto_rebalance_portfolio="indmoney_us" if case == "portfolio" else "india",
                      auto_rebalance_sequence=43 if case == "sequence" else 42)
        row = Run(**fields, prompt_preview="scan") if reference == "run_id" else Job(**fields, provider="test", model="test")
        async with audit_db.sessions() as db:
            db.add(row)
            await db.commit()
    with pytest.raises(HTTPException) as error:
        await write(audit_db, "swing", "processing", **{reference: 9001})
    assert error.value.status_code == expected
    workflow, count, events = await snapshot(audit_db)
    assert (workflow.status, count, events) == ("queued", 0, 0)


@pytest.mark.anyio
async def test_wrong_owner_cannot_update_or_queue_email(audit_db, email_queue):
    with pytest.raises(HTTPException) as update_error:
        await write(audit_db, "sync", "processing", user=SimpleNamespace(id=8))
    with pytest.raises(HTTPException) as email_error:
        await email(audit_db, user=SimpleNamespace(id=8))
    assert update_error.value.status_code == email_error.value.status_code == 404
    email_queue.factory.assert_not_called()
    assert (await snapshot(audit_db))[1:] == (0, 0)


@pytest.mark.anyio
async def test_routes_require_authentication(audit_db, monkeypatch, email_queue):
    app = FastAPI()
    app.include_router(routes.router)
    monkeypatch.setattr("app.domains.auth.dependencies.is_auth_disabled", lambda: False)

    async def get_db():
        async with audit_db.sessions() as db:
            yield db

    app.dependency_overrides[routes.get_async_db] = get_db
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        stage_response = await client.patch("/runs/auto-rebalance-history/india/42/stages/sync", json={"status": "processing"})
        email_response = await client.post("/runs/auto-rebalance-completion-email", json={
            "portfolio": "india", "sequence": 42, "label": "claim", "completed_at": FINISH.isoformat(),
        })
    assert stage_response.status_code == email_response.status_code == 401
    email_queue.factory.assert_not_called()


@pytest.mark.anyio
@pytest.mark.parametrize("case", ["missing", "queued", "missing_stage", "processing_stage", "failed_stage", "missing_timestamp", "missing_parent_timestamp", "failed_parent"])
async def test_email_refuses_incomplete_or_unsuccessful_durable_evidence(audit_db, email_queue, case):
    if case == "missing":
        async with audit_db.sessions() as db:
            await db.delete(await db.get(AutoRebalanceWorkflow, 7001))
            await db.commit()
    elif case != "queued":
        for stage in routes.AUTO_REBALANCE_STAGE_ORDER:
            if stage == "technical" and case == "missing_stage":
                continue
            status = "processing" if stage == "technical" and case == "processing_stage" else "completed"
            await finish_with_execution(audit_db, stage, status, completed_at=FINISH)
        async with audit_db.sessions() as db:
            if case in {"missing_timestamp", "failed_stage"}:
                stage = (await db.execute(select(AutoRebalanceWorkflowStage).where(AutoRebalanceWorkflowStage.stage == "technical"))).scalar_one()
                if case == "missing_timestamp":
                    stage.completed_at = None
                else:
                    stage.status = "failed"
            if case == "failed_parent":
                (await db.get(AutoRebalanceWorkflow, 7001)).status = "failed"
            if case == "missing_parent_timestamp":
                (await db.get(AutoRebalanceWorkflow, 7001)).completed_at = None
            await db.commit()
    with pytest.raises(HTTPException) as error:
        await email(audit_db)
    assert error.value.status_code == (404 if case == "missing" else 409)
    email_queue.factory.assert_not_called()
    email_queue.send.assert_not_called()


@pytest.mark.anyio
async def test_email_uses_persisted_evidence_and_deduplicates(audit_db, email_queue):
    for index, stage in enumerate(routes.AUTO_REBALANCE_STAGE_ORDER):
        status = "skipped" if stage == "technical" else "partial" if stage == "threats" else "completed"
        fields = {}
        if stage in {"threats", "swing", "rebalance"}:
            async with audit_db.sessions() as db:
                run = Run(id=400 + index, user_id=7, prompt="scan", prompt_preview="scan",
                          auto_rebalance_portfolio="india", auto_rebalance_sequence=42,
                          auto_rebalance_label=f"India Run #42 ({stage.title()} Scan)",
                          status=JobStatus(status))
                db.add(run)
                await db.commit()
                fields["run_id"] = run.id
        await write(audit_db, stage, status, completed_at=FINISH, **fields)
    assert await email(audit_db) == {"status": "queued"}
    assert await email(audit_db) == {"status": "already_queued"}
    event_id, payload = (await overall_events(audit_db))[0]
    assert payload["portfolio"] == "india" and payload["workflow_label"] == "India Run #42"
    assert datetime.fromisoformat(payload["completed_at"]).replace(tzinfo=timezone.utc) == FINISH
    assert len(payload["stages_completed"]) == 5
    assert "Stage 2 · Threats and guardrails (partial)" in payload["stages_completed"]
    assert all("Technical" not in label and "Unpersisted" not in label for label in payload["stages_completed"])
    assert email_queue.redis.calls == ["auto_rebalance_success_email_sent:7:india:42"]
    assert email_queue.redis.closed == 1
    assert [call.args for call in audit_db.dispatch.call_args_list].count((event_id,)) == 1
    email_queue.send.assert_not_called()


@pytest.mark.anyio
async def test_delayed_callbacks_preserve_terminal_progress_and_confirmed_links(audit_db):
    async with audit_db.sessions() as db:
        for record_id in (9001, 9002):
            db.add(Run(id=record_id, user_id=7, prompt="scan", prompt_preview="scan",
                       auto_rebalance_portfolio="india", auto_rebalance_sequence=42,
                       auto_rebalance_label="India Run #42 (Swing Scan)", status=JobStatus.COMPLETED))
        for record_id in (8001, 8002):
            db.add(Job(id=record_id, user_id=7, prompt="scan", provider="test", model="test",
                       auto_rebalance_portfolio="india", auto_rebalance_sequence=42,
                       auto_rebalance_label="India Run #42 (Swing Scan)", status=JobStatus.COMPLETED))
        await db.commit()
    async with audit_db.sessions() as db:
        db.add(RunJob(run_id=9001, job_id=8001))
        await db.commit()
    first = await write(audit_db, "swing", "completed", run_id=9001, job_id=8001,
                        summary={"completedLlms": 3, "runStatus": "completed"}, completed_at=FINISH)
    for status in ("processing", "failed"):
        result = await write(audit_db, "swing", status, run_id=9002, job_id=8002,
                             summary={"completedLlms": 0, "runStatus": status, "extraMetadata": "attached"},
                             error_message="Delayed callback failed", completed_at=LATE)
        assert (result.status, result.run_id, result.job_id, result.error_message) == ("completed", 9001, 8001, None)
        assert result.summary == {"completedLlms": 3, "runStatus": "completed", "extraMetadata": "attached"}
        assert result.completed_at.replace(tzinfo=timezone.utc) == first.completed_at.replace(tzinfo=timezone.utc)
    assert (await snapshot(audit_db))[1:] == (1, 1)


async def seed_verified_workflow(audit_db, *, reference="run_id"):
    for index, stage in enumerate(routes.AUTO_REBALANCE_STAGE_ORDER):
        fields = {}
        if stage in {"threats", "swing", "rebalance", "technical"}:
            async with audit_db.sessions() as db:
                values = dict(id=400 + index, user_id=7, prompt="scan",
                              auto_rebalance_portfolio="india", auto_rebalance_sequence=42,
                              auto_rebalance_label=f"India Run #42 ({stage.title()} Scan)", status=JobStatus.COMPLETED)
                record = Run(**values, prompt_preview="scan") if reference == "run_id" else Job(**values, provider="test", model="test")
                db.add(record)
                await db.commit()
                fields[reference] = record.id
        await write(audit_db, stage, "completed", completed_at=FINISH, **fields)


@pytest.mark.anyio
@pytest.mark.parametrize("reference", ["run_id", "job_id"])
@pytest.mark.parametrize("case", ["no_reference", "owner", "portfolio", "sequence", "stage", "processing", "failed", "partial"])
async def test_email_requires_matching_execution_evidence(audit_db, email_queue, reference, case):
    await seed_verified_workflow(audit_db, reference=reference)
    async with audit_db.sessions() as db:
        stage = (await db.execute(select(AutoRebalanceWorkflowStage).where(AutoRebalanceWorkflowStage.stage == "swing"))).scalar_one()
        record = await db.get(Run if reference == "run_id" else Job, getattr(stage, reference))
        if case == "no_reference":
            setattr(stage, reference, None)
        elif case == "owner":
            record.user_id = 8
        elif case == "portfolio":
            record.auto_rebalance_portfolio = "indmoney_us"
        elif case == "sequence":
            record.auto_rebalance_sequence = 43
        elif case == "stage":
            record.auto_rebalance_label = "India Run #42 (Technical Scan)"
        else:
            record.status = JobStatus(case)
        await db.commit()
    with pytest.raises(HTTPException) as error:
        await email(audit_db)
    assert error.value.status_code == 409 and "execution evidence" in error.value.detail
    email_queue.factory.assert_not_called()
    email_queue.send.assert_not_called()


@pytest.mark.anyio
@pytest.mark.parametrize("reference", ["run_id", "job_id"])
async def test_matching_completed_execution_evidence_permits_email(audit_db, email_queue, reference):
    await seed_verified_workflow(audit_db, reference=reference)
    assert await email(audit_db) == {"status": "queued"}
    assert len((await overall_events(audit_db))[0][1]["stages_completed"]) == 6


@pytest.mark.anyio
async def test_only_actionables_selected_can_email_with_explicitly_skipped_llm_stages(audit_db, email_queue):
    for stage in routes.AUTO_REBALANCE_STAGE_ORDER:
        await write(audit_db, stage, "completed" if stage == "actionables" else "skipped", completed_at=FINISH)
    assert await email(audit_db) == {"status": "queued"}
    assert (await overall_events(audit_db))[0][1]["stages_completed"] == ["Stage 6 · Final actionables"]


async def overall_events(audit_db):
    async with audit_db.sessions() as db:
        rows = (await db.execute(select(ActivityLog).where(ActivityLog.resource_id == 7001))).scalars().all()
        return [(row.id, json.loads(row.details)) for row in rows]


@pytest.mark.anyio
async def test_final_stage_does_not_complete_parent_until_every_slot_finishes(audit_db):
    await write(audit_db, "sync", "completed", completed_at=START)
    await write(audit_db, "actionables", "completed", completed_at=FINISH)
    workflow, _, _ = await snapshot(audit_db)
    assert (workflow.status, workflow.current_stage, workflow.completed_at) == ("processing", "actionables", None)
    for stage in ("threats", "swing", "rebalance"):
        await write(audit_db, stage, "skipped", completed_at=START)
    await write(audit_db, "technical", "processing")
    assert (await snapshot(audit_db))[0].status == "processing"
    await finish_with_execution(audit_db, "technical", "completed", completed_at=LATE)
    workflow, _, _ = await snapshot(audit_db)
    assert (workflow.status, workflow.current_stage) == ("completed", "actionables")
    assert workflow.completed_at.replace(tzinfo=timezone.utc) == LATE


@pytest.mark.anyio
async def test_partial_prior_stage_remains_partial_at_overall_completion(audit_db):
    for stage in routes.AUTO_REBALANCE_STAGE_ORDER:
        await finish_with_execution(audit_db, stage, "partial" if stage == "swing" else "completed", completed_at=FINISH)
    assert (await snapshot(audit_db))[0].status == "partial"


@pytest.mark.anyio
@pytest.mark.parametrize("reference", ["run_id", "job_id"])
async def test_patch_rejects_semantically_wrong_stage_reference(audit_db, reference):
    async with audit_db.sessions() as db:
        values = dict(id=500, user_id=7, prompt="technical scan", auto_rebalance_portfolio="india",
                      auto_rebalance_sequence=42, auto_rebalance_label="India Run #42 (Technical Scan)")
        db.add(Run(**values, prompt_preview="scan") if reference == "run_id" else Job(**values, provider="test", model="test"))
        await db.commit()
    with pytest.raises(HTTPException) as error:
        await write(audit_db, "swing", "processing", **{reference: 500})
    assert error.value.status_code == 422 and "another auto-rebalance stage" in error.value.detail
    assert (await snapshot(audit_db))[1:] == (0, 0)


@pytest.mark.anyio
@pytest.mark.parametrize("stage", ["swing", "rebalance"])
async def test_own_stage_identity_ignores_quoted_prior_scan_content(audit_db, stage):
    async with audit_db.sessions() as db:
        db.add(Run(id=500, user_id=7, prompt=f"{stage.title()} scan\n\nPrior raw output: [ZERODHA_THREATS]\ntechnical scan",
                   prompt_preview="scan", auto_rebalance_portfolio="india", auto_rebalance_sequence=42,
                   auto_rebalance_label=f"India Run #42 ({stage.title()} Scan)"))
        await db.commit()
    response = await write(audit_db, stage, "processing", run_id=500)
    assert response.run_id == 500


@pytest.mark.anyio
async def test_late_job_link_must_belong_to_already_linked_run(audit_db):
    await seed_verified_workflow(audit_db)
    async with audit_db.sessions() as db:
        db.add(Job(id=500, user_id=7, prompt="Swing scan", provider="test", model="test",
                   auto_rebalance_portfolio="india", auto_rebalance_sequence=42,
                   auto_rebalance_label="India Run #42 (Swing Scan)", status=JobStatus.COMPLETED))
        await db.commit()
    with pytest.raises(HTTPException) as error:
        await write(audit_db, "swing", "processing", job_id=500)
    assert error.value.status_code == 422 and "does not belong" in error.value.detail
    async with audit_db.sessions() as db:
        stage = (await db.execute(select(AutoRebalanceWorkflowStage).where(AutoRebalanceWorkflowStage.stage == "swing"))).scalar_one()
        assert stage.run_id == 402 and stage.job_id is None
        db.add(RunJob(run_id=402, job_id=500))
        await db.commit()
    result = await write(audit_db, "swing", "processing", job_id=500)
    assert (result.run_id, result.job_id, result.status) == (402, 500, "completed")


@pytest.mark.anyio
async def test_email_rejects_unrelated_run_job_pair_even_when_both_individually_match(audit_db, email_queue):
    await seed_verified_workflow(audit_db)
    async with audit_db.sessions() as db:
        db.add(Job(id=500, user_id=7, prompt="Swing scan", provider="test", model="test",
                   auto_rebalance_portfolio="india", auto_rebalance_sequence=42,
                   auto_rebalance_label="India Run #42 (Swing Scan)", status=JobStatus.COMPLETED))
        await db.flush()
        stage = (await db.execute(select(AutoRebalanceWorkflowStage).where(AutoRebalanceWorkflowStage.stage == "swing"))).scalar_one()
        stage.job_id = 500
        await db.commit()
    with pytest.raises(HTTPException) as error:
        await email(audit_db)
    assert error.value.status_code == 409
    assert await overall_events(audit_db) == []
    email_queue.factory.assert_not_called()


@pytest.mark.anyio
async def test_legacy_redis_claim_is_honored_without_reissuing_historical_email(audit_db, email_queue):
    await seed_verified_workflow(audit_db)
    email_queue.redis.keys.add("auto_rebalance_success_email_sent:7:india:42")
    assert await email(audit_db) == {"status": "already_queued"}
    assert await overall_events(audit_db) == []
    email_queue.send.assert_not_called()


@pytest.mark.anyio
@pytest.mark.parametrize("mail_enabled", [True, False])
async def test_broker_failure_leaves_recoverable_outbox_and_delivery_is_idempotent(audit_db, email_queue, monkeypatch, mail_enabled):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from app.domains.mails import service, tasks
    from app.services.email import EmailSendResult

    await seed_verified_workflow(audit_db)
    audit_db.dispatch.side_effect = RuntimeError("broker acknowledgement unavailable")
    assert await email(audit_db) == {"status": "queued"}
    assert await email(audit_db) == {"status": "already_queued"}
    event_id, payload = (await overall_events(audit_db))[0]
    assert payload["kind"] == "auto_rebalance_success"
    async with audit_db.sessions() as db:
        assert (await db.get(ActivityLog, event_id)).action == "completion.pending"
        if not mail_enabled:
            db.add(ActivityLog(user_id=7, action=service.MAIL_PREFERENCES_ACTION,
                               resource_type=service.MAIL_PREFERENCES_RESOURCE_TYPE,
                               details=json.dumps({"preferences": {"completion.zerodha.overall": False}})))
            await db.commit()
    audit_db.dispatch.side_effect = None
    audit_db.dispatch.reset_mock()
    sync_engine = create_engine(audit_db.sync_url)
    try:
        monkeypatch.setattr(tasks, "SyncSessionLocal", sessionmaker(sync_engine))
        tasks.recover_completion_emails.run()
        audit_db.dispatch.assert_any_call(event_id)
        # Recovery and an ambiguously acknowledged original publish use the
        # same event ID. The existing delivery lock/reservation handles both.
        lock = Mock()
        lock.acquire.return_value = True
        redis = Mock()
        redis.lock.return_value = lock
        monkeypatch.setattr(tasks.redis, "from_url", Mock(return_value=redis))
        smtp = Mock(return_value=EmailSendResult(sent=True, code="EMAIL_SENT", summary="Test stub"))
        monkeypatch.setattr(service.EmailService, "send_email_detailed", smtp)
        tasks.deliver_completion_email.run(event_id)
        tasks.deliver_completion_email.run(event_id)
        assert smtp.call_count == int(mail_enabled)
        if mail_enabled:
            assert smtp.call_args.args[0] == "owner@example.test"
            assert "India Run #42 completed successfully" in smtp.call_args.args[1]
            assert "Stage 6 · Final actionables" in smtp.call_args.args[3]
        with sessionmaker(sync_engine)() as db:
            row = db.get(ActivityLog, event_id)
            assert row.action == "completion.processed"
            deliveries = db.scalars(select(ActivityLog).where(ActivityLog.action == "mail.auto_rebalance_success")).all()
            assert len(deliveries) == int(mail_enabled)
            if deliveries:
                assert json.loads(deliveries[0].details)["idempotency_key"] == f"completion:{event_id}"
    finally:
        sync_engine.dispose()
    email_queue.send.assert_not_called()


@pytest.mark.anyio
@pytest.mark.parametrize("job_status,expected", [("completed", "queued"), ("failed", "queued"), ("processing", None)])
async def test_partial_run_uses_aggregate_outcome_with_a_terminal_linked_provider_job(audit_db, email_queue, job_status, expected):
    await seed_verified_workflow(audit_db)
    async with audit_db.sessions() as db:
        run = await db.get(Run, 402)
        run.status = JobStatus.PARTIAL
        db.add(Job(id=500, user_id=7, prompt="Swing scan", provider="test", model="test",
                   auto_rebalance_portfolio="india", auto_rebalance_sequence=42,
                   auto_rebalance_label="India Run #42 (Swing Scan)", status=JobStatus(job_status)))
        await db.flush()
        db.add(RunJob(run_id=402, job_id=500))
        stage = (await db.execute(select(AutoRebalanceWorkflowStage).where(AutoRebalanceWorkflowStage.stage == "swing"))).scalar_one()
        stage.status = "partial"
        stage.job_id = 500
        (await db.get(AutoRebalanceWorkflow, 7001)).status = "partial"
        await db.commit()
    if expected:
        assert await email(audit_db) == {"status": expected}
        assert "Stage 3 · Swing scan (partial)" in (await overall_events(audit_db))[0][1]["stages_completed"]
    else:
        with pytest.raises(HTTPException) as error:
            await email(audit_db)
        assert error.value.status_code == 409


async def finish_with_execution(audit_db, stage, status, **fields):
    """Seed a real execution outcome for lifecycle tests before claiming it."""
    if stage in routes.LLM_STAGES and status in {"completed", "partial"}:
        record_id = 400 + routes.AUTO_REBALANCE_STAGE_ORDER.index(stage)
        async with audit_db.sessions() as db:
            db.add(Run(id=record_id, user_id=7, prompt="scan", prompt_preview="scan", status=JobStatus(status),
                       auto_rebalance_portfolio="india", auto_rebalance_sequence=42,
                       auto_rebalance_label=f"India Run #42 ({stage.title()} Scan)"))
            await db.commit()
        fields["run_id"] = record_id
    return await write(audit_db, stage, status, **fields)


@pytest.mark.anyio
@pytest.mark.parametrize("stage", routes.LLM_STAGES)
@pytest.mark.parametrize("claimed_status", ["completed", "partial"])
async def test_llm_terminal_claim_without_execution_is_rejected_without_event(audit_db, stage, claimed_status):
    with pytest.raises(HTTPException) as error:
        await write(audit_db, stage, claimed_status, completed_at=FINISH)
    assert error.value.status_code == 409
    workflow, count, events = await snapshot(audit_db)
    assert (workflow.status, count, events) == ("queued", 0, 0)
    audit_db.dispatch.assert_not_called()


@pytest.mark.anyio
@pytest.mark.parametrize("reference", ["run_id", "job_id"])
@pytest.mark.parametrize("stage", routes.LLM_STAGES)
async def test_llm_completion_and_stage_notification_wait_for_worker_evidence(audit_db, reference, stage):
    async with audit_db.sessions() as db:
        values = dict(id=500, user_id=7, prompt="scan", auto_rebalance_portfolio="india",
                      auto_rebalance_sequence=42, auto_rebalance_label=f"India Run #42 ({stage.title()} Scan)",
                      status=JobStatus.PROCESSING)
        model = Run if reference == "run_id" else Job
        db.add(model(**values, **({"prompt_preview": "scan"} if reference == "run_id" else {"provider": "test", "model": "test"})))
        await db.commit()
    await write(audit_db, stage, "processing", **{reference: 500})
    with pytest.raises(HTTPException) as error:
        await write(audit_db, stage, "completed", completed_at=FINISH)
    assert error.value.status_code == 409
    assert (await snapshot(audit_db))[2] == 0
    audit_db.dispatch.assert_not_called()
    async with audit_db.sessions() as db:
        (await db.get(model, 500)).status = JobStatus.COMPLETED
        await db.commit()
    completed = await write(audit_db, stage, "completed", completed_at=FINISH)
    assert completed.status == "completed"
    await write(audit_db, stage, "completed", completed_at=LATE)
    assert (await snapshot(audit_db))[2] == 1
    assert audit_db.dispatch.call_count == 1


@pytest.mark.anyio
async def test_verified_us_stage_uses_existing_indmoney_notification_preferences(audit_db):
    from app.domains.mails.completion_preferences import stock_run_preference

    async with audit_db.sessions() as db:
        db.add(AutoRebalanceWorkflow(id=144, user_id=7, portfolio="indmoney_us", sequence=43, label="IndMoney US Run #43"))
        run = Run(id=501, user_id=7, prompt="Swing scan", prompt_preview="scan", status=JobStatus.COMPLETED,
                  auto_rebalance_portfolio="indmoney_us", auto_rebalance_sequence=43,
                  auto_rebalance_label="IndMoney US Run #43 (Swing Scan)")
        db.add(run)
        await db.commit()
        result = await routes.update_auto_rebalance_stage(
            "indmoney_us", 43, "swing", AutoRebalanceStageUpdateRequest(status="completed", run_id=501), db, OWNER,
        )
        event_payload = json.loads((await db.execute(select(ActivityLog))).scalar_one().details)
        assert result.status == "completed"
        assert event_payload["segment"] == "indmoney" and event_payload["stage"] == "swing"
        assert stock_run_preference(run) == "completion.indmoney.swing"


@pytest.mark.anyio
@pytest.mark.parametrize("with_stage_labels", [True, False])
async def test_history_groups_own_execution_with_quoted_prior_stage_inputs(audit_db, with_stage_labels):
    openings = {
        "swing": "Act as an India swing trading strategist.",
        "rebalance": "[REBALANCE_FLOW:india]\nAnalyze this rebalance.",
        "technical": "## Technical Scan Input Bundle\nMarket: India equities",
    }
    async with audit_db.sessions() as db:
        for index, stage in enumerate(openings):
            prompt = openings[stage] + "\n\nQuoted prior output: [ZERODHA_THREATS]\ntechnical scan and rebalance inputs"
            label = f"India Run #42 ({stage.title()} Scan)" if with_stage_labels else None
            metadata = dict(auto_rebalance_portfolio="india", auto_rebalance_sequence=42, auto_rebalance_label=label)
            run = Run(id=601 + index, user_id=7, prompt=prompt, prompt_preview="scan", status=JobStatus.PARTIAL, **metadata)
            db.add(run)
            for offset, status, cost in ((0, JobStatus.COMPLETED, index + 1.25), (1, JobStatus.FAILED, 0.75)):
                job = Job(id=701 + index * 10 + offset, user_id=7, prompt=prompt, provider="test", model="test",
                          status=status, estimated_cost=cost, response=f"stored:{stage}:{offset}", **metadata)
                db.add_all([job, RunJob(run=run, job=job)])
            db.add(Job(id=703 + index * 10, user_id=7, prompt=prompt, provider="standalone", model="test",
                       status=JobStatus.COMPLETED, estimated_cost=0.5, response=f"stored:{stage}:standalone", **metadata))
        await db.commit()
        detail = await routes.get_auto_rebalance_history_detail("india", 42, db, OWNER)

    assert (detail.status, detail.current_stage, detail.completed_at) == ("queued", "sync", None)
    stages = {stage.stage: stage for stage in detail.stages}
    assert set(stages) == {"swing", "rebalance", "technical"}
    for index, stage in enumerate(openings):
        summary = stages[stage]
        assert (summary.run_id, summary.job_id) == (601 + index, 703 + index * 10)
        assert (summary.provider_count, summary.completed_provider_count, summary.failed_provider_count) == (3, 2, 1)
        assert summary.status == "partial"
        assert summary.estimated_cost == pytest.approx(index + 2.5)
    assert detail.total_estimated_cost == pytest.approx(10.5)
    assert [run.id for run in detail.runs] == [601, 602, 603]
    assert {job.id for run in detail.runs for job in run.jobs} == {701, 702, 711, 712, 721, 722}
    assert {job.id for job in detail.standalone_jobs} == {703, 713, 723}
    assert {job.response for run in detail.runs for job in run.jobs} == {
        f"stored:{stage}:{offset}" for stage in openings for offset in (0, 1)
    }
    assert {job.response for job in detail.standalone_jobs} == {f"stored:{stage}:standalone" for stage in openings}
    workflow, audit_rows, notification_rows = await snapshot(audit_db)
    assert (workflow.status, workflow.current_stage, audit_rows, notification_rows) == ("queued", "sync", 0, 0)


@pytest.mark.anyio
async def test_history_keeps_legacy_fallback_for_records_without_canonical_identity(audit_db):
    async with audit_db.sessions() as db:
        metadata = dict(auto_rebalance_portfolio="india", auto_rebalance_sequence=42)
        run = Run(id=601, user_id=7, prompt="Archived result mentions technical scan", prompt_preview="archived",
                  status=JobStatus.COMPLETED, **metadata)
        job = Job(id=701, user_id=7, prompt="Archived provider output", provider="test", model="test",
                  status=JobStatus.COMPLETED, estimated_cost=2.0, **metadata)
        standalone = Job(id=702, user_id=7, prompt="Archived output: [ZERODHA_THREATS]", provider="test", model="test",
                         status=JobStatus.COMPLETED, estimated_cost=0.5, **metadata)
        assert routes.analysis_run_identity(run).stage is None
        assert routes.analysis_run_identity(standalone).stage is None
        db.add_all([run, job, standalone, RunJob(run=run, job=job)])
        await db.commit()
        detail = await routes.get_auto_rebalance_history_detail("india", 42, db, OWNER)
    stages = {stage.stage: stage for stage in detail.stages}
    assert set(stages) == {"technical", "threats"}
    assert (stages["technical"].run_id, stages["technical"].provider_count, stages["technical"].estimated_cost) == (601, 1, 2.0)
    assert (stages["threats"].job_id, stages["threats"].provider_count, stages["threats"].estimated_cost) == (702, 1, 0.5)
    assert detail.total_estimated_cost == 2.5
    assert (detail.status, detail.current_stage, detail.completed_at) == ("queued", "sync", None)
