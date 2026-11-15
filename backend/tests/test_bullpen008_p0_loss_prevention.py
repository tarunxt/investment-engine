from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.domains.bullpen008.engine import (
    build_portfolio_target,
    build_stage1_output,
    normalize_cluster_rows,
)
from app.domains.bullpen008.risk_controls import (
    build_joint_loss_scenarios,
    classify_tail_risk,
    evaluate_contingent_policy,
    evaluate_drawdown,
    reward_and_edge_protection,
    stable_hash,
    validate_evidence_packet,
)
from app.domains.bullpen008.schemas import Bullpen008Settings
from app.domains.bullpen008.tasks import _persist_loss_prevention_artifacts
from app.domains.bullpen008.models import (
    Bullpen008ContingentExitPolicyRecord,
    Bullpen008EvidencePacketRecord,
    Bullpen008JointLossScenarioRecord,
    Bullpen008LossPreventionAuditRecord,
    Bullpen008PnlAttributionRecord,
    Bullpen008RiskClassificationRecord,
    Bullpen008RunRecord,
    Bullpen008ScenarioMembershipRecord,
)
from app.domains.auth.models import User
from app.infrastructure.database.base import Base
import app.infrastructure.database.all_models  # noqa: F401

NOW = datetime(2026, 8, 30, 12, tzinfo=UTC)


def test_minute_monitor_episode_version_counter_is_available() -> None:
    from app.domains.bullpen008 import tasks

    versions = tasks.defaultdict(int)
    versions[("market", "YES")] += 1
    assert versions[("market", "YES")] == 1


def market(market_id: str, **updates: object) -> dict[str, object]:
    row: dict[str, object] = {
        "market_id": market_id,
        "parent_event_id": f"parent-{market_id}",
        "slug": market_id,
        "question": f"Will objective event {market_id} occur?",
        "category": "Politics",
        "tags": [],
        "resolution_rules": "Resolves YES when the official public record confirms the objective event.",
        "deadline": (NOW + timedelta(days=5)).isoformat(),
        "open": True,
        "closed": False,
        "resolved": False,
        "claimable": False,
        "accepting_orders": True,
        "current_yes_odds": 80,
        "current_no_odds": 20,
        "quote_timestamp": NOW.isoformat(),
    }
    row.update(updates)
    return row


def fresh_packet(*, count: int = 2, stale: bool = False, conflict: bool = False) -> dict[str, object]:
    published = NOW - (timedelta(hours=2) if stale else timedelta(minutes=5))
    return {
        "built_at_utc": NOW.isoformat(),
        "conflict_status": "material" if conflict else "none",
        "adjudication_status": "unresolved" if conflict else "resolved",
        "sources": [
            {
                "source_id": f"S{index + 1}",
                "publisher": f"publisher-{index + 1}.example",
                "url": f"https://publisher-{index + 1}.example/report",
                "title": "Official regional security update",
                "published_at": published.isoformat(),
                "fetched_at": NOW.isoformat(),
                "source_type": "major_news",
                "short_extracted_proposition": "Officials report the ceasefire remains in effect.",
                "content_hash": f"hash-{index + 1}",
                "entity_coverage": ["Iran", "Jordan"],
                "relevance": 0.9,
                "thesis_effect": "supports",
            }
            for index in range(count)
        ],
    }


