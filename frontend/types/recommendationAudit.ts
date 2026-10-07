export type AuditFinding = { code: string; detail: string; severity: string };
export type AuditFormula = {
  detailedRationaleMultipliers: Record<string, number>;
  detailedRationaleDenominator: number | null;
  actionScores: Record<string, number>;
  technicalScanMultipliers: Record<string, number>;
  scoreSymbolThresholds: Record<string, number>;
};
export type AuditRunContext = { formula: AuditFormula; objective?: string; horizon?: string; rebalance_run_ids?: number[]; expected_response_hashes?: Record<number, string> };
export type AuditCalculation = {
  raw_action: string | null; raw_action_counts: Record<string, number>;
  formula_action: string | null; formula_units: string | null; score: string | null;
  rationale_mean?: string | null;
  current_units: string | null; numerator: string | null; denominator: string | null;
  findings: AuditFinding[]; averages: Record<string, string | null>;
};
export type AuditDecision = {
  id: string; run_id: number; market: string; symbol: string; exchange: string;
  provenance: string; captured_at: string; decision_at: string; original_completion_at: string | null;
  formula_hash: string | null; calculation: AuditCalculation;
  sizing: { action: string | null; units: string | null; findings: AuditFinding[] };
  coverage: { successful: number; attempted: number; captured_terminal: number };
};
export type AuditComparison = {
  capabilities?: { external_enabled: boolean; fundamentals_enabled?: boolean; automatic_delivery_recovery?: boolean; recovery_read_only: boolean; daily_cap_usd: number; kite_request_cost_usd: number | null; kite_max_requests: number; rbi_max_requests: number };
  current: AuditDecision | null; present_calculation?: AuditDecision | null; previous: AuditDecision | null; bundle_hash?: string;
  comparison: { comparable: boolean; exposure_reversal: boolean; changes: { field: string; before: unknown; after: unknown }[]; score_component_changes?: Record<string,string>; findings: AuditFinding[] } | null;
  coverage: unknown;
};
export type AuditVerification = {
  id: string; status: string; verdict: string | null; error: string | null;
  budget_usd: string; spent_usd: string; reserved_usd: string; dispatch_pending: boolean;
  result: { checked_at?: string; findings: string[]; limitations?: string[]; claims: { claim: { id: string; text: string }; state: string; observations?: { detail: string; available_at?: string | null }[] }[]; scope: string; sources?: { source_url: string; observed_at?: string; published_at?: string | null; available_at?: string | null; limitations?: string[]; facts?: { concept: string; value: string | null; unit_measures: string[]; period_start: string | null; period_end: string | null; instant: string | null; dimensions: Record<string,string> }[] }[] } | null;
};
export type AuditVerifyRequest = {
  current_id: string; previous_id: string | null; bundle_hash: string;
  mode: "stored_only" | "external_data"; policy_version: "reversal-evidence-v1";
  idempotency_key: string; budget_usd: number; refresh_key?: string;
};
