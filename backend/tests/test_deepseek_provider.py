import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")
os.environ.setdefault("DEEPSEEK_API_KEY", "test-deepseek-key")

from app.domains.ai_providers.deepseek import (
    DeepSeekProvider,
    _extract_dsml_web_search_calls,
)


class DeepSeekProviderTests(unittest.TestCase):
    def test_extract_dsml_web_search_calls_parses_queries(self):
        dsml = (
            "<｜｜DSML｜｜tool_calls>\n"
            '<｜｜DSML｜｜invoke name="web_search">\n'
            '<｜｜DSML｜｜parameter name="query" string="true">best breakout stocks India May 2026</｜｜DSML｜｜parameter>\n'
            '<｜｜DSML｜｜parameter name="max_results" string="false">10</｜｜DSML｜｜parameter>\n'
            "</｜｜DSML｜｜invoke>\n"
            "</｜｜DSML｜｜tool_calls>"
        )

        calls = _extract_dsml_web_search_calls(dsml)

        self.assertEqual(
            calls,
            [{"query": "best breakout stocks India May 2026", "max_results": 8}],
        )

    @patch("app.domains.ai_providers.deepseek.web_search_tool.execute")
    @patch("app.domains.ai_providers.deepseek.OpenAI")
    def test_generate_recovers_from_dsml_tool_trace(
        self,
        openai_cls_mock,
        web_search_execute_mock,
    ):
        dsml_trace = (
            "<｜｜DSML｜｜tool_calls>\n"
            '<｜｜DSML｜｜invoke name="web_search">\n'
            '<｜｜DSML｜｜parameter name="query" string="true">Indian stocks bullish breakout February 2025 brokerage upgrade</｜｜DSML｜｜parameter>\n'
            '<｜｜DSML｜｜parameter name="max_results" string="false">5</｜｜DSML｜｜parameter>\n'
            "</｜｜DSML｜｜invoke>\n"
            "</｜｜DSML｜｜tool_calls>"
        )
        recovered_table = (
            "| Stock Symbol | Stock Name | Technical Setup | Entry Range | Units to Buy |\n"
            "| --- | --- | --- | --- | --- |\n"
            "| TATAMOTORS | Tata Motors | Breakout from daily highs | 655-670 | 75 |\n"
            "| HDFCBANK | HDFC Bank | Accumulation after dip | 1640-1660 | 30 |\n"
            "| RELIANCE | Reliance Industries | Price-volume breakout | 2450-2500 | 20 |\n"
            "| LT | L&T | Bullish channel reversal | 2450-2500 | 20 |\n"
            "| INFY | Infosys | Recovery post pullback | 1400-1430 | 35 |"
        )

        mock_client = MagicMock()
        mock_client.chat.completions.create.side_effect = [
            SimpleNamespace(
                usage=SimpleNamespace(prompt_tokens=100, completion_tokens=40),
                choices=[
                    SimpleNamespace(
                        message=SimpleNamespace(content=dsml_trace, tool_calls=None)
                    )
                ],
            ),
            SimpleNamespace(
                usage=SimpleNamespace(prompt_tokens=200, completion_tokens=120),
                choices=[
                    SimpleNamespace(message=SimpleNamespace(content=recovered_table))
                ],
            ),
        ]
        openai_cls_mock.return_value = mock_client
        web_search_execute_mock.return_value = '{"query":"Indian stocks bullish breakout February 2025 brokerage upgrade","results":[{"title":"Moneycontrol","url":"https://www.moneycontrol.com"}]}'

        provider = DeepSeekProvider()
        result = provider.generate(
            prompt=(
                "Return only one markdown table.\n"
                "Table columns: Stock Symbol, Stock Name, Technical Setup, Entry Range, Units to Buy"
            ),
            model="deepseek-v4-flash",
        )

        self.assertEqual(result.content, recovered_table)
        self.assertEqual(result.tokens_in, 300)
        self.assertEqual(result.tokens_out, 160)
        self.assertEqual(result.cost, 0.000087)
        self.assertEqual(result.web_search_used, True)
        self.assertEqual(
            result.web_search_queries,
            ["Indian stocks bullish breakout February 2025 brokerage upgrade"],
        )
        self.assertEqual(result.web_sources, ["https://www.moneycontrol.com"])
        web_search_execute_mock.assert_called_once_with(
            "web_search",
            {
                "query": "Indian stocks bullish breakout February 2025 brokerage upgrade",
                "max_results": 5,
            },
        )
        second_call_kwargs = mock_client.chat.completions.create.call_args_list[
            1
        ].kwargs
        self.assertEqual(second_call_kwargs["tool_choice"], "none")
        self.assertIn(
            "Collected search results JSON",
            second_call_kwargs["messages"][1]["content"],
        )

    @patch("app.domains.ai_providers.deepseek.OpenAI")
    def test_generate_uses_deepseek_cache_hit_pricing(self, openai_cls_mock):
        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = SimpleNamespace(
            usage=SimpleNamespace(
                prompt_tokens=100_000,
                prompt_cache_hit_tokens=90_000,
                prompt_cache_miss_tokens=10_000,
                completion_tokens=20_000,
            ),
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(
                        content=(
                            "| Stock | Setup | Entry | Stop | Target |\n"
                            "| --- | --- | --- | --- | --- |\n"
                            "| A | Breakout | 1 | 0.9 | 1.2 |\n"
                            "| B | Pullback | 1 | 0.9 | 1.2 |\n"
                            "| C | Momentum | 1 | 0.9 | 1.2 |\n"
                            "| D | Reversal | 1 | 0.9 | 1.2 |\n"
                            "| E | Base | 1 | 0.9 | 1.2 |"
                        ),
                        tool_calls=None,
                    )
                )
            ],
        )
        openai_cls_mock.return_value = mock_client

        provider = DeepSeekProvider()
        result = provider.generate(
            prompt="Return a valid markdown table", model="deepseek-v4-pro"
        )

        self.assertEqual(result.tokens_in, 100_000)
        self.assertEqual(result.tokens_out, 20_000)
        self.assertEqual(result.cost, 0.022076)

    @patch("app.domains.ai_providers.deepseek.OpenAI")
    def test_generate_preserves_valid_json_output_without_table_rewrite(
        self, openai_cls_mock
    ):
        payload = {
            "markets": [
                {
                    "question_ref": "Q1",
                    "question": "Will France beat Iraq?",
                    "llm_yes_odds": 64.25,
                    "llm_no_odds": 35.75,
                    "confidence": "Medium",
                    "reasoning": "France is favored but the match is not certain.",
                }
            ]
        }
        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = SimpleNamespace(
            usage=SimpleNamespace(prompt_tokens=240, completion_tokens=90),
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(
                        content=json.dumps(payload),
                        tool_calls=None,
                    )
                )
            ],
        )
        openai_cls_mock.return_value = mock_client

        provider = DeepSeekProvider()
        result = provider.generate(
            prompt=(
                "Return strict JSON only.\n"
                'Return an object with a top-level "markets" array.\n'
                "Do not include markdown.\n"
                "JSON schema:\n"
                '{"markets":[{"question_ref":"Q1","question":"string","llm_yes_odds":50.00,"llm_no_odds":50.00,"confidence":"Low | Medium | High","reasoning":"short explanation"}]}'
            ),
            model="deepseek-v4-flash",
        )

        self.assertEqual(json.loads(result.content), payload)
        self.assertEqual(result.tokens_in, 240)
        self.assertEqual(result.tokens_out, 90)
        mock_client.chat.completions.create.assert_called_once()

    def test_token_usage_treats_missing_cache_breakdown_as_cache_miss(self):
        token_usage = DeepSeekProvider._token_usage_from_response_usage(
            SimpleNamespace(prompt_tokens=100_000, completion_tokens=20_000)
        )

        self.assertEqual(
            token_usage,
            {
                "tokens_in": 100_000,
                "tokens_out": 20_000,
                "cache_hit_tokens": 0,
                "cache_miss_tokens": 100_000,
            },
        )


if __name__ == "__main__":
    unittest.main()
