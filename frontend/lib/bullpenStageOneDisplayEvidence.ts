/** Display-only evidence. Empty projection defaults never prove successful empty sources. */
export function resolveStageOneDisplayEvidence(input: {
  outputs: Record<string, unknown>; savedStatus?: string | null; completedAt: string | null;
  runId: string | null; activeCount: number; claimableCount: number; candidateCount: number;
}) {
  const o = input.outputs;
  const timestamp = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
  const failed = input.savedStatus === "fail" || ["failed", "blocked", "aborted", "cancelled"].includes(String(o.phase_status));
  const partial = o.partial_scan === true || o.phase_status === "partial";
  const sourceKnown = Boolean(input.runId || (o.independent_stage1_scan === true && o.snapshot_id));
  const completed = sourceKnown && !failed && !partial && timestamp(input.completedAt);
  const filtersVerified = completed && (o.phase_status === "completed" || timestamp(o.filters_completed_at));
  const walletVerified = completed && o.wallet_snapshot_status === "fresh"
    && (o.wallet_snapshot_freshness_state ?? o.wallet_freshness_state) === "fresh"
    && !o.wallet_refresh_error && !o.wallet_market_enrichment_error
    && !o.stage2_candidate_only && !o.blocked_by_stage1_wallet_refresh;
  const knownNumber = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  const activeRecorded = [o.active_position_rows_before_llm, o.active_position_rows, o.active_positions_total].some(knownNumber) || Array.isArray(o.active_positions_found);
  const claimableRecorded = Array.isArray(o.available_for_claim) || knownNumber(o.claimable_wallet_positions);
  const candidatesRecorded = knownNumber(o.accepted_candidates_count) || Array.isArray(o.accepted_candidates);
  const count = (value: number, verified: boolean) => value > 0 || verified ? value : null;
  return {
    active: count(input.activeCount, walletVerified && activeRecorded),
    claimable: count(input.claimableCount, walletVerified && claimableRecorded),
    candidates: count(input.candidateCount, filtersVerified && candidatesRecorded),
    walletVerified, filtersVerified,
    source: input.runId ? `Saved run ${input.runId}` : o.snapshot_id ? `Saved snapshot ${String(o.snapshot_id)}` : "Unknown · no saved run or snapshot evidence",
    status: partial ? "Partial saved evidence; completeness is unknown" : failed ? "Stage 1 failed or was not evaluated; completeness is unknown" : completed ? "Saved Stage 1 evidence" : "Stage 1 completion is unknown",
  };
}
