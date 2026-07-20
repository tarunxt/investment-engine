import pytest

from app.domains.polymarket.bullpen import (
    BULLPEN_REDEEMED_HISTORY_COMMAND_VARIANTS,
    BULLPEN_TRADE_HISTORY_COMMAND_VARIANTS,
)
from app.domains.polymarket_auto_live.order_intents import (
    build_order_funnel,
    build_order_plan_from_intent,
    classify_executor_error,
    derive_run_status_from_intents,
)
from app.domains.polymarket_auto_live.order_intent_service import (
    STAGE3_ORDER_INTENT_IDEMPOTENCY_KEY_FORMAT,
    STAGE3_ORDER_INTENT_IDEMPOTENCY_KEY_MAX_LENGTH,
    _assert_intent_has_no_persisted_submission_reference,
    _assert_intent_retry_allowed,
    _auth_recovery_allows_operator_resume,
    _extract_remote_refs,
    _intent_requires_operator_resume_reconciliation,
    _matched_buy_submission_fill,
    _persisted_stage3_counts,
    _remaining_position_is_economic_dust,
    _reconciliation_snapshot_is_current,
    build_stage3_order_intent_idempotency_key,
    stage3_execution_market_reference,
)
from app.domains.polymarket_auto_live.schemas import (
    BullpenAutoLiveOrderIntent,
    BullpenAutoLiveOrderPlan,
)


def _intent(
    *,
    intent_id: str,
    status: str,
    action: str = "buy",
    attempt_count: int = 0,
    first_submitted_at: str | None = None,
    confirmed_at: str | None = None,
    filled_shares: float = 0.0,
    remaining_shares: float = 0.0,
    retryable: bool = True,
    last_error_code: str | None = None,
) -> BullpenAutoLiveOrderIntent:
    return BullpenAutoLiveOrderIntent(
        id=intent_id,
        user_id=1,
        run_id="run-1",
        decision_id=f"decision-{intent_id}",
        action=action,  # type: ignore[arg-type]
        market_id=f"market-{intent_id}",
        side="YES",
        requested_order_usd=5.0,
        requested_shares=6.25,
        requested_limit_price_cents=80.0,
        current_order_usd=5.0,
        current_shares=6.25,
        current_limit_price_cents=80.0,
        max_slippage_cents=2.0,
        status=status,  # type: ignore[arg-type]
        retryable=retryable,
        attempt_count=attempt_count,
        max_attempts=4,
        priority=100,
        idempotency_key=f"idem-{intent_id}",
        reserved_cash_usd=5.0 if action == "buy" else 0.0,
        expected_release_usd=0.0,
        confirmed_release_usd=0.0,
        filled_shares=filled_shares,
        remaining_shares=remaining_shares,
        dependency_metadata_json={},
        execution_metadata_json={},
        version=1,
        created_at="2026-07-18T10:00:00+00:00",
        updated_at="2026-07-18T10:00:00+00:00",
        first_submitted_at=first_submitted_at,
        confirmed_at=confirmed_at,
        attempts=[],
        reservations=[],
        last_error_code=last_error_code,
    )


def test_stage3_order_intent_idempotency_key_is_bounded_and_deterministic():
    identity = {
        "run_id": "110e5c01-9a27-45de-b91d-cabc563a1aec",
        "decision_id": f"decision-exit-{'d' * 96}",
        "order_plan_id": f"order-exit-{'o' * 96}",
    }
    legacy_key = (
        f"auto-live:{identity['run_id']}:{identity['decision_id']}:"
        f"{identity['order_plan_id']}"
    )

    first = build_stage3_order_intent_idempotency_key(**identity)
    second = build_stage3_order_intent_idempotency_key(**identity)
    changed = build_stage3_order_intent_idempotency_key(
        **{**identity, "order_plan_id": f"order-exit-{'x' * 96}"}
    )

    assert len(legacy_key) > STAGE3_ORDER_INTENT_IDEMPOTENCY_KEY_MAX_LENGTH
    assert first == second
    assert first != changed
    assert first.startswith(f"{STAGE3_ORDER_INTENT_IDEMPOTENCY_KEY_FORMAT}:")
    assert len(first) <= STAGE3_ORDER_INTENT_IDEMPOTENCY_KEY_MAX_LENGTH


def test_stage3_execution_market_reference_prefers_cli_slug():
    assert (
        stage3_execution_market_reference(
            slug="will-this-market-resolve-yes",
            market_id="2952467",
        )
        == "will-this-market-resolve-yes"
    )


