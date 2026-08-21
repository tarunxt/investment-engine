#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy import select  # noqa: E402

from app.domains.bullpen_trade_analysis.service import (  # noqa: E402
    capture_auto_live_buy_pre_submit_sync,
    capture_auto_live_buy_result_sync,
    capture_auto_live_exit_pre_submit_sync,
    capture_auto_live_exit_result_sync,
)
from app.domains.polymarket.config import load_polymarket_config  # noqa: E402
from app.domains.polymarket.schemas import PolymarketLiveTradeDecision  # noqa: E402
from app.domains.polymarket_auto_live.models import PolymarketAutoLiveDecisionRecord  # noqa: E402
from app.domains.polymarket_auto_live.repository import record_to_decision  # noqa: E402
from app.infrastructure.database.sync_session import SyncSessionLocal  # noqa: E402
from app.domains.bullpen_trade_analysis.models import BullpenTradeAnalysisRecord  # noqa: E402

BACKFILL_SUMMARY = (
    "Backfilled from historical order data; detailed buy/sell snapshots unavailable."
)


def _manual_live_trades_path(user_id: int) -> Path:
    data_dir = Path(load_polymarket_config().data_dir)
    return data_dir / f"user-{user_id}" / "polymarket-live-trades.json"


def _load_manual_live_trades(user_id: int) -> list[PolymarketLiveTradeDecision]:
    file_path = _manual_live_trades_path(user_id)
    if not file_path.exists():
        return []
    payload = json.loads(file_path.read_text())
    if not isinstance(payload, list):
        return []
    return [PolymarketLiveTradeDecision.model_validate(item) for item in payload]


def _execution_payload_from_trade(trade: PolymarketLiveTradeDecision) -> str:
    payload = {
        "orderId": trade.id,
        "status": trade.status,
        "filledAmount": trade.amount,
        "filledShares": trade.shares,
        "avgPrice": trade.price,
        "fees": 0,
    }
    if trade.execution_response:
        try:
            parsed = json.loads(trade.execution_response)
        except json.JSONDecodeError:
            payload["raw_output"] = trade.execution_response
        else:
            if isinstance(parsed, dict):
                payload.update(parsed)
    return json.dumps(payload)


def _backfill_manual_live_trades(user_id: int) -> int:
    processed = 0
    trades = sorted(
        [trade for trade in _load_manual_live_trades(user_id) if trade.status == "executed"],
        key=lambda trade: trade.executed_at or trade.updated_at or trade.proposed_at,
    )
    for trade in trades:
        if trade.side == "BUY":
            capture_auto_live_buy_pre_submit_sync(
                user_id=user_id,
                entry_reference=f"backfill-manual:{trade.id}",
                context={
                    "source_variant": "backfill-manual-live",
                    "bot_name": "Bullpen x AI",
                    "strategy_name": "Bullpen x AI Manual",
                    "strategy_version": "historical-manual",
                    "event_id": trade.market_id,
                    "event_slug": trade.market_id,
                    "market_id": trade.market_id,
                    "outcome_name": trade.outcome,
                    "title": trade.market_title,
                    "event_question": trade.market_title,
                    "event_close_time": trade.event_end_at,
                    "requested_amount": trade.amount,
                    "requested_price": trade.price,
                    "decision_summary": trade.reason,
                    "buy_reason": trade.reason,
                    "selected_by_rule": False,
                    "selected_by_llm": False,
                    "selected_by_hybrid": False,
                },
            )
            capture_auto_live_buy_result_sync(
                user_id=user_id,
                entry_reference=f"backfill-manual:{trade.id}",
                raw_execution_response=_execution_payload_from_trade(trade),
            )
            processed += 1
            continue

        capture_auto_live_exit_pre_submit_sync(
            user_id=user_id,
            exit_reference=f"backfill-manual:{trade.id}",
            context={
                "market_id": trade.market_id,
                "outcome_name": trade.outcome,
                "title": trade.market_title,
                "event_question": trade.market_title,
                "requested_amount": trade.amount,
                "requested_shares": trade.shares,
                "requested_price": trade.price,
                "decision_summary": trade.reason,
                "sell_reason": trade.reason,
                "exit_type": "SELL",
            },
        )
        capture_auto_live_exit_result_sync(
            user_id=user_id,
            exit_reference=f"backfill-manual:{trade.id}",
            market_id=trade.market_id,
            outcome_name=trade.outcome,
            title=trade.market_title,
            raw_execution_response=_execution_payload_from_trade(trade),
            exit_type="SELL",
            sell_reason=trade.reason,
        )
        processed += 1
    return processed


