import { NextRequest, NextResponse } from "next/server";

const LOCAL_SERVER_API_BASE_URL = "http://127.0.0.1:8000";
const DOCKER_SERVER_API_BASE_URL = "http://backend:8000";
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0"]);
const PLACEHOLDER_HOST_SNIPPETS = ["yourdomain.com", "example.com"];
const FORWARDED_HEADER_BLOCKLIST = new Set([
  "accept-encoding",
  "content-length",
  "host",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
]);
const RESPONSE_HEADER_BLOCKLIST = new Set(["content-encoding", "content-length"]);
const RETRYABLE_PROXY_STATUSES = new Set([502, 503, 504]);
const DEFAULT_BACKEND_PROXY_ATTEMPT_TIMEOUT_MS = 3_000;
const DEFAULT_BACKEND_PROXY_MUTATION_TIMEOUT_MS = 8_000;
const SAFE_FALLBACK_METHODS = new Set(["GET", "HEAD"]);

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

function buildForwardHeaders(request: NextRequest, correlationId: string) {
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!FORWARDED_HEADER_BLOCKLIST.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  });
  if (!headers.has("x-correlation-id")) {
    headers.set("X-Correlation-ID", correlationId);
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

function getProxyAttemptTimeoutMs(method: string) {
  const configured = Number.parseInt(
    process.env.BACKEND_PROXY_TIMEOUT_MS || "",
    10,
  );
  if (!Number.isFinite(configured)) {
    return SAFE_FALLBACK_METHODS.has(method)
      ? DEFAULT_BACKEND_PROXY_ATTEMPT_TIMEOUT_MS
      : DEFAULT_BACKEND_PROXY_MUTATION_TIMEOUT_MS;
  }

  // Reads may traverse three bounded transports. Mutations execute exactly
  // once and retain the historical, slightly longer proxy deadline.
  return SAFE_FALLBACK_METHODS.has(method)
    ? Math.min(Math.max(configured, 1_000), 5_000)
    : Math.min(Math.max(configured, 1_000), 30_000);
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

function logProxyFallback(input: {
  request: NextRequest;
  correlationId: string;
  failedCandidate: BackendApiCandidate;
  nextCandidate: BackendApiCandidate;
  reason: string;
  durationMs: number;
  status?: number;
  errorType?: string;
}) {
  console.warn(
    JSON.stringify({
      event: "backend_api_proxy_fallback_triggered",
      method: input.request.method,
      path: input.request.nextUrl.pathname,
      correlation_id: input.correlationId,
      from_stage: input.failedCandidate.stage,
      from_transport: input.failedCandidate.transport,
      to_stage: input.nextCandidate.stage,
      to_transport: input.nextCandidate.transport,
      reason: input.reason,
      duration_ms: Math.round(input.durationMs),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.errorType ? { error_type: input.errorType } : {}),
    }),
  );
}

function createProxyAttemptContext(
  requestSignal: AbortSignal,
  timeoutMs: number,
) {
  const controller = new AbortController();
  let timedOut = false;
  const abortForRequest = () => controller.abort();
  if (requestSignal.aborted) {
    abortForRequest();
  } else {
    requestSignal.addEventListener("abort", abortForRequest, { once: true });
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
      requestSignal.removeEventListener("abort", abortForRequest);
    },
  };
}

async function buildBufferedProxyResponse(
  response: Response,
  method: string,
  correlationId: string,
) {
  // Browser-facing API calls are JSON payloads. Buffering makes the BFF
  // deadline cover body delivery too (not merely response headers), which
  // prevents a stalled upstream stream from leaving client state unresolved.
  const body = method === "HEAD" ? null : await response.arrayBuffer();
  const headers = buildResponseHeaders(response);
  headers.set("X-Correlation-ID", correlationId);
  return new NextResponse(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function proxyBackendRequest(request: NextRequest, context: RouteContext) {
  const params = await context.params;
  const path = (params.path ?? []).map(encodeURIComponent).join("/");
  const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer();
  const startedAt = performance.now();
  const correlationId = createProxyCorrelationId(request);
  let lastErrorType: string | null = null;
  let lastRetryableResponse: NextResponse | null = null;
  let outcome = "unreachable";
  let responseStatus: number | undefined;
  let anyAttemptTimedOut = false;
  const resolvedCandidates = resolveBackendApiCandidates(request);
  const candidates = SAFE_FALLBACK_METHODS.has(request.method)
    ? resolvedCandidates
    : resolvedCandidates.slice(0, 1);

  try {
    for (let index = 0; index < candidates.length; index += 1) {
      if (request.signal.aborted) break;
      const candidate = candidates[index];
      const nextCandidate = candidates[index + 1];
      const targetUrl = buildTargetUrl(candidate.baseUrl, path, request);
      const attemptStartedAt = performance.now();
      const attempt = createProxyAttemptContext(
        request.signal,
        getProxyAttemptTimeoutMs(request.method),
      );

      try {
        const response = await fetch(targetUrl, {
          method: request.method,
          headers: buildForwardHeaders(request, correlationId),
          body,
          // Requests through this BFF include user auth and must not be shared
          // across users. Client-side resource caches handle safe SWR state.
          cache: "no-store",
          signal: attempt.signal,
        });

        if (RETRYABLE_PROXY_STATUSES.has(response.status)) {
          responseStatus = response.status;
          outcome = `upstream_${response.status}`;
          lastRetryableResponse = await buildBufferedProxyResponse(
            response,
            request.method,
            correlationId,
          );
          if (nextCandidate) {
            logProxyFallback({
              request,
              correlationId,
              failedCandidate: candidate,
              nextCandidate,
              reason: outcome,
              durationMs: performance.now() - attemptStartedAt,
              status: response.status,
            });
          }
          continue;
        }

        responseStatus = response.status;
        const proxiedResponse = await buildBufferedProxyResponse(
          response,
          request.method,
          correlationId,
        );
        outcome = "success";
        return proxiedResponse;
      } catch (error) {
        lastErrorType = error instanceof Error ? error.name : "UnknownError";
        const attemptTimedOut = attempt.didTimeout();
        anyAttemptTimedOut ||= attemptTimedOut;
        outcome = attemptTimedOut ? "timeout" : "upstream_body_error";
        if (nextCandidate && !request.signal.aborted) {
          logProxyFallback({
            request,
            correlationId,
            failedCandidate: candidate,
            nextCandidate,
            reason: outcome,
            durationMs: performance.now() - attemptStartedAt,
            errorType: lastErrorType,
          });
        }
      } finally {
        attempt.cleanup();
      }
    }

    if (lastRetryableResponse) {
      return lastRetryableResponse;
    }

    if (anyAttemptTimedOut) {
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
          },
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
        errorType: lastErrorType ?? undefined,
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
