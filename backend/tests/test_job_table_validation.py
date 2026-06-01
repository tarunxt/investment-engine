import os
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

from app.domains.ai_providers.base import AIProviderResponse
from app.domains.jobs import tasks
from app.shared.types import JobStatus


class FakeDB:
    def __init__(self):
        self.rolled_back = False
        self.closed = False

    def rollback(self):
        self.rolled_back = True

    def close(self):
        self.closed = True


class FakeRepo:
    def __init__(self, job):
        self.job = job

    def get(self, _job_id: int):
        return self.job

    def update_status(
        self,
        job,
        status,
        *,
        response=None,
        error_message=None,
        tokens_in=None,
        tokens_out=None,
        estimated_cost=None,
    ):
        job.status = status
        if response is not None:
            job.response = response
        if error_message is not None:
            job.error_message = error_message
        if tokens_in is not None:
            job.tokens_in = tokens_in
        if tokens_out is not None:
            job.tokens_out = tokens_out
        if estimated_cost is not None:
            job.estimated_cost = estimated_cost


class ExecuteAIJobTableValidationTests(unittest.TestCase):
    @patch("app.domains.jobs.tasks._refresh_run_status")
    @patch("app.domains.jobs.tasks._publish_job_update")
    @patch("app.domains.google_sheets.stock_service.normalize_stock_rows")
    @patch("app.domains.google_sheets.stock_service.parse_stock_recommendations")
    @patch("app.domains.ai_providers.factory.ProviderFactory.create")
    @patch("app.domains.jobs.tasks.SyncJobRepository")
    @patch("app.domains.jobs.tasks.SyncSessionLocal")
    def test_execute_ai_job_allows_placeholder_noise_when_rows_normalize_cleanly(
        self,
        sync_session_local_mock,
        sync_repo_cls_mock,
        provider_factory_create_mock,
        parse_stock_recommendations_mock,
        normalize_stock_rows_mock,
        _publish_job_update_mock,
        _refresh_run_status_mock,
    ):
        job = SimpleNamespace(
            id=68,
            prompt=(
                "Return only one markdown table.\n"
                "Table columns: Stock Symbol, Stock Name, Technical Setup, Entry Range, Units to Buy"
            ),
            provider="openai",
            model="gpt-4o-mini",
            status=JobStatus.PENDING,
            response=None,
            error_message=None,
            tokens_in=None,
            tokens_out=None,
            estimated_cost=None,
        )
        fake_db = FakeDB()
        fake_repo = FakeRepo(job)

        sync_session_local_mock.return_value = fake_db
        sync_repo_cls_mock.return_value = fake_repo

        provider = MagicMock()
        provider.generate.return_value = AIProviderResponse(
            content=(
                "| Stock Symbol | Stock Name | Technical Setup | Entry Range | Units to Buy |\n"
                "| --- | --- | --- | --- | --- |\n"
                "| HDFCBANK | HDFC Bank Ltd. | Strong breakout | 1630-1650 | 30 |\n"
                + ("-" * 50 + "\n") * 3
            ),
            tokens_in=671,
            tokens_out=917,
            cost=0.0007,
            provider="openai",
            model="gpt-4o-mini",
        )
        provider_factory_create_mock.return_value = provider

        parse_stock_recommendations_mock.return_value = [{"stock_symbol": "ignored"}]
        normalize_stock_rows_mock.return_value = [
            {
                "llm_name_model": "OpenAI gpt-4o-mini",
                "exchange_symbol": "NSE",
                "stock_symbol": "HDFCBANK",
                "stock_name": "HDFC Bank Ltd.",
                "technical_setup": "Strong breakout",
                "entry_range": "1630-1650",
                "stop_loss": "1580",
                "target": "1780",
                "analyst_source": "Brokerage Note",
                "units_to_buy": "30",
                "price_per_unit": "1650",
                "total_buy_amount": "49500",
                "upside_horizon": "9.4",
                "weeks": "8",
                "confidence_score": "90",
            }
            for _ in range(5)
        ]

        tasks.execute_ai_job.run(68)

        self.assertEqual(job.status, JobStatus.COMPLETED)
        self.assertIsNone(job.error_message)
        self.assertEqual(job.tokens_in, 671)
        self.assertEqual(job.tokens_out, 917)
        self.assertEqual(job.estimated_cost, 0.0007)
        self.assertIn("LLM Name + Model", job.response)
        self.assertIn("HDFCBANK", job.response)
        self.assertTrue(fake_db.closed)

    @patch("app.domains.jobs.tasks._refresh_run_status")
    @patch("app.domains.jobs.tasks._publish_job_update")
    @patch("app.domains.ai_providers.factory.ProviderFactory.create")
    @patch("app.domains.jobs.tasks.SyncJobRepository")
    @patch("app.domains.jobs.tasks.SyncSessionLocal")
    def test_execute_ai_job_repairs_stock_table_when_first_pass_has_no_data_rows(
        self,
        sync_session_local_mock,
        sync_repo_cls_mock,
        provider_factory_create_mock,
        _publish_job_update_mock,
        _refresh_run_status_mock,
    ):
        job = SimpleNamespace(
            id=102,
            prompt=(
                "Return only one markdown table.\n"
                "Table columns: Stock Symbol, Stock Name, Technical Setup, Entry Range, Units to Buy"
            ),
            provider="gemini",
            model="gemini-2.5-flash",
            status=JobStatus.PENDING,
            response=None,
            error_message=None,
            tokens_in=None,
            tokens_out=None,
            estimated_cost=None,
        )
        fake_db = FakeDB()
        fake_repo = FakeRepo(job)

        sync_session_local_mock.return_value = fake_db
        sync_repo_cls_mock.return_value = fake_repo

        provider = MagicMock()
        provider.generate.side_effect = [
            AIProviderResponse(
                content=(
                    "## May 31, 2026 | How to Invest INR 50,000 | Generated by Gemini 1.5 Pro\n\n"
                    "| LLM Name + Model | Exchange Symbol | Stock Symbol | Stock Name | Technical Setup | Entry Range | Units to Buy |\n"
                    "| --- | --- | --- | --- | --- | --- | --- |"
                ),
                tokens_in=714,
                tokens_out=139,
                cost=0.0008,
                provider="gemini",
                model="gemini-2.5-flash",
            ),
            AIProviderResponse(
                content=(
                    "| Stock Symbol | Stock Name | Technical Setup | Entry Range | Units to Buy |\n"
                    "| --- | --- | --- | --- | --- |\n"
                    "| HAL | Hindustan Aeronautics Ltd | Bullish flag breakout | 4300-4350 | 11 |\n"
                    "| ICICIBANK | ICICI Bank Ltd | Accumulation near support | 1100-1120 | 45 |\n"
                    "| LT | Larsen & Toubro Ltd | Breakout from consolidation | 4000-4050 | 6 |\n"
                    "| TATAMOTORS | Tata Motors Ltd | Momentum continuation | 980-995 | 20 |\n"
                    "| BEL | Bharat Electronics Ltd | Pullback entry above support | 300-308 | 32 |"
                ),
                tokens_in=820,
                tokens_out=420,
                cost=0.0012,
                provider="gemini",
                model="gemini-2.5-flash",
            ),
        ]
        provider_factory_create_mock.return_value = provider

        tasks.execute_ai_job.run(102)

        self.assertEqual(job.status, JobStatus.COMPLETED)
        self.assertIsNone(job.error_message)
        self.assertEqual(provider.generate.call_count, 2)
        self.assertEqual(job.tokens_in, 1534)
        self.assertEqual(job.tokens_out, 559)
        self.assertEqual(job.estimated_cost, 0.002)
        self.assertIn("Stock Symbol", job.response)
        self.assertIn("BEL", job.response)
        self.assertIn("[STOCK_TABLE_REPAIR]", provider.generate.call_args_list[1].kwargs["prompt"])
        self.assertTrue(fake_db.closed)

    @patch("app.domains.jobs.tasks._refresh_run_status")
    @patch("app.domains.jobs.tasks._publish_job_update")
    @patch("app.domains.ai_providers.factory.ProviderFactory.create")
    @patch("app.domains.jobs.tasks.SyncJobRepository")
    @patch("app.domains.jobs.tasks.SyncSessionLocal")
    def test_execute_ai_job_tops_up_stock_table_after_full_repair_still_returns_four_rows(
        self,
        sync_session_local_mock,
        sync_repo_cls_mock,
        provider_factory_create_mock,
        _publish_job_update_mock,
        _refresh_run_status_mock,
    ):
        job = SimpleNamespace(
            id=1021,
            prompt=(
                "Return only one markdown table.\n"
                "Table columns: Stock Symbol, Stock Name, Technical Setup, Entry Range, Units to Buy"
            ),
            provider="gemini",
            model="gemini-2.5-flash",
            status=JobStatus.PENDING,
            response=None,
            error_message=None,
            tokens_in=None,
            tokens_out=None,
            estimated_cost=None,
        )
        fake_db = FakeDB()
        fake_repo = FakeRepo(job)

        sync_session_local_mock.return_value = fake_db
        sync_repo_cls_mock.return_value = fake_repo

        provider = MagicMock()
        provider.generate.side_effect = [
            AIProviderResponse(
                content=(
                    "## May 31, 2026 | How to Invest INR 50,000 | Generated by Gemini 1.5 Pro\n\n"
                    "| LLM Name + Model | Exchange Symbol | Stock Symbol | Stock Name | Technical Setup | Entry Range | Units to Buy |\n"
                    "| --- | --- | --- | --- | --- | --- | --- |"
                ),
                tokens_in=714,
                tokens_out=139,
                cost=0.0008,
                provider="gemini",
                model="gemini-2.5-flash",
            ),
            AIProviderResponse(
                content=(
                    "| Stock Symbol | Stock Name | Technical Setup | Entry Range | Units to Buy |\n"
                    "| --- | --- | --- | --- | --- |\n"
                    "| HAL | Hindustan Aeronautics Ltd | Bullish flag breakout | 4300-4350 | 11 |\n"
                    "| ICICIBANK | ICICI Bank Ltd | Accumulation near support | 1100-1120 | 45 |\n"
                    "| LT | Larsen & Toubro Ltd | Breakout from consolidation | 4000-4050 | 6 |\n"
                    "| TATAMOTORS | Tata Motors Ltd | Momentum continuation | 980-995 | 20 |"
                ),
                tokens_in=820,
                tokens_out=420,
                cost=0.0012,
                provider="gemini",
                model="gemini-2.5-flash",
            ),
            AIProviderResponse(
                content=(
                    "| Stock Symbol | Stock Name | Technical Setup | Entry Range | Units to Buy |\n"
                    "| --- | --- | --- | --- | --- |\n"
                    "| BEL | Bharat Electronics Ltd | Pullback entry above support | 300-308 | 32 |"
                ),
                tokens_in=240,
                tokens_out=130,
                cost=0.0004,
                provider="gemini",
                model="gemini-2.5-flash",
            ),
        ]
        provider_factory_create_mock.return_value = provider

        tasks.execute_ai_job.run(1021)

        self.assertEqual(job.status, JobStatus.COMPLETED)
        self.assertIsNone(job.error_message)
        self.assertEqual(provider.generate.call_count, 3)
        self.assertEqual(job.tokens_in, 1774)
        self.assertEqual(job.tokens_out, 689)
        self.assertEqual(job.estimated_cost, 0.0024)
        self.assertIn("BEL", job.response)
        self.assertIn("[STOCK_TABLE_REPAIR]", provider.generate.call_args_list[1].kwargs["prompt"])
        self.assertIn("[STOCK_TABLE_TOP_UP]", provider.generate.call_args_list[2].kwargs["prompt"])
        self.assertIn("exactly 1 ADDITIONAL unique stock row", provider.generate.call_args_list[2].kwargs["prompt"])
        self.assertTrue(fake_db.closed)

    @patch("app.domains.jobs.tasks._refresh_run_status")
    @patch("app.domains.jobs.tasks._publish_job_update")
    @patch("app.domains.ai_providers.factory.ProviderFactory.create")
    @patch("app.domains.jobs.tasks.SyncJobRepository")
    @patch("app.domains.jobs.tasks.SyncSessionLocal")
    def test_execute_ai_job_repairs_stock_table_when_first_pass_has_insufficient_rows(
        self,
        sync_session_local_mock,
        sync_repo_cls_mock,
        provider_factory_create_mock,
        _publish_job_update_mock,
        _refresh_run_status_mock,
    ):
        job = SimpleNamespace(
            id=103,
            prompt=(
                "Return only one markdown table.\n"
                "Table columns: Stock Symbol, Stock Name, Technical Setup, Entry Range, Units to Buy"
            ),
            provider="gemini",
            model="gemini-2.5-flash",
            status=JobStatus.PENDING,
            response=None,
            error_message=None,
            tokens_in=None,
            tokens_out=None,
            estimated_cost=None,
        )
        fake_db = FakeDB()
        fake_repo = FakeRepo(job)

        sync_session_local_mock.return_value = fake_db
        sync_repo_cls_mock.return_value = fake_repo

        provider = MagicMock()
        provider.generate.side_effect = [
            AIProviderResponse(
                content=(
                    "| Stock Symbol | Stock Name | Technical Setup | Entry Range | Units to Buy |\n"
                    "| --- | --- | --- | --- | --- |\n"
                    "| HAL | Hindustan Aeronautics Ltd | Bullish Flag Breakout / Pullback to support | 4300-4350 | 11 |\n"
                    "| ICICIBANK | ICICI Bank Ltd | Accumulation after minor pullback, near key support | 1100-1120 | 45 |\n"
                    "| LT | Larsen & Toubro Ltd | Breakout from consolidation, volume confirmation | 4000-4050 | 6 |\n"
                    "| TAT |"
                ),
                tokens_in=714,
                tokens_out=983,
                cost=0.0033,
                provider="gemini",
                model="gemini-2.5-flash",
            ),
            AIProviderResponse(
                content=(
                    "| Stock Symbol | Stock Name | Technical Setup | Entry Range | Units to Buy |\n"
                    "| --- | --- | --- | --- | --- |\n"
                    "| HAL | Hindustan Aeronautics Ltd | Bullish flag breakout | 4300-4350 | 11 |\n"
                    "| ICICIBANK | ICICI Bank Ltd | Accumulation near support | 1100-1120 | 45 |\n"
                    "| LT | Larsen & Toubro Ltd | Breakout from consolidation | 4000-4050 | 6 |\n"
                    "| TATAMOTORS | Tata Motors Ltd | Momentum continuation | 980-995 | 20 |\n"
                    "| BEL | Bharat Electronics Ltd | Pullback entry above support | 300-308 | 32 |"
                ),
                tokens_in=760,
                tokens_out=390,
                cost=0.0011,
                provider="gemini",
                model="gemini-2.5-flash",
            ),
        ]
        provider_factory_create_mock.return_value = provider

        tasks.execute_ai_job.run(103)

        self.assertEqual(job.status, JobStatus.COMPLETED)
        self.assertIsNone(job.error_message)
        self.assertEqual(provider.generate.call_count, 2)
        self.assertEqual(job.tokens_in, 1474)
        self.assertEqual(job.tokens_out, 1373)
        self.assertEqual(job.estimated_cost, 0.0044)
        self.assertIn("TATAMOTORS", job.response)
        self.assertIn("[STOCK_TABLE_TOP_UP]", provider.generate.call_args_list[1].kwargs["prompt"])
        self.assertIn("Forbidden existing stock symbols: HAL, ICICIBANK, LT", provider.generate.call_args_list[1].kwargs["prompt"])
        self.assertTrue(fake_db.closed)

    @patch("app.domains.jobs.tasks._refresh_run_status")
    @patch("app.domains.jobs.tasks._publish_job_update")
    @patch("app.domains.ai_providers.factory.ProviderFactory.create")
    @patch("app.domains.jobs.tasks.SyncJobRepository")
    @patch("app.domains.jobs.tasks.SyncSessionLocal")
    def test_execute_ai_job_completes_for_deepseek_coder_canonical_variant(
        self,
        sync_session_local_mock,
        sync_repo_cls_mock,
        provider_factory_create_mock,
        _publish_job_update_mock,
        _refresh_run_status_mock,
    ):
        job = SimpleNamespace(
            id=294,
            prompt=(
                "Return only one markdown table.\n"
                "Table columns: Stock Symbol, Stock Name, Technical Setup, Entry Range, Units to Buy"
            ),
            provider="deepseek",
            model="deepseek-coder",
            status=JobStatus.PENDING,
            response=None,
            error_message=None,
            tokens_in=None,
            tokens_out=None,
            estimated_cost=None,
        )
        fake_db = FakeDB()
        fake_repo = FakeRepo(job)

        sync_session_local_mock.return_value = fake_db
        sync_repo_cls_mock.return_value = fake_repo

        provider = MagicMock()
        provider.generate.return_value = AIProviderResponse(
            content=(
                "| DeepSeek R1 | NSE | RELIANCE | Reliance Industries Ltd | Breakout from consolidation with high volume | 2850 - 2900 | 2720 | 3300 | Motilal Oswal | 7 | 2890 | 20230 | 13.0 | 7 | 82 | Strong volume breakout above resistance, bullish on retail and telecom | Sustained outperformance vs Nifty50, institutional accumulation | Robust retail and Jio performance, capex plans | Diversified conglomerate with stable growth drivers | Breakout with above-average volumes, RSI bullish | 1 | 2025-03-27 | 09:30 | DeepSeek R1 |\n"
                "| DeepSeek R1 | NSE | HDFCBANK | HDFC Bank Ltd | Pullback to support with strong rebound | 1750 - 1780 | 1680 | 1950 | Jefferies | 8 | 1765 | 14120 | 9.8 | 8 | 78 | Reversal from 50-DMA, strong support at 1750 | Steady uptrend, outperforming financials index | Strong loan growth, steady NIM, low NPA expectations | Market leader in banking with solid fundamentals | Bullish engulfing pattern with volume confirmation | 2 | 2025-03-27 | 09:30 | DeepSeek R1 |\n"
                "| DeepSeek R1 | NSE | ICICIBANK | ICICI Bank Ltd | Momentum continuation with higher highs breakout | 1250 - 1270 | 1190 | 1380 | CLSA | 6 | 1260 | 7560 | 9.5 | 6 | 80 | Price broke above previous high on heavy volume | Outperforming peers, strong trend from last 3 months | Strong earnings momentum, improved asset quality | Consistent performer with digital banking edge | Follow-through day confirming uptrend | 3 | 2025-03-27 | 09:30 | DeepSeek R1 |\n"
                "| DeepSeek R1 | NSE | BAJFINANCE | Bajaj Finance Ltd | Flag formation breakout with volume | 7200 - 7300 | 6850 | 8000 | Morgan Stanley | 1 | 7250 | 7250 | 10.3 | 8 | 76 | Flag breakout on strong volumes, RSI above 60 | Consolidation breakout, relative strength improving | Strong AUM growth, stable asset quality, digital push | Leader in consumer finance, scalable model | Bullish flag breakout, MACD crossover | 4 | 2025-03-27 | 09:30 | DeepSeek R1 |\n"
                "| DeepSeek R1 | NSE | TATASTEEL | Tata Steel Ltd | Accumulation after correction, base formation | 150 - 155 | 140 | 175 | Kotak Securities | 40 | 153 | 6120 | 12.9 | 9 | 74 | Base breakout above 155 with increased volume | Accumulation phase, higher lows forming | Steel prices stabilizing, strong domestic demand | Beneficiary of infrastructure push, low valuations | Cup-and-handle pattern formation | 5 | 2025-03-27 | 09:30 | DeepSeek R1 |"
            ),
            tokens_in=28543,
            tokens_out=2890,
            cost=0.0048,
            provider="deepseek",
            model="deepseek-coder",
        )
        provider_factory_create_mock.return_value = provider

        tasks.execute_ai_job.run(294)

        self.assertEqual(job.status, JobStatus.COMPLETED)
        self.assertIsNone(job.error_message)
        self.assertEqual(job.tokens_in, 28543)
        self.assertEqual(job.tokens_out, 2890)
        self.assertEqual(job.estimated_cost, 0.0048)
        self.assertIn("LLM Name + Model", job.response)
        self.assertIn("TATASTEEL", job.response)
        self.assertIn("Rationale - Fundamentals Short Term", job.response)
        self.assertTrue(fake_db.closed)

    @patch("app.domains.jobs.tasks._refresh_run_status")
    @patch("app.domains.jobs.tasks._publish_job_update")
    @patch("app.domains.ai_providers.factory.ProviderFactory.create")
    @patch("app.domains.jobs.tasks.SyncJobRepository")
    @patch("app.domains.jobs.tasks.SyncSessionLocal")
    def test_execute_ai_job_repairs_portfolio_events_when_first_pass_is_past_only(
        self,
        sync_session_local_mock,
        sync_repo_cls_mock,
        provider_factory_create_mock,
        _publish_job_update_mock,
        _refresh_run_status_mock,
    ):
        job = SimpleNamespace(
            id=401,
            prompt=(
                "[INDMONEY_US_EVENTS]\n"
                "[ENABLE_WEB_SEARCH]\n"
                "[EVENT_SNAPSHOT_DATE=2026-05-30]\n"
                "Return ONLY one markdown table.\n"
            ),
            provider="openai",
            model="gpt-4o-mini",
            status=JobStatus.PENDING,
            response=None,
            error_message=None,
            tokens_in=None,
            tokens_out=None,
            estimated_cost=None,
        )
        fake_db = FakeDB()
        fake_repo = FakeRepo(job)

        sync_session_local_mock.return_value = fake_db
        sync_repo_cls_mock.return_value = fake_repo

        provider = MagicMock()
        provider.generate.side_effect = [
            AIProviderResponse(
                content=(
                    "| Date | Exchange | Stock Symbol | Stock Name | Event | Why it may matter | Expected Outcome | Status / Source |\n"
                    "| ---- | -------- | ------------ | ---------- | ----- | ----------------- | ---------------- | --------------- |\n"
                    "| 05 May 2026 | NASDAQ | AMD | Advanced Micro Devices Inc. | Earnings Announcement | Old event | Bullish | Confirmed |\n"
                    "| Not found | Not found | All holdings | All holdings | No upcoming scheduled price-sensitive event found | No scheduled catalyst found in checked sources | Neutral | Checked latest available sources |"
                ),
                tokens_in=600,
                tokens_out=120,
                cost=0.001,
                provider="openai",
                model="gpt-4o-mini",
            ),
            AIProviderResponse(
                content=(
                    "| Date | Exchange | Stock Symbol | Stock Name | Event | Why it may matter | Expected Outcome | Status / Source |\n"
                    "| ---- | -------- | ------------ | ---------- | ----- | ----------------- | ---------------- | --------------- |\n"
                    "| 24 Jun 2026 | NASDAQ | MU | Micron Technology Inc. | Fiscal Q3 2026 earnings call | HBM demand and guidance may move memory sentiment | Bullish | Confirmed - Micron IR |\n"
                    "| 30 Jun 2026 | NYSE | VST | Vistra Corp. | Dividend payment / record cycle | Utility yield event may affect near-term flows | Neutral | Confirmed - Vistra IR |"
                ),
                tokens_in=650,
                tokens_out=180,
                cost=0.0011,
                provider="openai",
                model="gpt-4o-mini",
            ),
        ]
        provider_factory_create_mock.return_value = provider

        tasks.execute_ai_job.run(401)

        self.assertEqual(job.status, JobStatus.COMPLETED)
        self.assertIsNone(job.error_message)
        self.assertEqual(provider.generate.call_count, 2)
        self.assertEqual(job.tokens_in, 1250)
        self.assertEqual(job.tokens_out, 300)
        self.assertEqual(job.estimated_cost, 0.0021)
        self.assertIn("24 Jun 2026", job.response)
        self.assertIn("30 Jun 2026", job.response)
        self.assertNotIn("05 May 2026", job.response)
        self.assertNotIn("Not found", job.response)
        self.assertTrue(fake_db.closed)


    @patch("app.domains.jobs.tasks._refresh_run_status")
    @patch("app.domains.jobs.tasks._publish_job_update")
    @patch("app.domains.ai_providers.factory.ProviderFactory.create")
    @patch("app.domains.jobs.tasks.SyncJobRepository")
    @patch("app.domains.jobs.tasks.SyncSessionLocal")
    def test_execute_ai_job_repairs_rebalance_table_when_first_pass_has_no_data_rows(
        self,
        sync_session_local_mock,
        sync_repo_cls_mock,
        provider_factory_create_mock,
        _publish_job_update_mock,
        _refresh_run_status_mock,
    ):
        job = SimpleNamespace(
            id=902,
            prompt=(
                "[REBALANCE_FLOW:india]\n"
                "Return ONLY one markdown table.\n"
                "Create one table only with exactly these columns:\n"
                "| Exchange Symbol | Stock Symbol | Current Units | Action (Buy/Add/Sell All/Trim/Hold/Buy New) | Units Change | Final Units | Technical Setup | Entry Range | Stop Loss | Target | Analyst/Source | Units to Buy | Price Per Unit | Total Buy Amount | Upside Horizon (% return) | Weeks | Confidence Score (0-100) | Rationale Remarks | Rationale - Technical setup (short term (1-3 months) | Rationale - Technical setup (medium term) | Rationale - Technical setup (long term term) | Rationale - Fundamentals Short term | Rationale - Fundamentals Medium/Long Term |"
            ),
            provider="gemini",
            model="gemini-2.5-flash",
            status=JobStatus.PENDING,
            response=None,
            error_message=None,
            tokens_in=None,
            tokens_out=None,
            estimated_cost=None,
        )
        fake_db = FakeDB()
        fake_repo = FakeRepo(job)

        sync_session_local_mock.return_value = fake_db
        sync_repo_cls_mock.return_value = fake_repo

        provider = MagicMock()
        provider.generate.side_effect = [
            AIProviderResponse(
                content=(
                    "## 01 Jun 2026 | Recommended Rebalance | Aggressive Swing Portfolio | Generated by Gemini\n"
                    "| Exchange Symbol | Stock Symbol | Current Units | Action (Buy/Add/Sell All/Trim/Hold/Buy New) | Units Change | Final Units | Technical Setup | Entry Range | Stop Loss | Target | Analyst/Source | Units to Buy | Price Per Unit | Total Buy Amount | Upside Horizon (% return) | Weeks | Confidence Score (0-100) | Rationale Remarks | Rationale - Technical setup (short term (1-3 months) | Rationale - Technical setup (medium term) | Rationale - Technical setup (long term term) | Rationale - Fundamentals Short term | Rationale - Fundamentals Medium/Long Term |"
                ),
                tokens_in=100,
                tokens_out=50,
                cost=0.001,
                provider="gemini",
                model="gemini-2.5-flash",
            ),
            AIProviderResponse(
                content=(
                    "## 01 Jun 2026 | Recommended Rebalance | Aggressive Swing Portfolio | Generated by Gemini\n"
                    "| Exchange Symbol | Stock Symbol | Current Units | Action (Buy/Add/Sell All/Trim/Hold/Buy New) | Units Change | Final Units | Technical Setup | Entry Range | Stop Loss | Target | Analyst/Source | Units to Buy | Price Per Unit | Total Buy Amount | Upside Horizon (% return) | Weeks | Confidence Score (0-100) | Rationale Remarks | Rationale - Technical setup (short term (1-3 months) | Rationale - Technical setup (medium term) | Rationale - Technical setup (long term term) | Rationale - Fundamentals Short term | Rationale - Fundamentals Medium/Long Term |\n"
                    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n"
                    "| NSE | ABC | 10 | Hold | 0 | 10 | Breakout hold | 100-105 | 95 | 120 | Exchange data | 0 | 102 | 0 | 15 | 8 | 82 | Strong setup | constructive | improving | stable | catalyst | quality |"
                ),
                tokens_in=130,
                tokens_out=90,
                cost=0.0013,
                provider="gemini",
                model="gemini-2.5-flash",
            ),
        ]
        provider_factory_create_mock.return_value = provider

        tasks.execute_ai_job.run(902)

        self.assertEqual(job.status, JobStatus.COMPLETED)
        self.assertIsNone(job.error_message)
        self.assertEqual(provider.generate.call_count, 2)
        self.assertEqual(job.tokens_in, 230)
        self.assertEqual(job.tokens_out, 140)
        self.assertEqual(job.estimated_cost, 0.0023)
        self.assertIn("ABC", job.response)
        self.assertIn("Action (Buy/Add/Sell All/Trim/Hold/Buy New)", job.response)
        self.assertTrue(fake_db.closed)


if __name__ == "__main__":
    unittest.main()
