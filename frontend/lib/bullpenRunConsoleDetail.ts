import type {
  BullpenAutoLiveDecision,
  BullpenAutoLiveRun,
  BullpenAutoLiveStageResult,
} from "@/types/api";

function stageIdentity(stage: BullpenAutoLiveStageResult) {
  const workflowKey = stage.outputs?.workflow_stage_key;
  return typeof workflowKey === "string" && workflowKey
    ? workflowKey
    : `${stage.stage_number}:${stage.stage_name}`;
}

// These fields describe the current worker/reconciliation generation, rather
// than expandable frozen evidence. Their absence from an available exact-run
// projection is an authoritative clear. Keep this list aligned with the live
// subset of backend console_projection._STAGE_OUTPUT_KEYS. The completed Stage 2
// actionable contract is intentionally excluded: once persisted, omission from
// a later compact poll must never erase or locally recompute that contract.
const AUTHORITATIVE_LIVE_OUTPUT_KEYS = [
  "phase_status",
  "progress_commentary",
  "cancellation_state",
  "current_blockage",
  "error_message",
  "execution_mode_reason",
  "execution_step_detail",
  "execution_step_label",
  "execution_gate_reason",
  "failure_category",
  "how_to_resolve",
  "next_action",
  "next_reconciliation_at",
  "next_retry_at",
  "recovery_required",
  "stage2_universe_blocker_code",
  "stage2_universe_blocker_fix",
  "stage2_universe_blocker_summary",
  "scanned_candidates",
  "total_items",
  "completed_items",
  "failed_items",
  "accepted_candidates_count",
  "candidate_rows_before_llm",
  "stage1_accepted_candidate_count",
  "active_position_rows",
  "active_position_rows_before_llm",
  "wallet_snapshot_status",
  "wallet_source",
  "wallet_snapshot_fetched_at",
  "wallet_snapshot_freshness_state",
  "wallet_freshness_state",
  "wallet_account_identity",
  "wallet_position_classifier_version",
  "wallet_credential_artifact_inode",
  "wallet_credential_artifact_mtime_ns",
  "wallet_credential_artifact_size",
  "wallet_credential_artifact",
  "position_classifier_version",
  "wallet_market_enrichment_error",
  "unresolved_positive_exposure_position_count",
  "wallet_refresh_error",
  "wallet_lock_wait_ms",
  "wallet_command_duration_ms",
  "stage2_candidate_only",
  "blocked_by_stage1_wallet_refresh",
  "console_trade_amount_usd",
  "console_trade_amount_source",
  "console_trade_last_calculated_usd",
  "console_trade_cash_in_hand_usd",
  "console_trade_occupied_positions",
  "console_trade_active_positions",
  "console_trade_available_slots",
  "console_trade_max_positions",
  "llm_candidate_count",
  "llm_provider_target_count",
  "llm_selected_target_count",
  "llm_target_count",
  "llm_completed_provider_target_count",
  "llm_completed_model_count",
  "llm_successful_provider_target_count",
  "llm_passed_provider_target_count",
  "llm_usable_provider_target_count",
  "llm_failed_provider_target_count",
  "llm_failed_model_count",
  "llms_completed",
  "llm_execution_mode",
  "llm_events_per_prompt",
  "reused_existing_llm_outputs",
  "stage2_eligible_rows_total",
  "stage2_reviewed_rows",
  "stage2_skipped_rows",
  "stage2_universe_complete",
  "stage2_universe_status",
  "candidate_decision_rows",
  "event_exit_planned",
  "event_exit_processed",
  "event_exit_submitted",
  "event_exit_forced_planned",
  "event_exit_forced_submitted",
  "event_exit_ranking_llm_planned",
  "event_exit_ranking_llm_submitted",
  "redeem_planned",
  "redeem_processed",
  "redeem_submitted",
  "orders_planned",
  "orders_processed",
  "orders_submitted",
  "orders_ready",
  "orders_attempted",
  "orders_remotely_accepted",
  "orders_confirmed",
  "orders_filled",
  "orders_retry_wait",
  "orders_waiting_for_collateral",
  "orders_deferred",
  "orders_permanently_failed",
  "persisted_execution_counters",
  "post_exit_snapshot_source",
  "post_exit_snapshot_fetched_at",
] as const;