def _backfill_auto_live_decisions(user_id: int) -> int:
    processed = 0
    with SyncSessionLocal() as session:
        records = (
            session.execute(
                select(PolymarketAutoLiveDecisionRecord)
                .where(PolymarketAutoLiveDecisionRecord.user_id == user_id)
            )
            .scalars()
            .all()
        )
    decisions = sorted(
        [record_to_decision(record) for record in records],
        key=lambda decision: decision.updated_at,
    )
    for decision in decisions:
        order_plan = decision.order_plan
        if order_plan is None or order_plan.status != "submitted":
            continue
        if order_plan.action == "buy":
            capture_auto_live_buy_pre_submit_sync(
                user_id=user_id,
                entry_reference=f"backfill-auto-live:{order_plan.id}",
                context={
                    "source_variant": "backfill-auto-live",
                    "bot_name": "Bullpen x AI",
                    "strategy_name": "Bullpen x AI Auto-Live",
                    "strategy_version": decision.run_id,
                    "run_id": decision.run_id,
                    "event_id": decision.market_id,
                    "event_slug": decision.slug,
                    "market_id": decision.market_id,
                    "outcome_name": order_plan.side,
                    "title": decision.market_title,
                    "event_question": decision.market_title,
                    "event_close_time": decision.close_time,
                    "requested_amount": order_plan.order_size_usd,
                    "requested_price": order_plan.limit_price_cents / 100,
                    "decision_summary": decision.reason,
                    "buy_reason": decision.reason,
                    "selected_by_rule": True,
                    "selected_by_llm": bool(decision.llm_outputs),
                    "selected_by_hybrid": bool(decision.llm_outputs),
                    "llm_payloads": [
                        output.model_dump(mode="json") for output in decision.llm_outputs
                    ],
                },
            )
            capture_auto_live_buy_result_sync(
                user_id=user_id,
                entry_reference=f"backfill-auto-live:{order_plan.id}",
                raw_execution_response=order_plan.execution_response
                or _execution_payload_from_trade(
                    PolymarketLiveTradeDecision(
                        id=order_plan.id,
                        source_trade_id=order_plan.id,
                        source_trade_key=order_plan.id,
                        proposed_at=order_plan.created_at,
                        updated_at=order_plan.executed_at or order_plan.created_at,
                        trader_id="bullpen-auto-live",
                        trader_name="Bullpen x AI Auto-Live",
                        trader_address="",
                        market_id=decision.market_id,
                        market_title=decision.market_title,
                        event_end_at=decision.close_time,
                        outcome=order_plan.side,
                        side="BUY",
                        amount=order_plan.order_size_usd,
                        price=order_plan.limit_price_cents / 100,
                        shares=order_plan.shares,
                        max_loss=order_plan.order_size_usd,
                        reason=decision.reason,
                        status="executed",
                        command="buy",
                        executed_at=order_plan.executed_at,
                        source="live-market-read",
                    )
                ),
            )
            processed += 1
            continue

        capture_auto_live_exit_pre_submit_sync(
            user_id=user_id,
            exit_reference=f"backfill-auto-live:{order_plan.id}",
            context={
                "run_id": decision.run_id,
                "market_id": decision.market_id,
                "outcome_name": order_plan.side,
                "title": decision.market_title,
                "event_question": decision.market_title,
                "requested_amount": order_plan.order_size_usd,
                "requested_shares": order_plan.shares,
                "requested_price": order_plan.limit_price_cents / 100,
                "decision_summary": decision.reason,
                "sell_reason": decision.reason,
                "exit_type": "SELL",
                "llm_payloads": [
                    output.model_dump(mode="json") for output in decision.llm_outputs
                ],
            },
        )
        capture_auto_live_exit_result_sync(
            user_id=user_id,
            exit_reference=f"backfill-auto-live:{order_plan.id}",
            market_id=decision.market_id,
            outcome_name=order_plan.side,
            title=decision.market_title,
            raw_execution_response=order_plan.execution_response
            or json.dumps(
                {
                    "orderId": order_plan.id,
                    "status": order_plan.status,
                    "filledAmount": order_plan.order_size_usd,
                    "filledShares": order_plan.shares,
                    "avgPrice": order_plan.limit_price_cents / 100,
                    "fees": 0,
                }
            ),
            exit_type="SELL",
            sell_reason=decision.reason,
        )
        processed += 1
    return processed


def _mark_backfilled_records(user_id: int) -> None:
    with SyncSessionLocal() as session:
        records = (
            session.execute(
                select(BullpenTradeAnalysisRecord)
                .where(BullpenTradeAnalysisRecord.user_id == user_id)
                .where(
                    BullpenTradeAnalysisRecord.entry_reference.like("backfill-%")
                )
            )
            .scalars()
            .all()
        )
        for record in records:
            record.analysis_summary = record.analysis_summary or BACKFILL_SUMMARY
        session.commit()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Backfill Bullpen trade analysis records from historical order data.",
    )
    parser.add_argument("--user-id", type=int, required=True)
    parser.add_argument(
        "--source",
        choices=["all", "manual", "auto-live"],
        default="all",
    )
    args = parser.parse_args()

    processed = 0
    if args.source in {"all", "manual"}:
        processed += _backfill_manual_live_trades(args.user_id)
    if args.source in {"all", "auto-live"}:
        processed += _backfill_auto_live_decisions(args.user_id)
    _mark_backfilled_records(args.user_id)
    print(
        f"Backfill completed for user {args.user_id}. Processed {processed} historical execution rows.",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
