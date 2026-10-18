"""Offline public-key bundle adapter. Trusted fetch/provenance remains external.

Receives bounded bytes from an already verified root-owned snapshot. Never
fetches a token-selected key or URL. Compatible with GoogleVerifier's key
provider callable. This module performs no filesystem or network operations.
"""
import json
import math
from jwt.algorithms import RSAAlgorithm


class SnapshotDenied(Exception):
    pass


def _pairs(pairs):
    out = {}
    for k, v in pairs:
        if k in out: raise ValueError()
        out[k] = v
    return out


class OfflineGoogleKeys:
    def __init__(self, *, clock):
        self._clock = clock
        self._keys, self._fetched, self._expires = {}, 0, 0

    def replace(self, raw):
        # Clear before validation so a failed refresh never retains stale trust.
        self._keys, self._fetched, self._expires = {}, 0, 0
        try:
            if type(raw) is not bytes or not 0 < len(raw) <= 65536: raise ValueError()
            d = json.loads(raw, object_pairs_hook=_pairs)
            if set(d) != {'fetched_at', 'expires_at', 'keys'}: raise ValueError()
            now = self._clock()
            for n in [now, d['fetched_at'], d['expires_at']]:
                if type(n) not in (int, float) or not math.isfinite(n): raise ValueError()
            if not 0 < d['fetched_at'] <= now < d['expires_at'] <= d['fetched_at'] + 3600: raise ValueError()
            if type(d['keys']) is not list or not 1 <= len(d['keys']) <= 10: raise ValueError()
            keys = {}
            for k in d['keys']:
                if (type(k) is not dict or set(k) != {'kid','kty','alg','use','n','e'}
                    or type(k['kid']) is not str or not 1 <= len(k['kid']) <= 128
                    or k['kid'] in keys or k['kty'] != 'RSA' or k['alg'] != 'RS256'
                    or k['use'] != 'sig'): raise ValueError()
                key = RSAAlgorithm.from_jwk(k)
                if not 2048 <= key.key_size <= 8192: raise ValueError()
                keys[k['kid']] = key
            self._keys, self._fetched, self._expires = keys, d['fetched_at'], d['expires_at']
        except Exception:
            raise SnapshotDenied('UAT public key snapshot denied') from None

    def snapshot(self):
        try:
            now = self._clock()
            if (type(now) not in (int, float) or not math.isfinite(now)
                or not self._keys or not self._fetched <= now < self._expires): raise ValueError()
            return dict(self._keys), self._expires
        except Exception:
            raise SnapshotDenied('UAT public key snapshot unavailable') from None
