from __future__ import annotations

from typing import Final

BULLPEN_RUN_AUDIT_SCHEMA_VERSION: Final[int] = 2
BULLPEN_RUN_AUDIT_RULE_VERSION: Final[str] = "2026-07-20-stage3-capacity-sizing-v8"
BULLPEN_RUN_AUDIT_PROMPT_VERSION: Final[str] = "bullpen-run-audit-v1"
BULLPEN_RUN_AUDIT_ALGORITHM_REGISTRY_VERSION: Final[str] = (
    "2026-07-20-stage3-capacity-sizing-v8"
)

SNAPSHOT_SOURCE_NATIVE: Final[str] = "native"
SNAPSHOT_SOURCE_RECONSTRUCTED: Final[str] = "reconstructed"

SNAPSHOT_STATUS_WORKING: Final[str] = "working"
SNAPSHOT_STATUS_FROZEN: Final[str] = "frozen"
SNAPSHOT_STATUS_INCOMPLETE: Final[str] = "incomplete"

FINDING_SEVERITIES: Final[tuple[str, ...]] = (
    "critical",
    "high",
    "medium",
    "low",
    "info",
)

MANUAL_CHECK_STATUSES: Final[tuple[str, ...]] = (
    "unchecked",
    "pass",
    "fail",
    "not_applicable",
)

AUDIT_SECTION_KEYS: Final[tuple[str, ...]] = (
    "overview",
    "stage-1",
    "stage-2",
    "stage-3",
    "formulas",
    "guardrails",
    "raw",
)

AUDITED_ALGORITHM_REGISTRY: Final[tuple[dict[str, str], ...]] = (
    {
        "algorithm_key": "stage2_consensus_statistics",
        "stage": "stage-2",
        "algorithm_version": "v1",
        "source_module": "app.domains.polymarket.bullpen_llm_execution",
        "source_function": "compute_llm_consensus",
        "label": "Stage 2 consensus statistics",
    },
    {
        "algorithm_key": "candidate_returns_per_day",
        "stage": "stage-1",
        "algorithm_version": "v3",
        "source_module": "app.domains.polymarket_auto_live.console_profile",
        "source_function": "candidate_returns_per_day",
        "label": "Candidate returns per day",
    },
    {
        "algorithm_key": "console_trade_amount_per_opportunity",
        "stage": "stage-1",
        "algorithm_version": "v2",
        "source_module": "app.domains.polymarket_auto_live.engine",
        "source_function": "build_console_trade_amount_breakdown",
        "label": "Cash per available Bullpen portfolio slot",
    },
    {
        "algorithm_key": "stage3_capacity_override_sizing",
        "stage": "stage-3",
        "algorithm_version": "v1",
        "source_module": "app.domains.polymarket_auto_live.engine",
        "source_function": "_stage3_capacity_sizing_market_ids",
        "label": "Audited Stage 3 capacity-override sizing basis",
    },
    {
        "algorithm_key": "llm_returns_per_day",
        "stage": "stage-2",
        "algorithm_version": "v3",
        "source_module": "app.domains.polymarket_auto_live.console_profile",
        "source_function": "llm_returns_per_day",
        "label": "Stage 2 current-odds returns per day",
    },
    {
        "algorithm_key": "position_returns_per_day",
        "stage": "stage-3",
        "algorithm_version": "v1",
        "source_module": "app.domains.polymarket_auto_live.engine",
        "source_function": "position_returns_per_day",
        "label": "Active position returns per day",
    },
    {
        "algorithm_key": "stage3_rank_and_selection",
        "stage": "stage-3",
        "algorithm_version": "v1",
        "source_module": "app.domains.polymarket_auto_live.engine",
        "source_function": "_serialize_stage3_decision_row",
        "label": "Stage 3 ranking and selection",
    },
    {
        "algorithm_key": "stage3_economic_slot_allocation",
        "stage": "stage-3",
        "algorithm_version": "v1",
        "source_module": "app.domains.polymarket_auto_live.stage3_slots",
        "source_function": "classify_economic_slots",
        "label": "Stage 3 economic slot allocation and deduplication",
    },
    {
        "algorithm_key": "order_funnel_aggregation",
        "stage": "stage-3",
        "algorithm_version": "v1",
        "source_module": "app.domains.polymarket_auto_live.order_intent_service",
        "source_function": "summarize_run_orders_sync",
        "label": "Order funnel aggregation",
    },
    {
        "algorithm_key": "stage3_order_intent_idempotency",
        "stage": "stage-3",
        "algorithm_version": "v2",
        "source_module": "app.domains.polymarket_auto_live.order_intent_service",
        "source_function": "build_stage3_order_intent_idempotency_key",
        "label": "Bounded Stage 3 order-intent idempotency identity",
    },
    {
        "algorithm_key": "stage3_cli_market_reference",
        "stage": "stage-3",
        "algorithm_version": "v1",
        "source_module": "app.domains.polymarket_auto_live.order_intent_service",
        "source_function": "stage3_execution_market_reference",
        "label": "Bullpen CLI Stage 3 market-reference selection",
    },
    {
        "algorithm_key": "stage3_auth_recovery_intent_preservation",
        "stage": "stage-3",
        "algorithm_version": "v3",
        "source_module": "app.domains.polymarket_auto_live.bot",
        "source_function": "_get_active_run_or_recover",
        "label": "Durable Stage 3 intent preservation during auth recovery",
    },
    {
        "algorithm_key": "stage3_persisted_counter_reconciliation",
        "stage": "stage-3",
        "algorithm_version": "v2",
        "source_module": "app.domains.polymarket_auto_live.order_intent_service",
        "source_function": "_persisted_stage3_counts",
        "label": "Stage 3 persisted execution counter reconciliation",
    },
    {
        "algorithm_key": "stage3_restart_recovery",
        "stage": "stage-3",
        "algorithm_version": "v1",
        "source_module": "app.domains.polymarket_auto_live.run_recovery",
        "source_function": "mark_interrupted_run_for_restart",
        "label": "Stage 3 restart abort and operator recovery",
    },
    {
        "algorithm_key": "stage3_exit_dust_reconciliation",
        "stage": "stage-3",
        "algorithm_version": "v1",
        "source_module": "app.domains.polymarket_auto_live.order_intent_service",
        "source_function": "_remaining_position_is_economic_dust",
        "label": "Economically inactive exit precision-dust reconciliation",
    },
    {
        "algorithm_key": "stage3_cli_history_reconciliation",
        "stage": "stage-3",
        "algorithm_version": "v2",
        "source_module": "app.domains.polymarket.bullpen",
        "source_function": "BullpenTradeHistoryReader.refresh",
        "label": "Bullpen CLI order-history reconciliation source",
    },
)

