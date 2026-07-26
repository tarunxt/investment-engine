import json
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.dialects import postgresql

import app.infrastructure.database.all_models  # noqa: F401
from app.domains.auth.dependencies import get_current_user
from app.domains.bullpen_run_audit.constants import (
    AUDIT_SECTION_KEYS,
    AUDITED_ALGORITHM_REGISTRY,
    BULLPEN_RUN_AUDIT_ALGORITHM_REGISTRY_VERSION,
    BULLPEN_RUN_AUDIT_RULE_VERSION,
    BULLPEN_RUN_AUDIT_SCHEMA_VERSION,
)
from app.domains.bullpen_run_audit.prompt_builder import (
    REQUIRED_REPORT_KEYS,
    parse_feedback_report,
    plan_feedback_chunks,
)
from app.domains.bullpen_run_audit.repository import (
    BullpenRunAuditRepository,
    sanitize_audit_evidence,
)
from app.domains.bullpen_run_audit.router import router as run_audit_router
from app.domains.bullpen_run_audit.service import (
    _build_bundle,
    _build_formula_records,
    _serialize_stage_records,
    _stage_result_for_workflow,
)
from app.domains.bullpen_run_audit.sanitizer import sanitize_secret_value
from app.domains.bullpen_run_audit.schemas import BullpenRunAuditFeedbackSummary
from app.domains.bullpen_run_audit.validators import (
    build_deterministic_findings,
    coalesce_deterministic_findings,
)
from app.domains.polymarket.position_classification import (
    BULLPEN_POSITION_CLASSIFIER_VERSION,
)


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


def test_audit_decision_capture_filters_superseded_reconciliation_rows():
    class _ScalarRows:
        def scalars(self):
            return self

        def all(self):
            return []

    class _Session:
        query = None

        def execute(self, query):
            self.query = query
            return _ScalarRows()

    session = _Session()
    repository = BullpenRunAuditRepository(session)  # type: ignore[arg-type]

    assert repository.get_run_decision_records(user_id=7, run_id="run-1") == []
    assert session.query is not None
    compiled = str(
        session.query.compile(
            dialect=postgresql.dialect(),
            compile_kwargs={"literal_binds": True},
        )
    )

    assert "_console_reconciliation_state" in compiled
    assert "superseded" in compiled


@pytest.mark.parametrize(
    ("workflow_key", "exact_stage_number"),
    [("scan", 1), ("llm", 2), ("invest", 3)],
)
@pytest.mark.parametrize("legacy_first", [False, True])
def test_audit_workflow_stage_selector_always_prefers_exact_stage_number(
    workflow_key,
    exact_stage_number,
    legacy_first,
):
    exact = {
        "stage_number": exact_stage_number,
        "status": "pass",
        "outputs": {
            "workflow_stage_key": workflow_key,
            "selection_marker": "exact",
        },
    }
    mislabeled = {
        "stage_number": exact_stage_number + 10,
        "status": "fail",
        "outputs": {
            "workflow_stage_key": workflow_key,
            "selection_marker": "mislabeled",
        },
    }
    stages = [mislabeled, exact] if legacy_first else [exact, mislabeled]

    selected = _stage_result_for_workflow(
        {"stage_results": stages},
        workflow_key,
    )

    assert selected["stage_number"] == exact_stage_number
    assert selected["outputs"]["selection_marker"] == "exact"


def test_audit_workflow_stage_selector_uses_first_explicit_legacy_fallback():
    selected = _stage_result_for_workflow(
        {
            "stage_results": [
                {
                    "stage_number": 8,
                    "outputs": {
                        "workflow_stage_key": "invest",
                        "selection_marker": "first",
                    },
                },
                {
                    "stage_number": 9,
                    "outputs": {
                        "workflow_stage_key": "invest",
                        "selection_marker": "second",
                    },
                },
            ]
        },
        "invest",
    )

    assert selected["outputs"]["selection_marker"] == "first"


@pytest.mark.parametrize("legacy_first", [False, True])
def test_audit_bundle_status_uses_same_exact_stage_as_section_payload(
    legacy_first,
):
    exact = {
        "stage_number": 3,
        "status": "pass",
        "outputs": {
            "workflow_stage_key": "invest",
            "decision_rows": [{"selection_marker": "exact"}],
        },
    }
    mislabeled = {
        "stage_number": 13,
        "status": "fail",
        "outputs": {
            "workflow_stage_key": "invest",
            "decision_rows": [{"selection_marker": "mislabeled"}],
        },
    }
    stages = [mislabeled, exact] if legacy_first else [exact, mislabeled]

    bundle = _build_bundle(
        run_payload={
            "id": "run-canonical-stage-status",
            "status": "completed",
            "triggered_by": "manual",
            "started_at": "2026-07-27T00:00:00+00:00",
            "completed_at": "2026-07-27T00:01:00+00:00",
            "summary": "Canonical exact Stage 3 completed.",
            "stage_results": stages,
            "audit_metadata": {},
            "diagnostics": {},
        },
        decisions=[],
        run_orders_payload={},
        source_kind="native",
        lifecycle_status="frozen",
    )

    assert bundle["stage_3"]["decision_rows"] == [
        {"selection_marker": "exact"}
    ]
    assert bundle["overview"]["stage_statuses"]["stage_3"] == "pass"


def test_audit_evidence_sanitizer_redacts_host_paths_but_preserves_json_pointers():
    credential_path = (
        "/home/investor/.config/bullpen/credentials.json.enc"
    )

    sanitized = sanitize_audit_evidence(
        {
            "wallet_refresh_error": (
                f"Unable to read {credential_path} during Stage 1."
            ),
            "evidence_pointer": "/stage_3/order_intents/0",
            "market_url": "https://example.com/home/market",
        }
    )

    serialized = json.dumps(sanitized)
    assert credential_path not in serialized
    assert "[REDACTED_PATH]" in serialized
    assert sanitized["evidence_pointer"] == "/stage_3/order_intents/0"
    assert sanitized["market_url"] == "https://example.com/home/market"


def test_stage_record_direct_fields_and_blobs_are_path_sanitized():
    credential_path = "/etc/investor/backend.env"

    class CaptureRepository:
        def __init__(self):
            self.payloads = []

        def create_blob(self, *, payload, content_type):
            assert content_type == "application/json"
            self.payloads.append(payload)
            return SimpleNamespace(id=f"blob-{len(self.payloads)}")

    repo = CaptureRepository()
    records = _serialize_stage_records(
        repo,
        snapshot_id=17,
        run_stages=[
            {
                "stage_number": 1,
                "stage_name": "scan",
                "status": "warning",
                "reason": f"Could not read {credential_path}",
                "inputs": {"path": credential_path},
                "outputs": {"error": f"Missing {credential_path}"},
            }
        ],
        decision_stages=[],
    )

    serialized = json.dumps(
        {
            "reason": records[0].reason,
            "payloads": repo.payloads,
        }
    )
    assert credential_path not in serialized
    assert "[REDACTED_PATH]" in serialized


def _immediate_sell_attempt(
    sequence: int,
    *,
    result: str,
    safe_to_fallback: bool,
) -> dict[str, object]:
    layer = ("primary", "secondary", "tertiary")[sequence - 1]
    path = (
        "market_sell_explicit",
        "market_sell_max",
        "limit_sell_fak",
    )[sequence - 1]
    return {
        "sequence": sequence,
        "layer": layer,
        "path": path,
        "result": result,
        "reason": f"{path}:{result}",
        "validation": (
            "no_remote_write_safe_to_fallback"
            if safe_to_fallback
            else "terminal_result_stop"
        ),
        "safe_to_fallback": safe_to_fallback,
        "provider_alias": "rpc-1",
        "started_at": f"2026-07-26T10:00:0{sequence}+00:00",
        "completed_at": f"2026-07-26T10:00:0{sequence + 1}+00:00",
    }


def _immediate_sell_strategy(
    attempts: list[dict[str, object]],
    *,
    selected_layer: str | None,
    execution_path: str | None,
) -> dict[str, object]:
    return {
        "version": "v1",
        "selected_layer": selected_layer,
        "execution_path": execution_path,
        "fallback_count": sum(
            1 for attempt in attempts[:-1] if attempt.get("result") == "fallback"
        ),
        "attempts": attempts,
    }


