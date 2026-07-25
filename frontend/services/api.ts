import { resolveApiReadTransportCandidates, URLs } from "@/lib/urls";
import { deriveApiErrorMessage } from "@/lib/apiErrors";
import { isBullpenTradeAnalysisListResponse } from "@/lib/bullpenTradeAnalysisFallback";
import {
  notifyAuthTokensRefreshed,
  sessionStorage,
} from "@/services/session";
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
  BullpenAutoLiveRunOrdersResponse,
  BullpenAutoLiveRunOnceRequest,
  BullpenAutoLiveDecision,
  BullpenAutoLivePersistedStatus,
  BullpenAutoLiveState,
  BullpenAutoLiveSummaryResponse,
  BullpenRunAuditDetailResponse,
  BullpenRunAuditFeedbackCreateRequest,
  BullpenRunAuditFeedbackDetail,
  BullpenRunAuditFeedbackSummary,
  BullpenRunAuditFinding,
  BullpenRunAuditListResponse,
  BullpenRunAuditManualCheck,
  BullpenRunAuditManualCheckUpdateRequest,
  BullpenRunAuditMaterializeResponse,
  BullpenRunAuditRemark,
  BullpenRunAuditRemarkCreateRequest,
  BullpenRunAuditSectionResponse,
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
  PortfolioAnalysisHistoryItem,
  PortfolioEventRunRequest,
  ProviderInfo,
  PaginatedResponse,
  RegisterResponse,
  RefreshTokenResponse,
  RunCreate,
  RunListItem,
  AutoRebalanceRunReservationResponse,
  AutoRebalanceCompletionEmailRequest,
  AutoRebalanceHistoryDetailResponse,
  AutoRebalanceHistoryListResponse,
  AutoRebalancePortfolioKey,
  AutoRebalanceStageKey,
  AutoRebalanceStageResponse,
  AutoRebalanceStageUpdateRequest,
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
import { IApiService, type ApiRequestControl } from "./api.types";

const devAuthDisabled =
  process.env.NEXT_PUBLIC_DISABLE_AUTH === "true" ||
  process.env.NODE_ENV === "development";
const apiDebugEnabled = process.env.NEXT_PUBLIC_API_DEBUG === "true";
const DEFAULT_API_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_API_READ_TRANSPORT_TIMEOUT_MS = 6_000;
const SLOW_API_REQUEST_THRESHOLD_MS = 2_000;
const BULLPEN_RUN_START_SECONDARY_DELAY_MS = 250;
const BULLPEN_RUN_START_TERTIARY_DELAY_MS = 750;

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

export class RequestTimeoutError extends NetworkError {
  constructor(
    method: string,
    url: string,
    public timeoutMs: number,
  ) {
    super(method, url, `Request timed out after ${timeoutMs}ms`);
    this.name = "RequestTimeoutError";
  }
}

export class InvalidAPIResponseError extends Error {
  constructor(
    public method: string,
    public url: string,
    public reason: string,
  ) {
    super(`Invalid response from ${url} (${method}). ${reason}`);
    this.name = "InvalidAPIResponseError";
  }
}

const AUTO_REBALANCE_START_RECONCILIATION_DELAYS_MS = [0, 750, 1_500, 3_000, 6_000] as const;

type AnalysisHistoryResponse = {
  history: PortfolioAnalysisHistoryItem[];
};

function matchesAutoRebalanceAnalysis(
  item: PortfolioAnalysisHistoryItem,
  data?: PortfolioEventRunRequest,
) {
  if (
    !data?.auto_rebalance_portfolio ||
    typeof data.auto_rebalance_sequence !== "number"
  ) {
    return false;
  }
  return (
    item.auto_rebalance_portfolio === data.auto_rebalance_portfolio &&
    item.auto_rebalance_sequence === data.auto_rebalance_sequence &&
    (!data.auto_rebalance_label ||
      !item.auto_rebalance_label ||
      item.auto_rebalance_label === data.auto_rebalance_label)
  );
}

async function reconcileTimedOutAutoRebalanceStart<TResponse>(
  error: unknown,
  data: PortfolioEventRunRequest | undefined,
  loadHistory: () => Promise<AnalysisHistoryResponse>,
  buildResponse: (item: PortfolioAnalysisHistoryItem) => Promise<TResponse>,
): Promise<TResponse> {
  if (
    !(error instanceof RequestTimeoutError) ||
    !data?.auto_rebalance_portfolio ||
    typeof data.auto_rebalance_sequence !== "number"
  ) {
    throw error;
  }

  for (const delayMs of AUTO_REBALANCE_START_RECONCILIATION_DELAYS_MS) {
    if (delayMs > 0) {
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs));
    }
    try {
      const history = await loadHistory();
      const match = history.history.find((item) =>
        matchesAutoRebalanceAnalysis(item, data),
      );
      if (match) {
        return await buildResponse(match);
      }
    } catch {
      // The queueing request may still be committing. Keep reconciling until the
      // bounded grace period ends, then surface the original timeout.
    }
  }
  throw error;
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
} & ApiRequestControl;

