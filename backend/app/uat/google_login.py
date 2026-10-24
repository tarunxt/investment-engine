"""Offline Google verification and one-process login challenge primitive.

No HTTP routes, network transport, credential loader or live key is configured.
An approved certificate-only transport must supply trusted Google RSA public keys
and their cache expiry. Unknown keys and expired bundles fail closed.
The challenge store is bounded, ephemeral and deliberately single-process.
An HTTP adapter must enforce the documented JSON/origin/host-only-cookie contract.
"""
import hmac
import re
import secrets
import threading
import time
from urllib.parse import urlsplit

import jwt
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicKey

from .owner_policy import AdmissionDenied


def deny():
    return AdmissionDenied('UAT identity denied')


def valid_challenge(value):
    return isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_-]{43}', value) is not None


class LoginChallenges:
    """Five-minute, one-use browser-bound nonce; restart invalidates outstanding logins."""
    def __init__(self, *, clock=time.monotonic, random_token=secrets.token_urlsafe):
        self._clock, self._random = clock, random_token
        self._entries = {}
        self._lock = threading.Lock()

    def issue(self):
        with self._lock:
            now = self._clock()
            self._entries = {k: v for k, v in self._entries.items() if v[1] > now}
            if len(self._entries) >= 256:
                raise deny()
            cookie, nonce = self._random(32), self._random(32)
            if (not valid_challenge(cookie) or not valid_challenge(nonce)
                    or cookie in self._entries or cookie == nonce):
                raise deny()
            self._entries[cookie] = (nonce, now + 300)
            return cookie, nonce

    def check(self, cookie, nonce, *, consume=False):
        if not valid_challenge(cookie) or not valid_challenge(nonce):
            raise deny()
        with self._lock:
            entry = self._entries.get(cookie)
            if not entry or entry[1] <= self._clock() or not hmac.compare_digest(entry[0], nonce):
                raise deny()
            if consume:
                del self._entries[cookie]


class GoogleVerifier:
    def __init__(self, policy, trusted_keys, *, clock=time.time):
        self.policy, self._keys, self._clock = policy, trusted_keys, clock

    async def __call__(self, credential, nonce):
        try:
            if not isinstance(credential, str) or not 1 <= len(credential) <= 16384 or not valid_challenge(nonce):
                raise ValueError()
            header = jwt.get_unverified_header(credential)
            if (set(header) != {'alg', 'typ', 'kid'} or header['alg'] != 'RS256'
                    or header['typ'] != 'JWT' or not isinstance(header['kid'], str)
                    or not 1 <= len(header['kid']) <= 128):
                raise ValueError()
            # This provider receives no token, URL, nonce or attacker-selected key ID.
            keys, expires = self._keys()
            if not isinstance(expires, (int, float)) or not self._clock() < expires:
                raise ValueError()
            key = keys[header['kid']]
            if not isinstance(key, RSAPublicKey) or key.key_size < 2048:
                raise ValueError()
            claims = jwt.decode(credential, key, algorithms=['RS256'],
                                audience=self.policy.google_audience,
                                issuer=['accounts.google.com', 'https://accounts.google.com'],
                                options={'require': ['exp', 'iat', 'iss', 'aud', 'sub',
                                                     'email', 'email_verified', 'nonce'],
                                         'strict_aud': True}, leeway=0)
            if (type(claims['exp']) is not int or type(claims['iat']) is not int
                    or not claims['iat'] < claims['exp'] <= claims['iat'] + 3600
                    or not valid_challenge(claims['nonce'])
                    or not hmac.compare_digest(claims['nonce'], nonce)
                    or ('azp' in claims and claims['azp'] != self.policy.google_audience)):
                raise ValueError()
            self.policy.admit_verified_claims(claims)
            return claims
        except Exception:
            # Provider diagnostics must not leak keys, claims or credentials.
            raise deny() from None


class GoogleLogin:
    """Prepared for same-origin JS POST /auth/google, not a mounted endpoint.

Browser sends credential plus server-issued nonce in JSON and a Secure, HttpOnly,
SameSite=Strict __Host-credx_uat_login cookie (Path=/, no Domain). Reject cross-
origin requests before verification. Resolve identity by verified Google subject;
the resolver must reject subject conflicts and return an empty synthetic profile.
"""
    def __init__(self, *, origin, policy, verifier, challenges, resolve, issue):
        parsed = urlsplit(origin)
        if (parsed.scheme != 'https' or not parsed.hostname or parsed.username
                or parsed.password or parsed.path or parsed.query or parsed.fragment):
            raise deny()
        self.origin, self.policy, self.verifier = origin, policy, verifier
        self.challenges, self.resolve, self.issue = challenges, resolve, issue

    async def login(self, *, origin, cookie, nonce, credential):
        if origin != self.origin:
            raise deny()
        self.challenges.check(cookie, nonce)
        claims = await self.verifier(credential, nonce)
        email = self.policy.admit_verified_claims(claims)
        # Atomic consumption precedes any profile creation or session issuance.
        self.challenges.check(cookie, nonce, consume=True)
        user = await self.resolve(claims['sub'], email)
        if getattr(user, 'google_sub', None) != claims['sub']:
            raise deny()
        self.policy.require_active_owner(user.email, user.is_active)
        return await self.issue(user)
