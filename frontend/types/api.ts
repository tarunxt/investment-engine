// ==================== Health Check Types ====================

export interface HealthCheckResponse {
  [key: string]: unknown;
}

// ==================== Auth Types ====================

export interface UserProfileResponse {
  user_id: number;
  avatar_url: string | null;
  bio: string | null;
  timezone: string;
  notification_preferences: string;
  theme_preference: string;
  zerodha_buy_threshold: number;
  indmoney_buy_threshold: number;
  created_at: string;
  updated_at: string;
}

export interface UserResponse {
  id: number;
  email: string;
  username: string;
  full_name: string | null;
  role: string;
  is_active: boolean;
  is_verified: boolean;
  created_at: string;
  updated_at: string;
  last_login: string | null;
  profile: UserProfileResponse | null;
}

export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  user: UserResponse;
  expires_in: number;
}

export interface RegisterResponse {
  id: number;
  email: string;
  username: string;
  message: string;
}

export interface RefreshTokenRequest {
  refresh_token: string;
}

export interface RefreshTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

export interface UserRegisterRequest {
  email: string;
  username: string;
  password: string;
  full_name?: string | null;
}

export interface UserLoginRequest {
  email?: string | null;
  username?: string | null;
  password: string;
}

export interface UpdatePasswordRequest {
  current_password: string;
  new_password: string;
  confirm_password: string;
}

export interface UpdateProfileRequest {
  full_name?: string | null;
  avatar_url?: string | null;
  bio?: string | null;
  timezone?: string | null;
  notification_preferences?: string | null;
  theme_preference?: string | null;
  zerodha_buy_threshold?: number | null;
  indmoney_buy_threshold?: number | null;
}

// ==================== Prompt Types ====================

