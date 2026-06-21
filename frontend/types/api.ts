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

export interface ProviderInfo {
  name: string;
  models: string[];
  configured: boolean;
  model_estimated_cost_usd?: Record<string, number>;
  model_estimated_cost_inr?: Record<string, number>;
  model_compatibility?: Record<string, { compatible: boolean; reason?: string | null }>;
  compatible_models?: string[];
}

export interface ProviderModelTarget {
  provider: string;
  model: string;
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
  daily_estimated_cost_inr: number;
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
  estimated_cost_inr: number;
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
  estimated_cost_inr: number;
  tokens_in?: number | null;
  tokens_out?: number | null;
}

export interface LlmCostHistoryResponse {
  provider: string;
  name: string;
  timezone: string;
  usd_inr_rate: number;
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
  usd_inr_rate?: number;
  fx_source?: string;
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

export interface RunCreate {
  prompt: string;
  targets: RunModelTarget[];
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
}

export interface ZerodhaProtectedMarketRequest {
  orders: ZerodhaProtectedMarketOrderRequest[];
}

export interface ZerodhaProtectedMarketOrderResult {
  tradingsymbol: string;
  exchange: string;
  transaction_type: 'BUY' | 'SELL';
  quantity: number;
  status: 'placed' | 'failed';
  order_id?: string | null;
  error?: string | null;
}

export interface ZerodhaProtectedMarketResponse {
  results: ZerodhaProtectedMarketOrderResult[];
  placed_count: number;
  failed_count: number;
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

export interface PolymarketManualInvestOrderRequest {
  question_id: string;
  market_id: string;
  market_title: string;
  outcome: string;
  amount: number;
  price: number;
  event_end_at?: string | null;
  market_url?: string | null;
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

export interface BullpenAutoLiveSettings {
  bankroll_usd: number;
  bankroll_source: "manual";
  max_single_trade_pct_bankroll: number;
  max_single_market_pct_bankroll: number;
  max_theme_exposure_pct_bankroll: number;
  max_open_exposure_pct_bankroll: number;
  min_cash_reserve_pct_bankroll: number;
  min_order_usd: number;
  max_order_usd: number;
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

export interface BullpenAutoLiveState {
  running: boolean;
  paused: boolean;
  status: BullpenAutoLiveRuntimeStatus;
  mode: BullpenAutoLiveRuntimeMode;
  server_now?: string | null;
  started_at?: string | null;
  stopped_at?: string | null;
  last_run_at?: string | null;
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
  trades_today: number;
  consecutive_failed_orders: number;
  doctor_status: BullpenAutoLiveGuardrailStatus;
  balance_status: BullpenAutoLiveGuardrailStatus;
}

export interface BullpenAutoLiveSummaryResponse {
  state: BullpenAutoLiveState;
  settings: BullpenAutoLiveSettings;
  latest_guardrail_checks: BullpenAutoLiveGuardrailCheck[];
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

export type TradingBotSummaryId =
  | "bullpen-x-polymarket"
  | "polymarket-direct"
  | "bullpen-x-ai"
  | "bullpen-ai-auto-live";

export interface TradingBotGuardrail {
  label: string;
  value: string;
  tone?: TradingBotGuardrailTone;
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
  source?: string | null;
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
