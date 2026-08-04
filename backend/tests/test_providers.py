import os
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")
os.environ.setdefault("OPENAI_API_KEY", "test-openai-key")
os.environ.setdefault("GEMINI_API_KEY", "test-gemini-key")
os.environ.setdefault("ANTHROPIC_API_KEY", "test-anthropic-key")
os.environ.setdefault("DEEPSEEK_API_KEY", "test-deepseek-key")

from app.domains.ai_providers.anthropic import AnthropicProvider
from app.domains.ai_providers.base import AIProviderResponse
from app.domains.ai_providers.deepseek import DeepSeekProvider
from app.domains.ai_providers.factory import ProviderFactory
from app.domains.ai_providers.gemini import MAX_OUTPUT_TOKENS, GeminiProvider
from app.domains.ai_providers.openai import OpenAIProvider
from app.domains.ai_providers.router import _resolve_recent_model_costs
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
        web_search_used=None,
        web_search_queries=None,
        web_sources=None,
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
        if web_search_used is not None:
            job.web_search_used = web_search_used
        if web_search_queries is not None:
            job.web_search_queries = web_search_queries
        if web_sources is not None:
            job.web_sources = web_sources


class ProviderFactoryTests(unittest.TestCase):
    def test_create_returns_openai_provider(self):
        provider = ProviderFactory.create("openai")

        self.assertIsInstance(provider, OpenAIProvider)

    def test_create_returns_gemini_provider(self):
        provider = ProviderFactory.create("gemini")

        self.assertIsInstance(provider, GeminiProvider)

    def test_create_returns_anthropic_provider(self):
        provider = ProviderFactory.create("anthropic")

        self.assertIsInstance(provider, AnthropicProvider)

    def test_create_returns_deepseek_provider(self):
        provider = ProviderFactory.create("deepseek")

        self.assertIsInstance(provider, DeepSeekProvider)

    def test_create_rejects_unsupported_provider(self):
        with self.assertRaises(ValueError):
            ProviderFactory.create("unsupported-provider")

    @patch.object(ProviderFactory, "default_target_candidates")
    def test_resolve_default_target_falls_back_to_next_configured_provider(
        self,
        default_target_candidates_mock,
    ):
        default_target_candidates_mock.return_value = [
            ("gemini", "gemini-2.5-flash")
        ]

        target = ProviderFactory.resolve_default_target("openai", "gpt-4o-mini")

        self.assertEqual(target, ("gemini", "gemini-2.5-flash"))
        default_target_candidates_mock.assert_called_once_with(
            "openai",
            "gpt-4o-mini",
        )

    @patch.object(ProviderFactory, "default_target_candidates")
    def test_resolve_default_target_prefers_requested_model_when_available(
        self,
        default_target_candidates_mock,
    ):
        default_target_candidates_mock.return_value = [
            ("openai", "gpt-4o-mini"),
            ("gemini", "gemini-2.5-flash"),
        ]

        target = ProviderFactory.resolve_default_target("openai", "gpt-4o-mini")

        self.assertEqual(target, ("openai", "gpt-4o-mini"))

    def test_list_providers_includes_internet_access_metadata(self):
        providers = {item["name"]: item for item in ProviderFactory.list_providers()}

        self.assertEqual(providers["openai"]["internet_access"]["mode"], "conditional")
        self.assertEqual(providers["gemini"]["internet_access"]["mode"], "always_enabled")
        self.assertEqual(providers["deepseek"]["internet_access"]["mode"], "tool_auto")
        self.assertEqual(providers["anthropic"]["internet_access"]["mode"], "none")

    def test_deepseek_catalog_advertises_only_current_v4_models(self):
        providers = {item["name"]: item for item in ProviderFactory.list_providers()}

        self.assertEqual(
            providers["deepseek"]["models"],
            ["deepseek-v4-flash", "deepseek-v4-pro"],
        )

    def test_legacy_deepseek_models_are_incompatible(self):
        for model in (
            "deepseek-reasoner",
            "deepseek-chat",
            "deepseek-coder",
            "deepseek-r1",
            "deepseek-v3",
        ):
            compatible, reason = ProviderFactory.model_compatibility("deepseek", model)
            self.assertFalse(compatible)
            self.assertTrue(reason)

    def test_get_provider_internet_access_returns_force_token_for_openai(self):
        internet_access = ProviderFactory.get_provider_internet_access("openai")

        self.assertEqual(internet_access["force_token"], "[ENABLE_WEB_SEARCH]")


