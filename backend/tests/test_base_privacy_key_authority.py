from datetime import timedelta
import pytest
from app.domains.ai_limits.contracts import BoundaryDenied
from sqlalchemy import Table,Column,Integer,String,Boolean,ForeignKey,select
from test_stage17_sql_privacy_plan import setup as plan_setup,residency_setup,NOW
from app.domains.public_service.sql_account import SQLAccountReader,AccountInventory,AccountTableRule,schema_digest
from app.domains.public_service.sql_privacy_plan import RetentionSchedule
from app.domains.public_service.sql_privacy_workflow import DisposablePrivacyScope
from app.domains.public_service.recoverable_privacy import RecoverableFixturePrivacy

def test_base_adapter_refuses_active_key_recovery_before_deletion(plan_setup):
    db,planner,request=plan_setup
    metadata=planner.reader.metadata
    keys=Table('api_keys',metadata,Column('id',Integer,primary_key=True),Column('user_id',ForeignKey('users.id'),nullable=False),Column('key_hash',String),Column('is_active',Boolean,nullable=False))
    keys.create(db.get_bind())
    db.execute(keys.insert().values(id=1,user_id=1,key_hash='synthetic-active-key',is_active=True));db.commit()
    rules=(*planner.reader.inventory.rules,AccountTableRule('api_keys',('id','user_id','is_active'),('key_hash',)))
    inventory=AccountInventory('synthetic:key-review',schema_digest(metadata),rules)
    reader=SQLAccountReader(db,metadata,inventory)
    retention=RetentionSchedule('synthetic:retention-review',NOW+timedelta(days=1),retain_until=tuple((name,None) for name in metadata.tables))
    workflow=RecoverableFixturePrivacy(db,reader,planner.keyring,retention=retention,scope=DisposablePrivacyScope('synthetic:base-key-restore-review'))
    with pytest.raises(BoundaryDenied):
        workflow.execute(1,request,now=NOW)
    db.rollback()
    restored=db.execute(select(keys)).mappings().one()
    assert restored['is_active'] is True
    assert restored['key_hash']=='synthetic-active-key'
