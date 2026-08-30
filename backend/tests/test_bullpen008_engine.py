from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.domains.bullpen008.engine import (
    build_portfolio_target,
    build_stage1_output,
    deterministic_cluster_seed,
    normalize_cluster_rows,
    normalize_stage2_rows,
    parse_cluster_response,
    parse_probability_risk_response,
    risk_class,
    verify_portfolio_certificate,
)
from app.domains.bullpen008.schemas import Bullpen008Settings

NOW = datetime(2026, 8, 30, 12, tzinfo=UTC)


def market(market_id: str, **updates: object) -> dict[str, object]:
    row: dict[str, object] = {
        "market_id": market_id,
        "condition_id": f"condition-{market_id}",
        "question_id": f"question-{market_id}",
        "parent_event_id": f"event-{market_id}",
        "slug": f"market-{market_id}",
        "question": f"Will objective event {market_id} occur?",
        "category": "Politics",
        "outcomes": ["YES", "NO"],
        "resolution_rules": "Resolves YES when the official public record confirms the event.",
        "resolution_source": "Official public record",
        "deadline": (NOW + timedelta(days=10)).isoformat(),
        "timezone": "UTC",
        "open": True,
        "closed": False,
        "resolved": False,
        "claimable": False,
        "accepting_orders": True,
        "current_yes_odds": 82,
        "current_no_odds": 18,
        "quote_timestamp": NOW.isoformat(),
    }
    row.update(updates)
    return row


def provider_row(market_id: str, **updates: object) -> dict[str, object]:
    row: dict[str, object] = {
        "market_id": market_id,
        "yes_definition": "The official record confirms the objective event.",
        "llm_yes_probability": 85,
        "llm_no_probability": 15,
        "recommended_side": "YES",
        "confidence": "High",
        "evidence_quality": "Strong",
        "U": 2,
        "A": 2,
        "T": 2,
        "D": 2,
        "I": 2,
        "auto_reject": False,
        "watch": False,
        "sizing_modifier": 1,
        "red_flags": [],
    }
    row.update(updates)
    return row


def clustered_candidate(
    market_id: str, cluster: str, **updates: object
) -> dict[str, object]:
    row = market(market_id)
    row.update(
        {
            "chosen_side": "YES",
            "chosen_side_llm_probability": 86,
            "current_chosen_side_bullpen_odds": 82,
            "llm_edge_pp": 4,
            "returns_per_day": 1.1,
            "confidence": "High",
            "evidence_quality": "Strong",
            "risk_components": {"U": 2, "A": 2, "T": 2, "D": 2, "I": 2},
            "risk_score": 2,
            "days_until_close": 10,
            "auto_reject": False,
            "new_entry_eligible": True,
            "active_position": False,
            "adjudication_status": "resolved",
            "strict_cluster_id": f"strict-{cluster}",
            "common_catalyst_cluster_id": f"catalyst-{cluster}",
            "strict_cluster_members": [market_id],
            "current_exposure_usd": 0,
        }
    )
    row.update(updates)
    return row


def test_stage1_accounts_for_every_market_and_keeps_all_rejection_reasons() -> None:
    settings = Bullpen008Settings(custom_exclude_phrases=["forbidden phrase"])
    rejected = market(
        "rejected",
        question="Will a player say the forbidden phrase in an NBA game?",
        category="Sports",
        closed=True,
        deadline=(NOW - timedelta(days=1)).isoformat(),
        resolution_rules="",
        current_yes_odds=2,
        current_no_odds=98,
        quote_timestamp=(NOW - timedelta(hours=1)).isoformat(),
    )
    result = build_stage1_output(
        [market("accepted"), rejected], [], settings=settings, now=NOW
    )

    assert result["pass_condition_met"] is True
    assert result["metrics"] == {
        "scanned": 2,
        "accepted": 1,
        "rejected": 0,
        "active_positions": 0,
        "stale_data_errors": 1,
        "accounted": 2,
    }
    reasons = next(row for row in result["rows"] if row["market_id"] == "rejected")[
        "rejection_reasons"
    ]
    codes = {reason["code"] for reason in reasons}
    assert {
        "CLOSED",
        "DEADLINE_PASSED",
        "MISSING_RESOLUTION_RULES",
        "BINARY_SIDE_ODDS_FLOOR",
        "STALE_ODDS",
        "SPORTS",
        "SPEECH_WORDING",
        "CUSTOM_PHRASE",
    } <= codes
    assert any(reason.get("phrase") == "forbidden phrase" for reason in reasons)


