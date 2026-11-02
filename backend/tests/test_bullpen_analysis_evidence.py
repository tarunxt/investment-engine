"""Audit10 conservative analysis acceptance using synthetic evidence only."""
from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from app.domains.bullpen_trade_analysis.analytics import (
    build_trade_learning_insights, generate_bullpen_post_trade_analysis,
    normalize_declared_price,
)
from app.domains.bullpen_trade_analysis.helpers import extract_execution_summary
from app.domains.bullpen_trade_analysis.models import (
    BullpenTradeAnalysisRecord, BullpenTradeAnalysisSnapshotRecord,
)
from app.domains.bullpen_trade_analysis.service import (
    BullpenTradeAnalysisService, _apply_exit_execution, _build_summary,
)
from test_bullpen_trade_analysis import _build_async_session_factory


def record(**changes):
    values = dict(id="evidence", user_id=7, entry_reference="synthetic-entry",
                  source_variant="synthetic", bot_name="synthetic", title="Synthetic",
                  event_question="Synthetic?", status="SOLD", lifecycle_state="BUY_AND_SELL_EXECUTED",
                  final_tag="RULE_EXIT", pnl_outcome_tag="UNKNOWN", closed_at=datetime.now(UTC))
    values.update(changes)
    return BullpenTradeAnalysisRecord(**values)


@pytest.mark.parametrize("pnl", [None, 0, -1, 1])
@pytest.mark.parametrize("confidence", [None, 0, .9, 90])
def test_single_outcome_is_not_calibration_or_learning(pnl, confidence):
    result = generate_bullpen_post_trade_analysis(dict(net_pnl=pnl, buy_confidence=confidence,
                                                     buy_liquidity_score=.8))
    assert result["reinforcement_signal"] == "NOT_EVALUATED"
    assert result["reinforcement_score"] is None
    assert result["llm_confidence_aligned"] is None
    assert not result["should_increase_confidence_for_similar_trade"]
    assert not result["should_avoid_similar_trade"]
    assert not result["suggested_platform_rule_changes"]
    if pnl is None:
        assert "unknown" in result["analysis_summary"]
        assert "gain" not in result["analysis_summary"]
    if pnl == 0:
        assert "breakeven" in result["analysis_summary"]


@pytest.mark.parametrize("case", ["single", "winner_only", "same_event", "unequal_stake", "unknown_cost", "model_mixed", "mixed_outcomes"])
def test_unvalidated_cohorts_cannot_recommend_policy(case):
    trades = [dict(closed_at="2026-01-01", net_pnl=1, buy_computed_tags_json=["tag"],
                   buy_confidence=.9, buy_liquidity_score=0, event_id="same", buy_notional=1)]
    if case != "single":
        trades.append({**trades[0], "buy_notional": 100, "model_version": "other",
                       "net_pnl": -2 if case == "mixed_outcomes" else 2})
    output = build_trade_learning_insights(trades)
    assert output["evidence_status"] == "insufficient"
    assert output["validated_recommendations"] == []
    assert output["average_pnl_by_tag"][0]["count"] == len(trades)
    assert output["losses_caused_by_low_liquidity"] == 0
    assert len(output["limitations"]) >= 3


@pytest.mark.parametrize("value,unit,expected", [(50,"cents",.5),(.5,"unit_price",.5),
    (0,"cents",0),(None,"cents",None),(50,None,None),(.5,"odds",None),
    (float("nan"),"unit_price",None),(101,"cents",None)])
def test_only_declared_valid_prices_normalize(value, unit, expected):
    assert normalize_declared_price(value,unit) == expected


@pytest.mark.parametrize("case", ["before", "at_exit", "unknown_time", "stale", "illiquid", "fees", "missing_fill", "post_exit"])
def test_no_unapproved_post_exit_counterfactual(case):
    output = generate_bullpen_post_trade_analysis(dict(net_pnl=1, best_possible_exit_price_after_buy=90,
        sell_average_fill_price=None if case == "missing_fill" else .5, sell_requested_price=.6,
        metadata_json={"analysis_price_contract":{"in_hold_maximum_unit":"cents", "fill_unit":"unit_price"}}))
    assert output["exit_timing"] == "not evaluated"
    assert output["exit_analysis"]["status"] == "not_evaluated"
    assert output["exit_analysis"]["fill_unit_price"] is None  # provenance unverified
    assert output["exit_analysis"]["in_hold_maximum_unit_price"] == .9
    assert output["exit_analysis"]["requested_price_raw"] == .6


