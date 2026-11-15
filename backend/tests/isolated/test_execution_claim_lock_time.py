"""A lock wait cannot authorize provider entry/return using an expired clock."""
from unittest.mock import patch
import pytest
from sqlalchemy.orm import Session
import test_execution_claim as fixtures


@pytest.mark.parametrize('boundary', ['before_call', 'after_call'])
@pytest.mark.parametrize('bound', ['lease', 'lifetime'])
def test_provider_checkpoint_checks_time_after_row_lock(boundary, bound):
    fixture = fixtures.Claims()
    fixture.setUp()
    claim = fixtures.claim
    try:
        token = claim.admit(fixture.db, 1, 'synthetic-delivery', now=100)
        if boundary == 'after_call' or bound == 'lifetime':
            row = fixture.db.get(fixtures.Job, 1)
            record = row.runtime_metadata_json[claim.KEY]
            claim.save_claim(row, {**record,
                'expires_at': 999999 if bound == 'lifetime' else 220,
                'provider_started': boundary == 'after_call',
                'pending_calls': 1 if boundary == 'after_call' else 0})
            fixture.db.commit()
        owner = claim.ExecutionOwnership(lambda: Session(fixture.engine), 1, token)
        deadline = 220 if bound == 'lease' else 100 + claim.MAX_OWNER_SECONDS
        clock = [deadline - 1]
        original = claim.locked_job
        def wait_across_deadline(db, job_id):
            row = original(db, job_id)
            clock[0] = deadline + 1
            return row
        with patch.object(claim, 'timestamp', side_effect=lambda: clock[0]), \
             patch.object(claim, 'locked_job', side_effect=wait_across_deadline):
            with pytest.raises(claim.LostExecutionOwner):
                getattr(owner, boundary)()
        assert owner.lost_event.is_set()
        fixture.db.expire_all()
        record = fixture.db.get(fixtures.Job, 1).runtime_metadata_json[claim.KEY]
        assert record.get('pending_calls', 0) == (1 if boundary == 'after_call' else 0)
        assert record.get('provider_started') == (boundary == 'after_call')
    finally:
        fixture.tearDown()


@pytest.mark.parametrize('boundary', ['before_call', 'after_call'])
@pytest.mark.parametrize('phase', ['lock', 'commit'])
def test_sticky_loss_during_checkpoint_is_not_revived(boundary, phase):
    fixture = fixtures.Claims()
    fixture.setUp()
    claim = fixtures.claim
    try:
        token = claim.admit(fixture.db, 1, 'synthetic-delivery')
        class CheckpointSession(Session):
            def commit(self):
                super().commit()
                if phase == 'commit':
                    owner.block()
        owner = claim.ExecutionOwnership(lambda: CheckpointSession(fixture.engine), 1, token)
        original = claim.locked_job
        def locked(db, job_id):
            row = original(db, job_id)
            if phase == 'lock':
                owner.block()
            return row
        with patch.object(claim, 'locked_job', side_effect=locked):
            with pytest.raises(claim.LostExecutionOwner):
                getattr(owner, boundary)()
        assert owner.lost_event.is_set()
        if phase == 'lock':
            fixture.db.expire_all()
            record = fixture.db.get(fixtures.Job, 1).runtime_metadata_json[claim.KEY]
            assert record['provider_started'] is False
    finally:
        fixture.tearDown()


@pytest.mark.parametrize('phase', ['lock', 'capture'])
def test_terminal_write_rolls_back_sticky_loss(phase):
    import ast
    import sys
    from pathlib import Path
    from types import ModuleType, SimpleNamespace
    from sqlalchemy import select
    fixture = fixtures.Claims()
    fixture.setUp()
    claim = fixtures.claim
    try:
        source = Path(__file__).parents[2] / 'app/domains/jobs/repository.py'
        node = next(n for n in ast.parse(source.read_text()).body
                    if isinstance(n, ast.ClassDef) and n.name == 'SyncJobRepository')
        namespace = {'JobStatus': claim.JobStatus, 'Job': fixtures.Job, 'select': select}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[
            ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0), node],
            type_ignores=[])), str(source), 'exec'), namespace)
        settings = ModuleType('app.core.config')
        settings.settings = SimpleNamespace(recommendation_audit_enabled=phase == 'capture')
        capture = ModuleType('app.domains.recommendation_audit.capture')
        lost = [False]
        def lose(*args): lost[0] = True
        capture.capture_terminal = lose
        token = claim.admit(fixture.db, 1, 'synthetic-delivery')
        repo = namespace['SyncJobRepository'](fixture.db)
        repo.execution_token = token
        repo.execution_owner_lost = lambda: lost[0]
        original = claim.require_owner
        def waited(*args, **kwargs):
            result = original(*args, **kwargs)
            if phase == 'lock': lost[0] = True
            return result
        with patch.dict(sys.modules, {'app.domains.jobs.execution_claim': claim,
                                     'app.core.config': settings,
                                     'app.domains.recommendation_audit.capture': capture}), \
             patch.object(claim, 'require_owner', side_effect=waited):
            with pytest.raises(claim.LostExecutionOwner):
                repo.update_status(fixture.db.get(fixtures.Job, 1), claim.JobStatus.COMPLETED,
                                   response='stale terminal output')
        fixture.db.expire_all()
        row = fixture.db.get(fixtures.Job, 1)
        assert row.status == 'pending'
        assert row.response is None
        assert row.runtime_metadata_json[claim.KEY]['state'] == 'owned'
    finally:
        fixture.tearDown()
