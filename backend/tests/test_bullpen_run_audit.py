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


def test_algorithm_registry_contains_required_audit_keys():
    keys = {entry["algorithm_key"] for entry in AUDITED_ALGORITHM_REGISTRY}
    assert keys >= {
        "stage2_consensus_statistics",
        "candidate_returns_per_day",
        "position_returns_per_day",
        "stage3_rank_and_selection",
        "order_funnel_aggregation",
    }


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
