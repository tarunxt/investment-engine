"""Dependency-injected UAT session orchestration; no live transport is configured.

Adapters must verify Google signature/expiry/nonce and session signature/type/
issuer/audience/expiry before returning claims. Never pass request claims directly.
Production auth helpers and routers are deliberately not imported.
"""
from .owner_policy import AdmissionDenied


class OwnerSessions:
    def __init__(self, policy, verify_google, resolve_owner, verify_session,
                 load_owner, issue_tokens):
        self.policy = policy
        self.verify_google = verify_google
        self.resolve_owner = resolve_owner
        self.verify_session = verify_session
        self.load_owner = load_owner
        self.issue_tokens = issue_tokens

    async def login(self, credential, nonce):
        if not isinstance(credential, str) or not 1 <= len(credential) <= 16384:
            raise AdmissionDenied('UAT identity denied')
        if not isinstance(nonce, str) or not 16 <= len(nonce) <= 256:
            raise AdmissionDenied('UAT identity denied')
        claims = await self.verify_google(credential, nonce)
        user = await self.policy.resolve_verified_owner(claims, self.resolve_owner)
        return await self.issue_tokens(user)

    async def authenticate(self, token, token_type='access'):
        if token_type not in ('access', 'refresh'):
            raise AdmissionDenied('UAT session denied')
        if not isinstance(token, str) or not 1 <= len(token) <= 16384:
            raise AdmissionDenied('UAT session denied')
        claims = await self.verify_session(token, token_type)
        if (not isinstance(claims, dict) or claims.get('type') != token_type
                or claims.get('iss') != 'credx-uat'
                or claims.get('aud') != 'credx-uat-api'
                or not isinstance(claims.get('sub'), str) or not claims['sub']):
            raise AdmissionDenied('UAT session denied')
        self.policy.require_active_owner(claims.get('email'), True)
        user = await self.load_owner(claims['sub'])
        if user is None or str(user.id) != claims['sub']:
            raise AdmissionDenied('UAT session denied')
        self.policy.require_active_owner(user.email, user.is_active)
        return user

    async def refresh(self, token):
        return await self.issue_tokens(await self.authenticate(token, 'refresh'))
