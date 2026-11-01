import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock
import pytest
from sqlalchemy import text, create_engine
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session
from test_auto_rebalance_audit_durability import audit_db, anyio_backend, OWNER, email
from app.domains.runs import router as routes
from app.domains.runs.schemas import AutoRebalanceRunReservationRequest, AutoRebalanceStageUpdateRequest
from app.domains.runs.side_effect_policy import WorkflowSchemaNotReady, require_workflow_policy_schema, execution_allows_side_effects, execution_allows_side_effects_sync
EXECUTION = SimpleNamespace(user_id=7, auto_rebalance_portfolio='india', auto_rebalance_sequence=42)
async def remove_column(fixture):
    async with fixture.engine.begin() as connection:
        await connection.execute(text('ALTER TABLE auto_rebalance_workflows DROP COLUMN side_effect_policy_json'))
@pytest.mark.anyio
async def test_missing_schema_blocks_routes_before_mutation(audit_db, monkeypatch):
    await remove_column(audit_db)
    monkeypatch.setattr(routes, '_get_redis', lambda: (_ for _ in ()).throw(AssertionError('Sequence allocation before readiness')))
    async with audit_db.sessions() as db:
        operations = [
            lambda: routes.list_auto_rebalance_history(offset=0, portfolio='india', limit=100, db=db, current_user=OWNER),
            lambda: routes.get_auto_rebalance_history_detail('india', 42, db, OWNER),
            lambda: routes.reserve_auto_rebalance_label(AutoRebalanceRunReservationRequest(portfolio='india'), db, OWNER),
            lambda: routes.update_auto_rebalance_stage('india', 42, 'sync', AutoRebalanceStageUpdateRequest(status='processing'), db, OWNER),
            lambda: execution_allows_side_effects(db, EXECUTION),
        ]
        for operation in operations:
            with pytest.raises(WorkflowSchemaNotReady) as error: await operation()
            assert error.value.status_code == 503 and error.value.code == 'WORKFLOW_SCHEMA_NOT_READY'
            assert (await db.execute(text('SELECT 1'))).scalar_one() == 1
    with pytest.raises(WorkflowSchemaNotReady): await email(audit_db)
    audit_db.dispatch.assert_not_called()
@pytest.mark.anyio
async def test_concurrent_repeated_reads_recover_without_cache(audit_db):
    await remove_column(audit_db)
    async def read():
        async with audit_db.sessions() as db:
            with pytest.raises(WorkflowSchemaNotReady): await require_workflow_policy_schema(db)
            assert (await db.execute(text('SELECT 1'))).scalar_one() == 1
    await asyncio.gather(*(read() for _ in range(8)))
    async with audit_db.engine.begin() as connection:
        await connection.execute(text('ALTER TABLE auto_rebalance_workflows ADD COLUMN side_effect_policy_json JSON'))
    async with audit_db.sessions() as db:
        await require_workflow_policy_schema(db)
        assert await execution_allows_side_effects(db, EXECUTION) is True
@pytest.mark.anyio
async def test_present_null_and_explicit_policies(audit_db):
    async with audit_db.sessions() as db:
        await require_workflow_policy_schema(db)
        assert await execution_allows_side_effects(db, EXECUTION) is True
        for mode, expected in [('analysis_only', False), ('existing_preferences', True)]:
            await db.execute(text('UPDATE auto_rebalance_workflows SET side_effect_policy_json = :value'), {'value': json.dumps({'version': 1, 'mode': mode})})
            await db.commit()
            assert await execution_allows_side_effects(db, EXECUTION) is expected
@pytest.mark.anyio
async def test_unrelated_error_not_hidden():
    original = DBAPIError('SELECT', {}, RuntimeError('connection unavailable'), False)
    db = SimpleNamespace(execute=AsyncMock(side_effect=original), rollback=AsyncMock())
    for operation in [lambda: require_workflow_policy_schema(db), lambda: execution_allows_side_effects(db, EXECUTION)]:
        with pytest.raises(DBAPIError) as result: await operation()
        assert result.value is original
    assert db.rollback.await_count == 2
@pytest.mark.anyio
async def test_sync_export_missing_column_does_not_grant_legacy_permission(audit_db):
    await remove_column(audit_db)
    engine = create_engine(audit_db.sync_url)
    with Session(engine) as db:
        with pytest.raises(WorkflowSchemaNotReady): execution_allows_side_effects_sync(db, EXECUTION)
        assert db.execute(text('SELECT 1')).scalar_one() == 1
    engine.dispose()

@pytest.mark.parametrize('state,message,expected', [
    ('42703', 'column auto_rebalance_workflows.side_effect_policy_json does not exist', True),
    ('42703', 'column auto_rebalance_workflows.unrelated does not exist', False),
    ('42703', 'column unrelated does not exist; hint: side_effect_policy_json', False),
    ('42P01', 'relation auto_rebalance_workflows does not exist', False),
    ('08006', 'side_effect_policy_json connection lost', False),
])
def test_postgres_missing_column_is_narrowly_classified(state, message, expected):
    from app.domains.runs.side_effect_policy import missing_policy_column
    original = RuntimeError(message)
    original.sqlstate = state
    assert missing_policy_column(DBAPIError('SELECT', {}, original, False)) is expected
