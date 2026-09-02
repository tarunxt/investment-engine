from types import SimpleNamespace

from app.domains.mails.service import (
    STAGE2_WARNING_THRESHOLD,
    _initial_sell_action,
    _sell_handoff_email_footer,
    build_stage2_warning_email,
    extract_stage2_position_warnings,
)


def _run(rows, *, active_positions=None):
    stages = []
    if active_positions is not None:
        stages.append(
            SimpleNamespace(
                stage_number=1,
                completed_at="2026-08-21T09:00:00Z",
                outputs={
                    "workflow_stage_key": "scan",
                    "active_positions_found": active_positions,
                },
            )
        )
    stages.append(SimpleNamespace(
        stage_number=2,
        completed_at="2026-08-21T10:00:00Z",
        outputs={
            "workflow_stage_key": "llm",
            "llm_reviewed_candidates": rows,
        },
    ))
    return SimpleNamespace(
        id="run-stage2-alert",
        stage_results=stages,
        audit_metadata={},
    )


def test_stage2_warning_uses_the_held_yes_side_and_strict_threshold():
    run = _run(
        [
            {
                "source_kind": "active_position",
                "position_key": "yes-market::YES",
                "position_side": "YES",
                "market_id": "yes-market",
                "question": "Will the YES event happen?",
                "market_url": "https://example.test/yes",
                "fair_yes_probability_pct": 79.99,
                "fair_no_probability_pct": 20.01,
            },
            {
                "source_kind": "active_position",
                "position_key": "equal-market::YES",
                "position_side": "YES",
                "market_id": "equal-market",
                "question": "Exactly at threshold",
                "fair_yes_probability_pct": STAGE2_WARNING_THRESHOLD,
                "fair_no_probability_pct": 20,
            },
        ]
    )

    warnings = extract_stage2_position_warnings(run)

    assert len(warnings) == 1
    assert warnings[0].market_id == "yes-market"
    assert warnings[0].position_side == "YES"
    assert warnings[0].held_side_llm_odds == 79.99


def test_stage2_warning_uses_held_no_side_and_ignores_candidates():
    run = _run(
        [
            {
                "source_kind": "active_position",
                "position_key": "no-market::NO",
                "position_side": "NO",
                "market_id": "no-market",
                "question": "Will the NO event happen?",
                "fair_yes_probability_pct": 72,
                "fair_no_probability_pct": 28,
            },
            {
                "source_kind": "candidate",
                "position_side": "YES",
                "market_id": "candidate",
                "question": "Not an active position",
                "fair_yes_probability_pct": 10,
                "fair_no_probability_pct": 90,
            },
        ]
    )

    warnings = extract_stage2_position_warnings(run)

    assert len(warnings) == 1
    assert warnings[0].market_id == "no-market"
    assert warnings[0].position_side == "NO"
    assert warnings[0].held_side_llm_odds == 28


def test_stage2_warning_email_is_actionable_and_identifies_pre_stage3_timing():
    run = _run(
        [
            {
                "source_kind": "active_position",
                "position_key": "market-1::YES",
                "position_side": "YES",
                "market_id": "market-1",
                "question": "Example event",
                "fair_yes_probability_pct": 75,
                "fair_no_probability_pct": 25,
                "current_yes_odds": 84,
                "current_no_odds": 16,
            }
        ]
    )
    warnings = extract_stage2_position_warnings(run)

    subject, html_content, text_content, remarks = build_stage2_warning_email(
        run,
        warnings,
    )

    assert "WARNING" in subject
    assert "Exit required" in subject
    assert "EXIT this position" in text_content
    assert "before Stage 3" in text_content
    assert "Consolidated held-side LLM odds: 75%" in text_content
    assert "Actual current held-side Bullpen odds: 84%" in text_content
    assert "Alert triggered by: LLM odds" in text_content
    assert "Example event" in html_content
    assert "immediate exit review" in remarks


def test_incomplete_stage_two_never_triggers_a_warning():
    run = _run([])
    run.stage_results[-1].completed_at = None
    run.stage_results[-1].outputs["llm_reviewed_candidates"] = [
        {
            "source_kind": "active_position",
            "position_side": "YES",
            "market_id": "market-1",
            "fair_yes_probability_pct": 5,
        }
    ]

    assert extract_stage2_position_warnings(run) == []