def _immediate_sell_bundle(
    strategy: dict[str, object] | None,
    *,
    mirror: dict[str, object] | None = None,
    order_status: str = "SUBMITTED",
    durable_attempts: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    execution_metadata = (
        {"immediate_sell_strategy": strategy}
        if strategy is not None
        else {}
    )
    response_json = (
        {"_stage3_immediate_sell": mirror if mirror is not None else strategy}
        if strategy is not None
        else {}
    )
    return {
        "metadata": {
            "run_id": "run-immediate-sell",
            "snapshot_schema_version": 2,
        },
        "overview": {
            "run_status": "confirming",
            "started_at": "2026-07-26T10:00:00+00:00",
            "completed_at": None,
            "duration_seconds": None,
            "code_provenance": {"backend_commit_sha": "abc123"},
            "missing_fields": [],
        },
        "stage_2": {"candidate_reviews": []},
        "stage_3": {
            "decisions": [],
            "max_positions": 10,
            "order_intents": [
                {
                    "id": "sell-intent-1",
                    "action": "sell",
                    "status": order_status,
                    "idempotency_key": "auto-live:v2:sell-intent-1",
                    "execution_metadata_json": execution_metadata,
                    "attempts": durable_attempts
                    if durable_attempts is not None
                    else [
                        {
                            "attempt_number": 1,
                            "sanitized_response_json": response_json,
                        }
                    ],
                }
            ],
        },
        "raw": {},
    }


def _current_buy_audit_bundle(
    *,
    status: str,
    execution_metadata: dict[str, object] | None = None,
    dependency_metadata: dict[str, object] | None = None,
    reserved_cash_usd: float = 0,
    reservations: list[dict[str, object]] | None = None,
    dependency_group: str | None = None,
    filled_shares: float = 0,
) -> dict[str, object]:
    bundle = _immediate_sell_bundle(
        None,
        order_status=status,
        durable_attempts=[],
    )
    order = bundle["stage_3"]["order_intents"][0]
    order.update(
        {
            "id": "buy-intent-1",
            "action": "buy",
            "idempotency_key": "auto-live:v2:buy-intent-1",
            "dependency_group": dependency_group,
            "reserved_cash_usd": reserved_cash_usd,
            "filled_shares": filled_shares,
            "execution_metadata_json": execution_metadata or {},
            "dependency_metadata_json": dependency_metadata or {},
            "reservations": reservations or [],
        }
    )
    return bundle


def _buy_market_preflight(
    *,
    conflict_count: int = 0,
) -> dict[str, object]:
    conflicts = (
        [
            {
                "intent_id": "older-unresolved-buy",
                "status": "TIMED_OUT",
                "matched_aliases": ["buy-market"],
                "persisted_write_evidence": True,
                "active_reservation": True,
                "definitive_zero_fill": False,
            }
        ]
        if conflict_count
        else []
    )
    return {
        "version": "v1",
        "checked_at": "2026-07-27T00:00:59+00:00",
        "market_wide": True,
        "scope": "singleton_bullpen_runtime",
        "target_aliases": ["buy-market"],
        "conflict_count": conflict_count,
        "conflicts": conflicts,
        "conflicts_truncated": False,
        "result": "blocked" if conflict_count else "pass",
    }


def _buy_cash_preflight() -> dict[str, object]:
    return {
        "version": "v2",
        "checked_at": "2026-07-27T00:00:59+00:00",
        "balance_checked_at": "2026-07-27T00:00:57+00:00",
        "scope": "singleton_bullpen_runtime",
        "available_balance_usd": 3.44,
        "balance_buffer_usd": 1.0,
        "spendable_cash_usd": 2.44,
        "held_reservation_usd": 0.0,
        "requested_order_usd": 1.22,
        "unreserved_cash_usd": 2.44,
        "includes_unseen_consumed_reservations": True,
        "result": "pass",
    }


def _valid_buy_wallet_lineage() -> tuple[dict[str, object], dict[str, object]]:
    return (
        {
            "source": "live-cli",
            "fetched_at": "2026-07-27T00:00:58+00:00",
            "freshness_state": "fresh",
            "account_identity": "wallet-a",
            "credential_artifact": {
                "inode": 11,
                "mtime_ns": 22,
                "size": 33,
            },
            "position_classifier_version": (
                BULLPEN_POSITION_CLASSIFIER_VERSION
            ),
        },
        {
            "status": "match",
            "compared_fields": [
                "account_identity",
                "position_classifier_version",
                "credential_artifact.inode",
                "credential_artifact.mtime_ns",
                "credential_artifact.size",
                "fetched_at_not_older",
            ],
            "mismatches": [],
        },
    )


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


def test_sanitize_secret_value_preserves_only_credential_artifact_fingerprint():
    sanitized = sanitize_secret_value(
        {
            "credential_artifact": {
                "path": "/home/investor/.config/bullpen/credentials.json.enc",
                "inode": 17,
                "mtime_ns": 123456,
                "size": 999,
                "password": "must-not-survive",
            },
            "wallet_credential_artifact_inode": 17,
            "wallet_credential_artifact_mtime_ns": 123456,
            "wallet_credential_artifact_size": 999,
            "credential_token": "must-not-survive",
        }
    )

    assert sanitized["credential_artifact"] == {
        "inode": 17,
        "mtime_ns": 123456,
        "size": 999,
    }
    assert sanitized["wallet_credential_artifact_inode"] == 17
    assert sanitized["wallet_credential_artifact_mtime_ns"] == 123456
    assert sanitized["wallet_credential_artifact_size"] == 999
    assert sanitized["credential_token"] == "[REDACTED]"
    serialized = json.dumps(sanitized)
    assert "/home/investor" not in serialized
    assert "must-not-survive" not in serialized


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


def test_coalesce_deterministic_findings_preserves_order_and_occurrences():
    first = {
        "rule_version": "rule-v1",
        "code": "REPEATED",
        "severity": "low",
        "stage": "stage-1",
        "category": "test",
        "title": "First title",
        "explanation": "First explanation",
        "observed_value": "first",
        "expected_value": None,
        "blocking": False,
        "classification": "deterministic",
        "suggested_remediation": None,
        "evidence_pointers": ["/first", {"path": "/shared"}],
        "detection_metadata": {"source": "first"},
    }
    singleton = {
        "rule_version": "rule-v1",
        "code": "SINGLETON",
        "severity": "medium",
        "evidence_pointers": ["/singleton"],
        "detection_metadata": {"unchanged": True},
    }
    second = {
        **first,
        "severity": "critical",
        "stage": "stage-2",
        "blocking": True,
        "observed_value": "second",
        "evidence_pointers": [{"path": "/shared"}, "/second"],
        "detection_metadata": {"source": "second"},
    }

    findings = coalesce_deterministic_findings([first, singleton, second])

    assert [finding["code"] for finding in findings] == [
        "REPEATED",
        "SINGLETON",
    ]
    repeated = findings[0]
    assert repeated["severity"] == "critical"
    assert repeated["blocking"] is True
    assert repeated["evidence_pointers"] == [
        "/first",
        {"path": "/shared"},
        "/second",
    ]
    assert repeated["detection_metadata"]["occurrence_count"] == 2
    assert repeated["detection_metadata"]["occurrences_truncated"] is False
    assert (
        len(repeated["detection_metadata"]["occurrences_hash"]) == 64
    )
    assert (
        repeated["detection_metadata"]["evidence_pointers_truncated"]
        is False
    )
    assert [
        occurrence["observed_value"]
        for occurrence in repeated["detection_metadata"]["occurrences"]
    ] == ["first", "second"]
    assert [
        occurrence["detection_metadata"]["source"]
        for occurrence in repeated["detection_metadata"]["occurrences"]
    ] == ["first", "second"]
    assert findings[1] == singleton
    assert "occurrence_count" not in findings[1]["detection_metadata"]


def test_coalesce_deterministic_findings_bounds_ten_thousand_duplicates():
    duplicates = []
    for index in range(10_000):
        evidence_pointers = (
            [
                {
                    "path": f"/large-evidence/{pointer_index}",
                    "detail": "e" * 2_000,
                }
                for pointer_index in range(75)
            ]
            if index == 0
            else [f"/occurrence/{index}"]
        )
        detection_metadata = (
            {
                "items": list(range(100)),
                "large": "m" * 5_000,
            }
            if index == 0
            else {"index": index}
        )
        duplicates.append(
            {
                "rule_version": "rule-v1",
                "code": "REPEATED_TEN_THOUSAND",
                "severity": "medium",
                "stage": "stage-2",
                "category": "test",
                "title": "Repeated finding",
                "explanation": "Repeated adversarial occurrence.",
                "observed_value": str(index),
                "expected_value": "none",
                "blocking": False,
                "classification": "deterministic",
                "suggested_remediation": None,
                "evidence_pointers": evidence_pointers,
                "detection_metadata": detection_metadata,
            }
        )

    first = coalesce_deterministic_findings(duplicates)[0]
    second = coalesce_deterministic_findings(duplicates)[0]
    metadata = first["detection_metadata"]

    assert metadata["occurrence_count"] == 10_000
    assert len(metadata["occurrences"]) == 50
    assert metadata["occurrences_truncated"] is True
    assert len(metadata["occurrences_hash"]) == 64
    assert metadata["occurrences_hash"] == second["detection_metadata"][
        "occurrences_hash"
    ]
    assert metadata["source_detection_metadata_truncated"] is True
    assert len(metadata["source_detection_metadata_hash"]) == 64
    assert len(metadata["items"]) == 50
    assert len(metadata["large"]) == 1_001
    assert len(first["evidence_pointers"]) == 50
    assert metadata["evidence_pointer_count"] == 10_074
    assert metadata["evidence_pointers_truncated"] is True
    assert len(metadata["evidence_pointers_hash"]) == 64

    first_occurrence = metadata["occurrences"][0]
    assert len(first_occurrence["evidence_pointers"]) == 50
    assert first_occurrence["evidence_pointer_count"] == 75
    assert first_occurrence["evidence_pointers_truncated"] is True
    assert first_occurrence["detection_metadata_truncated"] is True
    assert len(first_occurrence["detection_metadata"]["items"]) == 50
    assert len(first_occurrence["detection_metadata"]["large"]) == 1_001
    assert len(json.dumps(first, sort_keys=True)) < 250_000

    changed_duplicates = list(duplicates)
    changed_duplicates[-1] = {
        **duplicates[-1],
        "observed_value": "changed-outside-sample",
    }
    changed = coalesce_deterministic_findings(changed_duplicates)[0]
    assert changed["detection_metadata"]["occurrences"] == metadata[
        "occurrences"
    ]
    assert changed["detection_metadata"]["occurrences_hash"] != metadata[
        "occurrences_hash"
    ]


def test_build_deterministic_findings_coalesces_repeated_llm_mismatches():
    bundle = {
        "metadata": {"run_id": "run-repeated-llm-findings"},
        "overview": {
            "started_at": "2026-07-27T10:00:00+00:00",
            "duration_seconds": 1,
            "code_provenance": {"backend_commit_sha": "abc123"},
            "missing_fields": [],
        },
        "stage_2": {
            "candidate_reviews": [
                {
                    "market_id": "market-1",
                    "source_kind": "candidate",
                    "qualified": False,
                    "llm_outputs": [
                        {
                            "llm_yes_odds": 60,
                            "llm_no_odds": 40,
                            "status": "completed",
                            "rationale_odds_mismatch": True,
                        },
                        {
                            "llm_yes_odds": 55,
                            "llm_no_odds": 45,
                            "status": "completed",
                            "rationale_odds_mismatch": True,
                        },
                    ],
                }
            ],
            "universe_status": {},
        },
        "stage_3": {
            "decisions": [],
            "order_intents": [],
        },
        "raw": {},
    }

    findings = build_deterministic_findings(bundle)
    mismatches = [
        finding
        for finding in findings
        if finding["code"] == "RATIONALE_ODDS_DIRECTION_CONFLICT"
    ]

    assert len(mismatches) == 1
    assert mismatches[0]["evidence_pointers"] == [
        "/stage_2/candidate_reviews/0/llm_outputs/0",
        "/stage_2/candidate_reviews/0/llm_outputs/1",
    ]
    metadata = mismatches[0]["detection_metadata"]
    assert metadata["occurrence_count"] == 2
    assert [
        occurrence["evidence_pointers"][0]
        for occurrence in metadata["occurrences"]
    ] == mismatches[0]["evidence_pointers"]


def test_build_deterministic_findings_validates_bounded_execution_handoffs():
    bundle = {
        "metadata": {"run_id": "run-handoff"},
        "overview": {
            "run_status": "running",
            "execution_handoff": {
                "stages": [
                    {
                        "stage": "primary",
                        "reason": "preferred_planning_queue",
                        "validation": "durable_run_persisted",
                        "triggered_at": "2026-07-25T10:00:00+00:00",
                    },
                    {
                        "stage": "secondary",
                        "reason": "dedicated_queue_handoff_timeout",
                        "validation": "fallback_publish_accepted",
                        "triggered_at": "2026-07-25T10:00:30+00:00",
                    },
                ]
            },
            "request_context": {"client_run_id": "run-handoff"},
            "missing_fields": [],
            "code_provenance": {"backend_commit_sha": "abc123"},
        },
        "stage_2": {"candidate_reviews": []},
        "stage_3": {"decisions": [], "order_intents": []},
        "raw": {},
    }

    codes = {
        finding["code"]
        for finding in build_deterministic_findings(bundle)
    }
    assert "RUN_HANDOFF_SECONDARY_FALLBACK_USED" in codes
    assert "RUN_HANDOFF_FALLBACK_SEQUENCE_INVALID" not in codes
    assert "RUN_START_IDEMPOTENCY_ID_MISMATCH" not in codes

    bundle["overview"]["execution_handoff"]["stages"] = [
        {
            "stage": "primary",
            "reason": "preferred_planning_queue",
            "validation": "durable_run_persisted",
            "triggered_at": "2026-07-25T10:00:00+00:00",
        },
        {
            "stage": "tertiary",
            "reason": "handoff_timeout",
            "validation": "no_execution_owner",
            "triggered_at": "2026-07-25T10:04:00+00:00",
        },
    ]
    bundle["overview"]["request_context"]["client_run_id"] = "different-run"
    invalid_codes = {
        finding["code"]
        for finding in build_deterministic_findings(bundle)
    }
    assert "RUN_HANDOFF_FALLBACK_SEQUENCE_INVALID" in invalid_codes
    assert "RUN_HANDOFF_TERTIARY_NOT_FAIL_CLOSED" in invalid_codes
    assert "RUN_START_IDEMPOTENCY_ID_MISMATCH" in invalid_codes


def test_immediate_sell_audit_accepts_primary_and_legacy_intents():
    primary_attempts = [
        _immediate_sell_attempt(
            1,
            result="accepted",
            safe_to_fallback=False,
        )
    ]
    primary_strategy = _immediate_sell_strategy(
        primary_attempts,
        selected_layer="primary",
        execution_path="market_sell_explicit",
    )

    primary_codes = {
        finding["code"]
        for finding in build_deterministic_findings(
            _immediate_sell_bundle(primary_strategy)
        )
        if str(finding["code"]).startswith("STAGE3_IMMEDIATE_SELL")
    }
    legacy_codes = {
        finding["code"]
        for finding in build_deterministic_findings(
            _immediate_sell_bundle(None)
        )
        if str(finding["code"]).startswith("STAGE3_IMMEDIATE_SELL")
    }

    assert primary_codes == set()
    assert legacy_codes == set()


def test_immediate_sell_audit_records_valid_secondary_fallback():
    attempts = [
        _immediate_sell_attempt(
            1,
            result="fallback",
            safe_to_fallback=True,
        ),
        _immediate_sell_attempt(
            2,
            result="accepted",
            safe_to_fallback=False,
        ),
    ]
    strategy = _immediate_sell_strategy(
        attempts,
        selected_layer="secondary",
        execution_path="market_sell_max",
    )

    findings = build_deterministic_findings(_immediate_sell_bundle(strategy))
    immediate_findings = {
        finding["code"]: finding
        for finding in findings
        if str(finding["code"]).startswith("STAGE3_IMMEDIATE_SELL")
    }

    assert set(immediate_findings) == {"STAGE3_IMMEDIATE_SELL_FALLBACK_USED"}
    assert immediate_findings["STAGE3_IMMEDIATE_SELL_FALLBACK_USED"][
        "detection_metadata"
    ] == {"fallback_reasons": ["market_sell_explicit:fallback"]}


def test_immediate_sell_audit_accepts_bounded_tertiary_fallback():
    attempts = [
        _immediate_sell_attempt(
            1,
            result="fallback",
            safe_to_fallback=True,
        ),
        _immediate_sell_attempt(
            2,
            result="fallback",
            safe_to_fallback=True,
        ),
        _immediate_sell_attempt(
            3,
            result="accepted",
            safe_to_fallback=False,
        ),
    ]
    strategy = _immediate_sell_strategy(
        attempts,
        selected_layer="tertiary",
        execution_path="limit_sell_fak",
    )

    codes = {
        finding["code"]
        for finding in build_deterministic_findings(
            _immediate_sell_bundle(strategy)
        )
        if str(finding["code"]).startswith("STAGE3_IMMEDIATE_SELL")
    }

    assert codes == {"STAGE3_IMMEDIATE_SELL_FALLBACK_USED"}


def test_immediate_sell_audit_accepts_verified_tertiary_exhaustion():
    attempts = [
        _immediate_sell_attempt(
            sequence,
            result="fallback",
            safe_to_fallback=True,
        )
        for sequence in (1, 2, 3)
    ]
    strategy = _immediate_sell_strategy(
        attempts,
        selected_layer=None,
        execution_path=None,
    )

    codes = {
        finding["code"]
        for finding in build_deterministic_findings(
            _immediate_sell_bundle(
                strategy,
                order_status="FAILED_PERMANENT",
            )
        )
        if str(finding["code"]).startswith("STAGE3_IMMEDIATE_SELL")
    }

    assert strategy["fallback_count"] == 2
    assert codes == {"STAGE3_IMMEDIATE_SELL_FALLBACK_USED"}


def test_immediate_sell_audit_rejects_stopping_after_safe_primary_failure():
    attempts = [
        _immediate_sell_attempt(
            1,
            result="fallback",
            safe_to_fallback=True,
        )
    ]
    strategy = _immediate_sell_strategy(
        attempts,
        selected_layer=None,
        execution_path=None,
    )

    codes = {
        finding["code"]
        for finding in build_deterministic_findings(
            _immediate_sell_bundle(
                strategy,
                order_status="FAILED_PERMANENT",
            )
        )
    }

    assert "STAGE3_IMMEDIATE_SELL_UNSAFE_FALLBACK" in codes


def test_immediate_sell_audit_rejects_terminal_fallthrough_and_bad_selection():
    attempts = [
        _immediate_sell_attempt(
            1,
            result="ambiguous",
            safe_to_fallback=False,
        ),
        _immediate_sell_attempt(
            2,
            result="accepted",
            safe_to_fallback=False,
        ),
    ]
    strategy = _immediate_sell_strategy(
        attempts,
        selected_layer="primary",
        execution_path="market_sell_explicit",
    )

    codes = {
        finding["code"]
        for finding in build_deterministic_findings(
            _immediate_sell_bundle(strategy)
        )
    }

    assert "STAGE3_IMMEDIATE_SELL_TERMINAL_RESULT_FELL_THROUGH" in codes
    assert "STAGE3_IMMEDIATE_SELL_SELECTED_PATH_INVALID" in codes


def test_immediate_sell_audit_rejects_unbounded_sequence_and_attempt_mismatch():
    attempts = [
        _immediate_sell_attempt(
            1,
            result="fallback",
            safe_to_fallback=True,
        ),
        {
            **_immediate_sell_attempt(
                2,
                result="accepted",
                safe_to_fallback=False,
            ),
            "layer": "primary",
            "path": "market_sell_explicit",
        },
    ]
    strategy = _immediate_sell_strategy(
        attempts,
        selected_layer="primary",
        execution_path="market_sell_explicit",
    )
    mismatched_mirror = {
        **strategy,
        "fallback_count": 0,
    }

    codes = {
        finding["code"]
        for finding in build_deterministic_findings(
            _immediate_sell_bundle(
                strategy,
                mirror=mismatched_mirror,
            )
        )
    }

    assert "STAGE3_IMMEDIATE_SELL_FALLBACK_SEQUENCE_INVALID" in codes
    assert "STAGE3_IMMEDIATE_SELL_ATTEMPT_MIRROR_MISMATCH" in codes


def test_immediate_sell_audit_binds_strategy_to_write_attempt_before_later_preflight_failure():
    attempts = [
        _immediate_sell_attempt(
            1,
            result="accepted",
            safe_to_fallback=False,
        )
    ]
    strategy = _immediate_sell_strategy(
        attempts,
        selected_layer="primary",
        execution_path="market_sell_explicit",
    )

    codes = {
        finding["code"]
        for finding in build_deterministic_findings(
            _immediate_sell_bundle(
                strategy,
                durable_attempts=[
                    {
                        "attempt_number": 1,
                        "sanitized_response_json": {
                            "_stage3_immediate_sell": strategy,
                        },
                    },
                    {
                        "attempt_number": 2,
                        "error_code": "DOCTOR_READ_FAILED",
                        "sanitized_response_json": {},
                    },
                ],
            )
        )
        if str(finding["code"]).startswith("STAGE3_IMMEDIATE_SELL")
    }

    assert codes == set()


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


def test_build_deterministic_findings_identifies_interrupted_stage3_handoff_checkpoint():
    bundle = {
        "metadata": {"run_id": "run-stage3-checkpoint"},
        "overview": {
            "run_status": "failed",
            "started_at": "2026-07-21T00:00:00+00:00",
            "completed_at": "2026-07-21T00:05:00+00:00",
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
            "handoff_checkpoint": {
                "status": "received",
                "candidate_market_ids": ["market-top-1"],
                "candidate_count": 1,
            },
            "max_positions": 10,
        },
        "raw": {},
    }

    findings = build_deterministic_findings(bundle)
    codes = {finding["code"] for finding in findings}

    assert "STAGE3_INTERRUPTED_AFTER_HANDOFF_CHECKPOINT" in codes
    assert "STAGE2_TO_STAGE3_HANDOFF_CHECKPOINT_MISMATCH" not in codes


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


def test_build_deterministic_findings_validates_affordable_buy_and_free_slots():
    bundle = {
        "metadata": {"run_id": "run-affordable-allocation"},
        "overview": {
            "run_status": "completed",
            "started_at": "2026-07-27T00:00:00+00:00",
            "completed_at": "2026-07-27T00:05:00+00:00",
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
                "operator_override_enabled": False,
                "capacity_sizing_basis": (
                    "live-economic-plus-current-run-accepted-v2"
                ),
                "capacity_sizing_occupied_market_count": 3,
                "current_run_submitted_buy_market_count": 0,
                "affordable_allocation_version": "v2",
                "eligible_ranked_buy_count": 6,
                "cash_affordable_buy_count": 2,
                "affordable_capacity_slot_budget": 7,
                "affordable_buy_count": 6,
                "affordable_planned_buy_count": 4,
                "affordable_buy_gross_cash_in_hand_usd": 3.44,
                "affordable_buy_balance_buffer_usd": 1.0,
                "affordable_buy_spendable_cash_usd": 2.44,
                "affordable_buy_min_order_usd": 1.0,
                "free_slots_after_planned_buys": 0,
            },
        },
        "raw": {},
    }

    codes = {
        finding["code"] for finding in build_deterministic_findings(bundle)
    }

    assert "STAGE3_AFFORDABLE_BUY_ALLOCATION_INVALID" in codes
    assert "STAGE3_POST_BUY_FREE_SLOT_COUNT_INVALID" in codes


