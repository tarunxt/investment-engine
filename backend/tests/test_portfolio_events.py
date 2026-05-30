import os
import unittest
from datetime import date, datetime, timezone
from types import SimpleNamespace

from pydantic import ValidationError

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

from app.domains.indmoney_us.events import build_indmoney_us_events_prompt  # noqa: E402
from app.domains.portfolio_events.common import (  # noqa: E402
    EVENT_TABLE_COLUMNS,
    ensure_event_table_covers_prompt_holdings,
    parse_event_calendar_table,
)
from app.domains.portfolio_events.schemas import PortfolioEventRunRequest  # noqa: E402
from app.domains.zerodha.events import build_zerodha_events_prompt  # noqa: E402


class PortfolioEventsTests(unittest.TestCase):
    def test_parse_event_calendar_table_normalizes_columns_and_outcome(self):
        markdown = """
Intro line that should be ignored.

| Date | Exchange | Stock Symbol | Stock Name | Event | Why it may matter | Expected Outcome | Status / Source |
| ---- | -------- | ------------ | ---------- | ----- | ----------------- | ---------------- | --------------- |
| 14 Aug 2026 | NASDAQ | AMD | Advanced Micro Devices Inc. | Q2 earnings | Guidance may move semis | bullish | Confirmed - [AMD IR](https://example.com/amd) |
| 21 Sep 2026 | NSE | RELIANCE | Reliance Industries Limited | AGM | Commentary may affect sentiment | Neutral | Confirmed - NSE |
""".strip()

        parsed = parse_event_calendar_table(markdown)

        assert parsed is not None
        self.assertEqual(parsed["columns"], EVENT_TABLE_COLUMNS)
        self.assertEqual(len(parsed["rows"]), 2)
        self.assertEqual(parsed["rows"][0]["Expected Outcome"], "Bullish")
        self.assertEqual(parsed["rows"][0]["Exchange"], "NASDAQ")
        self.assertEqual(parsed["rows"][0]["Stock Symbol"], "AMD")
        self.assertEqual(parsed["rows"][0]["Stock Name"], "Advanced Micro Devices Inc.")
        self.assertEqual(parsed["rows"][1]["Status / Source"], "Confirmed - NSE")

    def test_indmoney_events_prompt_emphasizes_reference_date_and_ticker_search(self):
        snapshot = SimpleNamespace(
            id=9,
            snapshot_date=date(2026, 5, 30),
            captured_at=datetime(2026, 5, 30, 10, 14, tzinfo=timezone.utc),
            holdings_count=2,
            current_value=5483.39,
            invested_value=4119.32,
            total_return_value=1364.07,
            holdings=[
                {
                    "company_name": "Micron Technology Inc",
                    "symbol": "MU",
                    "quantity": 1.41,
                    "average_price": 499.73,
                    "market_price": 971.00,
                    "current_value": 1377.24,
                },
                {
                    "company_name": "NVIDIA Corporation",
                    "symbol": "NVDA",
                    "quantity": 5.22,
                    "average_price": 203.77,
                    "market_price": 211.14,
                    "current_value": 1102.29,
                },
            ],
        )

        prompt = build_indmoney_us_events_prompt(snapshot)

        self.assertIn("You must cover **every holding in the pasted portfolio**", prompt)
        self.assertIn("Treat 2026-05-30 as the reference 'today' date", prompt)
        self.assertIn("Return at least one row for every holding in the portfolio.", prompt)
        self.assertIn("If no scheduled event is found for a holding after checking the required categories", prompt)
        self.assertIn("Every output row must include Exchange, Stock Symbol, and Stock Name", prompt)
        self.assertIn("Use the pasted stock symbol as authoritative", prompt)
        self.assertIn("Prioritize the **nearest 60 calendar days first**", prompt)
        self.assertIn("Before concluding there are no events, check at least these categories for every holding", prompt)

    def test_zerodha_events_prompt_emphasizes_reference_date_and_ticker_search(self):
        snapshot = SimpleNamespace(
            snapshot_date=date(2026, 5, 30),
            captured_at=datetime(2026, 5, 30, 10, 40, tzinfo=timezone.utc),
            holdings_count=1,
            holdings_market_value=454401.0,
            holdings_pnl=38211.0,
            holdings=[
                {
                    "tradingsymbol": "DIXON",
                    "exchange": "NSE",
                    "isin": "INE935N01020",
                    "quantity": 10,
                    "average_price": 12000.0,
                    "last_price": 13457.2,
                    "market_value": 134572.0,
                }
            ],
        )

        prompt = build_zerodha_events_prompt(snapshot)

        self.assertIn("You must cover **every holding in the pasted portfolio**", prompt)
        self.assertIn("Treat 2026-05-30 as the reference 'today' date", prompt)
        self.assertIn("Return at least one row for every holding in the portfolio.", prompt)
        self.assertIn("If no scheduled event is found for a holding after checking the required categories", prompt)
        self.assertIn("Every output row must include Exchange, Stock Symbol, and Stock Name", prompt)
        self.assertIn("Use the pasted exchange + tradingsymbol pair as authoritative", prompt)
        self.assertIn("Prioritize the **nearest 60 calendar days first**", prompt)
        self.assertIn("Before concluding there are no events, check at least these categories for every holding", prompt)

    def test_event_run_request_requires_provider_and_model_together(self):
        with self.assertRaises(ValidationError):
            PortfolioEventRunRequest(provider="openai")

        with self.assertRaises(ValidationError):
            PortfolioEventRunRequest(model="gpt-4o-mini")

    def test_event_run_request_normalizes_blank_values(self):
        body = PortfolioEventRunRequest(provider="  ", model=" ")

        self.assertIsNone(body.provider)
        self.assertIsNone(body.model)

    def test_event_run_request_accepts_explicit_target(self):
        body = PortfolioEventRunRequest(provider=" openai ", model=" gpt-4o-mini ")

        self.assertEqual(body.provider, "openai")
        self.assertEqual(body.model, "gpt-4o-mini")

    def test_event_table_backfills_missing_holdings_from_prompt(self):
        snapshot = SimpleNamespace(
            id=9,
            snapshot_date=date(2026, 5, 30),
            captured_at=datetime(2026, 5, 30, 10, 14, tzinfo=timezone.utc),
            holdings_count=2,
            current_value=5483.39,
            invested_value=4119.32,
            total_return_value=1364.07,
            holdings=[
                {
                    "company_name": "Microsoft Corporation",
                    "symbol": "MSFT",
                    "quantity": 2.0,
                    "average_price": 400.0,
                    "market_price": 420.0,
                    "current_value": 840.0,
                },
                {
                    "company_name": "NVIDIA Corporation",
                    "symbol": "NVDA",
                    "quantity": 1.0,
                    "average_price": 900.0,
                    "market_price": 950.0,
                    "current_value": 950.0,
                },
            ],
        )

        prompt = build_indmoney_us_events_prompt(snapshot)
        parsed = parse_event_calendar_table(
            """
| Date | Exchange | Stock Symbol | Stock Name | Event | Why it may matter | Expected Outcome | Status / Source |
| ---- | -------- | ------------ | ---------- | ----- | ----------------- | ---------------- | --------------- |
| 11 Jun 2026 | NASDAQ | MSFT | Microsoft Corporation | Dividend Payment Date | Cash return signal | Bullish | Confirmed |
""".strip()
        )

        completed = ensure_event_table_covers_prompt_holdings(prompt, parsed)

        assert completed is not None
        self.assertEqual(len(completed["rows"]), 2)
        self.assertEqual(completed["rows"][1]["Stock Symbol"], "NVDA")
        self.assertEqual(completed["rows"][1]["Stock Name"], "NVIDIA Corporation")
        self.assertEqual(completed["rows"][1]["Date"], "Not found")
        self.assertEqual(
            completed["rows"][1]["Event"],
            "No upcoming scheduled price-sensitive event found",
        )


if __name__ == "__main__":
    unittest.main()
