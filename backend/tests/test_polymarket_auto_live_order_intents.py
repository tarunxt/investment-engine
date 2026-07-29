from datetime import UTC, datetime, timedelta
from dataclasses import replace
from types import SimpleNamespace

import pytest
from sqlalchemy.dialects import postgresql

import app.models  # noqa: F401  # Configure all SQLAlchemy relationship targets.
from app.domains.polymarket.bullpen import (
    BULLPEN_REDEEMED_HISTORY_COMMAND_VARIANTS,
    BULLPEN_TRADE_HISTORY_COMMAND_VARIANTS,
)
from app.domains.polymarket_auto_live import console_profile
from app.domains.polymarket_auto_live.console_profile import (
    ConsoleWalletPosition,
    ConsoleWalletPositionsSnapshot,
)
from app.domains.polymarket_auto_live.engine import (
    build_console_affordable_buy_allocation,
)
from app.domains.polymarket_auto_live.order_intents import (
    AutoLiveExecutorError,
    build_order_funnel,
    build_order_plan_from_intent,
    classify_executor_error,
    derive_run_status_from_intents,
)
from app.domains.polymarket_auto_live.order_intent_service import (
    STAGE3_ORDER_INTENT_IDEMPOTENCY_KEY_FORMAT,
    STAGE3_ORDER_INTENT_IDEMPOTENCY_KEY_MAX_LENGTH,
    _automatic_attempt_budget_allows,
    _apply_executor_error,
    _cancel_unsubmitted_intent_for_user,
    _compare_wallet_snapshot_lineage,
    _defer_buy_until_exit,
    _assert_intent_has_no_persisted_submission_reference,
    _assert_intent_retry_allowed,
    _auth_recovery_allows_operator_resume,
    _extract_remote_refs,
    _intent_requires_operator_resume_reconciliation,
    _matched_buy_submission_fill,
    _authoritative_stage2_contract_counts,
    _persisted_execution_step,
    _summary_text,
    _persisted_stage3_counts,
    _post_exit_replacement_sizing,
    _position_is_non_tradable,
    _prepare_intent_submission,
    _reserve_buy_if_possible,
    _remaining_position_is_economic_dust,
    _reconciliation_snapshot_is_current,
    _submit_prepared_intent,
    build_stage3_order_intent_idempotency_key,
    stage3_execution_market_reference,
)
import app.domains.polymarket_auto_live.order_intent_service as order_intent_service
from app.domains.polymarket_auto_live.schemas import (
    BullpenAutoLiveOrderIntent,
    BullpenAutoLiveOrderPlan,
)
from app.domains.polymarket_auto_live.scanner import ScannedMarket


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


def _wallet_position(
    *,
    classification: str = "active",
    is_claimable: bool = False,
    shares: float = 2.5,
    expected_payout_usdc: float | None = None,
) -> ConsoleWalletPosition:
    return ConsoleWalletPosition(
        market_id="resolved-market-slug",
        slug="resolved-market-slug",
        condition_id="condition-1",
        market_title="Resolved market",
        market_url=None,
        side="YES",
        shares=shares,
        average_price_cents=40.0,
        exposure_usd=1.0,
        current_price_cents=99.0,
        current_value_usd=shares * 0.99,
        current_yes_odds=99.0,
        current_no_odds=1.0,
        close_time="2026-07-20T00:00:00+00:00",
        theme="test",
        is_claimable=is_claimable,
        raw_claimable_flag=is_claimable,
        upstream_redeemable=is_claimable,
        classification=classification,
        classification_reason=classification,
        claimable_value_usd=shares * 0.99 if is_claimable else None,
        expected_payout_usdc=expected_payout_usdc,
    )


def _market(*, open_market: bool) -> ScannedMarket:
    return ScannedMarket(
        market_id="resolved-market-slug",
        question="Resolved market",
        market_url=None,
        slug="resolved-market-slug",
        close_time=(
            "2026-07-30T00:00:00+00:00"
            if open_market
            else "2026-07-20T00:00:00+00:00"
        ),
        theme="test",
        current_yes_odds=50.0 if open_market else 0.0,
        current_no_odds=50.0 if open_market else 100.0,
        volume_usd=1000.0,
        liquidity_usd=500.0,
        description=None,
        outcome_labels=["Yes", "No"],
        event_slug=None,
        best_bid_cents=49.0,
        best_ask_cents=51.0,
        spread_cents=2.0,
        force_include=True,
        raw={
            "active": open_market,
            "closed": not open_market,
            "archived": False,
            "conditionId": "condition-1",
        },
    )


def _live_controls(*, doctor_ok: bool = True):
    return SimpleNamespace(
        emergency_stopped=False,
        unlocked=doctor_ok,
        locked_reason=None if doctor_ok else "Dashboard live unlock is required.",
        doctor=SimpleNamespace(
            ok=doctor_ok,
            message=(
                "Bullpen doctor passed."
                if doctor_ok
                else "POLYMARKET_WALLET_ROUTE_UNCONFIRMED"
            ),
        ),
        balance=SimpleNamespace(
            status="ready",
            message="Balance ready.",
            available_balance_usd=3.44,
        ),
    )


def _wallet_snapshot(
    position: ConsoleWalletPosition,
    *,
    source: str = "live-cli",
    freshness_state: str = "fresh",
    credential_artifact: dict[str, int | None] | None = None,
    account_identity: str | None = "wallet-a",
    auth_checked_at: str | None = None,
) -> ConsoleWalletPositionsSnapshot:
    return ConsoleWalletPositionsSnapshot(
        positions=[position],
        raw_positions=[position],
        source=source,
        freshness_state=freshness_state,
        fetched_at=(datetime.now(UTC) + timedelta(seconds=1)).isoformat(),
        raw_position_count=1,
        diagnostics={},
        credential_artifact=(
            credential_artifact
            if credential_artifact is not None
            else {"inode": 11, "mtime_ns": 22, "size": 33}
        ),
        account_identity=account_identity,
        position_classifier_version=3,
        auth_checked_at=auth_checked_at,
    )


def _expected_wallet_lineage() -> dict[str, object]:
    return {
        "source": "live-cli",
        "fetched_at": "2026-07-20T00:00:00+00:00",
        "freshness_state": "fresh",
        "account_identity": "wallet-a",
        "credential_artifact": {
            "inode": 11,
            "mtime_ns": 22,
            "size": 33,
        },
        "position_classifier_version": 3,
        "auth_checked_at": "2026-07-20T00:00:00+00:00",
    }


def _sell_intent(intent_id: str) -> BullpenAutoLiveOrderIntent:
    return _intent(
        intent_id=intent_id,
        status="READY",
        action="sell",
    ).model_copy(
        update={
            "market_id": "legacy-numeric-market-id",
            "slug": "resolved-market-slug",
            "condition_id": "condition-1",
            "execution_metadata_json": {
                "expected_stage1_wallet_lineage": _expected_wallet_lineage(),
            },
        }
    )


def _submitted_sell_intent(
    intent_id: str,
    *,
    submitted_at: datetime,
    remote_order_id: str | None = None,
) -> BullpenAutoLiveOrderIntent:
    preflight_lineage = {
        "source": "live-cli",
        "fetched_at": (submitted_at - timedelta(seconds=1)).isoformat(),
        "freshness_state": "fresh",
        "account_identity": "wallet-a",
        "credential_artifact": {
            "inode": 11,
            "mtime_ns": 22,
            "size": 33,
        },
        "position_classifier_version": 3,
        "submitted_shares": 6.25,
        "verified_shares": 6.25,
        "sellable": True,
    }
    return _sell_intent(intent_id).model_copy(
        update={
            "status": "CONFIRMING",
            "first_submitted_at": submitted_at.isoformat(),
            "last_submitted_at": submitted_at.isoformat(),
            "remote_order_id": remote_order_id,
            "execution_metadata_json": {
                "wallet_snapshot_lineage": dict(preflight_lineage),
                "sell_live_preflight": dict(preflight_lineage),
            },
        }
    )


def _redeem_intent(intent_id: str) -> BullpenAutoLiveOrderIntent:
    return _intent(
        intent_id=intent_id,
        status="READY",
        action="redeem",
    ).model_copy(
        update={
            "market_id": "legacy-numeric-market-id",
            "slug": "resolved-market-slug",
            "condition_id": "condition-1",
            "execution_metadata_json": {
                "expected_stage1_wallet_lineage": _expected_wallet_lineage(),
            },
        }
    )


def _buy_reconciliation_intent(
    intent_id: str,
    *,
    submitted_at: datetime,
    remote_order_id: str | None = "remote-buy-1",
) -> BullpenAutoLiveOrderIntent:
    return _intent(
        intent_id=intent_id,
        status="CONFIRMING",
        action="buy",
        first_submitted_at=submitted_at.isoformat(),
        remaining_shares=6.25,
    ).model_copy(
        update={
            "market_id": "legacy-numeric-market-id",
            "slug": "resolved-market-slug",
            "condition_id": "condition-1",
            "remote_order_id": remote_order_id,
            "last_submitted_at": submitted_at.isoformat(),
            "execution_metadata_json": {
                "wallet_snapshot_lineage": {
                    "source": "live-cli",
                    "fetched_at": (
                        submitted_at - timedelta(seconds=1)
                    ).isoformat(),
                    "freshness_state": "fresh",
                    "account_identity": "wallet-a",
                    "credential_artifact": {
                        "inode": 11,
                        "mtime_ns": 22,
                        "size": 33,
                    },
                    "position_classifier_version": 3,
                },
                "expected_stage1_wallet_lineage": {
                    "source": "live-cli",
                    "fetched_at": (
                        submitted_at - timedelta(seconds=2)
                    ).isoformat(),
                    "freshness_state": "fresh",
                    "account_identity": "wallet-a",
                    "credential_artifact": {
                        "inode": 11,
                        "mtime_ns": 22,
                        "size": 33,
                    },
                    "position_classifier_version": 3,
                },
            },
        }
    )


@pytest.mark.anyio
async def test_sell_preflight_surfaces_doctor_failure_before_dashboard_lock(
    monkeypatch,
):
    async def refresh_controls(*, user_id: int):
        assert user_id == 1
        return _live_controls(doctor_ok=False)

    monkeypatch.setattr(
        order_intent_service,
        "refresh_live_controls",
        refresh_controls,
    )

    with pytest.raises(AutoLiveExecutorError) as error:
        await _prepare_intent_submission(_sell_intent("doctor-blocked-sell"))

    assert error.value.code == "POLYMARKET_WALLET_ROUTE_UNCONFIRMED"
    assert error.value.retryable is False
    assert "POLYMARKET_WALLET_ROUTE_UNCONFIRMED" in error.value.message


@pytest.mark.anyio
async def test_sell_preflight_keeps_untyped_doctor_read_failure_retryable(
    monkeypatch,
):
    async def refresh_controls(*, user_id: int):
        assert user_id == 1
        controls = _live_controls(doctor_ok=False)
        controls.doctor.message = "Bullpen doctor failed during a transient read."
        return controls

    monkeypatch.setattr(
        order_intent_service,
        "refresh_live_controls",
        refresh_controls,
    )

    with pytest.raises(AutoLiveExecutorError) as error:
        await _prepare_intent_submission(_sell_intent("transient-doctor-sell"))

    assert error.value.code == "DOCTOR_READ_FAILED"
    assert error.value.retryable is True


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("position", "expected_code"),
    [
        (
            _wallet_position(
                classification="positive_payout_claimable",
                is_claimable=True,
                expected_payout_usdc=2.5,
            ),
            "SELL_REQUIRES_REDEEM",
        ),
        (
            replace(
                _wallet_position(
                    classification="resolved_zero_payout",
                    expected_payout_usdc=0.0,
                ),
                current_price_cents=0.0,
                current_value_usd=0.0,
            ),
            "NO_SELLABLE_EXPOSURE",
        ),
    ],
)
async def test_sell_preflight_blocks_claimable_and_resolved_aliases(
    monkeypatch,
    position,
    expected_code,
):
    async def refresh_controls(*, user_id: int):
        assert user_id == 1
        return _live_controls()

    async def read_snapshot(**kwargs):
        assert kwargs == {
            "force_fresh": True,
            "caller_source": "auto-live-stage3-sell-pre-submit",
            "max_age_seconds": 0,
        }
        return _wallet_snapshot(position)

    async def fetch_market(slug: str):
        assert slug == "resolved-market-slug"
        return _market(open_market=False)

    monkeypatch.setattr(
        order_intent_service,
        "refresh_live_controls",
        refresh_controls,
    )
    monkeypatch.setattr(
        order_intent_service,
        "read_console_wallet_positions_snapshot",
        read_snapshot,
    )
    monkeypatch.setattr(
        console_profile,
        "fetch_market_by_slug",
        fetch_market,
    )

    with pytest.raises(AutoLiveExecutorError) as error:
        await _prepare_intent_submission(_sell_intent(expected_code.lower()))

    assert error.value.code == expected_code


