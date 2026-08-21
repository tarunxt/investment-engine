const LOCAL_BACKEND_FALLBACK =
  process.env.BACKEND_API_URL ||
  process.env.API_URL ||
  "http://127.0.0.1:8000";

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function resolveBackendBaseUrl() {
  return trimTrailingSlash(LOCAL_BACKEND_FALLBACK);
}

async function parseBackendJson(response: Response) {
  const text = await response.text();
  if (!text.trim()) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function backendErrorMessage(payload: unknown, status: number) {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    return String(
      record.detail ||
        record.message ||
        record.error ||
        `Backend runtime returned HTTP ${status}.`,
    );
  }
  if (typeof payload === "string" && payload.trim()) {
    return payload.trim();
  }
  return `Backend runtime returned HTTP ${status}.`;
}

export class BackendRuntimeHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly payload: unknown,
    message = backendErrorMessage(payload, status),
  ) {
    super(message);
    this.name = "BackendRuntimeHttpError";
  }
}

export async function fetchBackendRuntimeJson<T = unknown>(
  path: string,
  {
    accessToken,
    body,
    method = "GET",
  }: {
    accessToken?: string | null;
    body?: unknown;
    method?: "GET" | "POST";
  } = {},
): Promise<T> {
  const response = await fetch(`${resolveBackendBaseUrl()}${path}`, {
    method,
    cache: "no-store",
    headers: {
      ...(accessToken
        ? {
            Authorization: `Bearer ${accessToken}`,
          }
        : {}),
      ...(body !== undefined
        ? {
            "Content-Type": "application/json",
          }
        : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const payload = await parseBackendJson(response);
  if (!response.ok) {
    throw new BackendRuntimeHttpError(response.status, payload);
  }

  return payload as T;
}
