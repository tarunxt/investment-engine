from types import SimpleNamespace

from app.domains.mails.service import (
    STAGE2_WARNING_THRESHOLD,
    build_stage2_warning_email,
    extract_stage2_position_warnings,
)


def _run(rows):
    stage = SimpleNamespace(
        stage_number=2,
        completed_at="2026-08-21T10:00:00Z",
        outputs={
            "workflow_stage_key": "llm",
            "llm_reviewed_candidates": rows,
        },
    )
    return SimpleNamespace(
        id="run-stage2-alert",
        stage_results=[stage],
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
    assert "Example event" in html_content
    assert "immediate exit review" in remarks


def test_incomplete_stage_two_never_triggers_a_warning():
    run = _run([])
    run.stage_results[0].completed_at = None
    run.stage_results[0].outputs["llm_reviewed_candidates"] = [
        {
            "source_kind": "active_position",
            "position_side": "YES",
            "market_id": "market-1",
            "fair_yes_probability_pct": 5,
        }
    ]

    assert extract_stage2_position_warnings(run) == []