@pytest.mark.anyio
async def test_sell_preflight_active_open_market_overrides_stale_payout_flags(
    monkeypatch,
):
    position = _wallet_position(
        classification="positive_payout_claimable",
        is_claimable=True,
        expected_payout_usdc=2.5,
    )

    async def refresh_controls(*, user_id: int):
        assert user_id == 1
        return _live_controls()

    async def read_snapshot(**_kwargs):
        return _wallet_snapshot(position)

    async def fetch_market(_slug: str):
        return _market(open_market=True)

    monkeypatch.setattr(
        order_intent_service,
        "refresh_live_controls",
        refresh_controls,
    )
    monkeypatch.setattr(
        order_intent_service,
        "read_console_wallet_positions_snapshot",
        read_snapshot,
    )
    monkeypatch.setattr(
        console_profile,
        "fetch_market_by_slug",
        fetch_market,
    )

    prepared = await _prepare_intent_submission(
        _sell_intent("stale-payout-open-sell")
    )

    assert prepared.sell_preflight_metadata["classification"] == "active"
    assert prepared.sell_preflight_metadata["sellable"] is True


@pytest.mark.anyio
@pytest.mark.parametrize("action", ["sell", "redeem"])
@pytest.mark.parametrize(
    "missing_lineage_field",
    [
        "stage1",
        "account_identity",
        "credential_artifact",
        "position_classifier_version",
    ],
)
async def test_sell_and_redeem_preflight_require_complete_stage1_and_current_lineage(
    monkeypatch,
    action,
    missing_lineage_field,
):
    position = _wallet_position()

    async def refresh_controls(*, user_id: int):
        assert user_id == 1
        return _live_controls()

    snapshot = _wallet_snapshot(position)
    if missing_lineage_field == "account_identity":
        snapshot = replace(snapshot, account_identity=None)
    elif missing_lineage_field == "credential_artifact":
        snapshot = replace(snapshot, credential_artifact={})
    elif missing_lineage_field == "position_classifier_version":
        snapshot = replace(snapshot, position_classifier_version=None)

    async def read_snapshot(**_kwargs):
        return snapshot

    monkeypatch.setattr(
        order_intent_service,
        "refresh_live_controls",
        refresh_controls,
    )
    monkeypatch.setattr(
        order_intent_service,
        "read_console_wallet_positions_snapshot",
        read_snapshot,
    )
    intent = (
        _sell_intent("complete-lineage-sell")
        if action == "sell"
        else _redeem_intent("complete-lineage-redeem")
    )
    if missing_lineage_field == "stage1":
        intent = intent.model_copy(
            update={"execution_metadata_json": {}}
        )

    with pytest.raises(AutoLiveExecutorError) as error:
        await _prepare_intent_submission(intent)

    assert error.value.code == "POSITION_LINEAGE_UNAVAILABLE"
    assert error.value.retryable is True
    assert f"no external {action} write was issued" in error.value.message


@pytest.mark.anyio
async def test_sell_preflight_accepts_attested_same_wallet_credential_rotation(
    monkeypatch,
):
    position = _wallet_position()
    new_artifact = {"inode": 44, "mtime_ns": 55, "size": 66}
    auth_checked_at = "2026-07-27T00:01:00+00:00"
    snapshot = _wallet_snapshot(
        position,
        credential_artifact=new_artifact,
        auth_checked_at=auth_checked_at,
    )

    async def refresh_controls(*, user_id: int):
        assert user_id == 1
        return _live_controls()

    async def read_snapshot(**_kwargs):
        return snapshot

    async def enrich_positions(positions):
        return list(positions), {"unresolved_position_count": 0}

    class FakeBroker:
        async def read_latest_active_auth_result(self):
            return SimpleNamespace(
                healthy=True,
                account_identity="wallet-a",
                credential_artifact=new_artifact,
                auth_checked_at=auth_checked_at,
            )

    monkeypatch.setattr(
        order_intent_service,
        "refresh_live_controls",
        refresh_controls,
    )
    monkeypatch.setattr(
        order_intent_service,
        "read_console_wallet_positions_snapshot",
        read_snapshot,
    )
    monkeypatch.setattr(
        order_intent_service,
        "enrich_console_wallet_positions_authoritatively",
        enrich_positions,
    )
    monkeypatch.setattr(
        order_intent_service,
        "get_bullpen_runtime_broker",
        lambda: FakeBroker(),
    )

    prepared = await _prepare_intent_submission(
        _sell_intent("attested-rotation-sell")
    )

    attestation = prepared.wallet_lineage_comparison[
        "credential_rotation_attestation"
    ]
    assert prepared.wallet_lineage_comparison["status"] == "match"
    assert attestation["status"] == "attested_same_account_rotation"
    assert attestation["old_credential_artifact"] == {
        "inode": 11,
        "mtime_ns": 22,
        "size": 33,
    }
    assert attestation["new_credential_artifact"] == new_artifact
    assert attestation["auth_checked_at"] == auth_checked_at


@pytest.mark.anyio
async def test_sell_preflight_rejects_wallet_change_during_credential_rotation(
    monkeypatch,
):
    position = _wallet_position()
    new_artifact = {"inode": 44, "mtime_ns": 55, "size": 66}
    auth_checked_at = "2026-07-27T00:01:00+00:00"
    snapshot = _wallet_snapshot(
        position,
        credential_artifact=new_artifact,
        account_identity="wallet-b",
        auth_checked_at=auth_checked_at,
    )

    async def refresh_controls(*, user_id: int):
        assert user_id == 1
        return _live_controls()

    async def read_snapshot(**_kwargs):
        return snapshot

    monkeypatch.setattr(
        order_intent_service,
        "refresh_live_controls",
        refresh_controls,
    )
    monkeypatch.setattr(
        order_intent_service,
        "read_console_wallet_positions_snapshot",
        read_snapshot,
    )

    with pytest.raises(AutoLiveExecutorError) as error:
        await _prepare_intent_submission(
            _sell_intent("wallet-change-sell")
        )

    assert error.value.code == "POSITION_LINEAGE_MISMATCH"
    assert error.value.retryable is False
    assert "no external sell write was issued" in error.value.message


@pytest.mark.anyio
async def test_sell_preflight_rejects_unattested_current_credential_artifact(
    monkeypatch,
):
    position = _wallet_position()
    new_artifact = {"inode": 44, "mtime_ns": 55, "size": 66}
    auth_checked_at = "2026-07-27T00:01:00+00:00"
    snapshot = _wallet_snapshot(
        position,
        credential_artifact=new_artifact,
        auth_checked_at=auth_checked_at,
    )

    async def refresh_controls(*, user_id: int):
        assert user_id == 1
        return _live_controls()

    async def read_snapshot(**_kwargs):
        return snapshot

    class FakeBroker:
        async def read_latest_active_auth_result(self):
            return SimpleNamespace(
                healthy=True,
                account_identity="wallet-a",
                credential_artifact={
                    "inode": 11,
                    "mtime_ns": 22,
                    "size": 33,
                },
                auth_checked_at=auth_checked_at,
            )

    monkeypatch.setattr(
        order_intent_service,
        "refresh_live_controls",
        refresh_controls,
    )
    monkeypatch.setattr(
        order_intent_service,
        "read_console_wallet_positions_snapshot",
        read_snapshot,
    )
    monkeypatch.setattr(
        order_intent_service,
        "get_bullpen_runtime_broker",
        lambda: FakeBroker(),
    )

    with pytest.raises(AutoLiveExecutorError) as error:
        await _prepare_intent_submission(
            _sell_intent("unattested-rotation-sell")
        )

    assert error.value.code == "POSITION_LINEAGE_UNAVAILABLE"
    assert error.value.retryable is True


def test_active_position_classifier_overrides_stale_raw_resolution_status():
    position = replace(
        _wallet_position(classification="active"),
        resolution_status="resolved",
    )

    assert _position_is_non_tradable(position) is False
    assert (
        _position_is_non_tradable(
            replace(position, classification="unknown")
        )
        is True
    )


@pytest.mark.anyio
async def test_sell_reconciliation_keeps_numeric_id_slot_occupied_when_slug_position_remains(
    monkeypatch,
):
    position = replace(
        _wallet_position(shares=6.25),
        condition_id=None,
    )
    snapshot = _wallet_snapshot(position)

    async def read_snapshot(**kwargs):
        assert kwargs == {
            "force_fresh": True,
            "caller_source": "auto-live-stage3-post-exit-intent-reconcile",
            "max_age_seconds": 0,
        }
        return snapshot

    class EmptyHistoryReader:
        async def refresh(self):
            return []

    class FilledOrderExecutor:
        async def poll_order(self, **kwargs):
            assert kwargs == {
                "order_id": "remote-exit-1",
                "interval_seconds": 1,
                "timeout_seconds": 5,
            }
            return {"status": "filled", "filledShares": 6.25}

    async def refresh_balance():
        return SimpleNamespace(status="ready", available_balance_usd=3.44)

    async def enrich_positions(positions):
        return list(positions), {"unresolved_position_count": 0}

    monkeypatch.setattr(
        order_intent_service,
        "read_console_wallet_positions_snapshot",
        read_snapshot,
    )
    monkeypatch.setattr(
        order_intent_service,
        "BullpenLiveExecutor",
        FilledOrderExecutor,
    )
    monkeypatch.setattr(
        order_intent_service,
        "refresh_balance",
        refresh_balance,
    )
    monkeypatch.setattr(
        order_intent_service,
        "enrich_console_wallet_positions_authoritatively",
        enrich_positions,
    )
    monkeypatch.setattr(
        order_intent_service,
        "BullpenTradeHistoryReader",
        EmptyHistoryReader,
    )
    monkeypatch.setattr(
        order_intent_service,
        "BullpenRedeemedTradesReader",
        EmptyHistoryReader,
    )

    result = await order_intent_service._reconcile_intent_async(
        _sell_intent("numeric-id-slug-still-present").model_copy(
            update={"remote_order_id": "remote-exit-1"}
        )
    )

    assert result.status == "SETTLEMENT_PENDING"
    assert result.remaining_shares == 6.25
    assert "replacement buy remains blocked" in result.detail.lower()


@pytest.mark.anyio
async def test_sell_reconciliation_never_infers_fill_without_submission_evidence(
    monkeypatch,
):
    async def read_snapshot(**_kwargs):
        raise AssertionError(
            "wallet absence must not be read as execution evidence"
        )

    monkeypatch.setattr(
        order_intent_service,
        "read_console_wallet_positions_snapshot",
        read_snapshot,
    )

    result = await order_intent_service._reconcile_intent_async(
        _sell_intent("numeric-id-slug-removed")
    )

    assert result.status == "DEFERRED"
    assert result.retryable is False
    assert result.last_error_code == "SUBMISSION_EVIDENCE_MISSING"
    assert "Wallet absence alone cannot prove" in result.detail


@pytest.mark.anyio
async def test_sell_reconciliation_accepts_anchored_same_lineage_wallet_delta(
    monkeypatch,
):
    submitted_at = datetime.now(UTC) - timedelta(seconds=10)
    position = replace(
        _wallet_position(shares=6.25),
        condition_id=None,
    )
    snapshot = replace(
        _wallet_snapshot(position),
        positions=[],
        raw_positions=[],
        raw_position_count=0,
    )

    async def read_snapshot(**_kwargs):
        return snapshot

    async def enrich_positions(positions):
        return list(positions), {"unresolved_position_count": 0}

    monkeypatch.setattr(
        order_intent_service,
        "read_console_wallet_positions_snapshot",
        read_snapshot,
    )
    monkeypatch.setattr(
        order_intent_service,
        "enrich_console_wallet_positions_authoritatively",
        enrich_positions,
    )
    intent = _submitted_sell_intent(
        "anchored-wallet-delta",
        submitted_at=submitted_at,
    )

    result = await order_intent_service._reconcile_intent_async(intent)

    assert result.status == "FILLED"
    assert result.remaining_shares == 0.0
    assert "no meaningful or redeemable sell exposure remains" in result.detail


