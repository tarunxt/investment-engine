"""Actual isolated Redis wakeup preservation; no live/runtime consumer."""
import os
from pathlib import Path
from uuid import uuid4

from celery import Celery
import pytest
import redis

pytestmark = pytest.mark.skipif(
    os.getenv('CREDX_STAGE18_ACK') != 'synthetic-disposable-only',
    reason='Stage18 acknowledged disposable CI Redis required; CI rejects skips')


def test_actual_redis_redelivery_preserves_bound_owner_version_and_task_id():
    assert Path('/.dockerenv').is_file()
    assert os.environ.get('CI') == 'true' and os.environ.get('GITHUB_ACTIONS') == 'true'
    url = 'redis://redis:6379/14'
    assert os.environ.get('CREDX_STAGE17_REDIS_URL') == url
    assert os.environ.get('CREDX_STAGE17_REDIS_ACK') == 'disposable-ci-only'
    assert not any(Path(p).exists() for p in ('.env', 'backend/.env', 'frontend/.env'))
    prefix = 'stage18_' + uuid4().hex + ':'
    queue = 'stage18_rehearsal_' + uuid4().hex
    app = Celery('stage18_rehearsal', broker=url, set_as_current=False)
    app.conf.update(broker_transport_options={'global_keyprefix': prefix, 'visibility_timeout': 5},
                    task_serializer='json', accept_content=['json'], task_ignore_result=True,
                    task_publish_retry=False, broker_connection_timeout=3)
    connection = simple = None
    try:
        # Wakeup only: no financial payload or provider task is registered/run.
        binding = {'owner_id': 41, 'module_id': 'market_scanner', 'module_version': 7,
                   'request_id': 'synthetic-stage18-request'}
        sent = app.send_task('stage18.rehearsal.wakeup', kwargs=binding, queue=queue)
        connection = app.connection_for_read(); connection.connect()
        simple = connection.SimpleQueue(queue)
        first = simple.get(block=True, timeout=3)
        assert first.headers['id'] == sent.id
        assert first.payload[1] == binding
        first.reject(requeue=True)
        duplicate = simple.get(block=True, timeout=3)
        assert duplicate.headers['id'] == sent.id
        assert duplicate.payload[1] == binding
        duplicate.ack()
        # This is transport identity only, not owner-policy or worker acceptance.
        # Those require the retained authenticated/actual-worker Stage17 suites.
    finally:
        if simple is not None: simple.close()
        if connection is not None: connection.release()
        app.close()
        client = redis.Redis.from_url(url, socket_connect_timeout=3, socket_timeout=3)
        try:
            for key in client.scan_iter(match=prefix+'*', count=100): client.delete(key)
        finally:
            client.close()
