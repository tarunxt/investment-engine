import os
import unittest
from unittest.mock import patch

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

from app.domains.ai_providers.tools import web_search  # noqa: E402


class WebSearchToolTests(unittest.TestCase):
    @patch("app.domains.ai_providers.tools.web_search._bing_rss_search")
    @patch("app.domains.ai_providers.tools.web_search._ddg_search")
    def test_web_search_falls_back_to_bing_when_ddg_is_empty(
        self,
        ddg_search_mock,
        bing_rss_search_mock,
    ):
        ddg_search_mock.return_value = '{"query":"AMD earnings date","answer":null,"results":[]}'
        bing_rss_search_mock.return_value = (
            '{"query":"AMD earnings date","answer":null,"results":[{"title":"AMD IR","url":"https://example.com"}]}'
        )

        with patch.object(web_search.settings, "tavily_api_key", None):
            payload = web_search._web_search("AMD earnings date", 5)

        self.assertTrue(web_search._payload_has_results(payload))
        ddg_search_mock.assert_called_once_with("AMD earnings date", 5)
        bing_rss_search_mock.assert_called_once_with("AMD earnings date", 5)

    @patch("app.domains.ai_providers.tools.web_search.requests.get")
    def test_bing_rss_search_parses_items(self, requests_get_mock):
        requests_get_mock.return_value = unittest.mock.Mock(
            text=(
                "<?xml version='1.0' encoding='utf-8'?>"
                "<rss version='2.0'><channel>"
                "<item>"
                "<title>AMD Investor Relations</title>"
                "<link>https://ir.amd.com/events</link>"
                "<description><![CDATA[Upcoming events &amp; earnings date]]></description>"
                "<pubDate>Sat, 30 May 2026 10:00:00 GMT</pubDate>"
                "</item>"
                "</channel></rss>"
            )
        )
        requests_get_mock.return_value.raise_for_status.return_value = None

        payload = web_search._bing_rss_search("AMD earnings date", 5)

        self.assertTrue(web_search._payload_has_results(payload))
        self.assertIn("AMD Investor Relations", payload)
        self.assertIn("https://ir.amd.com/events", payload)


if __name__ == "__main__":
    unittest.main()