def test_stage1_active_positions_bypass_new_entry_filters_for_monitoring() -> None:
    settings = Bullpen008Settings()
    expired = market(
        "held", closed=True, deadline=(NOW - timedelta(days=2)).isoformat()
    )
    positions = [{"market_id": "held", "side": "NO", "classification": "active"}]

    result = build_stage1_output([expired], positions, settings=settings, now=NOW)
    row = result["rows"][0]

    assert row["accounting_status"] == "accepted_monitoring"
    assert row["monitoring_override"] is True
    assert row["new_entry_eligible"] is False
    assert row["held_sides"] == ["NO"]
    assert result["metrics"]["active_positions"] == 1


def test_stage2_strict_json_complementarity_and_complete_row_validation() -> None:
    settings = Bullpen008Settings(probability_tolerance_pp=0.25)
    accepted = build_stage1_output([market("m1")], [], settings=settings, now=NOW)[
        "rows"
    ]

    with pytest.raises(ValueError, match="strict JSON"):
        parse_probability_risk_response("```json\n{}\n```")

    invalid = normalize_stage2_rows(
        accepted,
        [provider_row("m1", llm_yes_probability=80, llm_no_probability=21)],
        settings=settings,
        now=NOW,
    )
    assert invalid["pass_condition_met"] is False
    assert invalid["metrics"]["llm_failures"] == 1
    assert "not complementary" in invalid["validation_errors"][0]["errors"][0]

    valid = normalize_stage2_rows(
        accepted,
        [provider_row("m1")],
        settings=settings,
        now=NOW,
    )
    assert valid["pass_condition_met"] is True
    row = valid["rows"][0]
    assert row["chosen_side_llm_probability"] == 85
    assert row["p_llm"] == 85
    assert row["llm_edge_pp"] == 3
    assert row["risk_score"] == 2
    assert row["returns_per_day"] == pytest.approx((100 - 82) / (10 + 4), rel=0.01)


@pytest.mark.parametrize(
    ("score", "classification"),
    [
        (0, "eligible"),
        (3.9, "eligible"),
        (4, "eligible_normal"),
        (5.9, "eligible_normal"),
        (6, "marginal_half_size"),
        (6.9, "marginal_half_size"),
        (7, "normally_reject"),
        (7.9, "normally_reject"),
        (8, "hard_reject"),
        (10, "hard_reject"),
    ],
)
def test_risk_score_boundaries(score: float, classification: str) -> None:
    assert risk_class(score) == classification


def test_deterministic_and_semantic_clustering_links_ladders_and_applies_closure() -> (
    None
):
    settings = Bullpen008Settings()
    rows = [
        clustered_candidate(
            "a",
            "unused",
            parent_event_id="election-2030",
            question="Will A win by May 1?",
            deadline="2030-05-01T00:00:00+00:00",
        ),
        clustered_candidate(
            "b",
            "unused",
            parent_event_id="election-2030",
            question="Will B win by June 1?",
            deadline="2030-06-01T00:00:00+00:00",
        ),
        clustered_candidate(
            "c",
            "unused",
            parent_event_id="election-2030",
            question="Will turnout be above 60%?",
        ),
    ]
    seed = deterministic_cluster_seed(rows)
    assert len({value["strict_cluster_id"] for value in seed.values()}) == 1

    provider = [
        {
            "market_id": row["market_id"],
            "strict_cluster_id": f"semantic-{row['market_id']}",
            "common_catalyst_cluster_id": "election-result",
            "driver": "same election",
            "main_joint_loss_trigger": "unexpected result",
            "adjudication_status": "resolved",
            "adjudication_reason": "complete",
        }
        for row in rows
    ]
    result = normalize_cluster_rows(
        rows,
        provider,
        existing_exposure_by_market={"a": 7},
        pending_buy_exposure_by_market={"b": 5},
        confirmed_exit_exposure_by_market={},
        settings=settings,
    )
    assert result["pass_condition_met"] is True
    assert result["metrics"]["strict_clusters"] == 1
    assert result["metrics"]["common_catalyst_clusters"] == 1
    assert result["metrics"]["duplicates_date_ladders"] == 1
    assert result["metrics"]["largest_current_exposure"] == 12
    assert all(len(row["strict_cluster_members"]) == 3 for row in result["rows"])
    assert all(row["remaining_capacity_usd"] == 8 for row in result["rows"])


