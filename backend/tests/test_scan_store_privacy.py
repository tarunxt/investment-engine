import os,hashlib
import pytest
from test_stage17_reviewed_residency import setup,NOW
from app.domains.polymarket_auto_live.models import PolymarketAutoLiveRunRecord as Run
from app.domains.public_service.scan_store_inventory import scan_inventory
from app.domains.ai_limits.contracts import BoundaryDenied


def test_owned_run_references_are_verified_without_opaque_content_or_foreign_scan(setup,tmp_path):
    db,_=setup;Run.__table__.create(db.get_bind())
    sources=tmp_path/'source';pages=tmp_path/'pages';sources.mkdir();pages.mkdir()
    content=b'SYNTHETIC_PRIVATE_OPAQUE';identity='a'*32
    (sources/(identity+'.pack')).write_bytes(content)
    reference=f'source-v1:{identity}:0:{len(content)}:{hashlib.sha256(content).hexdigest()}'
    db.add(Run(id='owned',user_id=1,status='completed',triggered_by='synthetic',summary='fixture',started_at=NOW,payload={'stage_results':[{'scan_export_data':reference}]}))
    db.add(Run(id='foreign',user_id=3,status='completed',triggered_by='synthetic',summary='fixture',started_at=NOW,payload={'scan_export_data':'source-v1:malformed'}));db.commit()
    directory=pages/hashlib.sha256(b'owned').hexdigest();directory.mkdir()
    (directory/('b'*64+'.json.gz')).write_bytes(b'opaque-gzip-fixture')
    (pages/'foreign-unknown').mkdir()
    source_fd=os.open(sources,os.O_RDONLY|os.O_DIRECTORY);page_fd=os.open(pages,os.O_RDONLY|os.O_DIRECTORY)
    try:
        result=scan_inventory(db,1,source_directory_fd=source_fd,page_directory_fd=page_fd)
        assert len(result['runs'])==1 and len(result['runs'][0]['pages'])==1
        assert result['runs'][0]['segments'][0]['size_bytes']==len(content)
        assert 'SYNTHETIC_PRIVATE' not in str(result) and result['exclusive_pack_ownership_proven'] is False
        (sources/(identity+'.pack')).write_bytes(b'corrupted')
        with pytest.raises(BoundaryDenied):scan_inventory(db,1,source_directory_fd=source_fd,page_directory_fd=page_fd)
    finally:os.close(source_fd);os.close(page_fd)
