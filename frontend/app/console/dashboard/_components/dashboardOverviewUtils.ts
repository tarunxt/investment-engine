import type {
  IndMoneyUsThreatAnalysis,
  IndMoneyUsThreatTableSection,
  ZerodhaThreatAnalysis,
  ZerodhaThreatTableSection,
} from "@/types/api";

export type DashboardMarket = "india" | "us";
export type DashboardThreatAnalysis =
  | ZerodhaThreatAnalysis
  | IndMoneyUsThreatAnalysis;
export type DashboardThreatTableSection =
  | ZerodhaThreatTableSection
  | IndMoneyUsThreatTableSection;

export type DashboardUrgentActionRow = {
  id: string;
  market: DashboardMarket;
  marketLabel: string;
  exchange: string;
  symbol: string;
  stockName: string;
  action: string;
  reason: string;
  trigger: string;
  deadline: string;
  priority: string;
  timeSensitivity: string;
  updatedAt: string | null;
  threatHref: string;
};

export type DashboardSeverityCounts = {
  veryHigh: number;
  high: number;
  medium: number;
  low: number;
};

export type DashboardSummaryPoint = {
  label: string;
  value: string;
};

const SUMMARY_POINT_CONFIG = [
  { label: "Main Risk", key: "main_portfolio_risk" },
  { label: "Near-Term Threat", key: "biggest_near_term_threat" },
  { label: "Protect Gains In", key: "biggest_profit_protection_candidate" },
] as const;

const PRIORITY_SCORES: Record<string, number> = {
  "very high": 0,
  high: 1,
  medium: 2,
  low: 3,
};

const TIMELINE_SCORES: Record<string, number> = {
  today: 0,
  "before earnings/event": 1,
  "on breakdown": 2,
  "on bounce": 3,
  "over next few sessions": 4,
};

function cleanCell(value: string | null | undefined) {
  return (value ?? "")
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)
    .join(" · ");
}

function extractDateTimestamp(value: string) {
  const normalized = cleanCell(value);
  if (!normalized) return Number.POSITIVE_INFINITY;

  const patterns = [
    /\b\d{1,2}\s[A-Za-z]{3,9}\s\d{4}\b/,
    /\b[A-Za-z]{3,9}\s\d{1,2},\s\d{4}\b/,
    /\b\d{4}-\d{2}-\d{2}\b/,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    const parsed = Date.parse(match[0]);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return Number.POSITIVE_INFINITY;
}

function readErrorText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readErrorObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractStructuredErrorMessage(message: string) {
  const trimmed = message.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }

  try {
    const payload = readErrorObject(JSON.parse(trimmed));
    if (!payload) {
      return null;
    }

    const health = readErrorObject(payload.health);
    const fallback = readErrorObject(payload.fallback);
    const primary =
      readErrorText(health?.message) ||
      readErrorText(payload.error) ||
      readErrorText(payload.detail) ||
      readErrorText(payload.message) ||
      readErrorText(fallback?.message);
    const actionNeeded = readErrorText(health?.actionNeeded);

    if (!primary) {
      return actionNeeded;
    }
    if (!actionNeeded || primary.includes(actionNeeded)) {
      return primary;
    }
    return `${primary} ${actionNeeded}`;
  } catch {
    return null;
  }
}

function truncateErrorMessage(message: string) {
  return message.length > 220
    ? `${message.slice(0, 217).trimEnd()}...`
    : message;
}

export function normalizeError(error: unknown) {
  if (error === null || error === undefined) {
    return "The request failed without an error message. Check the server logs for the request correlation ID.";
  }
  const errorObject = readErrorObject(error);
  const rawMessage =
    (error instanceof Error ? readErrorText(error.message) : null) ||
    readErrorText(errorObject?.detail) ||
    readErrorText(errorObject?.error) ||
    readErrorText(errorObject?.message) ||
    String(error);
  const message = extractStructuredErrorMessage(rawMessage) || rawMessage;
  if (/^(?:null|undefined|\[object Object\])$/i.test(message.trim())) {
    return "The request failed without a usable error message. Check the server logs for the request correlation ID.";
  }
  if (/<(?:!doctype\s+html|html|head|body)[\s>]/i.test(message)) {
    const titleMatch = message.match(/<title[^>]*>([^<]+)<\/title>/i);
    const headingMatch = message.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    return (
      headingMatch?.[1]?.trim() ||
      titleMatch?.[1]?.trim() ||
      "Upstream service returned an HTML error page"
    );
  }
  if (message.trim()) {
    return truncateErrorMessage(message);
  }
  return "Something went wrong";
}

