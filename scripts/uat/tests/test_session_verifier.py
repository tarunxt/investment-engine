import sys
import time
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock
from pathlib import Path

import jwt

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'backend'))
from app.uat.owner_policy import AdmissionDenied, OWNER_EMAIL
from app.uat.session_verifier import SessionVerifier
from app.uat.sessions import OwnerSessions
from app.uat.owner_policy import OwnerPolicy
from app.uat.http_app import create_private_app
from fastapi.testclient import TestClient


class SignatureTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # Public deterministic test fixture, never a deployable credential.
        self.key = b'public-synthetic-test-key-only-000000000000000000000000'
        self.verify = SessionVerifier(environment='uat', key=self.key)
        now = int(time.time())
        self.claims = dict(iss='credx-uat', aud='credx-uat-api', sub='fixture',
                           email=OWNER_EMAIL, type='access', jti='synthetic',
                           iat=now, nbf=now, exp=now + 300)

    def token(self, claims=None, **kwargs):
        return jwt.encode(self.claims if claims is None else claims,
                          kwargs.pop('key', self.key),
                          algorithm=kwargs.pop('algorithm', 'HS256'), **kwargs)

    async def denied(self, token, kind='access'):
        with self.assertRaisesRegex(AdmissionDenied, '^UAT session denied$'):
            await self.verify(token, kind)

    async def test_real_signature_accepts_fixture(self):
        self.assertEqual(await self.verify(self.token(), 'access'), self.claims)

    async def test_wrong_signature_and_algorithms(self):
        await self.denied(self.token(key=b'different-public-synthetic-key-00000000'))
        await self.denied(self.token(algorithm='HS384'))
        await self.denied(self.token(key='', algorithm='none'))

    async def test_required_claims(self):
        for field in self.claims:
            with self.subTest(field=field):
                claims = dict(self.claims)
                del claims[field]
                await self.denied(self.token(claims))

    async def test_owner_environment_type_and_dates(self):
        now = int(time.time())
        for field, value in [('iss', 'production'), ('aud', 'production'),
                             ('aud', ['credx-uat-api']), ('type', 'refresh'),
                             ('email', 'other@example.com'), ('sub', ''),
                             ('jti', ''), ('exp', now - 1), ('nbf', now + 20),
                             ('iat', now + 20), ('exp', now + 901),
                             ('iat', str(now)), ('nbf', True)]:
            with self.subTest(field=field, value=value):
                await self.denied(self.token(dict(self.claims, **{field: value})))

    async def test_headers_and_malformed_tokens(self):
        await self.denied(self.token(headers={'jku': 'https://invalid.example/keys'}))
        await self.denied(self.token(headers={'typ': 'other'}))
        for token in ['', 'bad', 'a' * 16385, None]:
            await self.denied(token)

    async def test_refresh_type_and_lifetime(self):
        claims = dict(self.claims, type='refresh', exp=self.claims['iat'] + 86400)
        self.assertEqual(await self.verify(self.token(claims), 'refresh'), claims)
        await self.denied(self.token(claims))
        claims['exp'] += 1
        await self.denied(self.token(claims), 'refresh')

    def test_configuration_fails_closed(self):
        for env, key in [('production', self.key), ('uat', b'short'), ('uat', 'x' * 40)]:
            with self.assertRaises(AdmissionDenied):
                SessionVerifier(environment=env, key=key)

    def test_http_verifies_signature_before_owner_lookup(self):
        load = AsyncMock(return_value=SimpleNamespace(
            id='fixture', email=OWNER_EMAIL, is_active=True))
        sessions = OwnerSessions(
            OwnerPolicy('uat', OWNER_EMAIL, 'synthetic.apps.googleusercontent.com'),
            AsyncMock(), AsyncMock(), self.verify, load, AsyncMock())
        with TestClient(create_private_app(sessions)) as client:
            forged = self.token(key=b'wrong-synthetic-signature-key-000000000000')
            response = client.get('/auth/me', headers={'Authorization': 'Bearer ' + forged})
            self.assertEqual(response.status_code, 401)
            load.assert_not_awaited()
            response = client.get('/auth/me', headers={'Authorization': 'Bearer ' + self.token()})
            self.assertEqual(response.status_code, 200)
            load.assert_awaited_once_with('fixture')
