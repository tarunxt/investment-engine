import sys
from pathlib import Path
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'backend'))
from fastapi.testclient import TestClient
from app.uat.http_app import create_private_app
from app.uat.owner_policy import AdmissionDenied, OWNER_EMAIL


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.sessions = SimpleNamespace(authenticate=AsyncMock(return_value=
            SimpleNamespace(id=1, email=OWNER_EMAIL)))
        self.client = TestClient(create_private_app(self.sessions))
        self.auth = {'Authorization': 'Bearer synthetic-test-session'}
        self.order = dict(request_id='retry-1', symbol='SYNTHETIC-INDEX', side='buy', quantity=1)

    def test_all_routes_require_session(self):
        for path in ['/health', '/auth/me']:
            self.assertEqual(self.client.get(path).status_code, 401)
        self.assertEqual(self.client.post('/simulation/orders', json=self.order).status_code, 401)
        self.sessions.authenticate.assert_not_awaited()

    def test_denied_identity_cannot_submit(self):
        self.sessions.authenticate.side_effect = AdmissionDenied('denied')
        self.assertEqual(self.client.post('/simulation/orders', headers=self.auth,
                                        json=self.order).status_code, 401)

    def test_real_adapter_fields_rejected(self):
        self.assertEqual(self.client.post('/simulation/orders', headers=self.auth,
            json={**self.order, 'endpoint': 'https://broker.example'}).status_code, 422)
        self.assertEqual(self.client.post('/simulation/orders', headers=self.auth,
            json={**self.order, 'quantity': True}).status_code, 422)

    def test_retry_and_conflict(self):
        a = self.client.post('/simulation/orders', headers=self.auth, json=self.order)
        b = self.client.post('/simulation/orders', headers=self.auth, json=self.order)
        self.assertEqual(a.status_code, 200)
        self.assertEqual(a.json(), b.json())
        self.assertTrue(a.json()['simulation'])
        self.assertEqual(self.client.post('/simulation/orders', headers=self.auth,
            json={**self.order, 'quantity': 2}).status_code, 409)

    def test_alternate_routes_and_docs_absent(self):
        for path in ['/auth/register', '/auth/login', '/auth/refresh', '/auth/reset-password',
                     '/auth/google', '/broker/orders', '/tasks', '/docs', '/openapi.json']:
            for verb in ['get', 'post', 'put', 'delete', 'patch']:
                self.assertEqual(getattr(self.client, verb)(path, headers=self.auth).status_code, 404)

    def test_duplicate_auth_denied(self):
        self.assertEqual(self.client.get('/health', headers=[('Authorization','Bearer a'),
            ('Authorization','Bearer b')]).status_code, 401)
