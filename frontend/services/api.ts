import { URLs } from "@/lib/urls";
import { sessionStorage } from "@/services/session";
import { syncTokenToCookie } from "@/services/cookies";
import { signOut } from "next-auth/react";
import {
  LoginResponse,
  RegisterResponse,
  UserResponse,
  JobResponse,
  PaginatedResponse,
  UpdateProfileRequest,
  UpdatePasswordRequest,
  RefreshTokenResponse,
  FullHealthCheckResponse,
  JobCreate,
  PromptResponse,
  PromptCreate,
  PromptUpdate,
  ProviderInfo,
  RunCreate,
  RunResponse,
  ZerodhaLoginUrlResponse,
  ZerodhaOrder,
  ZerodhaPlaceOrderRequest,
  ZerodhaPlaceOrderResponse,
  ZerodhaStatusResponse,
} from "@/types/api";
import { IApiService } from "./api.types";

export class APIError extends Error {
  constructor(
    public status: number,
    public message: string,
    public details?: any,
  ) {
    super(message);
    this.name = "APIError";
  }
}

// Helper function to get auth token
async function getAuthToken(): Promise<string | null> {
  return sessionStorage.getAccessToken();
}

// Flag to prevent infinite refresh loops
let isRefreshing = false;
let refreshPromise: Promise<boolean> | null = null;

/**
 * API Service - Wrapper around URL resolver for making API calls
 */
class apiServiceClass implements IApiService {
  async fetch<T>(
    url: string,
    options: RequestInit & { token?: string; _retry?: boolean } = {},
  ): Promise<T> {
    const method = options.method || "GET";
    // Start a collapsed group to keep the console clean
    this.groupCollapsed(`🚀 API Request: ${method} ${url}`);

    try {
      let token = options.token;
      if (!token) {
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
        if (response.status === 401 && !options._retry) {
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
        const errorData = await response.json().catch(() => ({
          message: response.statusText,
        }));

        this.error(`❌ API Error ${response.status}:`, errorData);
        throw new APIError(response.status, errorData.message || errorData.detail, errorData);
      }

      const data = await response.json();
      this.log("✅ API Response Success:", data);
      return data;

    } catch (err: any) {
      if (err.name === 'AbortError' || err.name === 'CanceledError') {
        this.log("Request canceled:", err.reason || err.message);
        throw err;
      }

      if (!(err instanceof APIError)) {
        this.error("❌ Network or Unexpected Error:", err.message || err);
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

  post<T>(url: string, data?: any): Promise<T> {
    return this.fetch<T>(url, {
      method: "POST",
      body: data ? JSON.stringify(data) : undefined,
    });
  }

  put<T>(url: string, data?: any): Promise<T> {
    return this.fetch<T>(url, {
      method: "PUT",
      body: data ? JSON.stringify(data) : undefined,
    });
  }

  patch<T>(url: string, data?: any): Promise<T> {
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
    if (typeof console.groupCollapsed === "function") {
      console.groupCollapsed(label);
    } else {
      console.group(label);
    }
  }

  group(label: string): void {
    if (typeof console.group === "function") {
      console.group(label);
    }
  }

  groupEnd(): void {
    if (typeof console.groupEnd === "function") {
      console.groupEnd();
    }
  }

  log(...args: any[]): void {
    console.log(...args);
  }

  info(...args: any[]): void {
    console.info(...args);
  }

  warn(...args: any[]): void {
    console.warn(...args);
  }

  error(...args: any[]): void {
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
    return this.post<RegisterResponse>(URLs.auth.register(), data);
  }

  /**
   * Login user
   */
  login(data: {
    email?: string;
    username?: string;
    password: string;
  }): Promise<LoginResponse> {
    return this.post<LoginResponse>(URLs.auth.login(), data);
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
      const error = await response.json().catch(() => ({
        message: response.statusText,
      }));
      this.error("Refresh token request failed:", error);
      throw new APIError(response.status, error.message || error.detail, error);
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
    return this.post<{ message: string }>(URLs.auth.forgotPassword(), data);
  }

  /**
   * Reset password
   */
  resetPassword(data: {
    token: string;
    new_password: string;
    confirm_password: string;
  }): Promise<{ message: string }> {
    return this.post<{ message: string }>(URLs.auth.resetPassword(), data);
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
  healthCheck(): Promise<Record<string, any>> {
    return this.get<Record<string, any>>(URLs.health.ping());
  }

  /**
   * Check database health
   */
  healthCheckDB(): Promise<Record<string, any>> {
    return this.get<Record<string, any>>(URLs.health.db());
  }

  /**
   * Check Redis health
   */
  healthCheckRedis(): Promise<Record<string, any>> {
    return this.get<Record<string, any>>(URLs.health.redis());
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

  getRuns(params?: { page?: number; limit?: number }): Promise<PaginatedResponse<RunResponse>> {
    const qs = new URLSearchParams();
    if (params?.page) qs.set("page", String(params.page));
    if (params?.limit) qs.set("limit", String(params.limit));
    const query = qs.toString();
    return this.get<PaginatedResponse<RunResponse>>(`${URLs.runs.list()}${query ? `?${query}` : ""}`);
  }

  getRun(id: number): Promise<RunResponse> {
    return this.get<RunResponse>(URLs.runs.get(id));
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

  // ===== Provider Endpoints =====

  getProviders({ signal }: { signal?: AbortSignal }): Promise<ProviderInfo[]> {
    return this.get<ProviderInfo[]>(URLs.providers.list(), { signal });
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

  zerodhaOrders(): Promise<{ data: ZerodhaOrder[] }> {
    return this.get<{ data: ZerodhaOrder[] }>(URLs.zerodha.orders());
  }

  zerodhaPlaceOrder(data: ZerodhaPlaceOrderRequest): Promise<ZerodhaPlaceOrderResponse> {
    return this.post<ZerodhaPlaceOrderResponse>(URLs.zerodha.orders(), data);
  }

  zerodhaDisconnect(): Promise<{ message: string }> {
    return this.delete<{ message: string }>(URLs.zerodha.disconnect());
  }
}

const apiService = new apiServiceClass();

export { apiService };
