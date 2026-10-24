import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'backend'))
from app.uat.http_app import create_private_app
from app.uat.google_login import GoogleLogin, LoginChallenges
from app.uat.owner_policy import OwnerPolicy, OWNER_EMAIL


class AuthRouteTests(unittest.TestCase):
    def setUp(self):
        self.origin = 'https://uat.example.test'
        tokens = iter([str(i).zfill(43) for i in range(1000)])
        self.store = LoginChallenges(random_token=lambda _: next(tokens))
        self.claims = dict(iss='accounts.google.com', aud='synthetic.apps.googleusercontent.com',
                           sub='subject', email=OWNER_EMAIL, email_verified=True)
        self.resolve = AsyncMock(return_value=SimpleNamespace(
            id=1, google_sub='subject', email=OWNER_EMAIL, is_active=True))
        self.issue = AsyncMock(return_value={'access_token': 'synthetic-only'})
        self.login = GoogleLogin(origin=self.origin,
            policy=OwnerPolicy('uat', OWNER_EMAIL, self.claims['aud']),
            verifier=AsyncMock(return_value=self.claims), challenges=self.store,
            resolve=self.resolve, issue=self.issue)
        self.client = TestClient(create_private_app(AsyncMock(), google_login=self.login), base_url=self.origin)
        self.headers = {'Origin': self.origin}

    def challenge(self):
        return self.client.post('/auth/google/challenge', headers=self.headers, json={})

    def test_cookie_flags_and_success(self):
        r = self.challenge()
        self.assertEqual(r.status_code, 200)
        cookie = r.headers['set-cookie']
        for value in ['__Host-credx_uat_login=', 'HttpOnly', 'Secure', 'SameSite=strict', 'Path=/', 'Max-Age=300']:
            self.assertIn(value, cookie)
        self.assertNotIn('Domain', cookie)
        self.assertEqual(r.headers['cache-control'], 'no-store')
        r = self.client.post('/auth/google', headers=self.headers,
                             json={'credential': 'synthetic', 'nonce': r.json()['nonce']})
        self.assertEqual(r.status_code, 200)
        self.assertIn('Max-Age=0', r.headers['set-cookie'])
        self.issue.assert_awaited_once()

    def test_nonowner_cannot_resolve_or_issue(self):
        nonce = self.challenge().json()['nonce']
        self.claims['email'] = 'other@example.test'
        r = self.client.post('/auth/google', headers=self.headers, json={'credential': 'synthetic', 'nonce': nonce})
        self.assertEqual(r.status_code, 401)
        self.resolve.assert_not_awaited()
        self.issue.assert_not_awaited()

    def test_origin_host_type_duplicate_and_size_guards(self):
        cases = [({}, '{}'), ({'Origin': 'https://other.test'}, '{}'),
                 ({'Origin': self.origin, 'Host': 'other.test'}, '{}'),
                 ({'Origin': self.origin, 'Content-Type': 'text/plain'}, '{}'),
                 ([('Origin', self.origin), ('Origin', self.origin), ('Content-Type', 'application/json')], '{}'),
                 ({'Origin': self.origin, 'Content-Type': 'application/json'}, '{"a":1,"a":2}'),
                 ({'Origin': self.origin, 'Content-Type': 'application/json'}, ' ' * 17001)]
        for headers, data in cases:
            self.assertEqual(self.client.post('/auth/google/challenge', headers=headers, content=data).status_code, 401)

    def test_duplicate_cookie_and_replay(self):
        nonce = self.challenge().json()['nonce']
        token = self.client.cookies.get('__Host-credx_uat_login')
        payload = dict(credential='synthetic', nonce=nonce)
        header = {**self.headers, 'Cookie': f'__Host-credx_uat_login={token}; __Host-credx_uat_login={token}'}
        self.assertEqual(self.client.post('/auth/google', headers=header, json=payload).status_code, 401)
        header['Cookie'] = f'__Host-credx_uat_login={token}'
        self.assertEqual(self.client.post('/auth/google', headers=header, json=payload).status_code, 200)
        self.assertEqual(self.client.post('/auth/google', headers=header, json=payload).status_code, 401)
        self.issue.assert_awaited_once()

    def test_rate_limit_and_no_default_mount(self):
        for _ in range(30):
            self.assertEqual(self.challenge().status_code, 200)
        self.assertEqual(self.challenge().status_code, 401)
        other = TestClient(create_private_app(AsyncMock()))
        self.assertEqual(other.post('/auth/google').status_code, 404)

    def test_missing_cookie_extra_fields_and_get_rejected(self):
        self.assertEqual(self.client.get('/auth/google').status_code, 405)
        r = self.client.post('/auth/google', headers=self.headers,
                             json={'credential': 'synthetic', 'nonce': '1' * 43})
        self.assertEqual(r.status_code, 401)
        self.assertEqual(self.client.post('/auth/google/challenge', headers=self.headers, json={'extra': 1}).status_code, 401)
        self.resolve.assert_not_awaited()
