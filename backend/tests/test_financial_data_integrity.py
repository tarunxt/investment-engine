from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.domains.auth.models import UserRole
from app.domains.api_usage.router import _convert_usd_to_inr
from app.domains.fx_rates.service import (
    USD_INR_STALE_AFTER,
    assess_persisted_fx_rate,
)
from app.domains.fx_rates.tasks import parse_verified_usd_inr_payload
from app.domains.polymarket.access import (
    require_singleton_bullpen_runtime_access,
    user_can_access_singleton_bullpen_runtime,
)
from app.shared.portfolio_summary import build_persisted_portfolio_summary


def test_persisted_fx_rate_has_a_bounded_36_hour_valid_window():
    now = datetime(2026, 7, 26, 12, tzinfo=UTC)
    boundary = assess_persisted_fx_rate(
        value=Decimal("86.125"),
        source="verified-provider",
        as_of=now - USD_INR_STALE_AFTER,
        now=now,
    )
    expired = assess_persisted_fx_rate(
        value=Decimal("86.125"),
        source="verified-provider",
        as_of=now - USD_INR_STALE_AFTER - timedelta(seconds=1),
        now=now,
    )

    assert boundary.status == "valid"
    assert boundary.valid_value == 86.125
    assert expired.status == "stale"
    assert expired.value == 86.125
    assert expired.valid_value is None


def test_missing_fx_rate_is_unavailable_and_never_invents_a_value():
    assessment = assess_persisted_fx_rate(
        value=None,
        source=None,
        as_of=None,
    )

    assert assessment.status == "unavailable"
    assert assessment.value is None
    assert assessment.valid_value is None
    assert _convert_usd_to_inr(12.5, assessment.valid_value) is None


def test_cost_conversion_uses_only_the_verified_persisted_rate():
    assert _convert_usd_to_inr(2.0, 86.125) == 172.25
    assert _convert_usd_to_inr(2.0, None) is None


def test_fx_provider_payload_requires_rate_source_timestamp_and_sanity():
    now = datetime(2026, 7, 26, 12, tzinfo=UTC)
    payload = {
        "result": "success",
        "base_code": "USD",
        "time_last_update_unix": int((now - timedelta(hours=1)).timestamp()),
        "rates": {"INR": 86.25},
    }

    rate, as_of = parse_verified_usd_inr_payload(payload, now=now)
    assert rate == Decimal("86.25")
    assert as_of == now - timedelta(hours=1)

    with pytest.raises(ValueError):
        parse_verified_usd_inr_payload(
            {**payload, "rates": {"INR": 8300}},
            now=now,
        )
    with pytest.raises(ValueError):
        parse_verified_usd_inr_payload(
            {
                key: value
                for key, value in payload.items()
                if key != "time_last_update_unix"
            },
            now=now,
        )


@pytest.mark.anyio
async def test_singleton_bullpen_runtime_is_admin_only():
    admin = SimpleNamespace(role=UserRole.ADMIN)
    user = SimpleNamespace(role=UserRole.USER)

    assert user_can_access_singleton_bullpen_runtime(admin)
    assert not user_can_access_singleton_bullpen_runtime(user)
    assert await require_singleton_bullpen_runtime_access(admin) is admin
    with pytest.raises(HTTPException) as error:
        await require_singleton_bullpen_runtime_access(user)
    assert error.value.status_code == 403


def test_dashboard_holding_projection_is_bounded_and_persistable():
    holdings = [
        {
            "symbol": f"H{index}",
            "current_value": 1_000 - index,
            "invested_value": 900 - index,
            "total_pnl": 100,
            "total_pnl_percent": 10,
        }
        for index in range(10)
    ]

    top, invested = build_persisted_portfolio_summary(
        holdings,
        total_value=10_000,
    )

    assert len(top) == 4
    assert [item["symbol"] for item in top] == ["H0", "H1", "H2", "H3"]
    assert invested == sum(900 - index for index in range(10))


def test_missing_invested_values_remain_unavailable():
    _, invested = build_persisted_portfolio_summary(
        [{"symbol": "UNKNOWN", "current_value": 100}],
        total_value=100,
    )

    assert invested is None
