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
}

export interface RunJobResponse {
  id: number;
  run_id: number;
  job_id: number;
  stage: number;
  job: JobResponse;
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
