"""Source-backed tenant exceptions on disposable canonical SQL model fixtures.

Not an approved full-account inventory or legal retention/deletion mapping.
"""
from dataclasses import replace
from decimal import Decimal
import pytest
from sqlalchemy import MetaData,select
from app.domains.ai_limits.contracts import BoundaryDenied
from app.domains.auth.models import APIKey
from app.domains.recommendation_audit.models import EvidenceRecord,DecisionRecord,VerificationRecord,SpendAccount,SpendAttempt
from app.domains.public_service.sql_account import SQLAccountReader,AccountInventory,AccountTableRule,schema_digest,_credential_column,APPLICATION_OWNER_SEMANTICS
from test_stage17_reviewed_residency import setup as residency_setup,NOW

MODELS=(EvidenceRecord,DecisionRecord,VerificationRecord,SpendAccount,SpendAttempt)

@pytest.fixture
def mapping(residency_setup):
    db,_=residency_setup;engine=db.get_bind()
    for model in MODELS:model.__table__.create(engine)
    APIKey.__table__.create(engine)
    for owner in (1,3):
        payload={'label':'safe','list':[{'api-key':'SYNTHETIC_API_SECRET','key':'SYNTHETIC_KEY','safe':'keep'}]}
        db.execute(EvidenceRecord.__table__.insert().values(id=f'e-{owner}',user_id=owner,kind='fixture',source_key=f's-{owner}',content_hash='a'*64,payload=payload))
        db.execute(DecisionRecord.__table__.insert().values(id=f'd-{owner}',user_id=owner,run_id=7,market='fixture',symbol='FAKE',exchange='FAKE',decision_at=NOW,provenance='fixture',content_hash='b'*64,payload={}))
        db.execute(VerificationRecord.__table__.insert().values(id=f'v-{owner}',user_id=owner,current_id=f'e-{owner}',request_hash='c'*64,idempotency_key='fixture',request={}))
        db.execute(SpendAccount.__table__.insert().values(id=f'sa-{owner}',user_id=owner,day='2026-10-22',cap_usd=Decimal(1)))
        db.execute(SpendAttempt.__table__.insert().values(id=f'at-{owner}',user_id=owner,account_id=f'sa-{owner}',attempt_key='fixture',adapter='fake',tariff_version='fixture',upper_bound_usd=Decimal(0)))
    db.execute(SpendAccount.__table__.insert().values(id='platform-sentinel',user_id=0,day='2026-10-22'))
    db.execute(APIKey.__table__.insert().values(id=1,user_id=1,key='SYNTHETIC_NEVER_EXPORT_API_KEY',key_hash='SYNTHETIC_HASH_NOT_A_REAL_KEY',name='fixture'))
    db.commit();metadata=MetaData();metadata.reflect(engine)
    names={model.__tablename__ for model in MODELS};rules=[]
    for name,table in metadata.tables.items():
        if name in {'outbox','activity_logs'}:rules.append(AccountTableRule(name,(),excluded_reason='fixture operational retention review'))
        else:
            fields=tuple(c for c in table.c.keys() if not _credential_column(c));withheld=tuple(c for c in table.c.keys() if _credential_column(c))
            rules.append(AccountTableRule(name,fields,withheld,owner_column='id' if name=='users' else 'user_id',
                owner_semantics=APPLICATION_OWNER_SEMANTICS if name in names else ''))
    inventory=AccountInventory('fixture-source-mapping-not-real-approval',schema_digest(metadata),tuple(rules))
    return db,SQLAccountReader(db,metadata,inventory)

def test_five_explicit_source_tenant_tables_filter_foreign_and_platform(mapping):
    db,reader=mapping;datasets=reader.export(1)['datasets']
    for model in MODELS:
        rows=datasets[model.__tablename__]
        assert len(rows)==1 and rows[0]['user_id']==1
    assert 'platform-sentinel' not in str(datasets)
    with pytest.raises(BoundaryDenied):reader.export(0)

def test_api_key_column_and_nested_json_keys_are_withheld(mapping):
    _,reader=mapping;datasets=reader.export(1)['datasets']
    assert 'key' not in datasets['api_keys'][0]
    assert 'SYNTHETIC_' not in str(datasets)
    payload=datasets['recommendation_evidence'][0]['payload']
    assert payload['list'][0]=={'api-key':'[withheld credential]','key':'[withheld credential]','safe':'keep'}

@pytest.mark.parametrize('mode',['missing','wrong','foreign_table','schema_changed'])
def test_application_tenant_exception_is_narrow_and_schema_bound(mapping,mode):
    _,reader=mapping;rules=list(reader.inventory.rules)
    target=next(i for i,r in enumerate(rules) if r.table=='recommendation_evidence')
    if mode=='missing':rules[target]=replace(rules[target],owner_semantics='')
    elif mode=='wrong':rules[target]=replace(rules[target],owner_semantics='invented')
    elif mode=='foreign_table':
        target=next(i for i,r in enumerate(rules) if r.table=='api_keys');rules[target]=replace(rules[target],owner_semantics=APPLICATION_OWNER_SEMANTICS)
    else:
        reader.metadata.tables['recommendation_evidence'].c.source_key.type.length=129
    reader.inventory=replace(reader.inventory,rules=tuple(rules),schema_digest=schema_digest(reader.metadata))
    with pytest.raises(BoundaryDenied):reader.export(1)

def test_application_owner_binding_rejects_physically_matching_noncanonical_schema(mapping):
    from sqlalchemy import text,Column,String
    db,reader=mapping;table=reader.metadata.tables['recommendation_evidence']
    db.execute(text('ALTER TABLE recommendation_evidence ADD COLUMN fixture_extra VARCHAR'));db.commit()
    table.append_column(Column('fixture_extra',String))
    rules=tuple(replace(rule,export_columns=rule.export_columns+('fixture_extra',)) if rule.table==table.name else rule for rule in reader.inventory.rules)
    reader.inventory=replace(reader.inventory,rules=rules,schema_digest=schema_digest(reader.metadata))
    with pytest.raises(BoundaryDenied,match='APPLICATION_OWNER_BINDING'):reader.export(1)

def test_even_explicit_inventory_cannot_export_api_key_key(mapping):
    _,reader=mapping
    rules=tuple(replace(rule,export_columns=rule.export_columns+('key',),withheld_columns=tuple(c for c in rule.withheld_columns if c!='key')) if rule.table=='api_keys' else rule for rule in reader.inventory.rules)
    reader.inventory=replace(reader.inventory,rules=rules)
    with pytest.raises(BoundaryDenied,match='CREDENTIAL_FIELD'):reader.export(1)
