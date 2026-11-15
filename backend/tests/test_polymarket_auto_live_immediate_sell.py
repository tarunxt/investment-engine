import json

import pytest

from app.domains.polymarket.bullpen import BullpenCommandError
from app.domains.polymarket_auto_live import order_intent_service
from app.domains.polymarket_auto_live.immediate_sell import (
    IMMEDIATE_SELL_MIN_PRICE,
    submit_immediate_sell_with_fallbacks,
    validate_immediate_sell_response,
)
from app.domains.polymarket_auto_live.order_intent_service import (
    PreparedIntentSubmission,
    _submit_prepared_intent,
)
from app.domains.polymarket_auto_live.order_intents import AutoLiveExecutorError


class _Executor:
    def __init__(
        self,
        *,
        primary: object,
        secondary: object = AssertionError("secondary fallback must not run"),
        tertiary: object = AssertionError("tertiary fallback must not run"),
    ) -> None:
        self.results = {
            "market_sell_explicit": primary,
            "market_sell_max": secondary,
            "limit_sell_fak": tertiary,
        }
        self.calls: list[tuple[str, dict[str, object]]] = []

    async def _run(self, path: str, kwargs: dict[str, object]) -> str:
        self.calls.append((path, kwargs))
        result = self.results[path]
        if isinstance(result, BaseException):
            raise result
        assert isinstance(result, str)
        return result

    async def sell_limit(self, **kwargs) -> str:
        return await self._run("market_sell_explicit", kwargs)

    async def sell_max_market(self, **kwargs) -> str:
        return await self._run("market_sell_max", kwargs)

    async def sell_fak_limit(self, **kwargs) -> str:
        return await self._run("limit_sell_fak", kwargs)


async def _submit(executor: _Executor):
    return await submit_immediate_sell_with_fallbacks(
        executor=executor,  # type: ignore[arg-type]
        market_id="will-this-exit",
        outcome="Yes",
        shares=12.345678,
        extra_env={"POLYMARKET_POLYGON_RPC_URLS": "https://rpc.invalid"},
        provider_alias="rpc-1",
    )


@pytest.mark.anyio
async def test_primary_market_sell_is_aggressive_validated_and_single_write():
    executor = _Executor(
        primary=json.dumps(
            {
                "status": "ok",
                "result": {
                    "success": True,
                    "status": "matched",
                    "order_id": "order-primary",
                    "filled_size": 12.345678,
                    "avg_price": 0.61,
                },
            }
        )
    )

    result = await _submit(executor)

    assert result.selected_layer == "primary"
    assert result.execution_path == "market_sell_explicit"
    assert [item["result"] for item in result.fallback_history] == ["accepted"]
    assert [path for path, _kwargs in executor.calls] == ["market_sell_explicit"]
    primary_kwargs = executor.calls[0][1]
    assert primary_kwargs["min_price"] == IMMEDIATE_SELL_MIN_PRICE
    assert primary_kwargs["max_reprice_attempts"] == 0


@pytest.mark.anyio
async def test_secondary_max_market_sell_handles_verified_share_validation_failure():
    executor = _Executor(
        primary=json.dumps(
            {
                "status": "unmatched",
                "success": False,
                "filled_size": 0,
                "error": "No shares matched the explicit sell.",
            }
        ),
        secondary=json.dumps(
            {
                "status": "ok",
                "result": {
                    "success": True,
                    "status": "matched",
                    "order_id": "order-max",
                },
            }
        ),
    )

    result = await _submit(executor)

    assert result.selected_layer == "secondary"
    assert result.execution_path == "market_sell_max"
    assert [item["result"] for item in result.fallback_history] == [
        "fallback",
        "accepted",
    ]
    assert [path for path, _kwargs in executor.calls] == [
        "market_sell_explicit",
        "market_sell_max",
    ]


@pytest.mark.anyio
async def test_tertiary_fak_sell_runs_once_after_two_verified_unsupported_paths():
    executor = _Executor(
        primary=BullpenCommandError("unknown command polymarket sell"),
        secondary=BullpenCommandError("unexpected argument --max"),
        tertiary=json.dumps(
            {
                "status": "submitted",
                "order_id": "order-fak",
            }
        ),
    )

    result = await _submit(executor)

    assert result.selected_layer == "tertiary"
    assert result.execution_path == "limit_sell_fak"
    assert [item["result"] for item in result.fallback_history] == [
        "fallback",
        "fallback",
        "accepted",
    ]
    assert [path for path, _kwargs in executor.calls] == [
        "market_sell_explicit",
        "market_sell_max",
        "limit_sell_fak",
    ]
    assert executor.calls[-1][1]["price"] == IMMEDIATE_SELL_MIN_PRICE