def test_nested_bullpen_matched_buy_response_is_normalized():
    payload = {
        "status": "ok",
        "result": {
            "success": True,
            "status": "matched",
            "order_id": "0xorder",
            "transaction_hash": "0xtx",
            "filled_size": 1.820893,
            "avg_price": 0.67,
        },
    }

    assert _extract_remote_refs(payload) == ("0xorder", "0xtx")
    assert _matched_buy_submission_fill(payload) == (1.820893, 67.0)


def test_nonterminal_bullpen_buy_response_stays_unconfirmed():
    payload = {
        "status": "ok",
        "result": {
            "success": True,
            "status": "open",
            "order_id": "0xorder",
            "transaction_hashes": ["0xtx"],
        },
    }

    assert _extract_remote_refs(payload) == ("0xorder", "0xtx")
    assert _matched_buy_submission_fill(payload) is None
    assert (
        stage3_execution_market_reference(slug=None, market_id="legacy-market-ref")
        == "legacy-market-ref"
    )


def test_auth_recovery_requires_explicit_operator_resume_timestamp():
    assert (
        _auth_recovery_allows_operator_resume({"historical_error_stale": True})
        is False
    )
    assert (
        _auth_recovery_allows_operator_resume(
            {
                "historical_error_stale": True,
                "operator_resume_at": "2026-07-20T15:00:00+00:00",
            }
        )
        is True
    )


def test_stage3_history_readers_prefer_current_bullpen_orders_command():
    expected_prefix = ["polymarket", "orders", "--history"]

    assert BULLPEN_TRADE_HISTORY_COMMAND_VARIANTS[0][:3] == expected_prefix
    assert BULLPEN_REDEEMED_HISTORY_COMMAND_VARIANTS[0][:3] == expected_prefix


def test_remaining_exit_precision_dust_is_economically_inactive():
    intent = _intent(intent_id="dust-exit", status="CONFIRMING", action="sell")
    intent.current_limit_price_cents = 80

    assert _remaining_position_is_economic_dust(intent, remaining_shares=0.005)
    assert not _remaining_position_is_economic_dust(intent, remaining_shares=0.02)


def test_classify_executor_error_marks_write_timeout_as_ambiguous_submission():
    error = classify_executor_error(
        "Command timed out after 45s",
        during_write=True,
        provider_alias="rpc-1",
    )

    assert error.code == "AMBIGUOUS_SUBMISSION"
    assert error.retryable is True
    assert error.ambiguous_submission is True
    assert error.provider_alias == "rpc-1"


def test_build_order_funnel_keeps_settlement_pending_out_of_confirmed_rate():
    intents = [
        _intent(
            intent_id="submitted",
            status="SUBMITTED",
            attempt_count=1,
            first_submitted_at="2026-07-18T10:00:05+00:00",
        ),
        _intent(
            intent_id="pending",
            status="SETTLEMENT_PENDING",
            action="sell",
            attempt_count=1,
            first_submitted_at="2026-07-18T10:00:06+00:00",
        ),
        _intent(
            intent_id="confirmed",
            status="CONFIRMED",
            attempt_count=1,
            first_submitted_at="2026-07-18T10:00:07+00:00",
            confirmed_at="2026-07-18T10:00:30+00:00",
        ),
    ]

    funnel = build_order_funnel(intents)

    assert funnel.planned == 3
    assert funnel.remotely_accepted == 3
    assert funnel.confirmed == 1
    assert funnel.settlement_pending == 1
    assert funnel.confirmation_rate == round(1 / 3, 4)
    assert funnel.terminal_success_rate == round(1 / 3, 4)


def test_derive_run_status_from_intents_returns_partial_success_for_mixed_terminal_outcomes():
    intents = [
        _intent(
            intent_id="success",
            status="FILLED",
            attempt_count=1,
            first_submitted_at="2026-07-18T10:00:07+00:00",
            confirmed_at="2026-07-18T10:00:30+00:00",
            filled_shares=6.25,
            remaining_shares=0.0,
        ),
        _intent(
            intent_id="failed",
            status="FAILED_PERMANENT",
            action="sell",
            attempt_count=2,
            retryable=False,
        ),
    ]

    assert derive_run_status_from_intents(intents) == "partial_success"


