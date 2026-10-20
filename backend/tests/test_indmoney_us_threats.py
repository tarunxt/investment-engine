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
        # Original pre-acceptance fixtures are no longer admissible inputs.
        from app.domains.indmoney_us.schemas import IndMoneyUsPortfolioSnapshotCreateRequest
        from app.domains.indmoney_us.import_validation import parse_import
        from app.shared.exceptions import ValidationException
        with self.assertRaises(ValidationException):
            build_indmoney_us_threat_prompt(SimpleNamespace(acceptance_state='legacy_unverified'))
        captured=datetime.now(timezone.utc)
        raw='symbol,company_name,currency,quantity,market_price,invested_value,current_value,total_pnl,total_pnl_percent\nUATA,Synthetic Alpha,USD,2,55,100,110,10,10\nUATB,Synthetic Beta,USD,1,60,50,60,10,20\n'
        data=parse_import(IndMoneyUsPortfolioSnapshotCreateRequest(raw_text=raw,captured_at=captured,format='csv'))
        self.assertFalse(data['import_provenance']['errors'])
        snapshot=SimpleNamespace(id=7,**{**data,'acceptance_state':'accepted'})

        prompt = build_indmoney_us_threat_prompt(snapshot)

        self.assertIn(THREAT_JOB_MARKER, prompt)
        self.assertIn("[INDMONEY_THREAT_SNAPSHOT_ID=7]", prompt)
        self.assertIn(f"[THREAT_SNAPSHOT_DATE={snapshot.snapshot_date.isoformat()}]", prompt)
        self.assertIn("Synthetic Alpha", prompt)
        self.assertIn("UATB", prompt)
        self.assertIn("Table 10: Urgent Actionables / Immediate Risk-Control Actions", prompt)
        self.assertIn("For every table row about a single stock, always include Exchange, Stock Symbol, and Stock Name.", prompt)
        self.assertIn("Exact Date / Timing", prompt)
        self.assertIn("Exact Date / Deadline", prompt)
        self.assertIn('do not write only "Before Earnings" or "Soon"', prompt)

        metadata = extract_indmoney_us_threat_prompt_metadata(prompt)
        self.assertEqual(metadata.snapshot_id, 7)
        self.assertEqual(metadata.snapshot_date, snapshot.snapshot_date)
        self.assertEqual(metadata.captured_at, captured)

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
| Exchange | Stock Symbol | Stock Name | Urgent Action Needed | Why Action Is Needed Now | Trigger / Condition | Exact Date / Deadline | Suggested Action Size | Priority | Time Sensitivity |
|---|---|---|---|---|---|---|---|---|---|
| NASDAQ | MU | Micron Technology Inc. | Tighten Stop-Loss | Gains are large and semis are extended | Close below support | 14 Aug 2026 | 20% trim on trigger | High | Before earnings on 14 Aug 2026 |

## Bottom Line
| Point | Conclusion |
|---|---|
| Stocks to protect gains in | MU, AMD |
""".strip()

        parsed = parse_indmoney_us_threat_report(markdown)

        assert parsed is not None
        self.assertEqual(parsed["summary"]["main_portfolio_risk"], "AI concentration is the key swing risk.")
        self.assertEqual(parsed["tables"][0]["key"], "urgent_actionables")
        self.assertEqual(parsed["tables"][0]["rows"][0]["Exchange"], "NASDAQ")
        self.assertEqual(parsed["tables"][0]["rows"][0]["Stock Symbol"], "MU")
        self.assertEqual(parsed["tables"][0]["rows"][0]["Stock Name"], "Micron Technology Inc.")
        self.assertEqual(parsed["tables"][0]["rows"][0]["Exact Date / Deadline"], "14 Aug 2026")
        self.assertEqual(parsed["bottom_line"][0]["value"], "MU, AMD")


if __name__ == "__main__":
    unittest.main()