def test_exit_history_requires_post_attempt_alias_side_and_compatible_size():
    submitted_at = datetime(2026, 7, 27, 10, 0, tzinfo=UTC)
    intent = _sell_intent("history-correlation").model_copy(
        update={
            "last_submitted_at": submitted_at.isoformat(),
            "current_shares": 6.25,
        }
    )
    compatible = SimpleNamespace(
        id="history-compatible",
        timestamp=(submitted_at + timedelta(seconds=1)).isoformat(),
        market_id="resolved-market-slug",
        condition_id=None,
        slug=None,
        side="SELL",
        outcome="YES",
        shares=6.25,
        status="executed",
        raw={},
    )
    stale = SimpleNamespace(
        **{
            **compatible.__dict__,
            "id": "history-stale",
            "timestamp": (
                submitted_at
                - timedelta(
                    seconds=(
                        order_intent_service
                        ._HISTORY_TIMESTAMP_TOLERANCE_SECONDS
                        + 1
                    )
                )
            ).isoformat(),
        }
    )
    oversized = SimpleNamespace(
        **{
            **compatible.__dict__,
            "id": "history-oversized",
            "shares": 12.5,
        }
    )
    wrong_side = SimpleNamespace(
        **{
            **compatible.__dict__,
            "id": "history-wrong-side",
            "side": "BUY",
        }
    )

    assert (
        order_intent_service._matching_post_submit_exit_history(
            [compatible],
            intent=intent,
            action="sell",
        )
        is compatible
    )
    for incompatible in (stale, oversized, wrong_side):
        assert (
            order_intent_service._matching_post_submit_exit_history(
                [incompatible],
                intent=intent,
                action="sell",
            )
            is None
        )


@pytest.mark.anyio
async def test_sell_history_cannot_terminalize_full_fresh_redis_exposure(
    monkeypatch,
):
    position = _wallet_position(shares=6.25)
    snapshot = _wallet_snapshot(position, source="redis-cache")
    submitted_at = datetime.now(UTC) - timedelta(seconds=10)

    async def read_snapshot(**kwargs):
        assert kwargs == {
            "force_fresh": True,
            "caller_source": (
                "auto-live-stage3-post-exit-intent-reconcile"
            ),
            "max_age_seconds": 0,
        }
        return snapshot

    async def enrich_positions(positions):
        return list(positions), {"unresolved_position_count": 0}

    trade = SimpleNamespace(
        id="sell-history",
        timestamp=datetime.now(UTC).isoformat(),
        market_id="resolved-market-slug",
        condition_id=None,
        slug=None,
        side="SELL",
        outcome="YES",
        shares=6.25,
        status="executed",
        raw={},
    )

    class TradeHistoryReader:
        async def refresh(self):
            return [trade]

    monkeypatch.setattr(
        order_intent_service,
        "read_console_wallet_positions_snapshot",
        read_snapshot,
    )
    monkeypatch.setattr(
        order_intent_service,
        "enrich_console_wallet_positions_authoritatively",
        enrich_positions,
    )
    monkeypatch.setattr(
        order_intent_service,
        "BullpenTradeHistoryReader",
        TradeHistoryReader,
    )

    result = await order_intent_service._reconcile_intent_async(
        _submitted_sell_intent(
            "history-is-not-settlement",
            submitted_at=submitted_at,
        )
    )

    assert result.status == "SETTLEMENT_PENDING"
    assert result.remaining_shares == 6.25
    assert result.raw_response["correlated_sell_history"] is True
    assert (
        result.raw_response["post_exit_snapshot"]["source"]
        == "redis-cache"
    )


@pytest.mark.anyio
async def test_remote_filled_sell_keeps_claimable_exposure_blocked(
    monkeypatch,
):
    position = _wallet_position(
        classification="positive_payout_claimable",
        is_claimable=True,
        shares=6.25,
        expected_payout_usdc=6.25,
    )
    snapshot = _wallet_snapshot(position)

    async def read_snapshot(**_kwargs):
        return snapshot

    async def enrich_positions(positions):
        return list(positions), {"unresolved_position_count": 0}

    class FilledOrderExecutor:
        async def poll_order(self, **_kwargs):
            return {"status": "filled", "filledShares": 6.25}

    async def refresh_balance():
        return SimpleNamespace(
            status="ready",
            available_balance_usd=3.44,
        )

    monkeypatch.setattr(
        order_intent_service,
        "read_console_wallet_positions_snapshot",
        read_snapshot,
    )
    monkeypatch.setattr(
        order_intent_service,
        "enrich_console_wallet_positions_authoritatively",
        enrich_positions,
    )
    monkeypatch.setattr(
        order_intent_service,
        "BullpenLiveExecutor",
        FilledOrderExecutor,
    )
    monkeypatch.setattr(
        order_intent_service,
        "refresh_balance",
        refresh_balance,
    )

    result = await order_intent_service._reconcile_intent_async(
        _sell_intent("filled-but-claimable").model_copy(
            update={"remote_order_id": "remote-filled-claimable"}
        )
    )

    assert result.status == "SETTLEMENT_PENDING"
    assert "redeemable exposure" in result.detail


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("remote_status", "filled_shares"),
    [
        ("cancelled", None),
        ("rejected", 2.0),
    ],
)
async def test_ambiguous_terminal_sell_poll_uses_fresh_wallet_proof(
    monkeypatch,
    remote_status,
    filled_shares,
):
    position = _wallet_position(shares=6.25)
    snapshot = replace(
        _wallet_snapshot(position),
        positions=[],
        raw_positions=[],
        raw_position_count=0,
    )
    snapshot_calls = 0

    async def read_snapshot(**_kwargs):
        nonlocal snapshot_calls
        snapshot_calls += 1
        return snapshot

    class AmbiguousTerminalExecutor:
        async def poll_order(self, **_kwargs):
            payload = {"status": remote_status}
            if filled_shares is not None:
                payload["filledShares"] = filled_shares
            return payload

    monkeypatch.setattr(
        order_intent_service,
        "read_console_wallet_positions_snapshot",
        read_snapshot,
    )
    monkeypatch.setattr(
        order_intent_service,
        "BullpenLiveExecutor",
        AmbiguousTerminalExecutor,
    )

    result = await order_intent_service._reconcile_intent_async(
        _sell_intent(f"{remote_status}-ambiguous-fill-sell").model_copy(
            update={"remote_order_id": "remote-ambiguous-exit"}
        )
    )

    assert result.status == "FILLED"
    assert result.remaining_shares == 0
    assert snapshot_calls == 1


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("remote_status", "expected_status"),
    [
        ("cancelled", "CANCELLED"),
        ("rejected", "REJECTED"),
    ],
)
async def test_explicit_zero_fill_sell_terminal_state_needs_no_wallet_fallback(
    monkeypatch,
    remote_status,
    expected_status,
):
    class ZeroFillTerminalExecutor:
        async def poll_order(self, **_kwargs):
            return {
                "status": remote_status,
                "filledShares": 0,
                "remainingShares": 6.25,
            }

    async def unexpected_snapshot(**_kwargs):
        raise AssertionError("explicit zero fill should terminalize directly")

    monkeypatch.setattr(
        order_intent_service,
        "BullpenLiveExecutor",
        ZeroFillTerminalExecutor,
    )
    monkeypatch.setattr(
        order_intent_service,
        "read_console_wallet_positions_snapshot",
        unexpected_snapshot,
    )

    result = await order_intent_service._reconcile_intent_async(
        _sell_intent(f"{remote_status}-zero-fill-sell").model_copy(
            update={"remote_order_id": "remote-zero-fill-exit"}
        )
    )

    assert result.status == expected_status
    assert result.filled_shares == 0


@pytest.mark.anyio
async def test_scheduled_redeem_uses_lineage_fenced_snapshot_and_history_is_nonterminal(
    monkeypatch,
):
    position = _wallet_position(
        classification="positive_payout_claimable",
        is_claimable=True,
        shares=2.5,
        expected_payout_usdc=2.5,
    )
    snapshot = _wallet_snapshot(position, source="redis-cache")
    submitted_at = datetime.now(UTC) - timedelta(seconds=10)

    async def read_snapshot(**kwargs):
        assert kwargs == {
            "force_fresh": True,
            "caller_source": (
                "auto-live-stage3-post-exit-intent-reconcile"
            ),
            "max_age_seconds": 0,
        }
        return snapshot

    async def generic_read_must_not_run():
        raise AssertionError("legacy wallet reader was used")

    async def enrich_positions(positions):
        return list(positions), {"unresolved_position_count": 0}

    redeem_history = SimpleNamespace(
        id="redeem-history",
        timestamp=datetime.now(UTC).isoformat(),
        market_id="resolved-market-slug",
        condition_id=None,
        slug=None,
        side="REDEEM",
        shares=2.5,
        status="redeemed",
    )

    class RedeemedHistoryReader:
        async def refresh(self):
            return [redeem_history]

    monkeypatch.setattr(
        order_intent_service,
        "read_console_wallet_positions_snapshot",
        read_snapshot,
    )
    monkeypatch.setattr(
        order_intent_service,
        "read_console_wallet_positions",
        generic_read_must_not_run,
    )
    monkeypatch.setattr(
        order_intent_service,
        "enrich_console_wallet_positions_authoritatively",
        enrich_positions,
    )
    monkeypatch.setattr(
        order_intent_service,
        "BullpenRedeemedTradesReader",
        RedeemedHistoryReader,
    )

    result = await order_intent_service._reconcile_intent_async(
        _redeem_intent("scheduled-redeem").model_copy(
            update={"last_submitted_at": submitted_at.isoformat()}
        )
    )

    assert result.status == "SETTLEMENT_PENDING"
    assert result.raw_response["correlated_redeem_history"] is True
    assert "history cannot terminalize" in result.detail


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("remote_status", "expected_status"),
    [
        ("rejected", "REJECTED"),
        ("cancelled", "CANCELLED"),
    ],
)
async def test_buy_reconciliation_maps_definitive_remote_no_fill_states(
    monkeypatch,
    remote_status,
    expected_status,
):
    poll_calls: list[dict[str, object]] = []

    class TerminalExecutor:
        async def poll_order(self, **kwargs):
            poll_calls.append(kwargs)
            return {
                "result": {
                    "orderStatus": remote_status,
                    "filledShares": 0,
                    "remainingShares": 6.25,
                }
            }

    async def unexpected_snapshot(**_kwargs):
        raise AssertionError("definitive remote state must not need wallet fallback")

    monkeypatch.setattr(
        order_intent_service,
        "BullpenLiveExecutor",
        TerminalExecutor,
    )
    monkeypatch.setattr(
        order_intent_service,
        "read_console_wallet_positions_snapshot",
        unexpected_snapshot,
    )
    intent = _buy_reconciliation_intent(
        f"remote-{remote_status}-buy",
        submitted_at=datetime.now(UTC) - timedelta(seconds=10),
    )

    result = await order_intent_service._reconcile_intent_async(intent)

    assert result.status == expected_status
    assert result.retryable is False
    assert result.filled_shares == 0
    assert result.remaining_shares == 6.25
    assert poll_calls == [
        {
            "order_id": "remote-buy-1",
            "interval_seconds": 1,
            "timeout_seconds": 5,
        }
    ]


@pytest.mark.anyio
async def test_cancelled_remote_buy_without_fill_field_preserves_ambiguity(
    monkeypatch,
):
    class CancelledExecutor:
        async def poll_order(self, **_kwargs):
            return {"status": "cancelled", "remainingShares": 6.25}

    monkeypatch.setattr(
        order_intent_service,
        "BullpenLiveExecutor",
        CancelledExecutor,
    )
    intent = _buy_reconciliation_intent(
        "cancelled-unknown-fill-buy",
        submitted_at=datetime.now(UTC) - timedelta(seconds=10),
    )

    result = await order_intent_service._reconcile_intent_async(intent)

    assert result.status == "CANCELLED"
    assert result.filled_shares is None
    assert result.remaining_shares == 6.25
    assert not order_intent_service._result_definitively_proves_no_fill(
        result
    )


@pytest.mark.anyio
async def test_buy_reconciliation_open_order_ages_into_operator_support_block(
    monkeypatch,
):
    position = _wallet_position()
    empty_snapshot = replace(
        _wallet_snapshot(position),
        positions=[],
        raw_positions=[],
        raw_position_count=0,
    )

    class OpenExecutor:
        async def poll_order(self, **_kwargs):
            return {"status": "open", "remainingShares": 6.25}

    class EmptyHistoryReader:
        async def refresh(self):
            return []

    async def read_snapshot(**kwargs):
        assert kwargs == {
            "force_fresh": True,
            "caller_source": "auto-live-stage3-buy-post-submit-reconcile",
            "max_age_seconds": 0,
        }
        return empty_snapshot

    monkeypatch.setenv(
        "AUTO_LIVE_BUY_RECONCILIATION_MAX_AGE_SECONDS",
        "30",
    )
    monkeypatch.setattr(
        order_intent_service,
        "BullpenLiveExecutor",
        OpenExecutor,
    )
    monkeypatch.setattr(
        order_intent_service,
        "read_console_wallet_positions_snapshot",
        read_snapshot,
    )
    monkeypatch.setattr(
        order_intent_service,
        "BullpenTradeHistoryReader",
        EmptyHistoryReader,
    )
    intent = _buy_reconciliation_intent(
        "stale-open-buy",
        submitted_at=datetime.now(UTC) - timedelta(minutes=5),
    )

    result = await order_intent_service._reconcile_intent_async(intent)

    assert result.status == "TIMED_OUT"
    assert result.retryable is False
    assert result.last_error_code == "AMBIGUOUS_SUBMISSION"
    assert "BUY_RECONCILIATION_OPERATOR_BLOCKED" in result.detail
    assert "automatic resubmission is prohibited" in result.detail
    assert "Bullpen support" in result.detail
    operator_block = result.raw_response[
        "buy_reconciliation_operator_block"
    ]
    assert operator_block["version"] == "v1"
    assert operator_block["max_age_seconds"] == 30
    assert operator_block["automatic_resubmission"] is False
    assert operator_block["support_verification_required"] is True