def analysed(row: dict[str, object], *, exposure: float, side: str, tier: str) -> dict[str, object]:
    return {
        **row,
        "chosen_side": side,
        "chosen_side_llm_probability": 92,
        "current_chosen_side_bullpen_odds": 80,
        "llm_edge_pp": 12,
        "conservative_edge_pp": 7,
        "uncertainty_haircut_pp": 5,
        "reward_to_loss_ratio": 0.25,
        "maximum_profit_usd": exposure * 0.25,
        "maximum_loss_usd": exposure,
        "returns_per_day": 1.2,
        "confidence": "High",
        "evidence_quality": "Strong",
        "risk_components": {"U": 2, "A": 2, "T": 2, "D": 2, "I": 2},
        "risk_score": 2,
        "days_until_close": 1,
        "active_position": True,
        "new_entry_eligible": False,
        "adjudication_status": "resolved",
        "adjudication_reason": "Rules, entities, date and held-side loss direction were verified.",
        "strict_cluster_id": f"strict:{row['market_id']}",
        "common_catalyst_cluster_id": f"catalyst:{row['market_id']}",
        "strict_cluster_members": [row["market_id"]],
        "current_exposure_usd": exposure,
        "existing_exposure_usd": exposure,
        "pending_exposure_usd": 0,
        "risk_tier": tier,
        "entry_rejection_codes": [],
        "risk_rejection_codes": ["SINGLE_DAY_HIGH_SHOCK"] if tier == "single_day_high_shock" else [],
        "evidence_packet": fresh_packet(),
    }


def iran_rows() -> list[dict[str, object]]:
    target = analysed(
        market(
            "iran-arab-no",
            parent_event_id="event-country-targeting",
            slug="iran-target-arab-country-august-31",
            question="Will Iran target an Arab country on August 31, 2026?",
            category="Geopolitics",
            tags=["Iran", "military action", "Jordan"],
            resolution_rules="Resolves YES if Iranian military forces target Jordan or another qualifying Arab country on August 31, 2026.",
            deadline="2026-09-01T00:00:00+00:00",
        ),
        exposure=8,
        side="NO",
        tier="single_day_high_shock",
    )
    ceasefire = analysed(
        market(
            "ceasefire-yes",
            parent_event_id="event-ceasefire-continuation",
            slug="us-ceasefire-iran-through-august-31",
            question="US ceasefire against Iran continues through August 31?",
            category="Geopolitics",
            tags=["Iran", "ceasefire"],
            resolution_rules="Resolves YES only if the ceasefire continues without a qualifying Iranian attack, retaliation, blockade or breach through August 31, 2026.",
            deadline="2026-09-01T00:00:00+00:00",
        ),
        exposure=7,
        side="YES",
        tier="high_shock_geopolitical",
    )
    hormuz = analysed(
        market(
            "hormuz-no-blockade",
            parent_event_id="event-hormuz-agreement",
            slug="no-hormuz-blockade-through-august-31",
            question="Will the Hormuz agreement prevent an Iranian naval blockade through August 31?",
            category="Geopolitics",
            tags=["Iran", "Hormuz", "blockade"],
            resolution_rules="Resolves YES if no Iranian naval blockade or military retaliation breaches the Hormuz agreement through August 31, 2026.",
            deadline="2026-09-01T00:00:00+00:00",
        ),
        exposure=0,
        side="YES",
        tier="high_shock_geopolitical",
    )
    return [target, ceasefire, hormuz]


def test_exact_date_military_market_is_rejected_but_held_position_is_monitored() -> None:
    settings = Bullpen008Settings()
    row = iran_rows()[0]
    classification = classify_tail_risk(row, settings=settings, now=NOW)
    assert classification["risk_tier"] == "single_day_high_shock"
    assert "SINGLE_DAY_HIGH_SHOCK" in classification["risk_rejection_codes"]
    assert "HIGH_SHOCK_ENTRY_WINDOW_LT_48H" in classification["risk_rejection_codes"]

    output = build_stage1_output(
        [row],
        [{"market_id": row["market_id"], "side": "NO", "classification": "active"}],
        settings=settings,
        now=NOW,
    )
    held = output["rows"][0]
    assert held["accounting_status"] == "accepted_monitoring"
    assert held["new_entry_enabled"] is False
    assert held["exit_review_required"] is True


