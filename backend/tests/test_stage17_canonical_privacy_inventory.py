"""Source classification only, not actual service or account-erasure acceptance."""
import pytest
from sqlalchemy import MetaData, Table, Column, Integer
import app.models
from app.infrastructure.database.base import Base
from app.domains.ai_limits.contracts import BoundaryDenied
from app.domains.public_service.canonical_privacy_inventory import canonical_inventory, classification


def test_every_canonical_table_and_field_has_exactly_one_disposition():
    result = classification(Base.metadata)
    assert len(result['tables']) == 95
    for name, table in Base.metadata.tables.items():
        entry = result['tables'][name]
        if entry['retained_reason']:
            assert not entry['export_columns'] and not entry['withheld_columns']
            assert set(entry['retained_columns']) == set(table.c.keys())
        else:
            assert set(entry['export_columns']).isdisjoint(entry['withheld_columns'])
            assert set(entry['export_columns']) | set(entry['withheld_columns']) == set(table.c.keys())
    assert not result['runtime_binding'] and not result['complete_account_export']


def test_actor_is_not_inferred_as_subject_and_shared_payloads_are_retained():
    entries = classification(Base.metadata)['tables']
    assert entries['bullpen_run_audit_feedback']['path'] == ['bullpen_run_audit_snapshots']
    for name in ('google_sheets_app_configs', 'outbox', 'bullpen_run_audit_blobs', 'order_execution_fences'):
        assert entries[name]['retained_reason'] and not entries[name]['export_columns']
    assert 'key' in entries['api_keys']['withheld_columns']
    assert 'key' not in entries['api_keys']['export_columns']


def test_unknown_table_and_same_name_schema_drift_fail_closed():
    metadata = MetaData()
    for table in Base.metadata.sorted_tables:
        table.to_metadata(metadata)
    Table('unknown_owner_data', metadata, Column('id', Integer, primary_key=True))
    with pytest.raises(BoundaryDenied, match='CLASSIFICATION_CHANGED'):
        canonical_inventory(metadata, reference='synthetic')
    metadata.remove(metadata.tables['unknown_owner_data'])
    metadata.tables['users'].append_column(Column('unreviewed_field', Integer))
    with pytest.raises(BoundaryDenied, match='SCHEMA_CHANGED'):
        canonical_inventory(metadata, reference='synthetic')


@pytest.mark.parametrize('reference', ['', ' ', None, 'x' * 257])
def test_review_reference_required(reference):
    with pytest.raises(BoundaryDenied, match='REVIEW_REQUIRED'):
        canonical_inventory(Base.metadata, reference=reference)


def test_all_declared_principal_paths_follow_exact_source_foreign_keys():
    inventory=canonical_inventory(Base.metadata,reference='synthetic-source-review')
    for rule in inventory.rules:
        if rule.excluded_reason:continue
        current=Base.metadata.tables[rule.table]
        for hop in rule.path:
            parent=Base.metadata.tables[hop.parent_table]
            expected=set(zip(hop.local_columns,hop.parent_columns))
            assert any(len(fk.elements)==len(expected) and
                {(e.parent.name,e.column.name) for e in fk.elements}==expected and
                all(e.column.table is parent for e in fk.elements) for fk in current.foreign_key_constraints)
            current=parent
        assert rule.owner_column in current.c
        if rule.table=='users':assert rule.owner_column=='id'
        elif not rule.owner_semantics:
            assert any(f.column.table.name=='users' and f.column.name=='id' for f in current.c[rule.owner_column].foreign_keys)


def test_execution_fence_key_construction_preserves_owner_and_source_binding():
    from uuid import UUID
    from app.domains.public_service.canonical_privacy_resolvers import _fence_keys
    from app.domains.ai_limits.contracts import digest
    connection=UUID('00000000-0000-0000-0000-000000000001')
    keys=_fence_keys(1,[connection],['synthetic-account'])
    assert keys=={'owner:1','connection:'+str(connection),'account:'+digest({'owner':1,'account':'synthetic-account'})}
    assert 'platform' not in keys and keys!=_fence_keys(2,[connection],['synthetic-account'])
    for args in [(True,[],[]),(1,['fake-id'],[]),(1,[],['x'*129]),(1,[],['x']*1001)]:
        with pytest.raises(BoundaryDenied):_fence_keys(*args)


def test_stored_string_connection_identity_is_resolved_without_adopting_foreign_rows(tmp_path):
    from sqlalchemy import create_engine,select
    from sqlalchemy.orm import Session
    from app.domains.auth.models import User
    from app.domains.connections.models import IntegrationConnection
    from app.domains.public_service.canonical_privacy_resolvers import _fence_keys
    engine=create_engine('sqlite:///'+str(tmp_path/'synthetic-connection-identity.sqlite'))
    Base.metadata.create_all(engine,tables=[User.__table__,IntegrationConnection.__table__])
    value='00000000-0000-0000-0000-000000000001';foreign='00000000-0000-0000-0000-000000000002'
    with Session(engine) as db:
        for id in (1,2):db.add(User(id=id,email=f'synthetic{id}@example.invalid',username=f'synthetic{id}',password_hash='unusable',is_active=True,is_verified=True))
        db.flush();db.add_all([IntegrationConnection(id=value,owner_id=1,app_ownership_mode='user_owned'),
            IntegrationConnection(id=foreign,owner_id=2,app_ownership_mode='user_owned')]);db.commit()
        owned=list(db.scalars(select(IntegrationConnection.id).where(IntegrationConnection.owner_id==1)))
        assert owned==[value] and type(owned[0]) is str
        assert _fence_keys(1,owned,[])=={'owner:1','connection:'+value}
        for invalid in [value.replace('-',''),'{'+value+'}',value+' ', 'not-a-uuid']:
            with pytest.raises(BoundaryDenied):_fence_keys(1,[invalid],[])
    engine.dispose()