@pytest.mark.parametrize(
    ("configured", "expected"),
    [
        ("1", 30),
        ("900", 900),
        ("999999", 24 * 60 * 60),
        ("invalid", 15 * 60),
    ],
)
def test_buy_reconciliation_window_is_bounded(
    monkeypatch,
    configured,
    expected,
):
    monkeypatch.setenv(
        "AUTO_LIVE_BUY_RECONCILIATION_MAX_AGE_SECONDS",
        configured,
    )

    assert (
        order_intent_service._buy_reconciliation_max_age_seconds()
        == expected
    )


@pytest.mark.anyio
async def test_buy_reconciliation_rejects_changed_wallet_lineage(
    monkeypatch,
):
    mismatched_snapshot = replace(
        _wallet_snapshot(_wallet_position()),
        account_identity="wallet-b",
        positions=[],
        raw_positions=[],
        raw_position_count=0,
    )

    class OpenExecutor:
        async def poll_order(self, **_kwargs):
            return {"status": "open"}

    class UnexpectedHistoryReader:
        async def refresh(self):
            raise AssertionError("mismatched wallet lineage must fence history")

    async def read_snapshot(**_kwargs):
        return mismatched_snapshot

    monkeypatch.setattr(
        order_intent_service,
        "BullpenLiveExecutor",
        OpenExecutor,
    )
    monkeypatch.setattr(
        order_intent_service,
        "read_console_wallet_positions_snapshot",
        read_snapshot,
    )
    monkeypatch.setattr(
        order_intent_service,
        "BullpenTradeHistoryReader",
        UnexpectedHistoryReader,
    )
    intent = _buy_reconciliation_intent(
        "lineage-mismatch-buy-reconcile",
        submitted_at=datetime.now(UTC) - timedelta(seconds=10),
    )

    result = await order_intent_service._reconcile_intent_async(intent)

    assert result.status == "CONFIRMING"
    assert result.retryable is True
    assert result.last_error_code == "POSITION_LINEAGE_MISMATCH"
    assert "different account, credential, classifier" in result.detail


@pytest.mark.anyio
async def test_buy_reconciliation_checks_stage1_and_preflight_lineage(
    monkeypatch,
):
    snapshot = replace(
        _wallet_snapshot(_wallet_position()),
        positions=[],
        raw_positions=[],
        raw_position_count=0,
    )

    class OpenExecutor:
        async def poll_order(self, **_kwargs):
            return {"status": "open"}

    async def read_snapshot(**_kwargs):
        return snapshot

    monkeypatch.setattr(
        order_intent_service,
        "BullpenLiveExecutor",
        OpenExecutor,
    )
    monkeypatch.setattr(
        order_intent_service,
        "read_console_wallet_positions_snapshot",
        read_snapshot,
    )
    intent = _buy_reconciliation_intent(
        "stage1-preflight-lineage-buy",
        submitted_at=datetime.now(UTC) - timedelta(seconds=10),
    )
    metadata = dict(intent.execution_metadata_json)
    metadata["expected_stage1_wallet_lineage"] = {
        **dict(metadata["expected_stage1_wallet_lineage"]),
        "account_identity": "different-stage1-wallet",
    }
    intent = intent.model_copy(
        update={"execution_metadata_json": metadata}
    )

    result = await order_intent_service._reconcile_intent_async(intent)

    assert result.status == "CONFIRMING"
    assert result.last_error_code == "POSITION_LINEAGE_MISMATCH"
    assert "stage1 account, credential, classifier" in result.detail


@pytest.mark.anyio
async def test_buy_reconciliation_ignores_stale_alias_history(
    monkeypatch,
):
    submitted_at = datetime.now(UTC) - timedelta(seconds=10)
    position = _wallet_position()
    empty_snapshot = replace(
        _wallet_snapshot(position),
        positions=[],
        raw_positions=[],
        raw_position_count=0,
    )
    stale_trade = SimpleNamespace(
        id="old-order",
        timestamp=(submitted_at - timedelta(minutes=1)).isoformat(),
        market_id="condition-1",
        side="BUY",
        outcome="YES",
        shares=6.25,
        price=0.8,
        raw={
            "conditionId": "condition-1",
            "slug": "resolved-market-slug",
            "orderId": "remote-buy-1",
        },
    )

    class OpenExecutor:
        async def poll_order(self, **_kwargs):
            return {"status": "open"}

    class StaleHistoryReader:
        async def refresh(self):
            return [stale_trade]

    async def read_snapshot(**_kwargs):
        return empty_snapshot

    monkeypatch.setattr(
        order_intent_service,
        "BullpenLiveExecutor",
        OpenExecutor,
    )
    monkeypatch.setattr(
        order_intent_service,
        "read_console_wallet_positions_snapshot",
        read_snapshot,
    )
    monkeypatch.setattr(
        order_intent_service,
        "BullpenTradeHistoryReader",
        StaleHistoryReader,
    )
    intent = _buy_reconciliation_intent(
        "stale-history-buy",
        submitted_at=submitted_at,
    )

    result = await order_intent_service._reconcile_intent_async(intent)

    assert result.status == "CONFIRMING"
    assert "no definitive buy fill" in result.detail


@pytest.mark.anyio
async def test_buy_reconciliation_ignores_incompatible_later_same_market_buy(
    monkeypatch,
):
    submitted_at = datetime.now(UTC) - timedelta(seconds=10)
    position = _wallet_position()
    empty_snapshot = replace(
        _wallet_snapshot(position),
        positions=[],
        raw_positions=[],
        raw_position_count=0,
    )
    unrelated_trade = SimpleNamespace(
        id="different-later-buy",
        timestamp=(submitted_at + timedelta(seconds=2)).isoformat(),
        market_id="condition-1",
        side="BUY",
        outcome="YES",
        shares=12.5,
        amount=10.0,
        price=0.8,
        raw={
            "conditionId": "condition-1",
            "slug": "resolved-market-slug",
        },
    )

    class HistoryReader:
        async def refresh(self):
            return [unrelated_trade]

    async def read_snapshot(**_kwargs):
        return empty_snapshot

    monkeypatch.setattr(
        order_intent_service,
        "BullpenLiveExecutor",
        lambda: pytest.fail("no remote ID means no provider call"),
    )
    monkeypatch.setattr(
        order_intent_service,
        "read_console_wallet_positions_snapshot",
        read_snapshot,
    )
    monkeypatch.setattr(
        order_intent_service,
        "BullpenTradeHistoryReader",
        HistoryReader,
    )
    intent = _buy_reconciliation_intent(
        "incompatible-later-buy",
        submitted_at=submitted_at,
        remote_order_id=None,
    )

    result = await order_intent_service._reconcile_intent_async(intent)

    assert result.status == "CONFIRMING"
    assert "no definitive buy fill" in result.detail


@pytest.mark.anyio
async def test_buy_reconciliation_accepts_same_second_truncated_history_time(
    monkeypatch,
):
    submitted_at = (
        datetime.now(UTC) - timedelta(seconds=10)
    ).replace(microsecond=800_000)
    position = _wallet_position()
    empty_snapshot = replace(
        _wallet_snapshot(position),
        positions=[],
        raw_positions=[],
        raw_position_count=0,
    )
    same_second_trade = SimpleNamespace(
        id="same-second-history-buy",
        # Bullpen CLI history may truncate sub-second precision.
        timestamp=submitted_at.replace(microsecond=0).isoformat(),
        market_id="condition-1",
        side="BUY",
        outcome="YES",
        shares=6.25,
        amount=5.0,
        price=0.8,
        raw={
            "conditionId": "condition-1",
            "slug": "resolved-market-slug",
        },
    )

    class HistoryReader:
        async def refresh(self):
            return [same_second_trade]

    async def read_snapshot(**_kwargs):
        return empty_snapshot

    monkeypatch.setattr(
        order_intent_service,
        "BullpenLiveExecutor",
        lambda: pytest.fail("no remote ID means no provider call"),
    )
    monkeypatch.setattr(
        order_intent_service,
        "read_console_wallet_positions_snapshot",
        read_snapshot,
    )
    monkeypatch.setattr(
        order_intent_service,
        "BullpenTradeHistoryReader",
        HistoryReader,
    )
    intent = _buy_reconciliation_intent(
        "same-second-history-buy",
        submitted_at=submitted_at,
        remote_order_id=None,
    )

    result = await order_intent_service._reconcile_intent_async(intent)

    assert result.status == "FILLED"
    assert result.filled_shares == 6.25
    assert result.remaining_shares == 0


@pytest.mark.anyio
async def test_buy_reconciliation_accepts_post_attempt_alias_history(
    monkeypatch,
):
    submitted_at = datetime.now(UTC) - timedelta(seconds=10)
    position = _wallet_position()
    empty_snapshot = replace(
        _wallet_snapshot(position),
        positions=[],
        raw_positions=[],
        raw_position_count=0,
    )
    correlated_trade = SimpleNamespace(
        id="history-row-without-order-id",
        timestamp=(submitted_at + timedelta(seconds=1)).isoformat(),
        market_id="condition-1",
        side="BUY",
        outcome="YES",
        shares=6.25,
        price=0.8,
        raw={
            "conditionId": "condition-1",
            "slug": "resolved-market-slug",
        },
    )

    class CorrelatedHistoryReader:
        async def refresh(self):
            return [correlated_trade]

    async def read_snapshot(**_kwargs):
        return empty_snapshot

    monkeypatch.setattr(
        order_intent_service,
        "BullpenLiveExecutor",
        lambda: pytest.fail(
            "no-ID reconciliation must never issue or poll a duplicate order"
        ),
    )
    monkeypatch.setattr(
        order_intent_service,
        "read_console_wallet_positions_snapshot",
        read_snapshot,
    )
    monkeypatch.setattr(
        order_intent_service,
        "BullpenTradeHistoryReader",
        CorrelatedHistoryReader,
    )
    intent = _buy_reconciliation_intent(
        "alias-history-buy",
        submitted_at=submitted_at,
        remote_order_id=None,
    )

    result = await order_intent_service._reconcile_intent_async(intent)

    assert result.status == "FILLED"
    assert result.filled_shares == 6.25
    assert result.remaining_shares == 0
    assert "alias-correlated" in result.detail


@pytest.mark.anyio
async def test_remote_filled_buy_forces_worker_portfolio_snapshot_publish(
    monkeypatch,
):
    snapshot_calls: list[dict[str, object]] = []
    position = _wallet_position(shares=6.25)

    class FilledExecutor:
        async def poll_order(self, **_kwargs):
            return {
                "status": "filled",
                "filledShares": 6.25,
                "remainingShares": 0,
                "averageFillPriceCents": 80,
            }

    async def read_snapshot(**kwargs):
        snapshot_calls.append(kwargs)
        return _wallet_snapshot(position)

    monkeypatch.setattr(
        order_intent_service,
        "BullpenLiveExecutor",
        FilledExecutor,
    )
    monkeypatch.setattr(
        order_intent_service,
        "read_console_wallet_positions_snapshot",
        read_snapshot,
    )
    intent = _buy_reconciliation_intent(
        "filled-buy-publishes-wallet",
        submitted_at=datetime.now(UTC) - timedelta(seconds=10),
    )

    result = await order_intent_service._reconcile_intent_async(intent)

    assert result.status == "FILLED"
    assert result.retryable is False
    assert snapshot_calls == [
        {
            "force_fresh": True,
            "caller_source": (
                "auto-live-stage3-buy-filled-post-submit-reconcile"
            ),
            "max_age_seconds": 0,
        }
    ]
    assert (
        result.raw_response["post_buy_wallet_refresh"]["status"]
        == "published"
    )
    assert (
        result.raw_response["post_buy_wallet_refresh"][
            "position_classifier_version"
        ]
        == 3
    )
    assert (
        result.raw_response["post_buy_wallet_refresh"][
            "lineage_comparison"
        ]["status"]
        == "match"
    )