def test_known_denominator_and_nullable_fee_coverage():
    output = _build_summary([record(net_pnl=1, fees_total=0), record(net_pnl=None, fees_total=None)])
    assert (output.closed_positions, output.known_outcomes, output.unknown_outcomes) == (2,1,1)
    assert (output.win_rate,output.win_rate_denominator) == (1,1)
    assert output.total_fees == 0 and output.fee_coverage == "partial"
    assert output.total_net_pnl == 1 and output.net_pnl_coverage == "partial"
    unknown = _build_summary([record()])
    assert unknown.total_fees is None and unknown.total_net_pnl is None and unknown.win_rate is None
    zero = _build_summary([record(net_pnl=0,fees_total=0)])
    assert zero.win_rate == 0 and zero.known_outcomes == 1


@pytest.mark.parametrize("buy_fee,sell_fee,expected", [(None,None,None),(0,None,None),(None,1,None),(0,0,0),(1,2,3)])
def test_exit_lifecycle_preserves_unknown_costs(buy_fee,sell_fee,expected):
    trade = record(buy_notional=5,buy_fees=buy_fee,sell_requested_price=.8)
    _apply_exit_execution(trade, summary={"filled_amount":6,"average_fill_price":0,"fees":sell_fee},
                          exit_type="SELL",executed_at=datetime.now(UTC),sell_reason=None)
    assert trade.sell_average_fill_price == 0
    assert trade.fees_total == expected
    assert trade.net_pnl == (1-expected if expected is not None else None)
    assert trade.analysis_summary is None  # original evidence is not overwritten


def test_requested_order_is_not_fill_evidence():
    output = extract_execution_summary({"status":"filled", "price":.7},requested_amount=10,
                                       requested_shares=20,requested_price=.5)
    assert output["average_fill_price"] is None and output["filled_amount"] is None
    trade = record(sell_requested_price=.5,sell_requested_amount=10,buy_notional=5,buy_fees=0)
    _apply_exit_execution(trade,summary=output,exit_type="SELL",executed_at=datetime.now(UTC),sell_reason=None)
    assert trade.net_pnl is None and trade.sell_average_fill_price is None


@pytest.mark.anyio
async def test_detail_reads_preserve_original_and_explicit_revision_appends():
    factory = await _build_async_session_factory()
    async with factory() as session:
        trade = record(analysis_summary="original explanation",mistake_category="ORIGINAL",net_pnl=None,
                       metadata_json={"fixture":"original"})
        session.add(trade)
        await session.commit()
        service = BullpenTradeAnalysisService(session)
        for _ in range(2):
            detail = await service.get_trade_detail(user_id=7,trade_id=trade.id)
            assert detail.trade.analysis_summary == "original explanation"
            assert detail.actionable_learning.algorithm_version == "bullpen-descriptive-v2"
            assert not session.dirty
        assert not list((await session.execute(select(BullpenTradeAnalysisSnapshotRecord))).scalars())
        for _ in range(2):
            revision = await service.recompute_post_trade_analysis(user_id=7,trade_id=trade.id)
            assert len(revision.snapshots) == _ + 1
        versions = list((await session.execute(select(BullpenTradeAnalysisSnapshotRecord))).scalars())
        assert len(versions) == 2
        assert all(v.snapshot_type == "ANALYSIS_VERSION" for v in versions)
        assert versions[0].raw_api_response_json["source_inputs"]["net_pnl"] is None
        assert trade.analysis_summary == "original explanation" and trade.mistake_category == "ORIGINAL"
        assert trade.metadata_json == {"fixture":"original"}


def test_population_includes_unknown_and_zero_tag_outcomes_and_partial_open():
    trades = [dict(closed_at="date",net_pnl=None,buy_computed_tags_json=["unknown"]),
              dict(closed_at="date",net_pnl=0,buy_computed_tags_json=["zero"])]
    output = build_trade_learning_insights(trades)
    assert output["tag_population_counts"] == {"unknown":1,"zero":1}
    assert (output["closed_count"],output["known_outcome_count"],output["unknown_outcome_count"]) == (2,1,1)
    summary = _build_summary([record(closed_at=None, buy_executed_at=datetime.now(UTC), net_pnl=None),record(net_pnl=None)])
    assert summary.open_positions == 1 and summary.closed_positions == 1 and summary.unknown_outcomes == 1


def test_malformed_unit_contract_abstains():
    output = generate_bullpen_post_trade_analysis({"metadata_json":{"analysis_price_contract":["cents"]}})
    assert output["exit_analysis"]["in_hold_maximum_unit_price"] is None
    assert normalize_declared_price(.5,["unit_price"]) is None