def test_build_deterministic_findings_validates_sell_live_preflight():
    bundle = _immediate_sell_bundle(
        None,
        order_status="SUBMITTED",
        durable_attempts=[],
    )
    order = bundle["stage_3"]["order_intents"][0]
    order.update(
        {
            "last_error_code": "SELL_REQUIRES_REDEEM",
            "remote_order_id": "unsafe-remote-order",
            "first_submitted_at": "2026-07-27T00:01:00+00:00",
            "execution_metadata_json": {
                "sell_live_preflight": {
                    "version": "v1",
                    "source": "cached",
                    "classification": "positive_payout_claimable",
                    "sellable": False,
                    "verified_shares": 4.0,
                    "submitted_shares": 4.0,
                }
            },
        }
    )

    codes = {
        finding["code"] for finding in build_deterministic_findings(bundle)
    }

    assert "STAGE3_SELL_LIVE_PREFLIGHT_INVALID" in codes
    assert "STAGE3_BLOCKED_SELL_HAS_REMOTE_WRITE_REFERENCE" in codes


def test_submitted_buy_audit_requires_singleton_market_preflight():
    bundle = _current_buy_audit_bundle(
        status="SUBMITTED",
        execution_metadata={},
    )
    order = bundle["stage_3"]["order_intents"][0]
    order["market_id"] = "buy-market"
    order["first_submitted_at"] = "2026-07-27T00:01:00+00:00"

    codes = {
        finding["code"] for finding in build_deterministic_findings(bundle)
    }

    assert "STAGE3_BUY_MARKET_PREFLIGHT_MISSING" in codes


