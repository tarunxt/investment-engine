"""Disposable reference ownership tests; no hosted or payload export claim."""
from types import SimpleNamespace
import pytest
from sqlalchemy import MetaData, Table, Column, Integer, String, ForeignKey, create_engine
from sqlalchemy.orm import Session
from app.domains.public_service.canonical_account_export import audit_blob_references
from app.domains.ai_limits.contracts import BoundaryDenied


def test_shared_blob_never_releases_foreign_metadata_or_opaque_content():
    metadata=MetaData()
    blobs=Table('bullpen_run_audit_blobs',metadata,Column('id',String,primary_key=True),
        Column('content_type',String),Column('size_bytes',Integer),Column('payload_text',String))
    refs=Table('refs',metadata,Column('id',Integer,primary_key=True),Column('owner',Integer),
        Column('blob',ForeignKey(blobs.c.id)))
    engine=create_engine('sqlite://');metadata.create_all(engine)
    rule=SimpleNamespace(table='refs',excluded_reason='')
    reader=SimpleNamespace(inventory=SimpleNamespace(rules=[rule]),
        _predicate=lambda table,rule,subject:table.c.owner==subject)
    with Session(engine) as db:
        db.execute(blobs.insert(),[dict(id='owned',content_type='application/json',size_bytes=8,payload_text='SECRET'),
            dict(id='shared',content_type='private/type',size_bytes=999,payload_text='FOREIGN'),
            dict(id='foreign',content_type='foreign/type',size_bytes=100,payload_text='FOREIGN')])
        db.execute(refs.insert(),[dict(id=1,owner=1,blob='owned'),dict(id=2,owner=1,blob='shared'),
            dict(id=3,owner=2,blob='shared'),dict(id=4,owner=2,blob='foreign')])
        result=audit_blob_references(db,metadata,reader,1)
        assert [item['id'] for item in result['items']]==['owned','shared']
        assert result['items'][1]['size_bytes'] is None
        assert result['items'][1]['content_type'] is None
        assert result['items'][1]['shared_reference'] is True
        assert 'SECRET' not in str(result) and 'FOREIGN' not in str(result)
        assert result['payloads_exported'] is False and result['deletable'] is False
        reader.inventory.rules=[]
        with pytest.raises(BoundaryDenied,match='UNCLASSIFIED'):
            audit_blob_references(db,metadata,reader,1)