@pytest.mark.parametrize(
    ("exit_status", "expected_buy_status", "expected_release"),
    [
        ("DEFERRED", "DEFERRED", True),
        ("CANCELLED", "DEFERRED", True),
        ("FAILED_PERMANENT", "DEFERRED", True),
        ("REJECTED", "DEFERRED", True),
        ("TIMED_OUT", "WAITING_FOR_EXIT", False),
    ],
)
def test_replacement_dependency_releases_only_for_definitive_exit_failures(
    monkeypatch,
    exit_status,
    expected_buy_status,
    expected_release,
):
    sibling = SimpleNamespace(
        id="exit-intent",
        run_id="run-1",
        dependency_group="replacement-group",
        action="sell",
        market_id="exit-market",
        status=exit_status,
        created_at=datetime(2026, 7, 27, 10, tzinfo=UTC),
    )
    record = SimpleNamespace(
        id="buy-intent",
        run_id="run-1",
        dependency_group="replacement-group",
        action="buy",
        market_id="replacement-market",
        status="READY",
        retryable=True,
        next_attempt_at=None,
        last_error_code=None,
        last_error_message=None,
        remote_order_id=None,
        remote_transaction_hash=None,
        first_submitted_at=None,
        last_submitted_at=None,
        reserved_cash_usd=1.22,
        execution_metadata_json={"reservation_state": "active"},
    )
    attempt = SimpleNamespace(
        completed_at=None,
        result_status=None,
        error_code=None,
        error_message=None,
    )
    released: list[str] = []

    class ScalarRows:
        def scalars(self):
            return self

        def first(self):
            return sibling

    class FakeSession:
        def execute(self, _query):
            return ScalarRows()

    def release_reservation(_session, intent):
        released.append(intent.id)
        intent.reserved_cash_usd = 0
        intent.execution_metadata_json = {
            **intent.execution_metadata_json,
            "reservation_state": "released",
        }

    monkeypatch.setattr(
        order_intent_service,
        "_release_reservation",
        release_reservation,
    )

    assert _defer_buy_until_exit(
        FakeSession(),  # type: ignore[arg-type]
        record=record,  # type: ignore[arg-type]
        attempt=attempt,  # type: ignore[arg-type]
    )
    assert record.status == expected_buy_status
    assert bool(released) is expected_release
    if expected_release:
        assert released == ["buy-intent"]
    else:
        assert record.reserved_cash_usd == 1.22


def test_replacement_buy_with_missing_exit_dependency_fails_closed(
    monkeypatch,
):
    record = SimpleNamespace(
        id="orphaned-buy-intent",
        run_id="run-1",
        dependency_group="missing-replacement-group",
        action="buy",
        status="READY",
        retryable=True,
        next_attempt_at=datetime.now(UTC),
        last_error_code=None,
        last_error_message=None,
        remote_order_id=None,
        remote_transaction_hash=None,
        first_submitted_at=None,
        last_submitted_at=None,
        reserved_cash_usd=1.22,
        execution_metadata_json={"reservation_state": "active"},
    )
    attempt = SimpleNamespace(
        completed_at=None,
        result_status=None,
        error_code=None,
        error_message=None,
    )
    released: list[str] = []

    class ScalarRows:
        def scalars(self):
            return self

        def first(self):
            return None

    class FakeSession:
        def execute(self, _query):
            return ScalarRows()

    def release_reservation(_session, intent):
        released.append(intent.id)
        intent.reserved_cash_usd = 0
        intent.execution_metadata_json = {
            **intent.execution_metadata_json,
            "reservation_state": "released",
        }

    monkeypatch.setattr(
        order_intent_service,
        "_release_reservation",
        release_reservation,
    )

    assert _defer_buy_until_exit(
        FakeSession(),  # type: ignore[arg-type]
        record=record,  # type: ignore[arg-type]
        attempt=attempt,  # type: ignore[arg-type]
    )
    assert record.status == "DEFERRED"
    assert record.retryable is False
    assert record.next_attempt_at is None
    assert record.last_error_code == "DEPENDENCY_EXIT_MISSING"
    assert record.execution_metadata_json["automatic_resubmission"] is False
    assert attempt.result_status == "DEFERRED"
    assert released == ["orphaned-buy-intent"]


def test_replacement_handoff_locks_and_rechecks_terminal_exit_before_waiting():
    """A concurrent exit commit must be observed before persisting WAITING."""

    sibling = SimpleNamespace(
        id="exit-intent",
        status="FILLED",
        dependency_group="replacement-group",
        market_id="exit-market",
    )
    record = SimpleNamespace(
        id="buy-intent",
        run_id="run-1",
        dependency_group="replacement-group",
        action="buy",
        status="SUBMITTING",
    )

    class ScalarRows:
        def scalars(self):
            return self

        def first(self):
            # Represents the row as seen after a concurrent terminal exit
            # transaction releases the FOR UPDATE lock.
            return sibling

    class LockAwareSession:
        def execute(self, query):
            compiled = str(
                query.compile(
                    dialect=postgresql.dialect(),
                    compile_kwargs={"literal_binds": True},
                )
            )
            assert compiled.rstrip().endswith("FOR UPDATE")
            return ScalarRows()

    assert not _defer_buy_until_exit(
        LockAwareSession(),  # type: ignore[arg-type]
        record=record,  # type: ignore[arg-type]
        attempt=SimpleNamespace(),  # type: ignore[arg-type]
    )
    assert record.status == "SUBMITTING"


def test_buy_reservation_scope_uses_postgresql_singleton_row_lock():
    query = order_intent_service._buy_reservation_scope_lock_query(user_id=7)

    compiled = str(
        query.compile(
            dialect=postgresql.dialect(),
            compile_kwargs={"literal_binds": True},
        )
    )

    assert "FROM users" in compiled
    assert "ORDER BY users.id ASC" in compiled
    assert "LIMIT 1" in compiled
    assert compiled.rstrip().endswith("FOR UPDATE")


@pytest.mark.parametrize(
    ("needed_usd", "expected_reserved"),
    [
        (1.00, True),
        (1.01, False),
    ],
)
def test_buy_reservation_is_locked_and_cent_exact_at_cash_boundary(
    monkeypatch,
    needed_usd,
    expected_reserved,
):
    events: list[object] = []
    intent = SimpleNamespace(id="buy-intent", user_id=7)

    class FakeSession:
        def get(self, model, intent_id):
            assert model is order_intent_service.PolymarketAutoLiveOrderIntentRecord
            assert intent_id == intent.id
            events.append("get-intent")
            return intent

        def commit(self):
            events.append("commit")

    session = FakeSession()

    def lock_scope(_session, *, user_id):
        assert _session is session
        assert user_id == intent.user_id
        events.append("lock-user")
        return True

    def active_reserved(
        _session,
        *,
        user_id,
        exclude_intent_id,
        verified_balance_checked_at,
    ):
        assert _session is session
        assert user_id == intent.user_id
        assert exclude_intent_id == intent.id
        assert verified_balance_checked_at == datetime(
            2026,
            7,
            27,
            9,
            tzinfo=UTC,
        )
        events.append("sum-active-reservations")
        return 0.30

    def upsert(_session, *, intent, amount_usd, status):
        assert _session is session
        assert intent is not None
        assert status == "active"
        events.append(("upsert", amount_usd))

    monkeypatch.delenv("AUTO_LIVE_BUY_BALANCE_BUFFER_USD", raising=False)
    monkeypatch.setattr(
        order_intent_service,
        "_lock_buy_reservation_scope",
        lock_scope,
    )
    monkeypatch.setattr(
        order_intent_service,
        "_active_reserved_cash",
        active_reserved,
    )
    monkeypatch.setattr(
        order_intent_service,
        "_upsert_reservation",
        upsert,
    )

    reserved = _reserve_buy_if_possible(
        session,  # type: ignore[arg-type]
        intent_id=intent.id,
        available_balance_usd=2.30,
        order_usd=needed_usd,
        available_balance_checked_at=(
            "2026-07-27T09:00:00+00:00"
        ),
    )

    assert reserved is expected_reserved
    assert events[:3] == [
        "get-intent",
        "lock-user",
        "sum-active-reservations",
    ]
    if expected_reserved:
        assert events[3:] == [("upsert", 1.0), "commit"]
    else:
        assert events[3:] == []


def test_three_forty_four_plan_and_reservations_preserve_one_dollar_buffer(
    monkeypatch,
):
    monkeypatch.delenv("AUTO_LIVE_BUY_BALANCE_BUFFER_USD", raising=False)
    allocation = build_console_affordable_buy_allocation(
        available_balance_usd=3.44,
        available_slots=7,
        eligible_candidate_count=10,
        min_order_usd=1.0,
        max_order_usd=25.0,
    )
    assert allocation["gross_cash_in_hand_usd"] == 3.44
    assert allocation["balance_buffer_usd"] == 1.0
    assert allocation["spendable_cash_usd"] == 2.44
    assert allocation["affordable_buy_count"] == 2
    assert allocation["initial_order_usd"] == 1.22

    intents = {
        intent_id: SimpleNamespace(id=intent_id, user_id=7)
        for intent_id in ("planned-buy-1", "planned-buy-2")
    }
    reservations: dict[str, float] = {}
    events: list[tuple[str, str]] = []

    class FakeSession:
        def __init__(self, intent_id: str):
            self.intent_id = intent_id

        def get(self, model, intent_id):
            assert model is order_intent_service.PolymarketAutoLiveOrderIntentRecord
            assert intent_id == self.intent_id
            return intents[intent_id]

        def commit(self):
            events.append(("commit", self.intent_id))

    def lock_scope(session, *, user_id):
        assert user_id == 7
        events.append(("lock", session.intent_id))
        return True

    def active_reserved(
        _session,
        *,
        user_id,
        exclude_intent_id,
        verified_balance_checked_at,
    ):
        assert user_id == 7
        assert verified_balance_checked_at == datetime(
            2026,
            7,
            27,
            9,
            tzinfo=UTC,
        )
        return sum(
            amount
            for intent_id, amount in reservations.items()
            if intent_id != exclude_intent_id
        )

    def upsert(_session, *, intent, amount_usd, status):
        assert status == "active"
        reservations[intent.id] = amount_usd

    monkeypatch.setattr(
        order_intent_service,
        "_lock_buy_reservation_scope",
        lock_scope,
    )
    monkeypatch.setattr(
        order_intent_service,
        "_active_reserved_cash",
        active_reserved,
    )
    monkeypatch.setattr(
        order_intent_service,
        "_upsert_reservation",
        upsert,
    )

    results = [
        _reserve_buy_if_possible(
            FakeSession(intent_id),  # type: ignore[arg-type]
            intent_id=intent_id,
            available_balance_usd=3.44,
            order_usd=float(allocation["initial_order_usd"] or 0.0),
            available_balance_checked_at=(
                "2026-07-27T09:00:00+00:00"
            ),
        )
        for intent_id in intents
    ]

    assert results == [True, True]
    assert reservations == {
        "planned-buy-1": 1.22,
        "planned-buy-2": 1.22,
    }
    assert round(3.44 - sum(reservations.values()), 2) == 1.00
    assert events == [
        ("lock", "planned-buy-1"),
        ("commit", "planned-buy-1"),
        ("lock", "planned-buy-2"),
        ("commit", "planned-buy-2"),
    ]


def test_post_exit_replacement_sizing_uses_only_fresh_spendable_cash_and_slots():
    unfunded = _post_exit_replacement_sizing(
        available_balance_usd=0.75,
        economically_active_position_count=9,
        slot_limit=10,
        min_order_usd=1,
        max_order_usd=25,
        balance_buffer_usd=1,
    )
    spread_across_two_affordable_slots = _post_exit_replacement_sizing(
        available_balance_usd=3.44,
        economically_active_position_count=0,
        slot_limit=10,
        min_order_usd=1,
        max_order_usd=25,
        balance_buffer_usd=1,
    )
    one_released_slot = _post_exit_replacement_sizing(
        available_balance_usd=3.44,
        economically_active_position_count=9,
        slot_limit=10,
        min_order_usd=1,
        max_order_usd=25,
        balance_buffer_usd=1,
    )

    assert unfunded["order_usd"] == 0
    assert unfunded["affordable_slot_count"] == 0
    assert spread_across_two_affordable_slots["order_usd"] == 1.22
    assert spread_across_two_affordable_slots["affordable_slot_count"] == 2
    assert one_released_slot["order_usd"] == 2.44
    assert one_released_slot["available_slots"] == 1


