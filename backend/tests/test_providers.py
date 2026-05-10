import os
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

os.environ.setdefault("DATABASE_URL", "sqlite:////tmp/investor-test.db")
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")
os.environ.setdefault("OPENAI_API_KEY", "test-openai-key")
os.environ.setdefault("GEMINI_API_KEY", "test-gemini-key")

from app.providers.base import AIProviderResponse
from app.providers.factory import ProviderFactory
from app.providers.gemini_provider import GeminiProvider
from app.providers.openai_provider import OpenAIProvider
from app.workers.tasks import execute_ai_job


class FakeQuery:
    def __init__(self, job):
        self.job = job

    def filter(self, *_args, **_kwargs):
        return self

    def first(self):
        return self.job


class FakeSession:
    def __init__(self, job):
        self.job = job
        self.commits = 0
        self.closed = False
        self.rolled_back = False

    def query(self, _model):
        return FakeQuery(self.job)

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rolled_back = True

    def close(self):
        self.closed = True


class ProviderFactoryTests(unittest.TestCase):
    def test_create_returns_openai_provider(self):
        provider = ProviderFactory.create("openai")

        self.assertIsInstance(provider, OpenAIProvider)

    def test_create_returns_gemini_provider(self):
        provider = ProviderFactory.create("gemini")

        self.assertIsInstance(provider, GeminiProvider)

    def test_create_rejects_unsupported_provider(self):
        with self.assertRaises(ValueError):
            ProviderFactory.create("anthropic")


class OpenAIProviderTests(unittest.TestCase):
    @patch("app.providers.openai_provider.OpenAI")
    def test_generate_returns_normalized_response(self, openai_client_cls):
        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(content="  investment analysis  ")
                )
            ],
            usage=SimpleNamespace(prompt_tokens=123, completion_tokens=45),
        )
        openai_client_cls.return_value = mock_client

        provider = OpenAIProvider()
        result = provider.generate(prompt="analyze tesla", model="gpt-4o-mini")

        self.assertEqual(
            result,
            AIProviderResponse(
                content="investment analysis",
                tokens_in=123,
                tokens_out=45,
                cost=0.000045,
                provider="openai",
                model="gpt-4o-mini",
            ),
        )


class GeminiProviderTests(unittest.TestCase):
    @patch("app.providers.gemini_provider.httpx.post")
    def test_generate_returns_normalized_response(self, httpx_post):
        response = MagicMock()
        response.json.return_value = {
            "candidates": [
                {
                    "content": {
                        "parts": [
                            {"text": " investment "},
                            {"text": "analysis "},
                        ]
                    }
                }
            ],
            "usageMetadata": {
                "promptTokenCount": 200,
                "candidatesTokenCount": 75,
            },
        }
        httpx_post.return_value = response

        provider = GeminiProvider()
        result = provider.generate(prompt="analyze tesla", model="gemini-1.5-flash")

        response.raise_for_status.assert_called_once_with()
        httpx_post.assert_called_once()
        self.assertEqual(
            result,
            AIProviderResponse(
                content="investment analysis",
                tokens_in=200,
                tokens_out=75,
                cost=0.000037,
                provider="gemini",
                model="gemini-1.5-flash",
            ),
        )


class ExecuteAIJobTests(unittest.TestCase):
    @patch("app.workers.tasks.ProviderFactory.create")
    @patch("app.workers.tasks.SessionLocal")
    def test_execute_ai_job_updates_job_with_provider_response(
        self,
        session_local_mock,
        provider_factory_mock,
    ):
        job = SimpleNamespace(
            id=1,
            prompt="analyze apple",
            provider="openai",
            model="gpt-4o-mini",
            status="pending",
            response=None,
            error_message=None,
            tokens_in=None,
            tokens_out=None,
            estimated_cost=None,
        )
        fake_session = FakeSession(job)
        session_local_mock.return_value = fake_session

        provider = MagicMock()
        provider.generate.return_value = AIProviderResponse(
            content="analysis complete",
            tokens_in=321,
            tokens_out=123,
            cost=0.000154,
            provider="openai",
            model="gpt-4o-mini",
        )
        provider_factory_mock.return_value = provider

        execute_ai_job.run(1)

        self.assertEqual(job.status, "completed")
        self.assertEqual(job.response, "analysis complete")
        self.assertEqual(job.tokens_in, 321)
        self.assertEqual(job.tokens_out, 123)
        self.assertEqual(job.estimated_cost, 0.000154)
        self.assertIsNone(job.error_message)
        self.assertEqual(fake_session.commits, 2)
        self.assertTrue(fake_session.closed)

    @patch("app.workers.tasks.ProviderFactory.create")
    @patch("app.workers.tasks.SessionLocal")
    def test_execute_ai_job_marks_job_failed_when_provider_errors(
        self,
        session_local_mock,
        provider_factory_mock,
    ):
        job = SimpleNamespace(
            id=2,
            prompt="analyze risk",
            provider="openai",
            model="gpt-4o-mini",
            status="pending",
            response=None,
            error_message=None,
            tokens_in=None,
            tokens_out=None,
            estimated_cost=None,
        )
        fake_session = FakeSession(job)
        session_local_mock.return_value = fake_session
        provider_factory_mock.return_value.generate.side_effect = RuntimeError("boom")

        execute_ai_job.run(2)

        self.assertEqual(job.status, "failed")
        self.assertEqual(job.error_message, "boom")
        self.assertTrue(fake_session.rolled_back)
        self.assertEqual(fake_session.commits, 2)
        self.assertTrue(fake_session.closed)
