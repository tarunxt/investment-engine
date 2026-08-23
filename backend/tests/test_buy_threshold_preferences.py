import pytest
from pydantic import ValidationError

from app.domains.auth.schemas import UpdateProfileRequest


def test_buy_threshold_preferences_accept_portfolio_specific_values():
    request = UpdateProfileRequest(
        zerodha_buy_threshold=2.25,
        indmoney_buy_threshold=1.75,
    )

    assert request.zerodha_buy_threshold == 2.25
    assert request.indmoney_buy_threshold == 1.75


@pytest.mark.parametrize("field", ["zerodha_buy_threshold", "indmoney_buy_threshold"])
def test_buy_threshold_preferences_reject_values_outside_supported_range(field):
    with pytest.raises(ValidationError):
        UpdateProfileRequest(**{field: 101})