def test_llm_cannot_downgrade_and_incomplete_high_shock_data_fails_closed() -> None:
    settings = Bullpen008Settings()
    incomplete = market(
        "attack",
        question="Will Iran launch a military strike?",
        category="Geopolitics",
        resolution_rules="",
        deadline=None,
        llm_risk_tier="standard_objective",
    )
    result = classify_tail_risk(incomplete, settings=settings, now=NOW)
    assert result["risk_tier"] == "high_shock_geopolitical"
    assert {"HIGH_SHOCK_TIMING_UNRESOLVED", "HIGH_SHOCK_RULES_INCOMPLETE"} <= set(result["risk_rejection_codes"])


def test_ordinary_exact_date_market_is_not_false_positive_and_speech_filter_survives() -> None:
    settings = Bullpen008Settings()
    weather = market(
        "weather",
        question="Will rainfall exceed one inch on August 31, 2026?",
        category="Weather",
        resolution_rules="Resolves YES if the official weather station measures more than one inch of rain on August 31, 2026.",
        deadline="2026-09-01T00:00:00+00:00",
    )
    assert classify_tail_risk(weather, settings=settings, now=NOW)["risk_tier"] == "standard_objective"
    speech = market("speech", question="Will the president praise or praises the minister in a speech?")
    codes = {reason["code"] for reason in build_stage1_output([speech], [], settings=settings, now=NOW)["rows"][0]["rejection_reasons"]}
    assert "SPEECH_WORDING" in codes


def test_iran_and_ceasefire_cross_wording_share_one_conservative_joint_loss_scenario() -> None:
    graph = build_joint_loss_scenarios(iran_rows(), settings=Bullpen008Settings())
    assert graph["pass_condition_met"] is True
    scenarios = graph["scenarios"]
    shared = next(row for row in scenarios if {"iran-arab-no", "ceasefire-yes"} <= set(row["affected_market_ids"]))
    assert set(shared["affected_market_ids"]) == {"iran-arab-no", "ceasefire-yes", "hormuz-no-blockade"}
    assert shared["loss_direction_by_market"]["iran-arab-no"]["direction"] == "NO_LOSES"
    assert shared["loss_direction_by_market"]["ceasefire-yes"]["direction"] == "YES_LOSES"
    assert shared["existing_loss_at_risk_usd"] == 15
    assert shared["effective_scenario_cap_usd"] == 5
    assert shared["deterministic_links"]


def test_stage4_reduces_existing_joint_scenario_and_blocks_every_new_buy() -> None:
    settings = Bullpen008Settings()
    graph = build_joint_loss_scenarios(iran_rows(), settings=settings)
    result = build_portfolio_target(
        graph["rows"],
        settings=settings,
        available_cash_usd=100,
        inputs_hash="iran-regression",
        now=NOW,
    )
    assert sum(float(row["target_exposure_usd"]) for row in result["allocations"]) <= 5
    assert all(float(row["proposed_buy_usd"]) == 0 for row in result["allocations"])
    assert result["certificate"]["maximum_joint_scenario_loss"] <= 5
    assert result["certificate"]["all_proposed_reductions"]


def test_spiderman_threshold_band_uses_one_representative_and_accounts_existing_positions() -> None:
    rows = [
        analysed(
            market(
                "spider-threshold",
                parent_event_id="spiderman-opening-weekend",
                question="Will Spider-Man opening weekend exceed $150m?",
            ),
            exposure=5,
            side="YES",
            tier="standard_objective",
        ),
        analysed(
            market(
                "spider-band",
                parent_event_id="spiderman-opening-weekend",
                question="Will Spider-Man opening weekend be $150m–$175m?",
            ),
            exposure=5,
            side="YES",
            tier="standard_objective",
        ),
    ]
    provider = [
        {
            "market_id": row["market_id"],
            "strict_cluster_id": "spiderman-outcome",
            "common_catalyst_cluster_id": "spiderman-box-office",
            "driver": "Spider-Man opening-weekend gross",
            "main_joint_loss_trigger": "The official opening-weekend gross lands outside the held condition.",
            "adjudication_status": "resolved",
            "adjudication_reason": "Threshold and band share the same authoritative gross.",
        }
        for row in rows
    ]
    clustered = normalize_cluster_rows(
        rows,
        provider,
        existing_exposure_by_market={"spider-threshold": 5, "spider-band": 5},
        pending_buy_exposure_by_market={},
        confirmed_exit_exposure_by_market={},
        settings=Bullpen008Settings(),
    )
    assert clustered["metrics"]["largest_current_exposure"] == 10
    result = build_portfolio_target(
        clustered["rows"],
        settings=Bullpen008Settings(),
        available_cash_usd=50,
        inputs_hash="spiderman",
        now=NOW,
    )
    assert sum(1 for row in result["allocations"] if row["proposed_buy_usd"] > 0) <= 1
    assert sum(float(row["current_exposure_usd"]) for row in result["allocations"]) == 10


