import app.models
import pytest
from app.infrastructure.database.base import Base
from app.domains.public_service.recovery_exclusions import EXCLUDED,disposition
from app.domains.public_service.recoverable_privacy import restorable


@pytest.mark.parametrize('name',sorted(EXCLUDED))
def test_source_legacy_financial_operator_and_credential_stores_fail_closed(name):
    assert name in Base.metadata.tables
    assert restorable(name) is False
    result=disposition(name)
    assert result['restore_allowed'] is False and result['live_effects_allowed'] is False
    assert result['reason'] and result['complete_account_erasure'] is False
