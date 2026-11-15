// Presentation provenance only. Normalized [] fallbacks do not prove emptiness.
export function getStageOneDialogEvidence(stage: {
  outputs: Record<string, unknown>;
  timerCompletedAt: string | null;
}) {
  const outputs = stage.outputs;
  const phase = String(outputs.phase_status ?? "").toLowerCase();
  const incomplete = ["failed", "error", "unavailable", "unknown", "incomplete", "not_evaluated", "blocked", "aborted", "cancelled", "partial", "running", "pending"].includes(phase)
    || outputs.partial_scan === true
    || (outputs.scan_scope === "full_universe" && outputs.scan_completeness !== "complete");
  const completedAt = typeof outputs.filters_completed_at === "string"
    ? outputs.filters_completed_at : stage.timerCompletedAt;
  const complete = !incomplete && Boolean(completedAt);
  const hasCount = (...keys: string[]) => keys.some(key => {
    const value = outputs[key];
    return (typeof value === "number" && Number.isFinite(value) && value >= 0)
      || (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0);
  });
  // Arrays can be compacted in summaries. Only explicit totals establish totals.
  const candidatesKnown = complete && hasCount("accepted_candidates_count", "candidate_rows_before_llm");
  const scanKnown = complete && hasCount("scanned_candidates", "total_items");
  const positionsKnown = complete && hasCount("active_position_rows_before_llm", "active_position_rows", "active_positions_total");
  const claimsKnown = complete && Array.isArray(outputs.available_for_claim);
  const allKnown = candidatesKnown && scanKnown && positionsKnown && claimsKnown;
  const label = complete
    ? `Saved Stage 1 evidence · ${completedAt}. ${allKnown ? "" : "Missing source counts remain unknown."}`
    : "Stage 1 source evidence is unavailable or incomplete. Counts and empty states are unknown; retained rows, if any, are shown below.";
  return { complete, candidatesKnown, scanKnown, positionsKnown, claimsKnown, label };
}
