"""Bounded, reusable Stage 1 export jobs. HTTP requests only poll or serve files."""
from __future__ import annotations
import hashlib
import json
import logging
import os
import time
from pathlib import Path
import redis
from app.core.config import settings

TTL = 3600
ROOT = Path(os.environ.get('BULLPEN_EXPORT_DIR', Path(__file__).resolve().parents[3] / '.stage-one-exports'))

def job_key(user_id: int, run_id: str, scope: str) -> str:
    return 'bullpen:excel:v2:' + hashlib.sha256(f'{user_id}:{run_id}:{scope}'.encode()).hexdigest()

def client():
    return redis.Redis.from_url(settings.redis_url, decode_responses=True, socket_timeout=5)

def read_job(key: str):
    with client() as cache:
        raw = cache.get(key)
    return json.loads(raw) if raw else None

def save_job(key: str, value: dict):
    with client() as cache:
        cache.set(key, json.dumps({**value, 'updated_at': time.time()}), ex=TTL)

def ensure_job(user_id: int, run_id: str, scope: str):
    key = job_key(user_id, run_id, scope)
    with client() as cache:
        raw = cache.get(key)
        if raw:
            state = json.loads(raw)
            orphaned = state['status'] == 'working' and not cache.exists(key + ':lock')
            if not orphaned and state['status'] != 'failed' and (state['status'] != 'ready' or Path(state['path']).is_file()):
                return state
            cache.delete(key)
        state = {'status': 'queued', 'message': 'Queued for Excel preparation', 'created_at': time.time()}
        if not cache.set(key, json.dumps(state), nx=True, ex=TTL):
            return read_job(key) or state
    try:
        from app.domains.polymarket_auto_live.export_tasks import prepare_stage_one_excel
        prepare_stage_one_excel.apply_async(args=[user_id, run_id, scope], queue='ai')
    except Exception:
        logging.getLogger(__name__).exception('Could not queue Stage 1 export')
        with client() as cache:
            cache.delete(key)
        raise
    return state

def read_or_recover_job(user_id: int, run_id: str, scope: str):
    key = job_key(user_id, run_id, scope)
    state = read_job(key)
    # Only recover an already-authorized preparation. An absent status remains
    # absent, and a live lock is never stolen from a working export process.
    if state and state.get('status') == 'working':
        with client() as cache:
            idle = not cache.exists(key + ':lock')
        if idle:
            return ensure_job(user_id, run_id, scope)
    return state

def public_state(state: dict) -> dict:
    return {k: v for k, v in state.items() if k in {'status', 'message', 'row_count', 'filename', 'phase', 'processed_rows', 'total_rows', 'updated_at'}}
