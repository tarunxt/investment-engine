"""Tiny test-only endpoints; no app router, external socket or provider dispatch."""
from typing import Annotated
from unittest.mock import Mock

from fastapi import FastAPI, Form, Request
from fastapi.testclient import TestClient
from pydantic import BaseModel
import pytest
import starlette.formparsers as parsers


class Payload(BaseModel):
    symbol: str
    units: int


@pytest.fixture
def fixture_app(monkeypatch):
    denied = Mock(side_effect=AssertionError('no external sockets in parser fixtures'))
    monkeypatch.setattr('socket.socket.connect', denied)
    monkeypatch.setattr('socket.socket.connect_ex', denied)
    monkeypatch.setattr('socket.create_connection', denied)
    app = FastAPI()
    entered = []

    @app.post('/json')
    async def json_route(payload: Payload):
        entered.append('json')
        return payload.model_dump()

    @app.post('/declared-form')
    async def declared_form(value: Annotated[str, Form(min_length=1, max_length=8)]):
        entered.append('declared-form')
        return {'value': value}

    @app.post('/bounded-form')
    async def bounded_form(request: Request):
        async with request.form(max_fields=1, max_part_size=8) as form:
            entered.append('bounded-form')
            return {'pairs': list(form.multi_items())}

    with TestClient(app) as client:
        yield client, entered
    denied.assert_not_called()


def multipart(*fields):
    boundary = 'synthetic-boundary'
    body = ''.join(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n' for name, value in fields)
    return (body + f'--{boundary}--\r\n').encode(), f'multipart/form-data; boundary={boundary}'


@pytest.mark.parametrize('content,content_type,expected', [
    (b'{"symbol":"SYNTH","units":2}', 'application/json', 200),
    (b'{"symbol":"SYNTH","units":2}', 'application/problem+json', 200),
    (b'symbol=SYNTH&units=2', 'application/x-www-form-urlencoded', 422),
    (b'synthetic', 'text/plain', 422),
    (*multipart(('symbol', 'SYNTH')), 422),
])
def test_json_fixture_never_invokes_form_parsers(fixture_app, monkeypatch, content, content_type, expected):
    client, entered = fixture_app
    form = Mock(side_effect=AssertionError('JSON route must not parse form'))
    query = Mock(side_effect=AssertionError('no querystring parser'))
    multi = Mock(side_effect=AssertionError('no multipart parser'))
    monkeypatch.setattr(Request, 'form', form)
    monkeypatch.setattr(parsers.multipart, 'QuerystringParser', query)
    monkeypatch.setattr(parsers.multipart, 'MultipartParser', multi)
    response = client.post('/json', content=content, headers={'content-type': content_type})
    assert response.status_code == expected
    assert entered == (['json'] if expected == 200 else [])
    form.assert_not_called()
    query.assert_not_called()
    multi.assert_not_called()


@pytest.mark.parametrize('value,expected', [('SYNTH', 200), ('12345678', 200), ('123456789', 422)])
def test_explicit_test_only_form_route_runs_real_parser_and_field_validation(fixture_app, monkeypatch, value, expected):
    client, entered = fixture_app
    query = Mock(wraps=parsers.multipart.QuerystringParser)
    monkeypatch.setattr(parsers.multipart, 'QuerystringParser', query)
    response = client.post('/declared-form', content=f'value={value}', headers={'content-type': 'application/x-www-form-urlencoded'})
    assert response.status_code == expected
    query.assert_called_once()
    assert entered == (['declared-form'] if expected == 200 else [])


@pytest.mark.parametrize('fields,expected', [
    ([('value', '12345678')], 200),
    ([('value', '123456789')], 400),
    ([('first', 'a'), ('second', 'b')], 400),
])
def test_tiny_multipart_field_and_part_limits(fixture_app, fields, expected):
    client, entered = fixture_app
    content, kind = multipart(*fields)
    response = client.post('/bounded-form', content=content, headers={'content-type': kind})
    assert response.status_code == expected
    assert entered == (['bounded-form'] if expected == 200 else [])


def test_duplicate_urlencoded_parameter_order_is_preserved(fixture_app):
    client, _ = fixture_app
    response = client.post('/bounded-form', content='value=a&value=b', headers={'content-type': 'application/x-www-form-urlencoded'})
    assert response.status_code == 200
    assert response.json() == {'pairs': [['value', 'a'], ['value', 'b']]}


@pytest.mark.parametrize('content', ['first=a&second=b', 'value=123456789'])
@pytest.mark.xfail(strict=True, raises=AssertionError, reason='Starlette 1.0.0 urlencoded parser ignores max_fields/max_part_size; fixture-only reachability, no app form endpoint established')
def test_urlencoded_test_only_limits_must_be_enforced(fixture_app, content):
    client, entered = fixture_app
    response = client.post('/bounded-form', content=content, headers={'content-type': 'application/x-www-form-urlencoded'})
    assert response.status_code == 400
    assert entered == []