type RequestAbortContext = {
  signal: AbortSignal;
  didTimeout: () => boolean;
  cleanup: () => void;
};

function createRequestAbortContext(
  callerSignal: AbortSignal | null | undefined,
  timeoutMs: number,
): RequestAbortContext {
  const controller = new AbortController();
  let timedOut = false;

  const abortForCaller = () => controller.abort();
  if (callerSignal?.aborted) {
    abortForCaller();
  } else {
    callerSignal?.addEventListener("abort", abortForCaller, { once: true });
  }

  const timeoutId = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      globalThis.clearTimeout(timeoutId);
      callerSignal?.removeEventListener("abort", abortForCaller);
    },
  };
}

function waitForRequestAbort<T>(promise: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) {
    return Promise.reject(new DOMException("Request aborted", "AbortError"));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Request aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function isRetryableReadError(error: unknown) {
  if (
    error instanceof RequestTimeoutError ||
    error instanceof NetworkError ||
    error instanceof InvalidAPIResponseError
  ) {
    return true;
  }
  return error instanceof APIError && (error.status === 429 || error.status >= 500);
}

function getReadFallbackReason(error: unknown) {
  if (error instanceof RequestTimeoutError) return "timeout";
  if (error instanceof InvalidAPIResponseError) return "invalid_response";
  if (error instanceof NetworkError) return "network_error";
  if (error instanceof APIError) return `http_${error.status}`;
  if (error instanceof Error) return error.name || "error";
  return "unknown_error";
}

function isAmbiguousBullpenRunStartError(error: unknown) {
  return (
    error instanceof RequestTimeoutError ||
    error instanceof NetworkError ||
    error instanceof InvalidAPIResponseError ||
    (error instanceof APIError && (error.status === 429 || error.status >= 500))
  );
}

function isBullpenAutoLiveRunResponse(
  value: unknown,
  expectedRunId?: string,
): value is BullpenAutoLiveRun {
  const validStatuses = new Set([
    "running",
    "confirming",
    "completed",
    "partial_success",
    "failed",
    "skipped",
  ]);
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !validStatuses.has(String(value.status)) ||
    typeof value.triggered_by !== "string" ||
    typeof value.dry_run !== "boolean" ||
    typeof value.started_at !== "string" ||
    typeof value.summary !== "string" ||
    !Array.isArray(value.stage_results)
  ) {
    return false;
  }
  return expectedRunId === undefined || value.id === expectedRunId;
}

function logBullpenRunStartFallback(input: {
  runId: string;
  fromStage: "primary" | "secondary";
  toStage: "secondary" | "tertiary";
  approach: string;
  reason: string;
}) {
  console.warn(
    JSON.stringify({
      event: "bullpen_auto_live_run_start_fallback_triggered",
      run_id: input.runId,
      from_stage: input.fromStage,
      to_stage: input.toStage,
      approach: input.approach,
      reason: input.reason,
    }),
  );
}

function waitForBoundedFallback(delayMs: number) {
  return new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs));
}