@pytest.mark.anyio
async def test_structured_invalid_result_can_trigger_safe_fallback():
    executor = _Executor(
        primary=json.dumps(
            {
                "status": "invalid",
                "success": False,
                "filled_size": 0,
                "error": "Share precision is invalid.",
            }
        ),
        secondary=json.dumps({"status": "submitted", "order_id": "order-max"}),
    )

    result = await _submit(executor)

    assert result.execution_path == "market_sell_max"
    assert (
        result.fallback_history[0]["validation"]
        == "verified_zero_write_argument_failure"
    )
    assert result.fallback_history[0]["safe_to_fallback"] is True


def test_structured_unsupported_zero_fill_result_is_safe_to_fallback():
    validation = validate_immediate_sell_response(
        {
            "status": "unsupported",
            "success": False,
            "filled_size": 0,
        }
    )

    assert validation.accepted is False
    assert validation.safe_to_fallback is True
    assert validation.validation == "verified_zero_write_argument_failure"


@pytest.mark.anyio
@pytest.mark.parametrize(
    "primary",
    [
        "{}",
        "not-json",
        json.dumps(
            {
                "status": "cancelled",
                "success": False,
                "filled_size": 0,
            }
        ),
        TimeoutError("Bullpen sell command timed out after 45s"),
    ],
)
async def test_ambiguous_primary_result_never_issues_duplicate_fallback(primary):
    executor = _Executor(primary=primary)

    with pytest.raises(AutoLiveExecutorError) as exc_info:
        await _submit(executor)

    assert exc_info.value.code == "AMBIGUOUS_SUBMISSION"
    assert exc_info.value.ambiguous_submission is True
    assert len(exc_info.value.fallback_history) == 1
    assert exc_info.value.fallback_history[0]["result"] == "ambiguous"
    assert [path for path, _kwargs in executor.calls] == ["market_sell_explicit"]


@pytest.mark.anyio
async def test_fallback_chain_is_bounded_at_exactly_three_paths():
    executor = _Executor(
        primary=BullpenCommandError("unknown command polymarket sell"),
        secondary=BullpenCommandError("unexpected argument --max"),
        tertiary=BullpenCommandError("unknown command polymarket limit-sell"),
    )

    with pytest.raises(AutoLiveExecutorError) as exc_info:
        await _submit(executor)

    assert exc_info.value.code == "SELL_FALLBACK_EXHAUSTED"
    assert exc_info.value.retryable is False
    assert len(exc_info.value.fallback_history) == 3
    assert [path for path, _kwargs in executor.calls] == [
        "market_sell_explicit",
        "market_sell_max",
        "limit_sell_fak",
    ]


@pytest.mark.anyio
@pytest.mark.parametrize(
    "primary",
    [
        BullpenCommandError("provider rejected sell after order verification"),
        BullpenCommandError(
            json.dumps(
                {
                    "status": "cancelled",
                    "success": False,
                    "filled_size": 0,
                }
            )
        ),
        BullpenCommandError(
            json.dumps(
                {
                    "status": "failed",
                    "success": False,
                    "filled_size": 0,
                }
            )
        ),
    ],
)
async def test_generic_failure_or_cancellation_never_issues_fallback(primary):
    executor = _Executor(primary=primary)

    with pytest.raises(AutoLiveExecutorError) as exc_info:
        await _submit(executor)

    assert exc_info.value.code == "AMBIGUOUS_SUBMISSION"
    assert exc_info.value.ambiguous_submission is True
    assert [path for path, _kwargs in executor.calls] == ["market_sell_explicit"]


@pytest.mark.anyio
async def test_write_time_rate_limit_enters_reconciliation_without_resubmit():
    executor = _Executor(
        primary=BullpenCommandError("429 RPC rate limit exceeded after submission")
    )

    with pytest.raises(AutoLiveExecutorError) as exc_info:
        await _submit(executor)

    assert exc_info.value.code == "AMBIGUOUS_SUBMISSION"
    assert exc_info.value.retryable is True
    assert exc_info.value.ambiguous_submission is True
    assert exc_info.value.fallback_history[0]["result"] == "ambiguous"
    assert (
        exc_info.value.fallback_history[0]["validation"] == "exception:RPC_RATE_LIMITED"
    )
    assert [path for path, _kwargs in executor.calls] == ["market_sell_explicit"]


@pytest.mark.anyio
async def test_cancelled_response_with_positive_fill_is_accepted_not_replayed():
    executor = _Executor(
        primary=json.dumps(
            {
                "status": "cancelled",
                "success": False,
                "filled_size": 4.5,
                "order_id": "partially-filled-order",
            }
        )
    )

    result = await _submit(executor)

    assert result.selected_layer == "primary"
    assert result.fallback_history[0]["result"] == "accepted"
    assert [path for path, _kwargs in executor.calls] == ["market_sell_explicit"]


