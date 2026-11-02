#!/usr/bin/env python3
"""Offline ASGI proof using production AST-extracted endpoint/auth/schema code.

Does not import application startup, settings, database, provider or broker modules.
Only persistence/query/JWT/service boundaries are faked. No external sockets allowed.
This is a focused route/dependency proof, not a full application integration test.
"""
from __future__ import annotations

import ast
import sys
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field, field_validator

ROOT = Path(__file__).resolve().parents[1]


def extract(relative, names, namespace):
    tree = ast.parse((ROOT / relative).read_text())
    nodes = [node for node in tree.body if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names]
    assert len(nodes) == len(names), names
    for node in nodes:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            node.decorator_list = []
    module = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0), *nodes], type_ignores=[])
    exec(compile(ast.fix_missing_locations(module), relative, 'exec'), namespace)


class Query:
    def where(self, *_): return self
    def options(self, *_): return self


class PreexecutionProof(unittest.IsolatedAsyncioTestCase):
    async def check(self, *, expected, active=True, authenticated=True, quantity=1, connected=True):
        calls = {'placement': 0, 'handler_repository': 0, 'audit': 0}
        user = SimpleNamespace(id=71, is_active=active)

        class DB:
            async def execute(self, _): return SimpleNamespace(scalar_one_or_none=lambda: user)

        db = DB()
        async def get_db(): yield db

        class Repo:
            def __init__(self, _): calls['handler_repository'] += 1
            async def get_plaintext_token(self, _): return 'mock-token' if connected else None

        class Audit:
            def __init__(self, _): pass
            async def log(self, *_): calls['audit'] += 1

        async def forbidden_placement(*_, **__):
            calls['placement'] += 1
            raise AssertionError('Placement must never be reached')

        module = types.ModuleType('basket_preexecution_fixture')
        sys.modules[module.__name__] = module
        ns = module.__dict__
        ns.update(dict(BaseModel=BaseModel, Field=Field, field_validator=field_validator,
            Depends=Depends, HTTPException=HTTPException, Request=Request, status=status,
            HTTPAuthorizationCredentials=HTTPAuthorizationCredentials, AsyncSession=Any,
            User=type('User', (), {'id': 0, 'profile': None}), security=HTTPBearer(auto_error=False),
            get_async_db=get_db, monotonic=lambda: 0, add_auth_duration=lambda _: None,
            is_auth_disabled=lambda: False, JWTUtils=SimpleNamespace(verify_access_token=lambda _: {'sub': '71'}),
            select=lambda _: Query(), selectinload=lambda _: None,
            ZerodhaCredentialRepository=Repo, ZerodhaAuditRepository=Audit,
            _svc=SimpleNamespace(direct_market_orders_enabled=True, place_order=forbidden_placement)))
        extract('app/domains/zerodha/schemas.py', {
            'ZerodhaProtectedMarketOrderRequest', 'ZerodhaSequencedProtectedMarketRequest',
            'ZerodhaProtectedMarketOrderResult', 'ZerodhaSequencedProtectedMarketResponse'}, ns)
        extract('app/domains/auth/dependencies.py', {'get_current_user'}, ns)
        extract('app/domains/zerodha/router.py', {'_client_ip', 'place_protected_market_orders_sequenced'}, ns)
        app = FastAPI()
        app.post('/zerodha/orders/place-protected-market-sequenced', response_model=ns['ZerodhaSequencedProtectedMarketResponse'])(ns['place_protected_market_orders_sequenced'])
        headers = {'Authorization': 'Bearer mock-session'} if authenticated else {}
        with patch('socket.socket.connect', side_effect=AssertionError('External sockets forbidden')), patch('socket.getaddrinfo', side_effect=AssertionError('External DNS forbidden')):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://offline.test') as client:
                response = await client.post('/zerodha/orders/place-protected-market-sequenced', headers=headers,
                    json={'orders': [{'tradingsymbol': 'ADD', 'exchange': 'NSE', 'transaction_type': 'BUY', 'quantity': quantity}]})
        self.assertEqual(response.status_code, expected, response.text)
        self.assertEqual(calls['placement'], 0)
        self.assertEqual(calls['audit'], 0)
        self.assertEqual(calls['handler_repository'], 1 if not connected else 0)

    async def test_401_authentication_precedes_placement(self):
        await self.check(expected=401, authenticated=False)

    async def test_403_inactive_user_precedes_placement(self):
        await self.check(expected=403, active=False)

    async def test_422_real_request_validator_precedes_placement(self):
        await self.check(expected=422, quantity=0)

    async def test_401_disconnected_broker_precedes_placement(self):
        await self.check(expected=401, connected=False)


if __name__ == '__main__':
    unittest.main(verbosity=2)
