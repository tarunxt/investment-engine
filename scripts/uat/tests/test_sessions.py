import sys
from pathlib import Path
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'backend'))
from app.uat.owner_policy import OwnerPolicy, OWNER_EMAIL, AdmissionDenied
from app.uat.sessions import OwnerSessions


class SessionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.policy = OwnerPolicy('uat', OWNER_EMAIL, 'synthetic.apps.googleusercontent.com')
        self.user = SimpleNamespace(id=1, email=OWNER_EMAIL, is_active=True)
        self.google = {'email': OWNER_EMAIL, 'email_verified': True, 'sub': 'google-owner',
                       'iss': 'https://accounts.google.com', 'aud': self.policy.google_audience}
        self.claims = {'email': OWNER_EMAIL, 'sub': '1', 'iss': 'credx-uat',
                       'aud': 'credx-uat-api', 'type': 'refresh'}
        self.verify = AsyncMock(return_value=self.google)
        self.resolve = AsyncMock(return_value=self.user)
        self.decode = AsyncMock(return_value=self.claims)
        self.load = AsyncMock(return_value=self.user)
        self.issue = AsyncMock(return_value={'synthetic': True})
        self.sessions = OwnerSessions(self.policy, self.verify, self.resolve,
                                      self.decode, self.load, self.issue)

    async def test_owner_login(self):
        self.assertEqual(await self.sessions.login('fixture', 'n' * 16), {'synthetic': True})
        self.verify.assert_awaited_once_with('fixture', 'n' * 16)
        self.issue.assert_awaited_once_with(self.user)

    async def test_nonowner_has_no_profile_or_session(self):
        self.google['email'] = 'other@example.com'
        with self.assertRaises(AdmissionDenied):
            await self.sessions.login('fixture', 'n' * 16)
        self.resolve.assert_not_awaited()
        self.issue.assert_not_awaited()

    async def test_verification_failure_has_no_profile(self):
        self.verify.side_effect = AdmissionDenied('invalid')
        with self.assertRaises(AdmissionDenied):
            await self.sessions.login('fixture', 'n' * 16)
        self.resolve.assert_not_awaited()

    async def test_refresh_rechecks_active_owner(self):
        self.user.is_active = False
        with self.assertRaises(AdmissionDenied):
            await self.sessions.refresh('fixture')
        self.issue.assert_not_awaited()

    async def test_cross_environment_and_wrong_type_denied_before_lookup(self):
        for key, value in [('iss', 'production'), ('aud', 'production'),
                           ('type', 'access'), ('email', 'other@example.com')]:
            original = self.claims[key]
            self.claims[key] = value
            with self.assertRaises(AdmissionDenied):
                await self.sessions.refresh('fixture')
            self.claims[key] = original
        self.load.assert_not_awaited()
        self.issue.assert_not_awaited()

    async def test_subject_mismatch_denied(self):
        self.user.id = 2
        with self.assertRaises(AdmissionDenied):
            await self.sessions.refresh('fixture')
        self.issue.assert_not_awaited()

    async def test_invalid_input_does_not_invoke_verifiers(self):
        with self.assertRaises(AdmissionDenied):
            await self.sessions.login('fixture', '')
        with self.assertRaises(AdmissionDenied):
            await self.sessions.refresh('x' * 16385)
        self.verify.assert_not_awaited()
        self.decode.assert_not_awaited()
