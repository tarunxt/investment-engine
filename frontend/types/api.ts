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
  provider?: string;
  model?: string;
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
}

export interface ZerodhaStatusResponse {
  connected: boolean;
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

export interface PortfolioEventTable {
  columns: string[];
  rows: Record<string, string>[];
  raw_markdown: string;
}

export interface PortfolioAnalysisHistoryItem {
  job_id: number;
  status: string;
  provider: string;
  model: string;
  snapshot_date: string | null;
  captured_at: string | null;
  created_at: string;
  updated_at: string;
  estimated_cost?: number | null;
  error_message?: string | null;
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
  filled_quantity: number;
  pending_quantity: number;
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
}

export interface ZerodhaPlaceOrderResponse {
  order_id: string;
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
}

export interface GoogleSheetsStatusResponse {
  connected: boolean;
  token_expiry: string | null;
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
