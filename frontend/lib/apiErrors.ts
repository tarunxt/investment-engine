type ApiErrorLike = {
  details?: unknown;
  message?: string | null;
  status?: number | null;
};

export function stringifyErrorDetail(detail: unknown): string | null {
  if (detail == null) return null;
  if (typeof detail === "string") {
    const trimmed = detail.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof detail === "number" || typeof detail === "boolean") {
    return String(detail);
  }
  if (Array.isArray(detail)) {
    const parts = detail
      .map((item) => stringifyErrorDetail(item))
      .filter((item): item is string => Boolean(item));
    return parts.length > 0 ? parts.join("; ") : null;
  }
  if (typeof detail === "object") {
    const record = detail as Record<string, unknown>;
    const preferred =
      stringifyErrorDetail(record.detail) ||
      stringifyErrorDetail(record.message) ||
      stringifyErrorDetail(record.error) ||
      stringifyErrorDetail(record.reason) ||
      stringifyErrorDetail(record.title);
    if (preferred) return preferred;

    const entries = Object.entries(record)
      .map(([key, value]) => {
        const valueText = stringifyErrorDetail(value);
        return valueText ? `${key}: ${valueText}` : null;
      })
      .filter((entry): entry is string => Boolean(entry));
    return entries.length > 0 ? entries.join("; ") : null;
  }
  return String(detail);
}

export function deriveApiErrorMessage(
  detail: unknown,
  fallback = "API request failed",
) {
  const message = stringifyErrorDetail(detail);
  if (!message) return fallback;
  if (message.toLowerCase() === "undefined") return fallback;
  return message;
}

export function formatApiErrorSummary(error: ApiErrorLike) {
  const statusText =
    typeof error.status === "number" ? `HTTP ${error.status}` : "API error";
  const baseMessage =
    deriveApiErrorMessage(error.message, "API request failed") ||
    "API request failed";
  const details = stringifyErrorDetail(error.details);

  return details && details !== baseMessage
    ? `${statusText}: ${baseMessage}. Details: ${details}`
    : `${statusText}: ${baseMessage}`;
}

export function formatUnknownError(error: unknown) {
  if (error instanceof Error) {
    const message = error.message?.trim() || "Unexpected error";
    return `${error.name}: ${message}`;
  }
  if (typeof error === "string" && error.trim()) return error.trim();
  return `Unexpected error: ${String(error)}`;
}
