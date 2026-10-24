"""Offline UAT JWT verification; no key loader, signer, or live entrypoint.

The deployment must inject a separately provisioned UAT-only random key through
the approved secret mechanism. Length validation cannot prove key provenance or
entropy. Production keys must never be passed here. Requires PyJWT 2.15.1.
"""
import jwt

from .owner_policy import AdmissionDenied, OWNER_EMAIL


class SessionVerifier:
    def __init__(self, *, environment, key):
        if environment != 'uat' or not isinstance(key, bytes) or len(key) < 32:
            raise AdmissionDenied('Invalid UAT verifier configuration')
        self._key = key

    async def __call__(self, token, token_type):
        try:
            if (token_type not in ('access', 'refresh') or
                    not isinstance(token, str) or not 1 <= len(token) <= 16384):
                raise ValueError()
            result = jwt.decode_complete(
                token, self._key, algorithms=['HS256'],
                issuer='credx-uat', audience='credx-uat-api', leeway=0,
                options={'require': ['exp', 'iat', 'nbf', 'iss', 'aud',
                                     'sub', 'email', 'type', 'jti'],
                         'strict_aud': True},
            )
            header, claims = result['header'], result['payload']
            # Reject key URLs and extensions; there is no key selection or I/O.
            if set(header) != {'alg', 'typ'} or header['typ'] != 'JWT':
                raise ValueError()
            if (claims['iss'] != 'credx-uat' or claims['aud'] != 'credx-uat-api'
                    or claims['type'] != token_type or claims['email'] != OWNER_EMAIL
                    or not isinstance(claims['sub'], str) or not claims['sub'].strip()
                    or not isinstance(claims['jti'], str) or not 1 <= len(claims['jti']) <= 128):
                raise ValueError()
            if any(type(claims[k]) is not int for k in ('iat', 'nbf', 'exp')):
                raise ValueError()
            max_age = 900 if token_type == 'access' else 86400
            if not claims['iat'] <= claims['nbf'] < claims['exp'] <= claims['iat'] + max_age:
                raise ValueError()
            return claims
        except (jwt.PyJWTError, ValueError, TypeError, KeyError):
            raise AdmissionDenied('UAT session denied') from None