def test_submitted_buy_audit_rejects_nonzero_market_conflict():
    preflight = _buy_market_preflight(conflict_count=1)
    cash_preflight = _buy_cash_preflight()
    lineage, comparison = _valid_buy_wallet_lineage()
    bundle = _current_buy_audit_bundle(
        status="SUBMITTED",
        execution_metadata={
            "buy_market_exposure_preflight": preflight,
            "buy_cash_reservation_preflight": cash_preflight,
            "wallet_snapshot_lineage": lineage,
            "wallet_lineage_comparison": comparison,
        },
    )
    order = bundle["stage_3"]["order_intents"][0]
    order["market_id"] = "buy-market"
    order["first_submitted_at"] = "2026-07-27T00:01:00+00:00"
    order["attempts"] = [
        {
            "attempt_number": 1,
            "sanitized_request_json": {
                "_stage3_buy_market_exposure_preflight": preflight,
                "_stage3_buy_cash_reservation_preflight": cash_preflight,
            },
        }
    ]

    codes = {
        finding["code"] for finding in build_deterministic_findings(bundle)
    }

    assert (
        "STAGE3_BUY_MARKET_CONFLICT_CROSSED_WRITE_BOUNDARY" in codes
    )


def test_submitted_buy_audit_accepts_zero_conflict_market_preflight():
    preflight = _buy_market_preflight()
    cash_preflight = _buy_cash_preflight()
    lineage, comparison = _valid_buy_wallet_lineage()
    bundle = _current_buy_audit_bundle(
        status="SUBMITTED",
        execution_metadata={
            "buy_market_exposure_preflight": preflight,
            "buy_cash_reservation_preflight": cash_preflight,
            "wallet_snapshot_lineage": lineage,
            "wallet_lineage_comparison": comparison,
        },
    )
    order = bundle["stage_3"]["order_intents"][0]
    order["market_id"] = "buy-market"
    order["first_submitted_at"] = "2026-07-27T00:01:00+00:00"
    order["attempts"] = [
        {
            "attempt_number": 1,
            "sanitized_request_json": {
                "_stage3_buy_market_exposure_preflight": preflight,
                "_stage3_buy_cash_reservation_preflight": cash_preflight,
            },
        }
    ]

    codes = {
        finding["code"] for finding in build_deterministic_findings(bundle)
    }

    assert "STAGE3_BUY_MARKET_PREFLIGHT_MISSING" not in codes
    assert "STAGE3_BUY_MARKET_PREFLIGHT_INVALID" not in codes
    assert (
        "STAGE3_BUY_MARKET_CONFLICT_CROSSED_WRITE_BOUNDARY"
        not in codes
    )
    assert "STAGE3_BUY_WALLET_LINEAGE_PREFLIGHT_INVALID" not in codes
    assert "STAGE3_BUY_CASH_PREFLIGHT_MISSING" not in codes
    assert "STAGE3_BUY_CASH_PREFLIGHT_INVALID" not in codes


def test_submitted_buy_audit_requires_singleton_cash_preflight():
    market_preflight = _buy_market_preflight()
    lineage, comparison = _valid_buy_wallet_lineage()
    bundle = _current_buy_audit_bundle(
        status="SUBMITTED",
        execution_metadata={
            "buy_market_exposure_preflight": market_preflight,
            "wallet_snapshot_lineage": lineage,
            "wallet_lineage_comparison": comparison,
        },
    )
    order = bundle["stage_3"]["order_intents"][0]
    order["market_id"] = "buy-market"
    order["first_submitted_at"] = "2026-07-27T00:01:00+00:00"
    order["attempts"] = [
        {
            "attempt_number": 1,
            "sanitized_request_json": {
                "_stage3_buy_market_exposure_preflight": (
                    market_preflight
                ),
            },
        }
    ]

    codes = {
        finding["code"] for finding in build_deterministic_findings(bundle)
    }

    assert "STAGE3_BUY_CASH_PREFLIGHT_MISSING" in codes


@pytest.mark.parametrize(
    "status",
    [
        "WAITING_FOR_EXIT",
        "DEFERRED",
        "FAILED_PERMANENT",
        "REJECTED",
        "CANCELLED",
    ],
)
def test_current_buy_audit_flags_leaked_active_reservation(status):
    bundle = _current_buy_audit_bundle(
        status=status,
        reserved_cash_usd=1.22,
        execution_metadata={
            "reservation_state": "active",
            **(
                {
                    "reconciliation_fill_evidence": {
                        "version": "v1",
                        "quantity_known": True,
                        "filled_shares": 0,
                        "definitive_zero_fill": True,
                    }
                }
                if status != "WAITING_FOR_EXIT"
                else {}
            ),
        },
        reservations=[
            {
                "status": "active",
                "amount_usd": 1.22,
            }
        ],
    )

    codes = {
        finding["code"] for finding in build_deterministic_findings(bundle)
    }

    assert "STAGE3_BUY_RESERVATION_NOT_RELEASED" in codes


