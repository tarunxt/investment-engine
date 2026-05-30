import os
import unittest
from datetime import date, datetime, timezone
from types import SimpleNamespace

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

from app.domains.indmoney_us.threats import (  # noqa: E402
    THREAT_JOB_MARKER,
    build_indmoney_us_threat_prompt,
    extract_indmoney_us_threat_prompt_metadata,
    parse_indmoney_us_threat_report,
)


class IndMoneyUsThreatsTests(unittest.TestCase):
    def test_build_prompt_embeds_snapshot_metadata_holdings_and_indices(self):
        snapshot = SimpleNamespace(
            id=7,
            snapshot_date=date(2026, 5, 30),
            captured_at=datetime(2026, 5, 30, 9, 15, tzinfo=timezone.utc),
            source="manual_paste",
            parse_status="parsed",
            parse_warnings=[],
            reported_holdings_count=2,
            holdings_count=2,
            wallet_balance=1540.73,
            current_value=5483.39,
            invested_value=4119.32,
            day_return_value=121.83,
            day_return_percent=2.27,
            total_return_value=1364.07,
            total_return_percent=33.11,
            market_indices=[
                {
                    "name": "Nasdaq 100",
                    "value": 30340.52,
                    "change_value": 117.87,
                    "change_percent": 0.39,
                    "raw_change_text": "117.87 (▲0.39%)",
                }
            ],
            holdings=[
                {
                    "company_name": "NVIDIA Corporation",
                    "symbol": "NVDA",
                    "quantity": 5.220667443,
                    "average_price": 203.77,
                    "market_price": 211.14,
                    "invested_value": 1063.80,
                    "current_value": 1102.29,
                    "total_pnl": 38.49,
                    "total_pnl_percent": 3.62,
                    "price_vs_average_percent": 3.62,
                    "market_change_percent": 1.45,
                },
                {
                    "company_name": "Advanced Micro Devices Inc",
                    "symbol": "AMD",
                    "quantity": 1.294617161,
                    "average_price": 423.60,
                    "market_price": 516.10,
                    "invested_value": 548.40,
                    "current_value": 668.15,
                    "total_pnl": 119.75,
                    "total_pnl_percent": 21.84,
                    "price_vs_average_percent": 21.84,
                    "market_change_percent": 0.38,
                },
            ],
        )

        prompt = build_indmoney_us_threat_prompt(snapshot)

        self.assertIn(THREAT_JOB_MARKER, prompt)
        self.assertIn("[INDMONEY_THREAT_SNAPSHOT_ID=7]", prompt)
        self.assertIn("[THREAT_SNAPSHOT_DATE=2026-05-30]", prompt)
        self.assertIn("Nasdaq 100", prompt)
        self.assertIn("NVIDIA Corporation", prompt)
        self.assertIn("AMD", prompt)
        self.assertIn("Table 10: Urgent Actionables / Immediate Risk-Control Actions", prompt)
        self.assertIn("Exact Date / Timing", prompt)
        self.assertIn("Exact Date / Deadline", prompt)
        self.assertIn('do not write only "Before Earnings" or "Soon"', prompt)

        metadata = extract_indmoney_us_threat_prompt_metadata(prompt)
        self.assertEqual(metadata.snapshot_id, 7)
        self.assertEqual(metadata.snapshot_date, date(2026, 5, 30))
        self.assertEqual(metadata.captured_at, datetime(2026, 5, 30, 9, 15, tzinfo=timezone.utc))

    def test_parse_report_reuses_markdown_table_and_summary_parser(self):
        markdown = """
## Summary
- Main portfolio risk in one sentence: AI concentration is the key swing risk.
- Biggest weakness: Several winners are now crowded and extended.
- Biggest near-term threat: A Nasdaq-led growth de-rating.
- Biggest position-size risk: NVDA is large enough to dominate downside.
- Biggest profit-protection candidate: MU after a sharp run.
- Biggest weak/drag position: GM due to weak momentum.

## Table 10: Urgent Actionables / Immediate Risk-Control Actions
| Stock | Urgent Action Needed | Why Action Is Needed Now | Trigger / Condition | Exact Date / Deadline | Suggested Action Size | Priority | Time Sensitivity |
|---|---|---|---|---|---|---|---|
| MU | Tighten Stop-Loss | Gains are large and semis are extended | Close below support | 14 Aug 2026 | 20% trim on trigger | High | Before earnings on 14 Aug 2026 |

## Bottom Line
| Point | Conclusion |
|---|---|
| Stocks to protect gains in | MU, AMD |
""".strip()

        parsed = parse_indmoney_us_threat_report(markdown)

        assert parsed is not None
        self.assertEqual(parsed["summary"]["main_portfolio_risk"], "AI concentration is the key swing risk.")
        self.assertEqual(parsed["tables"][0]["key"], "urgent_actionables")
        self.assertEqual(parsed["tables"][0]["rows"][0]["Stock"], "MU")
        self.assertEqual(parsed["tables"][0]["rows"][0]["Exact Date / Deadline"], "14 Aug 2026")
        self.assertEqual(parsed["bottom_line"][0]["value"], "MU, AMD")


if __name__ == "__main__":
    unittest.main()