class ProviderCostSelectionTests(unittest.TestCase):
    def test_prefers_latest_exact_prompt_cost_for_current_user(self):
        rows = [
            (0.0007, "latest valid output", "Different prompt", 41),
            (0.0005, "older valid output", "Analyze   AMD   \n earnings", 7),
            (0.0004, "even older valid output", "Analyze AMD earnings", 7),
        ]

        exact_prompt_cost, latest_model_cost = _resolve_recent_model_costs(
            rows,
            prompt_text="Analyze AMD earnings",
            current_user_id=7,
        )

        self.assertEqual(exact_prompt_cost, 0.0005)
        self.assertEqual(latest_model_cost, 0.0007)

    def test_falls_back_to_latest_valid_model_cost_when_prompt_does_not_match(self):
        rows = [
            (0.0009, "latest valid output", "Different prompt", 12),
            (0.0006, "", "Analyze AMD earnings", 12),
        ]

        exact_prompt_cost, latest_model_cost = _resolve_recent_model_costs(
            rows,
            prompt_text="Analyze AMD earnings",
            current_user_id=12,
        )

        self.assertIsNone(exact_prompt_cost)
        self.assertEqual(latest_model_cost, 0.0009)

    def test_ignores_unparseable_cost_rows(self):
        rows = [
            ("bad-cost", "latest valid output", "Analyze AMD earnings", 7),
            (0.0008, "older valid output", "Analyze AMD earnings", 7),
        ]

        exact_prompt_cost, latest_model_cost = _resolve_recent_model_costs(
            rows,
            prompt_text="Analyze AMD earnings",
            current_user_id=7,
        )

        self.assertEqual(exact_prompt_cost, 0.0008)
        self.assertEqual(latest_model_cost, 0.0008)


class GeminiProviderConfigTests(unittest.TestCase):
    def test_flash_generation_disables_thinking_and_uses_larger_output_budget(self):
        provider = GeminiProvider()
        stream_mock = MagicMock(
            return_value=[
                SimpleNamespace(
                    text="ok",
                    usage_metadata=SimpleNamespace(
                        prompt_token_count=10,
                        candidates_token_count=2,
                    ),
                )
            ]
        )
        provider.client = SimpleNamespace(
            models=SimpleNamespace(generate_content_stream=stream_mock),
        )

        provider._generate_once(
            prompt="[REBALANCE_FLOW:india] build table", model="gemini-2.5-flash"
        )

        config = stream_mock.call_args.kwargs["config"]
        self.assertEqual(config.max_output_tokens, MAX_OUTPUT_TOKENS)
        self.assertIsNotNone(config.tools)
        self.assertIsNotNone(config.thinking_config)
        self.assertEqual(config.thinking_config.thinking_budget, 0)

    def test_repair_generation_disables_search_tools(self):
        provider = GeminiProvider()
        stream_mock = MagicMock(
            return_value=[
                SimpleNamespace(
                    text="ok",
                    usage_metadata=SimpleNamespace(
                        prompt_token_count=10,
                        candidates_token_count=2,
                    ),
                )
            ]
        )
        provider.client = SimpleNamespace(
            models=SimpleNamespace(generate_content_stream=stream_mock),
        )

        provider._generate_once(
            prompt="[REBALANCE_TABLE_REPAIR] return rows only",
            model="gemini-2.5-flash",
        )

        config = stream_mock.call_args.kwargs["config"]
        self.assertIsNone(config.tools)

    def test_generate_captures_grounded_web_metadata(self):
        provider = GeminiProvider()
        stream_mock = MagicMock(
            return_value=[
                SimpleNamespace(
                    text="Spain won Euro 2024.",
                    usage_metadata=SimpleNamespace(
                        prompt_token_count=120,
                        candidates_token_count=40,
                        tool_use_prompt_token_count=18,
                    ),
                    candidates=[
                        SimpleNamespace(
                            grounding_metadata=SimpleNamespace(
                                web_search_queries=["UEFA Euro 2024 winner"],
                                grounding_chunks=[
                                    SimpleNamespace(
                                        web=SimpleNamespace(
                                            uri="https://www.uefa.com/euro2024/",
                                            title="UEFA",
                                        )
                                    )
                                ],
                            )
                        )
                    ],
                )
            ]
        )
        provider.client = SimpleNamespace(
            models=SimpleNamespace(generate_content_stream=stream_mock),
        )

        result = provider._generate_once(
            prompt="Who won Euro 2024?",
            model="gemini-2.5-flash",
        )

        self.assertEqual(result.web_search_used, True)
        self.assertEqual(result.web_search_queries, ["UEFA Euro 2024 winner"])
        self.assertEqual(result.web_sources, ["https://www.uefa.com/euro2024/"])


