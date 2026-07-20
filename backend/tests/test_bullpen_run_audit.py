import json
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from app.domains.auth.dependencies import get_current_user
from app.domains.bullpen_run_audit.constants import (
    AUDIT_SECTION_KEYS,
    AUDITED_ALGORITHM_REGISTRY,
)
from app.domains.bullpen_run_audit.prompt_builder import (
    REQUIRED_REPORT_KEYS,
    parse_feedback_report,
    plan_feedback_chunks,
)
from app.domains.bullpen_run_audit.router import router as run_audit_router
from app.domains.bullpen_run_audit.service import _build_bundle, _build_formula_records
from app.domains.bullpen_run_audit.sanitizer import sanitize_secret_value
from app.domains.bullpen_run_audit.schemas import BullpenRunAuditFeedbackSummary
from app.domains.bullpen_run_audit.validators import build_deterministic_findings


def _current_user():
    return SimpleNamespace(
        id=7,
        full_name="Tarun Singh",
        username="tarun",
        email="tarun@example.com",
    )


def _build_test_app() -> FastAPI:
    app = FastAPI()
    app.include_router(run_audit_router)
    app.dependency_overrides[get_current_user] = _current_user
    return app


def _feedback_report_payload() -> dict[str, object]:
    return {
        "report_version": "1",
        "executive_summary": "summary",
        "overall_grade": "B",
        "overall_score": 78,
        "confidence": "medium",
        "run_reliability": "partially_reliable",
        "critical_findings": [],
        "high_findings": [],
        "medium_findings": [],
        "low_findings": [],
        "stage_1_assessment": {},
        "stage_2_assessment": {},
        "stage_3_assessment": {},
        "handoff_assessment": {},
        "formula_and_algorithm_assessment": {},
        "guardrail_assessment": {},
        "execution_assessment": {},
        "data_capture_gaps": [],
        "root_cause_hypotheses": [],
        "recommended_changes": [],
        "recommended_tests": [],
        "priority_plan": [],
        "codex_prompt": "Fix the pipeline",
    }


def test_sanitize_secret_value_redacts_nested_credentials_and_urls():
    sanitized = sanitize_secret_value(
        {
            "token": "super-secret-token",
            "headers": {
                "authorization": "Bearer abc123",
                "nested": [
                    {"api_key": "xyz"},
                    "https://example.com/path?session=abc&plain=ok",
                ],
            },
        }
    )

    assert sanitized["token"] == "[REDACTED]"
    assert sanitized["headers"]["authorization"] == "[REDACTED]"
    assert sanitized["headers"]["nested"][0]["api_key"] == "[REDACTED]"
    assert "session=%5BREDACTED%5D" in sanitized["headers"]["nested"][1]
    assert "plain=ok" in sanitized["headers"]["nested"][1]


def test_plan_feedback_chunks_covers_all_audit_sections():
    bundle = {
        "metadata": {"run_id": "run-1"},
        "overview": {"summary": "Run summary"},
        "stage_1": {"candidate_inputs": [{"id": i, "text": "x" * 200} for i in range(6)]},
        "stage_2": {"candidate_reviews": [{"id": i, "text": "y" * 220} for i in range(6)]},
        "stage_3": {"decisions": [{"id": i, "text": "z" * 220} for i in range(6)]},
        "formulas": [{"algorithm_key": "stage2_consensus_statistics"}],
        "guardrails": {"run_guardrails": [{"key": "bankroll"}]},
        "raw": {"run_payload": {"blob": "raw" * 400}},
    }

    chunks = plan_feedback_chunks(bundle=bundle, max_chars=1200)
    covered_keys = {
        key.split("#", 1)[0]
        for chunk in chunks
        for key in chunk["section_keys"]
    }

    assert chunks
    assert covered_keys == set(AUDIT_SECTION_KEYS)


def test_parse_feedback_report_requires_complete_schema():
    payload = _feedback_report_payload()
    missing_key = "priority_plan"
    payload.pop(missing_key)

    with pytest.raises(ValueError) as error:
        parse_feedback_report(json.dumps(payload))

    assert missing_key in str(error.value)