@pytest.mark.anyio
async def test_sell_preflight_caps_fresh_coalesced_redis_shares(
    monkeypatch,
):
    position = _wallet_position(shares=2.25)

    async def refresh_controls(*, user_id: int):
        assert user_id == 1
        return _live_controls()

    async def read_snapshot(**_kwargs):
        return _wallet_snapshot(position, source="redis-cache")

    async def fetch_market(_slug: str):
        return _market(open_market=True)

    monkeypatch.setattr(
        order_intent_service,
        "refresh_live_controls",
        refresh_controls,
    )
    monkeypatch.setattr(
        order_intent_service,
        "read_console_wallet_positions_snapshot",
        read_snapshot,
    )
    monkeypatch.setattr(
        console_profile,
        "fetch_market_by_slug",
        fetch_market,
    )
    intent = _sell_intent("fresh-share-cap-sell").model_copy(
        update={
            "requested_shares": 6.25,
            "current_shares": 6.25,
        }
    )

    prepared = await _prepare_intent_submission(intent)

    assert prepared.shares == 2.25
    assert prepared.sell_preflight_metadata["source"] == "redis-cache"
    assert prepared.sell_preflight_metadata["freshness_state"] == "fresh"
    assert prepared.sell_preflight_metadata["verified_shares"] == 2.25
    assert prepared.sell_preflight_metadata["submitted_shares"] == 2.25
    assert prepared.wallet_lineage_comparison["status"] == "match"


@pytest.mark.anyio
async def test_sell_preflight_rejects_cached_redis_snapshot(monkeypatch):
    position = _wallet_position()

    async def refresh_controls(*, user_id: int):
        assert user_id == 1
        return _live_controls()

    async def read_snapshot(**_kwargs):
        return _wallet_snapshot(
            position,
            source="redis-cache",
            freshness_state="cached",
        )

    monkeypatch.setattr(
        order_intent_service,
        "refresh_live_controls",
        refresh_controls,
    )
    monkeypatch.setattr(
        order_intent_service,
        "read_console_wallet_positions_snapshot",
        read_snapshot,
    )

    with pytest.raises(AutoLiveExecutorError) as error:
        await _prepare_intent_submission(_sell_intent("cached-sell"))

    assert error.value.code == "POSITION_UNAVAILABLE"


@pytest.mark.anyio
async def test_buy_preflight_rejects_opposite_side_exposure_in_same_market(
    monkeypatch,
):
    opposite_side_position = replace(_wallet_position(), side="NO")

    async def refresh_controls(*, user_id: int):
        assert user_id == 1
        return _live_controls()

    async def read_snapshot(**kwargs):
        assert kwargs == {
            "force_fresh": True,
            "caller_source": "auto-live-stage3-buy-pre-submit",
            "max_age_seconds": 0,
        }
        return _wallet_snapshot(opposite_side_position)

    async def enrich_positions(positions):
        assert positions == [opposite_side_position]
        return [opposite_side_position], {
            "unresolved_position_count": 0,
        }

    monkeypatch.setattr(
        order_intent_service,
        "refresh_live_controls",
        refresh_controls,
    )
    monkeypatch.setattr(
        order_intent_service,
        "read_console_wallet_positions_snapshot",
        read_snapshot,
    )
    monkeypatch.setattr(
        order_intent_service,
        "enrich_console_wallet_positions_authoritatively",
        enrich_positions,
    )
    intent = _intent(
        intent_id="opposite-side-market-exposure",
        status="READY",
    ).model_copy(
        update={
            "market_id": "legacy-numeric-market-id",
            "slug": "resolved-market-slug",
            "condition_id": "condition-1",
            "side": "YES",
            "execution_metadata_json": {
                "expected_stage1_wallet_lineage": {
                    "fetched_at": "2026-07-20T00:00:00+00:00",
                    "account_identity": "wallet-a",
                    "credential_artifact": {
                        "inode": 11,
                        "mtime_ns": 22,
                        "size": 33,
                    },
                    "position_classifier_version": 3,
                },
            },
        }
    )

    with pytest.raises(AutoLiveExecutorError) as error:
        await _prepare_intent_submission(intent)

    assert error.value.code == "PERMANENT_REJECTION"
    assert error.value.retryable is False
    assert "duplicate exposure is not allowed" in error.value.message


@pytest.mark.anyio
async def test_buy_preflight_keeps_unresolved_other_markets_as_capacity_not_global_block(
    monkeypatch,
):
    unresolved_position = replace(
        _wallet_position(),
        market_id="unresolved-other-market",
        slug="unresolved-other-market",
        condition_id="unresolved-condition",
        classification="stale_or_unknown",
        classification_reason="Exact open/closed state unavailable.",
        authoritative_market_state="unknown",
    )

    async def refresh_controls(*, user_id: int):
        assert user_id == 1
        return _live_controls()

    async def read_snapshot(**_kwargs):
        return _wallet_snapshot(unresolved_position)

    async def enrich_positions(positions):
        assert positions == [unresolved_position]
        return [unresolved_position], {"unresolved_position_count": 1}

    async def refresh_quote(*, slug: str | None, side: str):
        assert slug == "authoritative-buy-target"
        assert side == "YES"
        return SimpleNamespace(market=object(), current_price_cents=80.0)

    monkeypatch.setattr(
        order_intent_service,
        "refresh_live_controls",
        refresh_controls,
    )
    monkeypatch.setattr(
        order_intent_service,
        "read_console_wallet_positions_snapshot",
        read_snapshot,
    )
    monkeypatch.setattr(
        order_intent_service,
        "enrich_console_wallet_positions_authoritatively",
        enrich_positions,
    )
    monkeypatch.setattr(
        order_intent_service,
        "refresh_execution_quote",
        refresh_quote,
    )
    intent = _intent(
        intent_id="authoritative-buy-with-unresolved-capacity",
        status="READY",
    ).model_copy(
        update={
            "slug": "authoritative-buy-target",
            "execution_metadata_json": {
                "expected_stage1_wallet_lineage": _expected_wallet_lineage(),
                "stage3_capacity_policy": {
                    "slot_limit": 10,
                    "dust_threshold_usd": 0.01,
                },
            },
        }
    )

    prepared = await _prepare_intent_submission(intent)

    assert prepared.order_usd == 5.0
    capacity = intent.execution_metadata_json["stage2_authoritative_capacity"]
    assert capacity["policy"] == "conservative-unresolved-occupancy"
    assert capacity["unresolved_occupied_market_ids"] == [
        "unresolved-other-market"
    ]


@pytest.mark.anyio
async def test_sell_preflight_executes_exact_stage2_exit_with_unresolved_open_state(
    monkeypatch,
):
    unresolved_position = replace(
        _wallet_position(shares=2.25),
        classification="stale_or_unknown",
        classification_reason="Exact open/closed state unavailable.",
        authoritative_market_state="unknown",
        resolution_status=None,
    )

    async def refresh_controls(*, user_id: int):
        assert user_id == 1
        return _live_controls()

    async def read_snapshot(**_kwargs):
        return _wallet_snapshot(unresolved_position)

    async def enrich_positions(positions):
        assert positions == [unresolved_position]
        return [unresolved_position], {"unresolved_position_count": 1}

    monkeypatch.setattr(
        order_intent_service,
        "refresh_live_controls",
        refresh_controls,
    )
    monkeypatch.setattr(
        order_intent_service,
        "read_console_wallet_positions_snapshot",
        read_snapshot,
    )
    monkeypatch.setattr(
        order_intent_service,
        "enrich_console_wallet_positions_authoritatively",
        enrich_positions,
    )

    prepared = await _prepare_intent_submission(
        _sell_intent("authoritative-unresolved-exit")
    )

    assert prepared.shares == 2.25
    assert prepared.sell_preflight_metadata[
        "stage2_authoritative_execution"
    ] is True
    assert prepared.sell_preflight_metadata[
        "unresolved_market_identity_accepted_for_risk_reducing_sell"
    ] is True


@pytest.mark.anyio
@pytest.mark.parametrize(
    "missing_lineage_field",
    [
        "stage1",
        "account_identity",
        "credential_artifact",
        "position_classifier_version",
    ],
)
async def test_buy_preflight_requires_complete_matching_wallet_lineage(
    monkeypatch,
    missing_lineage_field,
):
    position = _wallet_position()

    async def refresh_controls(*, user_id: int):
        assert user_id == 1
        return _live_controls()

    snapshot = _wallet_snapshot(position)
    if missing_lineage_field == "account_identity":
        snapshot = replace(snapshot, account_identity=None)
    elif missing_lineage_field == "credential_artifact":
        snapshot = replace(snapshot, credential_artifact={})
    elif missing_lineage_field == "position_classifier_version":
        snapshot = replace(snapshot, position_classifier_version=None)

    async def read_snapshot(**_kwargs):
        return snapshot

    monkeypatch.setattr(
        order_intent_service,
        "refresh_live_controls",
        refresh_controls,
    )
    monkeypatch.setattr(
        order_intent_service,
        "read_console_wallet_positions_snapshot",
        read_snapshot,
    )
    execution_metadata = {}
    if missing_lineage_field != "stage1":
        execution_metadata["expected_stage1_wallet_lineage"] = {
            "fetched_at": "2026-07-20T00:00:00+00:00",
            "account_identity": "wallet-a",
            "credential_artifact": {
                "inode": 11,
                "mtime_ns": 22,
                "size": 33,
            },
            "position_classifier_version": 3,
        }
    intent = _intent(
        intent_id=f"incomplete-lineage-{missing_lineage_field}",
        status="READY",
    ).model_copy(
        update={
            "slug": "resolved-market-slug",
            "execution_metadata_json": execution_metadata,
        }
    )

    with pytest.raises(AutoLiveExecutorError) as error:
        await _prepare_intent_submission(intent)

    assert error.value.code == "POSITION_LINEAGE_UNAVAILABLE"
    assert error.value.retryable is True


def test_wallet_lineage_comparison_fails_closed_on_account_or_credential_change():
    comparison = _compare_wallet_snapshot_lineage(
        expected={
            "fetched_at": "2026-07-27T00:00:00+00:00",
            "account_identity": "wallet-a",
            "credential_artifact": {
                "inode": 11,
                "mtime_ns": 22,
                "size": 33,
            },
            "position_classifier_version": 3,
        },
        actual={
            "fetched_at": "2026-07-27T00:01:00+00:00",
            "account_identity": "wallet-b",
            "credential_artifact": {
                "inode": 12,
                "mtime_ns": 22,
                "size": 33,
            },
            "position_classifier_version": 3,
        },
    )

    assert comparison["status"] == "mismatch"
    assert comparison["mismatches"] == [
        "account_identity",
        "credential_artifact.inode",
    ]


@pytest.mark.anyio
async def test_redeem_preflight_forces_fresh_lineage_fenced_wallet_snapshot(
    monkeypatch,
):
    position = _wallet_position(
        classification="positive_payout_claimable",
        is_claimable=True,
        expected_payout_usdc=2.5,
    )

    async def refresh_controls(*, user_id: int):
        assert user_id == 1
        return _live_controls()

    async def read_snapshot(**kwargs):
        assert kwargs == {
            "force_fresh": True,
            "caller_source": "auto-live-stage3-redeem-pre-submit",
            "max_age_seconds": 0,
        }
        return _wallet_snapshot(position)

    monkeypatch.setattr(
        order_intent_service,
        "refresh_live_controls",
        refresh_controls,
    )
    monkeypatch.setattr(
        order_intent_service,
        "read_console_wallet_positions_snapshot",
        read_snapshot,
    )
    intent = _redeem_intent("lineage-fenced-redeem").model_copy(
        update={
            "execution_metadata_json": {
                "idempotency_key_format": "auto-live:v2",
                "expected_stage1_wallet_lineage": {
                    "fetched_at": "2026-07-20T00:00:00+00:00",
                    "account_identity": "wallet-a",
                    "credential_artifact": {
                        "inode": 11,
                        "mtime_ns": 22,
                        "size": 33,
                    },
                    "position_classifier_version": 3,
                },
            }
        }
    )

    prepared = await _prepare_intent_submission(intent)

    assert prepared.condition_ids == ["condition-1"]
    assert prepared.wallet_snapshot_lineage["source"] == "live-cli"
    assert prepared.wallet_snapshot_lineage["freshness_state"] == "fresh"
    assert prepared.wallet_snapshot_lineage["account_identity"] == "wallet-a"
    assert prepared.wallet_lineage_comparison["status"] == "match"
    assert prepared.wallet_lineage_comparison["mismatches"] == []


