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

from app.domains.ai_providers.openai import OpenAIProvider


class OpenAIProviderTests(unittest.TestCase):
    @patch("app.domains.ai_providers.openai.OpenAI")
    def test_generate_uses_simple_responses_api_without_live_context(self, openai_cls_mock):
        mock_client = MagicMock()
        mock_client.responses.create.return_value = SimpleNamespace(
            output_text="  clean response  ",
            usage=SimpleNamespace(input_tokens=123, output_tokens=45),
        )
        openai_cls_mock.return_value = mock_client

        provider = OpenAIProvider()
        result = provider.generate(prompt="Summarize this portfolio", model="gpt-4o-mini")

        self.assertEqual(result.content, "clean response")
        self.assertEqual(result.tokens_in, 123)
        self.assertEqual(result.tokens_out, 45)
        self.assertEqual(result.web_search_used, False)
        self.assertEqual(result.web_search_queries, [])
        self.assertEqual(result.web_sources, [])
        mock_client.responses.create.assert_called_once()
        mock_client.chat.completions.create.assert_not_called()

    @patch("app.domains.ai_providers.openai.web_search_tool.execute")
    @patch("app.domains.ai_providers.openai.OpenAI")
    def test_generate_uses_web_search_tool_when_prompt_opts_in(
        self,
        openai_cls_mock,
        web_search_execute_mock,
    ):
        mock_client = MagicMock()
        mock_client.chat.completions.create.side_effect = [
            SimpleNamespace(
                usage=SimpleNamespace(prompt_tokens=200, completion_tokens=60),
                choices=[
                    SimpleNamespace(
                        message=SimpleNamespace(
                            content="",
                            tool_calls=[
                                SimpleNamespace(
                                    id="call_1",
                                    function=SimpleNamespace(
                                        name="web_search",
                                        arguments='{"query":"NIFTY 50 live price today","max_results":3}',
                                    ),
                                )
                            ],
                        )
                    )
                ],
            ),
            SimpleNamespace(
                usage=SimpleNamespace(prompt_tokens=180, completion_tokens=90),
                choices=[
                    SimpleNamespace(
                        message=SimpleNamespace(
                            content="## Summary\n- Main portfolio risk in one sentence: Concentration risk.\n",
                            tool_calls=None,
                        )
                    )
                ],
            ),
        ]
        openai_cls_mock.return_value = mock_client
        web_search_execute_mock.return_value = '{"query":"NIFTY 50 live price today","results":[{"title":"NSE","url":"https://www.nseindia.com"}]}'

        provider = OpenAIProvider()
        result = provider.generate(
            prompt="[ENABLE_WEB_SEARCH]\nAnalyze my current portfolio using the latest market data.",
            model="gpt-4o-mini",
        )

        self.assertIn("## Summary", result.content)
        self.assertEqual(result.tokens_in, 380)
        self.assertEqual(result.tokens_out, 150)
        self.assertEqual(result.web_search_used, True)
        self.assertEqual(result.web_search_queries, ["NIFTY 50 live price today"])
        self.assertEqual(result.web_sources, ["https://www.nseindia.com"])
        web_search_execute_mock.assert_called_once_with(
            "web_search",
            {"query": "NIFTY 50 live price today", "max_results": 3},
        )
        first_call_kwargs = mock_client.chat.completions.create.call_args_list[0].kwargs
        self.assertEqual(first_call_kwargs["tool_choice"], "auto")
        self.assertIn("reformulate the query", first_call_kwargs["messages"][0]["content"])


if __name__ == "__main__":
    unittest.main()