def test_build_deterministic_findings_flags_missing_stage3_handoff():
    bundle = {
        "metadata": {"run_id": "run-1"},
        "overview": {
            "started_at": "2026-07-18T10:00:00+00:00",
            "completed_at": "2026-07-18T10:05:00+00:00",
            "duration_seconds": 300,
            "code_provenance": {"backend_commit_sha": "abc123"},
            "missing_fields": [],
        },
        "stage_2": {
            "candidate_reviews": [
                {
                    "market_id": "market-1",
                    "source_kind": "candidate",
                    "qualified": True,
                    "llm_outputs": [
                        {
                            "llm_yes_odds": 62,
                            "llm_no_odds": 38,
                            "status": "completed",
                        }
                    ],
                }
            ]
        },
        "stage_3": {
            "decisions": [],
            "order_intents": [],
            "max_positions": 1,
        },
        "raw": {},
    }

    findings = build_deterministic_findings(bundle)
    codes = {finding["code"] for finding in findings}

    assert "QUALIFIED_STAGE2_CANDIDATE_MISSING_STAGE3_RESULT" in codes


def test_build_deterministic_findings_flags_missing_stage2_top10_handoff_decision():
    bundle = {
        "metadata": {"run_id": "run-2"},
        "overview": {
            "started_at": "2026-07-18T10:00:00+00:00",
            "completed_at": "2026-07-18T10:05:00+00:00",
            "duration_seconds": 300,
            "code_provenance": {"backend_commit_sha": "abc123"},
            "missing_fields": [],
        },
        "stage_2": {
            "candidate_reviews": [],
            "stage3_handoff_candidate_market_ids": ["market-top-1"],
        },
        "stage_3": {
            "decisions": [],
            "order_intents": [],
            "max_positions": 10,
        },
        "raw": {},
    }

    findings = build_deterministic_findings(bundle)
    codes = {finding["code"] for finding in findings}

    assert "STAGE2_TOP10_HANDOFF_MISSING_STAGE3_DECISION" in codes


def test_build_deterministic_findings_flags_missing_stage2_top10_planning_reason():
    bundle = {
        "metadata": {"run_id": "run-3"},
        "overview": {
            "started_at": "2026-07-18T10:00:00+00:00",
            "completed_at": "2026-07-18T10:05:00+00:00",
            "duration_seconds": 300,
            "code_provenance": {"backend_commit_sha": "abc123"},
            "missing_fields": [],
        },
        "stage_2": {
            "candidate_reviews": [],
            "stage3_handoff_candidate_market_ids": ["market-top-2"],
        },
        "stage_3": {
            "decisions": [
                {
                    "id": "decision-1",
                    "market_id": "market-top-2",
                    "stage3_result": "SELECTED",
                    "stage3_result_reason": "",
                    "summary": "",
                    "reason": "",
                    "order_plan": None,
                }
            ],
            "order_intents": [],
            "max_positions": 10,
        },
        "raw": {},
    }

    findings = build_deterministic_findings(bundle)
    codes = {finding["code"] for finding in findings}

    assert "STAGE2_TOP10_HANDOFF_MISSING_PLANNING_REASON" in codes


def test_build_deterministic_findings_flags_incomplete_stage2_universe_without_remediation():
    bundle = {
        "metadata": {"run_id": "run-stage2-universe"},
        "overview": {
            "started_at": "2026-07-18T10:00:00+00:00",
            "completed_at": "2026-07-18T10:05:00+00:00",
            "duration_seconds": 300,
            "code_provenance": {"backend_commit_sha": "abc123"},
            "missing_fields": [],
        },
        "stage_2": {
            "candidate_reviews": [],
            "universe_status": {
                "total_eligible_rows": 26,
                "reviewed_rows": 20,
                "skipped_rows": 6,
                "is_complete": False,
            },
        },
        "stage_3": {
            "decisions": [],
            "order_intents": [],
            "max_positions": 10,
        },
        "raw": {},
    }

    findings = build_deterministic_findings(bundle)
    codes = {finding["code"] for finding in findings}

    assert "INCOMPLETE_STAGE2_UNIVERSE_MISSING_REMEDIATION" in codes


