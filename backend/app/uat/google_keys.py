"""Explicit certificate refresh via an injected HTTP client; no default client.

Only refresh() performs I/O. Tests inject httpx.MockTransport. Deployment must
provide an approved TLS-verifying client and isolated network access before use.
Never call refresh in response to a token-selected URL or unknown key identifier.
"""
import json
import re
import threading
import time

from jwt.algorithms import RSAAlgorithm
from .owner_policy import AdmissionDenied

CERT_URL = 'https://www.googleapis.com/oauth2/v3/certs'


class GoogleKeyCache:
    def __init__(self, client, *, clock=time.time):
        self._client, self._clock = client, clock
        self._keys, self._expires = {}, 0
        self._lock = threading.Lock()

    def refresh(self):
        try:
            with self._client.stream('GET', CERT_URL, timeout=3, follow_redirects=False,
                                     headers={'Accept-Encoding': 'identity'}) as result:
                if (result.status_code != 200 or str(result.url) != CERT_URL
                        or result.headers.get('content-encoding', 'identity') != 'identity'):
                    raise ValueError()
                controls = result.headers.get('cache-control', '').lower()
                age = re.search(r'(?:^|,)\s*max-age=(\d+)\s*(?:,|$)', controls)
                if not age or 'no-store' in controls or 'no-cache' in controls:
                    raise ValueError()
                response_age = int(result.headers.get('age', '0'))
                if response_age < 0:
                    raise ValueError()
                ttl = min(int(age[1]), 3600) - response_age
                if not 0 < ttl <= 3600:
                    raise ValueError()
                data = bytearray()
                for chunk in result.iter_bytes():
                    data.extend(chunk)
                    if len(data) > 65536:
                        raise ValueError()
                jwks = json.loads(data)['keys']
                if not isinstance(jwks, list) or not 1 <= len(jwks) <= 10:
                    raise ValueError()
                keys = {}
                for item in jwks:
                    if (not isinstance(item, dict) or not isinstance(item.get('kid'), str)
                            or not 1 <= len(item['kid']) <= 128 or item['kid'] in keys
                            or item.get('kty') != 'RSA' or item.get('alg') != 'RS256'
                            or item.get('use') != 'sig'
                            or set(item) - {'kid', 'kty', 'alg', 'use', 'n', 'e'}):
                        raise ValueError()
                    key = RSAAlgorithm.from_jwk(item)
                    if key.key_size < 2048:
                        raise ValueError()
                    keys[item['kid']] = key
                with self._lock:
                    self._keys, self._expires = keys, self._clock() + ttl
        except Exception:
            with self._lock:
                self._keys, self._expires = {}, 0
            raise AdmissionDenied('UAT certificate refresh denied') from None

    def snapshot(self):
        with self._lock:
            if not self._keys or self._clock() >= self._expires:
                raise AdmissionDenied('UAT certificate cache unavailable')
            return dict(self._keys), self._expires
