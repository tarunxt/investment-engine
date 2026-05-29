import { UserResponse } from "@/types/api";
import { sessionStorage } from '@/services/session';

/**
 * API Base URL Configuration
 * Adjusts based on environment
 */
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL;
const FRONTEND_BASE_URL = process.env.NEXT_PUBLIC_FRONTEND_URL;

// Derive WebSocket base URL: http → ws, https → wss
const WS_BASE_URL = API_BASE_URL!.replace(/^http/, "ws");

/**
 * URL Resolver - Centralized API endpoint management
 */
export const URLs = {
  // Base URLs
  api: API_BASE_URL,
  frontend: FRONTEND_BASE_URL,

  // Health Check endpoints
  health: {
    ping: () => `${API_BASE_URL}/health`,
    db: () => `${API_BASE_URL}/health/db`,
    redis: () => `${API_BASE_URL}/health/redis`,
    full: () => `${API_BASE_URL}/health/full`,
  },

  // Authentication endpoints
  auth: {
    register: () => `${API_BASE_URL}/auth/register`,
    login: () => `${API_BASE_URL}/auth/login`,
    logout: () => `${API_BASE_URL}/auth/logout`,
    refresh: () => `${API_BASE_URL}/auth/refresh`,
    me: () => `${API_BASE_URL}/auth/me`,
    updatePassword: () => `${API_BASE_URL}/auth/password`,
    getProfile: () => `${API_BASE_URL}/auth/profile`,
    updateProfile: () => `${API_BASE_URL}/auth/profile`,
    forgotPassword: () => `${API_BASE_URL}/auth/forgot-password`,
    resetPassword: () => `${API_BASE_URL}/auth/reset-password`,
  },

  // User endpoints
  users: {
    list: () => `${API_BASE_URL}/users`,
    get: (id: number) => `${API_BASE_URL}/users/${id}`,
    update: (id: number) => `${API_BASE_URL}/users/${id}`,
    delete: (id: number) => `${API_BASE_URL}/users/${id}`,
    getJobs: (id: number) => `${API_BASE_URL}/users/${id}/jobs`,
    getActivity: (id: number) => `${API_BASE_URL}/users/${id}/activity`,
  },

  // Job endpoints
  jobs: {
    create: () => `${API_BASE_URL}/jobs`,
    list: () => `${API_BASE_URL}/jobs`,
    get: (id: number) => `${API_BASE_URL}/jobs/${id}`,
    update: (id: number) => `${API_BASE_URL}/jobs/${id}`,
    delete: (id: number) => `${API_BASE_URL}/jobs/${id}`,
    getCost: (id: number) => `${API_BASE_URL}/jobs/${id}/cost`,
    // WebSocket base URLs — WSClient appends ?token= before each connect attempt
    ws: () => `${WS_BASE_URL}/ws/jobs`,
    wsJob: (id: number) => `${WS_BASE_URL}/ws/jobs/${id}`,
  },

  // Run endpoints (multi-LLM fan-out)
  runs: {
    create: () => `${API_BASE_URL}/runs`,
    list: () => `${API_BASE_URL}/runs`,
    get: (id: number) => `${API_BASE_URL}/runs/${id}`,
    ws: () => `${WS_BASE_URL}/ws/runs`,
    wsRun: (id: number) => `${WS_BASE_URL}/ws/runs/${id}`,
  },

  // Zerodha endpoints
  zerodha: {
    loginUrl: () => `${API_BASE_URL}/zerodha/login-url`,
    callback: () => `${API_BASE_URL}/zerodha/callback`,
    status: () => `${API_BASE_URL}/zerodha/status`,
    orders: () => `${API_BASE_URL}/zerodha/orders`,
    disconnect: () => `${API_BASE_URL}/zerodha/disconnect`,
  },

  // Google Sheets endpoints
  googleSheets: {
    authUrl: () => `${API_BASE_URL}/google-sheets/auth-url`,
    exchangeCode: () => `${API_BASE_URL}/google-sheets/exchange-code`,
    status: () => `${API_BASE_URL}/google-sheets/status`,
    disconnect: () => `${API_BASE_URL}/google-sheets/disconnect`,
    exportJob: () => `${API_BASE_URL}/google-sheets/export/job`,
    exportRun: () => `${API_BASE_URL}/google-sheets/export/run`,
    import: () => `${API_BASE_URL}/google-sheets/import`,
  },

  // Provider endpoints
  providers: {
    list: () => `${API_BASE_URL}/providers`,
  },

  // Prompt endpoints
  prompts: {
    list: () => `${API_BASE_URL}/prompts`,
    create: () => `${API_BASE_URL}/prompts`,
    get: (id: number) => `${API_BASE_URL}/prompts/${id}`,
    update: (id: number) => `${API_BASE_URL}/prompts/${id}`,
    delete: (id: number) => `${API_BASE_URL}/prompts/${id}`,
  },
  apiUsage: {
    summary: () => `${API_BASE_URL}/api-usage/summary`,
  },

  // Schedule endpoints
  schedules: {
    create: () => `${API_BASE_URL}/schedules`,
    list: () => `${API_BASE_URL}/schedules`,
    get: (id: number) => `${API_BASE_URL}/schedules/${id}`,
    update: (id: number) => `${API_BASE_URL}/schedules/${id}`,
    delete: (id: number) => `${API_BASE_URL}/schedules/${id}`,
  },

  // API Key endpoints
  apiKeys: {
    create: () => `${API_BASE_URL}/api-keys`,
    list: () => `${API_BASE_URL}/api-keys`,
    get: (id: number) => `${API_BASE_URL}/api-keys/${id}`,
    delete: (id: number) => `${API_BASE_URL}/api-keys/${id}`,
  },

  // Activity Log endpoints
  activityLogs: {
    list: () => `${API_BASE_URL}/activity-logs`,
    get: (id: number) => `${API_BASE_URL}/activity-logs/${id}`,
  },

  // Frontend Routes
  routes: {
    home: () => "/",
    login: () => "/login",
    register: () => "/register",
    forgotPassword: () => "/forgot-password",
    resetPassword: (token: string) => `/reset-password/${token}`,
    verifyEmail: (token: string) => `/verify-email/${token}`,
    logout: () => "/logout",

    console: {
      dashboard: () => "/console/dashboard",
      overview: () => "/console/dashboard",
      jobs: () => "/console/jobs",
      runs: () => "/console/runs",
      jobDetail: (id: number) => `/console/jobs/${id}`,
      runDetail: (id: number) => `/console/runs/${id}`,
      prompts: () => "/console/prompts",
      schedules: () => "/console/schedules",
      scheduleDetail: (id: number) => `/console/schedules/${id}`,
      apiKeys: () => "/console/api-keys",
      zerodha: () => "/console/zerodha",
      googleSheets: () => "/console/google-sheets",
      apis: () => "/console/apis",
    },

    profile: {
      root: () => "/console/profile",
      preferences: () => "/console/profile/preferences",
      security: () => "/console/profile/security",
      activity: () => "/console/profile/activity",
    },

    admin: {
      root: () => "/console/admin",
      users: () => "/console/admin/users",
      userDetail: (id: number) => `/console/admin/users/${id}`,
      jobs: () => "/console/admin/jobs",
      schedules: () => "/console/admin/schedules",
      settings: () => "/console/admin/settings",
    },
  },
};