class ExecuteAIJobTests(unittest.TestCase):
    @patch("app.domains.jobs.tasks._refresh_run_status")
    @patch("app.domains.jobs.tasks._publish_job_update")
    @patch("app.domains.ai_providers.factory.ProviderFactory.create")
    @patch("app.domains.jobs.tasks.SyncJobRepository")
    @patch("app.domains.jobs.tasks.SyncSessionLocal")
    def test_execute_ai_job_updates_job_with_provider_response(
        self,
        sync_session_local_mock,
        sync_repo_cls_mock,
        provider_factory_create_mock,
        _publish_job_update_mock,
        _refresh_run_status_mock,
    ):
        job = SimpleNamespace(
            id=1,
            prompt="analyze apple",
            provider="openai",
            model="gpt-4o-mini",
            status=JobStatus.PENDING,
            response=None,
            error_message=None,
            tokens_in=None,
            tokens_out=None,
            estimated_cost=None,
            web_search_used=None,
            web_search_queries=None,
            web_sources=None,
        )
        fake_db = FakeDB()
        fake_repo = FakeRepo(job)

        sync_session_local_mock.return_value = fake_db
        sync_repo_cls_mock.return_value = fake_repo

        provider = MagicMock()
        provider.generate.return_value = AIProviderResponse(
            content="analysis complete",
            tokens_in=321,
            tokens_out=123,
            cost=0.000154,
            provider="openai",
            model="gpt-4o-mini",
            web_search_used=True,
            web_search_queries=["AAPL latest earnings date"],
            web_sources=["https://investor.apple.com"],
        )
        provider_factory_create_mock.return_value = provider

        tasks.execute_ai_job.run(1)

        self.assertEqual(job.status, JobStatus.COMPLETED)
        self.assertEqual(job.response, "analysis complete")
        self.assertEqual(job.tokens_in, 321)
        self.assertEqual(job.tokens_out, 123)
        self.assertEqual(job.estimated_cost, 0.000154)
        self.assertEqual(job.web_search_used, True)
        self.assertEqual(job.web_search_queries, ["AAPL latest earnings date"])
        self.assertEqual(job.web_sources, ["https://investor.apple.com"])
        self.assertIsNone(job.error_message)
        self.assertTrue(fake_db.closed)

    @patch("app.domains.jobs.tasks._refresh_run_status")
    @patch("app.domains.jobs.tasks._publish_job_update")
    @patch("app.domains.jobs.tasks._classify_exc", return_value=(False, 0))
    @patch("app.domains.ai_providers.factory.ProviderFactory.create")
    @patch("app.domains.jobs.tasks.SyncJobRepository")
    @patch("app.domains.jobs.tasks.SyncSessionLocal")
    def test_execute_ai_job_marks_job_failed_when_provider_errors(
        self,
        sync_session_local_mock,
        sync_repo_cls_mock,
        provider_factory_create_mock,
        _classify_exc_mock,
        _publish_job_update_mock,
        _refresh_run_status_mock,
    ):
        job = SimpleNamespace(
            id=2,
            prompt="analyze risk",
            provider="openai",
            model="gpt-4o-mini",
            status=JobStatus.PENDING,
            response=None,
            error_message=None,
            tokens_in=None,
            tokens_out=None,
            estimated_cost=None,
            web_search_used=None,
            web_search_queries=None,
            web_sources=None,
        )
        fake_db = FakeDB()
        fake_repo = FakeRepo(job)

        sync_session_local_mock.return_value = fake_db
        sync_repo_cls_mock.return_value = fake_repo

        provider = MagicMock()
        provider.generate.side_effect = RuntimeError("boom")
        provider_factory_create_mock.return_value = provider

        tasks.execute_ai_job.run(2)

        self.assertEqual(job.status, JobStatus.FAILED)
        self.assertEqual(job.error_message, "boom")
        self.assertTrue(fake_db.rolled_back)
        self.assertTrue(fake_db.closed)


if __name__ == "__main__":
    unittest.main()
