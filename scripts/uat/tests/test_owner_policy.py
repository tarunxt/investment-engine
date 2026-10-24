from pathlib import Path
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'backend'))
from app.uat.owner_policy import OwnerPolicy, AdmissionDenied, OWNER_EMAIL


class OwnerPolicyTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.policy = OwnerPolicy('uat', OWNER_EMAIL, 'synthetic.apps.googleusercontent.com')
        self.claims = dict(iss='https://accounts.google.com',
                           aud=self.policy.google_audience, sub='synthetic-owner',
                           email=OWNER_EMAIL, email_verified=True)
        self.resolve = AsyncMock(return_value=SimpleNamespace(email=OWNER_EMAIL, is_active=True))

    async def test_owner_reaches_resolver_once(self):
        user = await self.policy.resolve_verified_owner(self.claims, self.resolve)
        self.assertEqual(user.email, OWNER_EMAIL)
        self.resolve.assert_awaited_once_with(OWNER_EMAIL)

    async def test_nonowner_and_aliases_never_reach_profile_resolver(self):
        for email in ['other@gmail.com', 'tarunsingh6893@gmail.com',
                      'tarun.singh6893+uat@gmail.com', '', None]:
            with self.subTest(email=email), self.assertRaises(AdmissionDenied):
                await self.policy.resolve_verified_owner(self.claims | {'email': email}, self.resolve)
        self.resolve.assert_not_called()

    async def test_missing_or_wrong_claims_never_reach_resolver(self):
        for key, bad in [('email_verified', 'true'), ('email_verified', 1),
                         ('aud', 'production.apps.googleusercontent.com'),
                         ('iss', 'https://attacker.invalid'), ('sub', ''), ('sub', None)]:
            with self.subTest(key=key), self.assertRaises(AdmissionDenied):
                await self.policy.resolve_verified_owner(self.claims | {key: bad}, self.resolve)
        self.resolve.assert_not_called()

    async def test_disabled_or_mismatched_resolved_account_denied(self):
        for email, active in [(OWNER_EMAIL, False), ('other@gmail.com', True), (OWNER_EMAIL, 1)]:
            self.resolve.return_value = SimpleNamespace(email=email, is_active=active)
            with self.assertRaises(AdmissionDenied):
                await self.policy.resolve_verified_owner(self.claims, self.resolve)

    def test_configuration_fails_closed(self):
        for env, owner, audience in [('production', OWNER_EMAIL, self.policy.google_audience),
                                    ('development', OWNER_EMAIL, self.policy.google_audience),
                                    ('uat', '', self.policy.google_audience),
                                    ('uat', OWNER_EMAIL + ',other@gmail.com', self.policy.google_audience),
                                    ('uat', OWNER_EMAIL, '')]:
            with self.assertRaises(AdmissionDenied):
                OwnerPolicy(env, owner, audience)

    def test_refresh_policy_rechecks_current_active_identity(self):
        self.policy.require_active_owner(OWNER_EMAIL, True)
        for email, active in [('other@gmail.com', True), (OWNER_EMAIL, False)]:
            with self.assertRaises(AdmissionDenied):
                self.policy.require_active_owner(email, active)