def test_sweden_pm_contracts_share_semantic_driver_across_parent_ids() -> None:
    rows = [
        analysed(market("sweden-a", parent_event_id="pm-a", question="Will Andersson become Sweden PM?"), exposure=0, side="YES", tier="standard_objective"),
        analysed(market("sweden-b", parent_event_id="pm-b", question="Will Kristersson remain Sweden PM?"), exposure=0, side="NO", tier="standard_objective"),
    ]
    provider = [
        {
            "market_id": row["market_id"],
            "strict_cluster_id": str(row["market_id"]),
            "common_catalyst_cluster_id": "sweden-prime-minister-outcome",
            "driver": "The same Swedish government-formation outcome",
            "main_joint_loss_trigger": "Parliament confirms the competing prime minister.",
            "adjudication_status": "resolved",
            "adjudication_reason": "Both resolve from the same government-formation process.",
        }
        for row in rows
    ]
    clustered = normalize_cluster_rows(
        rows,
        provider,
        existing_exposure_by_market={},
        pending_buy_exposure_by_market={},
        confirmed_exit_exposure_by_market={},
        settings=Bullpen008Settings(),
    )
    scenario_ids = {tuple(row["joint_loss_scenario_ids"]) for row in clustered["rows"]}
    assert len(scenario_ids) == 1
    assert clustered["metrics"]["common_catalyst_clusters"] == 1


@pytest.mark.parametrize(
    ("packet", "expected"),
    [
        ({"sources": []}, "EVIDENCE_EMPTY"),
        (fresh_packet(count=1), "EVIDENCE_INDEPENDENT_SOURCE_COUNT_LT_2"),
        (fresh_packet(stale=True), "EVIDENCE_STALE"),
        (fresh_packet(conflict=True), "EVIDENCE_CONFLICT_UNRESOLVED"),
    ],
)
def test_high_shock_evidence_fails_closed(packet: dict[str, object], expected: str) -> None:
    result = validate_evidence_packet(packet, risk_tier="high_shock_geopolitical", settings=Bullpen008Settings(), now=NOW)
    assert expected in result["evidence_blocker_codes"]


def test_two_fresh_independent_sources_pass() -> None:
    result = validate_evidence_packet(fresh_packet(), risk_tier="high_shock_geopolitical", settings=Bullpen008Settings(), now=NOW)
    assert result["evidence_complete"] is True
    assert result["independent_publisher_count"] == 2


@pytest.mark.parametrize(
    ("price", "allocation", "expected"),
    [(96, 5, "ENTRY_PRICE_ABOVE_95"), (95, 10, "HIGH_PRICE_ALLOCATION_ABOVE_5"), (92, 5, "REWARD_TO_LOSS_BELOW_MINIMUM")],
)
def test_reward_skew_protection(price: float, allocation: float, expected: str) -> None:
    row = {
        "current_chosen_side_bullpen_odds": price,
        "proposed_allocation_usd": allocation,
        "chosen_side_llm_probability": 99,
        "confidence": "High",
        "evidence_quality": "Strong",
        "risk_components": {"U": 1, "A": 1, "T": 1, "D": 1, "I": 1},
        "risk_score": 1,
        "risk_tier": "standard_objective",
        "llm_disagreement_level": "low",
    }
    result = reward_and_edge_protection(row, settings=Bullpen008Settings(), now=NOW)
    assert expected in result["entry_rejection_codes"]


