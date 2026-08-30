import { NextRequest, NextResponse } from "next/server";

import {
  ApiOriginCircuitBreaker,
  ApiTransportDeadlineError,
  executeBoundedApiRequest,
  type BufferedTransportResponse,
} from "@/lib/boundedApiTransport";
import {
  createBackendSessionContext,
  rotateBackendTokens,
} from "@/app/api/bullpen-ai/_lib/serverBackendSession";
import { BackendRuntimeHttpError } from "@/app/api/bullpen-ai/_lib/backendBullpenRuntime";

const LOCAL_SERVER_API_BASE_URL = "http://127.0.0.1:8000";
const DOCKER_SERVER_API_BASE_URL = "http://backend:8000";
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0"]);
const PLACEHOLDER_HOST_SNIPPETS = ["yourdomain.com", "example.com"];
const FORWARDED_HEADER_BLOCKLIST = new Set([
  "accept-encoding",
  "content-length",
  "cookie",
  "host",
  "authorization",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
]);
const RESPONSE_HEADER_BLOCKLIST = new Set(["content-encoding", "content-length"]);
const DEFAULT_BACKEND_PROXY_ATTEMPT_TIMEOUT_MS = 1_200;
const DEFAULT_BACKEND_PROXY_TOTAL_TIMEOUT_MS = 4_000;
// Auto-Live dashboard, history, and exact-run reads intentionally have backend
// deadlines of up to four seconds. Give those routes enough time to return
// their own compact 503/degraded response while keeping the BFF below the
// console's five-second poll deadline.
const DEFAULT_BULLPEN_BACKEND_PROXY_ATTEMPT_TIMEOUT_MS = 4_200;
const DEFAULT_BULLPEN_BACKEND_PROXY_TOTAL_TIMEOUT_MS = 4_750;
const MAX_BULLPEN_BACKEND_PROXY_ATTEMPT_TIMEOUT_MS = 4_500;
const MAX_BULLPEN_BACKEND_PROXY_TOTAL_TIMEOUT_MS = 4_900;
const DEFAULT_BACKEND_PROXY_MUTATION_TIMEOUT_MS = 8_000;
const SAFE_FALLBACK_METHODS = new Set(["GET", "HEAD"]);
const PUBLIC_BACKEND_PATHS = new Set([
  "auth/register",
  "auth/forgot-password",
  "auth/reset-password",
  "auth/verify-email",
  "health/live",
  "health/ready",
]);
const originCircuit = new ApiOriginCircuitBreaker(2, 30_000);
// Read fallbacks share a circuit so a dead primary does not consume every
// dashboard poll budget. Mutations are single-target and carry server-side
// idempotency keys; they must still reach that target when a prior read opened
// its circuit. A practically non-opening circuit retains the transport's
// accounting contract without suppressing an explicitly requested mutation.
const mutationOriginCircuit = new ApiOriginCircuitBreaker(
  Number.MAX_SAFE_INTEGER,
  0,
);

type BackendApiCandidate = {
  baseUrl: string;
  stage: "primary" | "secondary" | "tertiary";
  transport:
    | "configured-server-api"
    | "host-loopback"
    | "docker-service"
    | "public-api";
};

type RouteContext = {
  params: Promise<{ path?: string[] }>;
};

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
  return PLACEHOLDER_HOST_SNIPPETS.some((snippet) => hostname.includes(snippet));
}

function resolveFirstConfiguredBackendApiBaseUrl() {
  return [process.env.BACKEND_API_URL, process.env.API_URL]
    .map(parseConfiguredUrl)
    .filter((parsed): parsed is URL => Boolean(parsed))
    .filter((parsed) => !isPlaceholderHostname(parsed.hostname))
    .map((parsed) => trimTrailingSlash(parsed.toString()))[0] ?? null;
}

function resolvePublicBackendApiBaseUrl(request: NextRequest) {
  const configured = parseConfiguredUrl(process.env.NEXT_PUBLIC_API_URL);
  if (configured && !isPlaceholderHostname(configured.hostname)) {
    return trimTrailingSlash(configured.toString());
  }

  const host = request.nextUrl.hostname;
  if (LOCAL_HOSTNAMES.has(host)) {
    return null;
  }

  const rootHostname = host.replace(/^www\./, "");
  return `${request.nextUrl.protocol}//api.${rootHostname}`;
}