def test_stage2_warning_triggers_when_only_actual_bullpen_odds_are_below_threshold():
    run = _run(
        [
            {
                "source_kind": "active_position",
                "position_key": "bullpen-breach::YES",
                "position_side": "YES",
                "market_id": "bullpen-breach",
                "question": "Actual odds breach",
                "fair_yes_probability_pct": 91,
                "fair_no_probability_pct": 9,
                "current_yes_odds": 79.5,
                "current_no_odds": 20.5,
            }
        ]
    )

    warnings = extract_stage2_position_warnings(run)

    assert len(warnings) == 1
    assert warnings[0].held_side_llm_odds == 91
    assert warnings[0].held_side_bullpen_odds == 79.5
    assert warnings[0].breach_sources == ("Actual Current Bullpen Odds",)


def test_stage2_warning_consolidates_llm_and_actual_bullpen_breaches():
    run = _run(
        [
            {
                "source_kind": "active_position",
                "position_key": "both-breach::NO",
                "position_side": "NO",
                "market_id": "both-breach",
                "question": "Both odds breach",
                "fair_yes_probability_pct": 30,
                "fair_no_probability_pct": 70,
                "current_yes_odds": 24,
                "current_no_odds": 76,
            }
        ]
    )

    warnings = extract_stage2_position_warnings(run)

    assert len(warnings) == 1
    assert warnings[0].held_side_llm_odds == 70
    assert warnings[0].held_side_bullpen_odds == 76
    assert warnings[0].breach_sources == (
        "LLM odds",
        "Actual Current Bullpen Odds",
    )


def test_stage2_warning_keeps_both_measures_strictly_below_80():
    run = _run(
        [
            {
                "source_kind": "active_position",
                "position_key": "equal-both::YES",
                "position_side": "YES",
                "market_id": "equal-both",
                "question": "Both measures equal threshold",
                "fair_yes_probability_pct": STAGE2_WARNING_THRESHOLD,
                "fair_no_probability_pct": 20,
                "current_yes_odds": STAGE2_WARNING_THRESHOLD,
                "current_no_odds": 20,
            }
        ]
    )

    assert extract_stage2_position_warnings(run) == []


def test_exit_warning_creates_gpt_work_delivery_audit_handoff():
    action = _initial_sell_action(
        [
            {
                "market_id": "1130016",
                "recommended_action": "EXIT",
            }
        ],
        at="2026-09-02T07:00:00+00:00",
    )

    assert action is not None
    assert action["status"] == "detected"
    assert action["market_ids"] == ["1130016"]
    html_footer, text_footer = _sell_handoff_email_footer(91, action)
    assert "Delivery audit ID:</strong> 91" in html_footer
    assert "Market IDs:</strong> 1130016" in html_footer
    assert "Delivery audit ID: 91" in text_footer
    assert "Action: SELL FULL POSITION" in text_footer
    assert "https://cred-x.in/console/mails?deliveryId=91" in text_footer


def test_non_exit_mail_does_not_create_sell_handoff():
    assert _initial_sell_action(
        [{"market_id": "1130016", "recommended_action": "HOLD"}],
        at="2026-09-02T07:00:00+00:00",
    ) is None


def test_continuous_bullpen_breach_also_creates_sell_handoff():
    action = _initial_sell_action(
        [{"market_id": "1130016", "side": "NO", "breach_type": "actual"}],
        at="2026-09-02T07:00:00+00:00",
    )

    assert action is not None
    assert action["market_ids"] == ["1130016"]


def test_stage2_warning_uses_stage1_actual_odds_when_review_row_is_compact():
    run = _run(
        [
            {
                "source_kind": "active_position",
                "position_key": "stage1-fallback::YES",
                "position_side": "YES",
                "market_id": "stage1-fallback",
                "question": "Compact Stage 2 row",
                "fair_yes_probability_pct": 90,
                "fair_no_probability_pct": 10,
            }
        ],
        active_positions=[
            {
                "position_key": "stage1-fallback::YES",
                "market_id": "stage1-fallback",
                "side": "YES",
                "current_yes_odds": 79.25,
                "current_no_odds": 20.75,
            }
        ],
    )

    warnings = extract_stage2_position_warnings(run)

    assert len(warnings) == 1
    assert warnings[0].held_side_bullpen_odds == 79.25
    assert warnings[0].breach_sources == ("Actual Current Bullpen Odds",)
