import { NextRequest, NextResponse } from "next/server";

const LOCAL_API_FALLBACK = "http://localhost:8000";
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

function inferApiBaseUrlFromRequest(request: NextRequest) {
  const host = request.nextUrl.hostname;
  if (LOCAL_HOSTNAMES.has(host)) {
    return LOCAL_API_FALLBACK;
  }

  const rootHostname = host.replace(/^www\./, "");
  return `${request.nextUrl.protocol}//api.${rootHostname}`;
}

function resolveBackendApiBaseUrl(request: NextRequest) {
  const configured = parseConfiguredUrl(
    process.env.API_URL || process.env.NEXT_PUBLIC_API_URL,
  );

  if (configured && !isPlaceholderHostname(configured.hostname)) {
    return trimTrailingSlash(configured.toString());
  }

  return inferApiBaseUrlFromRequest(request);
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

async function proxyBackendRequest(request: NextRequest, context: RouteContext) {
  const params = await context.params;
  const path = (params.path ?? []).map(encodeURIComponent).join("/");
  const targetUrl = new URL(`${resolveBackendApiBaseUrl(request)}/${path}`);
  targetUrl.search = request.nextUrl.search;

  try {
    const response = await fetch(targetUrl, {
      method: request.method,
      headers: buildForwardHeaders(request),
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
      cache: "no-store",
    });

    return new NextResponse(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: buildResponseHeaders(response),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      {
        message: "Unable to reach backend API through the frontend proxy.",
        detail: message,
      },
      { status: 502 },
    );
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
