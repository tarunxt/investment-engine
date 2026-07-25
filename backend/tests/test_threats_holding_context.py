import unittest
from types import SimpleNamespace

from app.domains.indmoney_us.threats_router import (
    _build_holding_context_index as build_indmoney_context_index,
)
from app.domains.zerodha.threats import (
    parse_zerodha_threat_urgent_actionables,
)
from app.domains.zerodha.threats_router import (
    _build_holding_context_index as build_zerodha_context_index,
)


class ThreatHoldingContextTests(unittest.TestCase):
    def test_history_parser_materializes_only_urgent_actionables(self):
        report = parse_zerodha_threat_urgent_actionables(
            """
## Summary

- Main portfolio risk in one sentence: Test summary

## Table 1: Portfolio-Level Risk Snapshot

| Risk Factor | Current Situation | Why It Matters | Severity |
|---|---|---|---|
| Test | Test | Test | Low |

## Table 10: Urgent Actionables / Immediate Risk-Control Actions

| Exchange | Stock Symbol | Stock Name | Urgent Action Needed |
|---|---|---|---|
| NSE | SBIN | State Bank of India | Trim |

## Bottom Line

| Point | Conclusion |
|---|---|
| Test | Test |
"""
        )

        self.assertIsNotNone(report)
        assert report is not None
        self.assertEqual(len(report["tables"]), 1)
        self.assertEqual(report["tables"][0]["key"], "urgent_actionables")
        self.assertEqual(report["tables"][0]["rows"][0]["Stock Symbol"], "SBIN")
        self.assertNotIn("raw_markdown", report)

    def test_indmoney_urgent_history_uses_invested_amount_basis_for_portfolio_percentage(self):
        snapshot = SimpleNamespace(
            current_value=2000.0,
            holdings=[
                {
                    "symbol": "MU",
                    "company_name": "Micron Technology Inc",
                    "invested_value": 700.0,
                    "current_value": 1200.0,
                    "portfolio_weight_percent": 60.0,
                },
                {
                    "symbol": "NVDA",
                    "company_name": "NVIDIA Corporation",
                    "invested_value": 1400.0,
                    "current_value": 800.0,
                    "portfolio_weight_percent": 40.0,
                },
            ],
        )

        context_index = build_indmoney_context_index(snapshot)

        self.assertEqual(context_index["symbol:mu"].amount_invested, 700.0)
        self.assertAlmostEqual(context_index["symbol:mu"].portfolio_percentage or 0.0, 33.33, places=2)
        self.assertAlmostEqual(
            context_index["symbol:nvda"].portfolio_percentage or 0.0,
            66.67,
            places=2,
        )

    def test_indmoney_urgent_history_falls_back_to_snapshot_weight_when_invested_amounts_missing(self):
        snapshot = SimpleNamespace(
            current_value=2000.0,
            holdings=[
                {
                    "symbol": "MU",
                    "company_name": "Micron Technology Inc",
                    "invested_value": None,
                    "current_value": 1200.0,
                    "portfolio_weight_percent": 60.0,
                },
                {
                    "symbol": "NVDA",
                    "company_name": "NVIDIA Corporation",
                    "invested_value": None,
                    "current_value": 800.0,
                    "portfolio_weight_percent": 40.0,
                },
            ],
        )

        context_index = build_indmoney_context_index(snapshot)

        self.assertEqual(context_index["symbol:mu"].portfolio_percentage, 60.0)
        self.assertEqual(context_index["symbol:nvda"].portfolio_percentage, 40.0)

    def test_zerodha_urgent_history_uses_invested_amount_basis_for_portfolio_percentage(self):
        snapshot = SimpleNamespace(
            holdings_market_value=2000.0,
            holdings=[
                {
                    "exchange": "NSE",
                    "tradingsymbol": "SBIN",
                    "invested_value": 900.0,
                    "market_value": 1500.0,
                },
                {
                    "exchange": "NSE",
                    "tradingsymbol": "INFY",
                    "invested_value": 1100.0,
                    "market_value": 500.0,
                },
            ],
        )

        context_index = build_zerodha_context_index(snapshot)

        self.assertAlmostEqual(
            context_index["symbol:sbin"].portfolio_percentage or 0.0,
            45.0,
            places=2,
        )
        self.assertAlmostEqual(
            context_index["symbol:infy"].portfolio_percentage or 0.0,
            55.0,
            places=2,
        )

    def test_zerodha_urgent_history_falls_back_to_market_value_when_invested_amounts_missing(self):
        snapshot = SimpleNamespace(
            holdings_market_value=2000.0,
            holdings=[
                {
                    "exchange": "NSE",
                    "tradingsymbol": "SBIN",
                    "invested_value": None,
                    "market_value": 1500.0,
                },
                {
                    "exchange": "NSE",
                    "tradingsymbol": "INFY",
                    "invested_value": None,
                    "market_value": 500.0,
                },
            ],
        )

        context_index = build_zerodha_context_index(snapshot)

        self.assertEqual(context_index["symbol:sbin"].portfolio_percentage, 75.0)
        self.assertEqual(context_index["symbol:infy"].portfolio_percentage, 25.0)


if __name__ == "__main__":
    unittest.main()