// The exact projection deliberately bounds or omits expandable evidence. Once
// the dialog has loaded the frozen run, a poll must not replace complete
// evidence with a ten-row projection or erase it merely because it was
// omitted from a recovered generation.
const FROZEN_EVIDENCE_OUTPUT_KEYS = [
  "accepted_candidates",
  "rejected_candidates",
  "active_positions_found",
  "available_for_claim",
  "settlement_pending_positions",
  "excluded_position_diagnostics",
  "wallet_snapshot_diagnostics",
  "wallet_market_enrichment",
  "conservatively_occupied_market_ids",
  "execution_steps",
  "llm_reviewed_candidates",
  "llm_targets",
  "stage2_strategy_metadata",
  "qualified_candidate_market_ids",
  "decision_rows",
  "event_exit_rows",
  "slot_allocation",
] as const;

// Once a stage has completed these aggregate facts are as immutable as its
// expandable evidence. Later-stage compact projections are allowed to omit
// them, but omission must not make the workflow UI recalculate them as zero.
const COMPLETED_STAGE_METRIC_OUTPUT_KEYS = [
  "scanned_candidates",
  "total_items",
  "accepted_candidates_count",
  "candidate_rows_before_llm",
  "stage1_accepted_candidate_count",
  "active_position_rows",
  "active_position_rows_before_llm",
  "active_positions_total",
  "llm_candidate_count",
  "llm_provider_target_count",
  "llm_selected_target_count",
  "llm_target_count",
  "llm_completed_provider_target_count",
  "llm_completed_model_count",
  "llm_successful_provider_target_count",
  "llm_passed_provider_target_count",
  "llm_usable_provider_target_count",
  "llm_failed_provider_target_count",
  "llm_failed_model_count",
  "llms_completed",
] as const;

// A compact status poll can race a richer progress response by one database
// commit. These counters describe work already completed in the current Stage
// 2 execution and therefore cannot legitimately move backwards until a new
// stage generation starts.
const MONOTONIC_STAGE_METRIC_OUTPUT_KEYS = [
  "llm_completed_provider_target_count",
  "llm_completed_model_count",
  "llm_successful_provider_target_count",
  "llm_passed_provider_target_count",
  "llm_usable_provider_target_count",
  "llm_failed_provider_target_count",
  "llm_failed_model_count",
  "llms_completed",
] as const;

