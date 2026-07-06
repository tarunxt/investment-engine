import { URLs } from "@/lib/urls";
import { deriveApiErrorMessage } from "@/lib/apiErrors";
import { sessionStorage } from "@/services/session";
import { syncTokenToCookie } from "@/services/cookies";
import { signOut } from "next-auth/react";
import {
  ApiUsageSummaryResponse,
  LlmCostHistoryResponse,
  GoogleSheetsAdminConfigResponse,
  GoogleSheetsAdminConfigUpdateRequest,
  GoogleSheetsAuthUrlResponse,
  GoogleSheetsDefaultSheetRequest,
  GoogleSheetsDefaultSheetResponse,
  GoogleSheetsExportJobRequest,
  GoogleSheetsExportResponse,
  GoogleSheetsExportRunRequest,
  GoogleSheetsImportRequest,
  GoogleSheetsStatusResponse,
  IndMoneyUsCurrentPricesRequest,
  IndMoneyUsCurrentPricesResponse,
  IndMoneyUsEventsAnalysis,
  IndMoneyUsEventsHistoryResponse,
  IndMoneyUsEventsLatestResponse,
  IndMoneyUsEventsRunResponse,
  IndMoneyUsPortfolioOverviewResponse,
  IndMoneyUsPortfolioSnapshotCreateRequest,
  IndMoneyUsPortfolioSnapshotDetail,
  IndMoneyUsThreatAnalysis,
  IndMoneyUsThreatHistoryResponse,
  IndMoneyUsThreatLatestResponse,
  IndMoneyUsThreatRunResponse,
  BullpenAutoLiveSettings,
  BullpenAutoLiveSettingsUpdate,
  BullpenAutoLiveRun,
  BullpenAutoLiveRunOnceRequest,
  BullpenAutoLiveDecision,
  BullpenAutoLiveState,
  BullpenAutoLiveSummaryResponse,
  BullpenTradeAnalysisDetailResponse,
  BullpenTradeAnalysisListResponse,
  PolymarketBotState,
  PolymarketManualInvestOrderRequest,
  PolymarketManualInvestResponse,
  PolymarketLiveLimitUpdate,
  PolymarketTrackedAccountCreate,
  PolymarketTrackedAccountUpdate,
  PolymarketDiscoveryDebugReport,
  PolymarketDiscoveryDebugRequest,
  TradingBotsSummaryResponse,
  TradingBotsOverviewResponse,
  JobCreate,
  JobResponse,
  LoginResponse,
  LlmPerformanceResponse,
  PromptCreate,
  PromptResponse,
  PromptUpdate,
  PortfolioEventRunRequest,
  ProviderInfo,
  PaginatedResponse,
  RegisterResponse,
  RefreshTokenResponse,
  RunCreate,
  RunListItem,
  AutoRebalanceRunReservationResponse,
  AutoRebalanceCompletionEmailRequest,
  AutoRebalancePortfolioKey,
  RunResponse,
  UpdatePasswordRequest,
  UpdateProfileRequest,
  FullHealthCheckResponse,
  UserResponse,
  ZerodhaEventsAnalysis,
  ZerodhaEventsHistoryResponse,
  ZerodhaEventsLatestResponse,
  ZerodhaEventsRunResponse,
  ZerodhaLoginUrlResponse,
  ZerodhaPortfolioOverviewResponse,
  ZerodhaPortfolioSnapshotDetail,
  ZerodhaPortfolioSyncResponse,
  ZerodhaOrder,
  ZerodhaPrepareBasketRequest,
  ZerodhaPrepareBasketResponse,
  ZerodhaPlaceOrderRequest,
  ZerodhaPlaceOrderResponse,
  ZerodhaProtectedMarketRequest,
  ZerodhaProtectedMarketResponse,
  ZerodhaSequencedProtectedMarketRequest,
  ZerodhaSequencedProtectedMarketResponse,
  ZerodhaThreatAnalysis,
  ZerodhaThreatHistoryResponse,
  ZerodhaThreatLatestResponse,
  ZerodhaThreatRunResponse,
  ZerodhaStatusResponse,
} from "@/types/api";
import { IApiService } from "./api.types";

const devAuthDisabled =
  process.env.NEXT_PUBLIC_DISABLE_AUTH === "true" ||
  process.env.NODE_ENV === "development";
const apiDebugEnabled = process.env.NEXT_PUBLIC_API_DEBUG === "true";

export class APIError extends Error {
  constructor(
    public status: number,
    public message: string,
    public details?: unknown,
  ) {
    super(message || "API request failed");
    this.name = "APIError";
  }
}

export class NetworkError extends Error {
  constructor(
    public method: string,
    public url: string,
    public originalMessage: string,
  ) {
    super(`Unable to reach ${url} (${method}). ${originalMessage}`);
    this.name = "NetworkError";
  }
}

// Helper function to get auth token
async function getAuthToken(): Promise<string | null> {
  return sessionStorage.getAccessToken();
}

type ApiRequestOptions = RequestInit & {
  token?: string;
  _retry?: boolean;
  skipAuth?: boolean;
  skipUnauthorizedRefresh?: boolean;
};

// Flag to prevent infinite refresh loops
let isRefreshing = false;
let refreshPromise: Promise<boolean> | null = null;

/**
 * API Service - Wrapper around URL resolver for making API calls
 */