def test_current_buy_audit_rejects_consumed_reservation_before_success():
    bundle = _current_buy_audit_bundle(
        status="CONFIRMING",
        execution_metadata={"reservation_state": "consumed"},
        reservations=[
            {
                "status": "consumed",
                "amount_usd": 1.22,
            }
        ],
    )

    codes = {
        finding["code"] for finding in build_deterministic_findings(bundle)
    }

    assert "STAGE3_RESERVATION_CONSUMED_WITHOUT_SUCCESS" in codes


def test_current_buy_audit_keeps_unknown_fill_reservation_fenced():
    bundle = _current_buy_audit_bundle(
        status="CANCELLED",
        reserved_cash_usd=1.22,
        execution_metadata={
            "reservation_state": "active",
            "reconciliation_fill_evidence": {
                "version": "v1",
                "quantity_known": False,
                "filled_shares": None,
                "definitive_zero_fill": False,
            },
        },
        reservations=[
            {
                "status": "active",
                "amount_usd": 1.22,
            }
        ],
    )
    order = bundle["stage_3"]["order_intents"][0]
    order["remote_order_id"] = "remote-cancelled-unknown-fill"
    order["first_submitted_at"] = "2026-07-27T00:01:00+00:00"

    codes = {
        finding["code"] for finding in build_deterministic_findings(bundle)
    }

    assert "STAGE3_BUY_RESERVATION_NOT_RELEASED" not in codes


def test_current_intent_audits_ambiguous_write_boundary_mirror():
    recorded_at = "2026-07-27T00:01:00+00:00"
    boundary = {
        "recorded_at": recorded_at,
        "attempt_number": 1,
        "provider_alias": "rpc-1",
        "ambiguous_submission": True,
        "automatic_resubmission": False,
    }
    bundle = _current_buy_audit_bundle(
        status="CONFIRMING",
        execution_metadata={
            "automatic_resubmission": False,
            "uncertain_remote_write_boundary": boundary,
        },
    )
    order = bundle["stage_3"]["order_intents"][0]
    order["first_submitted_at"] = recorded_at
    order["last_submitted_at"] = recorded_at
    order["attempts"] = [
        {
            "attempt_number": 1,
            "reconciliation_json": {
                "uncertain_remote_write_boundary": boundary,
            },
        }
    ]

    valid_codes = {
        finding["code"] for finding in build_deterministic_findings(bundle)
    }
    assert (
        "STAGE3_AMBIGUOUS_WRITE_BOUNDARY_EVIDENCE_INVALID"
        not in valid_codes
    )

    order["attempts"][0]["reconciliation_json"] = {}
    invalid_codes = {
        finding["code"] for finding in build_deterministic_findings(bundle)
    }
    assert (
        "STAGE3_AMBIGUOUS_WRITE_BOUNDARY_EVIDENCE_INVALID"
        in invalid_codes
    )


def test_terminal_buy_audit_requires_lineage_fenced_portfolio_refresh():
    bundle = _current_buy_audit_bundle(
        status="FILLED",
        execution_metadata={"reservation_state": "consumed"},
    )
    order = bundle["stage_3"]["order_intents"][0]
    order["remote_order_id"] = "remote-filled-buy"
    order["first_submitted_at"] = "2026-07-27T00:01:00+00:00"

    missing_codes = {
        finding["code"] for finding in build_deterministic_findings(bundle)
    }
    assert "STAGE3_TERMINAL_BUY_PORTFOLIO_REFRESH_MISSING" in missing_codes

    order["execution_metadata_json"][
        "post_buy_terminal_wallet_refresh"
    ] = {
        "source": "live-cli",
        "fetched_at": "2026-07-27T00:01:02+00:00",
        "lineage_comparison": {"status": "match"},
        "lineage_checks": {
            "stage1": {"status": "match"},
            "preflight": {"status": "match"},
        },
    }
    valid_codes = {
        finding["code"] for finding in build_deterministic_findings(bundle)
    }
    assert (
        "STAGE3_TERMINAL_BUY_PORTFOLIO_REFRESH_MISSING"
        not in valid_codes
    )


def test_aged_ambiguous_buy_audit_requires_terminal_operator_fence():
    block = {
        "version": "v1",
        "blocked_at": "2026-07-27T00:16:00+00:00",
        "age_seconds": 900,
        "max_age_seconds": 900,
        "last_error_code": "AMBIGUOUS_SUBMISSION",
        "automatic_resubmission": False,
        "support_verification_required": True,
    }
    bundle = _current_buy_audit_bundle(
        status="TIMED_OUT",
        execution_metadata={
            "automatic_resubmission": False,
            "buy_reconciliation_operator_block": block,
        },
    )
    order = bundle["stage_3"]["order_intents"][0]
    order.update(
        {
            "retryable": False,
            "next_attempt_at": None,
            "last_error_code": "AMBIGUOUS_SUBMISSION",
            "last_error_message": (
                "BUY_RECONCILIATION_OPERATOR_BLOCKED: support verification "
                "is required."
            ),
            "remote_order_id": "remote-ambiguous-buy",
        }
    )

    valid_codes = {
        finding["code"] for finding in build_deterministic_findings(bundle)
    }
    assert "STAGE3_BUY_OPERATOR_BLOCK_INVALID" not in valid_codes

    block["automatic_resubmission"] = True
    invalid_codes = {
        finding["code"] for finding in build_deterministic_findings(bundle)
    }
    assert "STAGE3_BUY_OPERATOR_BLOCK_INVALID" in invalid_codes


def test_current_dependent_buy_requires_confirmed_exit_and_fresh_sizing():
    bundle = _current_buy_audit_bundle(
        status="SUBMITTING",
        dependency_group="replace-exit-market",
        execution_metadata={"reservation_state": "active"},
        reserved_cash_usd=1.22,
    )

    codes = {
        finding["code"] for finding in build_deterministic_findings(bundle)
    }

    assert "STAGE3_DEPENDENT_BUY_EXIT_PROOF_MISSING" in codes
    assert (
        "STAGE3_DEPENDENT_BUY_POST_EXIT_SIZING_PROOF_INVALID"
        in codes
    )


def test_current_replacement_buy_requires_matching_exit_dependency_group():
    dependency_group = "stage3-replacement:run-1:exit-market"
    bundle = _current_buy_audit_bundle(
        status="WAITING_FOR_EXIT",
        dependency_group=dependency_group,
    )
    bundle["stage_3"]["order_intents"].append(
        {
            "id": "exit-intent-1",
            "action": "sell",
            "status": "READY",
            "idempotency_key": "auto-live:v2:exit-intent-1",
            "market_id": "exit-market",
            "dependency_group": None,
            "execution_metadata_json": {},
            "dependency_metadata_json": {},
            "attempts": [],
        }
    )

    missing_codes = {
        finding["code"] for finding in build_deterministic_findings(bundle)
    }
    assert "STAGE3_REPLACEMENT_EXIT_DEPENDENCY_MISSING" in missing_codes

    bundle["stage_3"]["order_intents"][1][
        "dependency_group"
    ] = dependency_group
    matched_codes = {
        finding["code"] for finding in build_deterministic_findings(bundle)
    }
    assert "STAGE3_REPLACEMENT_EXIT_DEPENDENCY_MISSING" not in matched_codes


def test_pre_exit_immediate_buy_count_must_match_affordable_free_slots():
    bundle = _immediate_sell_bundle(
        None,
        order_status="READY",
        durable_attempts=[],
    )
    bundle["stage_3"]["stage3_slot_diagnostics"] = {
        "initial_free_slots_before_exit": 1,
        "pre_exit_immediate_buy_count": 2,
        "pre_exit_free_slot_allocation": {
            "affordable_buy_count": 1,
        },
    }

    invalid_codes = {
        finding["code"] for finding in build_deterministic_findings(bundle)
    }
    assert "STAGE3_PRE_EXIT_FREE_SLOT_ALLOCATION_INVALID" in invalid_codes

    bundle["stage_3"]["stage3_slot_diagnostics"][
        "pre_exit_immediate_buy_count"
    ] = 1
    valid_codes = {
        finding["code"] for finding in build_deterministic_findings(bundle)
    }
    assert "STAGE3_PRE_EXIT_FREE_SLOT_ALLOCATION_INVALID" not in valid_codes


def test_current_dependent_buy_accepts_fresh_post_exit_sizing_proof():
    bundle = _current_buy_audit_bundle(
        status="SUBMITTING",
        dependency_group="replace-exit-market",
        dependency_metadata={
            "exit_confirmed_at": "2026-07-27T00:01:00+00:00",
        },
        execution_metadata={
            "reservation_state": "active",
            "post_exit_sizing": {
                "version": "v1",
                "source": "forced_fresh_post_exit_balance",
                "applied_at": "2026-07-27T00:01:03+00:00",
                "order_usd": 1.22,
            },
            "wallet_snapshot_lineage": {
                "source": "redis-cache",
                "freshness_state": "fresh",
                "fetched_at": "2026-07-27T00:01:02+00:00",
            },
        },
        reserved_cash_usd=1.22,
    )

    codes = {
        finding["code"] for finding in build_deterministic_findings(bundle)
    }

    assert "STAGE3_DEPENDENT_BUY_EXIT_PROOF_MISSING" not in codes
    assert (
        "STAGE3_DEPENDENT_BUY_POST_EXIT_SIZING_PROOF_INVALID"
        not in codes
    )


