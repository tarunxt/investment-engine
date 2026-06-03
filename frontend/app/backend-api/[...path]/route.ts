import { NextRequest, NextResponse } from "next/server";

const LOCAL_API_FALLBACK = "http://localhost:8000";
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

function inferApiBaseUrlsFromRequest(request: NextRequest) {
  const host = request.nextUrl.hostname;
  if (LOCAL_HOSTNAMES.has(host)) {
    return [LOCAL_API_FALLBACK];
  }

  const rootHostname = host.replace(/^www\./, "");
  return [
    `${request.nextUrl.protocol}//api.${rootHostname}`,
    `${request.nextUrl.protocol}//${request.nextUrl.host}${VERCEL_BACKEND_ROUTE_PREFIX}`,
  ];
}

function resolveConfiguredBackendApiBaseUrl() {
  const configured = parseConfiguredUrl(
    process.env.BACKEND_API_URL ||
      process.env.API_URL ||
      process.env.NEXT_PUBLIC_API_URL,
  );

  if (configured && !isPlaceholderHostname(configured.hostname)) {
    return trimTrailingSlash(configured.toString());
  }

  return null;
}

function resolveBackendApiBaseUrls(request: NextRequest) {
  const urls = [
    resolveConfiguredBackendApiBaseUrl(),
    ...inferApiBaseUrlsFromRequest(request),
  ].filter((url): url is string => Boolean(url));
  return Array.from(new Set(urls));
}

function buildForwardHeaders(request: NextRequest) {
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!FORWARDED_HEADER_BLOCKLIST.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  });
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

async function proxyBackendRequest(request: NextRequest, context: RouteContext) {
  const params = await context.params;
  const path = (params.path ?? []).map(encodeURIComponent).join("/");
  const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer();
  let lastErrorMessage: string | null = null;
  let lastResponse: Response | null = null;

  for (const baseUrl of resolveBackendApiBaseUrls(request)) {
    const targetUrl = buildTargetUrl(baseUrl, path, request);

    try {
      const response = await fetch(targetUrl, {
        method: request.method,
        headers: buildForwardHeaders(request),
        body,
        cache: "no-store",
      });

      if (RETRYABLE_PROXY_STATUSES.has(response.status)) {
        lastResponse = response;
        continue;
      }

      return new NextResponse(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: buildResponseHeaders(response),
      });
    } catch (error) {
      lastErrorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  if (lastResponse) {
    return new NextResponse(lastResponse.body, {
      status: lastResponse.status,
      statusText: lastResponse.statusText,
      headers: buildResponseHeaders(lastResponse),
    });
  }

  return NextResponse.json(
    {
      message: "Unable to reach backend API through the frontend proxy.",
      detail: lastErrorMessage ?? "No backend API target was available.",
    },
    { status: 502 },
  );
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
