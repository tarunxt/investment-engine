import { NextRequest, NextResponse } from "next/server";

const LOCAL_SERVER_API_BASE_URLS = [
  "http://127.0.0.1:8000",
  "http://localhost:8000",
];
const VERCEL_BACKEND_ROUTE_PREFIX = "/_/backend";
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
const DEFAULT_BACKEND_PROXY_TIMEOUT_MS = 8_000;

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

function resolveConfiguredBackendApiBaseUrls() {
  return [
    process.env.BACKEND_API_URL,
    process.env.API_URL,
    process.env.NEXT_PUBLIC_API_URL,
    ...LOCAL_SERVER_API_BASE_URLS,
  ]
    .map(parseConfiguredUrl)
    .filter((parsed): parsed is URL => Boolean(parsed))
    .filter((parsed) => !isPlaceholderHostname(parsed.hostname))
    .map((parsed) => trimTrailingSlash(parsed.toString()));
}

function inferBackendApiBaseUrlsFromRequest(request: NextRequest) {
  const host = request.nextUrl.hostname;
  if (LOCAL_HOSTNAMES.has(host)) {
    return LOCAL_SERVER_API_BASE_URLS;
  }

  const rootHostname = host.replace(/^www\./, "");
  return [
    `${request.nextUrl.protocol}//${request.nextUrl.host}${VERCEL_BACKEND_ROUTE_PREFIX}`,
    `${request.nextUrl.protocol}//api.${rootHostname}`,
  ];
}

function resolveBackendApiBaseUrls(request: NextRequest) {
  return Array.from(
    new Set([
      ...resolveConfiguredBackendApiBaseUrls(),
      ...inferBackendApiBaseUrlsFromRequest(request),
    ]),
  );
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

function getProxyTimeoutMs() {
  const configured = Number.parseInt(
    process.env.BACKEND_PROXY_TIMEOUT_MS || "",
    10,
  );
  if (!Number.isFinite(configured)) return DEFAULT_BACKEND_PROXY_TIMEOUT_MS;

  // A browser-facing BFF endpoint should fail promptly. Keep this bounded so
  // a malformed environment value cannot recreate an indefinite UI wait.
  return Math.min(Math.max(configured, 1_000), 30_000);
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
  let lastResponse: Response | null = null;
  let outcome = "unreachable";
  let responseStatus: number | undefined;
  const controller = new AbortController();
  let timedOut = false;
  const abortForClientDisconnect = () => controller.abort();
  if (request.signal.aborted) {
    abortForClientDisconnect();
  } else {
    request.signal.addEventListener("abort", abortForClientDisconnect, {
      once: true,
    });
  }
  const timeoutId = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, getProxyTimeoutMs());

  try {
    for (const baseUrl of resolveBackendApiBaseUrls(request)) {
      if (controller.signal.aborted) break;
      const targetUrl = buildTargetUrl(baseUrl, path, request);

      try {
        const response = await fetch(targetUrl, {
          method: request.method,
          headers: buildForwardHeaders(request, correlationId),
          body,
          // Requests through this BFF include user auth and must not be shared
          // across users. Client-side resource caches handle safe SWR state.
          cache: "no-store",
          signal: controller.signal,
        });

        if (RETRYABLE_PROXY_STATUSES.has(response.status)) {
          // Avoid retaining a retry response body while trying the next safe
          // origin. The final response (if every origin fails) stays intact.
          if (lastResponse?.body) {
            void lastResponse.body.cancel().catch(() => undefined);
          }
          lastResponse = response;
          responseStatus = response.status;
          outcome = `upstream_${response.status}`;
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
        outcome = "upstream_body_error";
      }
    }

    if (timedOut) {
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

    if (lastResponse) {
      try {
        return await buildBufferedProxyResponse(
          lastResponse,
          request.method,
          correlationId,
        );
      } catch (error) {
        lastErrorType = error instanceof Error ? error.name : "UnknownError";
        if (timedOut) {
          outcome = "timeout";
          return NextResponse.json(
            { message: "The backend did not respond in time. Please retry." },
            {
              status: 504,
              headers: {
                "Retry-After": "1",
                "X-Correlation-ID": correlationId,
              },
            },
          );
        }
        outcome = "upstream_body_error";
      }
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
    globalThis.clearTimeout(timeoutId);
    request.signal.removeEventListener("abort", abortForClientDisconnect);
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