def test_incomplete_or_unresolved_semantic_cluster_blocks_stage4() -> None:
    settings = Bullpen008Settings()
    rows = [clustered_candidate("a", "a"), clustered_candidate("b", "b")]
    provider = [
        {
            "market_id": "a",
            "strict_cluster_id": "a",
            "common_catalyst_cluster_id": "x",
            "adjudication_status": "unresolved",
        }
    ]
    result = normalize_cluster_rows(
        rows,
        provider,
        existing_exposure_by_market={},
        pending_buy_exposure_by_market={},
        confirmed_exit_exposure_by_market={},
        settings=settings,
    )
    assert result["pass_condition_met"] is False
    assert result["missing_market_ids"] == ["b"]
    assert result["unresolved_adjudications"]
    with pytest.raises(ValueError, match="strict JSON"):
        parse_cluster_response("not-json")


def test_optimizer_enforces_caps_pending_exposure_increments_cash_and_half_size() -> (
    None
):
    settings = Bullpen008Settings()
    rows = [
        clustered_candidate("full", "one", current_exposure_usd=15),
        clustered_candidate("half", "two", risk_score=6.2),
        clustered_candidate("third", "three"),
    ]
    result = build_portfolio_target(
        rows, settings=settings, available_cash_usd=60, inputs_hash="inputs"
    )
    allocations = {row["market_id"]: row for row in result["allocations"]}
    assert allocations["full"]["proposed_buy_usd"] == 5
    assert allocations["half"]["proposed_buy_usd"] == 10
    assert "RISK_HALF_SIZE" in allocations["half"]["explanation_codes"]
    assert allocations["third"]["proposed_buy_usd"] == 20
    assert sum(row["proposed_buy_usd"] for row in result["allocations"]) <= 60
    assert all(row["proposed_buy_usd"] % 5 == 0 for row in result["allocations"])
    assert result["certificate"]["largest_contract_exposure"] <= 20
    assert result["certificate"]["largest_strict_cluster_exposure"] <= 20
    assert result["certificate"]["largest_common_catalyst_exposure"] <= 20
    assert result["certificate"]["cash_retained"] > 0
    assert result["certificate"]["bankroll_result"] is True
    assert verify_portfolio_certificate(result["certificate"]) is True
    assert all(
        "main_adverse_catalyst" in scenario for scenario in result["stress_scenarios"]
    )


def test_optimizer_rejects_adverse_scenario_above_common_catalyst_cap() -> None:
    settings = Bullpen008Settings()
    rows = [
        clustered_candidate("a", "shared", current_exposure_usd=12),
        clustered_candidate("b", "shared", current_exposure_usd=10),
    ]
    result = build_portfolio_target(
        rows, settings=settings, available_cash_usd=100, inputs_hash="stress"
    )
    assert result["certificate"]["stress_test_result"] is False
    assert result["certificate"]["portfolio_certified"] is False
    assert result["pass_condition_met"] is False

    tampered = dict(result["certificate"])
    tampered["bankroll"] = 201
    assert verify_portfolio_certificate(tampered) is False
