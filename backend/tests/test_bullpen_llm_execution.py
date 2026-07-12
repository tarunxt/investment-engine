from __future__ import annotations

import json

from app.domains.ai_providers.base import AIProviderResponse
from app.domains.polymarket.bullpen_llm_execution import execute_bullpen_llm_target
from app.domains.runs.schemas import (
    BullpenLlmExecutionOptions,
    PolymarketEventQuestionPayload,
    PolymarketEventRunContext,
    PolymarketEventEvidenceOptions,
)


def _question(index: int) -> PolymarketEventQuestionPayload:
    return PolymarketEventQuestionPayload(
        question_ref=f"Q{index}",
        question_id=f"question-{index}",
        market_id=f"market-{index}",
        question=f"Will event {index} happen?",
        current_time_utc="2026-07-12T00:00:00+00:00",
        current_time_et="2026-07-11 20:00 ET",
        category="test",
        outcomes=["Yes", "No"],
        polymarket_rules="Resolve YES if the event happens.",
    )


def test_oversized_single_combined_auto_falls_back_to_chunked_parallel(monkeypatch):
    calls: list[str] = []

    def fake_execute_provider_batch_call(*, provider_name: str, model_name: str, prompt: str):
        calls.append(prompt)
        payload = json.loads(prompt.split("Selected questions:\n", 1)[1])
        markets = []
        for item in payload:
            markets.append(
                {
                    "question_ref": item["question_ref"],
                    "question_id": item["question_id"],
                    "market_id": item["market_id"],
                    "question": item["question"],
                    "llm_yes_odds": 55,
                    "llm_no_odds": 45,
                    "yes_definition": "The event happens.",
                    "deadline_et": None,
                    "hours_remaining": None,
                    "evidence_status": "current",
                    "event_state": "open",
                    "confidence": "medium",
                    "key_evidence": ["test evidence"],
                    "red_flags": [],
                    "rationale": "Test rationale.",
                }
            )
        return type(
            "BatchCall",
            (),
            {
                "provider": provider_name,
                "model": model_name,
                "response": AIProviderResponse(
                    content=json.dumps({"markets": markets}),
                    tokens_in=10,
                    tokens_out=20,
                    cost=0.01,
                    provider=provider_name,
                    model=model_name,
                ),
                "attempts": 1,
                "retry_count": 0,
                "elapsed_seconds": 0.01,
                "error": None,
            },
        )()

    monkeypatch.setattr(
        "app.domains.polymarket.bullpen_llm_execution.prompt_budget_chars_for_provider",
        lambda provider_name: 1_000,
    )
    monkeypatch.setattr(
        "app.domains.polymarket.bullpen_llm_execution.execute_provider_batch_call",
        fake_execute_provider_batch_call,
    )

    context = PolymarketEventRunContext(
        prompt_template="Selected questions:\n{{SELECTED_QUESTIONS}}",
        question_payload=[_question(index) for index in range(3)],
        evidence_options=PolymarketEventEvidenceOptions(require_fresh_internet_evidence=False),
        execution_options=BullpenLlmExecutionOptions(
            execution_mode="single_combined",
            events_per_prompt=1,
            max_concurrent_requests=2,
            target_count=1,
        ),
    )

    result = execute_bullpen_llm_target(
        context,
        provider_name="gemini",
        model_name="gemini-test",
    )

    assert result.status == "completed"
    assert len(calls) == 3
    assert result.primary_request_count == 3
    assert result.blocked_event_count == 0
    assert result.runtime_metadata["llm_execution_mode"] == "chunked_parallel"
    assert "automatically switched to Batched parallel" in result.runtime_metadata[
        "llm_execution_mode_reason"
    ]
