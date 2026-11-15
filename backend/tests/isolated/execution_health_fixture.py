"""Explicit disposable PostgreSQL target, never application DATABASE_URL."""
import os
from pathlib import Path

from sqlalchemy.engine import make_url


def guarded_target(raw, acknowledgement):
    url = make_url(raw)
    if (acknowledgement != 'disposable-local-only'
            or url.drivername not in {'postgresql', 'postgresql+asyncpg'}
            or url.host not in {'localhost', '127.0.0.1', '::1'}
            or not (url.database or '').startswith('credx_audit_test_')
            or url.query):
        raise ValueError('Execution health tests require acknowledged disposable local PostgreSQL')
    return url.set(drivername='postgresql+asyncpg')


def configured_target():
    raw = os.environ.get('CREDX_AUDIT_TEST_DATABASE_URL')
    if raw:
        return guarded_target(raw, os.environ.get('CREDX_AUDIT_TEST_DATABASE_ACK'))
    if os.environ.get('CREDX_A11_HEALTH_PG_TEST') == 'synthetic-socket-only':
        directory = Path('/tmp/a11-004-pg-socket')
        if not (directory / 'A11_SYNTHETIC_ONLY').is_file() or not (directory / '.s.PGSQL.55434').is_socket():
            raise ValueError('Acknowledged synthetic health fixture marker/socket is missing')
        return 'postgresql+asyncpg://postgres@/postgres?host=/tmp/a11-004-pg-socket&port=55434'
    return None
