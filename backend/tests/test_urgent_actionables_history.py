import unittest
from datetime import datetime, timezone

from app.domains.portfolio_events.urgent_actionables import (
    HoldingContext,
    build_holding_context_index,
    build_urgent_action_history_entries,
    merge_urgent_actionables_history,
)


class UrgentActionablesHistoryTests(unittest.TestCase):
    def test_merge_keeps_historical_tags_per_stock_with_portfolio_context(self):
        first_report = {
            "tables": [
                {
                    "key": "urgent_actionables",
                    "title": "Table 10: Urgent Actionables / Immediate Risk-Control Actions",
                    "columns": [
                        "Exchange",
                        "Stock Symbol",
                        "Stock Name",
                        "Urgent Action Needed",
                        "Why Action Is Needed Now",
                        "Trigger / Condition",
                        "Exact Date / Deadline",
                        "Suggested Action Size",
                        "Priority",
                        "Time Sensitivity",
                    ],
                    "rows": [
                        {
                            "Exchange": "NSE",
                            "Stock Symbol": "DIXON",
                            "Stock Name": "Dixon Technologies (India) Ltd",
                            "Urgent Action Needed": "Trim",
                            "Why Action Is Needed Now": "High exposure with technical weakness",
                            "Trigger / Condition": "Below 11,400",
                            "Exact Date / Deadline": "Not found",
                            "Suggested Action Size": "Trim by 50%",
                            "Priority": "High",
                            "Time Sensitivity": "On Breakdown",
                        }
                    ],
                }
            ]
        }
        second_report = {
            "summary": {},
            "summary_items": [],
            "tables": [
                {
                    "key": "portfolio_risk_snapshot",
                    "title": "Table 1: Portfolio-Level Risk Snapshot",
                    "columns": ["Risk Factor"],
                    "rows": [{"Risk Factor": "Concentration"}],
                },
                {
                    "key": "urgent_actionables",
                    "title": "Table 10: Urgent Actionables / Immediate Risk-Control Actions",
                    "columns": [
                        "Exchange",
                        "Stock Symbol",
                        "Stock Name",
                        "Urgent Action Needed",
                        "Why Action Is Needed Now",
                        "Trigger / Condition",
                        "Exact Date / Deadline",
                        "Suggested Action Size",
                        "Priority",
                        "Time Sensitivity",
                    ],
                    "rows": [
                        {
                            "Exchange": "NSE",
                            "Stock Symbol": "DIXON",
                            "Stock Name": "Dixon Technologies (India) Ltd",
                            "Urgent Action Needed": "Urgent Sell",
                            "Why Action Is Needed Now": "Significant underperformance",
                            "Trigger / Condition": "Below support at 400",
                            "Exact Date / Deadline": "Not found",
                            "Suggested Action Size": "Sell All",
                            "Priority": "Very High",
                            "Time Sensitivity": "Immediate",
                        }
                    ],
                },
            ],
            "bottom_line": [],
            "raw_markdown": "",
        }

        holding_context_index = build_holding_context_index(
            [
                HoldingContext(
                    exchange="NSE",
                    stock_symbol="DIXON",
                    stock_name="Dixon Technologies (India) Ltd",
                    amount_invested=350000.0,
                    portfolio_percentage=7.61,
                )
            ]
        )

        entries = []
        entries.extend(
            build_urgent_action_history_entries(
                first_report,
                tagged_at=datetime(2026, 5, 29, 11, 10, tzinfo=timezone.utc),
                holding_context_index=holding_context_index,
            )
        )
        entries.extend(
            build_urgent_action_history_entries(
                second_report,
                tagged_at=datetime(2026, 5, 30, 16, 20, tzinfo=timezone.utc),
                holding_context_index=holding_context_index,
            )
        )

        merged = merge_urgent_actionables_history(
            second_report,
            entries=entries,
            currency_code="INR",
            portfolio_percentage_label="Percentage of India Portfolio",
        )

        assert merged is not None
        urgent_section = next(
            section for section in merged["tables"] if section["key"] == "urgent_actionables"
        )

        self.assertEqual(
            urgent_section["columns"][:4],
            [
                "Stock Symbol",
                "Stock Name",
                "Amount Invested",
                "Percentage of India Portfolio",
            ],
        )
        self.assertEqual(urgent_section["columns"][4], "Tagged At")
        self.assertEqual(len(urgent_section["rows"]), 1)
        self.assertEqual(
            urgent_section["rows"][0]["Stock Name"],
            "Dixon Technologies (India) Ltd",
        )
        self.assertEqual(urgent_section["rows"][0]["Amount Invested"], "INR 350,000.00")
        self.assertEqual(
            urgent_section["rows"][0]["Percentage of India Portfolio"],
            "7.61%",
        )
        self.assertEqual(
            urgent_section["rows"][0]["Tagged At"],
            "30 May 2026, 09:50 PM IST\n29 May 2026, 04:40 PM IST",
        )
        self.assertEqual(
            urgent_section["rows"][0]["Urgent Action Needed"],
            "Urgent Sell\nTrim",
        )
        self.assertEqual(
            urgent_section["rows"][0]["Why Action Is Needed Now"],
            "Significant underperformance\nHigh exposure with technical weakness",
        )
        self.assertEqual(
            urgent_section["rows"][0]["Trigger / Condition"],
            "Below support at 400\nBelow 11,400",
        )
        self.assertEqual(
            urgent_section["rows"][0]["Priority"],
            "Very High\nHigh",
        )
        self.assertEqual(urgent_section["rows"][0]["Exchange"], "NSE")
        self.assertEqual(urgent_section["rows"][0]["Stock Symbol"], "DIXON")

    def test_merge_collapses_shortened_company_name_rows_into_single_symbol_bucket(self):
        report = {
            "summary": {},
            "summary_items": [],
            "tables": [
                {
                    "key": "urgent_actionables",
                    "title": "Table 10: Urgent Actionables / Immediate Risk-Control Actions",
                    "columns": [
                        "Exchange",
                        "Stock Symbol",
                        "Stock Name",
                        "Urgent Action Needed",
                        "Why Action Is Needed Now",
                        "Trigger / Condition",
                        "Exact Date / Deadline",
                        "Suggested Action Size",
                        "Priority",
                        "Time Sensitivity",
                    ],
                    "rows": [
                        {
                            "Exchange": "NASDAQ",
                            "Stock Symbol": "NVDA",
                            "Stock Name": "NVIDIA Corporation",
                            "Urgent Action Needed": "Trim",
                            "Why Action Is Needed Now": "Extended after sharp rally",
                            "Trigger / Condition": "Failed breakout retest",
                            "Exact Date / Deadline": "Not found",
                            "Suggested Action Size": "Trim by 20%",
                            "Priority": "High",
                            "Time Sensitivity": "This week",
                        },
                        {
                            "Exchange": "",
                            "Stock Symbol": "",
                            "Stock Name": "NVIDIA",
                            "Urgent Action Needed": "Tighten Stop-Loss",
                            "Why Action Is Needed Now": "Momentum is cooling",
                            "Trigger / Condition": "Close below 20DMA",
                            "Exact Date / Deadline": "Not found",
                            "Suggested Action Size": "Trail 8%",
                            "Priority": "High",
                            "Time Sensitivity": "Immediate",
                        },
                        {
                            "Exchange": "NASDAQ",
                            "Stock Symbol": "MU",
                            "Stock Name": "Micron Technology Inc",
                            "Urgent Action Needed": "Trim",
                            "Why Action Is Needed Now": "Semis are crowded",
                            "Trigger / Condition": "Loss of near-term support",
                            "Exact Date / Deadline": "Not found",
                            "Suggested Action Size": "Trim by 15%",
                            "Priority": "Medium",
                            "Time Sensitivity": "This week",
                        },
                        {
                            "Exchange": "",
                            "Stock Symbol": "",
                            "Stock Name": "Micron",
                            "Urgent Action Needed": "Avoid Fresh Buying",
                            "Why Action Is Needed Now": "Volatility is rising",
                            "Trigger / Condition": "Wait for post-earnings setup",
                            "Exact Date / Deadline": "Not found",
                            "Suggested Action Size": "No new adds",
                            "Priority": "Medium",
                            "Time Sensitivity": "Immediate",
                        },
                    ],
                }
            ],
            "bottom_line": [],
            "raw_markdown": "",
        }

        holding_context_index = build_holding_context_index(
            [
                HoldingContext(
                    exchange="NASDAQ",
                    stock_symbol="NVDA",
                    stock_name="NVIDIA Corporation",
                    amount_invested=12500.0,
                    portfolio_percentage=55.0,
                ),
                HoldingContext(
                    exchange="NASDAQ",
                    stock_symbol="MU",
                    stock_name="Micron Technology Inc",
                    amount_invested=4500.0,
                    portfolio_percentage=20.0,
                ),
            ]
        )

        entries = build_urgent_action_history_entries(
            report,
            tagged_at=datetime(2026, 5, 30, 12, 0, tzinfo=timezone.utc),
            holding_context_index=holding_context_index,
        )

        merged = merge_urgent_actionables_history(
            report,
            entries=entries,
            currency_code="USD",
            portfolio_percentage_label="Percentage of US Portfolio",
        )

        assert merged is not None
        urgent_section = next(
            section for section in merged["tables"] if section["key"] == "urgent_actionables"
        )

        self.assertEqual(len(urgent_section["rows"]), 2)

        rows_by_symbol = {
            row["Stock Symbol"]: row
            for row in urgent_section["rows"]
        }

        self.assertEqual(set(rows_by_symbol.keys()), {"MU", "NVDA"})
        self.assertEqual(
            rows_by_symbol["NVDA"]["Urgent Action Needed"],
            "Tighten Stop-Loss\nTrim",
        )
        self.assertEqual(
            rows_by_symbol["MU"]["Urgent Action Needed"],
            "Avoid Fresh Buying\nTrim",
        )
        self.assertEqual(rows_by_symbol["NVDA"]["Exchange"], "NASDAQ")
        self.assertEqual(rows_by_symbol["MU"]["Exchange"], "NASDAQ")


if __name__ == "__main__":
    unittest.main()