def test_remote_reference_is_accepted_even_when_status_vocabulary_is_unknown():
    validation = validate_immediate_sell_response(
        {
            "status": "future_status",
            "result": {"order_id": "remote-order-1"},
        }
    )

    assert validation.accepted is True
    assert validation.safe_to_fallback is False
    assert validation.validation == "remote_reference_present"


def test_positive_making_amount_blocks_fallback_even_without_order_reference():
    validation = validate_immediate_sell_response(
        {
            "status": "cancelled",
            "success": False,
            "making_amount": "4500000",
        }
    )

    assert validation.accepted is True
    assert validation.safe_to_fallback is False
    assert validation.validation == "positive_fill_present"


@pytest.mark.anyio
async def test_durable_submission_persists_selected_path_and_matched_fill(monkeypatch):
    executor = _Executor(
        primary=json.dumps(
            {
                "status": "ok",
                "result": {
                    "success": True,
                    "status": "matched",
                    "order_id": "order-filled",
                    "filled_size": 12.345678,
                    "avg_price": 0.61,
                },
            }
        )
    )
    monkeypatch.setenv("AUTO_LIVE_EXECUTION_V2_SHADOW_ONLY", "false")
    monkeypatch.setattr(
        order_intent_service,
        "BullpenLiveExecutor",
        lambda: executor,
    )

    result = await _submit_prepared_intent(
        PreparedIntentSubmission(
            intent_id="intent-sell",
            user_id=7,
            action="sell",
            side="YES",
            market_id="market-sell",
            slug="will-this-exit",
            condition_ids=[],
            order_usd=None,
            shares=12.345678,
            limit_price_cents=61,
            available_balance_usd=None,
            provider_attempts=[("rpc-1", {})],
            detail="ready",
        )
    )

    assert result.status == "SETTLEMENT_PENDING"
    assert result.retryable is True
    assert result.next_attempt_at is not None
    assert result.execution_path == "market_sell_explicit"
    assert result.current_limit_price_cents == 1
    assert result.filled_shares == 12.345678
    assert result.remaining_shares == 0
    assert result.average_fill_price_cents == 61
    assert result.raw_response is not None
    assert result.raw_response["_stage3_immediate_sell"]["fallback_count"] == 0


@pytest.mark.anyio
async def test_partial_fak_fill_stays_nonterminal_for_wallet_reconciliation(
    monkeypatch,
):
    executor = _Executor(
        primary=json.dumps(
            {
                "status": "cancelled",
                "success": False,
                "order_id": "order-partial",
                "filled_size": 4.5,
                "avg_price": 0.37,
            }
        )
    )
    monkeypatch.setenv("AUTO_LIVE_EXECUTION_V2_SHADOW_ONLY", "false")
    monkeypatch.setattr(
        order_intent_service,
        "BullpenLiveExecutor",
        lambda: executor,
    )

    result = await _submit_prepared_intent(
        PreparedIntentSubmission(
            intent_id="intent-partial-sell",
            user_id=7,
            action="sell",
            side="YES",
            market_id="market-sell",
            slug="will-this-exit",
            condition_ids=[],
            order_usd=None,
            shares=12.345678,
            limit_price_cents=61,
            available_balance_usd=None,
            provider_attempts=[("rpc-1", {})],
            detail="ready",
        )
    )

    assert result.status == "PARTIALLY_FILLED"
    assert result.retryable is True
    assert result.filled_shares == 4.5
    assert result.remaining_shares == pytest.approx(7.845678)
    assert result.next_attempt_at is not None


@pytest.mark.anyio
async def test_durable_sell_never_fails_over_rpc_after_ambiguous_write(monkeypatch):
    executor = _Executor(primary=TimeoutError("write timed out"))
    monkeypatch.setenv("AUTO_LIVE_EXECUTION_V2_SHADOW_ONLY", "false")
    monkeypatch.setattr(
        order_intent_service,
        "BullpenLiveExecutor",
        lambda: executor,
    )

    with pytest.raises(AutoLiveExecutorError) as exc_info:
        await _submit_prepared_intent(
            PreparedIntentSubmission(
                intent_id="intent-ambiguous",
                user_id=7,
                action="sell",
                side="YES",
                market_id="market-sell",
                slug="will-this-exit",
                condition_ids=[],
                order_usd=None,
                shares=12.345678,
                limit_price_cents=61,
                available_balance_usd=None,
                provider_attempts=[("rpc-1", {}), ("rpc-2", {})],
                detail="ready",
            )
        )

    assert exc_info.value.code == "AMBIGUOUS_SUBMISSION"
    assert [path for path, _kwargs in executor.calls] == ["market_sell_explicit"]