function resolveBackendApiCandidates(request: NextRequest): BackendApiCandidate[] {
  const configuredServerUrl = resolveFirstConfiguredBackendApiBaseUrl();
  const primary: BackendApiCandidate = configuredServerUrl
    ? {
        baseUrl: configuredServerUrl,
        stage: "primary",
        transport: "configured-server-api",
      }
    : {
        baseUrl: LOCAL_SERVER_API_BASE_URL,
        stage: "primary",
        transport: "host-loopback",
      };
  const secondary: BackendApiCandidate = configuredServerUrl
    ? {
        baseUrl: LOCAL_SERVER_API_BASE_URL,
        stage: "secondary",
        transport: "host-loopback",
      }
    : {
        baseUrl: DOCKER_SERVER_API_BASE_URL,
        stage: "secondary",
        transport: "docker-service",
      };
  const publicUrl = resolvePublicBackendApiBaseUrl(request);
  const candidates = [
    primary,
    secondary,
    ...(publicUrl
      ? [
          {
            baseUrl: publicUrl,
            stage: "tertiary" as const,
            transport: "public-api" as const,
          },
        ]
      : []),
  ];
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.baseUrl)) return false;
    seen.add(candidate.baseUrl);
    return true;
  });
}

function buildForwardHeaders(
  request: NextRequest,
  correlationId: string,
  accessToken: string | null,
) {
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!FORWARDED_HEADER_BLOCKLIST.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  });
  if (!headers.has("x-correlation-id")) {
    headers.set("X-Correlation-ID", correlationId);
  }
  if (accessToken) {
    headers.set("Authorization", `Bearer ${accessToken}`);
  }
  return headers;
}

function buildResponseHeaders(response: Response) {
  const headers = new Headers();
  response.headers.forEach((value, key) => {
    if (!RESPONSE_HEADER_BLOCKLIST.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  });
  return headers;
}

function buildTargetUrl(baseUrl: string, path: string, request: NextRequest) {
  const targetUrl = new URL(`${baseUrl}/${path}`);
  targetUrl.search = request.nextUrl.search;
  return targetUrl;
}

function readBoundedTimeout(
  rawValue: string | undefined,
  fallbackMs: number,
  maximumMs: number,
) {
  const configured = Number.parseInt(rawValue || "", 10);
  if (!Number.isFinite(configured)) {
    return fallbackMs;
  }
  return Math.min(Math.max(configured, 1_000), maximumMs);
}

function isBullpenAutoLiveRead(method: string, path: string) {
  return (
    SAFE_FALLBACK_METHODS.has(method) &&
    (path === "polymarket/auto-live" ||
      path.startsWith("polymarket/auto-live/"))
  );
}

function getProxyAttemptTimeoutMs(method: string, path: string) {
  if (!SAFE_FALLBACK_METHODS.has(method)) {
    return readBoundedTimeout(
      process.env.BACKEND_PROXY_TIMEOUT_MS,
      DEFAULT_BACKEND_PROXY_MUTATION_TIMEOUT_MS,
      30_000,
    );
  }

  if (isBullpenAutoLiveRead(method, path)) {
    return readBoundedTimeout(
      process.env.BULLPEN_BACKEND_PROXY_TIMEOUT_MS,
      DEFAULT_BULLPEN_BACKEND_PROXY_ATTEMPT_TIMEOUT_MS,
      MAX_BULLPEN_BACKEND_PROXY_ATTEMPT_TIMEOUT_MS,
    );
  }

  return readBoundedTimeout(
    process.env.BACKEND_PROXY_TIMEOUT_MS,
    DEFAULT_BACKEND_PROXY_ATTEMPT_TIMEOUT_MS,
    DEFAULT_BACKEND_PROXY_ATTEMPT_TIMEOUT_MS,
  );
}

function getProxyTotalTimeoutMs(method: string, path: string) {
  if (!SAFE_FALLBACK_METHODS.has(method)) {
    return getProxyAttemptTimeoutMs(method, path);
  }

  if (isBullpenAutoLiveRead(method, path)) {
    return readBoundedTimeout(
      process.env.BULLPEN_BACKEND_PROXY_TOTAL_TIMEOUT_MS,
      DEFAULT_BULLPEN_BACKEND_PROXY_TOTAL_TIMEOUT_MS,
      MAX_BULLPEN_BACKEND_PROXY_TOTAL_TIMEOUT_MS,
    );
  }

  // Keep the same-origin BFF attempt chain inside one bounded deadline.
  return readBoundedTimeout(
    process.env.BACKEND_PROXY_TOTAL_TIMEOUT_MS,
    DEFAULT_BACKEND_PROXY_TOTAL_TIMEOUT_MS,
    DEFAULT_BACKEND_PROXY_TOTAL_TIMEOUT_MS,
  );
}

function createProxyCorrelationId(request: NextRequest) {
  return request.headers.get("x-correlation-id") || crypto.randomUUID();
}

function logProxyFailure(input: {
  request: NextRequest;
  correlationId: string;
  outcome: string;
  durationMs: number;
  status?: number;
  errorType?: string;
}) {
  // This runs on the Next server only. Do not include upstream URLs, error
  // messages, credentials, or response bodies in browser-visible payloads.
  console.warn(
    JSON.stringify({
      event: "backend_api_proxy_failure",
      method: input.request.method,
      path: input.request.nextUrl.pathname,
      correlation_id: input.correlationId,
      outcome: input.outcome,
      duration_ms: Math.round(input.durationMs),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.errorType ? { error_type: input.errorType } : {}),
    }),
  );
}