/**
 * URL Builder Helper - for dynamic URL construction
 */
export const buildURL = (
  baseUrl: string,
  _params?: Record<string, string | number>,
  query?: Record<string, string | number | boolean>,
): string => {
  let url = baseUrl;

  // Add query parameters
  if (query && Object.keys(query).length > 0) {
    const queryString = new URLSearchParams(
      Object.entries(query).map(([key, value]) => [key, String(value)]),
    ).toString();
    url += `?${queryString}`;
  }

  return url;
};

/**
 * API Request Helper with URL resolver
 */
export interface RequestOptions extends RequestInit {
  token?: string;
  params?: Record<string, string | number>;
  query?: Record<string, string | number | boolean>;
}

export const apiRequest = async (
  endpoint: string,
  options: RequestOptions = {},
): Promise<Response> => {
  const { token, query, headers = {}, ...init } = options;

  // Build URL with query parameters
  let url = endpoint;
  if (query && Object.keys(query).length > 0) {
    const queryString = new URLSearchParams(
      Object.entries(query).map(([key, value]) => [key, String(value)]),
    ).toString();
    url += `?${queryString}`;
  }

  // Build headers
  const requestHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...(headers as Record<string, string>),
  };

  // Add authorization token if provided
  if (token) {
    requestHeaders.Authorization = `Bearer ${token}`;
  }

  // Make request
  const response = await fetch(url, {
    ...init,
    headers: requestHeaders,
  });

  return response;
};

/**
 * Helper to get stored access token
 * Delegates to centralized session storage service
 */
export const getAccessToken = (): string | null => {
  return sessionStorage.getAccessToken();
};

/**
 * Helper to get stored refresh token
 * Delegates to centralized session storage service
 */
export const getRefreshToken = (): string | null => {
  return sessionStorage.getRefreshToken();
};

/**
 * Helper to store tokens
 * Delegates to centralized session storage service
 */
export const storeTokens = (
  accessToken: string,
  refreshToken: string,
): void => {
  sessionStorage.setTokens(accessToken, refreshToken);
};

/**
 * Helper to clear tokens
 * Delegates to centralized session storage service
 */
export const clearTokens = (): void => {
  sessionStorage.clearSession();
};

/**
 * Helper to store user data
 * Delegates to centralized session storage service
 */
export const storeUser = (user: UserResponse): void => {
  sessionStorage.setUserData(user);
};

/**
 * Helper to get stored user data
 * Delegates to centralized session storage service
 */
export const getUser = (): UserResponse | null => {
  return sessionStorage.getUserData();
};

/**
 * Helper to clear stored user data
 * Delegates to centralized session storage service
 */
export const clearUser = (): void => {
  sessionStorage.setUserData(null);
};
