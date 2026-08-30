"""Safe, idempotent Bullpen 008 Stage 6 execution adapter.

The production adapter is unreachable while 008 remains in shadow mode. Tests
inject a fake adapter to exercise submission, timeout, partial-fill, restart and
remote-ID reconciliation without touching a live account.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
import json
from typing import Awaitable, Callable, Protocol

from app.domains.bullpen008.constants import WORKFLOW_PROFILE
from app.domains.bullpen008.engine import stable_hash
from app.domains.bullpen008.planning import certificate_hash_is_valid, verify_action_plan
from app.domains.polymarket.bullpen import BullpenLiveExecutor
from app.domains.polymarket.runtime_broker import get_bullpen_runtime_broker

PersistIntent = Callable[[dict[str, object]], Awaitable[None]]
PersistTransition = Callable[[dict[str, object], str, dict[str, object]], Awaitable[None]]


class Bullpen008ExecutionAdapter(Protocol):
    async def find_existing(self, *, action: dict[str, object], idempotency_key: str) -> dict[str, object] | None: ...
    async def submit(self, *, action: dict[str, object], idempotency_key: str) -> dict[str, object]: ...
    async def reconcile(self, *, remote_id: str, action: dict[str, object]) -> dict[str, object]: ...


def build_durable_intent(*, action: dict[str, object], plan: dict[str, object]) -> dict[str, object]:
    action_id = str(action.get("action_id") or "")
    request = {
        "workflow_profile": WORKFLOW_PROFILE,
        "plan_id": plan.get("plan_id"),
        "plan_hash": plan.get("plan_hash"),
        "stage4_certificate_hash": plan.get("stage4_certificate_hash"),
        "action": action,
    }
    request_hash = stable_hash(request)
    return {
        "intent_id": "b008i-" + stable_hash({"action_id": action_id, "plan_hash": plan.get("plan_hash")})[:32],
        "workflow_profile": WORKFLOW_PROFILE,
        "run_id": plan.get("run_id"),
        "plan_id": plan.get("plan_id"),
        "action_id": action_id,
        "action_type": action.get("action_type"),
        "market_id": action.get("market_id"),
        "condition_id": action.get("condition_id"),
        "side": action.get("side"),
        "status": "Ready",
        "idempotency_key": f"bullpen008:{plan.get('plan_hash')}:{action_id}",
        "request_hash": request_hash,
        "stage4_certificate_hash": plan.get("stage4_certificate_hash"),
        "stage5_plan_hash": plan.get("plan_hash"),
        "attempt_number": 0,
        "remote_order_id": None,
        "remote_transaction_id": None,
        "created_at": datetime.now(UTC).isoformat(),
        "sanitized_request": request,
    }


def _remote_id(payload: dict[str, object]) -> str | None:
    for key in ("remote_order_id", "order_id", "id", "transaction_hash", "transaction_id", "tx_hash"):
        value = payload.get(key)
        if value:
            return str(value)
    return None


async def execute_certified_action(
    *,
    action: dict[str, object],
    plan: dict[str, object],
    stage4_certificate: dict[str, object],
    preflight: dict[str, object],
    adapter: Bullpen008ExecutionAdapter,
    persist_intent: PersistIntent,
    persist_transition: PersistTransition,
    existing_intent: dict[str, object] | None = None,
) -> dict[str, object]:
    """Execute exactly one immutable action, persisting before remote submission."""
    if not verify_action_plan(plan):
        return {"status": "Blocked", "blocker_code": "INVALID_STAGE5_PLAN_HASH"}
    if not certificate_hash_is_valid(stage4_certificate) or plan.get("stage4_certificate_hash") != stage4_certificate.get("certificate_hash"):
        return {"status": "Blocked", "blocker_code": "INVALID_STAGE4_CERTIFICATE_HASH"}
    if preflight.get("status") == "Blocked":
        return {
            "status": "Blocked",
            "blocker_code": "+".join(str(value) for value in preflight.get("blocker_codes", [])),
            "pre_submit_checks": preflight.get("pre_submit_checks", {}),
        }

    intent = dict(existing_intent or build_durable_intent(action=action, plan=plan))
    idempotency_key = str(intent["idempotency_key"])
    remote_id = str(intent.get("remote_order_id") or intent.get("remote_transaction_id") or "") or None
    if remote_id:
        await persist_transition(intent, "Confirming", {"reason": "resume_by_remote_id", "remote_id": remote_id})
        reconciled = await adapter.reconcile(remote_id=remote_id, action=action)
        status = str(reconciled.get("status") or "Recoverable")
        await persist_transition(intent, status, {"reconciliation": reconciled})
        return {**intent, **reconciled, "status": status, "resumed_without_resubmit": True}

    existing_remote = await adapter.find_existing(action=action, idempotency_key=idempotency_key)
    if existing_remote:
        remote_id = _remote_id(existing_remote)
        status = "Confirming" if remote_id else "Recoverable"
        await persist_transition(intent, status, {"remote_discovery": existing_remote})
        if not remote_id:
            return {**intent, "status": "Recoverable", "blocker_code": "AMBIGUOUS_REMOTE_RESULT"}
        reconciled = await adapter.reconcile(remote_id=remote_id, action=action)
        final_status = str(reconciled.get("status") or "Recoverable")
        await persist_transition(intent, final_status, {"reconciliation": reconciled})
        return {**intent, **reconciled, "remote_order_id": remote_id, "status": final_status, "resumed_without_resubmit": True}

    # This await is the irreversible boundary: persistence must succeed first.
    intent["status"] = "Submitting"
    intent["attempt_number"] = int(intent.get("attempt_number") or 0) + 1
    await persist_intent(intent)
    await persist_transition(intent, "Submitting", {"attempt_number": intent["attempt_number"]})
    try:
        submitted = await adapter.submit(action=action, idempotency_key=idempotency_key)
    except (TimeoutError, asyncio.TimeoutError) as exc:
        await persist_transition(intent, "Recoverable", {"error_code": "AMBIGUOUS_SUBMISSION", "message": str(exc)})
        return {**intent, "status": "Recoverable", "blocker_code": "AMBIGUOUS_SUBMISSION", "retryable": False}
    except Exception as exc:
        await persist_transition(intent, "Failed", {"error_code": "SUBMISSION_FAILED", "message": str(exc)})
        return {**intent, "status": "Failed", "blocker_code": "SUBMISSION_FAILED", "message": str(exc)}

    remote_id = _remote_id(submitted)
    if not remote_id:
        await persist_transition(intent, "Recoverable", {"error_code": "REMOTE_ID_MISSING", "response": submitted})
        return {**intent, "status": "Recoverable", "blocker_code": "REMOTE_ID_MISSING", "remote_payload": submitted}
    intent["remote_order_id"] = remote_id
    await persist_transition(intent, "Submitted", {"remote_id": remote_id, "response": submitted})
    try:
        reconciled = await adapter.reconcile(remote_id=remote_id, action=action)
    except Exception as exc:
        await persist_transition(intent, "Recoverable", {"error_code": "RECONCILIATION_FAILED", "message": str(exc), "remote_id": remote_id})
        return {**intent, "status": "Recoverable", "blocker_code": "RECONCILIATION_FAILED", "retryable": True}
    status = str(reconciled.get("status") or "Recoverable")
    await persist_transition(intent, status, {"reconciliation": reconciled})
    return {**intent, **reconciled, "status": status, "remote_order_id": remote_id}


class ProductionBullpen008Adapter:
    """Thin adapter over the existing account-wide serialized Bullpen runtime."""

    def __init__(self) -> None:
        self._executor = BullpenLiveExecutor()

    async def find_existing(self, *, action: dict[str, object], idempotency_key: str) -> dict[str, object] | None:
        # Durable DB lookup is performed before this adapter is called. Bullpen
        # has no provider-side client idempotency lookup, so an unknown outcome
        # must reconcile by a persisted remote ID and may never be resubmitted.
        return None

    async def submit(self, *, action: dict[str, object], idempotency_key: str) -> dict[str, object]:
        action_type = str(action.get("action_type") or "")
        market_id = str(action.get("market_id") or "")
        side = str(action.get("side") or "YES")
        if action_type == "claim":
            raw = await self._executor.redeem(
                dry_run=False,
                condition_ids=[str(action.get("condition_id"))] if action.get("condition_id") else None,
            )
        elif action_type == "cancel":
            remote_order_id = str(action.get("remote_order_id") or "")
            if not remote_order_id:
                raise ValueError("A remote order ID is required for cancellation.")
            payload = await get_bullpen_runtime_broker().execute_json(
                ["polymarket", "cancel", remote_order_id, "--yes", "--non-interactive", "--output", "json"],
                timeout_seconds=45,
            )
            return dict(payload) if isinstance(payload, dict) else {"result": payload, "remote_order_id": remote_order_id}
        elif action_type == "buy":
            raw = await self._executor.buy_limit(
                market_id=market_id,
                outcome=side,
                amount_usd=float(action.get("estimated_usd") or 0),
                max_price=float(action.get("permitted_price_cents") or 0) / 100,
            )
        elif action_type in {"full_exit", "trim"}:
            raw = await self._executor.sell_limit(
                market_id=market_id,
                outcome=side,
                shares=float(action.get("quantity_shares") or 0),
                min_price=float(action.get("permitted_price_cents") or 0) / 100,
            )
        else:
            raise ValueError(f"Unsupported immutable action type: {action_type}")
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = {"raw": raw}
        return dict(payload) if isinstance(payload, dict) else {"result": payload}

    async def reconcile(self, *, remote_id: str, action: dict[str, object]) -> dict[str, object]:
        if action.get("action_type") in {"claim", "cancel"}:
            return {"status": "Reconciled", "remote_transaction_id": remote_id}
        payload = await self._executor.poll_order(order_id=remote_id, timeout_seconds=30)
        row = dict(payload) if isinstance(payload, dict) else {"raw": payload}
        raw_status = str(row.get("status") or "").lower()
        if raw_status in {"filled", "confirmed", "complete", "completed"}:
            status = "Reconciled"
        elif raw_status in {"partial", "partially_filled"}:
            status = "PartiallyFilled"
        elif raw_status in {"cancelled", "canceled", "rejected", "failed"}:
            status = "Failed"
        else:
            status = "Recoverable"
        return {
            "status": status,
            "remote_order_id": remote_id,
            "filled_shares": row.get("filled_shares") or row.get("filled") or 0,
            "filled_value_usd": row.get("filled_value_usd") or row.get("value") or 0,
            "average_price_cents": row.get("average_price_cents") or row.get("average_price"),
            "fees_usd": row.get("fees_usd") or row.get("fees"),
            "remote_payload": row,
        }
