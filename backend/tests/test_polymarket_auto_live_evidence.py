from app.domains.polymarket_auto_live.evidence import _source_type


def test_evidence_source_type_handles_compiled_pattern_groups() -> None:
    assert _source_type("www.reuters.com") == "major_news"
    assert _source_type("techcrunch.com") == "specialist_news"
    assert _source_type("news.google.com") == "aggregator"
    assert _source_type("state.gov") == "official_government"
    assert _source_type("chatgpt.com") == "unknown"
