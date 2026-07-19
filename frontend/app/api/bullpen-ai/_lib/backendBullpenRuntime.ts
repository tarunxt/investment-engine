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

export async function fetchBackendRuntimeJson(
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
) {
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
    const message =
      payload && typeof payload === "object"
        ? String(
            (payload as Record<string, unknown>).detail ||
              (payload as Record<string, unknown>).message ||
              (payload as Record<string, unknown>).error ||
              `Backend runtime returned HTTP ${response.status}.`,
          )
        : typeof payload === "string" && payload.trim()
          ? payload.trim()
          : `Backend runtime returned HTTP ${response.status}.`;
    throw new Error(message);
  }

  return payload;
}
