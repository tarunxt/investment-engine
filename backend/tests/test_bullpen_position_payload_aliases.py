"""Regression coverage for the live Bullpen/Polymarket position payload."""

from app.domains.polymarket_auto_live.console_profile import (
    parse_console_wallet_positions_payload,
)


def test_standard_polymarket_payload_aliases_remain_active_positions() -> None:
    positions = parse_console_wallet_positions_payload(
        {
            "positions": [
                {
                    "conditionId": "0x" + ("1" * 64),
                    "title": "Iran full airspace closure by August 15, 2099?",
                    "slug": "iran-full-airspace-closure-by-august-15-2099",
                    "eventSlug": "iran-full-airspace-closure-by-august-15-2099",
                    "outcome": "No",
                    "size": "3.017",
                    "avgPrice": "0.60",
                    "initialValue": "1.81",
                    "curPrice": "0.855",
                    "currentValue": "2.58",
                    "cashPnl": "0.77",
                    "percentPnl": "42.5",
                    "endDate": "2099-08-15",
                    "redeemable": False,
                }
            ]
        }
    )

    assert len(positions) == 1
    position = positions[0]
    assert position.shares == 3.017
    assert position.average_price_cents == 60.0
    assert position.exposure_usd == 1.81
    assert position.current_price_cents == 85.5
    assert position.current_value_usd == 2.58
    assert position.classification == "active"