def test_high_price_zone_requires_strong_evidence_even_with_small_allocation() -> None:
    result = reward_and_edge_protection(
        {
            "current_chosen_side_bullpen_odds": 90,
            "proposed_allocation_usd": 5,
            "chosen_side_llm_probability": 99,
            "confidence": "High",
            "evidence_quality": "Moderate",
            "risk_components": {"U": 1, "A": 1, "T": 1, "D": 1, "I": 1},
            "risk_score": 1,
            "risk_tier": "standard_objective",
            "llm_disagreement_level": "low",
        },
        settings=Bullpen008Settings(),
        now=NOW,
    )
    assert "HIGH_PRICE_STRONG_EVIDENCE_REQUIRED" in result["entry_rejection_codes"]


def test_conservative_haircut_rejects_96_against_95_and_missing_uncertainty() -> None:
    complete = {
        "current_chosen_side_bullpen_odds": 95,
        "proposed_allocation_usd": 5,
        "chosen_side_llm_probability": 96,
        "confidence": "High",
        "evidence_quality": "Strong",
        "risk_components": {"U": 1, "A": 1, "T": 1, "D": 1, "I": 1},
        "risk_score": 1,
        "risk_tier": "standard_objective",
        "llm_disagreement_level": "low",
    }
    result = reward_and_edge_protection(complete, settings=Bullpen008Settings(), now=NOW)
    assert result["conservative_probability"] < 95
    assert "CONSERVATIVE_EDGE_BELOW_MINIMUM" in result["entry_rejection_codes"]
    missing = reward_and_edge_protection({"current_chosen_side_bullpen_odds": 80}, settings=Bullpen008Settings(), now=NOW)
    assert "UNCERTAINTY_INPUTS_MISSING" in missing["entry_rejection_codes"]


def policy(**updates: object) -> dict[str, object]:
    base: dict[str, object] = {
        "affected_market_id": "m",
        "thresholds": {
            "held_side_odds_below_pct": 85,
            "odds_drop_15m_pp": 5,
            "odds_drop_24h_pp": 10,
            "catastrophic_drop_15m_pp": 20,
            "mandatory_time_exit": (NOW + timedelta(hours=12)).isoformat(),
            "minimum_reward_to_loss_ratio": 0.10,
        },
        "confirmation_requirements": 2,
        "activation_expiry": (NOW + timedelta(days=1)).isoformat(),
    }
    base.update(updates)
    base["policy_hash"] = stable_hash(base)
    return base


def test_contingent_exit_requires_two_quotes_and_catastrophic_move_is_immediate() -> None:
    first_only = evaluate_contingent_policy(policy(), [{"observed_at": NOW.isoformat(), "held_side_odds": 84}], now=NOW)
    assert first_only["activation_status"] == "BLOCKED"
    assert "QUOTE_CONFIRMATION_INCOMPLETE" in first_only["blocker_codes"]
    confirmed = evaluate_contingent_policy(
        policy(),
        [
            {"observed_at": (NOW - timedelta(minutes=1)).isoformat(), "held_side_odds": 84},
            {"observed_at": NOW.isoformat(), "held_side_odds": 83},
        ],
        now=NOW,
    )
    assert confirmed["activation_status"] == "WOULD_ACTIVATE"
    catastrophic = evaluate_contingent_policy(
        policy(),
        [
            {"observed_at": (NOW - timedelta(minutes=10)).isoformat(), "held_side_odds": 95},
            {"observed_at": NOW.isoformat(), "held_side_odds": 70},
        ],
        now=NOW,
    )
    assert catastrophic["catastrophic_move"] is True
    assert catastrophic["activation_status"] == "WOULD_ACTIVATE"