def test_build_order_plan_from_intent_carries_retry_and_fill_metadata():
    order_plan = BullpenAutoLiveOrderPlan(
        id="order-1",
        action="buy",
        side="YES",
        status="planned",
        market_id="market-1",
        market_title="Will this fill?",
        order_size_usd=5.0,
        shares=6.25,
        limit_price_cents=80.0,
        max_slippage_cents=2.0,
        dry_run=False,
        detail="Order planned.",
        created_at="2026-07-18T10:00:00+00:00",
    )
    intent = _intent(
        intent_id="order-1",
        status="PARTIALLY_FILLED",
        attempt_count=2,
        first_submitted_at="2026-07-18T10:00:05+00:00",
        filled_shares=2.5,
        remaining_shares=3.75,
        last_error_code="QUOTE_STALE",
    ).model_copy(
        update={
            "next_attempt_at": "2026-07-18T10:01:00+00:00",
            "last_error_message": "Quote was refreshed for a follow-up confirmation pass.",
            "execution_metadata_json": {"provider_alias": "rpc-2", "reservation_state": "active"},
            "dependency_metadata_json": {"state": "ready"},
        }
    )

    updated = build_order_plan_from_intent(order_plan, intent)

    assert updated.status == "partially_filled"
    assert updated.attempt_count == 2
    assert updated.next_retry_at == "2026-07-18T10:01:00+00:00"
    assert updated.provider_alias == "rpc-2"
    assert updated.latest_error_code == "QUOTE_STALE"
    assert updated.filled_shares == 2.5
    assert updated.remaining_shares == 3.75


def test_stage3_counters_are_reconciled_from_persisted_order_intents():
    intents = [
        _intent(intent_id="exit-submitted", status="CONFIRMING", action="sell").model_copy(
            update={
                "attempt_count": 1,
                "remote_order_id": "remote-exit-1",
                "first_submitted_at": "2026-07-20T12:00:05+00:00",
            }
        ),
        _intent(intent_id="exit-deferred", status="DEFERRED", action="redeem"),
        _intent(intent_id="buy-ready", status="READY", action="buy"),
        _intent(intent_id="buy-failed", status="FAILED_PERMANENT", action="buy").model_copy(
            update={"attempt_count": 1, "retryable": False}
        ),
    ]

    counters = _persisted_stage3_counts(intents)

    assert counters["source"] == "persisted_order_intents"
    assert counters["total"] == {"planned": 4, "processed": 3, "submitted": 1}
    assert counters["sell"] == {"planned": 2, "processed": 2, "submitted": 1}
    assert counters["redeem"] == {"planned": 1, "processed": 1, "submitted": 0}
    assert counters["buy"] == {"planned": 2, "processed": 1, "submitted": 0}
    for key in ("total", "sell", "redeem", "buy"):
        group = counters[key]
        assert group["submitted"] <= group["processed"] <= group["planned"]


@pytest.mark.parametrize(
    "submission_update",
    [
        {"remote_order_id": "remote-order-1"},
        {"remote_transaction_hash": "0xabc123"},
        {"first_submitted_at": "2026-07-20T12:00:05+00:00"},
    ],
)
def test_retry_rejects_intent_with_persisted_submission_reference(submission_update):
    intent = _intent(intent_id="duplicate-guard", status="READY").model_copy(
        update=submission_update
    )

    with pytest.raises(ValueError, match="reconciled instead of retried"):
        _assert_intent_has_no_persisted_submission_reference(intent)


def test_confirming_retry_requires_verified_remote_absence():
    intent = _intent(intent_id="ambiguous", status="CONFIRMING", attempt_count=1)

    with pytest.raises(ValueError, match="Verify that Bullpen has no matching trade"):
        _assert_intent_retry_allowed(intent)

    _assert_intent_retry_allowed(intent, remote_absence_verified=True)


def test_verified_remote_absence_retry_still_rejects_persisted_reference():
    intent = _intent(intent_id="persisted", status="CONFIRMING", attempt_count=1).model_copy(
        update={"remote_order_id": "0xorder"}
    )

    with pytest.raises(ValueError, match="reconciled instead of retried"):
        _assert_intent_retry_allowed(intent, remote_absence_verified=True)


def test_operator_resume_preserves_terminal_success_with_persisted_reference():
    filled = _intent(intent_id="filled", status="FILLED").model_copy(
        update={"remote_order_id": "0xorder"}
    )
    confirming = filled.model_copy(update={"status": "CONFIRMING"})

    assert not _intent_requires_operator_resume_reconciliation(filled)
    assert _intent_requires_operator_resume_reconciliation(confirming)


def test_reconciliation_snapshot_must_match_pending_intent_generation():
    snapshot = _intent(intent_id="generation", status="CONFIRMING").model_copy(
        update={"version": 3}
    )

    assert _reconciliation_snapshot_is_current(snapshot, snapshot)
    assert not _reconciliation_snapshot_is_current(
        snapshot.model_copy(update={"status": "READY"}),
        snapshot,
    )
    assert not _reconciliation_snapshot_is_current(
        snapshot.model_copy(update={"version": 4}),
        snapshot,
    )
