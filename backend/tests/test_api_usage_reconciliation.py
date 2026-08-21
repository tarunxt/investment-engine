from types import SimpleNamespace

from app.domains.api_usage.corrected_router import (
    _aggregate_usage,
    _classify_job_usage,
    _job_request_count,
)


def _job(**overrides):
    values = {
        "runtime_metadata_json": {},
        "web_search_queries": [],
        "request_context_json": {},
        "prompt": "",
        "auto_rebalance_portfolio": None,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_bullpen_batch_attempts_are_counted_as_provider_requests():
    job = _job(
        runtime_metadata_json={
            "llm_batches": [
                {"batch_id": "a", "attempts": 2},
                {"batch_id": "b", "attempts": 1},
                {"batch_id": "recovery", "attempts": 3},
            ]
        }
    )

    assert _job_request_count(job) == 6


def test_bullpen_runtime_counters_are_used_when_batch_rows_are_unavailable():
    job = _job(
        runtime_metadata_json={
            "llm_primary_request_count": 3,
            "llm_retry_request_count": 2,
            "llm_recovery_batch_count": 1,
        }
    )

    assert _job_request_count(job) == 6


def test_web_search_rounds_are_a_conservative_request_lower_bound():
    job = _job(web_search_queries=["q1", "q2", "q1"])

    assert _job_request_count(job) == 3


def test_workflow_classification_covers_bullpen_zerodha_and_indmoney():
    bullpen = _job(request_context_json={"kind": "polymarket_bullpen_event"})
    zerodha = _job(prompt="[ZERODHA_EVENTS] analyse", auto_rebalance_portfolio="india")
    indmoney = _job(prompt="[INDMONEY_US_THREATS] analyse")

    assert _classify_job_usage(bullpen)[0] == "bullpen"
    assert _classify_job_usage(zerodha)[0] == "zerodha"
    assert _classify_job_usage(indmoney)[0] == "indmoney"


def test_usage_aggregation_keeps_model_and_workflow_breakdown():
    rows = [
        {
            "provider": "deepseek",
            "provider_name": "DeepSeek",
            "model": "deepseek-v4-flash",
            "source": "bullpen",
            "source_label": "Bullpen",
            "workflow": "Bullpen Stage 2 event analysis",
            "requests": 5,
            "tokens_in": 1000,
            "tokens_out": 100,
            "estimated_cost": 0.25,
        },
        {
            "provider": "deepseek",
            "provider_name": "DeepSeek",
            "model": "deepseek-v4-flash",
            "source": "zerodha",
            "source_label": "Zerodha",
            "workflow": "Zerodha event/threat/rebalance analysis",
            "requests": 1,
            "tokens_in": 200,
            "tokens_out": 20,
            "estimated_cost": 0.05,
        },
    ]

    items, totals = _aggregate_usage(rows, usd_inr_rate=90.0)

    assert len(items) == 2
    assert totals["deepseek"]["requests"] == 6
    assert totals["deepseek"]["tokens_in"] == 1200
    assert totals["deepseek"]["cost"] == 0.3
    assert {item["source"] for item in items} == {"bullpen", "zerodha"}
    assert {item["estimated_cost_inr"] for item in items} == {22.5, 4.5}
