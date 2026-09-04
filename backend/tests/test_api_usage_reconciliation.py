from types import SimpleNamespace
from datetime import UTC, datetime

from app.domains.api_usage.corrected_router import (
    _aggregate_run_items,
    _aggregate_usage,
    _classify_job_usage,
    _effective_usage_rows,
    _job_request_count,
    _run_breakdown_rows,
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


def _usage_row(*, day: int, source: str, requests: int, tokens_in: int, cost: float):
    return {
        "provider": "deepseek",
        "provider_name": "DeepSeek",
        "model": "deepseek-v4-flash",
        "source": source,
        "source_label": source,
        "workflow": source,
        "requests": requests,
        "tokens_in": tokens_in,
        "tokens_out": 10,
        "estimated_cost": cost,
        "occurred_at": datetime(2026, 9, day, 6, tzinfo=UTC),
        "record_kind": source,
        "record_id": day,
    }


def test_provider_snapshot_replaces_incomplete_job_estimate_for_same_day():
    local = [_usage_row(day=3, source="job", requests=163, tokens_in=1_025_454, cost=0.1018)]
    snapshot = [_usage_row(day=3, source="provider_snapshot", requests=232, tokens_in=4_238_239, cost=2.84)]

    rows = _effective_usage_rows(local, [], snapshot)

    assert rows == snapshot


def test_durable_provider_calls_replace_jobs_after_ledger_rollout():
    local = [_usage_row(day=5, source="job", requests=1, tokens_in=100, cost=0.01)]
    calls = [_usage_row(day=5, source="provider_ledger", requests=1, tokens_in=500, cost=0.05)]

    rows = _effective_usage_rows(local, calls, [])

    assert rows == calls
    assert rows[0]["measurement"] == "actual"


def test_rollout_day_keeps_job_estimate_until_full_day_ledger_exists():
    local = [_usage_row(day=4, source="job", requests=2, tokens_in=200, cost=0.02)]
    partial_calls = [_usage_row(day=4, source="provider_ledger", requests=1, tokens_in=100, cost=0.01)]

    rows = _effective_usage_rows(local, partial_calls, [])

    assert rows == local
    assert rows[0]["measurement"] == "estimated"


def test_provider_snapshot_is_reconciled_across_usage_areas_and_runs():
    local = [
        _usage_row(day=3, source="indmoney", requests=85, tokens_in=498_561, cost=0.055),
        _usage_row(day=3, source="zerodha", requests=78, tokens_in=526_893, cost=0.047),
        _usage_row(day=3, source="bullpen", requests=40, tokens_in=2_000_000, cost=0.9),
    ]
    for job_id, row in enumerate(local, start=100):
        row.update(
            {
                "job_id": job_id,
                "app_run_id": job_id + 1000,
                "run_number": job_id,
                "run_label": f"Run #{job_id}",
                "stage": 1,
                "status": "completed",
            }
        )
    snapshot = _usage_row(
        day=3,
        source="provider_snapshot",
        requests=232,
        tokens_in=4_238_239,
        cost=2.84,
    )
    snapshot.update(
        {
            "tokens_out": 2_708_635,
            "cache_hit_tokens": 1_085_568,
            "cache_miss_tokens": 3_152_671,
        }
    )

    rows = _run_breakdown_rows(local, [], [snapshot])

    assert {row["source"] for row in rows} == {"indmoney", "zerodha", "bullpen"}
    assert sum(row["requests"] for row in rows) == 232
    assert sum(row["tokens_in"] for row in rows) == 4_238_239
    assert sum(row["tokens_out"] for row in rows) == 2_708_635
    assert round(sum(row["estimated_cost"] for row in rows), 6) == 2.84
    assert {row["measurement"] for row in rows} == {"reconciled"}


def test_bullpen_run_receives_unlinked_provider_call_remainder():
    local = [
        _usage_row(day=3, source="indmoney", requests=85, tokens_in=498_561, cost=0.055),
        _usage_row(day=3, source="zerodha", requests=78, tokens_in=526_893, cost=0.047),
        _usage_row(day=3, source="bullpen", requests=1, tokens_in=0, cost=0),
    ]
    local[-1]["record_kind"] = "bullpen_auto_live_run"
    snapshot = _usage_row(
        day=3,
        source="provider_snapshot",
        requests=232,
        tokens_in=4_238_239,
        cost=2.84,
    )
    snapshot["tokens_out"] = 2_708_635

    rows = _run_breakdown_rows(local, [], [snapshot])
    bullpen = next(row for row in rows if row["source"] == "bullpen")

    assert bullpen["requests"] == 69
    assert bullpen["tokens_in"] > 0
    assert bullpen["tokens_out"] > 0
    assert bullpen["estimated_cost"] > 0
    assert sum(row["requests"] for row in rows) == 232
    assert sum(row["tokens_in"] for row in rows) == 4_238_239
    assert sum(row["tokens_out"] for row in rows) == 2_708_635
    assert round(sum(row["estimated_cost"] for row in rows), 6) == 2.84


def test_provider_calls_are_grouped_into_one_individual_run_row():
    calls = []
    for record_id, cost in ((1, 0.12), (2, 0.18)):
        row = _usage_row(
            day=5,
            source="bullpen",
            requests=1,
            tokens_in=500,
            cost=cost,
        )
        row.update(
            {
                "record_id": record_id,
                "record_kind": "provider_usage_call",
                "job_id": 42,
                "app_run_id": 24,
                "run_number": 24,
                "run_label": "Run #24",
                "stage": 1,
                "status": "completed",
                "measurement": "actual",
            }
        )
        calls.append(row)

    run_items = _aggregate_run_items(calls, usd_inr_rate=90.0)

    assert len(run_items) == 1
    assert run_items[0]["run_label"] == "Run #24"
    assert run_items[0]["requests"] == 2
    assert run_items[0]["tokens_in"] == 1000
    assert run_items[0]["estimated_cost"] == 0.3
    assert run_items[0]["estimated_cost_inr"] == 27.0
    assert run_items[0]["measurement"] == "actual"
