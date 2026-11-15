"""Read-only owner-scoped coverage/backfill plan. Never materialize or commit.

Example (authorized runtime): python scripts/report_historical_score_coverage.py
  --user-id VERIFIED_OWNER_ID --market india --symbol HAL --day 2026-10-05

Days use the explicitly selected display timezone (default Asia/Kolkata).
The report distinguishes retained evidence from absent historical formulas.
"""
from __future__ import annotations
import argparse
from datetime import datetime, time, timedelta
import json
from zoneinfo import ZoneInfo
from sqlalchemy import select
from app.domains.runs.models import FinalActionableHistory
from app.domains.recommendation_audit.models import DecisionRecord
from app.domains.recommendation_audit.historical_score_reader import historical_score_view, instant


def report_coverage(session, *, user_id, market, symbol, day, timezone="Asia/Kolkata"):
    start = datetime.combine(datetime.fromisoformat(day).date(), time.min, tzinfo=ZoneInfo(timezone))
    end = start + timedelta(days=1)
    from datetime import timezone as utc_timezone
    start_utc, end_utc = start.astimezone(utc_timezone.utc), end.astimezone(utc_timezone.utc)
    records = list(session.scalars(select(FinalActionableHistory).where(FinalActionableHistory.user_id == user_id, FinalActionableHistory.market == market, FinalActionableHistory.stock_symbol == symbol.upper(), FinalActionableHistory.covered_at >= start_utc, FinalActionableHistory.covered_at < end_utc).order_by(FinalActionableHistory.covered_at, FinalActionableHistory.id).limit(201)))
    rows = []
    for history in records[:200]:
        formula, snapshot = history.formula_inputs_json or {}, history.snapshot_json or {}
        exchange = formula.get("stockExchange") or snapshot.get("representative", {}).get("Exchange Symbol")
        if not exchange:
            venues = {str((row.get("raw") or {}).get("exchange symbol", "")).strip().upper() for row in snapshot.get("rows", []) if isinstance(row, dict)} - {""}
            if len(venues) == 1: exchange = next(iter(venues))
        if not exchange:
            venues = set(session.scalars(select(DecisionRecord.exchange).where(DecisionRecord.user_id == user_id, DecisionRecord.run_id == history.rebalance_run_id, DecisionRecord.market == market, DecisionRecord.symbol == symbol.upper()).distinct()))
            if len(venues) == 1: exchange = next(iter(venues))
        if exchange:
            view = historical_score_view(session, user_id=user_id, run_id=history.rebalance_run_id, market=market, symbol=symbol, exchange=exchange, covered_at=history.covered_at, history_id=history.id)
            status, coverage = view["status"], view["coverage"]
        else:
            status, coverage = "ambiguous_venue", {}
        rows.append({"history_id": history.id, "run_id": history.rebalance_run_id, "covered_at": instant(history.covered_at).isoformat(), "formula_version": history.formula_version, "exchange": exchange, "status": status, "coverage": coverage,
                     "proposed_action": "reuse_existing_capture" if status == "available" else "review_existing_revisions" if status.startswith("ambiguous") else "original_formula_not_recoverable_without_retained_formula_evidence"})
    return {"dry_run": True, "production_mutations": 0, "scope": {"user_id": user_id, "market": market, "symbol": symbol.upper(), "day": day, "timezone": timezone}, "candidate_count": len(records), "truncated": len(records) > 200, "rows": rows,
            "limits": ["No current formula was used to recreate a historical decision.", "No legacy materialization, provider rerun, history overwrite, deletion or backfill was executed.", "Missing formulas remain missing; retained raw jobs alone cannot prove an original weighted score."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--user-id", required=True, type=int)
    parser.add_argument("--market", required=True, choices=["india", "us"])
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--day", required=True)
    parser.add_argument("--timezone", default="Asia/Kolkata")
    args = parser.parse_args()
    if args.user_id < 1: parser.error("A verified positive owner ID is required")
    from app.infrastructure.database.sync_session import SyncSessionLocal
    with SyncSessionLocal() as session:
        session.autoflush = False
        report = report_coverage(session, user_id=args.user_id, market=args.market, symbol=args.symbol, day=args.day, timezone=args.timezone)
        session.rollback()
    print(json.dumps(report, indent=2))


if __name__ == "__main__": main()
