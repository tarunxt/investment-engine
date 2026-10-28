import os
import pytest
from test_stage17_reviewed_residency import setup,NOW
from app.domains.polymarket_auto_live.models import PolymarketAutoLiveRunRecord
from app.domains.polymarket_auto_live.export_jobs import job_key
from app.domains.public_service.export_file_inventory import owned_export_files
from app.domains.ai_limits.contracts import BoundaryDenied


def test_exact_owned_producer_files_no_cached_path_or_directory_scan(setup,tmp_path):
    db,_=setup;PolymarketAutoLiveRunRecord.__table__.create(db.get_bind())
    for subject in (1,3):
        db.add(PolymarketAutoLiveRunRecord(id=f'run-{subject}',user_id=subject,status='completed',
            triggered_by='synthetic',started_at=NOW,summary='synthetic',payload={}))
    db.commit()
    def name(subject):return job_key(subject,f'run-{subject}','filtered').rsplit(':',1)[-1]+'.xlsx'
    (tmp_path/name(1)).write_bytes(b'synthetic-owned-file')
    (tmp_path/name(3)).write_bytes(b'foreign-file')
    (tmp_path/'unknown.xlsx').write_bytes(b'unknown-file')
    fd=os.open(tmp_path,os.O_RDONLY|os.O_DIRECTORY)
    try:
        result=owned_export_files(db,1,fd)
        assert len(result['items'])==1 and result['items'][0]['run_id']=='run-1'
        assert 'foreign-file' not in str(result) and str(tmp_path) not in str(result)
        (tmp_path/name(1)).unlink();(tmp_path/name(1)).symlink_to(tmp_path/name(3))
        with pytest.raises(BoundaryDenied,match='UNSAFE'):owned_export_files(db,1,fd)
    finally:os.close(fd)
