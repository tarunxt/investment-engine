from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
import asyncio

import pytest
import app.models  # noqa: F401 - register relationships before SQL compilation

from app.domains.runs.run_identity import analysis_run_identity
from app.domains.runs.final_actionable_history import (
    infer_market, is_rebalance_run, persist_history_items, validate_history_source_identity,
)
from app.domains.runs.schemas import FinalActionableHistoryCreateItem


def run(id=1, portfolio=None, label=None, prompt=""):
    return SimpleNamespace(id=id, auto_rebalance_portfolio=portfolio, auto_rebalance_label=label, prompt=prompt)


def item(**kwargs):
    return FinalActionableHistoryCreateItem(
        covered_at=datetime(2026, 1, 2, tzinfo=timezone.utc), stock_symbol="EXAMPLE",
        **({"market": "india", "rebalance_run_id": 1} | kwargs),
    )


@pytest.mark.parametrize("source, market, stage", [
    (run(portfolio="indmoney_us", label="IndMoney US Run #12 (Swing Scan)", prompt="Act as a US aggressive swing-trading strategist.\n\nQuoted previous context:\n[REBALANCE_FLOW:india]\nRebalance India portfolio."), "us", "swing"),
    (run(portfolio="india", label="India Run #12 (Rebalance Scan)", prompt="[REBALANCE_FLOW:india]\nRebalance the current India holdings."), "india", "rebalance"),
    (run(prompt="Rebalance India portfolio.\n\nPrior US swing-trade output"), "india", "rebalance"),
    (run(prompt="Rebalance US portfolio."), "us", "rebalance"),
    (run(prompt="India and US rebalance"), None, "rebalance"),
    (run(portfolio="indmoney_us", prompt="[REBALANCE_FLOW:india]\nRebalance"), None, None),
    (run(portfolio="india", label="IndMoney US Run #1 (Rebalance Scan)"), None, None),
    (run(portfolio="other", prompt="[REBALANCE_FLOW:india]"), None, None),
    (run(portfolio="india", label="India Run #1 (Swing Scan)", prompt="[REBALANCE_FLOW:india]"), None, None),
    (run(prompt="## Technical Scan Input Bundle\nMarket: US equities\n\nQuoted India holdings"), "us", "technical"),
    (run(prompt="## Technical Scan Input Bundle\nMarket: US equities\nMarket: India equities"), None, None),
])
def test_identity_uses_run_metadata_and_opening_not_nested_context(source, market, stage):
    identity = analysis_run_identity(source)
    assert (identity.market, identity.stage) == (market, stage)
    assert infer_market(source) == market
    assert is_rebalance_run(source) == (market is not None and stage == "rebalance")


def test_valid_history_accepts_same_market_rebalance_and_named_technical_source():
    validate_history_source_identity(
        [item(source_run_ids_json=[1, 2, 3], technical_scan_run_id=3)],
        [run(1, "india", "India Run #1 (Rebalance Scan)"),
         run(2, "india", "India Run #2 (Rebalance Scan)"),
         run(3, "india", "India Run #2 (Technical Scan)")],
    )


@pytest.mark.parametrize("sources, history_item", [
    ([run(1, "indmoney_us", "IndMoney US Run #1 (Rebalance Scan)")], item()),
    ([run(1, "india", "India Run #1 (Swing Scan)")], item()),
    ([run(1, "india", "India Run #1 (Technical Scan)")], item(technical_scan_run_id=1)),
    ([run(1, "india", "India Run #1 (Rebalance Scan)"), run(2, "indmoney_us", "IndMoney US Run #1 (Technical Scan)")], item(technical_scan_run_id=2)),
    ([run(1, "india", "India Run #1 (Rebalance Scan)"), run(2, "india", "India Run #1 (Swing Scan)")], item(source_run_ids_json=[1, 2])),
    ([run(1, prompt="Ambiguous historical prompt")], item()),
])
def test_wrong_market_stage_and_ambiguous_sources_cannot_be_persisted(sources, history_item):
    with pytest.raises(ValueError, match="market or stage"):
        validate_history_source_identity([history_item], sources)


def test_write_rejection_happens_before_any_history_read_or_mutation():
    wrong_source = run(1, "indmoney_us", "IndMoney US Run #1 (Swing Scan)")
    result = Mock()
    result.all.return_value = [wrong_source]
    db = SimpleNamespace(execute=AsyncMock(return_value=result), commit=AsyncMock(), flush=AsyncMock())
    with pytest.raises(ValueError, match="market or stage"):
        asyncio.run(persist_history_items(db, user_id=17, items=[item()]))
    assert db.execute.await_count == 1
    db.commit.assert_not_awaited()
    db.flush.assert_not_awaited()
    statement = str(db.execute.call_args.args[0])
    assert "runs.user_id" in statement
    assert "run_jobs" not in statement


def test_explicit_empty_full_prompt_does_not_fall_back_to_preview():
    source = run(prompt="")
    source.prompt_preview = "[REBALANCE_FLOW:india]"
    assert analysis_run_identity(source).market is None
    assert analysis_run_identity(source).stage is None
    source.prompt = None
    assert analysis_run_identity(source).market == "india"
    assert analysis_run_identity(source).stage == "rebalance"


@pytest.mark.parametrize("portfolio", [None, "india", "indmoney_us"])
def test_conflicting_technical_headers_reject_even_with_metadata(portfolio):
    source = run(portfolio=portfolio, prompt="## Technical Scan Input Bundle\nMarket: India equities\nMarket: US equities")
    identity = analysis_run_identity(source)
    assert (identity.market, identity.stage) == (None, None)
