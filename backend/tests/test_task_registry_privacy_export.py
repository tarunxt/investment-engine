from types import SimpleNamespace
import pytest
import app.models
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from app.domains.auth.models import User
from app.domains.jobs.models import Job
from app.domains.public_service.task_registry_export import export_job_registry
from app.domains.ai_limits.contracts import BoundaryDenied


def test_only_persisted_owned_keys_are_read_and_values_are_closed():
    engine=create_engine('sqlite://')
    User.__table__.create(engine);Job.__table__.create(engine)
    with Session(engine) as db:
        db.add_all([User(id=i,username=f'synthetic{i}',password_hash='unusable-synthetic',email=f'synthetic{i}@example.test',is_active=True,is_verified=True) for i in (1,2)])
        db.flush()
        db.add_all([Job(id=i,user_id=i,prompt='synthetic',provider='fake',model='fake') for i in (1,2)])
        db.commit();calls=[]
        def read(keys):
            calls.append(keys);return ['00000000-0000-0000-0000-000000000001']
        result=export_job_registry(db,1,SimpleNamespace(mget=read))
        assert calls==[['celery:job-task:1']]
        assert result['items'][0]['job_id']==1
        assert result['atomic_with_sql'] is False and result['deletable'] is False
        for bad in (['private arbitrary text'],[],[b'opaque']):
            with pytest.raises(BoundaryDenied,match='RESPONSE_INVALID'):
                export_job_registry(db,1,SimpleNamespace(mget=lambda keys:bad))