def test_reservation_and_dependent_sizing_rules_ignore_legacy_intent_format():
    bundle = _current_buy_audit_bundle(
        status="SUBMITTING",
        dependency_group="replace-exit-market",
        execution_metadata={"reservation_state": "consumed"},
        reserved_cash_usd=1.22,
    )
    order = bundle["stage_3"]["order_intents"][0]
    order["idempotency_key"] = "legacy-buy-intent"

    codes = {
        finding["code"] for finding in build_deterministic_findings(bundle)
    }

    assert "STAGE3_RESERVATION_CONSUMED_WITHOUT_SUCCESS" not in codes
    assert "STAGE3_DEPENDENT_BUY_EXIT_PROOF_MISSING" not in codes
    assert "STAGE3_REPLACEMENT_EXIT_DEPENDENCY_MISSING" not in codes
    assert (
        "STAGE3_DEPENDENT_BUY_POST_EXIT_SIZING_PROOF_INVALID"
        not in codes
    )


@pytest.mark.parametrize(
    "classification",
    [
        "closed",
        "settlement_pending",
        "stale_or_unknown",
        "resolved_zero_payout",
        "positive_payout_claimable",
    ],
)
def test_sell_live_preflight_requires_current_active_classification(
    classification,
):
    bundle = _immediate_sell_bundle(
        None,
        order_status="SUBMITTED",
    )
    order = bundle["stage_3"]["order_intents"][0]
    order["execution_metadata_json"] = {
        "sell_live_preflight": {
            "version": "v1",
            "source": "live-cli",
            "freshness_state": "fresh",
            "position_classifier_version": 3,
            "classification": classification,
            "sellable": True,
            "verified_shares": 4.0,
            "submitted_shares": 4.0,
        }
    }

    codes = {
        finding["code"] for finding in build_deterministic_findings(bundle)
    }

    assert "STAGE3_SELL_LIVE_PREFLIGHT_INVALID" in codes


def test_attempted_current_sell_requires_preflight_even_with_remote_reference():
    bundle = _immediate_sell_bundle(
        None,
        order_status="SUBMITTED",
        durable_attempts=[],
    )
    order = bundle["stage_3"]["order_intents"][0]
    order["remote_order_id"] = "remote-without-proof"

    codes = {
        finding["code"] for finding in build_deterministic_findings(bundle)
    }

    assert "STAGE3_SELL_LIVE_PREFLIGHT_MISSING" in codes


@pytest.mark.parametrize(
    "error_code",
    [
        "SELL_REQUIRES_REDEEM",
        "NO_SELLABLE_EXPOSURE",
        "POSITION_LINEAGE_MISMATCH",
    ],
)
def test_failed_sell_preflight_does_not_claim_remote_write_without_evidence(
    error_code,
):
    bundle = _immediate_sell_bundle(
        None,
        order_status="FAILED_PERMANENT",
        durable_attempts=[
            {
                "attempt_number": 1,
                "result_status": "FAILED_PERMANENT",
                "error_code": error_code,
                "sanitized_request_json": {},
                "sanitized_response_json": {},
            }
        ],
    )

    codes = {
        finding["code"] for finding in build_deterministic_findings(bundle)
    }

    assert "STAGE3_SELL_LIVE_PREFLIGHT_MISSING" not in codes


def test_sell_preflight_accepts_fresh_lineage_fenced_redis_snapshot():
    bundle = _immediate_sell_bundle(
        None,
        order_status="SUBMITTED",
    )
    order = bundle["stage_3"]["order_intents"][0]
    order["execution_metadata_json"] = {
        "sell_live_preflight": {
            "version": "v1",
            "source": "redis-cache",
            "freshness_state": "fresh",
            "position_classifier_version": (
                BULLPEN_POSITION_CLASSIFIER_VERSION
            ),
            "classification": "active",
            "sellable": True,
            "verified_shares": 4.0,
            "submitted_shares": 4.0,
        }
    }

    codes = {
        finding["code"] for finding in build_deterministic_findings(bundle)
    }

    assert "STAGE3_SELL_LIVE_PREFLIGHT_INVALID" not in codes
    assert "STAGE3_SELL_LIVE_PREFLIGHT_MISSING" not in codes


def test_attempted_current_redeem_requires_wallet_lineage_preflight():
    bundle = _immediate_sell_bundle(
        None,
        order_status="SUBMITTED",
        durable_attempts=[],
    )
    order = bundle["stage_3"]["order_intents"][0]
    order["action"] = "redeem"

    codes = {
        finding["code"] for finding in build_deterministic_findings(bundle)
    }

    assert "STAGE3_REDEEM_LINEAGE_PREFLIGHT_MISSING" in codes


def test_redeem_preflight_accepts_fresh_matching_stage1_lineage():
    bundle = _immediate_sell_bundle(
        None,
        order_status="SUBMITTED",
        durable_attempts=[],
    )
    order = bundle["stage_3"]["order_intents"][0]
    order["action"] = "redeem"
    order["execution_metadata_json"] = {
        "wallet_snapshot_lineage": {
            "source": "redis-cache",
            "fetched_at": "2026-07-27T00:01:00+00:00",
            "freshness_state": "fresh",
            "account_identity": "wallet-a",
            "credential_artifact": {
                "inode": 11,
                "mtime_ns": 22,
                "size": 33,
            },
            "position_classifier_version": (
                BULLPEN_POSITION_CLASSIFIER_VERSION
            ),
        },
        "wallet_lineage_comparison": {
            "status": "match",
            "compared_fields": [
                "account_identity",
                "position_classifier_version",
                "credential_artifact.inode",
                "credential_artifact.mtime_ns",
                "credential_artifact.size",
                "fetched_at_not_older",
            ],
            "mismatches": [],
        },
    }

    codes = {
        finding["code"] for finding in build_deterministic_findings(bundle)
    }

    assert "STAGE3_REDEEM_LINEAGE_PREFLIGHT_MISSING" not in codes
    assert "STAGE3_REDEEM_LINEAGE_PREFLIGHT_INVALID" not in codes


def test_redeem_preflight_rejects_mismatched_or_incomplete_lineage_proof():
    bundle = _immediate_sell_bundle(
        None,
        order_status="SUBMITTED",
        durable_attempts=[],
    )
    order = bundle["stage_3"]["order_intents"][0]
    order["action"] = "redeem"
    order["execution_metadata_json"] = {
        "wallet_snapshot_lineage": {
            "source": "live-cli",
            "fetched_at": "2026-07-27T00:01:00+00:00",
            "freshness_state": "fresh",
            "account_identity": "wallet-b",
            "credential_artifact": {
                "inode": 11,
                "mtime_ns": 22,
                "size": 33,
            },
            "position_classifier_version": 3,
        },
        "wallet_lineage_comparison": {
            "status": "mismatch",
            "compared_fields": [
                "account_identity",
                "position_classifier_version",
            ],
            "mismatches": ["account_identity"],
        },
    }

    codes = {
        finding["code"] for finding in build_deterministic_findings(bundle)
    }

    assert "STAGE3_REDEEM_LINEAGE_PREFLIGHT_INVALID" in codes


def test_failed_redeem_lineage_preflight_does_not_claim_remote_write():
    bundle = _immediate_sell_bundle(
        None,
        order_status="FAILED_PERMANENT",
        durable_attempts=[
            {
                "attempt_number": 1,
                "result_status": "FAILED_PERMANENT",
                "error_code": "POSITION_LINEAGE_MISMATCH",
                "sanitized_request_json": {},
                "sanitized_response_json": {},
            }
        ],
    )
    order = bundle["stage_3"]["order_intents"][0]
    order["action"] = "redeem"

    codes = {
        finding["code"] for finding in build_deterministic_findings(bundle)
    }

    assert "STAGE3_REDEEM_LINEAGE_PREFLIGHT_MISSING" not in codes


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


def test_candidate_only_stage2_wallet_timeout_is_audited_without_stage3_handoff_failure():
    bundle = {
        "metadata": {"run_id": "run-wallet-handoff-timeout"},
        "overview": {
            "run_status": "partial_success",
            "started_at": "2026-07-21T00:00:00+00:00",
            "completed_at": "2026-07-21T00:01:00+00:00",
            "duration_seconds": 60,
            "code_provenance": {"backend_commit_sha": "abc123"},
            "missing_fields": [],
        },
        "stage_1": {
            "scan_context": {
                "stage2_candidate_only": True,
                "wallet_refresh_error": "Fresh Bullpen wallet refresh did not finish within 30 seconds.",
            }
        },
        "stage_2": {
            "candidate_only": True,
            "candidate_reviews": [
                {
                    "market_id": "candidate-1",
                    "source_kind": "candidate",
                    "qualified": True,
                    "llm_outputs": [
                        {"llm_yes_odds": 8, "llm_no_odds": 92}
                    ],
                }
            ],
            "stage3_handoff_candidate_market_ids": ["candidate-1"],
        },
        "stage_3": {
            "blocked_by_stage1_wallet_refresh": True,
            "decisions": [],
            "order_intents": [],
        },
        "raw": {},
    }

    codes = {
        finding["code"]
        for finding in build_deterministic_findings(bundle)
    }

    assert "STAGE1_WALLET_TIMEOUT_CANDIDATE_ONLY_REVIEW" in codes
    assert "QUALIFIED_STAGE2_CANDIDATE_MISSING_STAGE3_RESULT" not in codes
    assert "STAGE2_TOP10_HANDOFF_MISSING_STAGE3_DECISION" not in codes
    assert "STAGE1_WALLET_TIMEOUT_STAGE3_NOT_BLOCKED" not in codes
    assert "STAGE1_WALLET_TIMEOUT_EXECUTION_OCCURRED" not in codes


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


