from __future__ import annotations
import logging
import os
import time
from sqlalchemy import select
from app.infrastructure.messaging.celery_app import celery
from app.infrastructure.database.sync_session import SyncSessionLocal
from app.domains.polymarket_auto_live.models import PolymarketAutoLiveRunRecord
from app.domains.polymarket_auto_live.export_snapshot import build_export_snapshot
from app.domains.polymarket_auto_live.stage_one_excel import build_stage_one_excel
from app.domains.polymarket_auto_live.export_jobs import ROOT, client, job_key, read_job, save_job

@celery.task(name='app.domains.polymarket_auto_live.export_tasks.prepare_stage_one_excel', bind=True, max_retries=70, soft_time_limit=1800, time_limit=1860, acks_late=True, reject_on_worker_lost=True)
def prepare_stage_one_excel(self, user_id: int, run_id: str, scope: str):
    key = job_key(user_id, run_id, scope)
    with client() as cache:
        lock = cache.lock(key + ':lock', timeout=1900, blocking_timeout=0)
        if not lock.acquire(blocking=False):
            # A killed worker cannot release its lock. Do not acknowledge and
            # discard its redelivered export while that finite lease expires.
            raise self.retry(countdown=30)
        try:
            old = read_job(key)
            if old and old['status'] == 'ready' and os.path.isfile(old['path']):
                return
            save_job(key, {'status': 'working', 'message': 'Loading saved Stage 1 rows'})
            with SyncSessionLocal() as session:
                record = session.execute(select(
                    PolymarketAutoLiveRunRecord.payload['stage_results'].label('stage_results'),
                    PolymarketAutoLiveRunRecord.started_at,
                    PolymarketAutoLiveRunRecord.completed_at,
                ).where(
                    PolymarketAutoLiveRunRecord.id == run_id, PolymarketAutoLiveRunRecord.user_id == user_id
                )).one_or_none()
                if record is None:
                    raise ValueError('Run not found')
                run = build_export_snapshot(record.stage_results, record.started_at, record.completed_at)
            last_report = 0.0
            def report_progress(phase, processed, total):
                nonlocal last_report
                now = time.monotonic()
                if now - last_report < 3 and processed not in (0, total):
                    return
                last_report = now
                save_job(key, {'status': 'working', 'phase': phase,
                    'processed_rows': processed, 'total_rows': total,
                    'message': f'{phase}: {processed:,} / {total:,} rows'})
            path, filename, count = build_stage_one_excel(run, scope, True,
                enrichment_budget_seconds=1500, progress_callback=report_progress)
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
