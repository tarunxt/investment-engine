import json
import os
import unittest
from unittest.mock import patch

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

from app.domains.polymarket.event_preflight import (
    GammaMarketLookupResult,
    _fetch_gamma_market,
    build_polymarket_event_prompt_and_metadata,
    finalize_polymarket_event_runtime_metadata,
    prepare_polymarket_event_context,
)
from app.domains.runs.schemas import PolymarketEventRunContext


def _sample_context(*, require_fresh: bool = True) -> PolymarketEventRunContext:
    return PolymarketEventRunContext.model_validate(
        {
            "kind": "polymarket_bullpen_event",
            "prompt_template": "Analyze these markets.\n\nSelected questions:\n{{SELECTED_QUESTIONS}}",
            "question_payload": [
                {
                    "question_ref": "Q1",
                    "question_id": "12345",
                    "question": "Will Acme go public by December 31, 2026?",
                    "close_time": "2026-12-31T23:59:59Z",
                    "closing_time": "2026-12-31T23:59:59Z",
                    "close_time_et": "2026-12-31 06:59:59 PM ET",
                    "current_time_utc": "2026-06-23T00:00:00Z",
                    "current_time_et": "2026-06-22 08:00:00 PM ET",
                    "deadline_et": "2026-12-31 11:59:59 PM ET",
                    "hours_remaining": 100.5,
                    "deadline_source": "market title",
                    "title_date_hint": "December 31, 2026",
                    "title_deadline_et_assumption": "11:59 PM ET",
                    "category": "Business",
                    "outcomes": ["Yes", "No"],
                    "current_yes_odds": 25,
                    "current_no_odds": 75,
                    "market_url": "https://polymarket.com/event/acme-ipo",
                    "slug": "acme-ipo",
                    "polymarket_rules": "Resolves YES if Acme starts trading on Nasdaq by Dec 31, 2026.",
                    "polymarket_market_context": "Not supplied",
                    "polymarket_resolution_source": "Nasdaq IPO calendar",
                    "preflight_evidence_block": "Preflight Evidence Block:\n- Not supplied",
                }
            ],
            "evidence_options": {
                "require_fresh_internet_evidence": require_fresh,
                "allow_evidence_grounded_non_web_models": False,
            },
        }
    )


