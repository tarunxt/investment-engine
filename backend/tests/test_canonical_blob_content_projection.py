import pytest
from sqlalchemy import MetaData
from test_stage17_reviewed_residency import setup,NOW
from app.domains.bullpen_run_audit.models import BullpenRunAuditBlobRecord as Blob,BullpenRunAuditSnapshotRecord as Snapshot
from app.domains.bullpen_run_audit.repository import stable_blob_id
from app.domains.polymarket_auto_live.models import PolymarketAutoLiveRunRecord as Run
from app.domains.public_service.audit_blob_projection import canonical_blob_metadata
from app.domains.ai_limits.contracts import BoundaryDenied


def test_supported_canonical_projection_requires_owner_run_and_stable_content(setup):
    db,_=setup
    for model in (Run,Blob,Snapshot):model.__table__.create(db.get_bind())
    payload={'metadata':{'run_id':'synthetic-run','source_kind':'native','lifecycle_status':'frozen','snapshot_schema_version':2},
        'overview':{'private_unstructured_text':'SYNTHETIC_DO_NOT_EXPORT'}}
    identifier=stable_blob_id(payload)
    db.add(Run(id='synthetic-run',user_id=1,status='completed',triggered_by='synthetic',summary='fixture',started_at=NOW,payload={}))
    db.add(Blob(id=identifier,content_type='application/json',sanitized=True,size_bytes=10,payload_json=payload))
    db.flush()
    db.add(Snapshot(user_id=1,run_id='synthetic-run',snapshot_schema_version=2,source_kind='native',lifecycle_status='frozen',
        audit_status='fixture',run_status='completed',triggered_by='synthetic',started_at=NOW,
        canonical_bundle_blob_id=identifier,canonical_bundle_hash=identifier));db.commit()
    metadata=MetaData();metadata.reflect(db.get_bind())
    result=canonical_blob_metadata(db,metadata,1,identifier)
    assert result['run_id']=='synthetic-run' and 'SYNTHETIC_DO_NOT_EXPORT' not in str(result)
    assert canonical_blob_metadata(db,metadata,3,identifier) is None
    db.get(Blob,identifier).payload_json={**payload,'metadata':{**payload['metadata'],'run_id':'foreign'}};db.commit()
    with pytest.raises(BoundaryDenied):canonical_blob_metadata(db,metadata,1,identifier)