DEFAULT_MANUAL_CHECKS: Final[tuple[dict[str, str], ...]] = (
    {
        "check_key": "stage1_input_completeness",
        "label": "Stage 1 input completeness",
        "description": "Confirm the run captured the expected scan inputs and source metadata.",
    },
    {
        "check_key": "filter_exclusion_correctness",
        "label": "Filter and exclusion correctness",
        "description": "Confirm exclusion rules and filter reasons match the source data.",
    },
    {
        "check_key": "market_identity_rules",
        "label": "Market identity and rules",
        "description": "Confirm the market identity and resolution rules are correct.",
    },
    {
        "check_key": "stage2_llm_coverage",
        "label": "Stage 2 LLM coverage",
        "description": "Confirm every expected candidate received Stage 2 LLM review.",
    },
    {
        "check_key": "evidence_freshness",
        "label": "Evidence freshness and relevance",
        "description": "Confirm the evidence packet reflects relevant and current facts.",
    },
    {
        "check_key": "probability_rationale_consistency",
        "label": "Probability and rationale consistency",
        "description": "Confirm the numeric probabilities match the written rationales.",
    },
    {
        "check_key": "consensus_correctness",
        "label": "Consensus correctness",
        "description": "Confirm consensus aggregation used only valid LLM outputs.",
    },
    {
        "check_key": "handoff_completeness",
        "label": "Stage 2 to Stage 3 handoff",
        "description": "Confirm qualified Stage 2 candidates were handed off into Stage 3.",
    },
    {
        "check_key": "ranking_tie_breaks",
        "label": "Ranking and tie-breaks",
        "description": "Confirm ranking, ordering, and tie-breaks are deterministic.",
    },
    {
        "check_key": "capital_slot_constraints",
        "label": "Capital and slot constraints",
        "description": "Confirm slot, exposure, and capital constraints were enforced.",
    },
    {
        "check_key": "guardrail_enforcement",
        "label": "Guardrail enforcement",
        "description": "Confirm blocking guardrails actually prevented selection and execution.",
    },
    {
        "check_key": "execution_consistency",
        "label": "Order and execution consistency",
        "description": "Confirm plans, intents, attempts, and terminal order states line up.",
    },
    {
        "check_key": "audit_persistence_completeness",
        "label": "Audit persistence completeness",
        "description": "Confirm the persisted audit contains the required sections and evidence.",
    },
)

BULLPEN_AUDIT_CRITICAL_SOURCE_FILES: Final[tuple[str, ...]] = (
    "backend/app/domains/polymarket_auto_live/engine.py",
    "backend/app/domains/polymarket_auto_live/tasks.py",
    "backend/app/domains/polymarket_auto_live/order_intent_service.py",
    "backend/app/domains/polymarket_auto_live/run_recovery.py",
    "backend/app/domains/polymarket/runtime_broker.py",
    "backend/app/domains/polymarket/bullpen_llm_execution.py",
    "backend/app/domains/bullpen_run_audit/service.py",
    "backend/app/domains/bullpen_run_audit/validators.py",
)

FEEDBACK_PROMPT_FILE: Final[str] = "backend/prompts/bullpen-run-audit-v1.txt"