def test_build_bundle_projects_stage3_handoff_checkpoint_without_rewriting_legacy_shape():
    run_payload = {
        "id": "run-stage3-handoff-checkpoint",
        "status": "running",
        "triggered_by": "manual",
        "started_at": "2026-07-21T00:00:00+00:00",
        "completed_at": None,
        "summary": "Stage 3 received the saved handoff.",
        "stage_results": [
            {
                "stage_number": 6,
                "status": "pass",
                "reason": "Ranked Stage 2 candidates.",
                "outputs": {
                    "ranking_top_candidate_market_id_order": ["market-1"],
                },
            },
            {
                "stage_number": 3,
                "status": "pass",
                "reason": "Stage 3 received the saved handoff.",
                "outputs": {
                    "workflow_stage_key": "invest",
                    "phase_status": "running",
                    "decision_rows": [],
                    "stage2_handoff_checkpoint": {
                        "status": "received",
                        "candidate_market_ids": ["market-1"],
                        "candidate_count": 1,
                    },
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

    assert bundle["stage_3"]["handoff_checkpoint"] == {
        "status": "received",
        "candidate_market_ids": ["market-1"],
        "candidate_count": 1,
    }
    assert bundle["stage_3"]["stage2_handoff_candidate_market_ids"] == ["market-1"]


def test_algorithm_registry_contains_required_audit_keys():
    assert BULLPEN_RUN_AUDIT_SCHEMA_VERSION == 2
    assert (
        BULLPEN_RUN_AUDIT_ALGORITHM_REGISTRY_VERSION
        == "2026-07-27-stage3-stale-balance-buy-fence-v27"
    )
    assert (
        BULLPEN_RUN_AUDIT_RULE_VERSION
        == "2026-07-27-stage3-stale-balance-buy-fence-v27"
    )
    keys = {entry["algorithm_key"] for entry in AUDITED_ALGORITHM_REGISTRY}
    assert keys >= {
        "run_execution_handoff_fallback",
        "stage2_consensus_statistics",
        "candidate_returns_per_day",
        "stage1_wallet_handoff_circuit_breaker",
        "bullpen_position_claimability",
        "stage2_to_stage3_handoff_checkpoint",
        "console_trade_amount_per_opportunity",
        "stage3_live_capacity_sizing",
        "llm_returns_per_day",
        "position_returns_per_day",
        "stage3_rank_and_selection",
        "stage3_affordable_ranked_buy_allocation",
        "order_funnel_aggregation",
        "stage3_sell_live_exposure_preflight",
        "stage3_buy_market_exposure_preflight",
        "stage3_immediate_sell_fallback",
        "stage3_bullpen_response_normalization",
        "stage3_verified_remote_absence_retry",
        "stage3_reconciliation_generation_guard",
        "stage3_terminal_resume_preservation",
    }
    claimability = next(
        entry
        for entry in AUDITED_ALGORITHM_REGISTRY
        if entry["algorithm_key"] == "bullpen_position_claimability"
    )
    assert claimability["algorithm_version"] == "v4"
    dependency_handoff = next(
        entry
        for entry in AUDITED_ALGORITHM_REGISTRY
        if entry["algorithm_key"] == "stage3_dependency_exit_handoff"
    )
    assert dependency_handoff["algorithm_version"] == "v3"
    rank_and_selection = next(
        entry
        for entry in AUDITED_ALGORITHM_REGISTRY
        if entry["algorithm_key"] == "stage3_rank_and_selection"
    )
    assert rank_and_selection["algorithm_version"] == "v2"
    buy_market_preflight = next(
        entry
        for entry in AUDITED_ALGORITHM_REGISTRY
        if entry["algorithm_key"]
        == "stage3_buy_market_exposure_preflight"
    )
    assert buy_market_preflight["algorithm_version"] == "v2"
    deferred_replacement = next(
        entry
        for entry in AUDITED_ALGORITHM_REGISTRY
        if entry["algorithm_key"] == "stage3_deferred_replacement_sizing"
    )
    assert deferred_replacement["algorithm_version"] == "v2"
    active_reservation_filter = next(
        entry
        for entry in AUDITED_ALGORITHM_REGISTRY
        if entry["algorithm_key"] == "stage3_active_reservation_cash_filter"
    )
    assert active_reservation_filter["algorithm_version"] == "v2"
    assert BULLPEN_POSITION_CLASSIFIER_VERSION == 4


def test_stage3_rank_formula_provenance_matches_current_registry():
    records = _build_formula_records(
        snapshot_id=1,
        stage1_outputs={},
        candidate_reviews=[],
        decisions=[
            {
                "id": "decision-v2",
                "score": 91.5,
                "edge_pp": 12.0,
                "fair_probability_pct": 72.0,
                "price_cents": 60.0,
                "target_exposure_usd": 1.0,
                "stage3_final_rank": 1,
                "stage3_result": "SELECTED",
            }
        ],
        run_order_funnel={},
    )
    formula = next(
        record
        for record in records
        if record.algorithm_key == "stage3_rank_and_selection"
    )
    registry = next(
        entry
        for entry in AUDITED_ALGORITHM_REGISTRY
        if entry["algorithm_key"] == "stage3_rank_and_selection"
    )

    assert formula.algorithm_version == registry["algorithm_version"] == "v2"
    assert formula.source_module == registry["source_module"]
    assert formula.source_function == registry["source_function"]


def test_every_materialized_formula_provenance_matches_current_registry():
    records = _build_formula_records(
        snapshot_id=1,
        stage1_outputs={
            "active_positions_found": [],
            "console_trade_cash_in_hand_usd": 10.0,
            "console_trade_occupied_positions": 0,
            "console_trade_available_slots": 10,
            "console_trade_max_positions": 10,
            "console_trade_amount_usd": 1.0,
        },
        candidate_reviews=[
            {
                "market_id": "candidate-1",
                "source_kind": "new_opportunity",
                "returns_per_day": 2.5,
                "llm_outputs": [
                    {"llm_yes_odds": 60.0},
                    {"llm_yes_odds": 70.0},
                ],
            },
            {
                "market_id": "position-1",
                "source_kind": "active_position",
                "returns_per_day": 1.5,
                "llm_outputs": [],
            },
        ],
        decisions=[
            {
                "id": "decision-1",
                "score": 91.5,
                "edge_pp": 12.0,
                "fair_probability_pct": 72.0,
                "price_cents": 60.0,
                "target_exposure_usd": 1.0,
                "stage3_final_rank": 1,
                "stage3_result": "SELECTED",
            }
        ],
        run_order_funnel={
            "planned": 1,
            "submitted": 1,
            "confirmed": 1,
            "filled": 1,
            "permanently_failed": 0,
        },
        stage3_outputs={
            "post_exit_buy_refresh": {
                "cash_in_hand_usd": 9.0,
                "occupied_positions": 1,
                "max_positions": 10,
            },
            "stage3_slot_diagnostics": {
                "capacity_sizing_basis": (
                    "live-economic-plus-current-run-accepted-v2"
                )
            },
        },
    )
    registry_by_key = {
        entry["algorithm_key"]: entry
        for entry in AUDITED_ALGORITHM_REGISTRY
    }

    assert records
    for formula in records:
        registry = registry_by_key[formula.algorithm_key]
        assert formula.algorithm_version == registry["algorithm_version"]
        assert formula.source_module == registry["source_module"]
        assert formula.source_function == registry["source_function"]


def test_stage1_verified_portfolio_capture_and_formula_use_serialized_rows():
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
        "wallet_source": "live-cli",
        "wallet_snapshot_status": "fresh",
        "wallet_snapshot_fetched_at": "2026-07-20T13:20:03+00:00",
        "wallet_freshness_state": "fresh",
        "wallet_account_identity": "0xabc",
        "wallet_credential_artifact": {
            "path": "/Users/private/.config/bullpen/credentials.json.enc",
            "inode": 17,
            "mtime_ns": 123456,
            "size": 999,
        },
        "position_classifier_version": 3,
        "wallet_snapshot_diagnostics": {
            "caller_source": "auto-live-stage1",
            "produced_by_another_refresh": False,
            "effective_home": "/Users/private",
            "unix_user": "private-user",
            "credential_artifact": {
                "path": "/Users/private/.config/bullpen/credentials.json.enc",
            },
        },
        "active_positions_found": active_positions,
        "available_for_claim": [{"market_id": "claimable-1"}],
        "settlement_pending_positions": [],
        "excluded_position_diagnostics": [{"market_id": "excluded-1"}],
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
                "completed_at": "2026-07-20T13:20:10+00:00",
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
    assert verified["source"] == "live-cli"
    assert verified["fetched_at"] == "2026-07-20T13:20:03+00:00"
    assert verified["account_identity"] == "0xabc"
    assert verified["position_classifier_version"] == 3
    assert verified["credential_artifact"]["inode"] == 17
    assert verified["available_for_claim"] == [{"market_id": "claimable-1"}]
    assert verified["excluded_position_diagnostics"] == [
        {"market_id": "excluded-1"}
    ]
    frozen_verified = json.dumps(verified)
    assert '"path"' not in frozen_verified
    assert "effective_home" not in frozen_verified
    assert "unix_user" not in frozen_verified
    assert "/Users/private" not in frozen_verified
    sanitized_bundle = sanitize_audit_evidence(bundle)
    sanitized_verified = sanitized_bundle["stage_1"][
        "verified_portfolio_snapshot"
    ]
    assert sanitized_verified["credential_artifact"] == {
        "inode": 17,
        "mtime_ns": 123456,
        "size": 999,
    }

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


@pytest.mark.parametrize(
    (
        "wallet_snapshot_status",
        "wallet_snapshot_freshness_state",
        "wallet_refresh_error",
        "stage2_candidate_only",
        "blocked_by_stage1_wallet_refresh",
        "expected_verified",
    ),
    [
        ("fresh", "fresh", None, False, False, True),
        ("fresh", None, None, False, False, False),
        ("cached", "fresh", None, False, False, False),
        ("stale", "fresh", None, False, False, False),
        ("degraded", "fresh", None, False, False, False),
        ("fresh", "cached", None, False, False, False),
        ("fresh", "stale", None, False, False, False),
        ("fresh", "degraded", None, False, False, False),
        (
            "unavailable",
            "fresh",
            "wallet refresh timed out",
            True,
            False,
            False,
        ),
        ("fresh", "fresh", None, True, False, False),
        ("fresh", "fresh", None, False, True, False),
    ],
)
def test_stage1_empty_portfolio_requires_a_verified_wallet_snapshot(
    wallet_snapshot_status,
    wallet_snapshot_freshness_state,
    wallet_refresh_error,
    stage2_candidate_only,
    blocked_by_stage1_wallet_refresh,
    expected_verified,
):
    run_payload = {
        "id": "run-empty-portfolio",
        "status": "completed",
        "triggered_by": "scheduled",
        "started_at": "2026-07-27T00:00:00+00:00",
        "completed_at": "2026-07-27T00:01:00+00:00",
        "summary": "Stage 1 completed.",
        "stage_results": [
            {
                "stage_number": 1,
                "status": "pass" if expected_verified else "warning",
                "reason": "Stage 1 completed.",
                "completed_at": "2026-07-27T00:00:30+00:00",
                "outputs": {
                    "workflow_stage_key": "scan",
                    "phase_status": "completed",
                    "active_positions_found": [],
                    "wallet_snapshot_status": wallet_snapshot_status,
                    "wallet_snapshot_freshness_state": (
                        wallet_snapshot_freshness_state
                    ),
                    "wallet_refresh_error": wallet_refresh_error,
                    "stage2_candidate_only": stage2_candidate_only,
                    "blocked_by_stage1_wallet_refresh": (
                        blocked_by_stage1_wallet_refresh
                    ),
                },
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

    assert verified["active_position_count"] == 0
    assert verified["verified"] is expected_verified
    if not expected_verified:
        assert "not proof of an empty portfolio" in verified[
            "verification_reason"
        ]


@pytest.mark.parametrize(
    (
        "stage_status",
        "phase_status",
        "stage_completed_at",
        "hard_block",
        "wallet_refresh_error",
        "wallet_market_enrichment_error",
        "expected_verified",
    ),
    [
        (
            "pass",
            "completed",
            "2026-07-27T00:00:30+00:00",
            False,
            None,
            None,
            True,
        ),
        (
            "warning",
            "completed",
            "2026-07-27T00:00:30+00:00",
            False,
            None,
            None,
            True,
        ),
        (
            "warning",
            "partial",
            "2026-07-27T00:00:30+00:00",
            False,
            None,
            None,
            True,
        ),
        (
            "pass",
            None,
            "2026-07-27T00:00:30+00:00",
            False,
            None,
            None,
            True,
        ),
        (
            "fail",
            "completed",
            "2026-07-27T00:00:30+00:00",
            False,
            None,
            None,
            False,
        ),
        (
            "pass",
            "running",
            "2026-07-27T00:00:30+00:00",
            False,
            None,
            None,
            False,
        ),
        (
            "warning",
            "failed",
            "2026-07-27T00:00:30+00:00",
            False,
            None,
            None,
            False,
        ),
        ("pass", "completed", None, False, None, None, False),
        (
            "pass",
            "completed",
            "2026-07-27T00:00:30+00:00",
            True,
            None,
            None,
            False,
        ),
        (
            "pass",
            "completed",
            "2026-07-27T00:00:30+00:00",
            False,
            "wallet refresh failed",
            None,
            False,
        ),
        (
            "pass",
            "completed",
            "2026-07-27T00:00:30+00:00",
            False,
            None,
            "wallet enrichment failed",
            False,
        ),
    ],
)
def test_stage1_portfolio_verification_requires_terminal_usable_lifecycle(
    stage_status,
    phase_status,
    stage_completed_at,
    hard_block,
    wallet_refresh_error,
    wallet_market_enrichment_error,
    expected_verified,
):
    bundle = _build_bundle(
        run_payload={
            "id": "run-stage1-lifecycle",
            "status": "completed",
            "triggered_by": "scheduled",
            "started_at": "2026-07-27T00:00:00+00:00",
            "completed_at": "2026-07-27T00:01:00+00:00",
            "summary": "Stage 1 lifecycle adversarial test.",
            "stage_results": [
                {
                    "stage_number": 1,
                    "status": stage_status,
                    "hard_block": hard_block,
                    "started_at": "2026-07-27T00:00:01+00:00",
                    "completed_at": stage_completed_at,
                    "outputs": {
                        "workflow_stage_key": "scan",
                        "phase_status": phase_status,
                        "active_positions_found": [],
                        "wallet_snapshot_status": "fresh",
                        "wallet_snapshot_freshness_state": "fresh",
                        "wallet_refresh_error": wallet_refresh_error,
                        "wallet_market_enrichment_error": (
                            wallet_market_enrichment_error
                        ),
                        "stage2_candidate_only": False,
                        "blocked_by_stage1_wallet_refresh": False,
                    },
                }
            ],
            "audit_metadata": {
                "code_provenance": {"backend_commit_sha": "abc123"},
                "settings_snapshot": {},
            },
            "diagnostics": {},
        },
        decisions=[],
        run_orders_payload={},
        source_kind="native",
        lifecycle_status="frozen",
    )

    verified = bundle["stage_1"]["verified_portfolio_snapshot"]
    lifecycle = verified["canonical_stage_lifecycle"]

    assert verified["verified"] is expected_verified
    assert verified["stage_status"] == stage_status
    assert verified["phase_status"] == phase_status
    assert verified["stage_completed_at"] == stage_completed_at
    assert lifecycle == {
        "status": stage_status,
        "phase_status": phase_status,
        "started_at": "2026-07-27T00:00:01+00:00",
        "completed_at": stage_completed_at,
        "hard_block": hard_block,
        "completion_evidence": stage_completed_at is not None,
    }
    if not expected_verified:
        assert "not proof of an empty portfolio" in verified[
            "verification_reason"
        ]


def test_stage1_verified_lifecycle_claim_is_defensively_validated():
    bundle = _build_bundle(
        run_payload={
            "id": "run-working-stage1-claim",
            "status": "running",
            "triggered_by": "scheduled",
            "started_at": "2026-07-27T00:00:00+00:00",
            "stage_results": [
                {
                    "stage_number": 1,
                    "status": "pass",
                    "started_at": "2026-07-27T00:00:01+00:00",
                    "completed_at": "2026-07-27T00:00:30+00:00",
                    "outputs": {
                        "workflow_stage_key": "scan",
                        "phase_status": "running",
                        "active_positions_found": [],
                        "wallet_snapshot_status": "fresh",
                        "wallet_snapshot_freshness_state": "fresh",
                        "stage2_candidate_only": False,
                        "blocked_by_stage1_wallet_refresh": False,
                    },
                }
            ],
            "audit_metadata": {
                "code_provenance": {"backend_commit_sha": "abc123"},
                "settings_snapshot": {},
            },
            "diagnostics": {},
        },
        decisions=[],
        run_orders_payload={},
        source_kind="native",
        lifecycle_status="working",
    )
    bundle["stage_1"]["verified_portfolio_snapshot"]["verified"] = True

    codes = {
        finding["code"] for finding in build_deterministic_findings(bundle)
    }

    assert "STAGE1_VERIFIED_PORTFOLIO_LIFECYCLE_INVALID" in codes


def test_stage1_missing_portfolio_rows_are_unavailable_not_unverified_empty():
    bundle = _build_bundle(
        run_payload={
            "id": "run-no-wallet-rows",
            "status": "completed",
            "triggered_by": "scheduled",
            "started_at": "2026-07-27T00:00:00+00:00",
            "completed_at": "2026-07-27T00:01:00+00:00",
            "summary": "Stage 1 did not capture wallet rows.",
            "stage_results": [
                {
                    "stage_number": 1,
                    "status": "warning",
                    "outputs": {
                        "workflow_stage_key": "scan",
                        "wallet_snapshot_status": "unavailable",
                    },
                }
            ],
            "audit_metadata": {
                "code_provenance": {"backend_commit_sha": "abc123"},
                "settings_snapshot": {},
            },
            "diagnostics": {},
        },
        decisions=[],
        run_orders_payload={},
        source_kind="native",
        lifecycle_status="frozen",
    )

    assert bundle["stage_1"]["verified_portfolio_snapshot"] is None


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
                "verified": True,
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


def test_stage1_degraded_portfolio_skips_verified_formula_findings():
    bundle = {
        "metadata": {"run_id": "run-degraded-portfolio"},
        "overview": {
            "started_at": "2026-07-20T13:20:00+00:00",
            "completed_at": "2026-07-20T13:25:00+00:00",
            "duration_seconds": 300,
            "code_provenance": {"backend_commit_sha": "abc123"},
            "missing_fields": [],
        },
        "stage_1": {
            "verified_portfolio_snapshot": {
                "verified": False,
                "verification_reason": "Wallet refresh was degraded.",
                "active_positions_found": [],
                "recorded_occupied_positions": 7,
                "cash_in_hand_usd": 1.85,
                "available_slots": 3,
                "max_positions": 10,
                "trade_amount_usd": 0.62,
            }
        },
        "stage_2": {"candidate_reviews": []},
        "stage_3": {"decisions": [], "order_intents": []},
        "raw": {},
    }

    codes = {
        finding["code"] for finding in build_deterministic_findings(bundle)
    }

    assert "STAGE1_VERIFIED_POSITION_COUNT_MISMATCH" not in codes
    assert "STAGE1_VERIFIED_AVAILABLE_SLOTS_MISMATCH" not in codes
    assert "STAGE1_VERIFIED_TRADE_AMOUNT_MISMATCH" not in codes


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