def test_contingent_exit_five_point_15m_and_ten_point_24h_declines_activate() -> None:
    fast = evaluate_contingent_policy(
        policy(),
        [
            {"observed_at": (NOW - timedelta(minutes=10)).isoformat(), "held_side_odds": 94},
            {"observed_at": NOW.isoformat(), "held_side_odds": 89},
        ],
        now=NOW,
    )
    assert "ODDS_DROP_15M" in fast["trigger_types"]
    assert fast["activation_status"] == "WOULD_ACTIVATE"
    slow = evaluate_contingent_policy(
        policy(),
        [
            {"observed_at": (NOW - timedelta(hours=12)).isoformat(), "held_side_odds": 97},
            {"observed_at": NOW.isoformat(), "held_side_odds": 87},
        ],
        now=NOW,
    )
    assert "ODDS_DROP_24H" in slow["trigger_types"]
    assert slow["activation_status"] == "WOULD_ACTIVATE"


def test_contingent_exit_never_would_submit_with_stale_quote_or_expired_policy() -> None:
    stale = evaluate_contingent_policy(
        policy(),
        [
            {"observed_at": (NOW - timedelta(minutes=4)).isoformat(), "held_side_odds": 84},
            {"observed_at": (NOW - timedelta(minutes=3)).isoformat(), "held_side_odds": 83},
        ],
        now=NOW,
    )
    assert stale["activation_status"] == "BLOCKED"
    assert stale["submission_status"] is None
    assert "FRESH_QUOTE_MISSING" in stale["blocker_codes"]

    expired_policy = policy(activation_expiry=(NOW - timedelta(seconds=1)).isoformat())
    expired = evaluate_contingent_policy(
        expired_policy,
        [
            {"observed_at": (NOW - timedelta(minutes=1)).isoformat(), "held_side_odds": 84},
            {"observed_at": NOW.isoformat(), "held_side_odds": 83},
        ],
        now=NOW,
    )
    assert expired["activation_status"] == "BLOCKED"
    assert expired["submission_status"] is None
    assert "ACTIVATION_POLICY_EXPIRED" in expired["blocker_codes"]


def test_drawdown_breakers_and_external_flow_neutralisation_for_200_bankroll() -> None:
    settings = Bullpen008Settings(bankroll_usd=200)
    soft = evaluate_drawdown(baseline_equity_usd=200, current_equity_usd=194, external_flows_usd=0, settings=settings)
    hard = evaluate_drawdown(baseline_equity_usd=200, current_equity_usd=190, external_flows_usd=0, settings=settings)
    deposit = evaluate_drawdown(baseline_equity_usd=200, current_equity_usd=210, external_flows_usd=10, settings=settings)
    assert soft["state"] == "BUY_FREEZE_SOFT_DRAWDOWN"
    assert soft["soft_threshold_usd"] == 6
    assert hard["state"] == "EXIT_ONLY_HARD_DRAWDOWN"
    assert hard["hard_threshold_usd"] == 10
    assert deposit["drawdown_usd"] == 0


@pytest.mark.parametrize(
    ("gate_fields", "certificate_state"),
    [
        ({"drawdown_state": "BUY_FREEZE_SOFT_DRAWDOWN"}, "BUY_FREEZE_SOFT_DRAWDOWN"),
        ({"drawdown_state": "EXIT_ONLY_HARD_DRAWDOWN"}, "EXIT_ONLY_HARD_DRAWDOWN"),
        ({"drawdown_state": "NORMAL", "scenario_cooldown_active": True}, "NORMAL"),
    ],
)
def test_stage4_drawdown_and_post_shock_cooldown_freeze_buys_without_erasing_holdings(
    gate_fields: dict[str, object], certificate_state: str
) -> None:
    row = analysed(market("standard-held"), exposure=5, side="YES", tier="standard_objective")
    row.update(
        {
            "new_entry_eligible": True,
            "risk_rejection_codes": [],
            "joint_loss_scenario_ids": ["scenario:standard"],
            "effective_joint_scenario_cap_usd": 20,
            **gate_fields,
        }
    )
    result = build_portfolio_target(
        [row],
        settings=Bullpen008Settings(),
        available_cash_usd=100,
        inputs_hash="risk-gate",
        now=NOW,
    )
    allocation = result["allocations"][0]
    assert allocation["target_exposure_usd"] == 5
    assert allocation["proposed_buy_usd"] == 0
    assert result["certificate"]["new_buys_frozen"] is True
    assert result["certificate"]["drawdown_state"] == certificate_state
    if certificate_state == "EXIT_ONLY_HARD_DRAWDOWN":
        assert result["certificate"]["exit_only"] is True


