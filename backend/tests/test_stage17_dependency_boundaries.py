"""Small synthetic regressions for audited HTTP parser and crypto upgrades."""
import pytest
from starlette.datastructures import URL
from starlette.requests import Request
from starlette.exceptions import HTTPException

from app.domains.connections.crypto import ConnectionKeyring, ConnectionFault


@pytest.mark.parametrize('host', [b'evil.example/injected', b'evil.example?query', b'evil.example#fragment', b'evil.example@other.example'])
def test_untrusted_host_cannot_rewrite_request_path(host):
    url = URL(scope={'type': 'http', 'scheme': 'https', 'server': ('synthetic.example', 443),
                     'path': '/expected', 'query_string': b'', 'headers': [(b'host', host)]})
    assert url.path == '/expected'
    assert url.hostname == 'synthetic.example'


@pytest.mark.asyncio
@pytest.mark.parametrize('body,limits', [(b'a=1&b=2&c=3', {'max_fields': 2}),
                                        (b'long=value', {'max_part_size': 4})])
async def test_urlencoded_forms_obey_explicit_resource_limits(body, limits):
    async def receive():
        return {'type': 'http.request', 'body': body, 'more_body': False}
    request = Request({'type': 'http', 'method': 'POST', 'path': '/synthetic', 'app': object(),
                       'headers': [(b'content-type', b'application/x-www-form-urlencoded')]}, receive)
    with pytest.raises(HTTPException) as error:
        await request.form(**limits)
    assert error.value.status_code == 400


def test_crypto_upgrade_reads_frozen_previous_version_ciphertext_without_fallback():
    # Public synthetic fixture generated with cryptography 48.0.0, not a credential.
    keyring = ConnectionKeyring({1: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='})
    ciphertext = ('gAAAAABlU_EAYT5IiM59y_heSlddO5jY5Lh8tXiS1lkHAEo386FueY6vtUOHj_CHTcOBaafnCbPRiBWfjaRZ02K9F6ARlH1YY41QNx1272IzNQ-0bhHrthtwwz9z3CNFsoStrloeQ1TQ')
    assert keyring.open(ciphertext, 1) == {'binding_id': 'synthetic-fixture', 'owner_id': 1}
    with pytest.raises(ConnectionFault) as error:
        keyring.open(ciphertext, 2)
    assert error.value.code == 'ENCRYPTION_KEY_VERSION_UNAVAILABLE'
