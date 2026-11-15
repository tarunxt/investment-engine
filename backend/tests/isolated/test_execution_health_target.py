import pytest

from execution_health_fixture import guarded_target


@pytest.mark.parametrize('raw,ack', [
    ('postgresql://test:test@remote.example/credx_audit_test_ci', 'disposable-local-only'),
    ('postgresql://test:test@localhost/production', 'disposable-local-only'),
    ('postgresql://test:test@localhost/credx_audit_test_ci', ''),
    ('postgresql://test:test@localhost/credx_audit_test_ci?host=remote.example', 'disposable-local-only'),
    ('sqlite:///credx_audit_test_ci', 'disposable-local-only'),
])
def test_rejects_non_disposable_targets(raw, ack):
    with pytest.raises(ValueError, match='disposable local'):
        guarded_target(raw, ack)


def test_accepts_explicit_existing_local_fixture():
    target = guarded_target('postgresql://test:test@127.0.0.1/credx_audit_test_ci',
                            'disposable-local-only')
    assert target.drivername == 'postgresql+asyncpg'