def test_settings_relationships_fail_closed() -> None:
    with pytest.raises(ValueError):
        Bullpen008Settings(entry_price_high_zone_pct=96, entry_price_hard_ceiling_pct=95)
    with pytest.raises(ValueError):
        Bullpen008Settings(soft_drawdown_pct=5, hard_drawdown_pct=5)
    with pytest.raises(ValueError):
        Bullpen008Settings(single_day_high_shock_cap_usd=11, high_shock_cluster_cap_usd=10)
    with pytest.raises(ValueError):
        Bullpen008Settings(high_shock_min_source_count=1)


def test_p0_migration_and_orm_are_additive_bullpen008_only() -> None:
    source = Path("alembic/versions/1b2c3d4e5f6a_add_bullpen008_p0_loss_prevention.py").read_text()
    for table in (
        "bullpen008_risk_classifications",
        "bullpen008_joint_loss_scenarios",
        "bullpen008_scenario_memberships",
        "bullpen008_evidence_packets",
        "bullpen008_regime_change_episodes",
        "bullpen008_quote_observations",
        "bullpen008_contingent_exit_policies",
        "bullpen008_contingent_exit_activations",
        "bullpen008_daily_equity_baselines",
        "bullpen008_drawdown_episodes",
        "bullpen008_scenario_cooldowns",
        "bullpen008_pnl_attributions",
        "bullpen008_loss_prevention_audits",
    ):
        assert f'"{table}"' in source
        assert table in Base.metadata.tables
    assert "op.alter_column" not in source
    assert "op.rename_table" not in source
    assert "bullpen007_" not in source
    assert "polymarket_auto_live" not in source
    assert source.count("op.drop_table(table)") == 1


