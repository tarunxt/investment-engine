type ApiErrorLike = {
  details?: unknown;
  message?: string | null;
  status?: number | null;
};

type ApiErrorSummaryParts = {
  statusText: string | null;
  message: string;
  details: string | null;
};

function normalizeText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "undefined") return null;
  return trimmed;
}

function looksLikeHtmlDocument(value: string) {
  return /<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]/i.test(value);
}

function summarizeHtmlErrorPayload(value: string) {
  if (!looksLikeHtmlDocument(value)) return null;

  const titleMatch = value.match(/<title[^>]*>([^<]+)<\/title>/i);
  const headingMatch = value.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  const summary = normalizeText(headingMatch?.[1] ?? titleMatch?.[1]);

  return summary || "Upstream service returned an HTML error page";
}

function appendUniqueDetail(
  parts: string[],
  seen: Set<string>,
  value: string | null | undefined,
) {
  const normalized = normalizeText(value);
  if (!normalized) return;

  const key = normalized.toLowerCase();
  if (seen.has(key)) return;

  seen.add(key);
  parts.push(normalized);
}

function collectApiErrorDetails(
  detail: unknown,
  baseMessage: string,
): string | null {
  const parts: string[] = [];
  const seen = new Set<string>();
  appendUniqueDetail(parts, seen, baseMessage);

  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const record = detail as Record<string, unknown>;
    const nestedDetail =
      record.detail && typeof record.detail === "object" && !Array.isArray(record.detail)
        ? (record.detail as Record<string, unknown>)
        : null;
    const errorCode = normalizeText(stringifyErrorDetail(record.error));
    const nestedErrorCode = normalizeText(stringifyErrorDetail(nestedDetail?.error));
    if (errorCode || nestedErrorCode) {
      appendUniqueDetail(parts, seen, `Code: ${errorCode || nestedErrorCode}`);
    }

    appendUniqueDetail(parts, seen, stringifyErrorDetail(record.detail));
    appendUniqueDetail(parts, seen, stringifyErrorDetail(record.reason));
    appendUniqueDetail(parts, seen, stringifyErrorDetail(record.title));
    appendUniqueDetail(parts, seen, stringifyErrorDetail(record.details));
    appendUniqueDetail(
      parts,
      seen,
      nestedDetail?.required_migration
        ? `Required migration: ${String(nestedDetail.required_migration)}`
        : null,
    );
    appendUniqueDetail(
      parts,
      seen,
      nestedDetail?.run_id ? `Run ID: ${String(nestedDetail.run_id)}` : null,
    );
  }

  appendUniqueDetail(parts, seen, stringifyErrorDetail(detail));

  return parts.length > 1 ? parts.slice(1).join(" • ") : null;
}

export function stringifyErrorDetail(detail: unknown): string | null {
  if (detail == null) return null;
  if (typeof detail === "string") {
    const trimmed = detail.trim();
    const htmlSummary = summarizeHtmlErrorPayload(trimmed);
    if (htmlSummary) return htmlSummary;
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

function deriveStructuredApiErrorMessage(
  detail: Record<string, unknown>,
): string | null {
  const nested =
    detail.detail && typeof detail.detail === "object" && !Array.isArray(detail.detail)
      ? (detail.detail as Record<string, unknown>)
      : null;
  const envelope = nested ?? detail;
  const explicitMessage =
    normalizeText(stringifyErrorDetail(envelope.message)) ||
    normalizeText(stringifyErrorDetail(detail.message));
  const baseMessage =
    explicitMessage || normalizeText(stringifyErrorDetail(detail.detail));
  if (!baseMessage) return null;

  const parts: string[] = [baseMessage];
  const seen = new Set(parts.map((item) => item.toLowerCase()));
  const errorCode = explicitMessage
    ? normalizeText(stringifyErrorDetail(envelope.error)) ||
      normalizeText(stringifyErrorDetail(envelope.code)) ||
      normalizeText(stringifyErrorDetail(detail.error)) ||
      normalizeText(stringifyErrorDetail(detail.code))
    : null;
  if (errorCode) {
    appendUniqueDetail(parts, seen, `Code: ${errorCode}`);
  }

  appendUniqueDetail(parts, seen, stringifyErrorDetail(envelope.error_type));
  appendUniqueDetail(parts, seen, stringifyErrorDetail(envelope.correlation_id));
  appendUniqueDetail(parts, seen, stringifyErrorDetail(envelope.request_path));
  appendUniqueDetail(parts, seen, stringifyErrorDetail(envelope.resolution));
  appendUniqueDetail(parts, seen, stringifyErrorDetail(envelope.instructions));
  appendUniqueDetail(parts, seen, stringifyErrorDetail(envelope.details));

  return parts.join(" • ");
}

export function deriveApiErrorMessage(
  detail: unknown,
  fallback = "API request failed",
) {
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const structured = deriveStructuredApiErrorMessage(
      detail as Record<string, unknown>,
    );
    if (structured) return structured;
  }

  const message = stringifyErrorDetail(detail);
  if (!message) return fallback;
  if (message.toLowerCase() === "undefined") return fallback;
  return message;
}

export function splitApiErrorSummary(
  error: ApiErrorLike,
): ApiErrorSummaryParts {
  const message =
    deriveApiErrorMessage(error.message, "API request failed") ||
    "API request failed";
  const statusText =
    typeof error.status === "number" ? `HTTP ${error.status}` : null;

  return {
    statusText,
    message,
    details: collectApiErrorDetails(error.details, message),
  };
}

export function formatApiErrorSummary(error: ApiErrorLike) {
  const { statusText, message, details } = splitApiErrorSummary(error);
  const prefix = statusText ?? "API error";
  const detailSeparator = /[.!?]$/.test(message) ? " Details: " : ". Details: ";
  return details
    ? `${prefix}: ${message}${detailSeparator}${details}`
    : `${prefix}: ${message}`;
}

export function formatUnknownError(error: unknown) {
  if (error instanceof Error) {
    const message = error.message?.trim() || "Unexpected error";
    return `${error.name}: ${message}`;
  }
  if (typeof error === "string" && error.trim()) return error.trim();
  return `Unexpected error: ${String(error)}`;
}