class apiServiceClass implements IApiService {
  async parseErrorResponse(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text.trim()) {
      return {
        message:
          response.statusText ||
          `Request failed with status ${response.status}`,
      };
    }

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async fetch<T>(
    url: string,
    options: ApiRequestOptions = {},
  ): Promise<T> {
    const method = options.method || "GET";
    // Start a collapsed group to keep the console clean
    this.groupCollapsed(`🚀 API Request: ${method} ${url}`);

    try {
      let token = options.token;
      if (!token && !options.skipAuth) {
        token = (await getAuthToken()) || undefined;
      }

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...((options.headers as Record<string, string>) || {}),
      };

      if (token) {
        headers.Authorization = `Bearer ${token}`;
        this.log("Auth: Token attached");
      }

      this.log("Config:", { url, method, headers, body: options.body });

      const response = await fetch(url, { ...options, headers });

      if (!response.ok) {
        // Handle 401 Unauthorized with Retry Logic
        if (
          response.status === 401 &&
          !options._retry &&
          !options.skipUnauthorizedRefresh &&
          !devAuthDisabled
        ) {
          this.info("⚠️ 401 Unauthorized: Attempting token refresh...");

          if (!isRefreshing) {
            isRefreshing = true;
            refreshPromise = this.refreshToken()
              .then(() => {
                this.log("✅ Token refreshed successfully");
                return true;
              })
              .catch(async (err) => {
                this.error("❌ Token refresh failed:", err);
                if (typeof window !== "undefined") {
                  sessionStorage.clearSession();
                  await signOut({ redirect: true, callbackUrl: "/login" });
                }
                return false;
              })
              .finally(() => {
                refreshPromise = null;
                isRefreshing = false;
              });
          }

          const refreshed = await refreshPromise;
          if (refreshed) {
            await new Promise(resolve => setTimeout(resolve, 50));
            this.groupEnd(); // Close current group before retrying to prevent nesting
            return this.fetch<T>(url, { ...options, _retry: true, token: undefined });
          }
        }

        // Handle other errors
        const errorData = await this.parseErrorResponse(response);
        const fallbackMessage =
          response.statusText || `Request failed with status ${response.status}`;
        const errorMessage = deriveApiErrorMessage(errorData, fallbackMessage);

        this.error(`❌ API Error ${response.status}:`, errorData);
        throw new APIError(response.status, errorMessage, errorData);
      }

      const data = await response.json();
      this.log("✅ API Response Success:", data);
      return data;

    } catch (err: unknown) {
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'CanceledError')) {
        this.log("Request canceled:", (err as { reason?: string }).reason || err.message);
        throw err;
      }

      if (!(err instanceof APIError) && !(err instanceof NetworkError)) {
        const message = err instanceof Error ? err.message : String(err);
        this.error("❌ Network or Unexpected Error:", message);
        throw new NetworkError(method, url, message);
      }
      throw err;
    } finally {
      this.groupEnd();
    }
  }

  // HTTP methods
  get<T>(url: string, options?: RequestInit): Promise<T> {
    return this.fetch<T>(url, { method: "GET", ...options });
  }

  post<T>(
    url: string,
    data?: unknown,
    options: ApiRequestOptions = {},
  ): Promise<T> {
    return this.fetch<T>(url, {
      ...options,
      method: "POST",
      body: data ? JSON.stringify(data) : undefined,
    });
  }

  put<T>(url: string, data?: unknown): Promise<T> {
    return this.fetch<T>(url, {
      method: "PUT",
      body: data ? JSON.stringify(data) : undefined,
    });
  }

  patch<T>(url: string, data?: unknown): Promise<T> {
    return this.fetch<T>(url, {
      method: "PATCH",
      body: data ? JSON.stringify(data) : undefined,
    });
  }

  delete<T>(url: string): Promise<T> {
    return this.fetch<T>(url, {
      method: "DELETE",
    });
  }

  // ===== Log functions =====
  groupCollapsed(label: string): void {
    if (!apiDebugEnabled) return;
    if (typeof console.groupCollapsed === "function") {
      console.groupCollapsed(label);
    } else {
      console.group(label);
    }
  }

  group(label: string): void {
    if (!apiDebugEnabled) return;
    if (typeof console.group === "function") {
      console.group(label);
    }
  }

  groupEnd(): void {
    if (!apiDebugEnabled) return;
    if (typeof console.groupEnd === "function") {
      console.groupEnd();
    }
  }

  log(...args: unknown[]): void {
    if (!apiDebugEnabled) return;
    console.log(...args);
  }

  info(...args: unknown[]): void {
    if (!apiDebugEnabled) return;
    console.info(...args);
  }

  warn(...args: unknown[]): void {
    if (!apiDebugEnabled) return;
    console.warn(...args);
  }

  error(...args: unknown[]): void {
    console.error(...args);
  }

  // ===== Auth Endpoints =====

  /**
   * Register new user
   */
  register(data: {
    email: string;
    username: string;
    password: string;
    full_name?: string;
  }): Promise<RegisterResponse> {
    return this.post<RegisterResponse>(URLs.auth.register(), data, {
      skipAuth: true,
      skipUnauthorizedRefresh: true,
    });
  }

  /**
   * Login user
   */
  login(data: {
    email?: string;
    username?: string;
    password: string;
  }): Promise<LoginResponse> {
    return this.post<LoginResponse>(URLs.auth.login(), data, {
      skipAuth: true,
      skipUnauthorizedRefresh: true,
    });
  }

  /**
   * Logout user
   */
  logout(): Promise<void> {
    return this.post<void>(URLs.auth.logout(), {});
  }

  /**
   * Refresh access token
   */
  async refreshToken(): Promise<RefreshTokenResponse> {
    const refreshToken = sessionStorage.getRefreshToken();
    if (!refreshToken) {
      throw new Error("No refresh token available");
    }

    this.group("Refreshing access token");
    this.log("Current refresh token:", refreshToken);

    // Make refresh call WITHOUT Authorization header since we're using refresh token in body
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    const response = await fetch(URLs.auth.refresh(), {
      method: "POST",
      headers,
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!response.ok) {
      const error = await this.parseErrorResponse(response);
      const fallbackMessage =
        response.statusText || `Request failed with status ${response.status}`;
      const errorMessage = deriveApiErrorMessage(error, fallbackMessage);
      this.error("Refresh token request failed:", error);
      throw new APIError(response.status, errorMessage, error);
    }

    const data = await response.json() as RefreshTokenResponse;
    this.log("Received new tokens:", data);
    this.groupEnd();

    if (data.access_token && data.refresh_token) {
      sessionStorage.setTokens(data.access_token, data.refresh_token);
      syncTokenToCookie(data.access_token);
    }

    return data;
  }

  /**
   * Get current user info
   */
  getCurrentUser(): Promise<UserResponse> {
    return this.get<UserResponse>(URLs.auth.me());
  }

  /**
   * Update password
   */
  updatePassword(data: UpdatePasswordRequest): Promise<void> {
    return this.put<void>(URLs.auth.updatePassword(), data);
  }

  /**
   * Get user profile
   */
  getProfile(): Promise<UpdateProfileRequest> {
    return this.get<UpdateProfileRequest>(URLs.auth.getProfile());
  }

  /**
   * Update user profile
   */
  updateProfile(data: UpdateProfileRequest): Promise<void> {
    return this.put<void>(URLs.auth.updateProfile(), data);
  }

  /**
   * Forgot password
   */
  forgotPassword(data: { email: string }): Promise<{ message: string }> {
    return this.post<{ message: string }>(URLs.auth.forgotPassword(), data, {
      skipAuth: true,
      skipUnauthorizedRefresh: true,
    });
  }

  /**
   * Reset password
   */
  resetPassword(data: {
    token: string;
    new_password: string;
    confirm_password: string;
  }): Promise<{ message: string }> {
    return this.post<{ message: string }>(URLs.auth.resetPassword(), data, {
      skipAuth: true,
      skipUnauthorizedRefresh: true,
    });
  }

  // ===== User Endpoints (Admin) =====

  /**
   * Get user list (admin only)
   */
  getUsers(): Promise<PaginatedResponse<UserResponse>> {
    return this.get<PaginatedResponse<UserResponse>>(URLs.users.list());
  }

  /**
   * Get specific user
   */
  getUser(id: number): Promise<UserResponse> {
    return this.get<UserResponse>(URLs.users.get(id));
  }

  /**
   * Update user (admin only)
   */
  updateUser(
    id: number,
    data: Partial<UserResponse>
  ): Promise<UserResponse> {
    return this.put<UserResponse>(URLs.users.update(id), data);
  }

  /**
   * Delete user (admin only)
   */
  deleteUser(id: number): Promise<void> {
    return this.delete<void>(URLs.users.delete(id));
  }

  /**
   * Get user's jobs
   */
  getUserJobs(
    id: number
  ): Promise<PaginatedResponse<JobResponse>> {
    return this.get<PaginatedResponse<JobResponse>>(URLs.users.getJobs(id));
  }

  // ===== Health Check Endpoints =====

  /**
   * Ping health endpoint
   */
  healthCheck(): Promise<Record<string, unknown>> {
    return this.get<Record<string, unknown>>(URLs.health.ping());
  }

  /**
   * Check database health
   */
  healthCheckDB(): Promise<Record<string, unknown>> {
    return this.get<Record<string, unknown>>(URLs.health.db());
  }

  /**
   * Check Redis health
   */
  healthCheckRedis(): Promise<Record<string, unknown>> {
    return this.get<Record<string, unknown>>(URLs.health.redis());
  }

  /**
   * Full health check
   */
  healthCheckFull(): Promise<FullHealthCheckResponse> {
    return this.get<FullHealthCheckResponse>(URLs.health.full());
  }

  // ===== Job Endpoints =====

  /**
   * Create an asynchronous AI job.
   */
  createJob(data: JobCreate): Promise<JobResponse> {
    return this.post<JobResponse>(URLs.jobs.create(), data);
  }

  // ===== Run Endpoints (Multi-LLM Fan-Out) =====

  /**
   * Create a Research Run — fans out the prompt to all selected (provider, model) pairs as Stage 1 jobs.
   */
  createRun(data: RunCreate): Promise<RunResponse> {
    return this.post<RunResponse>(URLs.runs.create(), data);
  }

  reserveAutoRebalanceRunLabel(portfolio: AutoRebalancePortfolioKey): Promise<AutoRebalanceRunReservationResponse> {
    return this.post<AutoRebalanceRunReservationResponse>(URLs.runs.autoRebalanceLabel(), { portfolio });
  }

  queueAutoRebalanceCompletionEmail(data: AutoRebalanceCompletionEmailRequest): Promise<{ status: string }> {
    return this.post<{ status: string }>(URLs.runs.autoRebalanceCompletionEmail(), data);
  }

  getRuns(params?: { page?: number; limit?: number; summary?: boolean }): Promise<PaginatedResponse<RunListItem>> {
    const qs = new URLSearchParams();
    if (params?.page) qs.set("page", String(params.page));
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.summary) qs.set("summary", "true");
    const query = qs.toString();
    return this.get<PaginatedResponse<RunListItem>>(`${URLs.runs.list()}${query ? `?${query}` : ""}`);
  }

  getFullRuns(params?: { page?: number; limit?: number }): Promise<PaginatedResponse<RunResponse>> {
    const qs = new URLSearchParams();
    if (params?.page) qs.set("page", String(params.page));
    if (params?.limit) qs.set("limit", String(params.limit));
    const query = qs.toString();
    return this.get<PaginatedResponse<RunResponse>>(`${URLs.runs.list()}${query ? `?${query}` : ""}`);
  }

  getRun(id: number): Promise<RunResponse> {
    return this.get<RunResponse>(URLs.runs.get(id));
  }

  cancelRun(id: number): Promise<RunResponse> {
    return this.post<RunResponse>(URLs.runs.cancel(id), {});
  }

  /**
   * Get paginated AI jobs with optional server-side filtering.
   */
  getJobs(params?: { page?: number; limit?: number; status?: string; q?: string }, signal?: AbortSignal): Promise<PaginatedResponse<JobResponse>> {
    const qs = new URLSearchParams();
    if (params?.page) qs.set("page", String(params.page));
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.status && params.status !== "all") qs.set("status", params.status);
    if (params?.q?.trim()) qs.set("q", params.q.trim());
    const query = qs.toString();
    return this.get<PaginatedResponse<JobResponse>>(`${URLs.jobs.list()}${query ? `?${query}` : ""}`, { signal });
  }

  /**
   * Get a single AI job.
   */
  getJob(id: number): Promise<JobResponse> {
    return this.get<JobResponse>(URLs.jobs.get(id));
  }

  cancelJob(id: number): Promise<JobResponse> {
    return this.post<JobResponse>(URLs.jobs.cancel(id), {});
  }

  // ===== Provider Endpoints =====

  getProviders({ signal, prompt }: { signal?: AbortSignal; prompt?: string }): Promise<ProviderInfo[]> {
    const qs = new URLSearchParams();
    if (prompt?.trim()) qs.set("prompt", prompt.trim());
    const query = qs.toString();
    const url = `${URLs.providers.list()}${query ? `?${query}` : ""}`;
    return this.get<ProviderInfo[]>(url, { signal });
  }

  getApiUsageSummary(params?: {
    period?: 'today' | 'week' | 'month' | 'custom';
    custom_start?: string;
    custom_end?: string;
  }): Promise<ApiUsageSummaryResponse> {
    const qs = new URLSearchParams();
    if (params?.period) qs.set('period', params.period);
    if (params?.custom_start) qs.set('custom_start', params.custom_start);
    if (params?.custom_end) qs.set('custom_end', params.custom_end);
    const query = qs.toString();
    return this.get<ApiUsageSummaryResponse>(
      `${URLs.apiUsage.summary()}${query ? `?${query}` : ''}`,
    );
  }


  getLlmCostHistory(params: {
    provider: string;
    day_limit?: number;
    run_limit?: number;
  }): Promise<LlmCostHistoryResponse> {
    const qs = new URLSearchParams();
    qs.set('provider', params.provider);
    if (params.day_limit) qs.set('day_limit', String(params.day_limit));
    if (params.run_limit) qs.set('run_limit', String(params.run_limit));
    return this.get<LlmCostHistoryResponse>(
      `${URLs.apiUsage.llmCostHistory()}?${qs.toString()}`,
    );
  }

  getLlmPerformance(params?: { limit?: number }): Promise<LlmPerformanceResponse> {
    const qs = new URLSearchParams();
    if (params?.limit) qs.set('limit', String(params.limit));
    const query = qs.toString();
    return this.get<LlmPerformanceResponse>(
      `${URLs.apiUsage.llmPerformance()}${query ? `?${query}` : ''}`,
    );
  }

  // ===== Prompt Endpoints =====

  getPrompts(params?: { q?: string }, signal?: AbortSignal): Promise<PromptResponse[]> {
    const qs = new URLSearchParams();
    if (params?.q?.trim()) qs.set("q", params.q.trim());
    const query = qs.toString();
    const url = `${URLs.prompts.list()}${query ? `?${query}` : ""}`;
    return this.fetch<PromptResponse[]>(url, { method: "GET", signal });
  }

  getPrompt(id: number): Promise<PromptResponse> {
    return this.get<PromptResponse>(URLs.prompts.get(id));
  }

  createPrompt(data: PromptCreate): Promise<PromptResponse> {
    return this.post<PromptResponse>(URLs.prompts.create(), data);
  }

  updatePrompt(id: number, data: PromptUpdate): Promise<PromptResponse> {
    return this.put<PromptResponse>(URLs.prompts.update(id), data);
  }

  deletePrompt(id: number): Promise<void> {
    return this.delete<void>(URLs.prompts.delete(id));
  }

  // ===== Zerodha Endpoints =====

  zerodhaLoginUrl(): Promise<ZerodhaLoginUrlResponse> {
    return this.get<ZerodhaLoginUrlResponse>(URLs.zerodha.loginUrl());
  }

  zerodhaCallback(request_token: string): Promise<ZerodhaStatusResponse> {
    return this.post<ZerodhaStatusResponse>(URLs.zerodha.callback(), { request_token });
  }

  zerodhaStatus(): Promise<ZerodhaStatusResponse> {
    return this.get<ZerodhaStatusResponse>(URLs.zerodha.status());
  }

  zerodhaPortfolioOverview(): Promise<ZerodhaPortfolioOverviewResponse> {
    return this.get<ZerodhaPortfolioOverviewResponse>(URLs.zerodha.portfolio());
  }

  zerodhaPortfolioSnapshot(snapshotDate: string): Promise<ZerodhaPortfolioSnapshotDetail> {
    return this.get<ZerodhaPortfolioSnapshotDetail>(URLs.zerodha.portfolioSnapshot(snapshotDate));
  }

  zerodhaSyncPortfolio(): Promise<ZerodhaPortfolioSyncResponse> {
    return this.post<ZerodhaPortfolioSyncResponse>(URLs.zerodha.portfolioSync(), {});
  }

  zerodhaOrders(): Promise<{ data: ZerodhaOrder[] }> {
    return this.get<{ data: ZerodhaOrder[] }>(URLs.zerodha.orders());
  }

  zerodhaPrepareBasketOrders(data: ZerodhaPrepareBasketRequest): Promise<ZerodhaPrepareBasketResponse> {
    return this.post<ZerodhaPrepareBasketResponse>(URLs.zerodha.prepareBasketOrders(), data);
  }

  zerodhaPlaceOrder(data: ZerodhaPlaceOrderRequest): Promise<ZerodhaPlaceOrderResponse> {
    return this.post<ZerodhaPlaceOrderResponse>(URLs.zerodha.orders(), data);
  }

  zerodhaPlaceProtectedMarketOrders(data: ZerodhaProtectedMarketRequest): Promise<ZerodhaProtectedMarketResponse> {
    return this.post<ZerodhaProtectedMarketResponse>(URLs.zerodha.placeProtectedMarketOrders(), data);
  }

  zerodhaPlaceProtectedMarketOrdersSequenced(data: ZerodhaSequencedProtectedMarketRequest): Promise<ZerodhaSequencedProtectedMarketResponse> {
    return this.post<ZerodhaSequencedProtectedMarketResponse>(URLs.zerodha.placeProtectedMarketOrdersSequenced(), data);
  }

  zerodhaDisconnect(): Promise<{ message: string }> {
    return this.delete<{ message: string }>(URLs.zerodha.disconnect());
  }

  zerodhaEventsLatest(): Promise<ZerodhaEventsLatestResponse> {
    return this.get<ZerodhaEventsLatestResponse>(URLs.zerodha.eventsLatest());
  }

  zerodhaEventsHistory(params?: { limit?: number }): Promise<ZerodhaEventsHistoryResponse> {
    const qs = new URLSearchParams();
    if (params?.limit) qs.set('limit', String(params.limit));
    const query = qs.toString();
    return this.get<ZerodhaEventsHistoryResponse>(
      `${URLs.zerodha.eventsHistory()}${query ? `?${query}` : ''}`,
    );
  }

  zerodhaEventJob(jobId: number): Promise<ZerodhaEventsAnalysis> {
    return this.get<ZerodhaEventsAnalysis>(URLs.zerodha.eventJob(jobId));
  }

  zerodhaRunEvents(data?: PortfolioEventRunRequest): Promise<ZerodhaEventsRunResponse> {
    return this.post<ZerodhaEventsRunResponse>(URLs.zerodha.eventsRun(), data ?? {});
  }

  zerodhaThreatsLatest(): Promise<ZerodhaThreatLatestResponse> {
    return this.get<ZerodhaThreatLatestResponse>(URLs.zerodha.threatsLatest());
  }

  zerodhaThreatsHistory(params?: { limit?: number }): Promise<ZerodhaThreatHistoryResponse> {
    const qs = new URLSearchParams();
    if (params?.limit) qs.set('limit', String(params.limit));
    const query = qs.toString();
    return this.get<ZerodhaThreatHistoryResponse>(
      `${URLs.zerodha.threatsHistory()}${query ? `?${query}` : ''}`,
    );
  }

  zerodhaThreatJob(jobId: number): Promise<ZerodhaThreatAnalysis> {
    return this.get<ZerodhaThreatAnalysis>(URLs.zerodha.threatJob(jobId));
  }

  zerodhaRunThreats(data?: PortfolioEventRunRequest): Promise<ZerodhaThreatRunResponse> {
    return this.post<ZerodhaThreatRunResponse>(URLs.zerodha.threatsRun(), data ?? {});
  }

  indmoneyUsPortfolioOverview(): Promise<IndMoneyUsPortfolioOverviewResponse> {
    return this.get<IndMoneyUsPortfolioOverviewResponse>(URLs.indmoneyUs.portfolio());
  }

  indmoneyUsPortfolioSnapshot(snapshotId: number): Promise<IndMoneyUsPortfolioSnapshotDetail> {
    return this.get<IndMoneyUsPortfolioSnapshotDetail>(URLs.indmoneyUs.portfolioSnapshot(snapshotId));
  }

  indmoneyUsCreatePortfolioSnapshot(
    data: IndMoneyUsPortfolioSnapshotCreateRequest,
  ): Promise<IndMoneyUsPortfolioSnapshotDetail> {
    return this.post<IndMoneyUsPortfolioSnapshotDetail>(URLs.indmoneyUs.portfolio(), data);
  }

  indmoneyUsCurrentPrices(
    data: IndMoneyUsCurrentPricesRequest,
  ): Promise<IndMoneyUsCurrentPricesResponse> {
    return this.post<IndMoneyUsCurrentPricesResponse>(URLs.indmoneyUs.currentPrices(), data);
  }

  indmoneyUsEventsLatest(): Promise<IndMoneyUsEventsLatestResponse> {
    return this.get<IndMoneyUsEventsLatestResponse>(URLs.indmoneyUs.eventsLatest());
  }

  indmoneyUsEventsHistory(params?: { limit?: number }): Promise<IndMoneyUsEventsHistoryResponse> {
    const qs = new URLSearchParams();
    if (params?.limit) qs.set('limit', String(params.limit));
    const query = qs.toString();
    return this.get<IndMoneyUsEventsHistoryResponse>(
      `${URLs.indmoneyUs.eventsHistory()}${query ? `?${query}` : ''}`,
    );
  }

  indmoneyUsEventJob(jobId: number): Promise<IndMoneyUsEventsAnalysis> {
    return this.get<IndMoneyUsEventsAnalysis>(URLs.indmoneyUs.eventJob(jobId));
  }

  indmoneyUsRunEvents(data?: PortfolioEventRunRequest): Promise<IndMoneyUsEventsRunResponse> {
    return this.post<IndMoneyUsEventsRunResponse>(URLs.indmoneyUs.eventsRun(), data ?? {});
  }

  indmoneyUsThreatsLatest(): Promise<IndMoneyUsThreatLatestResponse> {
    return this.get<IndMoneyUsThreatLatestResponse>(URLs.indmoneyUs.threatsLatest());
  }

  indmoneyUsThreatsHistory(params?: { limit?: number }): Promise<IndMoneyUsThreatHistoryResponse> {
    const qs = new URLSearchParams();
    if (params?.limit) qs.set('limit', String(params.limit));
    const query = qs.toString();
    return this.get<IndMoneyUsThreatHistoryResponse>(
      `${URLs.indmoneyUs.threatsHistory()}${query ? `?${query}` : ''}`,
    );
  }

  indmoneyUsThreatJob(jobId: number): Promise<IndMoneyUsThreatAnalysis> {
    return this.get<IndMoneyUsThreatAnalysis>(URLs.indmoneyUs.threatJob(jobId));
  }

  indmoneyUsRunThreats(data?: PortfolioEventRunRequest): Promise<IndMoneyUsThreatRunResponse> {
    return this.post<IndMoneyUsThreatRunResponse>(URLs.indmoneyUs.threatsRun(), data ?? {});
  }

  polymarketState(): Promise<PolymarketBotState> {
    return this.get<PolymarketBotState>(URLs.polymarket.state());
  }

  polymarketStart(): Promise<PolymarketBotState> {
    return this.post<PolymarketBotState>(URLs.polymarket.start());
  }

  polymarketStop(): Promise<PolymarketBotState> {
    return this.post<PolymarketBotState>(URLs.polymarket.stop());
  }

  polymarketPause(): Promise<PolymarketBotState> {
    return this.post<PolymarketBotState>(URLs.polymarket.pause());
  }

  polymarketResume(): Promise<PolymarketBotState> {
    return this.post<PolymarketBotState>(URLs.polymarket.resume());
  }

  polymarketLiveUnlock(): Promise<PolymarketBotState> {
    return this.post<PolymarketBotState>(URLs.polymarket.liveUnlock());
  }

  polymarketLiveLock(): Promise<PolymarketBotState> {
    return this.post<PolymarketBotState>(URLs.polymarket.liveLock());
  }

  polymarketLiveDoctor(): Promise<PolymarketBotState> {
    return this.post<PolymarketBotState>(URLs.polymarket.liveDoctor());
  }

  polymarketLiveBalanceRefresh(): Promise<PolymarketBotState> {
    return this.post<PolymarketBotState>(URLs.polymarket.liveBalanceRefresh());
  }

  polymarketLiveRedeem(data?: {
    conditionIds?: string[];
  }): Promise<PolymarketBotState> {
    const conditionIds = Array.isArray(data?.conditionIds)
      ? Array.from(
          new Set(
            data.conditionIds
              .map((value) => value.trim())
              .filter((value) => value.length > 0),
          ),
        )
      : [];
    return this.post<PolymarketBotState>(
      URLs.polymarket.liveRedeem(),
      conditionIds.length > 0 ? { condition_ids: conditionIds } : undefined,
    );
  }

  polymarketLiveEmergencyStop(): Promise<PolymarketBotState> {
    return this.post<PolymarketBotState>(URLs.polymarket.liveEmergencyStop());
  }

  polymarketLiveResetEmergencyStop(): Promise<PolymarketBotState> {
    return this.post<PolymarketBotState>(URLs.polymarket.liveResetEmergencyStop());
  }

  polymarketUpdateLiveLimits(data: PolymarketLiveLimitUpdate): Promise<PolymarketBotState> {
    return this.patch<PolymarketBotState>(URLs.polymarket.liveLimits(), data);
  }

  polymarketLiveTradeConfirm(tradeId: string): Promise<PolymarketBotState> {
    return this.post<PolymarketBotState>(URLs.polymarket.liveTradeConfirm(tradeId));
  }

  polymarketLiveTradeReject(tradeId: string): Promise<PolymarketBotState> {
    return this.post<PolymarketBotState>(URLs.polymarket.liveTradeReject(tradeId));
  }

  polymarketLiveRejectAll(): Promise<PolymarketBotState> {
    return this.post<PolymarketBotState>(URLs.polymarket.liveRejectAll());
  }

  polymarketManualInvest(data: {
    orders: PolymarketManualInvestOrderRequest[];
  }): Promise<PolymarketManualInvestResponse> {
    return this.post<PolymarketManualInvestResponse>(
      URLs.polymarket.manualInvest(),
      data,
    );
  }

  polymarketAddTrackedAccount(data: PolymarketTrackedAccountCreate): Promise<PolymarketBotState> {
    return this.post<PolymarketBotState>(URLs.polymarket.trackedAccounts(), data);
  }

  polymarketUpdateTrackedAccount(
    accountId: string,
    data: PolymarketTrackedAccountUpdate,
  ): Promise<PolymarketBotState> {
    return this.patch<PolymarketBotState>(URLs.polymarket.trackedAccount(accountId), data);
  }

  polymarketRefreshTrackedAccountNetWorth(accountId: string): Promise<PolymarketBotState> {
    return this.post<PolymarketBotState>(URLs.polymarket.trackedAccountNetWorthRefresh(accountId));
  }

  polymarketDeleteTrackedAccount(accountId: string): Promise<PolymarketBotState> {
    return this.delete<PolymarketBotState>(URLs.polymarket.trackedAccount(accountId));
  }

  polymarketDiscoveryDebug(
    data: PolymarketDiscoveryDebugRequest,
  ): Promise<PolymarketDiscoveryDebugReport> {
    return this.post<PolymarketDiscoveryDebugReport>(URLs.polymarket.discoveryDebug(), data);
  }

  getBullpenAutoLiveSummary(): Promise<BullpenAutoLiveSummaryResponse> {
    return this.get<BullpenAutoLiveSummaryResponse>(URLs.bullpenAutoLive.summary());
  }

  getBullpenAutoLiveState(): Promise<BullpenAutoLiveState> {
    return this.get<BullpenAutoLiveState>(URLs.bullpenAutoLive.state());
  }

  getBullpenAutoLiveSettings(): Promise<BullpenAutoLiveSettings> {
    return this.get<BullpenAutoLiveSettings>(URLs.bullpenAutoLive.settings());
  }

  updateBullpenAutoLiveSettings(
    data: BullpenAutoLiveSettingsUpdate,
  ): Promise<BullpenAutoLiveSettings> {
    return this.put<BullpenAutoLiveSettings>(URLs.bullpenAutoLive.settings(), data);
  }

  resetBullpenAutoLiveSettings(): Promise<BullpenAutoLiveSettings> {
    return this.post<BullpenAutoLiveSettings>(URLs.bullpenAutoLive.resetSettings());
  }

  getBullpenAutoLiveRuns(): Promise<BullpenAutoLiveRun[]> {
    return this.get<BullpenAutoLiveRun[]>(URLs.bullpenAutoLive.runs());
  }

  getBullpenAutoLiveDecisions(): Promise<BullpenAutoLiveDecision[]> {
    return this.get<BullpenAutoLiveDecision[]>(URLs.bullpenAutoLive.decisions());
  }

  getBullpenTradeAnalysis(params?: {
    status?: string;
    finalTag?: string;
    fromDate?: string;
    toDate?: string;
    strategyVersion?: string;
    category?: string;
    topic?: string;
  }): Promise<BullpenTradeAnalysisListResponse> {
    const query = new URLSearchParams();
    if (params?.status) query.set("status", params.status);
    if (params?.finalTag) query.set("final_tag", params.finalTag);
    if (params?.fromDate) query.set("from_date", params.fromDate);
    if (params?.toDate) query.set("to_date", params.toDate);
    if (params?.strategyVersion) {
      query.set("strategy_version", params.strategyVersion);
    }
    if (params?.category) query.set("category", params.category);
    if (params?.topic) query.set("topic", params.topic);
    const baseUrl = URLs.bullpenTradeAnalysis.list();
    const url = query.size > 0 ? `${baseUrl}?${query.toString()}` : baseUrl;
    return this.get<BullpenTradeAnalysisListResponse>(url);
  }

  getBullpenTradeAnalysisDetail(
    tradeId: string,
  ): Promise<BullpenTradeAnalysisDetailResponse> {
    return this.get<BullpenTradeAnalysisDetailResponse>(
      URLs.bullpenTradeAnalysis.detail(tradeId),
    );
  }

  recomputeBullpenTradeAnalysis(
    tradeId: string,
  ): Promise<BullpenTradeAnalysisDetailResponse> {
    return this.post<BullpenTradeAnalysisDetailResponse>(
      URLs.bullpenTradeAnalysis.recompute(tradeId),
    );
  }

  runBullpenAutoLiveOnce(
    data?: BullpenAutoLiveRunOnceRequest,
  ): Promise<BullpenAutoLiveRun> {
    return this.post<BullpenAutoLiveRun>(URLs.bullpenAutoLive.runOnce(), data);
  }

  startBullpenAutoLive(): Promise<BullpenAutoLiveState> {
    return this.post<BullpenAutoLiveState>(URLs.bullpenAutoLive.start());
  }

  stopBullpenAutoLive(): Promise<BullpenAutoLiveState> {
    return this.post<BullpenAutoLiveState>(URLs.bullpenAutoLive.stop());
  }

  pauseBullpenAutoLive(): Promise<BullpenAutoLiveState> {
    return this.post<BullpenAutoLiveState>(URLs.bullpenAutoLive.pause());
  }

  resumeBullpenAutoLive(): Promise<BullpenAutoLiveState> {
    return this.post<BullpenAutoLiveState>(URLs.bullpenAutoLive.resume());
  }

  emergencyStopBullpenAutoLive(): Promise<BullpenAutoLiveState> {
    return this.post<BullpenAutoLiveState>(URLs.bullpenAutoLive.emergencyStop());
  }

  clearEmergencyStopBullpenAutoLive(): Promise<BullpenAutoLiveState> {
    return this.post<BullpenAutoLiveState>(URLs.bullpenAutoLive.clearEmergencyStop());
  }

  bullpenAiAutoLiveSummary(): Promise<BullpenAutoLiveSummaryResponse> {
    return this.getBullpenAutoLiveSummary();
  }

  bullpenAiAutoLiveState(): Promise<BullpenAutoLiveState> {
    return this.getBullpenAutoLiveState();
  }

  bullpenAiAutoLiveSettings(): Promise<BullpenAutoLiveSettings> {
    return this.getBullpenAutoLiveSettings();
  }

  bullpenAiAutoLiveUpdateSettings(
    data: BullpenAutoLiveSettingsUpdate,
  ): Promise<BullpenAutoLiveSettings> {
    return this.updateBullpenAutoLiveSettings(data);
  }

  bullpenAiAutoLiveResetSettings(): Promise<BullpenAutoLiveSettings> {
    return this.resetBullpenAutoLiveSettings();
  }

  bullpenAiAutoLiveRuns(): Promise<BullpenAutoLiveRun[]> {
    return this.getBullpenAutoLiveRuns();
  }

  bullpenAiAutoLiveDecisions(): Promise<BullpenAutoLiveDecision[]> {
    return this.getBullpenAutoLiveDecisions();
  }

  bullpenAiTradeAnalysis(params?: {
    status?: string;
    finalTag?: string;
    fromDate?: string;
    toDate?: string;
    strategyVersion?: string;
    category?: string;
    topic?: string;
  }): Promise<BullpenTradeAnalysisListResponse> {
    return this.getBullpenTradeAnalysis(params);
  }

  bullpenAiTradeAnalysisDetail(
    tradeId: string,
  ): Promise<BullpenTradeAnalysisDetailResponse> {
    return this.getBullpenTradeAnalysisDetail(tradeId);
  }

  bullpenAiTradeAnalysisRecompute(
    tradeId: string,
  ): Promise<BullpenTradeAnalysisDetailResponse> {
    return this.recomputeBullpenTradeAnalysis(tradeId);
  }

  bullpenAiAutoLiveRunOnce(
    data?: BullpenAutoLiveRunOnceRequest,
  ): Promise<BullpenAutoLiveRun> {
    return this.runBullpenAutoLiveOnce(data);
  }

  bullpenAiAutoLiveStart(): Promise<BullpenAutoLiveState> {
    return this.startBullpenAutoLive();
  }

  bullpenAiAutoLiveStop(): Promise<BullpenAutoLiveState> {
    return this.stopBullpenAutoLive();
  }

  bullpenAiAutoLivePause(): Promise<BullpenAutoLiveState> {
    return this.pauseBullpenAutoLive();
  }

  bullpenAiAutoLiveResume(): Promise<BullpenAutoLiveState> {
    return this.resumeBullpenAutoLive();
  }

  bullpenAiAutoLiveEmergencyStop(): Promise<BullpenAutoLiveState> {
    return this.emergencyStopBullpenAutoLive();
  }

  bullpenAiAutoLiveClearEmergencyStop(): Promise<BullpenAutoLiveState> {
    return this.clearEmergencyStopBullpenAutoLive();
  }

  getTradingBotsSummary(): Promise<TradingBotsSummaryResponse> {
    return this.get<TradingBotsSummaryResponse>(URLs.tradingBots.summary());
  }

  polymarketDirectState(): Promise<PolymarketBotState> {
    return this.get<PolymarketBotState>(URLs.polymarketDirect.state());
  }

  polymarketDirectStart(): Promise<PolymarketBotState> {
    return this.post<PolymarketBotState>(URLs.polymarketDirect.start());
  }

  polymarketDirectStop(): Promise<PolymarketBotState> {
    return this.post<PolymarketBotState>(URLs.polymarketDirect.stop());
  }

  polymarketDirectPause(): Promise<PolymarketBotState> {
    return this.post<PolymarketBotState>(URLs.polymarketDirect.pause());
  }

  polymarketDirectResume(): Promise<PolymarketBotState> {
    return this.post<PolymarketBotState>(URLs.polymarketDirect.resume());
  }

  polymarketDirectLiveUnlock(): Promise<PolymarketBotState> {
    return this.post<PolymarketBotState>(URLs.polymarketDirect.liveUnlock());
  }

  polymarketDirectLiveLock(): Promise<PolymarketBotState> {
    return this.post<PolymarketBotState>(URLs.polymarketDirect.liveLock());
  }

  polymarketDirectLiveDoctor(): Promise<PolymarketBotState> {
    return this.post<PolymarketBotState>(URLs.polymarketDirect.liveDoctor());
  }

  polymarketDirectLiveBalanceRefresh(): Promise<PolymarketBotState> {
    return this.post<PolymarketBotState>(URLs.polymarketDirect.liveBalanceRefresh());
  }

  polymarketDirectLiveRedeem(): Promise<PolymarketBotState> {
    return this.post<PolymarketBotState>(URLs.polymarketDirect.liveRedeem());
  }

  polymarketDirectLiveEmergencyStop(): Promise<PolymarketBotState> {
    return this.post<PolymarketBotState>(URLs.polymarketDirect.liveEmergencyStop());
  }

  polymarketDirectLiveResetEmergencyStop(): Promise<PolymarketBotState> {
    return this.post<PolymarketBotState>(URLs.polymarketDirect.liveResetEmergencyStop());
  }

  polymarketDirectUpdateLiveLimits(data: PolymarketLiveLimitUpdate): Promise<PolymarketBotState> {
    return this.patch<PolymarketBotState>(URLs.polymarketDirect.liveLimits(), data);
  }

  polymarketDirectLiveTradeConfirm(tradeId: string): Promise<PolymarketBotState> {
    return this.post<PolymarketBotState>(URLs.polymarketDirect.liveTradeConfirm(tradeId));
  }

  polymarketDirectLiveTradeReject(tradeId: string): Promise<PolymarketBotState> {
    return this.post<PolymarketBotState>(URLs.polymarketDirect.liveTradeReject(tradeId));
  }

  polymarketDirectLiveRejectAll(): Promise<PolymarketBotState> {
    return this.post<PolymarketBotState>(URLs.polymarketDirect.liveRejectAll());
  }

  polymarketDirectAddTrackedAccount(data: PolymarketTrackedAccountCreate): Promise<PolymarketBotState> {
    return this.post<PolymarketBotState>(URLs.polymarketDirect.trackedAccounts(), data);
  }

  polymarketDirectUpdateTrackedAccount(
    accountId: string,
    data: PolymarketTrackedAccountUpdate,
  ): Promise<PolymarketBotState> {
    return this.patch<PolymarketBotState>(URLs.polymarketDirect.trackedAccount(accountId), data);
  }

  polymarketDirectDeleteTrackedAccount(accountId: string): Promise<PolymarketBotState> {
    return this.delete<PolymarketBotState>(URLs.polymarketDirect.trackedAccount(accountId));
  }

  polymarketDirectDiscoveryDebug(
    data: PolymarketDiscoveryDebugRequest,
  ): Promise<PolymarketDiscoveryDebugReport> {
    return this.post<PolymarketDiscoveryDebugReport>(URLs.polymarketDirect.discoveryDebug(), data);
  }

  getTradingBotsOverview(): Promise<TradingBotsOverviewResponse> {
    return this.get<TradingBotsOverviewResponse>(URLs.tradingBots.overview());
  }

  googleSheetsAuthUrl(): Promise<GoogleSheetsAuthUrlResponse> {
    return this.get<GoogleSheetsAuthUrlResponse>(URLs.googleSheets.authUrl());
  }

  googleSheetsAdminConfig(): Promise<GoogleSheetsAdminConfigResponse> {
    return this.get<GoogleSheetsAdminConfigResponse>(URLs.googleSheets.adminConfig());
  }

  googleSheetsUpdateAdminConfig(
    data: GoogleSheetsAdminConfigUpdateRequest,
  ): Promise<GoogleSheetsAdminConfigResponse> {
    return this.put<GoogleSheetsAdminConfigResponse>(
      URLs.googleSheets.adminConfig(),
      data,
    );
  }

  googleSheetsExchangeCode(code: string): Promise<{ status: string; message: string }> {
    return this.post<{ status: string; message: string }>(URLs.googleSheets.exchangeCode(), { code });
  }

  googleSheetsStatus(): Promise<GoogleSheetsStatusResponse> {
    return this.get<GoogleSheetsStatusResponse>(URLs.googleSheets.status());
  }

  googleSheetsDisconnect(): Promise<{ message: string }> {
    return this.delete<{ message: string }>(URLs.googleSheets.disconnect());
  }

  googleSheetsSaveDefaultSheet(
    data: GoogleSheetsDefaultSheetRequest,
  ): Promise<GoogleSheetsDefaultSheetResponse> {
    return this.put<GoogleSheetsDefaultSheetResponse>(
      URLs.googleSheets.defaultSheet(),
      data,
    );
  }

  googleSheetsExportJob(data: GoogleSheetsExportJobRequest): Promise<GoogleSheetsExportResponse> {
    return this.post<GoogleSheetsExportResponse>(URLs.googleSheets.exportJob(), data);
  }

  googleSheetsExportRun(data: GoogleSheetsExportRunRequest): Promise<GoogleSheetsExportResponse> {
    return this.post<GoogleSheetsExportResponse>(URLs.googleSheets.exportRun(), data);
  }

  googleSheetsImport(data: GoogleSheetsImportRequest): Promise<GoogleSheetsExportResponse> {
    return this.post<GoogleSheetsExportResponse>(URLs.googleSheets.import(), data);
  }
}

const apiService = new apiServiceClass();

export { apiService };