function logReadFallback(input: {
  url: string;
  fromStage: string;
  toStage: string;
  toTransport: string;
  reason: string;
}) {
  const parsed = new URL(
    input.url,
    typeof window === "undefined" ? "http://localhost" : window.location.origin,
  );
  console.warn(
    JSON.stringify({
      event: "api_read_fallback_triggered",
      method: "GET",
      resource: `${parsed.pathname}${parsed.search}`,
      from_stage: input.fromStage,
      to_stage: input.toStage,
      to_transport: input.toTransport,
      reason: input.reason,
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isNullableString(value: unknown) {
  return value === null || typeof value === "string";
}

function isZerodhaStatusResponse(value: unknown): value is ZerodhaStatusResponse {
  if (!isRecord(value) || typeof value.connected !== "boolean") return false;
  return (
    isNullableString(value.login_time) &&
    isNullableString(value.expires_at) &&
    (value.last_portfolio_sync_at === undefined ||
      isNullableString(value.last_portfolio_sync_at)) &&
    (value.last_portfolio_snapshot_date === undefined ||
      isNullableString(value.last_portfolio_snapshot_date))
  );
}

function isThreatLatestResponse(
  value: unknown,
): value is ZerodhaThreatLatestResponse | IndMoneyUsThreatLatestResponse {
  if (!isRecord(value) || !("analysis" in value)) return false;
  if (value.analysis === null) return true;
  return (
    isRecord(value.analysis) &&
    typeof value.analysis.job_id === "number" &&
    typeof value.analysis.status === "string" &&
    typeof value.analysis.provider === "string" &&
    typeof value.analysis.model === "string"
  );
}

function isPaginatedResponse<T>(value: unknown): value is PaginatedResponse<T> {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    typeof value.total === "number" &&
    Number.isFinite(value.total) &&
    typeof value.page === "number" &&
    Number.isFinite(value.page) &&
    typeof value.size === "number" &&
    Number.isFinite(value.size) &&
    typeof value.pages === "number" &&
    Number.isFinite(value.pages)
  );
}

function hasHeader(headers: Record<string, string>, headerName: string) {
  const normalizedHeaderName = headerName.toLowerCase();
  return Object.keys(headers).some(
    (key) => key.toLowerCase() === normalizedHeaderName,
  );
}

function createCorrelationId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// Flag to prevent infinite refresh loops
let isRefreshing = false;
let refreshPromise: Promise<boolean> | null = null;

/**
 * API Service - Wrapper around URL resolver for making API calls
 */
class apiServiceClass implements IApiService {
  private readonly inFlightReads = new Map<string, Promise<unknown>>();

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
    const timeoutMs = options.timeoutMs ?? DEFAULT_API_REQUEST_TIMEOUT_MS;
    const startedAt =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    let abortContext: RequestAbortContext | null = null;
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
      }
      if (!hasHeader(headers, "X-Correlation-ID")) {
        headers["X-Correlation-ID"] = createCorrelationId();
      }

      const {
        token: _token,
        _retry: _retry,
        skipAuth: _skipAuth,
        skipUnauthorizedRefresh: _skipUnauthorizedRefresh,
        timeoutMs: _timeoutMs,
        validate: _validate,
        signal: callerSignal,
        ...requestInit
      } = options;
      void _token;
      void _retry;
      void _skipAuth;
      void _skipUnauthorizedRefresh;
      void _timeoutMs;
      void _validate;
      abortContext = createRequestAbortContext(callerSignal, timeoutMs);

      this.log("Config:", {
        url,
        method,
        timeoutMs,
        hasAuthToken: Boolean(token),
        hasBody: Boolean(options.body),
      });

      const response = await fetch(url, {
        ...requestInit,
        headers,
        signal: abortContext.signal,
      });

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

          const pendingRefresh = refreshPromise;
          if (!pendingRefresh) {
            throw new Error("Token refresh did not start.");
          }
          const refreshed = await waitForRequestAbort(
            pendingRefresh,
            abortContext.signal,
          );
          if (refreshed) {
            return this.fetch<T>(url, { ...options, _retry: true, token: undefined });
          }
        }

        // Handle other errors
        const errorData = await this.parseErrorResponse(response);
        const fallbackMessage =
          response.statusText || `Request failed with status ${response.status}`;
        const errorMessage = deriveApiErrorMessage(errorData, fallbackMessage);

        this.error(`API request failed with HTTP ${response.status}.`, {
          method,
          url,
        });
        throw new APIError(response.status, errorMessage, errorData);
      }

      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new InvalidAPIResponseError(
          method,
          url,
          "Response body was not valid JSON.",
        );
      }
      if (options.validate && !options.validate(data)) {
        throw new InvalidAPIResponseError(
          method,
          url,
          "Response body did not match the expected schema.",
        );
      }
      const durationMs = Math.round(
        (typeof performance !== "undefined" ? performance.now() : Date.now()) -
          startedAt,
      );
      this.log("Response received:", {
        method,
        url,
        status: response.status,
        durationMs,
      });
      if (process.env.NODE_ENV === "development") {
        console.debug("[api timing]", { method, status: response.status, durationMs });
      }
      if (durationMs >= SLOW_API_REQUEST_THRESHOLD_MS) {
        this.warn("Slow API request:", { method, url, durationMs });
      }
      return data as T;

    } catch (err: unknown) {
      const durationMs = Math.round(
        (typeof performance !== "undefined" ? performance.now() : Date.now()) -
          startedAt,
      );
      if (abortContext?.didTimeout()) {
        if (process.env.NODE_ENV === "development") {
          console.debug("[api timing]", { method, status: "timeout", durationMs });
        }
        this.warn(`API request timed out after ${timeoutMs}ms.`, {
          method,
          url,
          durationMs,
        });
        throw new RequestTimeoutError(method, url, timeoutMs);
      }

      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'CanceledError')) {
        this.log("Request canceled:", { method, url });
        throw err;
      }

      if (
        !(err instanceof APIError) &&
        !(err instanceof NetworkError) &&
        !(err instanceof InvalidAPIResponseError)
      ) {
        const message = err instanceof Error ? err.message : String(err);
        this.error("❌ Network or Unexpected Error:", message);
        throw new NetworkError(method, url, message);
      }
      throw err;
    } finally {
      abortContext?.cleanup();
      this.groupEnd();
    }
  }

  // HTTP methods
  private async getAcrossTransports<T>(
    url: string,
    options: ApiRequestOptions = {},
  ): Promise<T> {
    const candidates = resolveApiReadTransportCandidates(url);
    let lastError: unknown = null;

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      try {
        return await this.fetch<T>(candidate.url, {
          method: "GET",
          ...options,
          timeoutMs:
            options.timeoutMs ?? DEFAULT_API_READ_TRANSPORT_TIMEOUT_MS,
        });
      } catch (error) {
        lastError = error;
        const nextCandidate = candidates[index + 1];
        if (
          !nextCandidate ||
          options.signal?.aborted ||
          !isRetryableReadError(error)
        ) {
          throw error;
        }

        logReadFallback({
          url,
          fromStage: candidate.stage,
          toStage: nextCandidate.stage,
          toTransport: nextCandidate.transport,
          reason: getReadFallbackReason(error),
        });
      }
    }

    throw lastError;
  }

  get<T>(url: string, options: ApiRequestOptions = {}): Promise<T> {
    // A caller-owned abort signal must retain independent cancellation
    // semantics. Unsignalled dashboard reads can safely share one in-flight
    // request, preventing mount/refresh fan-out from duplicating work.
    if (options.signal) {
      return this.getAcrossTransports<T>(url, options);
    }

    const existing = this.inFlightReads.get(url);
    if (existing) {
      return existing as Promise<T>;
    }

    const request = this.getAcrossTransports<T>(url, options).finally(() => {
      if (this.inFlightReads.get(url) === request) {
        this.inFlightReads.delete(url);
      }
    });
    this.inFlightReads.set(url, request);
    return request;
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

  put<T>(
    url: string,
    data?: unknown,
    options: ApiRequestOptions = {},
  ): Promise<T> {
    return this.fetch<T>(url, {
      ...options,
      method: "PUT",
      body: data ? JSON.stringify(data) : undefined,
    });
  }

  patch<T>(
    url: string,
    data?: unknown,
    options: ApiRequestOptions = {},
  ): Promise<T> {
    return this.fetch<T>(url, {
      ...options,
      method: "PATCH",
      body: data ? JSON.stringify(data) : undefined,
    });
  }

  delete<T>(url: string, options: ApiRequestOptions = {}): Promise<T> {
    return this.fetch<T>(url, {
      ...options,
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
  async refreshToken(
    options?: ApiRequestControl,
  ): Promise<RefreshTokenResponse> {
    const refreshToken = sessionStorage.getRefreshToken();
    if (!refreshToken) {
      throw new Error("No refresh token available");
    }

    this.group("Refreshing access token");

    // Make refresh call WITHOUT Authorization header since we're using refresh token in body
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Correlation-ID": createCorrelationId(),
    };
    const abortContext = createRequestAbortContext(
      options?.signal,
      options?.timeoutMs ?? DEFAULT_API_REQUEST_TIMEOUT_MS,
    );

    try {
      const response = await fetch(URLs.auth.refresh(), {
        method: "POST",
        headers,
        body: JSON.stringify({ refresh_token: refreshToken }),
        signal: abortContext.signal,
      });

      if (!response.ok) {
        const error = await this.parseErrorResponse(response);
        const fallbackMessage =
          response.statusText || `Request failed with status ${response.status}`;
        const errorMessage = deriveApiErrorMessage(error, fallbackMessage);
        this.error("Token refresh request failed.", { status: response.status });
        throw new APIError(response.status, errorMessage, error);
      }

      const data = await response.json() as RefreshTokenResponse;

      if (data.access_token && data.refresh_token) {
        sessionStorage.setTokens(data.access_token, data.refresh_token);
        syncTokenToCookie(data.access_token);
        notifyAuthTokensRefreshed({
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresIn: data.expires_in,
        });
      }

      return data;
    } catch (error) {
      if (abortContext.didTimeout()) {
        throw new RequestTimeoutError(
          "POST",
          URLs.auth.refresh(),
          options?.timeoutMs ?? DEFAULT_API_REQUEST_TIMEOUT_MS,
        );
      }
      throw error;
    } finally {
      abortContext.cleanup();
      this.groupEnd();
    }
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

  getAutoRebalanceHistory(
    portfolio: AutoRebalancePortfolioKey,
    params?: { limit?: number },
  ): Promise<AutoRebalanceHistoryListResponse> {
    const suffix = params?.limit ? `&limit=${params.limit}` : "";
    return this.get<AutoRebalanceHistoryListResponse>(
      `${URLs.runs.autoRebalanceHistory(portfolio)}${suffix}`,
    );
  }

  getAutoRebalanceHistoryDetail(
    portfolio: AutoRebalancePortfolioKey,
    sequence: number,
  ): Promise<AutoRebalanceHistoryDetailResponse> {
    return this.get<AutoRebalanceHistoryDetailResponse>(
      URLs.runs.autoRebalanceHistoryDetail(portfolio, sequence),
    );
  }

  updateAutoRebalanceStage(
    portfolio: AutoRebalancePortfolioKey,
    sequence: number,
    stage: AutoRebalanceStageKey,
    data: AutoRebalanceStageUpdateRequest,
  ): Promise<AutoRebalanceStageResponse> {
    return this.patch<AutoRebalanceStageResponse>(
      URLs.runs.autoRebalanceStage(portfolio, sequence, stage),
      data,
    );
  }

  getRuns(params?: { page?: number; limit?: number; summary?: boolean }): Promise<PaginatedResponse<RunListItem>> {
    const qs = new URLSearchParams();
    if (params?.page) qs.set("page", String(params.page));
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.summary) qs.set("summary", "true");
    const query = qs.toString();
    return this.get<PaginatedResponse<RunListItem>>(
      `${URLs.runs.list()}${query ? `?${query}` : ""}`,
      { validate: isPaginatedResponse<RunListItem> },
    );
  }

  getFullRuns(
    params?: { page?: number; limit?: number },
    options?: ApiRequestControl,
  ): Promise<PaginatedResponse<RunResponse>> {
    const qs = new URLSearchParams();
    if (params?.page) qs.set("page", String(params.page));
    if (params?.limit) qs.set("limit", String(params.limit));
    const query = qs.toString();
    return this.get<PaginatedResponse<RunResponse>>(
      `${URLs.runs.list()}${query ? `?${query}` : ""}`,
      {
        ...options,
        validate: isPaginatedResponse<RunResponse>,
      },
    );
  }

  getRun(id: number, options?: ApiRequestControl): Promise<RunResponse> {
    return this.get<RunResponse>(URLs.runs.get(id), options);
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
    return this.get<ZerodhaStatusResponse>(URLs.zerodha.status(), {
      validate: isZerodhaStatusResponse,
    });
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

  async zerodhaRunEvents(
    data?: PortfolioEventRunRequest,
  ): Promise<ZerodhaEventsRunResponse> {
    try {
      return await this.post<ZerodhaEventsRunResponse>(
        URLs.zerodha.eventsRun(),
        data ?? {},
      );
    } catch (error) {
      return reconcileTimedOutAutoRebalanceStart(
        error,
        data,
        () => this.zerodhaEventsHistory({ limit: 50 }),
        async (item) => {
          const analysis = await this.zerodhaEventJob(item.job_id);
          if (!analysis.snapshot_date || !analysis.captured_at) {
            throw new Error(
              "Queued Zerodha events job is missing snapshot metadata.",
            );
          }
          return {
            job_id: analysis.job_id,
            status: analysis.status,
            provider: analysis.provider,
            model: analysis.model,
            snapshot_date: analysis.snapshot_date,
            captured_at: analysis.captured_at,
            created_at: analysis.created_at,
          };
        },
      );
    }
  }

  zerodhaThreatsLatest(): Promise<ZerodhaThreatLatestResponse> {
    return this.get<ZerodhaThreatLatestResponse>(URLs.zerodha.threatsLatest(), {
      validate: isThreatLatestResponse,
    });
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

  async zerodhaRunThreats(
    data?: PortfolioEventRunRequest,
  ): Promise<ZerodhaThreatRunResponse> {
    try {
      return await this.post<ZerodhaThreatRunResponse>(
        URLs.zerodha.threatsRun(),
        data ?? {},
      );
    } catch (error) {
      return reconcileTimedOutAutoRebalanceStart(
        error,
        data,
        () => this.zerodhaThreatsHistory({ limit: 50 }),
        async (item) => {
          const analysis = await this.zerodhaThreatJob(item.job_id);
          if (!analysis.snapshot_date || !analysis.captured_at) {
            throw new Error(
              "Queued Zerodha threats job is missing snapshot metadata.",
            );
          }
          return {
            job_id: analysis.job_id,
            status: analysis.status,
            provider: analysis.provider,
            model: analysis.model,
            snapshot_date: analysis.snapshot_date,
            captured_at: analysis.captured_at,
            created_at: analysis.created_at,
          };
        },
      );
    }
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

  async indmoneyUsRunEvents(
    data?: PortfolioEventRunRequest,
  ): Promise<IndMoneyUsEventsRunResponse> {
    try {
      return await this.post<IndMoneyUsEventsRunResponse>(
        URLs.indmoneyUs.eventsRun(),
        data ?? {},
      );
    } catch (error) {
      return reconcileTimedOutAutoRebalanceStart(
        error,
        data,
        () => this.indmoneyUsEventsHistory({ limit: 50 }),
        async (item) => {
          const analysis = await this.indmoneyUsEventJob(item.job_id);
          if (
            analysis.snapshot_id == null ||
            !analysis.snapshot_date ||
            !analysis.captured_at
          ) {
            throw new Error(
              "Queued INDmoney events job is missing snapshot metadata.",
            );
          }
          return {
            job_id: analysis.job_id,
            status: analysis.status,
            provider: analysis.provider,
            model: analysis.model,
            snapshot_id: analysis.snapshot_id,
            snapshot_date: analysis.snapshot_date,
            captured_at: analysis.captured_at,
            created_at: analysis.created_at,
          };
        },
      );
    }
  }

  indmoneyUsThreatsLatest(): Promise<IndMoneyUsThreatLatestResponse> {
    return this.get<IndMoneyUsThreatLatestResponse>(
      URLs.indmoneyUs.threatsLatest(),
      { validate: isThreatLatestResponse },
    );
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

  async indmoneyUsRunThreats(
    data?: PortfolioEventRunRequest,
  ): Promise<IndMoneyUsThreatRunResponse> {
    try {
      return await this.post<IndMoneyUsThreatRunResponse>(
        URLs.indmoneyUs.threatsRun(),
        data ?? {},
      );
    } catch (error) {
      return reconcileTimedOutAutoRebalanceStart(
        error,
        data,
        () => this.indmoneyUsThreatsHistory({ limit: 50 }),
        async (item) => {
          const analysis = await this.indmoneyUsThreatJob(item.job_id);
          if (
            analysis.snapshot_id == null ||
            !analysis.snapshot_date ||
            !analysis.captured_at
          ) {
            throw new Error(
              "Queued INDmoney threats job is missing snapshot metadata.",
            );
          }
          return {
            job_id: analysis.job_id,
            status: analysis.status,
            provider: analysis.provider,
            model: analysis.model,
            snapshot_id: analysis.snapshot_id,
            snapshot_date: analysis.snapshot_date,
            captured_at: analysis.captured_at,
            created_at: analysis.created_at,
          };
        },
      );
    }
  }

  polymarketState(options?: ApiRequestControl): Promise<PolymarketBotState> {
    return this.get<PolymarketBotState>(URLs.polymarket.state(), options);
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

  polymarketLiveBalanceRefresh(
    options?: ApiRequestControl,
  ): Promise<PolymarketBotState> {
    return this.post<PolymarketBotState>(
      URLs.polymarket.liveBalanceRefresh(),
      undefined,
      options,
    );
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
  }, options?: ApiRequestControl): Promise<PolymarketManualInvestResponse> {
    return this.post<PolymarketManualInvestResponse>(
      URLs.polymarket.manualInvest(),
      data,
      options,
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

  getBullpenAutoLiveStatus(
    options?: ApiRequestControl,
  ): Promise<BullpenAutoLivePersistedStatus> {
    return this.get<BullpenAutoLivePersistedStatus>(
      URLs.bullpenAutoLive.status(),
      { cache: "no-store", ...options },
    );
  }

  getBullpenAutoLiveSummary(
    options?: ApiRequestControl,
  ): Promise<BullpenAutoLiveSummaryResponse> {
    return this.get<BullpenAutoLiveSummaryResponse>(
      URLs.bullpenAutoLive.summary(),
      { cache: "no-store", ...options },
    );
  }

  getBullpenAutoLiveDashboardSummary(
    options?: ApiRequestControl,
  ): Promise<BullpenAutoLiveSummaryResponse> {
    return this.get<BullpenAutoLiveSummaryResponse>(
      URLs.bullpenAutoLive.dashboardSummary(),
      { cache: "no-store", ...options },
    );
  }

  getBullpenAutoLiveState(): Promise<BullpenAutoLiveState> {
    return this.get<BullpenAutoLiveState>(
      URLs.bullpenAutoLive.state(),
      { cache: "no-store" },
    );
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

  getBullpenAutoLiveRuns(
    options?: ApiRequestControl,
  ): Promise<BullpenAutoLiveRun[]> {
    return this.get<BullpenAutoLiveRun[]>(
      URLs.bullpenAutoLive.runs(),
      { cache: "no-store", ...options },
    );
  }

  getBullpenAutoLiveRun(
    runId: string,
    options?: ApiRequestControl,
  ): Promise<BullpenAutoLiveRun> {
    return this.get<BullpenAutoLiveRun>(
      URLs.bullpenAutoLive.run(runId),
      { cache: "no-store", ...options },
    );
  }

  getBullpenAutoLiveRunOrders(
    runId: string,
  ): Promise<BullpenAutoLiveRunOrdersResponse> {
    return this.get<BullpenAutoLiveRunOrdersResponse>(
      URLs.bullpenAutoLive.runOrders(runId),
      { cache: "no-store" },
    );
  }

  reconcileBullpenAutoLiveRunOrders(
    runId: string,
  ): Promise<BullpenAutoLiveRunOrdersResponse> {
    return this.post<BullpenAutoLiveRunOrdersResponse>(
      URLs.bullpenAutoLive.reconcileRunOrders(runId),
    );
  }

  retryBullpenAutoLiveExitsAndContinueBuys(
    runId: string,
  ): Promise<BullpenAutoLiveRunOrdersResponse> {
    return this.post<BullpenAutoLiveRunOrdersResponse>(
      URLs.bullpenAutoLive.retryExitsAndContinueBuys(runId),
    );
  }

  getBullpenAutoLiveDecisions(
    options?: ApiRequestControl,
  ): Promise<BullpenAutoLiveDecision[]> {
    return this.get<BullpenAutoLiveDecision[]>(
      URLs.bullpenAutoLive.decisions(),
      { cache: "no-store", ...options },
    );
  }

  retryBullpenAutoLiveOrder(
    intentId: string,
  ): Promise<BullpenAutoLiveRunOrdersResponse> {
    return this.post<BullpenAutoLiveRunOrdersResponse>(
      URLs.bullpenAutoLive.retryOrder(intentId),
    );
  }

  cancelBullpenAutoLiveOrder(
    intentId: string,
  ): Promise<BullpenAutoLiveRunOrdersResponse> {
    return this.post<BullpenAutoLiveRunOrdersResponse>(
      URLs.bullpenAutoLive.cancelOrder(intentId),
    );
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
    return this.get<BullpenTradeAnalysisListResponse>(url, {
      cache: "no-store",
      validate: isBullpenTradeAnalysisListResponse,
    });
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

  getBullpenRunAudits(params?: {
    page?: number;
    limit?: number;
    status?: string;
    triggeredBy?: string;
    dryLiveMode?: string;
    fromDate?: string;
    toDate?: string;
    stageFailure?: string;
    auditStatus?: string;
    findingSeverity?: string;
    feedbackGenerated?: boolean;
    runIdSearch?: string;
  }): Promise<BullpenRunAuditListResponse> {
    const query = new URLSearchParams();
    if (params?.page) query.set("page", String(params.page));
    if (params?.limit) query.set("limit", String(params.limit));
    if (params?.status) query.set("status", params.status);
    if (params?.triggeredBy) query.set("triggered_by", params.triggeredBy);
    if (params?.dryLiveMode) query.set("dry_live_mode", params.dryLiveMode);
    if (params?.fromDate) query.set("from_date", params.fromDate);
    if (params?.toDate) query.set("to_date", params.toDate);
    if (params?.stageFailure) query.set("stage_failure", params.stageFailure);
    if (params?.auditStatus) query.set("audit_status", params.auditStatus);
    if (params?.findingSeverity) {
      query.set("finding_severity", params.findingSeverity);
    }
    if (typeof params?.feedbackGenerated === "boolean") {
      query.set("feedback_generated", String(params.feedbackGenerated));
    }
    if (params?.runIdSearch) query.set("run_id_search", params.runIdSearch);
    const baseUrl = URLs.bullpenRunAudit.list();
    const url = query.size > 0 ? `${baseUrl}?${query.toString()}` : baseUrl;
    return this.get<BullpenRunAuditListResponse>(url, { cache: "no-store" });
  }

  getBullpenRunAuditDetail(
    runId: string,
  ): Promise<BullpenRunAuditDetailResponse> {
    return this.get<BullpenRunAuditDetailResponse>(
      URLs.bullpenRunAudit.detail(runId),
      { cache: "no-store" },
    );
  }

  materializeBullpenRunAudit(
    runId: string,
  ): Promise<BullpenRunAuditMaterializeResponse> {
    return this.post<BullpenRunAuditMaterializeResponse>(
      URLs.bullpenRunAudit.materialize(runId),
    );
  }

  getBullpenRunAuditSection(
    runId: string,
    section: string,
  ): Promise<BullpenRunAuditSectionResponse> {
    return this.get<BullpenRunAuditSectionResponse>(
      URLs.bullpenRunAudit.section(runId, section),
      { cache: "no-store" },
    );
  }

  getBullpenRunAuditFindings(runId: string): Promise<BullpenRunAuditFinding[]> {
    return this.get<BullpenRunAuditFinding[]>(
      URLs.bullpenRunAudit.findings(runId),
      { cache: "no-store" },
    );
  }

  addBullpenRunAuditRemark(
    runId: string,
    data: BullpenRunAuditRemarkCreateRequest,
  ): Promise<BullpenRunAuditRemark> {
    return this.post<BullpenRunAuditRemark>(
      URLs.bullpenRunAudit.remarks(runId),
      data,
    );
  }

  updateBullpenRunAuditManualCheck(
    runId: string,
    data: BullpenRunAuditManualCheckUpdateRequest,
  ): Promise<BullpenRunAuditManualCheck> {
    return this.post<BullpenRunAuditManualCheck>(
      URLs.bullpenRunAudit.manualChecks(runId),
      data,
    );
  }

  createBullpenRunAuditFeedback(
    runId: string,
    data: BullpenRunAuditFeedbackCreateRequest,
  ): Promise<BullpenRunAuditFeedbackSummary> {
    return this.post<BullpenRunAuditFeedbackSummary>(
      URLs.bullpenRunAudit.feedback(runId),
      data,
    );
  }

  getBullpenRunAuditFeedback(
    runId: string,
  ): Promise<BullpenRunAuditFeedbackSummary[]> {
    return this.get<BullpenRunAuditFeedbackSummary[]>(
      URLs.bullpenRunAudit.feedback(runId),
      { cache: "no-store" },
    );
  }

  getBullpenRunAuditFeedbackDetail(
    runId: string,
    feedbackId: number,
  ): Promise<BullpenRunAuditFeedbackDetail> {
    return this.get<BullpenRunAuditFeedbackDetail>(
      URLs.bullpenRunAudit.feedbackDetail(runId, feedbackId),
      { cache: "no-store" },
    );
  }

  exportBullpenRunAudit(runId: string): Promise<Record<string, unknown>> {
    return this.get<Record<string, unknown>>(
      URLs.bullpenRunAudit.export(runId),
      { cache: "no-store" },
    );
  }

  runBullpenAutoLiveOnce(
    data?: BullpenAutoLiveRunOnceRequest,
  ): Promise<BullpenAutoLiveRun> {
    const clientRunId =
      data?.client_run_id?.trim() ||
      (typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `auto-run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
    const request: BullpenAutoLiveRunOnceRequest = {
      ...(data ?? {}),
      client_run_id: clientRunId,
    };

    return this.post<BullpenAutoLiveRun>(
      URLs.bullpenAutoLive.runOnce(),
      request,
      {
        validate: (value) =>
          isBullpenAutoLiveRunResponse(value, clientRunId),
      },
    ).catch(async (primaryError: unknown) => {
      if (!isAmbiguousBullpenRunStartError(primaryError)) {
        throw primaryError;
      }

      logBullpenRunStartFallback({
        runId: clientRunId,
        fromStage: "primary",
        toStage: "secondary",
        approach: "read_durable_run_by_id",
        reason: getReadFallbackReason(primaryError),
      });
      await waitForBoundedFallback(BULLPEN_RUN_START_SECONDARY_DELAY_MS);

      try {
        return await this.getBullpenAutoLiveRun(clientRunId, {
          timeoutMs: 5_000,
          validate: (value) =>
            isBullpenAutoLiveRunResponse(value, clientRunId),
        });
      } catch (secondaryError) {
        logBullpenRunStartFallback({
          runId: clientRunId,
          fromStage: "secondary",
          toStage: "tertiary",
          approach: "match_durable_run_history",
          reason: getReadFallbackReason(secondaryError),
        });
      }

      await waitForBoundedFallback(BULLPEN_RUN_START_TERTIARY_DELAY_MS);
      try {
        const runs = await this.getBullpenAutoLiveRuns({
          timeoutMs: 5_000,
          validate: (value) =>
            Array.isArray(value) &&
            value.every((run) => isBullpenAutoLiveRunResponse(run)),
        });
        const recoveredRun = runs.find((run) => run.id === clientRunId);
        if (recoveredRun && isBullpenAutoLiveRunResponse(recoveredRun, clientRunId)) {
          return recoveredRun;
        }
      } catch {
        // Preserve the primary mutation error after all bounded, read-only
        // reconciliation paths have failed. Never issue a second POST.
      }

      throw primaryError;
    });
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

  bullpenAiAutoLiveRunOrders(
    runId: string,
  ): Promise<BullpenAutoLiveRunOrdersResponse> {
    return this.getBullpenAutoLiveRunOrders(runId);
  }

  bullpenAiAutoLiveReconcileRunOrders(
    runId: string,
  ): Promise<BullpenAutoLiveRunOrdersResponse> {
    return this.reconcileBullpenAutoLiveRunOrders(runId);
  }

  bullpenAiAutoLiveDecisions(): Promise<BullpenAutoLiveDecision[]> {
    return this.getBullpenAutoLiveDecisions();
  }

  bullpenAiAutoLiveRetryOrder(
    intentId: string,
  ): Promise<BullpenAutoLiveRunOrdersResponse> {
    return this.retryBullpenAutoLiveOrder(intentId);
  }

  bullpenAiAutoLiveCancelOrder(
    intentId: string,
  ): Promise<BullpenAutoLiveRunOrdersResponse> {
    return this.cancelBullpenAutoLiveOrder(intentId);
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
