import asyncio
import json

from asyncpg.exceptions import CannotConnectNowError, TooManyConnectionsError
from sqlalchemy.exc import DBAPIError, IntegrityError, TimeoutError
from starlette.requests import Request

from app.infrastructure.database.errors import database_is_unavailable
from app.infrastructure.database.session import ASYNC_POOL_TIMEOUT_SECONDS


def test_database_shutdown_pool_and_connection_failures_are_transient():
    shutdown = CannotConnectNowError('the database system is shutting down')
    assert database_is_unavailable(shutdown)
    assert database_is_unavailable(DBAPIError('select', {}, shutdown))
    assert database_is_unavailable(ExceptionGroup('request', [shutdown]))
    assert database_is_unavailable(TooManyConnectionsError('too many clients'))
    assert database_is_unavailable(TimeoutError('pool wait'))


def test_application_bugs_and_invalid_writes_are_not_reported_as_outages():
    assert not database_is_unavailable(ValueError('invalid rank'))
    assert not database_is_unavailable(IntegrityError('insert', {}, ValueError('constraint')))


def test_database_pool_exhaustion_fails_inside_the_proxy_deadline():
    assert ASYNC_POOL_TIMEOUT_SECONDS == 5


def test_outage_response_is_retryable_without_exposing_driver_detail():
    from app.main import general_exception_handler
    request = Request({'type': 'http', 'method': 'GET', 'path': '/api/sports-rankings'})
    response = asyncio.run(general_exception_handler(request, CannotConnectNowError('internal details')))
    assert response.status_code == 503
    assert response.headers['retry-after'] == '3'
    assert json.loads(response.body)['error'] == 'DATABASE_UNAVAILABLE'
    assert b'internal details' not in response.body