def test_build_deterministic_findings_flags_restart_and_duplicate_order_risks():
    bundle = {
        "metadata": {"run_id": "run-stage3-restart"},
        "overview": {
            "run_status": "confirming",
            "started_at": "2026-07-20T12:00:00+00:00",
            "completed_at": None,
            "duration_seconds": 300,
            "code_provenance": {"backend_commit_sha": "abc123"},
            "missing_fields": [],
        },
        "stage_2": {"candidate_reviews": []},
        "stage_3": {
            "decisions": [],
            "max_positions": 10,
            "persisted_execution_counters": {
                "total": {"planned": 2, "processed": 0, "submitted": 1}
            },
            "recovery": {
                "required": True,
                "automatic_resubmission": True,
            },
            "order_intents": [
                {
                    "id": "intent-1",
                    "status": "READY",
                    "idempotency_key": "x" * 129,
                    "remote_order_id": "remote-order-1",
                    "attempts": [],
                }
            ],
        },
        "raw": {},
    }

    findings = build_deterministic_findings(bundle)
    codes = {finding["code"] for finding in findings}

    assert "STAGE3_PERSISTED_COUNTERS_CONTRADICT" in codes
    assert "STAGE3_RECOVERY_RUN_LEFT_IN_PROGRESS" in codes
    assert "STAGE3_RECOVERY_AUTO_RESUBMISSION_NOT_DISABLED" in codes
    assert "STAGE3_RETRYABLE_ORDER_HAS_SUBMISSION_REFERENCE" in codes
    assert "ORDER_INTENT_IDEMPOTENCY_KEY_EXCEEDS_STORAGE_LIMIT" in codes


def test_build_deterministic_findings_flags_intents_lost_during_auth_recovery():
    bundle = {
        "metadata": {"run_id": "run-auth-recovery-intents"},
        "overview": {
            "run_status": "failed",
            "started_at": "2026-07-20T12:00:00+00:00",
            "completed_at": "2026-07-20T12:05:00+00:00",
            "duration_seconds": 300,
            "code_provenance": {"backend_commit_sha": "abc123"},
            "missing_fields": [],
        },
        "stage_2": {"candidate_reviews": []},
        "stage_3": {
            "decisions": [
                {
                    "id": "decision-exit-1",
                    "market_id": "market-1",
                    "order_plan": {
                        "id": "order-exit-1",
                        "action": "sell",
                        "dry_run": False,
                    },
                }
            ],
            "auth_recovery": {"historical_error_stale": True},
            "order_intents": [],
            "max_positions": 10,
        },
        "raw": {},
    }

    findings = build_deterministic_findings(bundle)

    assert "STAGE3_AUTH_RECOVERY_LOST_DURABLE_INTENTS" in {
        finding["code"] for finding in findings
    }


def test_build_deterministic_findings_flags_invalid_capacity_override_sizing_basis():
    bundle = {
        "metadata": {"run_id": "run-capacity-override"},
        "overview": {
            "run_status": "completed",
            "started_at": "2026-07-20T12:00:00+00:00",
            "completed_at": "2026-07-20T12:05:00+00:00",
            "duration_seconds": 300,
            "code_provenance": {"backend_commit_sha": "abc123"},
            "missing_fields": [],
        },
        "stage_2": {"candidate_reviews": []},
        "stage_3": {
            "decisions": [],
            "order_intents": [],
            "max_positions": 10,
            "stage3_slot_diagnostics": {
                "slot_limit": 10,
                "economically_active_position_count": 3,
                "operator_override_enabled": True,
                "operator_override_audit": {"used": True},
                "capacity_sizing_basis": "live-plus-all-history",
                "capacity_sizing_occupied_market_count": 13,
                "current_run_submitted_buy_market_count": 0,
            },
        },
        "raw": {},
    }

    findings = build_deterministic_findings(bundle)

    assert "STAGE3_CAPACITY_OVERRIDE_SIZING_BASIS_INVALID" in {
        finding["code"] for finding in findings
    }