function numericMetric(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function preserveRicherCompletedMetric(
  existing: unknown,
  projected: unknown,
) {
  const existingMetric = numericMetric(existing);
  const projectedMetric = numericMetric(projected);
  if (existingMetric !== null && projectedMetric !== null) {
    return projectedMetric < existingMetric ? existing : projected;
  }

  if (Array.isArray(existing) && Array.isArray(projected)) {
    return projected.length < existing.length ? existing : projected;
  }

  return projected === undefined ? existing : projected;
}

function isSameStageExecutionGeneration(
  existing: BullpenAutoLiveStageResult,
  projected: BullpenAutoLiveStageResult,
) {
  return Boolean(
    existing.started_at &&
      projected.started_at &&
      existing.started_at === projected.started_at,
  );
}

function mergeStageProjection(
  existing: BullpenAutoLiveStageResult,
  projected: BullpenAutoLiveStageResult,
): BullpenAutoLiveStageResult {
  const outputs = {
    ...(existing.outputs ?? {}),
    ...(projected.outputs ?? {}),
  };
  for (const key of AUTHORITATIVE_LIVE_OUTPUT_KEYS) {
    if (!Object.hasOwn(projected.outputs ?? {}, key)) {
      delete outputs[key];
    }
  }
  if (isSameStageExecutionGeneration(existing, projected)) {
    for (const key of MONOTONIC_STAGE_METRIC_OUTPUT_KEYS) {
      const existingMetric = numericMetric(existing.outputs?.[key]);
      const projectedMetric = numericMetric(projected.outputs?.[key]);
      if (
        existingMetric !== null &&
        (projectedMetric === null || projectedMetric < existingMetric)
      ) {
        outputs[key] = existing.outputs?.[key];
      }
    }
  }
  if (projected.completed_at) {
    for (const key of COMPLETED_STAGE_METRIC_OUTPUT_KEYS) {
      if (!Object.hasOwn(existing.outputs ?? {}, key)) continue;
      outputs[key] = preserveRicherCompletedMetric(
        existing.outputs[key],
        projected.outputs?.[key],
      );
    }
  }
  for (const key of FROZEN_EVIDENCE_OUTPUT_KEYS) {
    if (Object.hasOwn(existing.outputs ?? {}, key)) {
      outputs[key] = existing.outputs[key];
    }
  }

  return {
    ...existing,
    ...projected,
    inputs: {
      ...(existing.inputs ?? {}),
      ...(projected.inputs ?? {}),
    },
    outputs,
    // The exact-run projection is authoritative for current guardrail state.
    // An empty list means the prior checks were cleared during recovery.
    guardrails_checked: projected.guardrails_checked,
  };
}

export function mergeBullpenConsoleRunProjection({
  existing,
  projected,
  projectionAvailable,
}: {
  existing: BullpenAutoLiveRun;
  projected: BullpenAutoLiveRun;
  projectionAvailable: boolean;
}) {
  if (!projectionAvailable || existing.id !== projected.id) {
    return existing;
  }

  const projectedStages = new Map(
    projected.stage_results.map((stage) => [stageIdentity(stage), stage]),
  );
  const stageResults = existing.stage_results.map((stage) => {
    const update = projectedStages.get(stageIdentity(stage));
    if (!update) return stage;
    projectedStages.delete(stageIdentity(stage));
    return mergeStageProjection(stage, update);
  });
  stageResults.push(...projectedStages.values());

  return {
    ...existing,
    ...projected,
    stage_results: stageResults,
    guardrail_checks: projected.guardrail_checks,
    decision_ids: projected.decision_ids,
    order_intent_ids: projected.order_intent_ids,
    request_context: projected.request_context ?? existing.request_context,
    audit_metadata:
      Object.keys(projected.audit_metadata ?? {}).length > 0
        ? projected.audit_metadata
        : existing.audit_metadata,
  } satisfies BullpenAutoLiveRun;
}

/**
 * The summary response can contain the same run twice: a compact `latest_run`
 * projection and a richer entry in `recent_runs`. Reconcile those copies before
 * rendering so a later-stage compact projection cannot make completed Stage 1
 * or Stage 2 metrics appear to become zero.
 */
export function reconcileBullpenConsoleRunCopies(
  evidenceRun: BullpenAutoLiveRun,
  latestProjection: BullpenAutoLiveRun | null | undefined,
) {
  if (!latestProjection || evidenceRun.id !== latestProjection.id) {
    return evidenceRun;
  }

  return mergeBullpenConsoleRunProjection({
    existing: evidenceRun,
    projected: latestProjection,
    projectionAvailable: true,
  });
}

export function mergeBullpenConsoleDecisionProjection({
  existing,
  projected,
  truncated,
  visibleDecisionIds,
  visibleDecisionIdsTruncated = false,
}: {
  existing: BullpenAutoLiveDecision[];
  projected: BullpenAutoLiveDecision[];
  truncated: boolean;
  visibleDecisionIds?: string[];
  visibleDecisionIdsTruncated?: boolean;
}) {
  const authoritativeVisibleIds =
    visibleDecisionIds !== undefined && !visibleDecisionIdsTruncated
      ? new Set(visibleDecisionIds)
      : null;
  const merged = new Map(
    existing
      .filter(
        (decision) =>
          authoritativeVisibleIds === null ||
          authoritativeVisibleIds.has(decision.id),
      )
      .map((decision) => [decision.id, decision]),
  );
  for (const decision of projected) {
    if (
      authoritativeVisibleIds !== null &&
      !authoritativeVisibleIds.has(decision.id)
    ) {
      continue;
    }
    const fullDecision = merged.get(decision.id);
    merged.set(
      decision.id,
      fullDecision
        ? {
            ...fullDecision,
            ...decision,
            // These are frozen evidence collections that the console
            // projection deliberately emits as empty. Preserve a previously
            // loaded full copy while accepting live order/status fields.
            key_evidence:
              decision.key_evidence.length > 0
                ? decision.key_evidence
                : fullDecision.key_evidence,
            red_flags:
              decision.red_flags.length > 0
                ? decision.red_flags
                : fullDecision.red_flags,
            exit_signals:
              decision.exit_signals.length > 0
                ? decision.exit_signals
                : fullDecision.exit_signals,
            llm_outputs:
              decision.llm_outputs.length > 0
                ? decision.llm_outputs
                : fullDecision.llm_outputs,
            stage_results:
              decision.stage_results.length > 0
                ? decision.stage_results
                : fullDecision.stage_results,
            guardrail_checks:
              decision.guardrail_checks.length > 0
                ? decision.guardrail_checks
                : fullDecision.guardrail_checks,
          }
        : decision,
    );
  }
  if (authoritativeVisibleIds !== null && visibleDecisionIds) {
    return visibleDecisionIds
      .map((decisionId) => merged.get(decisionId))
      .filter(
        (decision): decision is BullpenAutoLiveDecision =>
          decision !== undefined,
      );
  }
  if (!truncated) {
    return projected
      .map((decision) => merged.get(decision.id))
      .filter(
        (decision): decision is BullpenAutoLiveDecision =>
          decision !== undefined,
      );
  }
  return [...merged.values()];
}
