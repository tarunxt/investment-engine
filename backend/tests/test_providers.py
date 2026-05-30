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
from app.domains.ai_providers.gemini import GeminiProvider
from app.domains.ai_providers.openai import OpenAIProvider
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
        )
        provider_factory_create_mock.return_value = provider

        tasks.execute_ai_job.run(1)

        self.assertEqual(job.status, JobStatus.COMPLETED)
        self.assertEqual(job.response, "analysis complete")
        self.assertEqual(job.tokens_in, 321)
        self.assertEqual(job.tokens_out, 123)
        self.assertEqual(job.estimated_cost, 0.000154)
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