def test_build_bundle_captures_stage2_universe_status_and_blocker_details():
    run_payload = {
        "id": "run-universe-details",
        "status": "completed",
        "triggered_by": "manual",
        "started_at": "2026-07-18T10:00:00+00:00",
        "completed_at": "2026-07-18T10:05:00+00:00",
        "summary": "Stage 2 finished.",
        "stage_results": [
            {
                "stage_number": 2,
                "status": "warning",
                "reason": "Universe incomplete.",
                "outputs": {
                    "workflow_stage_key": "llm",
                    "stage2_eligible_rows_total": 26,
                    "stage2_reviewed_rows": 20,
                    "stage2_skipped_rows": 6,
                    "stage2_universe_complete": False,
                    "stage2_universe_blocker_code": "manual_reuse_missing_active_positions",
                    "stage2_universe_blocker_summary": "Saved LLM reuse missed live active positions.",
                    "stage2_universe_blocker_fix": "Rerun Stage 2 without reuse.",
                    "stage2_universe_blocker_rows": [
                        {"position_key": "market-1::NO", "market_id": "market-1"}
                    ],
                },
            }
        ],
        "audit_metadata": {
            "code_provenance": {"backend_commit_sha": "abc123"},
            "settings_snapshot": {},
            "auth_recovery": {"historical_error_stale": True},
        },
        "diagnostics": {},
    }

    bundle = _build_bundle(
        run_payload=run_payload,
        decisions=[],
        run_orders_payload={},
        source_kind="native",
        lifecycle_status="working",
    )

    assert bundle["stage_2"]["universe_status"] == {
        "total_eligible_rows": 26,
        "reviewed_rows": 20,
        "skipped_rows": 6,
        "is_complete": False,
        "blocker_code": "manual_reuse_missing_active_positions",
        "blocker_summary": "Saved LLM reuse missed live active positions.",
        "blocker_fix": "Rerun Stage 2 without reuse.",
        "blocker_rows": [{"position_key": "market-1::NO", "market_id": "market-1"}],
    }
    assert bundle["stage_3"]["auth_recovery"] == {
        "historical_error_stale": True
    }


def test_build_bundle_preserves_stage2_rule_gate_provenance():
    run_payload = {
        "id": "run-rule-gate-provenance",
        "status": "completed",
        "triggered_by": "manual",
        "started_at": "2026-07-19T10:00:00+00:00",
        "completed_at": "2026-07-19T10:05:00+00:00",
        "summary": "Stage 2 and Stage 3 finished.",
        "stage_results": [
            {
                "stage_number": 2,
                "status": "pass",
                "reason": "Stage 2 finished.",
                "outputs": {
                    "workflow_stage_key": "llm",
                    "llm_reviewed_candidates": [
                        {
                            "market_id": "market-1",
                            "source_kind": "candidate",
                            "qualified": True,
                            "rule_gate_result": "bypassed_verified_binary_rules",
                            "yes_definition_extraction_method": "sentence_fallback",
                            "yes_definition_extraction_confidence": "low",
                            "stage2_context": {
                                "matched_gamma_market_id": "12345",
                                "gamma_match_method": "condition_id",
                                "exact_gamma_market_verified": True,
                                "authoritative_rule_source_field": "resolutionCriteria",
                                "final_rule_gate_result": "bypassed_verified_binary_rules",
                            },
                        }
                    ],
                },
            },
            {
                "stage_number": 3,
                "status": "warning",
                "reason": "Stage 3 recorded a blocker.",
                "outputs": {
                    "workflow_stage_key": "invest",
                    "decision_rows": [
                        {
                            "id": "decision-1",
                            "market_id": "market-1",
                            "stage3_result": "BLOCKED",
                            "stage3_result_reason": (
                                "LLM consensus completed, but Stage 3 did not plan this market because no exact Gamma child market matched the saved condition ID / market ID / slug. "
                                "Fix: refresh the Polymarket mapping so Stage 2 stores the correct child-market identifiers."
                            ),
                            "reason": "Rule blocker",
                            "summary": "Rule blocker",
                            "order_plan": None,
                        }
                    ],
                },
            },
        ],
        "audit_metadata": {
            "code_provenance": {"backend_commit_sha": "abc123"},
            "settings_snapshot": {},
        },
        "diagnostics": {},
    }

    bundle = _build_bundle(
        run_payload=run_payload,
        decisions=[],
        run_orders_payload={},
        source_kind="native",
        lifecycle_status="working",
    )

    review = bundle["stage_2"]["candidate_reviews"][0]
    assert review["rule_gate_result"] == "bypassed_verified_binary_rules"
    assert (
        review["stage2_context"]["authoritative_rule_source_field"]
        == "resolutionCriteria"
    )
    decision_row = bundle["stage_3"]["decision_rows"][0]
    assert "Fix:" in decision_row["stage3_result_reason"]


