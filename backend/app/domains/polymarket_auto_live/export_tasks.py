from __future__ import annotations
import logging
import os
import time
from sqlalchemy import select
from app.infrastructure.messaging.celery_app import celery
from app.infrastructure.database.sync_session import SyncSessionLocal
from app.domains.polymarket_auto_live.models import PolymarketAutoLiveRunRecord
from app.domains.polymarket_auto_live.repository import record_to_run
from app.domains.polymarket_auto_live.stage_one_excel import build_stage_one_excel
from app.domains.polymarket_auto_live.export_jobs import ROOT, client, job_key, read_job, save_job

@celery.task(name='app.domains.polymarket_auto_live.export_tasks.prepare_stage_one_excel', soft_time_limit=1800, time_limit=1860, acks_late=True, reject_on_worker_lost=True)
def prepare_stage_one_excel(user_id: int, run_id: str, scope: str):
    key = job_key(user_id, run_id, scope)
    with client() as cache:
        lock = cache.lock(key + ':lock', timeout=1900, blocking_timeout=0)
        if not lock.acquire(blocking=False):
            return
        try:
            old = read_job(key)
            if old and old['status'] == 'ready' and os.path.isfile(old['path']):
                return
            save_job(key, {'status': 'working', 'message': 'Fetching Gamma source fields and building Excel'})
            with SyncSessionLocal() as session:
                record = session.execute(select(PolymarketAutoLiveRunRecord).where(
                    PolymarketAutoLiveRunRecord.id == run_id, PolymarketAutoLiveRunRecord.user_id == user_id
                )).scalar_one_or_none()
                if record is None:
                    raise ValueError('Run not found')
                run = record_to_run(record)
            path, filename, count = build_stage_one_excel(run, scope, True, enrichment_budget_seconds=1500)
            ROOT.mkdir(parents=True, exist_ok=True)
            target = ROOT / (key.rsplit(':', 1)[-1] + '.xlsx')
            # Source and destination can be different filesystems.
            import shutil
            shutil.move(str(path), target)
            save_job(key, {'status': 'ready', 'message': 'Excel ready', 'path': str(target), 'filename': filename, 'row_count': count})
            for expired in ROOT.glob('*.xlsx'):
                if expired != target and time.time() - expired.stat().st_mtime > 86400:
                    expired.unlink(missing_ok=True)
        except Exception:
            logging.getLogger(__name__).exception('Stage 1 Excel preparation failed for run %s', run_id)
            save_job(key, {'status': 'failed', 'message': 'Excel preparation failed. Please retry later; the failure has been logged.'})
            raise
        finally:
            lock.release()
