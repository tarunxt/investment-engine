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

from app.domains.ai_providers.deepseek import DeepSeekProvider, _extract_dsml_web_search_calls


class DeepSeekProviderTests(unittest.TestCase):
    def test_extract_dsml_web_search_calls_parses_queries(self):
        dsml = (
            '<｜｜DSML｜｜tool_calls>\n'
            '<｜｜DSML｜｜invoke name="web_search">\n'
            '<｜｜DSML｜｜parameter name="query" string="true">best breakout stocks India May 2026</｜｜DSML｜｜parameter>\n'
            '<｜｜DSML｜｜parameter name="max_results" string="false">10</｜｜DSML｜｜parameter>\n'
            '</｜｜DSML｜｜invoke>\n'
            '</｜｜DSML｜｜tool_calls>'
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
            '<｜｜DSML｜｜tool_calls>\n'
            '<｜｜DSML｜｜invoke name="web_search">\n'
            '<｜｜DSML｜｜parameter name="query" string="true">Indian stocks bullish breakout February 2025 brokerage upgrade</｜｜DSML｜｜parameter>\n'
            '<｜｜DSML｜｜parameter name="max_results" string="false">5</｜｜DSML｜｜parameter>\n'
            '</｜｜DSML｜｜invoke>\n'
            '</｜｜DSML｜｜tool_calls>'
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
                choices=[SimpleNamespace(message=SimpleNamespace(content=dsml_trace, tool_calls=None))],
            ),
            SimpleNamespace(
                usage=SimpleNamespace(prompt_tokens=200, completion_tokens=120),
                choices=[SimpleNamespace(message=SimpleNamespace(content=recovered_table))],
            ),
        ]
        openai_cls_mock.return_value = mock_client
        web_search_execute_mock.return_value = '{"query":"Indian stocks bullish breakout February 2025 brokerage upgrade","results":[]}'

        provider = DeepSeekProvider()
        result = provider.generate(
            prompt=(
                "Return only one markdown table.\n"
                "Table columns: Stock Symbol, Stock Name, Technical Setup, Entry Range, Units to Buy"
            ),
            model="deepseek-chat",
        )

        self.assertEqual(result.content, recovered_table)
        self.assertEqual(result.tokens_in, 300)
        self.assertEqual(result.tokens_out, 160)
        web_search_execute_mock.assert_called_once_with(
            "web_search",
            {
                "query": "Indian stocks bullish breakout February 2025 brokerage upgrade",
                "max_results": 5,
            },
        )
        second_call_kwargs = mock_client.chat.completions.create.call_args_list[1].kwargs
        self.assertEqual(second_call_kwargs["tool_choice"], "none")
        self.assertIn("Collected search results JSON", second_call_kwargs["messages"][1]["content"])


if __name__ == "__main__":
    unittest.main()