@pytest.mark.anyio
async def test_redeem_coordinator_consumes_verified_snapshot_before_write(
    monkeypatch,
):
    preflight_position = _wallet_position(
        classification="positive_payout_claimable",
        is_claimable=True,
        expected_payout_usdc=2.5,
    )
    post_submit_position = replace(
        preflight_position,
        shares=1.5,
        exposure_usd=1.5,
    )
    snapshot_calls = 0
    coordinator_events: list[str] = []

    async def refresh_controls(*, user_id: int):
        assert user_id == 1
        return _live_controls()

    async def read_snapshot(**kwargs):
        nonlocal snapshot_calls
        snapshot_calls += 1
        if snapshot_calls == 1:
            assert kwargs == {
                "force_fresh": True,
                "caller_source": "auto-live-stage3-redeem-pre-submit",
                "max_age_seconds": 0,
            }
            return _wallet_snapshot(preflight_position)
        assert kwargs == {
            "force_fresh": True,
            "caller_source": (
                "auto-live-stage3-redeem-post-submit-reconcile"
            ),
            "max_age_seconds": 0,
        }
        return _wallet_snapshot(post_submit_position)

    async def fake_submit_scoped_redeem(**kwargs):
        read_wallet_positions = kwargs["read_wallet_positions"]
        first_positions = await read_wallet_positions()
        coordinator_events.append("pre-write-read")
        assert first_positions == [preflight_position]
        coordinator_events.append("external-write")
        second_positions = await read_wallet_positions()
        coordinator_events.append("post-write-read")
        assert second_positions == [post_submit_position]
        return SimpleNamespace(
            outcomes=[
                SimpleNamespace(
                    status="confirmed",
                    detail="Redeem confirmed.",
                )
            ],
            claim_attempted=False,
        )

    monkeypatch.setattr(
        order_intent_service,
        "refresh_live_controls",
        refresh_controls,
    )
    monkeypatch.setattr(
        order_intent_service,
        "read_console_wallet_positions_snapshot",
        read_snapshot,
    )
    monkeypatch.setattr(
        order_intent_service,
        "submit_scoped_redeem",
        fake_submit_scoped_redeem,
    )
    monkeypatch.setattr(
        order_intent_service,
        "BullpenLiveExecutor",
        lambda: SimpleNamespace(),
    )
    monkeypatch.setattr(
        order_intent_service,
        "auto_live_execution_v2_shadow_only",
        lambda: False,
    )
    intent = _redeem_intent("verified-reader-redeem").model_copy(
        update={
            "execution_metadata_json": {
                "idempotency_key_format": "auto-live:v2",
                "expected_stage1_wallet_lineage": {
                    "fetched_at": "2026-07-20T00:00:00+00:00",
                    "account_identity": "wallet-a",
                    "credential_artifact": {
                        "inode": 11,
                        "mtime_ns": 22,
                        "size": 33,
                    },
                    "position_classifier_version": 3,
                },
            }
        }
    )

    prepared = await _prepare_intent_submission(intent)
    result = await _submit_prepared_intent(prepared)

    assert result.status == "SETTLEMENT_PENDING"
    assert result.next_attempt_at is not None
    assert snapshot_calls == 2
    assert coordinator_events == [
        "pre-write-read",
        "external-write",
        "post-write-read",
    ]


@pytest.mark.anyio
async def test_redeem_preflight_rejects_stage1_wallet_lineage_mismatch(
    monkeypatch,
):
    position = _wallet_position(
        classification="positive_payout_claimable",
        is_claimable=True,
        expected_payout_usdc=2.5,
    )

    async def refresh_controls(*, user_id: int):
        assert user_id == 1
        return _live_controls()

    async def read_snapshot(**_kwargs):
        return replace(
            _wallet_snapshot(position),
            account_identity="wallet-b",
        )

    monkeypatch.setattr(
        order_intent_service,
        "refresh_live_controls",
        refresh_controls,
    )
    monkeypatch.setattr(
        order_intent_service,
        "read_console_wallet_positions_snapshot",
        read_snapshot,
    )
    intent = _redeem_intent("lineage-mismatch-redeem").model_copy(
        update={
            "execution_metadata_json": {
                "idempotency_key_format": "auto-live:v2",
                "expected_stage1_wallet_lineage": {
                    "fetched_at": "2026-07-20T00:00:00+00:00",
                    "account_identity": "wallet-a",
                    "credential_artifact": {
                        "inode": 11,
                        "mtime_ns": 22,
                        "size": 33,
                    },
                    "position_classifier_version": 3,
                },
            }
        }
    )

    with pytest.raises(AutoLiveExecutorError) as error:
        await _prepare_intent_submission(intent)

    assert error.value.code == "POSITION_LINEAGE_MISMATCH"
    assert error.value.retryable is False
    assert "no external redeem write was issued" in error.value.message


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


def test_user_cancel_only_cancels_an_intent_before_remote_submission(monkeypatch):
    released_intent_ids: list[str] = []
    monkeypatch.setattr(
        order_intent_service,
        "_release_reservation",
        lambda _session, intent: released_intent_ids.append(intent.id),
    )
    record = SimpleNamespace(
        id="intent-ready",
        status="READY",
        action="buy",
        retryable=True,
        next_attempt_at="later",
        terminal_at=None,
        last_error_code=None,
        last_error_message=None,
        execution_metadata_json={},
    )

    assert _cancel_unsubmitted_intent_for_user(
        object(),
        record=record,
    )
    assert record.status == "CANCELLED"
    assert record.retryable is False
    assert record.next_attempt_at is None
    assert record.last_error_code == "RUN_CANCELLED_BY_USER"
    assert released_intent_ids == ["intent-ready"]

    record.status = "SUBMITTED"
    assert not _cancel_unsubmitted_intent_for_user(object(), record=record)


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


def test_classify_executor_error_preserves_terminal_doctor_code():
    error = classify_executor_error(
        (
            "Polymarket preflight failed: "
            '{"code":"POLYMARKET_WALLET_ROUTE_UNCONFIRMED",'
            '"safe_to_retry":false,"support_required":true}'
        )
    )

    assert error.code == "POLYMARKET_WALLET_ROUTE_UNCONFIRMED"
    assert error.retryable is False
    assert error.ambiguous_submission is False


def test_long_typed_doctor_code_is_bounded_and_retained_in_metadata():
    upstream_code = f"POLYMARKET_{'X' * 70}"
    error = classify_executor_error(
        (
            "Polymarket preflight failed: "
            f'{{"code":"{upstream_code}","safe_to_retry":false}}'
        )
    )
    record = SimpleNamespace(
        execution_metadata_json={},
        action="buy",
        attempt_count=1,
    )
    attempt = SimpleNamespace(
        reconciliation_json={},
        sanitized_response_json={},
        executor_path=None,
    )

    _apply_executor_error(
        None,  # type: ignore[arg-type]
        record=record,
        attempt=attempt,
        exc=error,
    )

    assert error.code == "BULLPEN_SUPPORT_REQUIRED"
    assert len(error.code) <= 64
    assert error.upstream_error_code == upstream_code
    assert record.last_error_code == "BULLPEN_SUPPORT_REQUIRED"
    assert record.execution_metadata_json["typed_upstream_error"] == {
        "upstream_error_code": upstream_code,
        "persisted_error_code": "BULLPEN_SUPPORT_REQUIRED",
    }
    assert attempt.reconciliation_json["typed_upstream_error"] == {
        "upstream_error_code": upstream_code,
        "persisted_error_code": "BULLPEN_SUPPORT_REQUIRED",
    }


def test_classify_executor_error_keeps_generic_doctor_failure_retryable():
    error = classify_executor_error(
        "Bullpen doctor failed while reading a transient upstream response."
    )

    assert error.code == "DOCTOR_READ_FAILED"
    assert error.retryable is True


def test_ambiguous_write_boundary_persists_timestamp_and_retry_fence():
    record = SimpleNamespace(
        action="buy",
        attempt_count=1,
        execution_metadata_json={"reservation_state": "active"},
        first_submitted_at=None,
        last_submitted_at=None,
        remote_order_id=None,
        remote_transaction_hash=None,
        reserved_cash_usd=5.0,
        retryable=True,
        status="SUBMITTING",
        next_attempt_at=None,
        last_error_code=None,
        last_error_message=None,
        error_class=None,
    )
    attempt = SimpleNamespace(
        completed_at=None,
        error_code=None,
        error_message=None,
        reconciliation_json={},
        result_status=None,
    )
    error = AutoLiveExecutorError(
        code="AMBIGUOUS_SUBMISSION",
        message="Buy request timed out after crossing the write boundary.",
        retryable=True,
        ambiguous_submission=True,
        provider_alias="rpc-1",
    )

    order_intent_service._apply_executor_error(
        object(),
        record=record,
        attempt=attempt,
        exc=error,
    )

    assert record.status == "CONFIRMING"
    assert record.first_submitted_at is not None
    assert record.last_submitted_at == record.first_submitted_at
    assert (
        record.execution_metadata_json["uncertain_remote_write_boundary"][
            "automatic_resubmission"
        ]
        is False
    )
    assert (
        attempt.reconciliation_json["uncertain_remote_write_boundary"][
            "provider_alias"
        ]
        == "rpc-1"
    )

    # Even after the bounded ambiguity window terminalizes this row, missing
    # order IDs cannot release the reservation or permit a duplicate retry.
    record.status = "TIMED_OUT"
    assert (
        order_intent_service._release_buy_reservation_if_no_remote_evidence(
            object(),
            record,
            reason="Ambiguity aged out.",
        )
        is False
    )
    with pytest.raises(ValueError, match="reconciled instead of retried"):
        _assert_intent_retry_allowed(
            record,
            remote_absence_verified=True,
        )


def test_cancelled_buy_without_fill_field_does_not_prove_zero_fill():
    unknown_fill = order_intent_service.IntentSubmissionResult(
        status="CANCELLED",
        detail="Remote order was cancelled.",
        retryable=False,
        filled_shares=None,
        remaining_shares=6.25,
    )
    explicit_zero_fill = order_intent_service.IntentSubmissionResult(
        status="CANCELLED",
        detail="Remote order was cancelled before any fill.",
        retryable=False,
        filled_shares=0.0,
        remaining_shares=6.25,
    )

    assert not order_intent_service._result_definitively_proves_no_fill(
        unknown_fill
    )
    assert order_intent_service._result_definitively_proves_no_fill(
        explicit_zero_fill
    )


@pytest.mark.anyio
@pytest.mark.parametrize("failure_kind", ["rate_limit", "http_503"])
async def test_buy_write_boundary_uncertainty_never_rotates_to_second_provider(
    monkeypatch,
    failure_kind,
):
    calls: list[str] = []

    class FailingExecutor:
        async def buy_limit(self, **kwargs):
            calls.append(str(kwargs["extra_env"]["provider"]))
            if failure_kind == "rate_limit":
                raise AutoLiveExecutorError(
                    code="RPC_RATE_LIMITED",
                    message="429 rate limit after the buy request was sent",
                    retryable=True,
                )
            raise RuntimeError("503 Service Unavailable after write dispatch")

    monkeypatch.setattr(
        order_intent_service,
        "auto_live_execution_v2_shadow_only",
        lambda: False,
    )
    monkeypatch.setattr(
        order_intent_service,
        "BullpenLiveExecutor",
        FailingExecutor,
    )
    prepared = order_intent_service.PreparedIntentSubmission(
        intent_id="ambiguous-buy",
        user_id=7,
        action="buy",
        side="YES",
        market_id="numeric-market-id",
        slug="wallet-market-slug",
        condition_ids=[],
        order_usd=1.22,
        shares=2,
        limit_price_cents=61,
        available_balance_usd=3.44,
        provider_attempts=[
            ("rpc-1", {"provider": "rpc-1"}),
            ("rpc-2", {"provider": "rpc-2"}),
        ],
        detail="Preflight passed.",
    )

    with pytest.raises(AutoLiveExecutorError) as error:
        await _submit_prepared_intent(prepared)

    assert error.value.code == "AMBIGUOUS_SUBMISSION"
    assert error.value.ambiguous_submission is True
    assert calls == ["rpc-1"]


@pytest.mark.anyio
async def test_redeem_write_boundary_rate_limit_never_rotates_provider(
    monkeypatch,
):
    calls: list[int] = []

    async def failing_redeem(**_kwargs):
        calls.append(1)
        raise AutoLiveExecutorError(
            code="RPC_RATE_LIMITED",
            message="429 rate limit after redeem dispatch",
            retryable=True,
        )

    monkeypatch.setattr(
        order_intent_service,
        "auto_live_execution_v2_shadow_only",
        lambda: False,
    )
    monkeypatch.setattr(
        order_intent_service,
        "BullpenLiveExecutor",
        lambda: SimpleNamespace(),
    )
    monkeypatch.setattr(
        order_intent_service,
        "submit_scoped_redeem",
        failing_redeem,
    )
    prepared = order_intent_service.PreparedIntentSubmission(
        intent_id="ambiguous-redeem",
        user_id=7,
        action="redeem",
        side=None,
        market_id="numeric-market-id",
        slug="wallet-market-slug",
        condition_ids=["condition-1"],
        order_usd=None,
        shares=2,
        limit_price_cents=None,
        available_balance_usd=3.44,
        provider_attempts=[
            ("rpc-1", {"provider": "rpc-1"}),
            ("rpc-2", {"provider": "rpc-2"}),
        ],
        detail="Preflight passed.",
        redeem_preflight_wallet_positions=(_wallet_position(),),
    )

    with pytest.raises(AutoLiveExecutorError) as error:
        await _submit_prepared_intent(prepared)

    assert error.value.code == "AMBIGUOUS_SUBMISSION"
    assert error.value.ambiguous_submission is True
    assert calls == [1]


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


