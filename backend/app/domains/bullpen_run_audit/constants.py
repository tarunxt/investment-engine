from __future__ import annotations

from typing import Final

BULLPEN_RUN_AUDIT_SCHEMA_VERSION: Final[int] = 2
BULLPEN_RUN_AUDIT_RULE_VERSION: Final[str] = (
    "2026-09-05-stage1-common-filters-v30"
)
BULLPEN_RUN_AUDIT_PROMPT_VERSION: Final[str] = "bullpen-run-audit-v1"
BULLPEN_RUN_AUDIT_ALGORITHM_REGISTRY_VERSION: Final[str] = (
    "2026-09-05-stage1-common-filters-v30"
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
        "algorithm_key": "run_execution_handoff_fallback",
        "stage": "overview",
        "algorithm_version": "v2",
        "source_module": "app.domains.polymarket_auto_live.tasks",
        "source_function": "dispatch_stalled_auto_live_run_fallbacks_sync",
        "label": "Bounded primary, secondary, and fail-closed run handoff",
    },
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
        "algorithm_version": "v4",
        "source_module": "app.domains.polymarket_auto_live.console_profile",
        "source_function": "candidate_returns_per_day",
        "label": "Candidate returns per day",
    },
    {
        "algorithm_key": "stage1_common_scan_filters_and_wallet_union",
        "stage": "stage-1",
        "algorithm_version": "v1",
        "source_module": "app.domains.polymarket_auto_live.console_profile",
        "source_function": "scan_console_profile_markets",
        "label": "Saved common filters, child deadlines, and active-wallet union",
    },
    {
        "algorithm_key": "stage1_wallet_handoff_circuit_breaker",
        "stage": "stage-1",
        "algorithm_version": "v1",
        "source_module": "app.domains.polymarket_auto_live.engine",
        "source_function": "BullpenAutoLiveEngine._execute_console_top10",
        "label": "Stage 1 wallet handoff timeout and candidate-only safety gate",
    },
    {
        "algorithm_key": "bullpen_position_claimability",
        "stage": "stage-1",
        "algorithm_version": "v4",
        "source_module": "app.domains.polymarket.position_classification",
        "source_function": "classify_bullpen_position",
        "label": "Authoritative Bullpen position claimability classification",
    },
    {
        "algorithm_key": "stage2_to_stage3_handoff_checkpoint",
        "stage": "stage-3",
        "algorithm_version": "v1",
        "source_module": "app.domains.polymarket_auto_live.engine",
        "source_function": "BullpenAutoLiveEngine._execute_console_top10",
        "label": "Durable Stage 2 Top 10 to Stage 3 handoff checkpoint",
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
        "algorithm_key": "stage3_live_capacity_sizing",
        "stage": "stage-3",
        "algorithm_version": "v2",
        "source_module": "app.domains.polymarket_auto_live.engine",
        "source_function": "build_console_trade_amount_breakdown",
        "label": "Stage 3 live cash per available portfolio slot",
    },
    {
        "algorithm_key": "llm_returns_per_day",
        "stage": "stage-2",
        "algorithm_version": "v4",
        "source_module": "app.domains.polymarket_auto_live.console_profile",
        "source_function": "llm_returns_per_day",
        "label": "Stage 2 current-odds returns per day",
    },
    {
        "algorithm_key": "position_returns_per_day",
        "stage": "stage-3",
        "algorithm_version": "v2",
        "source_module": "app.domains.polymarket_auto_live.console_profile",
        "source_function": "position_returns_per_day",
        "label": "Active position returns per day",
    },
    {
        "algorithm_key": "stage3_rank_and_selection",
        "stage": "stage-3",
        "algorithm_version": "v2",
        "source_module": "app.domains.polymarket_auto_live.engine",
        "source_function": "BullpenAutoLiveEngine._execute_console_top10",
        "label": "Post-exit Stage 3 ranking, selection, and buy-queue handoff",
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
        "algorithm_key": "stage3_affordable_ranked_buy_allocation",
        "stage": "stage-3",
        "algorithm_version": "v1",
        "source_module": "app.domains.polymarket_auto_live.engine",
        "source_function": "build_console_affordable_buy_allocation",
        "label": "Stage 3 buffered highest-ranked affordable buy allocation",
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
        "algorithm_key": "stage3_sell_live_exposure_preflight",
        "stage": "stage-3",
        "algorithm_version": "v1",
        "source_module": "app.domains.polymarket_auto_live.order_intent_service",
        "source_function": "_prepare_intent_submission",
        "label": "Fresh live sell-exposure classification and share cap",
    },
    {
        "algorithm_key": "stage3_buy_market_exposure_preflight",
        "stage": "stage-3",
        "algorithm_version": "v2",
        "source_module": "app.domains.polymarket_auto_live.order_intent_service",
        "source_function": "_reserve_buy_if_possible",
        "label": "Forced-fresh wallet and singleton durable-intent duplicate BUY fence",
    },
    {
        "algorithm_key": "stage3_redeem_wallet_lineage_preflight",
        "stage": "stage-3",
        "algorithm_version": "v2",
        "source_module": "app.domains.polymarket_auto_live.order_intent_service",
        "source_function": "_prepare_intent_submission",
        "label": "Complete forced-fresh Stage 1 wallet-lineage fence before redeem",
    },
    {
        "algorithm_key": "stage3_wallet_credential_rotation_attestation",
        "stage": "stage-3",
        "algorithm_version": "v1",
        "source_module": "app.domains.polymarket_auto_live.order_intent_service",
        "source_function": "_attest_pre_submit_wallet_lineage",
        "label": "Same-wallet active-auth credential rotation attestation",
    },
    {
        "algorithm_key": "stage3_post_exit_planner_credential_rotation",
        "stage": "stage-3",
        "algorithm_version": "v1",
        "source_module": "app.domains.polymarket_auto_live.engine",
        "source_function": "_compare_console_wallet_snapshot_lineage",
        "label": "Planner-only same-wallet credential rotation continuation",
    },
    {
        "algorithm_key": "stage3_sell_alias_reconciliation",
        "stage": "stage-3",
        "algorithm_version": "v1",
        "source_module": "app.domains.polymarket_auto_live.order_intent_service",
        "source_function": "_position_matches_intent",
        "label": "Alias-aware sell position reconciliation",
    },
    {
        "algorithm_key": "stage3_buy_reservation_terminal_release",
        "stage": "stage-3",
        "algorithm_version": "v1",
        "source_module": "app.domains.polymarket_auto_live.order_intent_service",
        "source_function": "_release_buy_reservation_if_no_remote_evidence",
        "label": "Terminal no-write buy reservation release",
    },
    {
        "algorithm_key": "stage3_active_reservation_cash_filter",
        "stage": "stage-3",
        "algorithm_version": "v2",
        "source_module": "app.domains.polymarket_auto_live.order_intent_service",
        "source_function": "_active_reserved_cash",
        "label": "Active and post-balance consumed reservation cash filter",
    },
    {
        "algorithm_key": "stage3_buy_post_submit_reconciliation",
        "stage": "stage-3",
        "algorithm_version": "v1",
        "source_module": "app.domains.polymarket_auto_live.order_intent_service",
        "source_function": "_reconcile_buy_intent_async",
        "label": "Bounded remote, wallet-lineage, and history buy reconciliation",
    },
    {
        "algorithm_key": "stage3_ambiguous_write_boundary_fence",
        "stage": "stage-3",
        "algorithm_version": "v1",
        "source_module": "app.domains.polymarket_auto_live.order_intent_service",
        "source_function": "_apply_executor_error",
        "label": "Ambiguous remote-write timestamp and resubmission fence",
    },
    {
        "algorithm_key": "stage3_terminal_buy_portfolio_refresh",
        "stage": "stage-3",
        "algorithm_version": "v1",
        "source_module": "app.domains.polymarket_auto_live.order_intent_service",
        "source_function": "_terminal_buy_wallet_refresh_metadata",
        "label": "Forced-fresh terminal-buy portfolio publication",
    },
    {
        "algorithm_key": "stage3_dependency_exit_handoff",
        "stage": "stage-3",
        "algorithm_version": "v3",
        "source_module": "app.domains.polymarket_auto_live.order_intent_service",
        "source_function": "_defer_buy_until_exit",
        "label": "Serialized and legacy-repairable exit-to-replacement-buy dependency handoff",
    },
    {
        "algorithm_key": "stage3_waiting_exit_watchdog_recovery",
        "stage": "stage-3",
        "algorithm_version": "v1",
        "source_module": "app.domains.polymarket_auto_live.order_intent_service",
        "source_function": "watchdog_requeue_stale_order_intents_sync",
        "label": "Lost exit-wake recovery from committed terminal dependency",
    },
    {
        "algorithm_key": "stage3_deferred_replacement_sizing",
        "stage": "stage-3",
        "algorithm_version": "v2",
        "source_module": "app.domains.polymarket_auto_live.engine",
        "source_function": "BullpenAutoLiveEngine._execute_console_top10",
        "label": "Free-slot-aware deferred post-exit replacement sizing and reservation",
    },
    {
        "algorithm_key": "stage3_immediate_sell_fallback",
        "stage": "stage-3",
        "algorithm_version": "v1",
        "source_module": "app.domains.polymarket_auto_live.immediate_sell",
        "source_function": "submit_immediate_sell_with_fallbacks",
        "label": "Bounded primary, secondary, and tertiary immediate-sell execution",
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
        "algorithm_version": "v2",
        "source_module": "app.domains.polymarket_auto_live.bot",
        "source_function": "_get_active_run_or_recover",
        "label": "Stage 3 restart abort and durable-intent operator recovery",
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
    {
        "algorithm_key": "stage3_bullpen_response_normalization",
        "stage": "stage-3",
        "algorithm_version": "v1",
        "source_module": "app.domains.polymarket_auto_live.order_intent_service",
        "source_function": "_matched_buy_submission_fill",
        "label": "Nested Bullpen order reference and matched-fill normalization",
    },
    {
        "algorithm_key": "stage3_verified_remote_absence_retry",
        "stage": "stage-3",
        "algorithm_version": "v1",
        "source_module": "app.domains.polymarket_auto_live.order_intent_service",
        "source_function": "_assert_intent_retry_allowed",
        "label": "Explicit retry after verified remote order and trade absence",
    },
    {
        "algorithm_key": "stage3_reconciliation_generation_guard",
        "stage": "stage-3",
        "algorithm_version": "v1",
        "source_module": "app.domains.polymarket_auto_live.order_intent_service",
        "source_function": "_reconciliation_snapshot_is_current",
        "label": "Stage 3 stale reconciliation generation guard",
    },
    {
        "algorithm_key": "stage3_terminal_resume_preservation",
        "stage": "stage-3",
        "algorithm_version": "v1",
        "source_module": "app.domains.polymarket_auto_live.order_intent_service",
        "source_function": "_intent_requires_operator_resume_reconciliation",
        "label": "Terminal Stage 3 success preservation during operator resume",
    },
    {
        "algorithm_key": "stage3_terminal_doctor_blocker",
        "stage": "stage-3",
        "algorithm_version": "v1",
        "source_module": "app.domains.polymarket.doctor_errors",
        "source_function": "parse_bullpen_doctor_failure",
        "label": "Typed terminal Bullpen doctor and support-required blocker",
    },
    {
        "algorithm_key": "stage3_submission_evidence_terminality",
        "stage": "stage-3",
        "algorithm_version": "v1",
        "source_module": "app.domains.polymarket_auto_live.order_intents",
        "source_function": "intent_has_verified_terminal_success",
        "label": "Submission-evidence-fenced Stage 3 terminal success",
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
    "backend/app/domains/polymarket_auto_live/bot.py",
    "backend/app/domains/polymarket_auto_live/immediate_sell.py",
    "backend/app/domains/polymarket_auto_live/run_handoff.py",
    "backend/app/domains/polymarket_auto_live/engine.py",
    "backend/app/domains/polymarket_auto_live/tasks.py",
    "backend/app/domains/polymarket_auto_live/order_intent_service.py",
    "backend/app/domains/polymarket_auto_live/run_recovery.py",
    "backend/app/domains/polymarket/bullpen.py",
    "backend/app/domains/polymarket/runtime_broker.py",
    "backend/app/domains/polymarket/bullpen_llm_execution.py",
    "backend/app/domains/bullpen_run_audit/service.py",
    "backend/app/domains/bullpen_run_audit/validators.py",
)

FEEDBACK_PROMPT_FILE: Final[str] = "backend/prompts/bullpen-run-audit-v1.txt"