async function bufferBackendResponse(
  response: Response,
  method: string,
): Promise<BufferedTransportResponse> {
  // Browser-facing API calls are JSON payloads. Buffering makes the BFF
  // deadline cover body delivery too (not merely response headers), which
  // prevents a stalled upstream stream from leaving client state unresolved.
  const body = method === "HEAD" ? null : await response.arrayBuffer();
  return {
    body,
    status: response.status,
    statusText: response.statusText,
    headers: buildResponseHeaders(response),
  };
}

async function proxyBackendRequest(request: NextRequest, context: RouteContext) {
  const params = await context.params;
  const path = (params.path ?? []).map(encodeURIComponent).join("/");
  const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer();
  const startedAt = performance.now();
  const correlationId = createProxyCorrelationId(request);
  let outcome = "unreachable";
  let responseStatus: number | undefined;
  const resolvedCandidates = resolveBackendApiCandidates(request);
  const isPublicRequest = PUBLIC_BACKEND_PATHS.has(path);
  const backendSession = isPublicRequest
    ? null
    : await createBackendSessionContext(request);
  if (
    !isPublicRequest &&
    process.env.NEXT_PUBLIC_DISABLE_AUTH !== "true" &&
    !backendSession?.accessToken &&
    !backendSession?.refreshToken
  ) {
    return NextResponse.json(
      { message: "Not authenticated" },
      {
        status: 401,
        headers: { "X-Correlation-ID": correlationId },
      },
    );
  }

  const totalTimeoutMs = getProxyTotalTimeoutMs(request.method, path);

  try {
    const result = await executeBoundedApiRequest({
      method: request.method,
      candidates: resolvedCandidates,
      circuit: SAFE_FALLBACK_METHODS.has(request.method)
        ? originCircuit
        : mutationOriginCircuit,
      callerSignal: request.signal,
      totalBudgetMs: totalTimeoutMs,
      primaryAttemptBudgetMs: getProxyAttemptTimeoutMs(request.method, path),
      refreshAuthentication: backendSession
        ? (signal) => rotateBackendTokens(backendSession, signal)
        : undefined,
      fetchCandidate: async (candidate, signal) => {
        const targetUrl = buildTargetUrl(candidate.baseUrl, path, request);
        const response = await fetch(targetUrl, {
          method: request.method,
          headers: buildForwardHeaders(
            request,
            correlationId,
            backendSession?.accessToken ?? null,
          ),
          body,
          cache: "no-store",
          signal,
        });
        return bufferBackendResponse(
          response,
          request.method,
        );
      },
    });
    responseStatus = result.response.status;
    outcome = "success";
    const responseHeaders = result.response.headers;
    responseHeaders.set("X-Correlation-ID", correlationId);
    if (result.candidate) {
      responseHeaders.set("X-API-Transport", result.candidate.transport);
    }
    return new NextResponse(result.response.body, {
      status: result.response.status,
      statusText: result.response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    if (error instanceof ApiTransportDeadlineError) {
      outcome = "timeout";
      return NextResponse.json(
        {
          message: "The backend did not respond in time. Please retry.",
        },
        {
          status: 504,
          headers: {
            "Retry-After": "1",
            "X-Correlation-ID": correlationId,
            "X-Backend-Proxy-Budget-Ms": String(totalTimeoutMs),
          },
        },
      );
    }

    if (error instanceof BackendRuntimeHttpError && error.status === 401) {
      outcome = "authentication_failed";
      return NextResponse.json(
        { message: "Your session has expired. Please sign in again." },
        {
          status: 401,
          headers: { "X-Correlation-ID": correlationId },
        },
      );
    }

    outcome = "unreachable";
    return NextResponse.json(
      {
        message: "Unable to reach the backend API right now.",
      },
      {
        status: 502,
        headers: { "X-Correlation-ID": correlationId },
      },
    );
  } finally {
    if (outcome !== "success") {
      logProxyFailure({
        request,
        correlationId,
        outcome,
        durationMs: performance.now() - startedAt,
        status: responseStatus,
      });
    }
  }
}

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: RouteContext) {
  return proxyBackendRequest(request, context);
}

export async function HEAD(request: NextRequest, context: RouteContext) {
  return proxyBackendRequest(request, context);
}

export async function POST(request: NextRequest, context: RouteContext) {
  return proxyBackendRequest(request, context);
}

export async function PUT(request: NextRequest, context: RouteContext) {
  return proxyBackendRequest(request, context);
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  return proxyBackendRequest(request, context);
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  return proxyBackendRequest(request, context);
}