def test_algorithm_registry_contains_required_audit_keys():
    keys = {entry["algorithm_key"] for entry in AUDITED_ALGORITHM_REGISTRY}
    assert keys >= {
        "stage2_consensus_statistics",
        "candidate_returns_per_day",
        "console_trade_amount_per_opportunity",
        "llm_returns_per_day",
        "position_returns_per_day",
        "stage3_rank_and_selection",
        "order_funnel_aggregation",
        "stage3_bullpen_response_normalization",
        "stage3_verified_remote_absence_retry",
    }


def test_stage1_verified_portfolio_capture_and_formula_use_serialized_rows():
    import app.infrastructure.database.all_models  # noqa: F401

    active_positions = [
        {
            "position_key": f"market-{index}::NO",
            "market_id": f"market-{index}",
            "market_title": f"Market {index}",
            "side": "NO",
            "classification": "active",
        }
        for index in range(6)
    ]
    outputs = {
        "workflow_stage_key": "scan",
        "phase_status": "completed",
        "active_positions_found": active_positions,
        "console_trade_cash_in_hand_usd": 1.85,
        "console_trade_occupied_positions": 6,
        "console_trade_active_positions": 6,
        "console_trade_available_slots": 4,
        "console_trade_max_positions": 10,
        "console_trade_amount_usd": 0.46,
    }
    run_payload = {
        "id": "run-verified-portfolio",
        "status": "completed",
        "triggered_by": "scheduled",
        "started_at": "2026-07-20T13:20:00+00:00",
        "completed_at": "2026-07-20T13:25:00+00:00",
        "summary": "Stage 1 verified six active positions.",
        "stage_results": [
            {
                "stage_number": 1,
                "status": "pass",
                "reason": "Stage 1 finished.",
                "outputs": outputs,
            }
        ],
        "audit_metadata": {
            "code_provenance": {"backend_commit_sha": "abc123"},
            "settings_snapshot": {},
        },
        "diagnostics": {},
    }

    bundle = _build_bundle(
        run_payload=run_payload,
        decisions=[],
        run_orders_payload={},
        source_kind="native",
        lifecycle_status="frozen",
    )
    verified = bundle["stage_1"]["verified_portfolio_snapshot"]
    assert verified["active_position_count"] == 6
    assert verified["available_slots"] == 4
    assert verified["trade_amount_usd"] == 0.46

    records = _build_formula_records(
        snapshot_id=1,
        stage1_outputs=outputs,
        candidate_reviews=[],
        decisions=[],
        run_order_funnel={},
    )
    sizing_record = next(
        record
        for record in records
        if record.algorithm_key == "console_trade_amount_per_opportunity"
    )
    assert sizing_record.validation_status == "match"
    assert sizing_record.recomputed_value_json == {
        "occupied_positions": 6,
        "available_slots": 4,
        "trade_amount_usd": 0.46,
    }


def test_stage1_verified_portfolio_validator_rejects_zero_count_and_bad_sizing():
    bundle = {
        "metadata": {"run_id": "run-bad-portfolio"},
        "overview": {
            "started_at": "2026-07-20T13:20:00+00:00",
            "completed_at": "2026-07-20T13:25:00+00:00",
            "duration_seconds": 300,
            "code_provenance": {"backend_commit_sha": "abc123"},
            "missing_fields": [],
        },
        "stage_1": {
            "verified_portfolio_snapshot": {
                "source": "stage1_active_positions_found",
                "active_positions_found": [
                    {"market_id": f"market-{index}"} for index in range(6)
                ],
                "recorded_occupied_positions": 0,
                "cash_in_hand_usd": 1.85,
                "available_slots": 10,
                "max_positions": 10,
                "trade_amount_usd": 0.19,
            }
        },
        "stage_2": {"candidate_reviews": []},
        "stage_3": {"decisions": [], "order_intents": []},
        "raw": {},
    }

    findings = build_deterministic_findings(bundle)
    codes = {finding["code"] for finding in findings}

    assert "STAGE1_VERIFIED_POSITION_COUNT_MISMATCH" in codes
    assert "STAGE1_VERIFIED_AVAILABLE_SLOTS_MISMATCH" in codes
    assert "STAGE1_VERIFIED_TRADE_AMOUNT_MISMATCH" in codes