export interface PromptResponse {
  id: number;
  user_id: number | null;
  source_prompt_id: number | null;
  name: string;
  description: string | null;
  body: string;
  version: number;
  is_system: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface PromptCreate {
  name: string;
  description?: string;
  body: string;
  is_system?: boolean;
  source_prompt_id?: number;
}

export interface PromptUpdate {
  name?: string;
  description?: string;
  body?: string;
  is_active?: boolean;
}

// ==================== Provider Types ====================

export type ProviderInternetAccessMode =
  | "always_enabled"
  | "tool_auto"
  | "conditional"
  | "none";

export interface ProviderInternetAccess {
  mode: ProviderInternetAccessMode;
  label: string;
  force_token?: string | null;
  caveat?: string | null;
}

export interface ProviderInfo {
  name: string;
  models: string[];
  configured: boolean;
  internet_access: ProviderInternetAccess;
  model_estimated_cost_usd?: Record<string, number>;
  model_estimated_cost_inr?: Record<string, number>;
  fx?: {
    pair: 'USD/INR';
    value: number | null;
    source: string | null;
    as_of: string | null;
    age_seconds: number | null;
    stale_after_seconds: number;
    status: 'valid' | 'stale' | 'unavailable';
  };
  model_compatibility?: Record<string, { compatible: boolean; reason?: string | null }>;
  compatible_models?: string[];
  model_last_run_web_search_used?: Record<string, boolean | null>;
  model_last_run_web_search_queries?: Record<string, string[]>;
  model_last_run_web_sources?: Record<string, string[]>;
}

export interface ProviderModelTarget {
  provider: string;
  model: string;
}

export interface PolymarketEventEvidenceOptions {
  require_fresh_internet_evidence: boolean;
  allow_evidence_grounded_non_web_models: boolean;
}

export interface Stage2FieldProvenance {
  source?: string | null;
  fetched_at_utc?: string | null;
  validation_status?: string | null;
  notes?: string[] | null;
}

export interface Stage2EvidenceSource {
  source_id: string;
  title?: string | null;
  url?: string | null;
  publisher?: string | null;
  domain?: string | null;
  published_at?: string | null;
  fetched_at?: string | null;
  source_type?: string | null;
  relevance_score?: number | null;
  entity_match?: boolean | null;
  event_date_match?: boolean | null;
  resolution_criterion_match?: boolean | null;
  is_generic_landing_page?: boolean | null;
  snippet?: string | null;
  extracted_claims?: string[] | null;
  source_warning?: string | null;
  content_fingerprint?: string | null;
}

export interface Stage2EvidenceClaim {
  claim_id: string;
  claim_text: string;
  supporting_source_ids?: string[] | null;
  contradicting_source_ids?: string[] | null;
  verification_status?: string | null;
  confidence?: number | null;
}

export interface EvidencePacketV2 {
  schema_version?: number | null;
  built_at_utc: string;
  event_id: string;
  exact_resolution_question?: string | null;
  search_objective?: string | null;
  queries: string[];
  sources: Stage2EvidenceSource[];
  claims: Stage2EvidenceClaim[];
  warnings: string[];
  sufficiency_status?: string | null;
  legacy_preflight_evidence_block?: string | null;
}

export interface Stage2MarketContext {
  schema_version?: number | null;
  event_id: string;
  question_ref?: string | null;
  question_id?: string | null;
  market_id?: string | null;
  condition_id?: string | null;
  question: string;
  canonical_market_url?: string | null;
  canonical_market_slug?: string | null;
  canonical_event_slug?: string | null;
  category?: string | null;
  theme?: string | null;
  outcome_labels?: string[] | null;
  current_yes_odds?: number | null;
  current_no_odds?: number | null;
  best_bid_cents?: number | null;
  best_ask_cents?: number | null;
  spread_cents?: number | null;
  volume_usd?: number | null;
  liquidity_usd?: number | null;
  exact_resolution_rules?: string | null;
  exact_yes_definition?: string | null;
  resolution_source_description?: string | null;
  background_market_context?: string | null;
  background_context_warning?: string | null;
  resolution_timezone_name?: string | null;
  resolution_timezone_iana?: string | null;
  deadline_local?: string | null;
  deadline_utc?: string | null;
  hours_remaining?: number | null;
  deadline_source?: string | null;
  deadline_confidence?: string | null;
  current_time_utc: string;
  rule_quality_status?: string | null;
  url_validation_status?: string | null;
  warnings?: string[] | null;
  field_provenance?: Record<string, Stage2FieldProvenance> | null;
  field_fetched_at?: Record<string, string> | null;
  evidence_packet?: EvidencePacketV2 | null;
  legacy_preflight_evidence_block?: string | null;
}

export interface BullpenRunAuditSummaryItem {
  run_id: string;
  snapshot_id: number;
  snapshot_version: number;
  run_status: string;
  triggered_by: string;
  dry_run: boolean;
  live_execution_requested: boolean;
  live_execution_attempted: boolean;
  started_at: string;
  completed_at?: string | null;
  duration_seconds?: number | null;
  execution_version?: string | null;
  strategy_version?: string | null;
  backend_commit_sha?: string | null;
  frontend_build_sha?: string | null;
  deployment_id?: string | null;
  stage1_status?: string | null;
  stage2_status?: string | null;
  stage3_status?: string | null;
  scanned_candidate_count: number;
  candidate_rows_before_llm: number;
  llm_candidate_count: number;
  llm_configured_call_count: number;
  llm_attempted_call_count: number;
  llm_succeeded_call_count: number;
  llm_failed_call_count: number;
  qualified_candidate_count: number;
  ranked_count: number;
  final_selection_count: number;
  decisions_count: number;
  orders_planned: number;
  orders_submitted: number;
  orders_confirmed: number;
  orders_filled: number;
  orders_permanently_failed: number;
  findings_critical: number;
  findings_high: number;
  findings_medium: number;
  findings_low: number;
  findings_info: number;
  validation_failure_count: number;
  provider_failure_count: number;
  incomplete_data_count: number;
  manual_deficiency_count: number;
  source_kind: "native" | "reconstructed";
  lifecycle_status: "working" | "frozen" | "incomplete";
  audit_status: string;
  completeness_pct: number;
  feedback_status?: "queued" | "processing" | "completed" | "failed" | null;
  feedback_provider?: string | null;
  feedback_model?: string | null;
}

export interface BullpenRunAuditListResponse {
  items: BullpenRunAuditSummaryItem[];
  page: number;
  limit: number;
  total: number;
  total_pages: number;
}

export interface BullpenRunAuditMetadata {
  snapshot_id: number;
  snapshot_version: number;
  snapshot_schema_version: number;
  run_id: string;
  run_status: string;
  triggered_by: string;
  started_at: string;
  completed_at?: string | null;
  duration_seconds?: number | null;
  dry_run: boolean;
  live_execution_requested: boolean;
  live_execution_attempted: boolean;
  execution_version?: string | null;
  strategy_version?: string | null;
  source_kind: "native" | "reconstructed";
  lifecycle_status: "working" | "frozen" | "incomplete";
  audit_status: string;
  completeness_pct: number;
  canonical_bundle_hash?: string | null;
  backend_commit_sha?: string | null;
  frontend_build_sha?: string | null;
  deployment_id?: string | null;
  build_time?: string | null;
  alembic_revision?: string | null;
  settings_hash?: string | null;
  section_index: Record<string, { present: boolean; size_bytes: number }>;
  provenance: Record<string, unknown>;
  missing_fields: Array<Record<string, unknown> | string>;
}

export interface BullpenRunAuditFinding {
  id: number;
  code: string;
  rule_version: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  stage: string;
  category: string;
  title: string;
  explanation: string;
  observed_value?: string | null;
  expected_value?: string | null;
  blocking: boolean;
  classification: string;
  suggested_remediation?: string | null;
  evidence_pointers: unknown[];
  detection_metadata: Record<string, unknown>;
  resolution_status: string;
  resolution_remark?: string | null;
  created_at: string;
  updated_at: string;
}

export interface BullpenRunAuditRemark {
  id: number;
  scope_type: string;
  scope_id?: string | null;
  remark_type: string;
  body: string;
  author_label?: string | null;
  metadata: Record<string, unknown>;
  supersedes_remark_id?: number | null;
  created_at: string;
  updated_at: string;
}

export interface BullpenRunAuditManualCheck {
  id: number;
  check_key: string;
  check_label: string;
  status: "unchecked" | "pass" | "fail" | "not_applicable";
  scope_type: string;
  scope_id?: string | null;
  description?: string | null;
  remark?: string | null;
  metadata: Record<string, unknown>;
  supersedes_check_id?: number | null;
  created_at: string;
  updated_at: string;
}

export interface BullpenRunAuditFeedbackSummary {
  id: number;
  status: "queued" | "processing" | "completed" | "failed";
  provider: string;
  model: string;
  prompt_version: string;
  prompt_hash: string;
  report_version: string;
  chunk_count: number;
  chunk_coverage_pct: number;
  snapshot_hash?: string | null;
  tokens_in: number;
  tokens_out: number;
  estimated_cost: number;
  latency_seconds: number;
  error_message?: string | null;
  codex_prompt?: string | null;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
}

export interface BullpenRunAuditFeedbackSubcall {
  id: number;
  chunk_index: number;
  section_keys: unknown[];
  status: string;
  provider: string;
  model: string;
  prompt_hash: string;
  parsed_output?: Record<string, unknown> | null;
  tokens_in: number;
  tokens_out: number;
  estimated_cost: number;
  latency_seconds: number;
  coverage_pct: number;
  error_message?: string | null;
  created_at: string;
  updated_at: string;
}

export interface BullpenRunAuditFeedbackDetail extends BullpenRunAuditFeedbackSummary {
  report_json: Record<string, unknown>;
  subcalls: BullpenRunAuditFeedbackSubcall[];
}

export interface BullpenRunAuditDetailResponse {
  snapshot: BullpenRunAuditMetadata;
  findings_summary: Record<string, number>;
  findings: BullpenRunAuditFinding[];
  latest_manual_checks: BullpenRunAuditManualCheck[];
  manual_check_history: BullpenRunAuditManualCheck[];
  remarks: BullpenRunAuditRemark[];
  feedback_history: BullpenRunAuditFeedbackSummary[];
  available_sections: string[];
}

export interface BullpenRunAuditSectionResponse {
  run_id: string;
  snapshot_id: number;
  canonical_bundle_hash?: string | null;
  section: string;
  data: unknown;
}

export interface BullpenRunAuditMaterializeResponse {
  status: string;
  snapshot: BullpenRunAuditMetadata;
}

export interface BullpenRunAuditRemarkCreateRequest {
  scope_type: string;
  scope_id?: string | null;
  remark_type?: string;
  body: string;
  metadata?: Record<string, unknown>;
  supersedes_remark_id?: number | null;
}

export interface BullpenRunAuditManualCheckUpdateRequest {
  check_key: string;
  status: "unchecked" | "pass" | "fail" | "not_applicable";
  scope_type?: string;
  scope_id?: string | null;
  remark?: string | null;
  metadata?: Record<string, unknown>;
}

export interface BullpenRunAuditFeedbackCreateRequest {
  provider: string;
  model: string;
  force_rerun?: boolean;
}

export interface PolymarketEventQuestionPayload {
  question_ref: string;
  question_id: string;
  market_id?: string | null;
  condition_id?: string | null;
  question: string;
  close_time?: string | null;
  closing_time?: string | null;
  close_time_et?: string | null;
  current_time_utc: string;
  current_time_et: string;
  deadline_et?: string | null;
  hours_remaining?: number | null;
  deadline_source?: string | null;
  title_date_hint?: string | null;
  title_deadline_et_assumption?: string | null;
  category: string;
  outcomes: string[];
  current_yes_odds?: number | null;
  current_no_odds?: number | null;
  market_url?: string | null;
  slug?: string | null;
  market_slug?: string | null;
  event_slug?: string | null;
  polymarket_rules?: string | null;
  polymarket_market_context?: string | null;
  polymarket_resolution_source?: string | null;
  preflight_evidence_block?: string | null;
  evidence_packet_v2?: EvidencePacketV2 | null;
  stage2_context?: Stage2MarketContext | null;
}

export type BullpenLlmExecutionMode =
  | "chunked_parallel"
  | "single_combined";

export interface BullpenLlmExecutionOptions {
  execution_mode: BullpenLlmExecutionMode;
  events_per_prompt: number;
  max_concurrent_requests: number;
  target_count: number;
  prompt_template_hash?: string | null;
}

export interface PreparedPolymarketEventContext {
  question_payload: PolymarketEventQuestionPayload[];
  runtime_metadata: Record<string, unknown>;
}

export interface PolymarketEventRunContext {
  kind: "polymarket_bullpen_event";
  prompt_template: string;
  question_payload: PolymarketEventQuestionPayload[];
  evidence_options: PolymarketEventEvidenceOptions;
  execution_options?: BullpenLlmExecutionOptions;
  prepared_context?: PreparedPolymarketEventContext | null;
}

export interface PolymarketEventQuestionRuntimeMetadata {
  question_ref?: string | null;
  question_id?: string | null;
  question?: string | null;
  web_search_used?: boolean | null;
  web_search_queries?: string[] | null;
  web_sources?: string[] | null;
  evidence_block_used?: boolean | null;
  internet_verified?: boolean | null;
  stale_fact_detected?: boolean | null;
  invalid_reason?: string | null;
  preflight_evidence_block?: string | null;
  stage2_context?: Stage2MarketContext | null;
  evidence_packet_v2?: EvidencePacketV2 | null;
  status?: string | null;
  diagnostic?: Record<string, unknown> | null;
  rule_quality_status?: string | null;
  rule_fail_reason?: string | null;
}

export interface PolymarketEventRuntimeMetadata {
  kind?: string | null;
  require_fresh_internet_evidence?: boolean | null;
  allow_evidence_grounded_non_web_models?: boolean | null;
  web_search_used?: boolean | null;
  web_search_queries?: string[] | null;
  web_sources?: string[] | null;
  evidence_block_used?: boolean | null;
  internet_verified?: boolean | null;
  stale_fact_detected?: boolean | null;
  invalid_reason?: string | null;
  model_side_search_used?: boolean | null;
  question_runtime?: Record<string, PolymarketEventQuestionRuntimeMetadata> | null;
  canonical_stage2_contexts?: Record<string, Stage2MarketContext> | null;
  schema_version?: number | null;
  warnings?: string[] | null;
}

export interface PortfolioEventRunRequest {
  provider?: string | null;
  model?: string | null;
  auto_rebalance_portfolio?: AutoRebalancePortfolioKey | null;
  auto_rebalance_sequence?: number | null;
  auto_rebalance_label?: string | null;
}

export interface ApiUsageItem {
  name: string;
  category: string;
  configured: boolean;
  daily_requests: number;
  daily_tokens_in: number;
  daily_tokens_out: number;
  daily_estimated_cost: number;
  daily_estimated_cost_inr: number | null;
  daily_limit_requests: number | null;
  notes: string | null;
  console_url: string | null;
  gemini_key_index?: number | null;
  gemini_key_masked?: string | null;
  gemini_key_in_use?: boolean;
  gemini_key_consumed?: boolean;
  gemini_key_hidden_default?: boolean;
}


export interface LlmCostHistoryDay {
  date: string;
  estimated_cost: number;
  estimated_cost_inr: number | null;
  requests: number;
  tokens_in: number;
  tokens_out: number;
}

export interface LlmCostHistoryRun {
  job_id: number;
  model: string;
  status: string;
  timestamp: string;
  estimated_cost: number;
  estimated_cost_inr: number | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
}

export interface LlmCostHistoryResponse {
  provider: string;
  name: string;
  timezone: string;
  usd_inr_rate: number | null;
  fx_source: string | null;
  fx_as_of: string | null;
  fx_age_seconds: number | null;
  fx_status: 'valid' | 'stale' | 'unavailable';
  fx_stale_after_seconds: number;
  generated_at: string;
  day_limit: number;
  run_limit: number;
  days: LlmCostHistoryDay[];
  runs: LlmCostHistoryRun[];
  total_runs: number;
  has_more_days: boolean;
  has_more_runs: boolean;
}

export interface ApiUsageSummaryResponse {
  timezone: string;
  date: string;
  period?: 'today' | 'week' | 'month' | 'custom' | string;
  period_label?: string;
  from_date?: string | null;
  to_date?: string | null;
  usd_inr_rate?: number | null;
  fx_source?: string | null;
  fx_as_of?: string | null;
  fx_age_seconds?: number | null;
  fx_status?: 'valid' | 'stale' | 'unavailable';
  fx_stale_after_seconds?: number;
  items: ApiUsageItem[];
}


export interface LlmScanPerformanceItem {
  job_id: number;
  run_id?: number | null;
  stage?: number | null;
  scan_type: string;
  provider: string;
  model: string;
  status: string;
  processing_passed?: boolean | null;
  sheet_export_passed?: boolean | null;
  export_status?: string | null;
  created_at: string;
  updated_at: string;
  exported_at?: string | null;
  time_taken_ms?: number | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  estimated_cost?: number | null;
  error_message?: string | null;
  export_error?: string | null;
}

export interface LlmScanSummary {
  scan_type: string;
  total_scans: number;
  processing_passed: number;
  processing_failed: number;
  sheet_export_passed: number;
  sheet_export_failed: number;
  total_cost: number;
  avg_time_taken_ms?: number | null;
}

export interface LlmPerformanceGroup {
  provider: string;
  model: string;
  llm_key: string;
  total_scans: number;
  processing_passed: number;
  processing_failed: number;
  sheet_export_passed: number;
  sheet_export_failed: number;
  total_cost: number;
  avg_time_taken_ms?: number | null;
  scan_summaries: LlmScanSummary[];
  scans: LlmScanPerformanceItem[];
}

export interface LlmPerformanceResponse {
  total_llms: number;
  total_scans: number;
  generated_at: string;
  groups: LlmPerformanceGroup[];
}

// ==================== Job Types ====================

export interface JobCreate {
  prompt: string;
  provider: string;
  model: string;
  scheduled_at?: string | null;
}

export interface JobResponse {
  id: number;
  prompt: string;
  response: string | null;
  error_message?: string | null;
  provider: string;
  model: string;
  status: string;
  tokens_in?: number | null;
  tokens_out?: number | null;
  estimated_cost?: number | null;
  web_search_used?: boolean | null;
  web_search_queries?: string[] | null;
  web_sources?: string[] | null;
  request_context_json?: PolymarketEventRunContext | Record<string, unknown> | null;
  runtime_metadata_json?: PolymarketEventRuntimeMetadata | Record<string, unknown> | null;
  export_status?: string | null;
  export_error?: string | null;
  exported_at?: string | null;
  exported_sheet_url?: string | null;
  auto_rebalance_portfolio?: AutoRebalancePortfolioKey | null;
  auto_rebalance_sequence?: number | null;
  auto_rebalance_label?: string | null;
  scheduled_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobListResponse {
  jobs?: JobResponse[];
  [key: string]: unknown;
}

// ==================== Run Types (Multi-LLM Fan-Out) ====================

export interface RunModelTarget {
  provider: string;
  model: string;
}

export type AutoRebalancePortfolioKey = 'india' | 'indmoney_us';

export interface AutoRebalanceRunReservationResponse {
  portfolio: AutoRebalancePortfolioKey;
  sequence: number;
  label: string;
}

export interface AutoRebalanceRunMetadata {
  auto_rebalance_portfolio: AutoRebalancePortfolioKey;
  auto_rebalance_sequence: number;
  auto_rebalance_label: string;
}

export interface AutoRebalanceCompletionEmailRequest {
  portfolio: AutoRebalancePortfolioKey;
  sequence: number;
  label: string;
  completed_at: string;
  total_cost_inr?: number | null;
  total_llm_time?: string | null;
  stages_completed?: string[];
}

export type AutoRebalanceStageKey =
  | 'sync'
  | 'threats'
  | 'swing'
  | 'rebalance'
  | 'technical'
  | 'actionables';

export type AutoRebalanceStageStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'skipped'
  | 'paused'
  | 'cancelled'
  | 'interrupted';

export interface AutoRebalanceStageUpdateRequest {
  status: AutoRebalanceStageStatus;
  run_id?: number | null;
  job_id?: number | null;
  summary?: Record<string, unknown>;
  error_message?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface AutoRebalanceStageResponse {
  stage: AutoRebalanceStageKey;
  status: string;
  run_id?: number | null;
  job_id?: number | null;
  summary: Record<string, unknown>;
  error_message?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  provider_count: number;
  completed_provider_count: number;
  failed_provider_count: number;
  estimated_cost: number;
}

export interface AutoRebalanceJobDetailResponse {
  id: number;
  provider: string;
  model: string;
  status: string;
  prompt: string;
  response?: string | null;
  error_message?: string | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  estimated_cost?: number | null;
  web_search_used?: boolean | null;
  web_search_queries?: string[] | null;
  web_sources?: string[] | null;
  runtime_metadata_json?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface AutoRebalanceRunDetailResponse {
  id: number;
  status: string;
  prompt: string;
  created_at: string;
  updated_at: string;
  jobs: AutoRebalanceJobDetailResponse[];
}

export interface AutoRebalanceHistoryItemResponse {
  portfolio: AutoRebalancePortfolioKey;
  sequence: number;
  label: string;
  status: string;
  current_stage?: AutoRebalanceStageKey | null;
  error_message?: string | null;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
  total_estimated_cost: number;
  stages: AutoRebalanceStageResponse[];
}

export interface AutoRebalanceHistoryListResponse {
  items: AutoRebalanceHistoryItemResponse[];
  total: number;
}

export interface AutoRebalanceHistoryDetailResponse
  extends AutoRebalanceHistoryItemResponse {
  runs: AutoRebalanceRunDetailResponse[];
  standalone_jobs: AutoRebalanceJobDetailResponse[];
}

export interface RunCreate {
  prompt: string;
  targets: RunModelTarget[];
  polymarket_event_context?: PolymarketEventRunContext | null;
  prompt_id?: number | null;
  scheduled_at?: string | null;
  auto_export_enabled?: boolean;
  export_spreadsheet_url?: string | null;
  export_sheet_name?: string | null;
  export_investment_amount?: string | null;
  export_title?: string | null;
  allow_parallel?: boolean;
  auto_rebalance_portfolio?: AutoRebalancePortfolioKey | null;
  auto_rebalance_sequence?: number | null;
  auto_rebalance_label?: string | null;
}

export interface RunJobResponse {
  id: number;
  run_id: number;
  job_id: number;
  stage: number;
  job: JobResponse;
}

export interface RunListJobResponse {
  id: number;
  provider: string;
  model: string;
  status: string;
  error_message?: string | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  estimated_cost?: number | null;
  request_context_json?: PolymarketEventRunContext | Record<string, unknown> | null;
  export_status?: string | null;
  export_error?: string | null;
  exported_at?: string | null;
  exported_sheet_url?: string | null;
  auto_rebalance_portfolio?: AutoRebalancePortfolioKey | null;
  auto_rebalance_sequence?: number | null;
  auto_rebalance_label?: string | null;
  scheduled_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunListJobLinkResponse {
  id: number;
  run_id: number;
  job_id: number;
  stage: number;
  job: RunListJobResponse;
}

export interface RunResponse {
  id: number;
  prompt: string;
  prompt_id: number | null;
  status: string;
  current_stage: number;
  run_jobs: RunJobResponse[];
  synthesis_response: string | null;
  decision_response: string | null;
  auto_export_enabled: boolean;
  export_spreadsheet_url: string | null;
  export_sheet_name: string | null;
  export_investment_amount: string | null;
  export_title: string | null;
  export_status: string | null;
  export_error: string | null;
  exported_at: string | null;
  exported_sheet_url: string | null;
  auto_rebalance_portfolio?: AutoRebalancePortfolioKey | null;
  auto_rebalance_sequence?: number | null;
  auto_rebalance_label?: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunListItem {
  id: number;
  prompt_preview: string;
  prompt_id: number | null;
  status: string;
  current_stage: number;
  run_jobs: RunListJobLinkResponse[];
  auto_export_enabled: boolean;
  export_status: string | null;
  export_error: string | null;
  exported_at: string | null;
  exported_sheet_url: string | null;
  auto_rebalance_portfolio?: AutoRebalancePortfolioKey | null;
  auto_rebalance_sequence?: number | null;
  auto_rebalance_label?: string | null;
  created_at: string;
  updated_at: string;
}

// ==================== Validation Error Types ====================

export interface ValidationError {
  loc: (string | number)[];
  msg: string;
  type: string;
  input?: unknown;
  ctx?: Record<string, unknown>;
}

export interface HTTPValidationError {
  detail?: ValidationError[];
}

// ==================== Zerodha Types ====================

export interface ZerodhaLoginUrlResponse {
  login_url: string;
  configured: boolean;
  direct_market_orders_enabled?: boolean;
}

export interface ZerodhaStatusResponse {
  connected: boolean;
  direct_market_orders_enabled?: boolean;
  login_time: string | null;
  expires_at: string | null;
  last_portfolio_sync_at?: string | null;
  last_portfolio_snapshot_date?: string | null;
}

export interface ZerodhaPortfolioHolding {
  tradingsymbol: string;
  exchange: string;
  instrument_token: number | null;
  isin: string | null;
  product: string | null;
  quantity: number;
  used_quantity: number;
  t1_quantity: number;
  realised_quantity: number;
  authorised_quantity: number;
  authorised_date: string | null;
  opening_quantity: number;
  short_quantity: number;
  collateral_quantity: number;
  collateral_type: string | null;
  discrepancy: boolean;
  average_price: number;
  last_price: number;
  close_price: number;
  pnl: number;
  day_change: number;
  day_change_percentage: number;
  market_value: number;
  invested_value: number;
  day_change_value: number;
}

export interface ZerodhaPortfolioPosition {
  tradingsymbol: string;
  exchange: string;
  instrument_token: number | null;
  product: string | null;
  quantity: number;
  overnight_quantity: number;
  multiplier: number;
  average_price: number;
  close_price: number;
  last_price: number;
  value: number;
  pnl: number;
  m2m: number;
  unrealised: number;
  realised: number;
  buy_quantity: number;
  buy_price: number;
  buy_value: number;
  buy_m2m: number;
  sell_quantity: number;
  sell_price: number;
  sell_value: number;
  sell_m2m: number;
  day_buy_quantity: number;
  day_buy_price: number;
  day_buy_value: number;
  day_sell_quantity: number;
  day_sell_price: number;
  day_sell_value: number;
}

export interface ZerodhaPortfolioSnapshotSummary {
  snapshot_date: string;
  captured_at: string;
  source: string;
  holdings_count: number;
  net_positions_count: number;
  day_positions_count: number;
  holdings_market_value: number;
  holdings_invested_value?: number | null;
  holdings_pnl: number;
  holdings_day_change_value: number;
  available_margin: number;
  positions_pnl: number;
  positions_m2m: number;
}

export interface ZerodhaPortfolioSnapshotDetail extends ZerodhaPortfolioSnapshotSummary {
  holdings: ZerodhaPortfolioHolding[];
  positions: {
    net: ZerodhaPortfolioPosition[];
    day: ZerodhaPortfolioPosition[];
  };
}

export interface ZerodhaPortfolioOverviewResponse {
  latest: ZerodhaPortfolioSnapshotDetail | null;
  history: ZerodhaPortfolioSnapshotSummary[];
}

export interface ZerodhaPortfolioSyncResponse {
  status: string;
  message: string;
  snapshot_date: string;
  task_id: string | null;
}

// ==================== INDmoney US Types ====================

export interface IndMoneyUsPortfolioSnapshotCreateRequest {
  raw_text: string;
  captured_at?: string | null;
}

export interface IndMoneyUsMarketIndex {
  name: string;
  value: number | null;
  change_value: number | null;
  change_percent: number | null;
  raw_change_text: string | null;
}

export interface IndMoneyUsHolding {
  company_name: string;
  symbol: string;
  market_price: number | null;
  market_change_percent: number | null;
  invested_value: number | null;
  quantity: number | null;
  average_price: number | null;
  current_value: number | null;
  total_pnl: number | null;
  total_pnl_percent: number | null;
  portfolio_weight_percent: number | null;
  price_vs_average_percent: number | null;
}

export interface IndMoneyUsReconciliationItem {
  label: string;
  summary_value: number | null;
  parsed_value: number | null;
  delta: number | null;
}

export interface IndMoneyUsDerivedAnalytics {
  parsed_holdings_current_value: number;
  parsed_holdings_invested_value: number;
  parsed_holdings_total_pnl: number;
  profitable_holdings_count: number;
  loss_making_holdings_count: number;
  top_allocations: IndMoneyUsHolding[];
  top_gainers: IndMoneyUsHolding[];
  top_laggards: IndMoneyUsHolding[];
  reconciliation: IndMoneyUsReconciliationItem[];
}

export interface IndMoneyUsPortfolioSnapshotSummary {
  id: number;
  snapshot_date: string;
  captured_at: string;
  source: string;
  parse_status: string;
  parse_warnings: string[];
  holdings_count: number;
  reported_holdings_count: number | null;
  indices_count: number;
  wallet_balance: number | null;
  current_value: number | null;
  invested_value: number | null;
  day_return_value: number | null;
  day_return_percent: number | null;
  total_return_value: number | null;
  total_return_percent: number | null;
}

export interface IndMoneyUsPortfolioSnapshotDetail extends IndMoneyUsPortfolioSnapshotSummary {
  raw_text: string;
  market_indices: IndMoneyUsMarketIndex[];
  holdings: IndMoneyUsHolding[];
  derived: IndMoneyUsDerivedAnalytics;
}

export interface IndMoneyUsPortfolioOverviewResponse {
  latest: IndMoneyUsPortfolioSnapshotDetail | null;
  history: IndMoneyUsPortfolioSnapshotSummary[];
}

export interface DashboardSectionMeta {
  status: 'ok' | 'unavailable';
  duration_ms: number;
  fresh_at: string | null;
  error: string | null;
}

export interface DashboardHistoryPoint {
  captured_at: string;
  value: number;
}

export interface DashboardHolding {
  symbol: string;
  company_name: string | null;
  current_value: number;
  invested_value: number;
  pnl: number;
  pnl_percent: number;
  weight_percent: number | null;
}

export interface DashboardSummaryResponse {
  schema_version: 1;
  generated_at: string;
  usd_inr_rate: number | null;
  usd_inr_source: string | null;
  usd_inr_as_of: string | null;
  usd_inr_age_seconds: number | null;
  usd_inr_status: 'valid' | 'stale' | 'unavailable';
  fx: {
    pair: 'USD/INR';
    value: number | null;
    source: string | null;
    as_of: string | null;
    age_seconds: number | null;
    stale_after_seconds: number;
    status: 'valid' | 'stale' | 'unavailable';
  };
  zerodha: {
    connected: boolean;
    login_time: string | null;
    expires_at: string | null;
    snapshot: {
      snapshot_date: string;
      captured_at: string;
      source: string;
      holdings_count: number;
      holdings_market_value: number;
      holdings_invested_value: number | null;
      holdings_pnl: number;
      holdings_day_change_value: number;
      available_margin: number;
      top_holdings: DashboardHolding[];
      history: DashboardHistoryPoint[];
    } | null;
  } | null;
  indmoney_us: {
    snapshot: {
      snapshot_date: string;
      captured_at: string;
      source: string;
      parse_status: string;
      holdings_count: number;
      wallet_balance: number | null;
      current_value: number | null;
      invested_value: number | null;
      day_return_value: number | null;
      day_return_percent: number | null;
      total_return_value: number | null;
      total_return_percent: number | null;
      top_holdings: DashboardHolding[];
      history: DashboardHistoryPoint[];
    } | null;
  } | null;
  bullpen: {
    active_count: number;
    claimable_count: number;
    claimable_value: number;
    cash_balance: number | null;
    total_value: number | null;
    unrealized_pnl: number | null;
    wallet_value: number | null;
    fetched_at: string | null;
    source: 'redis-cache';
  } | null;
  portfolio_history: {
    india: DashboardHistoryPoint[];
    indmoney: DashboardHistoryPoint[];
    bullpen: DashboardHistoryPoint[];
    combined: DashboardHistoryPoint[];
  };
  sections: Record<string, DashboardSectionMeta>;
}

export interface IndMoneyUsCurrentPriceQuoteRequest {
  exchange: string;
  symbol: string;
}

export interface IndMoneyUsCurrentPricesRequest {
  quotes: IndMoneyUsCurrentPriceQuoteRequest[];
}

export interface IndMoneyUsCurrentPriceQuote {
  exchange: string;
  symbol: string;
  company_name: string | null;
  currency: string | null;
  current_price: number | null;
  previous_close: number | null;
  change_value: number | null;
  change_percent: number | null;
  market_open: boolean;
  session_open_at: string | null;
  session_close_at: string | null;
  error_message: string | null;
}

export interface IndMoneyUsCurrentPricesResponse {
  quotes: IndMoneyUsCurrentPriceQuote[];
  market_open: boolean;
  fetched_at: string;
}

export interface PortfolioEventTable {
  columns: string[];
  rows: Record<string, string>[];
  raw_markdown: string;
}

export interface PortfolioAnalysisHistoryItem {
  job_id: number;
  run_id?: number | null;
  status: string;
  provider: string;
  model: string;
  snapshot_date: string | null;
  captured_at: string | null;
  created_at: string;
  updated_at: string;
  estimated_cost?: number | null;
  error_message?: string | null;
  auto_rebalance_portfolio?: AutoRebalancePortfolioKey | null;
  auto_rebalance_sequence?: number | null;
  auto_rebalance_label?: string | null;
}

export interface ZerodhaEventsAnalysis {
  job_id: number;
  status: string;
  provider: string;
  model: string;
  snapshot_date: string | null;
  captured_at: string | null;
  created_at: string;
  updated_at: string;
  tokens_in?: number | null;
  tokens_out?: number | null;
  estimated_cost?: number | null;
  error_message?: string | null;
  table?: PortfolioEventTable | null;
}

export interface ZerodhaEventsLatestResponse {
  analysis: ZerodhaEventsAnalysis | null;
}

export interface ZerodhaEventsHistoryResponse {
  history: PortfolioAnalysisHistoryItem[];
}

export interface ZerodhaEventsRunResponse {
  job_id: number;
  status: string;
  provider: string;
  model: string;
  snapshot_date: string;
  captured_at: string;
  created_at: string;
}

export interface IndMoneyUsEventsAnalysis {
  job_id: number;
  status: string;
  provider: string;
  model: string;
  snapshot_id: number | null;
  snapshot_date: string | null;
  captured_at: string | null;
  created_at: string;
  updated_at: string;
  tokens_in?: number | null;
  tokens_out?: number | null;
  estimated_cost?: number | null;
  error_message?: string | null;
  table?: PortfolioEventTable | null;
}

export interface IndMoneyUsEventsLatestResponse {
  analysis: IndMoneyUsEventsAnalysis | null;
}

export interface IndMoneyUsEventsHistoryResponse {
  history: PortfolioAnalysisHistoryItem[];
}

export interface IndMoneyUsEventsRunResponse {
  job_id: number;
  status: string;
  provider: string;
  model: string;
  snapshot_id: number;
  snapshot_date: string;
  captured_at: string;
  created_at: string;
}

export type IndMoneyUsThreatSummary = ZerodhaThreatSummary;
export type IndMoneyUsThreatKeyValueItem = ZerodhaThreatKeyValueItem;
export type IndMoneyUsThreatTableSection = ZerodhaThreatTableSection;
export type IndMoneyUsThreatReport = ZerodhaThreatReport;

export interface IndMoneyUsThreatAnalysis {
  job_id: number;
  status: string;
  provider: string;
  model: string;
  snapshot_id: number | null;
  snapshot_date: string | null;
  captured_at: string | null;
  created_at: string;
  updated_at: string;
  tokens_in?: number | null;
  tokens_out?: number | null;
  estimated_cost?: number | null;
  error_message?: string | null;
  report?: IndMoneyUsThreatReport | null;
}

export interface IndMoneyUsThreatLatestResponse {
  analysis: IndMoneyUsThreatAnalysis | null;
}

export interface IndMoneyUsThreatHistoryResponse {
  history: PortfolioAnalysisHistoryItem[];
}

export interface IndMoneyUsThreatRunResponse {
  job_id: number;
  status: string;
  provider: string;
  model: string;
  snapshot_id: number;
  snapshot_date: string;
  captured_at: string;
  created_at: string;
}

export interface ZerodhaOrder {
  order_id: string;
  tradingsymbol: string;
  exchange: string;
  transaction_type: string;
  order_type: string;
  quantity: number;
  status: string;
  price: number;
  average_price: number;
  product: string;
  validity: string;
  placed_by: string;
  tag: string | null;
  order_timestamp: string | null;
  exchange_timestamp?: string | null;
  exchange_update_timestamp?: string | null;
  filled_quantity: number;
  pending_quantity: number;
}


export interface ZerodhaPrepareBasketOrderRequest {
  tradingsymbol: string;
  exchange: string;
  transaction_type: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  last_price?: number | null;
}

export interface ZerodhaPrepareBasketRequest {
  orders: ZerodhaPrepareBasketOrderRequest[];
}

export interface ZerodhaPreparedBasketOrder {
  tradingsymbol: string;
  exchange: string;
  transaction_type: 'BUY' | 'SELL';
  quantity: number;
  requested_price: number;
  price: number;
  last_price: number;
  tick_size: number;
  lower_circuit_limit?: number | null;
  upper_circuit_limit?: number | null;
  adjusted: boolean;
  reasons: string[];
}

export interface ZerodhaPrepareBasketResponse {
  orders: ZerodhaPreparedBasketOrder[];
  adjusted_count: number;
}

export interface ZerodhaPlaceOrderRequest {
  tradingsymbol: string;
  exchange: string;
  transaction_type: 'BUY' | 'SELL';
  order_type: 'MARKET' | 'LIMIT' | 'SL' | 'SL-M';
  quantity: number;
  product: string;
  validity?: string;
  price?: number;
  trigger_price?: number;
  market_protection?: number;
  variety?: 'regular' | 'amo';
  auto_amo_when_closed?: boolean;
}

export interface ZerodhaPlaceOrderResponse {
  order_id: string;
  variety?: 'regular' | 'amo';
  market_open?: boolean;
  auto_converted_to_amo?: boolean;
}

export interface ZerodhaProtectedMarketOrderRequest {
  tradingsymbol: string;
  exchange: 'NSE' | 'BSE';
  transaction_type: 'BUY' | 'SELL';
  quantity: number;
  product?: 'CNC';
  validity?: 'DAY';
  market_protection?: string;
  estimated_price?: number;
  last_price?: number;
}

export interface ZerodhaProtectedMarketRequest {
  orders: ZerodhaProtectedMarketOrderRequest[];
}

export interface ZerodhaProtectedMarketOrderResult {
  tradingsymbol: string;
  exchange: string;
  transaction_type: 'BUY' | 'SELL';
  quantity: number;
  status: 'placed' | 'failed' | 'skipped';
  order_id?: string | null;
  average_price?: number | null;
  error?: string | null;
}

export interface ZerodhaProtectedMarketResponse {
  results: ZerodhaProtectedMarketOrderResult[];
  placed_count: number;
  failed_count: number;
}

export interface ZerodhaSequencedProtectedMarketRequest extends ZerodhaProtectedMarketRequest {
  sell_first?: boolean;
  wait_for_sell_completion?: boolean;
  sell_wait_timeout_seconds?: number;
  poll_interval_seconds?: number;
  safety_buffer_amount?: number;
}

export interface ZerodhaSequencedProtectedMarketResponse {
  sell_results: ZerodhaProtectedMarketOrderResult[];
  buy_results: ZerodhaProtectedMarketOrderResult[];
  skipped_buy_results: ZerodhaProtectedMarketOrderResult[];
  placed_count: number;
  failed_count: number;
  skipped_count: number;
  sell_phase_complete: boolean;
  buy_phase_attempted: boolean;
  refreshed_available_margin?: number | null;
  messages: string[];
}


export interface ZerodhaThreatSummary {
  main_portfolio_risk: string | null;
  biggest_weakness: string | null;
  biggest_near_term_threat: string | null;
  biggest_position_size_risk: string | null;
  biggest_profit_protection_candidate: string | null;
  biggest_weak_drag_position: string | null;
}

export interface ZerodhaThreatKeyValueItem {
  label: string;
  value: string;
}

export interface ZerodhaThreatTableSection {
  key: string;
  title: string;
  columns: string[];
  rows: Record<string, string>[];
}

export interface ZerodhaThreatReport {
  summary: ZerodhaThreatSummary;
  summary_items: ZerodhaThreatKeyValueItem[];
  tables: ZerodhaThreatTableSection[];
  bottom_line: ZerodhaThreatKeyValueItem[];
  raw_markdown: string;
}

export interface ZerodhaThreatAnalysis {
  job_id: number;
  status: string;
  provider: string;
  model: string;
  snapshot_date: string | null;
  captured_at: string | null;
  created_at: string;
  updated_at: string;
  tokens_in?: number | null;
  tokens_out?: number | null;
  estimated_cost?: number | null;
  error_message?: string | null;
  report?: ZerodhaThreatReport | null;
}

export interface ZerodhaThreatLatestResponse {
  analysis: ZerodhaThreatAnalysis | null;
}

export interface ZerodhaThreatHistoryResponse {
  history: PortfolioAnalysisHistoryItem[];
}

export interface ZerodhaThreatRunResponse {
  job_id: number;
  status: string;
  provider: string;
  model: string;
  snapshot_date: string;
  captured_at: string;
  created_at: string;
}

// ==================== Google Sheets Types ====================

export interface GoogleSheetsAuthUrlResponse {
  auth_url: string;
  configured: boolean;
  redirect_uri?: string | null;
}

export interface GoogleSheetsStatusResponse {
  connected: boolean;
  token_expiry: string | null;
  default_spreadsheet_url?: string | null;
}

export interface GoogleSheetsAdminConfigResponse {
  configured: boolean;
  client_id?: string | null;
  has_client_secret: boolean;
  redirect_uri: string;
  updated_at?: string | null;
  updated_by_user_id?: number | null;
}

export interface GoogleSheetsAdminConfigUpdateRequest {
  client_id: string;
  client_secret?: string | null;
}

export interface GoogleSheetsDefaultSheetRequest {
  spreadsheet_url?: string | null;
  title?: string | null;
}

export interface GoogleSheetsDefaultSheetResponse {
  spreadsheet_url: string;
  created_new: boolean;
}

export interface GoogleSheetsExportJobRequest {
  job_id: number;
  spreadsheet_url?: string | null;
  sheet_name?: string;
  title?: string;
  investment_amount?: string;
}

export interface GoogleSheetsExportRunRequest {
  run_id: number;
  spreadsheet_url?: string | null;
  sheet_name?: string;
  title?: string;
  investment_amount?: string;
}

export interface GoogleSheetsImportRequest {
  spreadsheet_url: string;
  sheet_name?: string;
}

export interface GoogleSheetsExportResponse {
  status: string;
  message: string;
  spreadsheet_url?: string | null;
  task_id?: string | null;
}

// ==================== Polymarket Types ====================

export interface PolymarketBotConfig {
  paper_trading: boolean;
  live_trading: boolean;
  use_live_reads: boolean;
  auto_execute_live: boolean;
  auto_start: boolean;
  live_unlock_mode: 'automatic' | 'manual';
  require_manual_confirmation: boolean;
  poll_interval_ms: number;
  max_trade_size: number;
  fixed_copy_trade_size: number;
  max_trades_per_day: number;
  max_exposure_per_market: number;
  max_daily_loss: number;
  max_live_trade_size: number;
  max_live_trades_per_day: number;
  trader_invested_threshold_usd: number;
  max_live_daily_loss: number;
  max_live_exposure_per_market: number;
  auto_redeem_live: boolean;
  jurisdiction_confirmation: boolean;
  manual_tracked_wallets: string;
  use_trending_market_activity: boolean;
  paused: boolean;
  max_pending_confirmations: number;
  max_new_live_proposals_per_poll: number;
  max_new_live_proposals_per_trader_per_poll: number;
  max_pending_per_trader: number;
  proposal_cooldown_seconds_per_trader: number;
  min_source_trade_size_usd: number;
  min_copy_price: number;
  max_copy_price: number;
  max_tracked_traders: number;
  tracked_trader_mode: string;
  require_manual_tracked_wallets_for_live: boolean;
  exclude_market_title_regex: string;
  allow_market_title_regex: string;
  exclude_trader_handle_regex: string;
  allow_trader_handle_regex: string;
  data_dir: string;
}


export interface PolymarketTrackedAccount {
  id: string;
  target: string;
  handle?: string | null;
  address: string;
  profile_url?: string | null;
  proxy_wallet?: string | null;
  enabled: boolean;
  threshold_percent: number;
  net_worth_usd: number;
  positions_value_usd?: number | null;
  cash_balance_usd?: number | null;
  redeemable_value_usd?: number | null;
  net_worth_source?: string | null;
  net_worth_checked_at?: string | null;
  net_worth_error?: string | null;
  copy_trade_usd: number;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
}

export interface PolymarketTrackedAccountCreate {
  target: string;
  threshold_percent?: number;
  net_worth_usd?: number;
  copy_trade_usd?: number;
  enabled?: boolean;
}

export interface PolymarketLiveLimitUpdate {
  max_live_trades_per_day: number;
  trader_invested_threshold_usd: number;
  max_live_exposure_per_market: number;
}

export interface PolymarketManualInvestAnalysisLlmOutput {
  provider: string;
  model: string;
  llm_yes_odds?: number | null;
  llm_no_odds?: number | null;
  confidence?: string | null;
  evidence_status?: string | null;
  event_state?: string | null;
  key_evidence: string[];
  red_flags: string[];
  rationale?: string | null;
  completed_at?: string | null;
  raw_output?: string | null;
  prompt_version?: string | null;
}

export interface PolymarketManualInvestAnalysisContext {
  snapshot_id?: string | null;
  snapshot_mode?: string | null;
  scanned_at?: string | null;
  source_label?: string | null;
  source_url?: string | null;
  category?: string | null;
  topic?: string | null;
  event_slug?: string | null;
  event_description?: string | null;
  yes_odds?: number | null;
  no_odds?: number | null;
  volume_usd?: number | null;
  liquidity_usd?: number | null;
  best_bid_cents?: number | null;
  best_ask_cents?: number | null;
  spread_cents?: number | null;
  rules?: string | null;
  market_context?: string | null;
  resolution_source?: string | null;
  llm_yes_odds?: number | null;
  llm_no_odds?: number | null;
  llm_disagreement_level?: string | null;
  llm_disagreement_category?: string | null;
  confidence?: string | null;
  evidence_status?: string | null;
  event_state?: string | null;
  llm_notes?: string | null;
  llm_provider?: string | null;
  llm_model?: string | null;
  llm_completed_at?: string | null;
  preflight_evidence_block?: string | null;
  llm_outputs: PolymarketManualInvestAnalysisLlmOutput[];
}

export interface PolymarketManualInvestOrderRequest {
  question_id: string;
  market_id: string;
  market_title: string;
  outcome: string;
  amount: number;
  price: number;
  event_end_at?: string | null;
  market_url?: string | null;
  analysis_context?: PolymarketManualInvestAnalysisContext | null;
}

export interface PolymarketManualInvestOrderResult {
  question_id: string;
  market_id: string;
  market_title: string;
  outcome: string;
  amount: number;
  price: number;
  status: 'executed' | 'failed' | 'skipped';
  message: string;
  trade_id?: string | null;
  executed_at?: string | null;
}

export interface PolymarketTrackedAccountUpdate {
  target?: string;
  threshold_percent?: number;
  net_worth_usd?: number;
  copy_trade_usd?: number;
  enabled?: boolean;
}

export interface PolymarketTrader {
  id: string;
  name: string;
  address: string;
  handle?: string | null;
  profile_slug?: string | null;
  profile_url?: string | null;
  activity_url?: string | null;
  activity_source?: 'wallet' | 'handle' | 'feed' | 'fallback' | null;
  bullpen_profile_url?: string | null;
  polymarket_profile_url?: string | null;
  volume_24h: number;
  trades_1h: number;
  trades_6h: number;
  trades_24h: number;
  last_trade_at?: string | null;
  last_trade_age?: string | null;
  profit_usd: number;
  leaderboard_profit_usd: Record<string, number>;
  leaderboard_period?: string | null;
  leaderboard_periods: string[];
  source_reason: string;
  source: 'mock' | 'live-read' | 'live-market-read';
}

export interface PolymarketSourceTradeDecision {
  id: string;
  source_trade_id: string;
  source_trade_key: string;
  proposed_at: string;
  updated_at: string;
  trader_id: string;
  trader_name: string;
  trader_address: string;
  trader_handle?: string | null;
  market_id: string;
  market_title: string;
  event_end_at?: string | null;
  outcome: string;
  side: 'BUY' | 'SELL';
  amount: number;
  price: number;
  shares: number;
  max_loss: number;
  cost_basis_usd?: number;
  realized_pnl?: number;
  trader_invested_usd?: number;
  trader_net_worth_usd?: number;
  reason: string;
  status: 'proposed' | 'confirmed' | 'rejected' | 'executed' | 'failed' | 'skipped';
  command?: 'buy' | 'sell' | null;
  failure_reason?: string | null;
  executed_at?: string | null;
  source: 'mock' | 'live-read' | 'live-market-read';
}

export interface PolymarketBullpenRedeemedTrade {
  id: string;
  timestamp: string;
  market_id: string;
  market_title: string;
  outcome: string;
  side: 'BUY' | 'SELL' | string;
  amount: number;
  shares: number;
  price: number;
  profit_loss: number;
  status: string;
  detail: string;
}

export interface PolymarketBalanceState {
  status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';
  message: string;
  checked_at?: string | null;
  next_refresh_at?: string | null;
  account_value_usd?: number | null;
  available_balance_usd?: number | null;
  pnl_usd?: number | null;
  upnl_usd?: number | null;
}

export interface PolymarketLiveSourceStatus {
  source_mode: 'mock' | 'live-read' | 'live-trading';
  discovery_mode: string;
  live_read_traders_count: number;
  active_traders_found: number;
  candidate_rows_considered: number;
  candidate_wallets_extracted: number;
  fallback_traders_selected: number;
  activity_source_used?: 'wallet' | 'handle' | 'feed' | 'fallback' | null;
  rows_rejected_last_discovery: number;
  accepted_activity_trades_last_discovery: number;
  manual_wallets_configured: number;
  manual_wallets_valid: number;
  manual_wallets_invalid: string[];
  manual_tracked_wallets: PolymarketTrader[];
  last_poll_time?: string | null;
  last_active_trader_discovery_time?: string | null;
  last_discovery_error?: string | null;
  source_trades_found_last_poll: number;
  source_trades_after_filters_last_poll: number;
  new_live_proposals_created_last_poll: number;
  skipped_by_filters_last_poll: number;
  skipped_by_limits_last_poll: number;
  skipped_duplicates_last_poll: number;
  live_baseline_completed_at?: string | null;
  seen_live_trades_baseline_count: number;
  last_live_read_error?: string | null;
  trending_market_activity_enabled: boolean;
  trending_market_activity_unavailable?: string | null;
}

export interface PolymarketPosition {
  key: string;
  market_id: string;
  market_title: string;
  outcome: string;
  shares: number;
  average_price: number;
  cost_basis: number;
}

export interface PolymarketMetrics {
  total_pnl: number;
  win_rate: number;
  total_trades: number;
  winners: number;
  losers: number;
  skipped: number;
  failed: number;
}

export interface PolymarketActivity {
  timestamp: string;
  message: string;
}

export interface PolymarketDoctorStatus {
  checked_at?: string | null;
  ok: boolean;
  message: string;
  error_code?: string | null;
  error_classification?: string | null;
  safe_to_retry?: boolean | null;
  support_required?: boolean | null;
  terminal?: boolean | null;
  resolution_owner?: string | null;
  bullpen_login_observed_at?: string | null;
  bullpen_jwt_expires_at?: string | null;
  bullpen_jwt_seconds_remaining?: number | null;
}

export interface PolymarketLiveControlState {
  enabled_by_env: boolean;
  unlocked: boolean;
  unlock_mode: 'locked' | 'automatic' | 'manual';
  manually_locked: boolean;
  locked_reason?: string | null;
  emergency_stopped: boolean;
  doctor: PolymarketDoctorStatus;
  balance: PolymarketBalanceState;
  source_status: PolymarketLiveSourceStatus;
  max_live_trade_size: number;
  live_trades_today: number;
  pending_confirmations: PolymarketSourceTradeDecision[];
  recent_decisions: PolymarketSourceTradeDecision[];
  redeemed_trades: PolymarketBullpenRedeemedTrade[];
}

export interface PolymarketPaperTrade {
  id: string;
  source_trade_id: string;
  timestamp: string;
  trader_id: string;
  trader_name: string;
  market_id: string;
  market_title: string;
  event_end_at?: string | null;
  outcome: string;
  side: 'BUY' | 'SELL';
  price: number;
  copied_usd: number;
  shares: number;
  realized_pnl: number;
  status: 'executed' | 'skipped' | 'failed';
  reason?: string | null;
}

export interface PolymarketBotState {
  running: boolean;
  paused: boolean;
  mode: 'mock' | 'live-read' | 'live-trading';
  server_now: string;
  session_started_at: string;
  started_at?: string | null;
  stopped_at?: string | null;
  last_poll_at?: string | null;
  next_poll_at?: string | null;
  seconds_until_next_poll: number;
  last_error?: string | null;
  tracked_accounts: PolymarketTrackedAccount[];
  tracked_traders: PolymarketTrader[];
  open_positions: PolymarketPosition[];
  trade_history: PolymarketPaperTrade[];
  recent_activity: PolymarketActivity[];
  metrics: PolymarketMetrics;
  config: PolymarketBotConfig;
  live: PolymarketLiveControlState;
}

export interface PolymarketManualInvestResponse {
  orders: PolymarketManualInvestOrderResult[];
  state: PolymarketBotState;
}

export interface PolymarketDiscoveryDebugRequest {
  target: string;
}

export interface PolymarketDiscoveryDebugCommand {
  label: string;
  args: string[];
}

export interface PolymarketDiscoveryDebugCandidate {
  address?: string | null;
  handle?: string | null;
  username?: string | null;
  profile_slug?: string | null;
}

export interface PolymarketDiscoveryDebugAccepted {
  address?: string | null;
  clean_identity?: string | null;
  raw_identity?: string | null;
  handle?: string | null;
  username?: string | null;
  market?: string | null;
  title?: string | null;
  outcome?: string | null;
  side?: string | null;
  price?: number | null;
  amount?: number | null;
  timestamp?: string | null;
  reason: string;
}

export interface PolymarketDiscoveryDebugRejected {
  keys: string[];
  reason: string;
  extracted: Record<string, unknown>;
}

export interface PolymarketDiscoveryDebugError {
  command: string;
  error: string;
}

export interface PolymarketDiscoveryDebugReport {
  target: string;
  commands_attempted: PolymarketDiscoveryDebugCommand[];
  rows_returned_count: number;
  accepted_trades_count: number;
  rejected_rows_count: number;
  sample_row_keys: string[][];
  candidates: PolymarketDiscoveryDebugCandidate[];
  accepted: PolymarketDiscoveryDebugAccepted[];
  rejected: PolymarketDiscoveryDebugRejected[];
  errors: PolymarketDiscoveryDebugError[];
}

export type BullpenAutoLiveEvidenceStatus = "Low" | "Moderate" | "Strong";
export type BullpenAutoLiveConfidence = "Low" | "Medium" | "High";
export type BullpenAutoLiveGuardrailStatus = "pass" | "watch" | "fail";
export type BullpenAutoLiveDecisionAction =
  | "BUY_NEW"
  | "ADD_MORE"
  | "HOLD"
  | "TRIM"
  | "EXIT"
  | "SKIP";
export type BullpenAutoLiveStage3Result =
  | "SELECTED"
  | "OUTSIDE_TOP_10"
  | "BLOCKED";
export type BullpenAutoLiveRiskStatus = "Ready" | "Watch" | "Blocked";
export type BullpenAutoLiveRunStatus =
  | "running"
  | "confirming"
  | "completed"
  | "partial_success"
  | "failed"
  | "skipped";
export type BullpenAutoLiveTaskLifecycleState =
  | "QUEUED"
  | "RESERVED"
  | "STARTED"
  | "RETRYING"
  | "SUCCESS"
  | "FAILURE"
  | "REVOKED"
  | "WORKER_LOST";
export interface BullpenAutoLiveTaskLifecycle {
  state: BullpenAutoLiveTaskLifecycleState;
  task_id?: string | null;
  queue?: string | null;
  enqueued_at?: string | null;
  worker_hostname?: string | null;
  worker_started_at?: string | null;
  last_heartbeat_at?: string | null;
  detail?: string | null;
  redelivery_count?: number;
}
export type BullpenAutoLiveStageStatus =
  | "pass"
  | "fail"
  | "warning"
  | "skipped";
export type BullpenAutoLiveRuntimeStatus =
  | "running"
  | "paused"
  | "stopped"
  | "error"
  | "not-configured";
export type BullpenAutoLiveRuntimeMode =
  | "dry-run"
  | "analysis-only"
  | "live-trading";
export type BullpenAutoLiveOrderPlanStatus =
  | "planned"
  | "ready"
  | "retry_wait"
  | "submitting"
  | "submitted"
  | "confirming"
  | "partially_filled"
  | "settlement_pending"
  | "confirmed"
  | "filled"
  | "waiting_for_collateral"
  | "deferred"
  | "failed_permanent"
  | "rpc_rate_limited"
  | "already_redeemed"
  | "resolved_zero_payout"
  | "skipped"
  | "cancelled"
  | "rejected"
  | "timed_out"
  | "failed";
export type BullpenAutoLiveStage3Status =
  | "EXIT_RPC_RETRYING"
  | "EXIT_NOT_SUBMITTED"
  | "EXIT_SUBMITTED"
  | "EXIT_OPEN_UNFILLED"
  | "EXIT_PARTIALLY_FILLED"
  | "EXIT_FAILED_PERMANENTLY"
  | "POST_EXIT_REFRESH_PENDING"
  | "REPLACEMENT_SLOT_RESERVED"
  | "GENUINE_CAPACITY_BLOCK"
  | "CAPACITY_OVERRIDE_USED"
  | "BUY_READY"
  | "BUY_SUBMITTED"
  | "BUY_FAILED";
export type BullpenAutoLiveOrderAction = "buy" | "sell" | "hold" | "redeem";
export type BullpenAutoLiveOutcomeSide = "YES" | "NO";
export type BullpenAutoLiveOrderIntentStatus =
  | "PLANNED"
  | "READY"
  | "RETRY_WAIT"
  | "SUBMITTING"
  | "SUBMITTED"
  | "CONFIRMING"
  | "PARTIALLY_FILLED"
  | "SETTLEMENT_PENDING"
  | "WAITING_FOR_COLLATERAL"
  | "WAITING_FOR_EXIT"
  | "CONFIRMED"
  | "FILLED"
  | "DEFERRED"
  | "CANCELLED"
  | "FAILED_PERMANENT"
  | "REJECTED"
  | "TIMED_OUT";
export type BullpenAutoLiveReservationStatus =
  | "active"
  | "consumed"
  | "released";
export type BullpenAutoLiveExecutorErrorCode =
  | "RPC_RATE_LIMITED"
  | "RPC_UNAVAILABLE"
  | "HTTP_502"
  | "HTTP_503"
  | "HTTP_504"
  | "NETWORK_TIMEOUT"
  | "CONNECTION_RESET"
  | "AUTH_EXPIRED"
  | "SESSION_INVALID"
  | "LIVE_LOCKED"
  | "DOCTOR_READ_FAILED"
  | "BULLPEN_SUPPORT_REQUIRED"
  | "L2_WALLET_DISAGREEMENT"
  | "PM_LEGACY_DEPOSIT_WALLET_PENDING_RECOVERY"
  | "POLYMARKET_RELAYER_WALLET_NOT_REGISTERED"
  | "POLYMARKET_WALLET_ROUTE_UNCONFIRMED"
  | "SUBMISSION_EVIDENCE_MISSING"
  | "ORDER_WRITE_UNAVAILABLE"
  | "BALANCE_UNAVAILABLE"
  | "INSUFFICIENT_COLLATERAL"
  | "SETTLEMENT_PENDING"
  | "QUOTE_UNAVAILABLE"
  | "QUOTE_STALE"
  | "MARKET_CLOSED"
  | "MARKET_RESOLVED"
  | "UNSUPPORTED_SIDE"
  | "INVALID_TICK_SIZE"
  | "INVALID_PRICE_PRECISION"
  | "INVALID_SHARE_PRECISION"
  | "BELOW_MINIMUM_ORDER"
  | "NO_SHARES_AVAILABLE"
  | "CONDITION_ID_UNAVAILABLE"
  | "EMERGENCY_STOP"
  | "PERMANENT_REJECTION"
  | "CAPACITY_BLOCKED"
  | "AMBIGUOUS_SUBMISSION";
export type BullpenAutoLiveTriggeredBy =
  | "manual"
  | "scheduler"
  | "start"
  | "resume";
export type BullpenAutoLiveStrategyProfile =
  | "guardrail_kelly"
  | "bullpen_console_top10";

export interface BullpenAutoLiveSettings {
  strategy_profile: BullpenAutoLiveStrategyProfile;
  bankroll_usd: number;
  bankroll_source: "manual";
  max_single_trade_pct_bankroll: number;
  max_single_market_pct_bankroll: number;
  max_theme_exposure_pct_bankroll: number;
  max_open_exposure_pct_bankroll: number;
  min_cash_reserve_pct_bankroll: number;
  min_order_usd: number;
  max_order_usd: number;
  console_order_usd: number;
  console_min_market_odds: number;
  min_liquidity_usd: number;
  min_independent_active_markets: number;
  target_active_markets: number;
  max_active_markets: number;
  max_new_markets_per_rebalance: number;
  min_edge_pp: number;
  min_score: number;
  kelly_fraction: number;
  initial_tranche_pct: number;
  add_more_threshold_pct: number;
  max_llm_spread_pp: number;
  half_size_llm_spread_pp: number;
  min_evidence_status: BullpenAutoLiveEvidenceStatus;
  min_confidence: BullpenAutoLiveConfidence;
  adjudication_required_blocks_trade: boolean;
  limit_orders_only: boolean;
  max_bid_ask_spread_cents: number;
  max_slippage_cents: number;
  trade_cooldown_hours_per_market: number;
  max_reprice_attempts: number;
  stage3_exit_poll_timeout_seconds: number;
  stage3_exit_poll_interval_seconds: number;
  bullpen_economic_dust_threshold_usd: number;
  stage3_rpc_retry_attempts: number;
  stage3_rpc_retry_initial_delay_seconds: number;
  stage3_rpc_retry_max_delay_seconds: number;
  stage3_rpc_retry_max_total_wait_seconds: number;
  stage3_capacity_override: boolean;
  exit_edge_pp: number;
  trim_edge_pp: number;
  rebalance_interval_minutes: number;
  no_new_trade_under_hours_to_deadline: number;
  half_size_under_hours_to_deadline: number;
  max_rebalance_churn_pct_bankroll: number;
  max_daily_loss_pct_bankroll: number;
  max_weekly_loss_pct_bankroll: number;
  pause_after_consecutive_failed_orders: number;
  pause_if_balance_unavailable: boolean;
  pause_if_doctor_fails: boolean;
  pause_if_llm_provider_error_rate_high: boolean;
  emergency_stop: boolean;
  active_price_refresh_seconds: number;
  candidate_price_refresh_minutes: number;
  new_scan_interval_minutes: number;
  llm_rerun_interval_minutes: number;
  max_llm_candidates_per_run: number;
  console_llm_targets: ProviderModelTarget[];
  llm_execution_mode: BullpenLlmExecutionMode;
  llm_events_per_prompt: number;
  console_llm_prompt_template?: string | null;
  console_auto_start_at?: string | null;
  console_auto_refresh_minutes?: number | null;
  auto_live_enabled: boolean;
  dry_run: boolean;
  require_manual_confirmation: boolean;
  allow_live_execution: boolean;
}

export type BullpenAutoLiveSettingsUpdate = Partial<BullpenAutoLiveSettings>;

export interface BullpenAutoLiveGuardrailCheck {
  id: string;
  label: string;
  status: BullpenAutoLiveGuardrailStatus;
  detail: string;
  value?: string | null;
  blocking: boolean;
  checked_at: string;
}

export interface BullpenAutoLiveLlmOutput {
  provider: string;
  model: string;
  status?: string | null;
  llm_yes_odds?: number | null;
  llm_no_odds?: number | null;
  confidence?: BullpenAutoLiveConfidence | string | null;
  evidence_status?: BullpenAutoLiveEvidenceStatus | string | null;
  event_state?: string | null;
  key_evidence: string[];
  red_flags: string[];
  rationale?: string | null;
  error?: string | null;
  invalid_reason?: string | null;
  diagnostic?: Record<string, unknown> | null;
  completed_at?: string | null;
}

export interface BullpenAutoLiveConsoleCandidateInput {
  question_id: string;
  market_id: string;
  market_title: string;
  slug?: string | null;
  market_url?: string | null;
  close_time?: string | null;
  theme: string;
  current_yes_odds?: number | null;
  current_no_odds?: number | null;
  volume_usd?: number | null;
  liquidity_usd?: number | null;
  best_bid_cents?: number | null;
  best_ask_cents?: number | null;
  spread_cents?: number | null;
  llm_yes_odds?: number | null;
  llm_no_odds?: number | null;
  returns_per_day?: number | null;
  amount_to_be_invested?: number | null;
  llm_disagreement_level?: string | null;
  llm_disagreement_category?: string | null;
  adjudication_required: boolean;
  confidence?: BullpenAutoLiveConfidence | string | null;
  evidence_status?: BullpenAutoLiveEvidenceStatus | string | null;
  event_state?: string | null;
  rules?: string | null;
  market_context?: string | null;
  resolution_source?: string | null;
  event_description?: string | null;
  preflight_evidence_block?: string | null;
  selected: boolean;
  llm_outputs: BullpenAutoLiveLlmOutput[];
}

export interface BullpenAutoLiveConsoleRunContext {
  source_label?: string | null;
  source_url?: string | null;
  scanned_at?: string | null;
  snapshot_id?: string | null;
  mode?: string | null;
  total_candidates: number;
  candidate_rows_prefiltered: boolean;
  reuse_saved_llm_outputs: boolean;
  stage2_actionable_exit_market_ids?: string[];
  stage2_actionable_buy_market_ids?: string[];
  candidate_rows: BullpenAutoLiveConsoleCandidateInput[];
}

export interface BullpenAutoLiveRunOnceRequest {
  console_profile?: BullpenAutoLiveConsoleRunContext | null;
  client_run_id?: string | null;
}

export interface BullpenAutoLiveOrderFunnel {
  planned: number;
  ready: number;
  attempted: number;
  remotely_accepted: number;
  submitted: number;
  confirming: number;
  partially_filled: number;
  confirmed: number;
  filled: number;
  retry_wait: number;
  settlement_pending: number;
  waiting_for_collateral: number;
  deferred: number;
  cancelled: number;
  permanently_failed: number;
  attempt_rate: number;
  acceptance_rate: number;
  confirmation_rate: number;
  fill_rate: number;
  terminal_success_rate: number;
}

export interface BullpenAutoLiveOrderAttempt {
  id: number;
  intent_id: string;
  attempt_number: number;
  worker_task_id?: string | null;
  rpc_provider?: string | null;
  executor_path?: string | null;
  started_at: string;
  completed_at?: string | null;
  result_status: string;
  error_code?: BullpenAutoLiveExecutorErrorCode | string | null;
  error_message?: string | null;
  retry_after_seconds?: number | null;
  remote_order_id?: string | null;
  remote_transaction_hash?: string | null;
  sanitized_request_json: Record<string, unknown>;
  sanitized_response_json: Record<string, unknown>;
  reconciliation_json: Record<string, unknown>;
}

export interface BullpenAutoLiveCapitalReservation {
  id: number;
  user_id: number;
  order_intent_id: string;
  amount_usd: number;
  status: BullpenAutoLiveReservationStatus;
  created_at: string;
  updated_at: string;
  released_at?: string | null;
}

export interface BullpenAutoLiveOrderIntent {
  id: string;
  user_id: number;
  run_id: string;
  decision_id?: string | null;
  dependency_group?: string | null;
  action: "buy" | "sell" | "redeem";
  market_id: string;
  slug?: string | null;
  condition_id?: string | null;
  side?: BullpenAutoLiveOutcomeSide | null;
  requested_order_usd?: number | null;
  requested_shares?: number | null;
  requested_limit_price_cents?: number | null;
  current_order_usd?: number | null;
  current_shares?: number | null;
  current_limit_price_cents?: number | null;
  max_slippage_cents: number;
  status: BullpenAutoLiveOrderIntentStatus;
  error_class?: string | null;
  last_error_code?: BullpenAutoLiveExecutorErrorCode | string | null;
  last_error_message?: string | null;
  retryable: boolean;
  task_id?: string | null;
  queue?: string | null;
  worker?: string | null;
  last_dispatch_at?: string | null;
  current_blockage?: string | null;
  actionable_resolution?: string | null;
  deployed_commit_sha?: string | null;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at?: string | null;
  priority: number;
  remote_order_id?: string | null;
  remote_transaction_hash?: string | null;
  idempotency_key: string;
  reserved_cash_usd: number;
  expected_release_usd: number;
  confirmed_release_usd: number;
  filled_shares: number;
  remaining_shares: number;
  average_fill_price_cents?: number | null;
  dependency_metadata_json: Record<string, unknown>;
  execution_metadata_json: Record<string, unknown>;
  version: number;
  created_at: string;
  updated_at: string;
  first_submitted_at?: string | null;
  last_submitted_at?: string | null;
  confirmed_at?: string | null;
  terminal_at?: string | null;
  attempts: BullpenAutoLiveOrderAttempt[];
  reservations: BullpenAutoLiveCapitalReservation[];
}

export interface BullpenAutoLiveOrderPlan {
  id: string;
  action: BullpenAutoLiveOrderAction;
  side: BullpenAutoLiveOutcomeSide;
  order_type: "limit";
  status: BullpenAutoLiveOrderPlanStatus;
  stage3_status?: BullpenAutoLiveStage3Status | null;
  market_id: string;
  market_title: string;
  dependency_group?: string | null;
  order_size_usd: number;
  shares: number;
  limit_price_cents: number;
  refreshed_market_price_cents?: number | null;
  max_slippage_cents: number;
  dry_run: boolean;
  detail: string;
  retryable?: boolean;
  attempt_count?: number;
  next_retry_at?: string | null;
  remote_order_id?: string | null;
  remote_transaction_hash?: string | null;
  provider_alias?: string | null;
  execution_path?: string | null;
  fallback_history?: Array<Record<string, unknown>> | null;
  latest_error_code?: BullpenAutoLiveExecutorErrorCode | string | null;
  dependency_state?: string | null;
  reservation_state?: BullpenAutoLiveReservationStatus | string | null;
  reservation_amount_usd?: number | null;
  filled_shares?: number;
  remaining_shares?: number;
  average_fill_price_cents?: number | null;
  execution_response?: string | null;
  submission_evidence_present?: boolean | null;
  submission_evidence_kind?:
    | "remote_order_id"
    | "remote_transaction_hash"
    | "submitted_at"
    | "uncertain_write_boundary"
    | null;
  current_blockage?: string | null;
  how_to_resolve?: string | null;
  created_at: string;
  executed_at?: string | null;
  confirmed_at?: string | null;
  terminal_at?: string | null;
}

export interface BullpenAutoLiveStageResult {
  stage_number: number;
  stage_name: string;
  status: BullpenAutoLiveStageStatus;
  reason: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  guardrails_checked: BullpenAutoLiveGuardrailCheck[];
  hard_block: boolean;
  started_at: string;
  completed_at?: string | null;
}

export type BullpenAutoLiveExitStrategy =
  | "OUTSIDE_TOP_10_RETURNS_DAY"
  | "LLM_OR_ODDS_FILTER_EXIT"
  | "CAPITAL_AWARE_FORCED_EXIT";

export type BullpenAutoLiveExitSeverity =
  | "INFO"
  | "WATCH_FAST"
  | "PLANNED_EXIT"
  | "IMMEDIATE_EXIT"
  | "DUST_LOST";

export type BullpenAutoLiveExitReasonCode =
  | "OUTSIDE_TOP_10_BY_RETURNS_DAY"
  | "LLM_FILTER_FAILED"
  | "ODDS_FILTER_FAILED"
  | "ADVERSE_MARKET_99_5"
  | "ADVERSE_MARKET_99"
  | "HELD_SIDE_BID_BELOW_0_5_CENTS"
  | "HELD_SIDE_DROP_10_POINTS_1M"
  | "HELD_SIDE_DROP_15_POINTS_1M"
  | "HELD_SIDE_DROP_25_POINTS_5M"
  | "EVENT_CLOSE_PASSED"
  | "LOW_EXECUTABLE_VALUE"
  | "NO_BID_AVAILABLE";

export type BullpenAutoLiveExitState =
  | "ACTIVE"
  | "WATCH_FAST"
  | "EVENT_EXIT_PLANNED"
  | "SELL_SUBMITTED"
  | "PARTIALLY_FILLED"
  | "SOLD"
  | "DUST_LOST"
  | "FAILED";

export interface BullpenAutoLiveExitSignalMetrics {
  currentYes?: number | null;
  currentNo?: number | null;
  heldProbability?: number | null;
  adverseProbability?: number | null;
  heldBestBid?: number | null;
  shares?: number | null;
  avgPrice?: number | null;
  estimatedFreeableValue?: number | null;
  drop1m?: number | null;
  drop5m?: number | null;
  adverseRise1m?: number | null;
  adverseRise5m?: number | null;
  timeToCloseHours?: number | null;
}

export interface BullpenAutoLiveExitSignal {
  strategy: BullpenAutoLiveExitStrategy;
  severity: BullpenAutoLiveExitSeverity;
  reasonCode: BullpenAutoLiveExitReasonCode;
  label: string;
  description: string;
  score?: number | null;
  createdAt: string;
  metrics?: BullpenAutoLiveExitSignalMetrics | null;
}

export interface BullpenAutoLiveDecision {
  id: string;
  run_id: string;
  created_at: string;
  updated_at: string;
  market_id: string;
  market_title: string;
  market_url?: string | null;
  slug?: string | null;
  close_time?: string | null;
  theme: string;
  side: BullpenAutoLiveOutcomeSide;
  decision: BullpenAutoLiveDecisionAction;
  risk_status: BullpenAutoLiveRiskStatus;
  price_cents: number;
  current_yes_odds?: number | null;
  current_no_odds?: number | null;
  fair_probability_pct: number;
  fair_yes_probability_pct?: number | null;
  fair_no_probability_pct?: number | null;
  edge_pp: number;
  score: number;
  confidence: BullpenAutoLiveConfidence;
  evidence_status: BullpenAutoLiveEvidenceStatus;
  event_state?: string | null;
  adjudication_required: boolean;
  disagreement_level?: string | null;
  current_exposure_usd: number;
  target_exposure_usd: number;
  realized_pnl_usd?: number | null;
  hours_remaining?: number | null;
  key_evidence: string[];
  red_flags: string[];
  rationale?: string | null;
  reason: string;
  summary: string;
  stage3_result?: BullpenAutoLiveStage3Result | null;
  stage3_result_reason?: string | null;
  stage3_final_rank?: number | null;
  stage3_max_positions?: number | null;
  selection_required?: boolean;
  selected_for_auto_invest?: boolean | null;
  selection_block_reason?: string | null;
  stage3_status?: BullpenAutoLiveStage3Status | null;
  stage3_blocker?: Record<string, unknown> | null;
  order_plan?: BullpenAutoLiveOrderPlan | null;
  exit_signals: BullpenAutoLiveExitSignal[];
  exit_state: BullpenAutoLiveExitState;
  llm_outputs: BullpenAutoLiveLlmOutput[];
  stage_results: BullpenAutoLiveStageResult[];
  guardrail_checks: BullpenAutoLiveGuardrailCheck[];
}

export interface BullpenAutoLiveRun {
  id: string;
  triggered_by: BullpenAutoLiveTriggeredBy;
  status: BullpenAutoLiveRunStatus;
  dry_run: boolean;
  started_at: string;
  completed_at?: string | null;
  summary: string;
  live_execution_requested: boolean;
  live_execution_attempted: boolean;
  decisions_count: number;
  orders_planned: number;
  orders_submitted: number;
  error_message?: string | null;
  execution_version?: string | null;
  order_funnel?: BullpenAutoLiveOrderFunnel | null;
  action_funnels?: Record<string, BullpenAutoLiveOrderFunnel> | null;
  retry_counts?: Record<string, number> | null;
  provider_error_counts?: Record<string, number> | null;
  average_confirmation_seconds?: number | null;
  oldest_pending_order_age_seconds?: number | null;
  pending_confirmation_count?: number;
  partial_fill_count?: number;
  permanent_failure_count?: number;
  transient_failure_count?: number;
  stage_results: BullpenAutoLiveStageResult[];
  guardrail_checks: BullpenAutoLiveGuardrailCheck[];
  decision_ids: string[];
  order_intent_ids?: string[];
  stage2_llm_targets_snapshot?: ProviderModelTarget[] | null;
  request_context?: BullpenAutoLiveRunOnceRequest | null;
  audit_metadata?: Record<string, unknown>;
  task_lifecycle?: BullpenAutoLiveTaskLifecycle | null;
}

export interface BullpenAutoLiveConsoleRunDetail {
  run: BullpenAutoLiveRun;
  decisions: BullpenAutoLiveDecision[];
  visible_decision_ids: string[];
  visible_decision_ids_truncated: boolean;
  generated_at: string;
  as_of: string;
  projection_version: number;
  projection_available: boolean;
  decisions_limit: number;
  decisions_truncated: boolean;
}

export interface BullpenAutoLiveRunOrdersResponse {
  run?: BullpenAutoLiveRun | null;
  orders: BullpenAutoLiveOrderIntent[];
  order_funnel: BullpenAutoLiveOrderFunnel;
  action_funnels: Record<string, BullpenAutoLiveOrderFunnel>;
  retry_counts: Record<string, number>;
  provider_error_counts: Record<string, number>;
  average_confirmation_seconds?: number | null;
  oldest_pending_order_age_seconds?: number | null;
  pending_confirmation_count: number;
  partial_fill_count: number;
  permanent_failure_count: number;
  transient_failure_count: number;
}

export interface BullpenAutoLiveVerifiedPortfolioSnapshot {
  run_id: string;
  verified_at: string;
  active_positions: Record<string, unknown>[];
  active_positions_total?: number;
  active_positions_truncated?: boolean;
  claimable_positions?: Record<string, unknown>[];
  settlement_pending_positions?: Record<string, unknown>[];
  excluded_positions?: Record<string, unknown>[];
  cash_in_hand_usd?: number | null;
  occupied_positions: number;
  available_slots?: number | null;
  max_positions?: number | null;
  trade_amount_usd?: number | null;
  wallet_source?: string | null;
  wallet_snapshot_fetched_at?: string | null;
  wallet_freshness_state?: string | null;
  wallet_account_identity?: string | null;
  wallet_credential_artifact_inode?: number | null;
  wallet_credential_artifact_mtime_ns?: number | null;
  wallet_credential_artifact_size?: number | null;
  position_classifier_version?: string | null;
}

export interface BullpenAutoLiveState {
  running: boolean;
  paused: boolean;
  dry_run: boolean;
  live_armed: boolean;
  live_execution_allowed: boolean;
  emergency_stopped: boolean;
  status: BullpenAutoLiveRuntimeStatus;
  mode: BullpenAutoLiveRuntimeMode;
  server_now?: string | null;
  started_at?: string | null;
  stopped_at?: string | null;
  last_run_at?: string | null;
  last_execution_at?: string | null;
  next_run_at?: string | null;
  last_scan_at?: string | null;
  last_llm_run_at?: string | null;
  last_rebalance_at?: string | null;
  next_scan_at?: string | null;
  next_llm_run_at?: string | null;
  next_rebalance_at?: string | null;
  last_error?: string | null;
  last_action?: string | null;
  last_run_id?: string | null;
  latest_guardrail_checks: BullpenAutoLiveGuardrailCheck[];
  invested_usd: number;
  current_value_usd: number;
  pnl_usd: number;
  active_positions: number;
  last_console_trade_amount_usd?: number | null;
  last_console_trade_cash_in_hand_usd?: number | null;
  last_console_trade_active_positions?: number | null;
  last_console_trade_available_slots?: number | null;
  last_console_trade_max_positions?: number | null;
  verified_portfolio_snapshot?: BullpenAutoLiveVerifiedPortfolioSnapshot | null;
  trades_today: number;
  consecutive_failed_orders: number;
  today_executed_orders: number;
  today_skipped_orders: number;
  doctor_status: BullpenAutoLiveGuardrailStatus;
  balance_status: BullpenAutoLiveGuardrailStatus;
}

/**
 * Small, persisted-only scheduler configuration used for the Bullpen first
 * paint. It intentionally omits prompt bodies, run history, positions, and
 * runtime/Bullpen-CLI diagnostics from the legacy Auto-Live summary.
 */
export interface BullpenAutoLiveStatusConfiguration {
  strategy_profile: BullpenAutoLiveStrategyProfile;
  auto_live_enabled: boolean;
  dry_run: boolean;
  allow_live_execution: boolean;
  require_manual_confirmation: boolean;
  emergency_stop: boolean;
  limit_orders_only: boolean;
  console_order_usd: number;
  console_auto_start_at?: string | null;
  console_auto_refresh_minutes?: number | null;
  console_llm_target_count: number;
  updated_at?: string | null;
}

/** Persisted scheduler state; this is not a live worker/runtime health check. */
export interface BullpenAutoLiveSchedulerStatus {
  running: boolean;
  paused: boolean;
  dry_run: boolean;
  live_armed: boolean;
  live_execution_allowed: boolean;
  emergency_stopped: boolean;
  status: BullpenAutoLiveRuntimeStatus;
  mode: BullpenAutoLiveRuntimeMode;
  started_at?: string | null;
  stopped_at?: string | null;
  last_run_at?: string | null;
  last_execution_at?: string | null;
  next_run_at?: string | null;
  last_run_id?: string | null;
  active_run_id?: string | null;
  active_run_status?: BullpenAutoLiveRunStatus | null;
  updated_at?: string | null;
}

export interface BullpenAutoLivePersistedStatus {
  source: "persisted";
  refreshed_at: string;
  configuration: BullpenAutoLiveStatusConfiguration;
  scheduler: BullpenAutoLiveSchedulerStatus;
}

export interface BullpenAutoLiveSummarySection {
  source: string;
  status:
    | "live"
    | "persisted"
    | "cached"
    | "stale"
    | "degraded"
    | "unavailable";
  as_of?: string | null;
  age_seconds?: number | null;
  duration_ms?: number | null;
  detail?: string | null;
}

export interface BullpenAutoLiveHistoryStage {
  key: "scan" | "llm" | "invest";
  stage_number: number;
  label: string;
  status: BullpenAutoLiveStageStatus;
  phase_status?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  input_count?: number | null;
  processed_count?: number | null;
  succeeded_count?: number | null;
  failed_count?: number | null;
  blocker_preview?: string | null;
}

export interface BullpenAutoLiveHistoryItem {
  id: string;
  triggered_by: BullpenAutoLiveTriggeredBy;
  status: BullpenAutoLiveRunStatus;
  dry_run: boolean;
  started_at: string;
  completed_at?: string | null;
  duration_seconds?: number | null;
  summary: string;
  error_message?: string | null;
  decisions_count: number;
  orders_planned: number;
  orders_submitted: number;
  order_funnel: BullpenAutoLiveOrderFunnel;
  stages: BullpenAutoLiveHistoryStage[];
  blocker_preview?: string | null;
  latest_update_at: string;
  projection_available: boolean;
}

export interface BullpenAutoLiveHistoryPage {
  items: BullpenAutoLiveHistoryItem[];
  total: number;
  page: number;
  size: number;
  pages: number;
  has_next: boolean;
  generated_at: string;
}

export interface BullpenAutoLiveEventTrend {
  market_id: string;
  market_title: string;
  market_url?: string | null;
  close_time?: string | null;
  score: number;
  scan_scores: Array<number | null>;
  scan_sides: Array<BullpenAutoLiveOutcomeSide | null>;
  scan_timestamps: Array<string | null>;
  scan_llm_outputs?: BullpenAutoLiveLlmOutput[][];
  current_yes_odds?: number | null;
  current_no_odds?: number | null;
  llm_yes_odds?: number | null;
  llm_no_odds?: number | null;
  returns_per_day?: number | null;
  is_active_position?: boolean;
  is_claimable_position?: boolean;
  active_position_side?: BullpenAutoLiveOutcomeSide | null;
}

export interface BullpenAutoLiveEventTrendsResponse {
  events: BullpenAutoLiveEventTrend[];
  scan_count: number;
  generated_at: string;
}

export type TradingBotStatus =
  | "running"
  | "paused"
  | "stopped"
  | "error"
  | "not-configured";

export type TradingBotMode =
  | "paper"
  | "live-read"
  | "live-trading"
  | "dry-run"
  | "analysis-only";

export type TradingBotGuardrailTone =
  | "neutral"
  | "positive"
  | "warning"
  | "critical";
export type TradingBotSummaryCardSource =
  | "api"
  | "fallback"
  | "placeholder";

export interface TradingBotGuardrail {
  label: string;
  value: string;
  tone?: TradingBotGuardrailTone;
}

export interface TradingBotSummaryCard {
  id: TradingBotSummaryId;
  name: string;
  route: string;
  status: TradingBotStatus;
  mode: TradingBotMode;
  invested_usd?: number | null;
  current_value_usd?: number | null;
  pnl_usd?: number | null;
  return_pct?: number | null;
  active_positions?: number | null;
  trades_today?: number | null;
  last_run_at?: string | null;
  next_run_at?: string | null;
  guardrails_summary: string;
  strategy_summary: string;
  risk_summary: string;
  guardrails: TradingBotGuardrail[];
  note?: string | null;
  source?: TradingBotSummaryCardSource | null;
}

export interface BullpenAutoLiveBotCardSummary
  extends Omit<TradingBotSummaryCard, "id" | "note" | "source"> {
  id: "bullpen-ai-auto-live";
}

export interface BullpenAutoLiveSummaryResponse {
  state: BullpenAutoLiveState;
  settings: BullpenAutoLiveSettings;
  bot_card: BullpenAutoLiveBotCardSummary;
  latest_run?: BullpenAutoLiveRun | null;
  recent_runs: BullpenAutoLiveRun[];
  recent_decisions: BullpenAutoLiveDecision[];
  latest_guardrail_checks: BullpenAutoLiveGuardrailCheck[];
  runtime_auth?: BullpenRuntimeActiveAuthResult | null;
  generated_at?: string | null;
  projection_version?: number | null;
  sections?: Record<string, BullpenAutoLiveSummarySection>;
  degraded_sections?: string[];
}

export interface BullpenRuntimeActiveAuthResult {
  checked_at: string;
  auth_checked_at?: string | null;
  healthy: boolean;
  login_required: boolean;
  doctor_refresh_succeeded: boolean;
  credentials_valid?: boolean | null;
  refresh_succeeded?: boolean | null;
  token_valid?: boolean | null;
  trade_auth_blocked?: boolean | null;
  requires_login?: boolean | null;
  wallet_ready?: boolean | null;
  failure_reason?: string | null;
  error_classification?: string | null;
  recovered_failure_at?: string | null;
  historical_error_stale?: boolean;
}

export interface BullpenTradeAnalysisSnapshot {
  id: number;
  snapshot_type: string;
  captured_at: string;
  bullpen_snapshot_json: Record<string, unknown>;
  event_snapshot_json: Record<string, unknown>;
  market_snapshot_json: Record<string, unknown>;
  order_book_snapshot_json: Record<string, unknown>;
  positions_snapshot_json: Record<string, unknown>;
  raw_api_response_json: Record<string, unknown>;
}

export interface BullpenTradeAnalysisLlmEntry {
  id: number;
  phase: string;
  provider?: string | null;
  model?: string | null;
  prompt_version?: string | null;
  prompt_text?: string | null;
  raw_output?: string | null;
  parsed_output_json: Record<string, unknown>;
  confidence?: number | null;
  tags_json: unknown[];
  computed_tags_json: unknown[];
  decision_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface BullpenTradeAnalysisEventLog {
  id: number;
  run_id?: string | null;
  event_type: string;
  message: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface BullpenTradeAnalysisSummaryStats {
  total_executed_trades: number;
  open_positions: number;
  closed_positions: number;
  total_net_pnl: number;
  win_rate: number;
  average_pnl_percent?: number | null;
  average_holding_period_seconds?: number | null;
  total_fees: number;
}

export interface BullpenTradeAnalysisListItem {
  id: string;
  title: string;
  status: string;
  final_tag: string;
  pnl_outcome_tag: string;
  is_squared_off: boolean;
  category?: string | null;
  topic?: string | null;
  outcome_name?: string | null;
  exit_type?: string | null;
  run_id?: string | null;
  strategy_name?: string | null;
  strategy_version?: string | null;
  bought_at?: string | null;
  sold_at?: string | null;
  redeemed_at?: string | null;
  closed_at?: string | null;
  buy_submitted_at?: string | null;
  buy_executed_at?: string | null;
  sell_submitted_at?: string | null;
  sell_executed_at?: string | null;
  buy_amount?: number | null;
  buy_price?: number | null;
  buy_odds?: number | null;
  buy_shares?: number | null;
  buy_requested_amount?: number | null;
  buy_requested_shares?: number | null;
  buy_requested_price?: number | null;
  buy_requested_odds?: number | null;
  buy_filled_amount?: number | null;
  buy_filled_shares?: number | null;
  buy_average_fill_price?: number | null;
  buy_average_fill_odds?: number | null;
  current_price?: number | null;
  exit_price?: number | null;
  exit_odds?: number | null;
  exit_amount?: number | null;
  exit_shares?: number | null;
  sell_requested_amount?: number | null;
  sell_requested_shares?: number | null;
  sell_requested_price?: number | null;
  sell_requested_odds?: number | null;
  sell_filled_amount?: number | null;
  sell_filled_shares?: number | null;
  sell_average_fill_price?: number | null;
  sell_average_fill_odds?: number | null;
  buy_status?: string | null;
  sell_status?: string | null;
  gross_pnl?: number | null;
  net_pnl?: number | null;
  pnl_percent?: number | null;
  fees_total?: number | null;
  holding_period_seconds?: number | null;
  realized_return?: number | null;
  buy_tags: string[];
  short_reason?: string | null;
  exit_reason?: string | null;
  analysis_summary?: string | null;
  confidence?: number | null;
  risk_score?: number | null;
}

export interface BullpenTradeAnalysisLearningInsights {
  win_rate_by_tag: Array<Record<string, unknown>>;
  average_pnl_by_tag: Array<Record<string, unknown>>;
  total_pnl_by_strategy_version: Array<Record<string, unknown>>;
  average_pnl_by_confidence_bucket: Array<Record<string, unknown>>;
  average_pnl_by_spread_bucket: Array<Record<string, unknown>>;
  average_pnl_by_liquidity_bucket: Array<Record<string, unknown>>;
  losses_caused_by_low_liquidity: number;
  high_confidence_losses: number;
  profitable_tags: Array<Record<string, unknown>>;
  unprofitable_tags: Array<Record<string, unknown>>;
  average_holding_period_winners_seconds?: number | null;
  average_holding_period_losers_seconds?: number | null;
  exit_reasons_ranked_by_pnl: Array<Record<string, unknown>>;
  buy_reasons_ranked_by_pnl: Array<Record<string, unknown>>;
  recommendations: string[];
}

export interface BullpenTradeAnalysisComparison {
  buy_price?: number | null;
  exit_price?: number | null;
  buy_odds?: number | null;
  exit_odds?: number | null;
  buy_liquidity_score?: number | null;
  exit_liquidity_score?: number | null;
  buy_volume_score?: number | null;
  exit_volume_score?: number | null;
  buy_spread_score?: number | null;
  exit_spread_score?: number | null;
  buy_confidence?: number | null;
  exit_confidence?: number | null;
  buy_probability_estimate?: number | null;
  exit_probability_estimate?: number | null;
  buy_market_implied_probability?: number | null;
  exit_market_implied_probability?: number | null;
  buy_probability_delta?: number | null;
  exit_probability_delta?: number | null;
}

export interface BullpenTradeAnalysisActionableLearning {
  analysis_summary?: string | null;
  mistake_category?: string | null;
  improvement_suggestion?: string | null;
  reinforcement_signal?: string | null;
  reinforcement_score?: number | null;
  should_avoid_similar_trade: boolean;
  should_increase_confidence_for_similar_trade: boolean;
  human_review_required: boolean;
  what_worked: string[];
  what_went_wrong: string[];
  exit_timing: string;
  entry_too_expensive: boolean;
  liquidity_or_spread_issue: boolean;
  llm_confidence_aligned: boolean;
  suggested_platform_rule_changes: string[];
  suggested_prompt_changes: string[];
  suggested_risk_management_changes: string[];
  sell_reason?: string | null;
}

export interface BullpenTradeAnalysisRecordResponse {
  id: string;
  entry_reference: string;
  exit_reference?: string | null;
  source_variant: string;
  bot_name: string;
  strategy_name?: string | null;
  strategy_version?: string | null;
  status: string;
  lifecycle_state: string;
  final_tag: string;
  pnl_outcome_tag: string;
  is_squared_off: boolean;
  position_key?: string | null;
  event_id?: string | null;
  event_slug?: string | null;
  bullpen_event_id?: string | null;
  bullpen_market_id?: string | null;
  outcome_id?: string | null;
  outcome_name?: string | null;
  contract_id?: string | null;
  run_id?: string | null;
  title: string;
  event_question: string;
  event_description?: string | null;
  category?: string | null;
  topic?: string | null;
  source_url?: string | null;
  market_url?: string | null;
  event_close_time?: string | null;
  event_resolved_at?: string | null;
  bought_at?: string | null;
  sold_at?: string | null;
  redeemed_at?: string | null;
  closed_at?: string | null;
  buy_order_id?: string | null;
  buy_client_order_id?: string | null;
  buy_submitted_at?: string | null;
  buy_executed_at?: string | null;
  buy_requested_amount?: number | null;
  buy_requested_shares?: number | null;
  buy_requested_price?: number | null;
  buy_requested_odds?: number | null;
  buy_filled_amount?: number | null;
  buy_filled_shares?: number | null;
  buy_average_fill_price?: number | null;
  buy_average_fill_odds?: number | null;
  buy_fees?: number | null;
  buy_slippage?: number | null;
  buy_status?: string | null;
  buy_failure_reason?: string | null;
  buy_decision_summary?: string | null;
  buy_reason?: string | null;
  buy_confidence?: number | null;
  buy_risk_score?: number | null;
  buy_expected_edge?: number | null;
  buy_expected_value?: number | null;
  buy_probability_estimate?: number | null;
  buy_market_implied_probability?: number | null;
  buy_probability_delta?: number | null;
  buy_liquidity_score?: number | null;
  buy_volume_score?: number | null;
  buy_spread_score?: number | null;
  buy_volatility_score?: number | null;
  buy_news_recency_score?: number | null;
  buy_selected_by_rule: boolean;
  buy_selected_by_llm: boolean;
  buy_selected_by_hybrid_decision: boolean;
  buy_computed_tags_json: unknown[];
  buy_rule_checks_json: unknown[];
  exit_type?: string | null;
  sell_order_id?: string | null;
  sell_client_order_id?: string | null;
  sell_submitted_at?: string | null;
  sell_executed_at?: string | null;
  sell_requested_amount?: number | null;
  sell_requested_shares?: number | null;
  sell_requested_price?: number | null;
  sell_requested_odds?: number | null;
  sell_filled_amount?: number | null;
  sell_filled_shares?: number | null;
  sell_average_fill_price?: number | null;
  sell_average_fill_odds?: number | null;
  sell_fees?: number | null;
  sell_slippage?: number | null;
  sell_status?: string | null;
  sell_failure_reason?: string | null;
  sell_decision_summary?: string | null;
  sell_reason?: string | null;
  sell_confidence?: number | null;
  sell_risk_score?: number | null;
  sell_expected_edge?: number | null;
  sell_expected_value?: number | null;
  sell_probability_estimate?: number | null;
  sell_market_implied_probability?: number | null;
  sell_probability_delta?: number | null;
  sell_liquidity_score?: number | null;
  sell_volume_score?: number | null;
  sell_spread_score?: number | null;
  sell_volatility_score?: number | null;
  sell_computed_tags_json: unknown[];
  sell_rule_checks_json: unknown[];
  buy_notional?: number | null;
  exit_notional?: number | null;
  gross_pnl?: number | null;
  net_pnl?: number | null;
  pnl_percent?: number | null;
  fees_total?: number | null;
  holding_period_seconds?: number | null;
  realized_return?: number | null;
  max_favorable_price?: number | null;
  max_adverse_price?: number | null;
  best_possible_exit_price_after_buy?: number | null;
  worst_price_after_buy?: number | null;
  missed_profit_amount?: number | null;
  drawdown_while_held?: number | null;
  analysis_summary?: string | null;
  mistake_category?: string | null;
  improvement_suggestion?: string | null;
  reinforcement_signal?: string | null;
  reinforcement_score?: number | null;
  should_avoid_similar_trade: boolean;
  should_increase_confidence_for_similar_trade: boolean;
  human_review_required: boolean;
  reviewer_notes?: string | null;
  metadata_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface BullpenTradeAnalysisListResponse {
  items: BullpenTradeAnalysisListItem[];
  summary: BullpenTradeAnalysisSummaryStats;
  learning_insights: BullpenTradeAnalysisLearningInsights;
}

export interface BullpenTradeAnalysisDetailResponse {
  trade: BullpenTradeAnalysisRecordResponse;
  comparison: BullpenTradeAnalysisComparison;
  actionable_learning: BullpenTradeAnalysisActionableLearning;
  snapshots: BullpenTradeAnalysisSnapshot[];
  llm_entries: BullpenTradeAnalysisLlmEntry[];
  event_logs: BullpenTradeAnalysisEventLog[];
}

export type TradingBotSummaryId =
  | "bullpen-x-polymarket"
  | "polymarket-direct"
  | "bullpen-x-ai"
  | "bullpen-ai-auto-live";

export interface TradingBotsSummaryResponse {
  generated_at: string;
  cards: TradingBotSummaryCard[];
}

export interface TradingBotSummary {
  id: TradingBotSummaryId;
  name: string;
  href: string;
  details_href?: string | null;
  status: TradingBotStatus;
  mode: TradingBotMode;
  money_invested: number | null;
  current_value: number | null;
  profit_loss: number | null;
  return_pct: number | null;
  active_positions_count: number | null;
  trades_today: number | null;
  last_run_time: string | null;
  next_scheduled_run: string | null;
  guardrails_summary: string;
  guardrails: TradingBotGuardrail[];
  strategy: string;
  risk_warning: string;
  note?: string | null;
  source?: TradingBotSummaryCardSource | null;
}

export interface TradingBotsOverviewResponse {
  generated_at: string;
  bots: TradingBotSummary[];
}

// ==================== API Response Wrapper Types ====================

export interface ApiResponse<T = unknown> {
  data?: T;
  error?: string;
  status: number;
  message?: string;
}

export interface PaginatedResponse<T = unknown> {
  items: T[];
  total: number;
  page: number;
  size: number;
  pages: number;
}

// ==================== Request Configuration Types ====================

export interface ApiRequestConfig {
  token?: string;
  params?: Record<string, string | number>;
  query?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

// ==================== Service Response Types ====================

export interface ServiceHealthStatus {
  status: 'healthy' | 'unhealthy' | 'degraded';
  latency?: number;
  error?: string;
}

export interface FullHealthCheckResponse {
  database: ServiceHealthStatus;
  redis: ServiceHealthStatus;
  api: ServiceHealthStatus;
  timestamp: string;
  version?: string;
}

// ==================== Type Guards ====================

export function isLoginResponse(response: unknown): response is LoginResponse {
  return (
    typeof response === 'object' &&
    response !== null &&
    'access_token' in response &&
    'refresh_token' in response &&
    'user' in response
  );
}

export function isRegisterResponse(response: unknown): response is RegisterResponse {
  return (
    typeof response === 'object' &&
    response !== null &&
    'id' in response &&
    'email' in response &&
    'username' in response
  );
}

export function isJobResponse(response: unknown): response is JobResponse {
  return (
    typeof response === 'object' &&
    response !== null &&
    'id' in response &&
    'prompt' in response &&
    'provider' in response &&
    'model' in response &&
    'status' in response
  );
}

export function isUserResponse(response: unknown): response is UserResponse {
  return (
    typeof response === 'object' &&
    response !== null &&
    'id' in response &&
    'email' in response &&
    'username' in response &&
    'role' in response
  );
}

export function isHTTPValidationError(response: unknown): response is HTTPValidationError {
  return (
    typeof response === 'object' &&
    response !== null &&
    'detail' in response &&
    Array.isArray((response as Record<string, unknown>).detail)
  );
}


export type FinalActionableHistoryCoverageStatus =
  | "suggested"
  | "not_mentioned"
  | "not_in_input_universe"
  | "run_failed"
  | "parse_failed";

export type FinalActionableHistoryItem = {
  id: number;
  workflow_id: number | null;
  auto_rebalance_sequence: number | null;
  rebalance_run_id: number;
  market: "india" | "us";
  stock_symbol: string;
  stock_name: string | null;
  covered_at: string;
  action: string | null;
  score: number | null;
  consensus_numerator: number | null;
  consensus_denominator: number | null;
  historical_current_units: number | null;
  historical_current_value: number | null;
  action_units: number | null;
  amount: number | null;
  technical_scan_run_id: number | null;
  formula_version: string;
  formula_inputs_json: Record<string, unknown> | null;
  source_run_ids_json: number[] | null;
  snapshot_json: Record<string, unknown> | null;
  coverage_status: FinalActionableHistoryCoverageStatus;
  created_at: string;
};

export type FinalActionableHistoryListResponse = {
  items: FinalActionableHistoryItem[];
  next_cursor: string | null;
  has_more: boolean;
};

export type FinalActionableHistoryCreateItem = Omit<
  FinalActionableHistoryItem,
  "id" | "created_at"
>;

export type FinalActionableHistoryBulkCreateRequest = {
  items: FinalActionableHistoryCreateItem[];
};

export type FinalActionableHistoryBulkCreateResponse = {
  inserted: number;
  skipped: number;
  coverage_inserted: number;
};

export type FinalActionableHistoryBackfillResponse = {
  status: "queued" | "already_queued";
  task_id: string | null;
};
