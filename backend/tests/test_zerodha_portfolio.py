from datetime import datetime, timezone

from app.domains.zerodha.portfolio import build_portfolio_snapshot


def test_build_portfolio_snapshot_computes_totals_and_ist_date():
    captured_at = datetime(2026, 5, 30, 10, 45, tzinfo=timezone.utc)
    holdings = [
        {
            "tradingsymbol": "SBIN",
            "exchange": "NSE",
            "quantity": 10,
            "average_price": 700,
            "last_price": 720,
            "pnl": 200,
            "day_change": 5,
            "day_change_percentage": 0.7,
        },
        {
            "tradingsymbol": "INFY",
            "exchange": "NSE",
            "quantity": 5,
            "average_price": 1500,
            "last_price": 1490,
            "pnl": -50,
            "day_change": -3,
            "day_change_percentage": -0.2,
        },
    ]
    positions = {
        "net": [
            {
                "tradingsymbol": "NIFTY26JUNFUT",
                "exchange": "NFO",
                "product": "NRML",
                "quantity": 1,
                "value": 250000,
                "pnl": 1200,
                "m2m": 900,
                "last_price": 25100,
                "average_price": 24980,
            }
        ],
        "day": [
            {
                "tradingsymbol": "NIFTY26JUNFUT",
                "exchange": "NFO",
                "day_buy_quantity": 1,
                "day_sell_quantity": 0,
                "realised": 0,
                "unrealised": 1200,
                "pnl": 1200,
            }
        ],
    }

    snapshot = build_portfolio_snapshot(
        holdings,
        positions,
        captured_at=captured_at,
        source="scheduled",
    )

    assert snapshot["snapshot_date"].isoformat() == "2026-05-30"
    assert snapshot["source"] == "scheduled"
    assert snapshot["holdings_count"] == 2
    assert snapshot["net_positions_count"] == 1
    assert snapshot["day_positions_count"] == 1
    assert snapshot["holdings_market_value"] == 14650.0
    assert snapshot["holdings_pnl"] == 150.0
    assert snapshot["holdings_day_change_value"] == 35.0
    assert snapshot["positions_pnl"] == 1200.0
    assert snapshot["positions_m2m"] == 900.0
    assert snapshot["holdings"][0]["tradingsymbol"] == "INFY"
    assert snapshot["holdings"][0]["market_value"] >= snapshot["holdings"][1]["market_value"]
