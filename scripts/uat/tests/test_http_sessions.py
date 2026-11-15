"""HTTP-to-session integration using synthetic verifier outputs, never live keys."""
import sys
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'backend'))
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from app.uat.http_app import create_private_app
from app.uat.owner_policy import OWNER_EMAIL, OwnerPolicy, AdmissionDenied
from app.uat.sessions import OwnerSessions


class HttpSessionIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.user = SimpleNamespace(id=1, email=OWNER_EMAIL, is_active=True)
        self.claims = dict(sub='1', email=OWNER_EMAIL, type='access',
                           iss='credx-uat', aud='credx-uat-api')
        self.verify = AsyncMock(return_value=self.claims)
        self.load = AsyncMock(return_value=self.user)
        self.resolve = AsyncMock()
        self.issue = AsyncMock()
        self.sessions = OwnerSessions(
            OwnerPolicy('uat', OWNER_EMAIL, 'synthetic.apps.googleusercontent.com'),
            AsyncMock(), self.resolve, self.verify, self.load, self.issue)
        self.client = TestClient(create_private_app(self.sessions))
        self.headers = {'Authorization': 'Bearer synthetic-fixture'}
        self.order = dict(request_id='integration', symbol='SYNTHETIC-INDEX',
                          side='buy', quantity=1)

    def test_valid_session_reaches_only_synthetic_order(self):
        response = self.client.post('/simulation/orders', headers=self.headers, json=self.order)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()['simulation'])
        self.assertTrue(response.json()['order_id'].startswith('synthetic-'))
        self.verify.assert_awaited_once_with('synthetic-fixture', 'access')
        self.load.assert_awaited_once_with('1')
        self.resolve.assert_not_awaited()
        self.issue.assert_not_awaited()

    def test_nonowner_and_cross_environment_denied_before_lookup(self):
        for key, value in [('email', 'other@example.com'), ('iss', 'production'),
                           ('aud', 'production'), ('type', 'refresh')]:
            original = self.claims[key]
            self.claims[key] = value
            with self.subTest(key=key):
                response = self.client.post('/simulation/orders', headers=self.headers,
                                            json=self.order)
                self.assertEqual(response.status_code, 401)
            self.claims[key] = original
        self.load.assert_not_awaited()
        self.resolve.assert_not_awaited()
        self.issue.assert_not_awaited()

    def test_disabled_after_first_request_denied_without_order_creation(self):
        self.assertEqual(self.client.get('/auth/me', headers=self.headers).status_code, 200)
        self.user.is_active = False
        self.assertEqual(self.client.post('/simulation/orders', headers=self.headers,
                                          json=self.order).status_code, 401)
        self.user.is_active = True
        changed = {**self.order, 'quantity': 2}
        self.assertEqual(self.client.post('/simulation/orders', headers=self.headers,
                                          json=changed).status_code, 200)

    def test_verifier_rejection_does_not_leak_details(self):
        self.verify.side_effect = AdmissionDenied('private verifier diagnostic')
        response = self.client.get('/auth/me', headers=self.headers)
        self.assertEqual(response.status_code, 401)
        self.assertNotIn('private verifier diagnostic', response.text)
        self.load.assert_not_awaited()

    def test_cookie_and_websocket_cannot_bypass_bearer_policy(self):
        self.client.cookies.set('session', 'synthetic-fixture')
        self.assertEqual(self.client.get('/auth/me').status_code, 401)
        with self.assertRaises(WebSocketDisconnect):
            with self.client.websocket_connect('/simulation/orders', headers=self.headers):
                self.fail('WebSocket route must remain unavailable')
        self.verify.assert_not_awaited()
