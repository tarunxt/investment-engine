"""Synthetic RSA fixtures only: no Google request, persistent key or credential."""
import asyncio
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'backend'))
from app.uat.google_login import GoogleVerifier, GoogleLogin, LoginChallenges
from app.uat.owner_policy import OwnerPolicy, OWNER_EMAIL, AdmissionDenied


class GoogleTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    def setUp(self):
        self.policy = OwnerPolicy('uat', OWNER_EMAIL, 'synthetic.apps.googleusercontent.com')
        self.now = int(time.time())
        self.cache_expiry = self.now + 60
        self.clock = 100
        self.counter = 0
        def random_token(size):
            self.counter += 1
            return str(self.counter).zfill(43)
        self.challenges = LoginChallenges(clock=lambda: self.clock, random_token=random_token)
        self.cookie, self.nonce = self.challenges.issue()
        self.verifier = GoogleVerifier(self.policy, lambda: ({'fixture': self.key.public_key()}, self.cache_expiry))
        self.claims = dict(iss='https://accounts.google.com', aud=self.policy.google_audience,
                           sub='synthetic-google-sub', email=OWNER_EMAIL, email_verified=True,
                           iat=self.now, exp=self.now + 3600, nonce=self.nonce)
        self.user = SimpleNamespace(google_sub='synthetic-google-sub', email=OWNER_EMAIL, is_active=True)
        self.resolve = AsyncMock(return_value=self.user)
        self.issue = AsyncMock(return_value={'synthetic': True})
        self.login = GoogleLogin(origin='https://uat.example.test', policy=self.policy,
                                 verifier=self.verifier, challenges=self.challenges,
                                 resolve=self.resolve, issue=self.issue)

    def token(self, claims=None, key=None, headers=None):
        return jwt.encode(self.claims if claims is None else claims, key or self.key,
                          algorithm='RS256', headers=headers or {'kid': 'fixture'})

    async def submit(self, **changes):
        args = dict(origin='https://uat.example.test', cookie=self.cookie,
                    nonce=self.nonce, credential=self.token())
        args.update(changes)
        return await self.login.login(**args)

    async def test_owner_and_one_use(self):
        self.assertEqual(await self.submit(), {'synthetic': True})
        with self.assertRaises(AdmissionDenied):
            await self.submit()
        self.resolve.assert_awaited_once_with('synthetic-google-sub', OWNER_EMAIL)
        self.issue.assert_awaited_once()

    async def test_concurrent_replay_resolves_once(self):
        results = await asyncio.gather(self.submit(), self.submit(), return_exceptions=True)
        self.assertEqual(sum(isinstance(r, AdmissionDenied) for r in results), 1)
        self.resolve.assert_awaited_once()

    async def test_origin_cookie_nonce_binding(self):
        for changes in [dict(origin='https://other.example.test'), dict(origin=None),
                        dict(cookie='x' * 43), dict(nonce='x' * 43), dict(cookie=None)]:
            with self.assertRaises(AdmissionDenied):
                await self.submit(**changes)
        self.resolve.assert_not_awaited()

    async def test_expired_challenge(self):
        self.clock += 300
        with self.assertRaises(AdmissionDenied):
            await self.submit()
        self.resolve.assert_not_awaited()

    async def test_signature_unknown_key_and_key_url(self):
        for token in [self.token(key=self.other_key), self.token(headers={'kid': 'unknown'}),
                      self.token(headers={'kid': 'fixture', 'jku': 'https://invalid.example'}),
                      jwt.encode(self.claims, 'public-synthetic-test-string-000000000', algorithm='HS256', headers={'kid': 'fixture'}),
                      jwt.encode(self.claims, '', algorithm='none', headers={'kid': 'fixture'})]:
            with self.assertRaisesRegex(AdmissionDenied, '^UAT identity denied$'):
                await self.submit(credential=token)
        self.resolve.assert_not_awaited()

    async def test_claim_failures_before_profile(self):
        for field, value in [('email', 'other@example.com'), ('email_verified', False),
                             ('email_verified', 'true'), ('aud', 'production'),
                             ('aud', [self.policy.google_audience]), ('iss', 'attacker'),
                             ('nonce', 'x' * 43), ('azp', 'production'), ('sub', ''),
                             ('exp', self.now - 1), ('iat', self.now + 5), ('exp', self.now + 3601)]:
            with self.subTest(field=field, value=value):
                with self.assertRaises(AdmissionDenied):
                    await self.submit(credential=self.token(dict(self.claims, **{field: value})))
        self.resolve.assert_not_awaited()
        self.issue.assert_not_awaited()

    async def test_required_claims(self):
        for field in self.claims:
            claims = dict(self.claims)
            del claims[field]
            with self.assertRaises(AdmissionDenied):
                await self.submit(credential=self.token(claims))
        self.resolve.assert_not_awaited()

    async def test_expired_key_cache_fails_closed(self):
        self.cache_expiry = self.now - 1
        with self.assertRaises(AdmissionDenied):
            await self.submit()
        self.resolve.assert_not_awaited()

    async def test_disabled_or_subject_conflict_never_issues(self):
        self.user.is_active = False
        with self.assertRaises(AdmissionDenied):
            await self.submit()
        self.user.is_active = True
        self.user.google_sub = 'different'
        self.cookie, self.nonce = self.challenges.issue()
        self.claims['nonce'] = self.nonce
        with self.assertRaises(AdmissionDenied):
            await self.submit()
        self.issue.assert_not_awaited()

    async def test_provider_failure_is_generic(self):
        def fail():
            raise RuntimeError('private transport details')
        verifier = GoogleVerifier(self.policy, fail)
        with self.assertRaisesRegex(AdmissionDenied, '^UAT identity denied$'):
            await verifier(self.token(), self.nonce)

    def test_bounded_store_and_expiry_cleanup(self):
        for _ in range(255):
            self.challenges.issue()
        with self.assertRaises(AdmissionDenied):
            self.challenges.issue()
        self.clock += 301
        cookie, nonce = self.challenges.issue()
        self.challenges.check(cookie, nonce)

    def test_rejects_unsafe_origin_configuration(self):
        for origin in ['http://uat.example.test', 'https://uat.example.test/path',
                       'https://user:password@uat.example.test', 'https://uat.example.test?query']:
            with self.assertRaises(AdmissionDenied):
                GoogleLogin(origin=origin, policy=self.policy, verifier=self.verifier,
                            challenges=self.challenges, resolve=self.resolve, issue=self.issue)
