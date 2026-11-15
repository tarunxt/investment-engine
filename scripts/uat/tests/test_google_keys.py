import json
import sys
import unittest
from pathlib import Path
import httpx
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt.algorithms import RSAAlgorithm

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'backend'))
from app.uat.google_keys import GoogleKeyCache, CERT_URL
from app.uat.owner_policy import AdmissionDenied


class KeyTransportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        public = rsa.generate_private_key(public_exponent=65537, key_size=2048).public_key()
        cls.jwk = dict(json.loads(RSAAlgorithm.to_jwk(public)), kid='fixture', alg='RS256', use='sig')
        cls.jwk.pop('key_ops', None)  # Match Google's documented public JWKS shape.

    def setUp(self):
        self.now = 100
        self.calls = []
        self.status = 200
        self.data = json.dumps({'keys': [self.jwk]}).encode()
        self.headers = {'Cache-Control': 'public, max-age=300'}
        def handler(request):
            self.calls.append(request)
            return httpx.Response(self.status, content=self.data, headers=self.headers)
        self.client = httpx.Client(transport=httpx.MockTransport(handler))
        self.addCleanup(self.client.close)
        self.cache = GoogleKeyCache(self.client, clock=lambda: self.now)

    def test_fixed_url_bounded_timeout_expiry_and_no_implicit_fetch(self):
        with self.assertRaises(AdmissionDenied):
            self.cache.snapshot()
        self.assertEqual(self.calls, [])
        self.cache.refresh()
        self.assertEqual(str(self.calls[0].url), CERT_URL)
        self.assertEqual(self.calls[0].method, 'GET')
        self.assertEqual(self.calls[0].extensions['timeout']['read'], 3)
        self.assertNotIn('authorization', self.calls[0].headers)
        keys, expiry = self.cache.snapshot()
        self.assertEqual(expiry, 400)
        keys.clear()
        self.assertEqual(len(self.cache.snapshot()[0]), 1)
        self.now = 400
        with self.assertRaises(AdmissionDenied):
            self.cache.snapshot()
        self.assertEqual(len(self.calls), 1)

    def test_redirect_error_and_malformed_body_clear_cache(self):
        for status, data in [(302, self.data), (500, self.data), (200, b'not json'),
                             (200, b'x' * 65537), (200, b'{"keys":[]}')]:
            self.status, self.data = status, data
            with self.assertRaises(AdmissionDenied):
                self.cache.refresh()
            with self.assertRaises(AdmissionDenied):
                self.cache.snapshot()

    def test_invalid_key_shapes(self):
        for keys in [[self.jwk, self.jwk], [dict(self.jwk, alg='HS256')],
                     [dict(self.jwk, d='private-key-field')], [dict(self.jwk, use='enc')]]:
            self.data = json.dumps({'keys': keys}).encode()
            with self.assertRaises(AdmissionDenied):
                self.cache.refresh()

    def test_cache_control_age_and_failure_clear_previous_keys(self):
        self.cache.refresh()
        for headers in [{}, {'Cache-Control': 'no-store, max-age=300'},
                        {'Cache-Control': 'max-age=300', 'Age': '-1'},
                        {'Cache-Control': 'max-age=0'}, {'Cache-Control': 'max-age=300', 'Age': '301'},
                        {'Cache-Control': 'max-age=300', 'Content-Encoding': 'unsupported'}]:
            self.headers = headers
            with self.assertRaises(AdmissionDenied):
                self.cache.refresh()
            with self.assertRaises(AdmissionDenied):
                self.cache.snapshot()