@pytest.mark.anyio
async def test_run_audit_feedback_route_validates_target_and_enqueues(monkeypatch):
    app = _build_test_app()
    captured: dict[str, object] = {}

    class _DummySession:
        def commit(self) -> None:
            return None

    class _DummySessionContext:
        def __enter__(self):
            return _DummySession()

        def __exit__(self, exc_type, exc, tb):
            return False

    async def fake_to_thread(func):
        return func()

    def fake_validate_target(provider: str, model: str):
        captured["validated"] = (provider, model)
        return SimpleNamespace(available=True, reason=None)

    def fake_create_provider(*args, **kwargs):
        raise AssertionError("Feedback route should not create a provider directly")

    def fake_enqueue(session, user_id: int, run_id: str, request):
        captured["enqueued"] = {
            "user_id": user_id,
            "run_id": run_id,
            "provider": request.provider,
            "model": request.model,
            "force_rerun": request.force_rerun,
        }
        return BullpenRunAuditFeedbackSummary(
            id=41,
            status="queued",
            provider=request.provider,
            model=request.model,
            prompt_version="bullpen-run-audit-v1",
            prompt_hash="hash",
            report_version="1",
            chunk_count=0,
            chunk_coverage_pct=0,
            snapshot_hash="snapshot-hash",
            tokens_in=0,
            tokens_out=0,
            estimated_cost=0,
            latency_seconds=0,
            error_message=None,
            codex_prompt=None,
            created_at="2026-07-18T10:00:00+00:00",
            updated_at="2026-07-18T10:00:00+00:00",
            completed_at=None,
        )

    monkeypatch.setattr(
        "app.domains.bullpen_run_audit.router.ProviderFactory.validate_target",
        fake_validate_target,
    )
    monkeypatch.setattr(
        "app.domains.bullpen_run_audit.router.ProviderFactory.create",
        fake_create_provider,
    )
    monkeypatch.setattr(
        "app.domains.bullpen_run_audit.router.SyncSessionLocal",
        _DummySessionContext,
    )
    monkeypatch.setattr(
        "app.domains.bullpen_run_audit.router.asyncio.to_thread",
        fake_to_thread,
    )
    monkeypatch.setattr(
        "app.domains.bullpen_run_audit.router.enqueue_run_audit_feedback_sync",
        fake_enqueue,
    )

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post(
            "/bullpen-ai/run-audits/run-1/feedback",
            json={
                "provider": "openai",
                "model": "gpt-5-mini",
                "force_rerun": True,
            },
        )

    assert response.status_code == 202
    assert captured["validated"] == ("openai", "gpt-5-mini")
    assert captured["enqueued"] == {
        "user_id": 7,
        "run_id": "run-1",
        "provider": "openai",
        "model": "gpt-5-mini",
        "force_rerun": True,
    }


@pytest.mark.anyio
async def test_run_audit_feedback_route_rejects_unavailable_model(monkeypatch):
    app = _build_test_app()

    def fake_validate_target(provider: str, model: str):
        return SimpleNamespace(available=False, reason=f"{provider}/{model} unavailable")

    monkeypatch.setattr(
        "app.domains.bullpen_run_audit.router.ProviderFactory.validate_target",
        fake_validate_target,
    )

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post(
            "/bullpen-ai/run-audits/run-1/feedback",
            json={"provider": "openai", "model": "gpt-5-mini"},
        )

    assert response.status_code == 400
    assert "unavailable" in response.json()["detail"]


def test_feedback_report_fixture_matches_required_keys():
    payload = _feedback_report_payload()
    assert set(payload) == REQUIRED_REPORT_KEYS
