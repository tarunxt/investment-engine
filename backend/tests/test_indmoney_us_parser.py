from datetime import datetime, timezone

from app.domains.indmoney_us.service import IndMoneyUsPortfolioService


RAW_SNAPSHOT = """
wallet
$1,540.73
wallet
Add money
Current Value
$5,483.39
toggle-visibility
Invested Value
$4,119.32
1D Returns
+$121.83 (▲2.27%)
Total Returns
+$1,364.07 (▲33.11%)
Current Holdings (3)
Stock Name
Market Price
Invested (Qty/Price)
Current value
Total PnL
Micron Technology Inc
Micron Technology Inc
MU
$971.00
▲5.14%
$708.80
1.418367913 Qty
$499.73 Avg.
$1,377.24
+$668.44
▲94.31%
Advanced Micro Devices Inc
Advanced Micro Devices Inc
AMD
$516.10
▲0.38%
$548.40
1.294617161 Qty
$423.60 Avg.
$668.15
+$119.75
▲21.84%
Microsoft Corporation
Microsoft Corporation
MSFT
$450.24
▲5.45%
$58.83
0.141248499 Qty
$416.50 Avg.
$63.60
+$4.77
▲8.10%
Trading and brokerage services provided by
"""

COMPANY_NAME_SNAPSHOT = """
Current Value
$254.76
Invested Value
$219.35
Total Returns
+$35.41 (▲16.14%)
Current Holdings (2)
Stock Name
Market Price
Invested (Qty/Price)
Current value
Total PnL
Microsoft Corporation
Microsoft Corporation
MSFT
$450.24
▲5.45%
$58.83
0.141248499 Qty
$416.50 Avg.
$63.60
+$4.77
▲8.10%
General Motors Company
General Motors Company
GM
$83.24
▲1.32%
$69.79
0.880075662 Qty
$79.30 Avg.
$73.26
+$3.47
▲4.97%
Trading and brokerage services provided by
"""


def test_parse_snapshot_extracts_summary_and_holdings():
    service = IndMoneyUsPortfolioService()

    parsed = service.parse_snapshot(
        RAW_SNAPSHOT,
        captured_at=datetime(2026, 5, 30, 10, 45, tzinfo=timezone.utc),
    )

    assert parsed["snapshot_date"].isoformat() == "2026-05-30"
    assert parsed["wallet_balance"] == 1540.73
    assert parsed["current_value"] == 5483.39
    assert parsed["invested_value"] == 4119.32
    assert parsed["day_return_value"] == 121.83
    assert parsed["day_return_percent"] == 2.27
    assert parsed["total_return_value"] == 1364.07
    assert parsed["total_return_percent"] == 33.11
    assert parsed["reported_holdings_count"] == 3
    assert parsed["holdings_count"] == 3
    assert parsed["holdings"][0]["symbol"] == "MU"
    assert parsed["holdings"][0]["portfolio_weight_percent"] > parsed["holdings"][1]["portfolio_weight_percent"]


def test_parse_snapshot_reconciles_warning_when_totals_do_not_match():
    service = IndMoneyUsPortfolioService()

    parsed = service.parse_snapshot(RAW_SNAPSHOT)
    detail = service.serialize_detail(type("Snapshot", (), {
        "id": 1,
        "snapshot_date": parsed["snapshot_date"],
        "captured_at": parsed["captured_at"],
        "source": parsed["source"],
        "parse_status": parsed["parse_status"],
        "parse_warnings": parsed["parse_warnings"],
        "holdings_count": parsed["holdings_count"],
        "reported_holdings_count": parsed["reported_holdings_count"],
        "indices_count": parsed["indices_count"],
        "wallet_balance": parsed["wallet_balance"],
        "current_value": parsed["current_value"],
        "invested_value": parsed["invested_value"],
        "day_return_value": parsed["day_return_value"],
        "day_return_percent": parsed["day_return_percent"],
        "total_return_value": parsed["total_return_value"],
        "total_return_percent": parsed["total_return_percent"],
        "raw_text": parsed["raw_text"],
        "market_indices": parsed["market_indices"],
        "holdings": parsed["holdings"],
    })())

    reconciliation = detail["derived"]["reconciliation"]
    current_value_row = next(row for row in reconciliation if row["label"] == "Current Value")

    assert current_value_row["summary_value"] == 5483.39
    assert current_value_row["parsed_value"] == 2108.99
    assert parsed["parse_status"] == "partial"
    assert any("does not fully reconcile" in warning for warning in parsed["parse_warnings"])


def test_parse_snapshot_does_not_treat_company_name_as_footer():
    service = IndMoneyUsPortfolioService()

    parsed = service.parse_snapshot(COMPANY_NAME_SNAPSHOT)

    assert parsed["holdings_count"] == 2
    assert parsed["reported_holdings_count"] == 2
    assert [holding["symbol"] for holding in parsed["holdings"]] == ["GM", "MSFT"]
    assert parsed["parse_status"] == "partial"
    assert any("does not fully reconcile" in warning for warning in parsed["parse_warnings"])
