import { UserResponse } from "@/types/api";

/**
 * API Base URL Configuration
 * Adjusts based on environment
 */
const LOCAL_API_FALLBACK = "http://localhost:8000";
const LOCAL_FRONTEND_FALLBACK = "http://localhost:3000";
const BROWSER_API_PROXY_BASE = "/backend-api";
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0"]);
const PLACEHOLDER_HOST_SNIPPETS = ["yourdomain.com", "example.com"];

function trimTrailingSlash(url: string) {
  return url.replace(/\/+$/, "");
}

function parseConfiguredUrl(url: string | undefined | null) {
  if (!url) {
    return null;
  }

  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function isPlaceholderHostname(hostname: string) {
  return PLACEHOLDER_HOST_SNIPPETS.some(snippet => hostname.includes(snippet));
}

function getBrowserHostname() {
  if (typeof window === "undefined") {
    return null;
  }

  return window.location.hostname;
}

function resolveConfiguredBrowserUrl(url: string | undefined | null) {
  const parsed = parseConfiguredUrl(url);
  if (!parsed) {
    return null;
  }

  if (isPlaceholderHostname(parsed.hostname)) {
    return null;
  }

  const browserHostname = getBrowserHostname();
  if (!browserHostname) {
    return trimTrailingSlash(parsed.toString());
  }

  const browserIsLocal = LOCAL_HOSTNAMES.has(browserHostname);
  if (!browserIsLocal && LOCAL_HOSTNAMES.has(parsed.hostname)) {
    return null;
  }

  return trimTrailingSlash(parsed.toString());
}

function inferBrowserFrontendBaseUrl() {
  if (typeof window === "undefined") {
    return null;
  }

  return trimTrailingSlash(window.location.origin);
}

function inferBrowserApiBaseUrl() {
  if (typeof window === "undefined") {
    return null;
  }

  const { protocol, hostname } = window.location;
  if (LOCAL_HOSTNAMES.has(hostname)) {
    return LOCAL_API_FALLBACK;
  }

  const rootHostname = hostname.replace(/^www\./, "");
  return `${protocol}//api.${rootHostname}`;
}

function resolveConfiguredClientApiBaseUrl() {
  return resolveConfiguredBrowserUrl(process.env.NEXT_PUBLIC_API_URL);
}

function resolveConfiguredServerApiBaseUrl() {
  const configured = parseConfiguredUrl(
    process.env.BACKEND_API_URL || process.env.API_URL,
  );

  if (!configured) {
    return null;
  }

  return trimTrailingSlash(configured.toString());
}

function shouldUseBrowserApiProxy() {
  if (typeof window === "undefined") {
    return false;
  }

  if (
    process.env.NEXT_PUBLIC_DISABLE_AUTH === "true" &&
    process.env.NEXT_PUBLIC_DISABLE_API_PROXY === "true"
  ) {
    return false;
  }

  return true;
}

function resolveApiBaseUrl() {
  if (typeof window === "undefined") {
    return resolveConfiguredServerApiBaseUrl() || LOCAL_API_FALLBACK;
  }

  if (shouldUseBrowserApiProxy()) {
    return BROWSER_API_PROXY_BASE;
  }

  const configuredClientUrl = resolveConfiguredClientApiBaseUrl();
  if (configuredClientUrl) {
    return configuredClientUrl;
  }

  return inferBrowserApiBaseUrl() || LOCAL_API_FALLBACK;
}

export type ApiReadTransportCandidate = {
  url: string;
  stage: "primary" | "secondary";
  transport: "configured-or-inferred-api" | "same-origin-proxy";
};

/**
 * Builds the bounded browser read path used by the API service.
 *
 * Authenticated production reads begin at the same-origin BFF so bearer
 * credentials never have to exist in browser memory. Auth-disabled local
 * development may still use a configured direct API and one bounded fallback.
 */
export function resolveApiReadTransportCandidates(
  primaryUrl: string,
): ApiReadTransportCandidate[] {
  const primary: ApiReadTransportCandidate = {
    url: primaryUrl,
    stage: "primary",
    transport: primaryUrl.startsWith(BROWSER_API_PROXY_BASE)
      ? "same-origin-proxy"
      : "configured-or-inferred-api",
  };

  if (typeof window === "undefined" || LOCAL_HOSTNAMES.has(window.location.hostname)) {
    return [primary];
  }

  const parsedPrimary = new URL(primaryUrl, window.location.origin);
  const proxyPrefix = `${window.location.origin}${BROWSER_API_PROXY_BASE}`;
  const primaryUsesProxy =
    parsedPrimary.origin === window.location.origin &&
    (parsedPrimary.pathname === BROWSER_API_PROXY_BASE ||
      parsedPrimary.pathname.startsWith(`${BROWSER_API_PROXY_BASE}/`));

  // Authenticated browser reads stay on the same-origin BFF. Falling back to
  // the public API would require exposing a bearer token to browser code.
  if (primaryUsesProxy && process.env.NEXT_PUBLIC_DISABLE_AUTH !== "true") {
    return [primary];
  }

  const secondaryUrl = primaryUsesProxy
    ? (() => {
        const directBase =
          resolveConfiguredClientApiBaseUrl() || inferBrowserApiBaseUrl();
        if (!directBase) return null;
        const backendPath = parsedPrimary.pathname.slice(
          BROWSER_API_PROXY_BASE.length,
        );
        return `${directBase}${backendPath}${parsedPrimary.search}`;
      })()
    : `${proxyPrefix}${parsedPrimary.pathname}${parsedPrimary.search}`;

  if (!secondaryUrl || secondaryUrl === primaryUrl) {
    return [primary];
  }

  return [
    primary,
    {
      url: secondaryUrl,
      stage: "secondary",
      transport: primaryUsesProxy
        ? "configured-or-inferred-api"
        : "same-origin-proxy",
    },
  ];
}

function resolveFrontendBaseUrl() {
  const configuredFrontendUrl = resolveConfiguredBrowserUrl(
    process.env.NEXT_PUBLIC_FRONTEND_URL ||
      process.env.NEXTAUTH_URL,
  );

  if (configuredFrontendUrl) {
    return configuredFrontendUrl;
  }

  return inferBrowserFrontendBaseUrl() || LOCAL_FRONTEND_FALLBACK;
}

function resolveWebSocketBaseUrl() {
  const configuredClientUrl = resolveConfiguredClientApiBaseUrl();
  if (configuredClientUrl) {
    return configuredClientUrl.replace(/^http/, "ws");
  }

  if (typeof window === "undefined") {
    const configuredServerUrl = resolveConfiguredServerApiBaseUrl() || LOCAL_API_FALLBACK;
    return configuredServerUrl.replace(/^http/, "ws");
  }

  return (inferBrowserApiBaseUrl() || LOCAL_API_FALLBACK).replace(/^http/, "ws");
}

const bullpenAutoLiveApiUrls = {
  // This is intentionally separate from `summary`.  Console status badges need
  // persisted scheduler configuration immediately and must not wait for run
  // recovery, runtime diagnostics, or a Bullpen CLI auth refresh.
  status: () => `${resolveApiBaseUrl()}/polymarket/auto-live/status`,
  summary: () => `${resolveApiBaseUrl()}/polymarket/auto-live/summary`,
  dashboardSummary: () =>
    `${resolveApiBaseUrl()}/polymarket/auto-live/summary/dashboard`,
  state: () => `${resolveApiBaseUrl()}/polymarket/auto-live/state`,
  settings: () => `${resolveApiBaseUrl()}/polymarket/auto-live/settings`,
  history: () => `${resolveApiBaseUrl()}/polymarket/auto-live/history`,
  historyEventTrends: () =>
    `${resolveApiBaseUrl()}/polymarket/auto-live/history/event-trends`,
  runs: (includeDetail = false) =>
    `${resolveApiBaseUrl()}/polymarket/auto-live/runs${
      includeDetail ? "?include_detail=true" : ""
    }`,
  run: (runId: string) =>
    `${resolveApiBaseUrl()}/polymarket/auto-live/runs/${encodeURIComponent(runId)}`,
  runConsole: (runId: string) =>
    `${resolveApiBaseUrl()}/polymarket/auto-live/runs/${encodeURIComponent(runId)}/console`,
  runDecisions: (runId: string) =>
    `${resolveApiBaseUrl()}/polymarket/auto-live/runs/${encodeURIComponent(runId)}/decisions`,
  runOrders: (runId: string) => `${resolveApiBaseUrl()}/polymarket/auto-live/runs/${runId}/orders`,
  reconcileRunOrders: (runId: string) =>
    `${resolveApiBaseUrl()}/polymarket/auto-live/runs/${runId}/reconcile`,
  retryExitsAndContinueBuys: (runId: string) =>
    `${resolveApiBaseUrl()}/polymarket/auto-live/runs/${runId}/retry-exits-and-continue-buys`,
  decisions: () => `${resolveApiBaseUrl()}/polymarket/auto-live/decisions`,
  retryOrder: (intentId: string) =>
    `${resolveApiBaseUrl()}/polymarket/auto-live/orders/${intentId}/retry`,
  cancelOrder: (intentId: string) =>
    `${resolveApiBaseUrl()}/polymarket/auto-live/orders/${intentId}/cancel`,
  runOnce: () => `${resolveApiBaseUrl()}/polymarket/auto-live/run-once`,
  start: () => `${resolveApiBaseUrl()}/polymarket/auto-live/start`,
  stop: () => `${resolveApiBaseUrl()}/polymarket/auto-live/stop`,
  pause: () => `${resolveApiBaseUrl()}/polymarket/auto-live/pause`,
  resume: () => `${resolveApiBaseUrl()}/polymarket/auto-live/resume`,
  resetSettings: () => `${resolveApiBaseUrl()}/polymarket/auto-live/settings/reset`,
  emergencyStop: () => `${resolveApiBaseUrl()}/polymarket/auto-live/emergency-stop`,
  clearEmergencyStop: () => `${resolveApiBaseUrl()}/polymarket/auto-live/clear-emergency-stop`,
};

const bullpen008ApiUrls = {
  bootstrap: () => `${resolveApiBaseUrl()}/polymarket/bullpen008/bootstrap`,
  settings: () => `${resolveApiBaseUrl()}/polymarket/bullpen008/settings`,
  schedulerStart: () =>
    `${resolveApiBaseUrl()}/polymarket/bullpen008/scheduler/start`,
  schedulerStop: () =>
    `${resolveApiBaseUrl()}/polymarket/bullpen008/scheduler/stop`,
  schedulerPause: () =>
    `${resolveApiBaseUrl()}/polymarket/bullpen008/scheduler/pause`,
  schedulerResume: () =>
    `${resolveApiBaseUrl()}/polymarket/bullpen008/scheduler/resume`,
  emergencyStop: () =>
    `${resolveApiBaseUrl()}/polymarket/bullpen008/emergency-stop`,
  clearEmergencyStop: () =>
    `${resolveApiBaseUrl()}/polymarket/bullpen008/emergency-stop/clear`,
  kill: () => `${resolveApiBaseUrl()}/polymarket/bullpen008/kill`,
  runOnce: () => `${resolveApiBaseUrl()}/polymarket/bullpen008/run-once`,
  runs: () => `${resolveApiBaseUrl()}/polymarket/bullpen008/runs`,
  historyEventTrends: () =>
    `${resolveApiBaseUrl()}/polymarket/bullpen008/history/event-trends`,
  run: (runId: string) =>
    `${resolveApiBaseUrl()}/polymarket/bullpen008/runs/${encodeURIComponent(runId)}`,
  retryRun: (runId: string) =>
    `${resolveApiBaseUrl()}/polymarket/bullpen008/runs/${encodeURIComponent(runId)}/retry`,
  stage: (runId: string, stageNumber: number) =>
    `${resolveApiBaseUrl()}/polymarket/bullpen008/runs/${encodeURIComponent(runId)}/stages/${stageNumber}`,
};

const bullpenTradeAnalysisApiUrls = {
  list: () => `${resolveApiBaseUrl()}/bullpen-ai/trade-analysis`,
  detail: (tradeId: string) => `${resolveApiBaseUrl()}/bullpen-ai/trade-analysis/${tradeId}`,
  recompute: (tradeId: string) =>
    `${resolveApiBaseUrl()}/bullpen-ai/trade-analysis/${tradeId}/post-trade-analysis`,
};

const bullpenRunAuditApiUrls = {
  list: () => `${resolveApiBaseUrl()}/bullpen-ai/run-audits`,
  detail: (runId: string) => `${resolveApiBaseUrl()}/bullpen-ai/run-audits/${runId}`,
  materialize: (runId: string) => `${resolveApiBaseUrl()}/bullpen-ai/run-audits/${runId}/materialize`,
  section: (runId: string, section: string) =>
    `${resolveApiBaseUrl()}/bullpen-ai/run-audits/${runId}/sections/${section}`,
  findings: (runId: string) => `${resolveApiBaseUrl()}/bullpen-ai/run-audits/${runId}/findings`,
  remarks: (runId: string) => `${resolveApiBaseUrl()}/bullpen-ai/run-audits/${runId}/remarks`,
  manualChecks: (runId: string) => `${resolveApiBaseUrl()}/bullpen-ai/run-audits/${runId}/manual-checks`,
  feedback: (runId: string) => `${resolveApiBaseUrl()}/bullpen-ai/run-audits/${runId}/feedback`,
  feedbackDetail: (runId: string, feedbackId: number) =>
    `${resolveApiBaseUrl()}/bullpen-ai/run-audits/${runId}/feedback/${feedbackId}`,
  export: (runId: string) => `${resolveApiBaseUrl()}/bullpen-ai/run-audits/${runId}/export`,
};

const tradingBotsApiUrls = {
  summary: () => `${resolveApiBaseUrl()}/trading-bots/summary`,
  overview: () => `${resolveApiBaseUrl()}/trading-bots/overview`,
};

/**
 * URL Resolver - Centralized API endpoint management
 */
export const URLs = {
  // Base URLs
  get api() {
    return resolveApiBaseUrl();
  },
  get frontend() {
    return resolveFrontendBaseUrl();
  },

  costDrivers: {
    summary: (month?: string) => {
      const query = month ? `?month=${encodeURIComponent(month)}` : "";
      return `${resolveApiBaseUrl()}/api/admin/cost-drivers/summary${query}`;
    },
    refresh: (month?: string) => {
      const query = month ? `?month=${encodeURIComponent(month)}` : "";
      return `${resolveApiBaseUrl()}/api/admin/cost-drivers/refresh${query}`;
    },
  },

  dashboard: {
    summary: () => `${resolveApiBaseUrl()}/dashboard/summary`,
  },

  mails: {
    sendTest: () => `${resolveApiBaseUrl()}/mails/send-test`,
    history: () => `${resolveApiBaseUrl()}/mails/history`,
    sellAction: (historyId: number) =>
      `${resolveApiBaseUrl()}/mails/history/${historyId}/sell-action`,
    preferences: () => `${resolveApiBaseUrl()}/mails/preferences`,
  },

  // Health Check endpoints
  health: {
    ping: () => `${resolveApiBaseUrl()}/health`,
    db: () => `${resolveApiBaseUrl()}/health/db`,
    redis: () => `${resolveApiBaseUrl()}/health/redis`,
    full: () => `${resolveApiBaseUrl()}/health/full`,
  },

  // Authentication endpoints
  auth: {
    register: () => `${resolveApiBaseUrl()}/auth/register`,
    login: () => `${resolveApiBaseUrl()}/auth/login`,
    logout: () => `${resolveApiBaseUrl()}/auth/logout`,
    refresh: () => `${resolveApiBaseUrl()}/auth/refresh`,
    me: () => `${resolveApiBaseUrl()}/auth/me`,
    updatePassword: () => `${resolveApiBaseUrl()}/auth/password`,
    getProfile: () => `${resolveApiBaseUrl()}/auth/profile`,
    updateProfile: () => `${resolveApiBaseUrl()}/auth/profile`,
    forgotPassword: () => `${resolveApiBaseUrl()}/auth/forgot-password`,
    resetPassword: () => `${resolveApiBaseUrl()}/auth/reset-password`,
  },

  // User endpoints
  users: {
    list: () => `${resolveApiBaseUrl()}/users`,
    get: (id: number) => `${resolveApiBaseUrl()}/users/${id}`,
    update: (id: number) => `${resolveApiBaseUrl()}/users/${id}`,
    delete: (id: number) => `${resolveApiBaseUrl()}/users/${id}`,
    getJobs: (id: number) => `${resolveApiBaseUrl()}/users/${id}/jobs`,
    getActivity: (id: number) => `${resolveApiBaseUrl()}/users/${id}/activity`,
  },

  // Job endpoints
  jobs: {
    create: () => `${resolveApiBaseUrl()}/jobs`,
    list: () => `${resolveApiBaseUrl()}/jobs`,
    get: (id: number) => `${resolveApiBaseUrl()}/jobs/${id}`,
    cancel: (id: number) => `${resolveApiBaseUrl()}/jobs/${id}/cancel`,
    update: (id: number) => `${resolveApiBaseUrl()}/jobs/${id}`,
    delete: (id: number) => `${resolveApiBaseUrl()}/jobs/${id}`,
    getCost: (id: number) => `${resolveApiBaseUrl()}/jobs/${id}/cost`,
    // WebSocket base URLs — WSClient appends ?token= before each connect attempt
    ws: () => `${resolveWebSocketBaseUrl()}/ws/jobs`,
    wsJob: (id: number) => `${resolveWebSocketBaseUrl()}/ws/jobs/${id}`,
  },

  // Run endpoints (multi-LLM fan-out)
  runs: {
    create: () => `${resolveApiBaseUrl()}/runs`,
    list: () => `${resolveApiBaseUrl()}/runs`,
    get: (id: number) => `${resolveApiBaseUrl()}/runs/${id}`,
    cancel: (id: number) => `${resolveApiBaseUrl()}/runs/${id}/cancel`,
    autoRebalanceLabel: () => `${resolveApiBaseUrl()}/runs/auto-rebalance-label`,
    autoRebalanceCompletionEmail: () => `${resolveApiBaseUrl()}/runs/auto-rebalance-completion-email`,
    finalActionableHistory: () => `${resolveApiBaseUrl()}/runs/final-actionables/history`,
    finalActionableHistoryBackfill: () => `${resolveApiBaseUrl()}/runs/final-actionables/history/backfill`,
    autoRebalanceHistory: (portfolio: 'india' | 'indmoney_us') =>
      `${resolveApiBaseUrl()}/runs/auto-rebalance-history?portfolio=${portfolio}`,
    autoRebalanceHistoryDetail: (portfolio: 'india' | 'indmoney_us', sequence: number) =>
      `${resolveApiBaseUrl()}/runs/auto-rebalance-history/${portfolio}/${sequence}`,
    autoRebalanceStage: (
      portfolio: 'india' | 'indmoney_us',
      sequence: number,
      stage: string,
    ) => `${resolveApiBaseUrl()}/runs/auto-rebalance-history/${portfolio}/${sequence}/stages/${stage}`,
    ws: () => `${resolveWebSocketBaseUrl()}/ws/runs`,
    wsRun: (id: number) => `${resolveWebSocketBaseUrl()}/ws/runs/${id}`,
  },

  // Zerodha endpoints
  zerodha: {
    loginUrl: () => `${resolveApiBaseUrl()}/zerodha/login-url`,
    callback: () => `${resolveApiBaseUrl()}/zerodha/callback`,
    status: () => `${resolveApiBaseUrl()}/zerodha/status`,
    portfolio: () => `${resolveApiBaseUrl()}/zerodha/portfolio`,
    portfolioSync: () => `${resolveApiBaseUrl()}/zerodha/portfolio/sync`,
    portfolioSnapshot: (snapshotDate: string) => `${resolveApiBaseUrl()}/zerodha/portfolio/${snapshotDate}`,
    orders: () => `${resolveApiBaseUrl()}/zerodha/orders`,
    prepareBasketOrders: () => `${resolveApiBaseUrl()}/zerodha/orders/prepare-basket`,
    placeProtectedMarketOrders: () => `${resolveApiBaseUrl()}/zerodha/orders/place-protected-market`,
    placeProtectedMarketOrdersSequenced: () => `${resolveApiBaseUrl()}/zerodha/orders/place-protected-market-sequenced`,
    disconnect: () => `${resolveApiBaseUrl()}/zerodha/disconnect`,
    eventsLatest: () => `${resolveApiBaseUrl()}/zerodha/events/latest`,
    eventsHistory: () => `${resolveApiBaseUrl()}/zerodha/events/history`,
    eventJob: (jobId: number) => `${resolveApiBaseUrl()}/zerodha/events/${jobId}`,
    eventsRun: () => `${resolveApiBaseUrl()}/zerodha/events/run`,
    threatsLatest: () => `${resolveApiBaseUrl()}/zerodha/threats/latest`,
    threatsHistory: () => `${resolveApiBaseUrl()}/zerodha/threats/history`,
    threatJob: (jobId: number) => `${resolveApiBaseUrl()}/zerodha/threats/${jobId}`,
    threatsRun: () => `${resolveApiBaseUrl()}/zerodha/threats/run`,
  },

  // INDmoney US endpoints
  indmoneyUs: {
    portfolio: () => `${resolveApiBaseUrl()}/indmoney-us/portfolio`,
    portfolioSnapshot: (snapshotId: number) => `${resolveApiBaseUrl()}/indmoney-us/portfolio/${snapshotId}`,
    currentPrices: () => `${resolveApiBaseUrl()}/indmoney-us/prices/current`,
    eventsLatest: () => `${resolveApiBaseUrl()}/indmoney-us/events/latest`,
    eventsHistory: () => `${resolveApiBaseUrl()}/indmoney-us/events/history`,
    eventJob: (jobId: number) => `${resolveApiBaseUrl()}/indmoney-us/events/${jobId}`,
    eventsRun: () => `${resolveApiBaseUrl()}/indmoney-us/events/run`,
    threatsLatest: () => `${resolveApiBaseUrl()}/indmoney-us/threats/latest`,
    threatsHistory: () => `${resolveApiBaseUrl()}/indmoney-us/threats/history`,
    threatJob: (jobId: number) => `${resolveApiBaseUrl()}/indmoney-us/threats/${jobId}`,
    threatsRun: () => `${resolveApiBaseUrl()}/indmoney-us/threats/run`,
  },

  // Polymarket endpoints
  polymarket: {
    state: () => `${resolveApiBaseUrl()}/polymarket/state`,
    start: () => `${resolveApiBaseUrl()}/polymarket/start`,
    stop: () => `${resolveApiBaseUrl()}/polymarket/stop`,
    pause: () => `${resolveApiBaseUrl()}/polymarket/pause`,
    resume: () => `${resolveApiBaseUrl()}/polymarket/resume`,
    liveUnlock: () => `${resolveApiBaseUrl()}/polymarket/live/unlock`,
    liveLock: () => `${resolveApiBaseUrl()}/polymarket/live/lock`,
    liveDoctor: () => `${resolveApiBaseUrl()}/polymarket/live/doctor`,
    liveBalanceRefresh: () => `${resolveApiBaseUrl()}/polymarket/live/balance/refresh`,
    liveRedeem: () => `${resolveApiBaseUrl()}/polymarket/live/redeem`,
    liveEmergencyStop: () => `${resolveApiBaseUrl()}/polymarket/live/emergency-stop`,
    liveResetEmergencyStop: () => `${resolveApiBaseUrl()}/polymarket/live/reset-emergency-stop`,
    liveLimits: () => `${resolveApiBaseUrl()}/polymarket/live/limits`,
    liveTradeConfirm: (tradeId: string) => `${resolveApiBaseUrl()}/polymarket/live/trades/${tradeId}/confirm`,
    liveTradeReject: (tradeId: string) => `${resolveApiBaseUrl()}/polymarket/live/trades/${tradeId}/reject`,
    liveRejectAll: () => `${resolveApiBaseUrl()}/polymarket/live/trades/reject-all`,
    manualInvest: () => `${resolveApiBaseUrl()}/polymarket/manual-invest`,
    trackedAccounts: () => `${resolveApiBaseUrl()}/polymarket/tracked-accounts`,
    trackedAccount: (accountId: string) => `${resolveApiBaseUrl()}/polymarket/tracked-accounts/${accountId}`,
    trackedAccountNetWorthRefresh: (accountId: string) => `${resolveApiBaseUrl()}/polymarket/tracked-accounts/${accountId}/net-worth/refresh`,
    discoveryDebug: () => `${resolveApiBaseUrl()}/polymarket/live/discovery/debug`,
  },

  // Direct Polymarket endpoints
  polymarketDirect: {
    state: () => `${resolveApiBaseUrl()}/polymarket-direct/state`,
    start: () => `${resolveApiBaseUrl()}/polymarket-direct/start`,
    stop: () => `${resolveApiBaseUrl()}/polymarket-direct/stop`,
    pause: () => `${resolveApiBaseUrl()}/polymarket-direct/pause`,
    resume: () => `${resolveApiBaseUrl()}/polymarket-direct/resume`,
    liveUnlock: () => `${resolveApiBaseUrl()}/polymarket-direct/live/unlock`,
    liveLock: () => `${resolveApiBaseUrl()}/polymarket-direct/live/lock`,
    liveDoctor: () => `${resolveApiBaseUrl()}/polymarket-direct/live/doctor`,
    liveBalanceRefresh: () => `${resolveApiBaseUrl()}/polymarket-direct/live/balance/refresh`,
    liveRedeem: () => `${resolveApiBaseUrl()}/polymarket-direct/live/redeem`,
    liveEmergencyStop: () => `${resolveApiBaseUrl()}/polymarket-direct/live/emergency-stop`,
    liveResetEmergencyStop: () => `${resolveApiBaseUrl()}/polymarket-direct/live/reset-emergency-stop`,
    liveLimits: () => `${resolveApiBaseUrl()}/polymarket-direct/live/limits`,
    liveTradeConfirm: (tradeId: string) => `${resolveApiBaseUrl()}/polymarket-direct/live/trades/${tradeId}/confirm`,
    liveTradeReject: (tradeId: string) => `${resolveApiBaseUrl()}/polymarket-direct/live/trades/${tradeId}/reject`,
    liveRejectAll: () => `${resolveApiBaseUrl()}/polymarket-direct/live/trades/reject-all`,
    trackedAccounts: () => `${resolveApiBaseUrl()}/polymarket-direct/tracked-accounts`,
    trackedAccount: (accountId: string) => `${resolveApiBaseUrl()}/polymarket-direct/tracked-accounts/${accountId}`,
    discoveryDebug: () => `${resolveApiBaseUrl()}/polymarket-direct/live/discovery/debug`,
  },

  bullpenAutoLive: bullpenAutoLiveApiUrls,
  bullpen008: bullpen008ApiUrls,
  bullpenTradeAnalysis: bullpenTradeAnalysisApiUrls,
  bullpenRunAudit: bullpenRunAuditApiUrls,
  polymarketAutoLive: bullpenAutoLiveApiUrls,

  tradingBots: tradingBotsApiUrls,

  // Google Sheets endpoints
  googleSheets: {
    authUrl: () => `${resolveApiBaseUrl()}/google-sheets/auth-url`,
    adminConfig: () => `${resolveApiBaseUrl()}/google-sheets/admin-config`,
    exchangeCode: () => `${resolveApiBaseUrl()}/google-sheets/exchange-code`,
    status: () => `${resolveApiBaseUrl()}/google-sheets/status`,
    disconnect: () => `${resolveApiBaseUrl()}/google-sheets/disconnect`,
    defaultSheet: () => `${resolveApiBaseUrl()}/google-sheets/default-sheet`,
    exportJob: () => `${resolveApiBaseUrl()}/google-sheets/export/job`,
    exportRun: () => `${resolveApiBaseUrl()}/google-sheets/export/run`,
    import: () => `${resolveApiBaseUrl()}/google-sheets/import`,
  },

  // Provider endpoints
  providers: {
    list: () => `${resolveApiBaseUrl()}/providers`,
  },

  // Prompt endpoints
  prompts: {
    list: () => `${resolveApiBaseUrl()}/prompts`,
    create: () => `${resolveApiBaseUrl()}/prompts`,
    get: (id: number) => `${resolveApiBaseUrl()}/prompts/${id}`,
    update: (id: number) => `${resolveApiBaseUrl()}/prompts/${id}`,
    delete: (id: number) => `${resolveApiBaseUrl()}/prompts/${id}`,
  },
  apiUsage: {
    summary: () => `${resolveApiBaseUrl()}/api-usage/summary`,
    llmPerformance: () => `${resolveApiBaseUrl()}/api-usage/llms/performance`,
    llmCostHistory: () => `${resolveApiBaseUrl()}/api-usage/llms/cost-history`,
  },

  // Schedule endpoints
  schedules: {
    create: () => `${resolveApiBaseUrl()}/schedules`,
    list: () => `${resolveApiBaseUrl()}/schedules`,
    get: (id: number) => `${resolveApiBaseUrl()}/schedules/${id}`,
    update: (id: number) => `${resolveApiBaseUrl()}/schedules/${id}`,
    delete: (id: number) => `${resolveApiBaseUrl()}/schedules/${id}`,
  },

  // API Key endpoints
  apiKeys: {
    create: () => `${resolveApiBaseUrl()}/api-keys`,
    list: () => `${resolveApiBaseUrl()}/api-keys`,
    get: (id: number) => `${resolveApiBaseUrl()}/api-keys/${id}`,
    delete: (id: number) => `${resolveApiBaseUrl()}/api-keys/${id}`,
  },

  // Activity Log endpoints
  activityLogs: {
    list: () => `${resolveApiBaseUrl()}/activity-logs`,
    get: (id: number) => `${resolveApiBaseUrl()}/activity-logs/${id}`,
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
      database: () => "/database",
      jobs: () => "/console/jobs",
      runs: () => "/console/runs",
      jobDetail: (id: number) => `/console/jobs/${id}`,
      runDetail: (id: number) => `/console/runs/${id}`,
      prompts: () => "/console/prompts",
      schedules: () => "/console/schedules",
      scheduleDetail: (id: number) => `/console/schedules/${id}`,
      apiKeys: () => "/console/api-keys",
      zerodha: () => "/console/zerodha",
      zerodhaSwingTrade: () => "/console/zerodha/swing-trade",
      zerodhaEvents: () => "/console/zerodha/events",
      zerodhaRebalance: () => "/console/zerodha/rebalance",
      zerodhaFinalActionables: () => "/console/zerodha/final-actionables",
      indmoneyUs: () => "/console/indmoney-us",
      indmoneyUsSwingTrade: () => "/console/indmoney-us/swing-trade",
      indmoneyUsEvents: () => "/console/indmoney-us/events",
      indmoneyUsRebalance: () => "/console/indmoney-us/rebalance",
      indmoneyUsFinalActionables: () => "/console/indmoney-us/final-actionables",
      automatedRebalance: () => "/console/automated-rebalance",
      autoRebalanceRuns: (portfolio: 'zerodha' | 'indmoneyUs') =>
        `/console/auto-rebalance-runs/${portfolio}`,
      autoRebalanceRunDetail: (
        portfolio: 'zerodha' | 'indmoneyUs',
        sequence: number,
      ) => `/console/auto-rebalance-runs/${portfolio}/${sequence}`,
      zerodhaThreats: () => "/console/zerodha/threats",
      indmoneyUsThreats: () => "/console/indmoney-us/threats",
      tradingBots: () => "/console/trading-bots",
      polymarketBot: () => "/console/polymarket-bot",
      polymarketDirectBot: () => "/console/polymarket-direct-bot",
      bullpenAi: () => "/console/bullpen-ai",
      bullpen008: () => "/console/bullpen008",
      bullpen008History: () => "/console/bullpen-ai/008history",
      bullpen008AnalyseEvents: () => "/console/bullpen008/analyse-events",
      bullpen008AnalyseRuns: () => "/console/bullpen008/analyse-runs",
      bullpen008RunDetail: (runId: string) =>
        `/console/bullpen008/runs/${encodeURIComponent(runId)}`,
      bullpenAiAnalyseEvents: () => "/console/bullpen-ai/analyse-events",
      bullpenAiAnalyseEventDetail: (tradeId: string) =>
        `/console/bullpen-ai/analyse-events/${tradeId}`,
      bullpenAiAnalyseRuns: () => "/console/bullpen-ai/analyse-runs",
      bullpenAiAnalyseRunDetail: (runId: string) =>
        `/console/bullpen-ai/analyse-runs/${runId}`,
      bullpenAiAutoLive: () => "/console/trading-bots/bullpen-ai-auto-live",
      bullpenAi30Days: () => "/console/bullpen-ai?tab=30-days",
      bullpenAiEndOfMonth: () => "/console/bullpen-ai?tab=end-of-month",
      googleSheets: () => "/console/google-sheets",
      apis: () => "/console/apis",
      llms: () => "/console/llms",
      technicalSetups: () => "/console/technical-setups",
      mails: () => "/console/mails",
    },

    profile: {
      root: () => "/console/profile",
      preferences: () => "/console/profile/preferences",
      costDrivers: () => "/console/profile/cost-drivers",
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
  if (token) {
    throw new Error(
      "Browser Authorization headers are disabled; use the same-origin BFF.",
    );
  }

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
  return null;
};

/**
 * Helper to get stored refresh token
 * Delegates to centralized session storage service
 */
export const getRefreshToken = (): string | null => {
  return null;
};

/**
 * Helper to store tokens
 * Delegates to centralized session storage service
 */
export const storeTokens = (
  accessToken: string,
  refreshToken: string,
): void => {
  void accessToken;
  void refreshToken;
  throw new Error("Browser token storage is disabled; use the server session.");
};

/**
 * Helper to clear tokens
 * Delegates to centralized session storage service
 */
export const clearTokens = (): void => {
  // Auth.js owns its encrypted HttpOnly session cookie.
};

/**
 * Helper to store user data
 * Delegates to centralized session storage service
 */
export const storeUser = (user: UserResponse): void => {
  void user;
};

/**
 * Helper to get stored user data
 * Delegates to centralized session storage service
 */
export const getUser = (): UserResponse | null => {
  return null;
};

/**
 * Helper to clear stored user data
 * Delegates to centralized session storage service
 */
export const clearUser = (): void => {
  // User state is supplied by the server-validated Auth.js session.
};