class PolymarketEventPreflightTests(unittest.TestCase):
    @patch("app.domains.polymarket.event_preflight.web_search_tool.execute")
    @patch("app.domains.polymarket.event_preflight._fetch_event_market_context")
    @patch("app.domains.polymarket.event_preflight._fetch_gamma_market")
    def test_build_prompt_rebuilds_verified_stage2_context_without_force_token(
        self,
        fetch_gamma_market_mock,
        fetch_event_market_context_mock,
        web_search_execute_mock,
    ):
        fetch_gamma_market_mock.return_value = GammaMarketLookupResult(
            record={
                "id": "12345",
                "slug": "acme-ipo",
                "eventSlug": "acme-ipo",
                "question": "Will Acme go public by December 31, 2026?",
                "description": "Resolves YES if Acme starts trading on Nasdaq by Dec 31, 2026.",
                "resolutionSource": "Nasdaq IPO calendar",
                "outcomes": json.dumps(["Yes", "No"]),
                "outcomePrices": json.dumps([0.35, 0.65]),
            },
            matched_gamma_market_id="12345",
            match_method="market_id",
            exact_match_verified=True,
        )
        fetch_event_market_context_mock.return_value = (
            "Experimental AI-generated summary referencing Polymarket data.\n"
            "Acme confirmed an IPO filing and is targeting a Nasdaq listing."
        )
        web_search_execute_mock.return_value = json.dumps(
            {
                "query": "Will Acme go public by December 31, 2026?",
                "results": [
                    {
                        "title": "Nasdaq IPO Watch",
                        "url": "https://www.nasdaq.com/acme-ipo",
                        "content": "Acme is preparing for a Nasdaq IPO.",
                        "published_date": "2026-06-22",
                    }
                ],
            }
        )

        prompt, runtime_metadata = build_polymarket_event_prompt_and_metadata(
            _sample_context(),
            provider_name="openai",
        )

        self.assertFalse(prompt.startswith("[ENABLE_WEB_SEARCH]\n"))
        self.assertIn("stage2_context", prompt)
        self.assertIn("[STAGE2_SHARED_EVIDENCE_ONLY]", prompt)
        self.assertEqual(runtime_metadata["web_search_used"], True)
        self.assertIn(
            "https://www.nasdaq.com/acme-ipo",
            runtime_metadata["web_sources"],
        )
        self.assertEqual(
            runtime_metadata["question_runtime"]["12345"]["evidence_block_used"],
            True,
        )
        self.assertEqual(
            runtime_metadata["question_runtime"]["12345"]["internet_verified"],
            True,
        )
        self.assertIn(
            "Rules:\nResolves YES if Acme starts trading on Nasdaq by Dec 31, 2026.",
            runtime_metadata["question_runtime"]["12345"]["preflight_evidence_block"],
        )
        stage2_context = runtime_metadata["question_runtime"]["12345"]["stage2_context"]
        self.assertEqual(stage2_context["matched_gamma_market_id"], "12345")
        self.assertEqual(stage2_context["gamma_match_method"], "market_id")
        self.assertEqual(stage2_context["authoritative_rule_source_field"], "description")
        self.assertEqual(stage2_context["final_rule_gate_result"], "passed")

    def test_finalize_marks_stale_fact_without_requiring_model_side_search(self):
        context = _sample_context()
        runtime_metadata = {
            "kind": "polymarket_bullpen_event",
            "require_fresh_internet_evidence": True,
            "allow_evidence_grounded_non_web_models": False,
            "web_search_used": True,
            "web_search_queries": ["Acme IPO latest news"],
            "web_sources": ["https://www.nasdaq.com/acme-ipo"],
            "evidence_block_used": True,
            "internet_verified": True,
            "stale_fact_detected": False,
            "invalid_reason": None,
            "question_runtime": {
                "12345": {
                    "question_ref": "Q1",
                    "question_id": "12345",
                    "question": "Will Acme go public by December 31, 2026?",
                    "web_search_used": True,
                    "web_search_queries": ["Acme IPO latest news"],
                    "web_sources": ["https://www.nasdaq.com/acme-ipo"],
                    "evidence_block_used": True,
                    "internet_verified": True,
                    "stale_fact_detected": False,
                    "invalid_reason": None,
                    "preflight_evidence_block": (
                        "Verified Evidence Block:\n"
                        "Verified current facts:\n"
                        "- detailed market context: Acme started trading on Nasdaq today.\n"
                        "- resolution source: Nasdaq IPO calendar confirms the listing.\n"
                        "\nInstruction:\nUse verified evidence."
                    ),
                }
            },
        }
        content = json.dumps(
            {
                "markets": [
                    {
                        "question_ref": "Q1",
                        "question": "Will Acme go public by December 31, 2026?",
                        "llm_yes_odds": 5,
                        "llm_no_odds": 95,
                        "rationale": "Acme is still private and has not gone public yet.",
                    }
                ]
            }
        )

        finalized = finalize_polymarket_event_runtime_metadata(
            context,
            provider_name="deepseek",
            content=content,
            model_web_search_used=False,
            model_web_search_queries=[],
            model_web_sources=[],
            runtime_metadata=runtime_metadata,
        )

        question_runtime = finalized["question_runtime"]["12345"]
        self.assertEqual(
            question_runtime["invalid_reason"],
            "Rationale contradicted verified evidence that already confirmed the company is public.",
        )
        self.assertEqual(question_runtime["stale_fact_detected"], True)
        self.assertEqual(finalized["model_side_search_used"], False)
        self.assertEqual(finalized["stale_fact_detected"], True)

    @patch("app.domains.polymarket.event_preflight.httpx.get")
    def test_fetch_gamma_market_prefers_exact_condition_id_over_slug(self, httpx_get_mock):
        class _Response:
            def raise_for_status(self):
                return None

            def json(self):
                return [
                    {
                        "id": "99999",
                        "slug": "acme-ipo",
                        "eventSlug": "acme-ipo",
                        "conditionId": "condition-parent",
                        "description": "Parent event text",
                    },
                    {
                        "id": "12345",
                        "slug": "acme-ipo-child",
                        "eventSlug": "acme-ipo",
                        "conditionId": "condition-child",
                        "description": "Child market text",
                    },
                ]

        httpx_get_mock.return_value = _Response()
        question = _sample_context(require_fresh=False).question_payload[0].model_copy(
            update={
                "market_id": "12345",
                "condition_id": "condition-child",
                "slug": "acme-ipo",
                "market_slug": "acme-ipo",
            }
        )

        result = _fetch_gamma_market(question)

        self.assertTrue(result.exact_match_verified)
        self.assertEqual(result.match_method, "condition_id")
        self.assertEqual(result.matched_gamma_market_id, "12345")
        self.assertEqual(result.record["conditionId"], "condition-child")
        self.assertEqual(
            httpx_get_mock.call_args_list[0].kwargs["params"],
            [("conditionId", "condition-child")],
        )

    @patch("app.domains.polymarket.event_preflight._fetch_event_market_context")
    @patch("app.domains.polymarket.event_preflight._fetch_gamma_market")
    def test_prepare_context_blocks_unmatched_gamma_rules_even_if_legacy_rules_parse(
        self,
        fetch_gamma_market_mock,
        fetch_event_market_context_mock,
    ):
        fetch_gamma_market_mock.return_value = GammaMarketLookupResult()
        fetch_event_market_context_mock.return_value = None

        prepared = prepare_polymarket_event_context(_sample_context(require_fresh=False))

        question_runtime = prepared.runtime_metadata["question_runtime"]["12345"]
        stage2_context = question_runtime["stage2_context"]
        self.assertEqual(
            question_runtime["rule_fail_reason"],
            "Exact Gamma market match is unavailable.",
        )
        self.assertEqual(stage2_context["final_rule_gate_result"], "blocked")
        self.assertEqual(stage2_context["exact_gamma_market_verified"], False)
        self.assertEqual(
            stage2_context["authoritative_rule_source_field"],
            "legacy_payload",
        )
        self.assertIsNone(stage2_context["exact_yes_definition"])

    @patch("app.domains.polymarket.event_preflight._fetch_gamma_market")
    def test_preflight_keeps_required_evidence_fields_and_explains_missing_values(
        self,
        fetch_gamma_market_mock,
    ):
        fetch_gamma_market_mock.return_value = GammaMarketLookupResult()
        context = _sample_context(require_fresh=False)
        question = context.question_payload[0].model_copy(
            update={
                "market_url": None,
                "slug": None,
                "market_slug": None,
                "polymarket_rules": None,
                "polymarket_market_context": None,
                "polymarket_resolution_source": None,
            }
        )

        prepared = prepare_polymarket_event_context(
            context.model_copy(update={"question_payload": [question]})
        )
        block = prepared.runtime_metadata["question_runtime"]["12345"][
            "preflight_evidence_block"
        ]

        self.assertIn(
            "- Polymarket rules: Not supplied (reason: no exact Polymarket Gamma market matched",
            block,
        )
        self.assertIn(
            "- detailed market context: Not supplied (reason: no canonical Polymarket event URL was available",
            block,
        )
        self.assertIn(
            "- resolution source: Not supplied (reason: Polymarket supplied neither",
            block,
        )

    @patch("app.domains.polymarket.event_preflight._fetch_event_market_context")
    @patch("app.domains.polymarket.event_preflight._fetch_gamma_market")
    def test_prepare_context_marks_verified_binary_rule_bypass_for_exact_gamma_match(
        self,
        fetch_gamma_market_mock,
        fetch_event_market_context_mock,
    ):
        fetch_gamma_market_mock.return_value = GammaMarketLookupResult(
            record={
                "id": "12345",
                "slug": "iran-airspace-market",
                "eventSlug": "iran-airspace-market",
                "question": "Will Iran's airspace remain closed through July 20, 2026?",
                "resolutionCriteria": (
                    "According to Polymarket, this market resolves to Yes, if Iran's airspace "
                    "remains closed through July 20, 2026, 11:59 PM ET."
                ),
                "outcomes": json.dumps(["Yes", "No"]),
                "outcomePrices": json.dumps([0.89, 0.11]),
                "conditionId": "condition-iran-airspace",
                "endDate": "2026-07-21T03:59:00Z",
            },
            matched_gamma_market_id="12345",
            match_method="condition_id",
            exact_match_verified=True,
        )
        fetch_event_market_context_mock.return_value = None

        prepared = prepare_polymarket_event_context(
            _sample_context(require_fresh=False).model_copy(
                update={
                    "question_payload": [
                        _sample_context(require_fresh=False).question_payload[0].model_copy(
                            update={
                                "question": "Will Iran's airspace remain closed through July 20, 2026?",
                                "market_id": "12345",
                                "condition_id": "condition-iran-airspace",
                                "slug": "iran-airspace-market",
                                "market_slug": "iran-airspace-market",
                                "close_time": "2026-07-21T03:59:00Z",
                                "closing_time": "2026-07-21T03:59:00Z",
                            }
                        )
                    ]
                }
            )
        )

        stage2_context = prepared.runtime_metadata["question_runtime"]["12345"][
            "stage2_context"
        ]
        self.assertEqual(
            stage2_context["final_rule_gate_result"],
            "bypassed_verified_binary_rules",
        )
        self.assertEqual(
            stage2_context["yes_definition_extraction_method"],
            "sentence_fallback",
        )
        self.assertEqual(
            stage2_context["authoritative_rule_source_field"],
            "resolutionCriteria",
        )
        self.assertEqual(
            stage2_context["exact_yes_definition"],
            "Iran's airspace remains closed through July 20, 2026, 11:59 PM ET",
        )


if __name__ == "__main__":
    unittest.main()
