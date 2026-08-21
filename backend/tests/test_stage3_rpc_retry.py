from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace

from app.domains.polymarket_auto_live.rpc_retry import (
    compute_rpc_retry_delay_seconds,
    extract_retry_after_seconds,
    is_rpc_rate_limited,
    retry_budget_allows,
)
from app.domains.polymarket_auto_live.models import (
    PolymarketAutoLiveOrderAttemptRecord,
    PolymarketAutoLiveOrderIntentRecord,
)
from app.domains.polymarket_auto_live.order_intent_service import (
    _EXECUTABLE_STATUSES,
    _apply_executor_error,
)
from app.domains.polymarket_auto_live.order_intents import AutoLiveExecutorError
from app.domains.polymarket.runtime_broker import _parse_command_category
import app.infrastructure.database.all_models  # noqa: F401


def test_rate_limit_detection_and_retry_after_metadata() -> None:
    response = SimpleNamespace(status_code=429, headers={"Retry-After": "7"})
    assert is_rpc_rate_limited(response)
    assert extract_retry_after_seconds(response) == 7
    assert is_rpc_rate_limited("Bullpen RPC resource exhausted: too many requests")


def test_retry_after_text_does_not_parse_the_429_status_as_the_delay() -> None:
    assert extract_retry_after_seconds("HTTP 429; Retry-After: 11") == 11


def test_exponential_retry_delay_is_jittered_and_bounded() -> None:
    assert compute_rpc_retry_delay_seconds(
        attempt_number=3,
        initial_delay_seconds=2,
        max_delay_seconds=10,
        random_value=1,
    ) == 8
    assert compute_rpc_retry_delay_seconds(
        attempt_number=3,
        initial_delay_seconds=2,
        max_delay_seconds=10,
        retry_after_seconds=17,
    ) == 17


def test_retry_budget_exhaustion_is_deterministic() -> None:
    assert retry_budget_allows(
        retry_count=0,
        total_wait_seconds=5,
        attempts=1,
        max_total_wait_seconds=10,
    )
    assert not retry_budget_allows(
        retry_count=1,
        total_wait_seconds=5,
        attempts=1,
        max_total_wait_seconds=10,
    )


def test_bullpen_write_commands_are_marked_for_the_shared_authenticated_lock() -> None:
    for args in (
        ["polymarket", "sell", "market", "Yes", "1"],
        ["polymarket", "redeem", "condition", "--yes"],
        ["polymarket", "buy", "market", "Yes", "1"],
        ["polymarket", "cancel", "order"],
        ["polymarket", "orders", "--cancel", "order"],
    ):
        _, is_write, requires_auth = _parse_command_category(args)
        assert is_write is True
        assert requires_auth is True
    assert not retry_budget_allows(
        retry_count=0,
        total_wait_seconds=11,
        attempts=1,
        max_total_wait_seconds=10,
    )


def test_stage3_planned_intents_are_executable_for_watchdog_promotion() -> None:
    assert "PLANNED" in _EXECUTABLE_STATUSES


def test_celery_registers_stage3_watchdog_and_routes_to_beat_queue() -> None:
    from app.infrastructure.messaging.celery_app import celery

    task_name = (
        "app.domains.polymarket_auto_live.tasks."
        "watchdog_requeue_stale_auto_live_order_intents"
    )
    assert celery.conf.task_routes[task_name]["queue"] == "beat"
    assert any(entry["task"] == task_name for entry in celery.conf.beat_schedule.values())


def _rate_limited_intent() -> tuple[
    PolymarketAutoLiveOrderIntentRecord,
    PolymarketAutoLiveOrderAttemptRecord,
]:
    intent = PolymarketAutoLiveOrderIntentRecord(
        id="exit-intent",
        user_id=1,
        run_id="run-1",
        decision_id="decision-1",
        action="sell",
        market_id="market-1",
        slug="market-1",
        side="YES",
        requested_shares=10,
        current_shares=10,
        requested_limit_price_cents=50,
        current_limit_price_cents=50,
        max_slippage_cents=2,
        status="SUBMITTING",
        retryable=True,
        attempt_count=1,
        max_attempts=4,
        idempotency_key="auto-live:run-1:decision-1:exit-intent",
        execution_metadata_json={
            "stage3_rpc_retry_policy": {
                "attempts": 2,
                "initial_delay_seconds": 1,
                "max_delay_seconds": 10,
                "max_total_wait_seconds": 20,
            },
            "stage3_rpc_retry_history": [],
            "stage3_rpc_retry_total_wait_seconds": 0,
        },
    )
    attempt = PolymarketAutoLiveOrderAttemptRecord(
        intent_id=intent.id,
        attempt_number=1,
        started_at=datetime.now(UTC),
        result_status="SUBMITTING",
    )
    return intent, attempt


def test_intent_rate_limit_retries_then_exhausts_without_being_terminal_on_first_error() -> None:
    intent, attempt = _rate_limited_intent()
    error = AutoLiveExecutorError(
        code="RPC_RATE_LIMITED",
        message="HTTP 429 Too Many Requests",
        retryable=True,
        retry_after_seconds=3,
    )

    _apply_executor_error(None, record=intent, attempt=attempt, exc=error)  # type: ignore[arg-type]
    assert intent.status == "RETRY_WAIT"
    assert intent.retryable is True
    assert intent.execution_metadata_json["stage3_status"] == "EXIT_RPC_RETRYING"
    assert intent.next_attempt_at is not None
    assert attempt.reconciliation_json["retryable"] is True
    assert attempt.reconciliation_json["next_step"] == "retry_with_backoff"

    intent.status = "SUBMITTING"
    intent.attempt_count = 2
    attempt2 = PolymarketAutoLiveOrderAttemptRecord(
        intent_id=intent.id,
        attempt_number=2,
        started_at=datetime.now(UTC),
        result_status="SUBMITTING",
    )
    _apply_executor_error(None, record=intent, attempt=attempt2, exc=error)  # type: ignore[arg-type]
    assert intent.status == "RETRY_WAIT"

    intent.status = "SUBMITTING"
    intent.attempt_count = 3
    attempt3 = PolymarketAutoLiveOrderAttemptRecord(
        intent_id=intent.id,
        attempt_number=3,
        started_at=datetime.now(UTC),
        result_status="SUBMITTING",
    )
    _apply_executor_error(None, record=intent, attempt=attempt3, exc=error)  # type: ignore[arg-type]
    assert intent.status == "FAILED_PERMANENT"
    assert intent.retryable is False
    assert intent.execution_metadata_json["stage3_status"] == "EXIT_FAILED_PERMANENTLY"
