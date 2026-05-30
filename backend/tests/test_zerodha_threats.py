import os
import unittest
from datetime import date, datetime, timezone
from types import SimpleNamespace

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

from app.domains.zerodha.threats import (
    THREAT_JOB_MARKER,
    THREAT_WEB_SEARCH_MARKER,
    build_zerodha_threat_prompt,
    extract_threat_prompt_metadata,
    parse_zerodha_threat_report,
)


class ZerodhaThreatsTests(unittest.TestCase):
    def test_build_prompt_embeds_metadata_and_holdings(self):
        snapshot = SimpleNamespace(
            snapshot_date=date(2026, 5, 30),
            captured_at=datetime(2026, 5, 30, 9, 15, tzinfo=timezone.utc),
            holdings_count=2,
            net_positions_count=1,
            holdings_market_value=250000.0,
            holdings_pnl=18500.0,
            holdings_day_change_value=2450.0,
            positions_pnl=1200.0,
            positions_m2m=350.0,
            holdings=[
                {
                    "tradingsymbol": "RELIANCE",
                    "exchange": "NSE",
                    "quantity": 10,
                    "average_price": 2800.0,
                    "last_price": 3010.0,
                    "invested_value": 28000.0,
                    "market_value": 30100.0,
                    "pnl": 2100.0,
                    "day_change_percentage": 1.25,
                    "day_change_value": 370.0,
                },
                {
                    "tradingsymbol": "HAL",
                    "exchange": "NSE",
                    "quantity": 15,
                    "average_price": 4700.0,
                    "last_price": 5120.0,
                    "invested_value": 70500.0,
                    "market_value": 76800.0,
                    "pnl": 6300.0,
                    "day_change_percentage": 0.95,
                    "day_change_value": 720.0,
                },
            ],
            net_positions=[
                {
                    "tradingsymbol": "TCS",
                    "exchange": "NSE",
                    "product": "MIS",
                    "quantity": 25,
                    "average_price": 3900.0,
                    "last_price": 3955.0,
                    "value": 98875.0,
                    "pnl": 1375.0,
                    "m2m": 650.0,
                }
            ],
        )

        prompt = build_zerodha_threat_prompt(snapshot)

        self.assertIn(THREAT_JOB_MARKER, prompt)
        self.assertIn(THREAT_WEB_SEARCH_MARKER, prompt)
        self.assertIn("[THREAT_SNAPSHOT_DATE=2026-05-30]", prompt)
        self.assertIn("RELIANCE", prompt)
        self.assertIn("HAL", prompt)
        self.assertIn("TCS", prompt)
        self.assertIn("Table 10: Urgent Actionables / Immediate Risk-Control Actions", prompt)
        self.assertIn("For every table row about a single stock, always include Exchange, Stock Symbol, and Stock Name.", prompt)
        self.assertIn("Exact Date / Timing", prompt)
        self.assertIn("Exact Date / Deadline", prompt)
        self.assertIn('do not write only "Before Earnings" or "Soon"', prompt)

        metadata = extract_threat_prompt_metadata(prompt)
        self.assertEqual(metadata.snapshot_date, date(2026, 5, 30))
        self.assertEqual(metadata.captured_at, datetime(2026, 5, 30, 9, 15, tzinfo=timezone.utc))

    def test_parse_report_extracts_summary_tables_and_bottom_line(self):
        markdown = """
## Summary
- Main portfolio risk in one sentence: Defence-heavy concentration is the main swing risk.
- Biggest weakness: Too many names are extended after sharp moves.
- Biggest near-term threat: A midcap momentum unwind over the next few sessions.
- Biggest position-size risk: HAL is large enough that a reversal will hit the book hard.
- Biggest profit-protection candidate: RELIANCE after a stretched breakout.
- Biggest weak/drag position: TCS because momentum is lagging peers.

## Table 1: Portfolio-Level Risk Snapshot
| Risk Factor | Current Situation | Why It Matters | Severity |
|---|---|---|---|
| Sector concentration | Defence and heavy industry are overweight | Correlated profit booking could hit multiple names at once | High |

## Table 10: Urgent Actionables / Immediate Risk-Control Actions
| Exchange | Stock Symbol | Stock Name | Urgent Action Needed | Why Action Is Needed Now | Trigger / Condition | Exact Date / Deadline | Suggested Action Size | Priority | Time Sensitivity |
|---|---|---|---|---|---|---|---|---|---|
| NSE | HAL | Hindustan Aeronautics Limited | Tighten Stop-Loss | Position is extended after a vertical move | Close below 20-DMA | 14 Aug 2026 | 25% trim on trigger | High | Before earnings on 14 Aug 2026 |

## Bottom Line
| Point | Conclusion |
|---|---|
| The biggest short-term danger is | A crowded defence unwind. |
| Stocks to protect gains in | HAL, RELIANCE |
""".strip()

        parsed = parse_zerodha_threat_report(markdown)

        assert parsed is not None
        self.assertEqual(
            parsed["summary"]["main_portfolio_risk"],
            "Defence-heavy concentration is the main swing risk.",
        )
        self.assertEqual(len(parsed["tables"]), 2)
        self.assertEqual(parsed["tables"][0]["title"], "Table 1: Portfolio-Level Risk Snapshot")
        self.assertEqual(parsed["tables"][1]["key"], "urgent_actionables")
        self.assertEqual(parsed["tables"][1]["rows"][0]["Exchange"], "NSE")
        self.assertEqual(parsed["tables"][1]["rows"][0]["Stock Symbol"], "HAL")
        self.assertEqual(parsed["tables"][1]["rows"][0]["Stock Name"], "Hindustan Aeronautics Limited")
        self.assertEqual(parsed["tables"][1]["rows"][0]["Exact Date / Deadline"], "14 Aug 2026")
        self.assertEqual(parsed["bottom_line"][0]["label"], "The biggest short-term danger is")
        self.assertEqual(parsed["bottom_line"][1]["value"], "HAL, RELIANCE")


if __name__ == "__main__":
    unittest.main()