def test_p0_run_artifacts_persist_with_run_contract_scenario_and_policy_attribution() -> None:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(
        engine,
        tables=[
            Base.metadata.tables[name]
            for name in (
                "users",
                "bullpen008_runs",
                "bullpen008_action_plans",
                "bullpen008_execution_intents",
                "bullpen008_risk_classifications",
                "bullpen008_evidence_packets",
                "bullpen008_joint_loss_scenarios",
                "bullpen008_scenario_memberships",
                "bullpen008_scenario_exposure_snapshots",
                "bullpen008_contingent_exit_policies",
                "bullpen008_pnl_attributions",
                "bullpen008_loss_prevention_audits",
            )
        ],
    )
    with Session(engine) as session:
        session.add(User(id=1, email="p0@example.com", username="p0", password_hash="test"))
        run = Bullpen008RunRecord(
            id="b008-p0-persist",
            user_id=1,
            workflow_profile="bullpen008",
            idempotency_key="bullpen008-p0-persist",
            status="running",
            triggered_by="test",
            shadow_mode=True,
            execution_enabled=False,
            started_at=NOW,
            summary="P0 persistence test",
            settings_snapshot=Bullpen008Settings().model_dump(mode="json"),
            wallet_snapshot={
                "positions": [
                    {
                        "market_id": "iran-arab-no",
                        "shares": 10,
                        "average_price_cents": 50,
                        "current_value_usd": 8,
                    }
                ]
            },
            task_metadata={},
            run_metadata={},
        )
        session.add(run)
        session.flush()
        scenario = {
            "scenario_id": "scenario:iran",
            "scenario_version": "v1",
            "driver": "Iran escalation",
            "affected_market_ids": ["iran-arab-no"],
            "loss_direction_by_market": {"iran-arab-no": {"direction": "NO_LOSES", "reason": "Attack satisfies YES."}},
            "adjudication_status": "resolved",
            "risk_tier": "single_day_high_shock",
            "existing_loss_at_risk_usd": 5,
            "pending_loss_at_risk_usd": 0,
            "target_loss_at_risk_usd": 5,
            "effective_scenario_cap_usd": 5,
        }
        policy_payload = {
            "affected_market_id": "iran-arab-no",
            "affected_scenario_ids": ["scenario:iran"],
            "maximum_sell_quantity": 5,
        }
        policy_payload["policy_hash"] = stable_hash(policy_payload)
        allocation = {
            "market_id": "iran-arab-no",
            "question": "Will Iran target an Arab country?",
            "chosen_side": "NO",
            "risk_tier": "single_day_high_shock",
            "current_exposure_usd": 5,
            "target_exposure_usd": 5,
            "proposed_buy_usd": 0,
            "proposed_sell_usd": 0,
            "current_chosen_side_bullpen_odds": 80,
            "joint_loss_scenario_ids": ["scenario:iran"],
            "effective_scenario_cap_usd": 5,
            "maximum_loss_usd": 5,
            "maximum_profit_usd": 1.25,
            "reward_to_loss_ratio": 0.25,
            "raw_edge_pp": 12,
            "conservative_edge_pp": 7,
        }
        _persist_loss_prevention_artifacts(
            session,
            run=run,
            stage1={"rows": [{
                "market_id": "iran-arab-no",
                "classifier_version": "v1",
                "risk_tier": "single_day_high_shock",
                "risk_classification_evidence": {"matches": ["Iran", "target"]},
                "risk_rejection_codes": ["SINGLE_DAY_HIGH_SHOCK"],
                "accounting_status": "accepted_monitoring",
            }]},
            stage2={"rows": [{
                "market_id": "iran-arab-no",
                "evidence_validation": {"packet_hash": "evidence-hash", "evidence_complete": True, "sources": fresh_packet()["sources"]},
            }]},
            stage3={"joint_loss_scenarios": [scenario]},
            portfolio={
                "certificate": {"certificate_hash": "certificate-hash"},
                "contingent_exit_policies": [policy_payload],
                "allocations": [allocation],
                "loss_prevention_audit": [{"market_id": "iran-arab-no", "counterfactual_estimate": True}],
            },
            plan={"plan_id": "plan", "holds": [{"market_id": "iran-arab-no", "action_id": "action-hold"}]},
        )
        session.commit()
        assert session.scalar(select(Bullpen008RiskClassificationRecord.id)) is not None
        assert session.scalar(select(Bullpen008EvidencePacketRecord.id)) is not None
        assert session.scalar(select(Bullpen008JointLossScenarioRecord.id)) is not None
        assert session.scalar(select(Bullpen008ScenarioMembershipRecord.id)) is not None
        assert session.scalar(select(Bullpen008ContingentExitPolicyRecord.id)) is not None
        risk = session.scalars(select(Bullpen008RiskClassificationRecord)).one()
        assert risk.payload["matched_evidence"] == {"matches": ["Iran", "target"]}
        pnl = session.scalars(select(Bullpen008PnlAttributionRecord)).one()
        assert pnl.payload["entry_run_id"] == run.id
        assert pnl.payload["associated_scenario_ids"] == ["scenario:iran"]
        assert pnl.payload["entry_amount"] == 5
        assert pnl.payload["current_value"] == 8
        assert pnl.payload["unrealized_pnl"] == 3
        assert pnl.payload["applicable_cap"] == 5
        audit = session.scalars(select(Bullpen008LossPreventionAuditRecord)).one()
        assert audit.payload["counterfactual_estimate"] is True