export function formatTs(
  value: string | null | undefined,
  timeZone = "Asia/Kolkata",
) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-IN", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function formatSnapshotDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Date(`${value}T00:00:00`).toLocaleDateString("en-IN", {
    dateStyle: "medium",
  });
}

export function formatSnapshotTime(
  value: string | null | undefined,
  timeZone = "Asia/Kolkata",
) {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString("en-IN", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatCount(value: number | null | undefined) {
  if (value == null) return "—";
  return new Intl.NumberFormat("en-IN").format(value);
}

export function formatInr(value: number | null | undefined) {
  if (value == null) return "—";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatUsd(value: number | null | undefined) {
  if (value == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatPercent(value: number | null | undefined, digits = 2) {
  if (value == null) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}%`;
}

export function toneClass(value: number | null | undefined) {
  if (value == null) return "text-slate-500";
  if (value > 0) return "text-emerald-600";
  if (value < 0) return "text-rose-600";
  return "text-slate-500";
}

export function countThreatSeverities(
  tables: DashboardThreatTableSection[] | null | undefined,
): DashboardSeverityCounts {
  const counts = { veryHigh: 0, high: 0, medium: 0, low: 0 };

  for (const table of tables ?? []) {
    for (const row of table.rows) {
      for (const [column, value] of Object.entries(row)) {
        if (!/severity|risk|priority/i.test(column)) continue;
        const normalizedValues = value
          .split("\n")
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean);

        for (const normalized of normalizedValues) {
          if (normalized === "very high") counts.veryHigh += 1;
          if (normalized === "high") counts.high += 1;
          if (normalized === "medium") counts.medium += 1;
          if (normalized === "low") counts.low += 1;
        }
      }
    }
  }

  return counts;
}

export function getThreatSummaryPoints(
  analysis: DashboardThreatAnalysis | null | undefined,
) {
  const summary = analysis?.report?.summary;
  if (!summary) {
    return [];
  }

  return SUMMARY_POINT_CONFIG.map<DashboardSummaryPoint | null>((item) => {
    const value = summary[item.key];
    return value
      ? {
          label: item.label,
          value,
        }
      : null;
  }).filter((item): item is DashboardSummaryPoint => item !== null);
}

export function findThreatSection(
  analysis: DashboardThreatAnalysis | null | undefined,
  key: string,
) {
  return (
    analysis?.report?.tables.find((section) => section.key === key) ?? null
  );
}

export function extractUrgentActionRows({
  analysis,
  market,
  threatHref,
}: {
  analysis: DashboardThreatAnalysis | null | undefined;
  market: DashboardMarket;
  threatHref: string;
}) {
  const urgentSection = findThreatSection(analysis, "urgent_actionables");
  if (!urgentSection) {
    return [];
  }

  const marketLabel = market === "india" ? "India" : "US";

  return urgentSection.rows
    .map<DashboardUrgentActionRow | null>((row, index) => {
      const action = cleanCell(row["Urgent Action Needed"]);
      if (!action || /no urgent action required/i.test(action)) {
        return null;
      }

      const exchange = cleanCell(row.Exchange);
      const symbol = cleanCell(row["Stock Symbol"]);
      const stockName = cleanCell(row["Stock Name"]);

      return {
        id: `${market}-${symbol || stockName || index}`,
        market,
        marketLabel,
        exchange: exchange || "—",
        symbol: symbol || "—",
        stockName: stockName || "—",
        action,
        reason: cleanCell(row["Why Action Is Needed Now"]) || "—",
        trigger: cleanCell(row["Trigger / Condition"]) || "—",
        deadline: cleanCell(row["Exact Date / Deadline"]) || "Not found",
        priority: cleanCell(row.Priority) || "Low",
        timeSensitivity: cleanCell(row["Time Sensitivity"]) || "—",
        updatedAt: analysis?.updated_at ?? null,
        threatHref,
      };
    })
    .filter((item): item is DashboardUrgentActionRow => item !== null);
}

export function sortUrgentActionRows(rows: DashboardUrgentActionRow[]) {
  return [...rows].sort((left, right) => {
    const priorityDelta =
      (PRIORITY_SCORES[left.priority.toLowerCase()] ?? 99) -
      (PRIORITY_SCORES[right.priority.toLowerCase()] ?? 99);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }

    const timelineDelta =
      (TIMELINE_SCORES[left.timeSensitivity.toLowerCase()] ?? 99) -
      (TIMELINE_SCORES[right.timeSensitivity.toLowerCase()] ?? 99);
    if (timelineDelta !== 0) {
      return timelineDelta;
    }

    const deadlineDelta =
      extractDateTimestamp(left.deadline) -
      extractDateTimestamp(right.deadline);
    if (deadlineDelta !== 0) {
      return deadlineDelta;
    }

    return left.symbol.localeCompare(right.symbol, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}