def test_build_order_funnel_counts_all_definitive_failure_outcomes():
    funnel = build_order_funnel(
        [
            _intent(
                intent_id="failed",
                status="FAILED_PERMANENT",
                retryable=False,
            ),
            _intent(
                intent_id="rejected",
                status="REJECTED",
                retryable=False,
            ),
            _intent(
                intent_id="timed-out",
                status="TIMED_OUT",
                retryable=False,
            ),
            _intent(
                intent_id="cancelled",
                status="CANCELLED",
                retryable=False,
            ),
        ]
    )

    assert funnel.permanently_failed == 3
    assert funnel.cancelled == 1


def test_evidence_free_terminal_rows_are_fail_closed_in_funnel_and_run_status():
    intents = [
        _intent(
            intent_id=f"legacy-sell-{index}",
            status="FILLED",
            action="sell",
            attempt_count=1,
            retryable=False,
            filled_shares=6.25,
        )
        for index in range(5)
    ]
    intents.append(
        _intent(
            intent_id="timed-out-buy",
            status="TIMED_OUT",
            action="buy",
            attempt_count=2,
            retryable=False,
        )
    )

    funnel = build_order_funnel(intents)

    assert funnel.planned == 6
    assert funnel.attempted == 6
    assert funnel.remotely_accepted == 0
    assert funnel.confirmed == 0
    assert funnel.filled == 0
    assert funnel.permanently_failed == 6
    assert 0 <= funnel.confirmation_rate <= 1
    assert 0 <= funnel.fill_rate <= 1
    assert derive_run_status_from_intents(intents) == "failed"


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


def test_derive_run_status_keeps_retryable_intents_running_and_terminal_rejections_failed():
    retrying = [
        _intent(
            intent_id="retrying",
            status="RETRY_WAIT",
            action="sell",
            attempt_count=1,
            retryable=True,
        )
    ]
    rejected = [
        _intent(
            intent_id="rejected",
            status="REJECTED",
            action="buy",
            attempt_count=1,
            retryable=False,
        )
    ]
    timed_out = [
        _intent(
            intent_id="timed-out",
            status="TIMED_OUT",
            action="sell",
            attempt_count=2,
            retryable=False,
        )
    ]

    assert derive_run_status_from_intents(retrying) == "running"
    assert derive_run_status_from_intents(rejected) == "failed"
    assert derive_run_status_from_intents(timed_out) == "failed"


@pytest.mark.parametrize(
    "status",
    ["WAITING_FOR_COLLATERAL", "WAITING_FOR_EXIT"],
)
def test_pre_submit_waits_stay_running_without_remote_confirmation(
    status: str,
):
    intents = [
        _intent(
            intent_id=f"waiting-{status.lower()}",
            status=status,
            action="buy",
            attempt_count=0,
            retryable=True,
        )
    ]

    assert derive_run_status_from_intents(intents) == "running"
    assert build_order_funnel(intents).confirming == 0


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
    assert updated.submission_evidence_present is True
    assert updated.submission_evidence_kind == "submitted_at"
    assert updated.executed_at == "2026-07-18T10:00:05+00:00"


def test_build_order_plan_projects_evidence_free_fill_as_unsubmitted():
    order_plan = BullpenAutoLiveOrderPlan(
        id="legacy-exit",
        action="sell",
        side="YES",
        status="filled",
        stage3_status="EXIT_SUBMITTED",
        market_id="market-1",
        market_title="Legacy evidence-free exit",
        order_size_usd=5.0,
        shares=6.25,
        limit_price_cents=80.0,
        max_slippage_cents=2.0,
        dry_run=False,
        detail="Wallet state was empty.",
        execution_response="Legacy inferred fill.",
        created_at="2026-07-18T10:00:00+00:00",
        executed_at="2026-07-18T10:00:05+00:00",
    )
    intent = _intent(
        intent_id="legacy-exit",
        status="FILLED",
        action="sell",
        attempt_count=1,
        retryable=False,
        filled_shares=6.25,
    )

    updated = build_order_plan_from_intent(order_plan, intent)

    assert updated.status == "deferred"
    assert updated.stage3_status == "EXIT_NOT_SUBMITTED"
    assert updated.execution_response is None
    assert updated.submission_evidence_present is False
    assert updated.submission_evidence_kind is None
    assert updated.executed_at is None
    assert updated.confirmed_at is None
    assert "no durable submission" in updated.detail


def test_build_order_plan_projects_uncertain_write_marker_as_submission_evidence():
    order_plan = BullpenAutoLiveOrderPlan(
        id="ambiguous-buy",
        action="buy",
        side="YES",
        status="planned",
        market_id="market-1",
        market_title="Ambiguous remote write",
        order_size_usd=5.0,
        shares=6.25,
        limit_price_cents=80.0,
        max_slippage_cents=2.0,
        dry_run=False,
        detail="Order planned.",
        created_at="2026-07-18T10:00:00+00:00",
    )
    intent = _intent(
        intent_id="ambiguous-buy",
        status="CONFIRMING",
        attempt_count=1,
    ).model_copy(
        update={
            "execution_metadata_json": {
                "uncertain_remote_write_boundary": {
                    "recorded_at": "2026-07-18T10:00:05+00:00",
                }
            }
        }
    )

    updated = build_order_plan_from_intent(order_plan, intent)

    assert updated.status == "confirming"
    assert updated.submission_evidence_present is True
    assert updated.submission_evidence_kind == "uncertain_write_boundary"



def test_authoritative_stage2_contract_counts_use_latest_persisted_contract():
    run = SimpleNamespace(
        stage_results=[
            SimpleNamespace(
                stage_number=2,
                outputs={
                    "workflow_stage_key": "llm",
                    "stage2_actionable_contract_authoritative": True,
                    "stage2_actionable_exit_market_ids": [],
                    "stage2_actionable_buy_market_ids": ["legacy-buy"],
                },
            ),
            SimpleNamespace(
                stage_number=3,
                outputs={
                    "workflow_stage_key": "invest",
                    "stage2_actionable_contract_authoritative": True,
                    "stage2_actionable_exit_market_ids": [
                        "exit-1",
                        "exit-2",
                        "exit-3",
                        "exit-4",
                    ],
                    "stage2_actionable_buy_market_ids": [
                        "buy-1",
                        "buy-2",
                        "buy-3",
                        "buy-4",
                        "buy-5",
                    ],
                },
            ),
        ]
    )

    assert _authoritative_stage2_contract_counts(run) == {
        "sell": 4,
        "buy": 5,
        "total": 9,
    }


def test_support_blocker_preserves_planned_summary_and_blocks_execution_step():
    blocked_intent = _intent(
        intent_id="support-blocked-buy",
        status="DEFERRED",
        action="buy",
        attempt_count=0,
        retryable=False,
        last_error_code="POLYMARKET_WALLET_ROUTE_UNCONFIRMED",
    ).model_copy(
        update={
            "execution_metadata_json": {
                "support_blocked": True,
                "stage2_authoritative_plan_preserved": True,
                "automatic_resubmission": False,
            }
        }
    )
    funnel = build_order_funnel([blocked_intent])

    summary = _summary_text("failed", funnel, [blocked_intent])
    step = _persisted_execution_step(
        key="buy",
        label="Invest planned orders",
        step_number=2,
        counts={"planned": 1, "processed": 1, "submitted": 0},
        intents=[blocked_intent],
        recovery_required=False,
    )

    assert "preserved 1 planned order intent" in summary
    assert "blocked/deferred" in summary
    assert "Auto Runs are paused" in summary
    assert step["status"] == "blocked"
    assert step["planned_orders"] == 1
    assert step["processed_orders"] == 1
    assert step["submitted_orders"] == 0
    assert "Bullpen support" in step["detail"]


def test_persisted_execution_step_reports_missing_authoritative_intents():
    step = _persisted_execution_step(
        key="buy",
        label="Invest planned orders",
        step_number=2,
        counts={"planned": 5, "processed": 0, "submitted": 0},
        intents=[],
        recovery_required=False,
    )

    assert step["status"] == "blocked"
    assert "5 authoritative Stage 2 actionable" in step["detail"]
    assert step["planned_orders"] == 5
    assert step["processed_orders"] == 0
    assert step["submitted_orders"] == 0

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


def test_persisted_execution_step_completed_detail_omits_persisted_records_copy():
    terminal_intent = _intent(
        intent_id="terminal-buy",
        status="FAILED_PERMANENT",
        action="buy",
        attempt_count=1,
    )
    step = _persisted_execution_step(
        key="buy",
        label="Invest planned orders",
        step_number=2,
        counts={"planned": 1, "processed": 1, "submitted": 0},
        intents=[terminal_intent],
        recovery_required=False,
    )

    assert step["status"] == "completed"
    assert "Processed 1 of 1" in step["detail"]
    assert "0 crossed the remote-write boundary" in step["detail"]


def test_persisted_execution_step_does_not_call_retry_wait_completed_after_attempt():
    retrying_intent = _intent(
        intent_id="retrying-sell",
        status="RETRY_WAIT",
        action="sell",
        attempt_count=1,
        retryable=True,
    )

    step = _persisted_execution_step(
        key="sell",
        label="Event Exits",
        step_number=1,
        counts={"planned": 1, "processed": 1, "submitted": 0},
        intents=[retrying_intent],
        recovery_required=False,
    )

    assert step["status"] == "running"
    assert "retry" in step["detail"].lower()


def test_automatic_attempt_budget_is_bounded_and_preserves_legacy_zero_budget():
    now = datetime(2026, 7, 26, 12, 0, tzinfo=UTC)
    legacy = SimpleNamespace(
        max_attempts=0,
        attempt_count=0,
        status="READY",
        retryable=True,
        next_attempt_at=now,
        terminal_at=None,
        last_error_code=None,
        last_error_message=None,
        action="sell",
        execution_metadata_json={},
    )
    exhausted = SimpleNamespace(
        max_attempts=2,
        attempt_count=2,
        status="RETRY_WAIT",
        retryable=True,
        next_attempt_at=now,
        terminal_at=None,
        last_error_code=None,
        last_error_message=None,
        action="sell",
        execution_metadata_json={},
    )

    assert _automatic_attempt_budget_allows(legacy, now=now) is True
    assert legacy.max_attempts == 1

    assert _automatic_attempt_budget_allows(exhausted, now=now) is False
    assert exhausted.status == "FAILED_PERMANENT"
    assert exhausted.retryable is False
    assert exhausted.next_attempt_at is None
    assert exhausted.last_error_code == "ATTEMPT_BUDGET_EXHAUSTED"
    assert exhausted.execution_metadata_json["attempt_budget_exhausted"] is True


def test_retry_exhausted_buy_releases_its_active_cash_reservation(monkeypatch):
    now = datetime(2026, 7, 26, 12, 0, tzinfo=UTC)
    session = object()
    exhausted = SimpleNamespace(
        id="reserved-retrying-buy",
        max_attempts=2,
        attempt_count=2,
        status="RETRY_WAIT",
        retryable=True,
        next_attempt_at=now,
        terminal_at=None,
        last_error_code="RPC_RATE_LIMITED",
        last_error_message="Retryable write failed before the bounded retry.",
        action="buy",
        reserved_cash_usd=1.22,
        execution_metadata_json={"reservation_state": "active"},
    )
    released: list[str] = []

    def release_reservation(actual_session, intent):
        assert actual_session is session
        released.append(intent.id)
        intent.reserved_cash_usd = 0.0
        intent.execution_metadata_json = {
            **intent.execution_metadata_json,
            "reservation_state": "released",
        }

    monkeypatch.setattr(
        order_intent_service,
        "_release_reservation",
        release_reservation,
    )

    assert (
        _automatic_attempt_budget_allows(
            exhausted,
            now=now,
            session=session,  # type: ignore[arg-type]
        )
        is False
    )
    assert exhausted.status == "FAILED_PERMANENT"
    assert exhausted.last_error_code == "ATTEMPT_BUDGET_EXHAUSTED"
    assert exhausted.reserved_cash_usd == 0.0
    assert exhausted.execution_metadata_json["reservation_state"] == "released"
    assert released == ["reserved-retrying-buy"]
