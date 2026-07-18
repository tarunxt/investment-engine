"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export const runAuditSelectClassName =
  "h-10 rounded-none border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/30";

export function formatCurrency(value?: number | null) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatNumber(value?: number | null, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
  }).format(value);
}

export function formatPercent(value?: number | null, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${formatNumber(value, digits)}%`;
}

export function formatDateTime(value?: string | null) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

export function formatDuration(seconds?: number | null) {
  if (seconds === null || seconds === undefined) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${formatNumber(seconds / 3600, 1)}h`;
  return `${formatNumber(seconds / 86400, 1)}d`;
}

export function humanizeToken(value?: string | null) {
  if (!value) return "Unknown";
  return value
    .replace(/[_-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function toneClassName(tone: string) {
  if (tone === "critical" || tone === "danger") {
    return "border-rose-200 bg-rose-50 text-rose-700";
  }
  if (tone === "high" || tone === "warning") {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }
  if (tone === "success") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }
  if (tone === "info") {
    return "border-sky-200 bg-sky-50 text-sky-700";
  }
  return "border-slate-200 bg-slate-50 text-slate-700";
}

export function severityTone(severity?: string | null) {
  switch ((severity || "").toLowerCase()) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "medium":
      return "warning";
    case "low":
      return "info";
    case "pass":
    case "healthy":
      return "success";
    default:
      return "neutral";
  }
}

export function statusTone(status?: string | null) {
  const normalized = (status || "").toLowerCase();
  if (["failed", "error", "critical"].includes(normalized)) return "critical";
  if (["partial_success", "partial", "warning", "incomplete", "blocked"].includes(normalized)) {
    return "warning";
  }
  if (["completed", "success", "pass", "selected", "frozen"].includes(normalized)) {
    return "success";
  }
  if (["processing", "queued", "running", "working"].includes(normalized)) return "info";
  return "neutral";
}

export function AuditBadge({
  label,
  tone,
  className,
}: {
  label?: string | null;
  tone?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-none border px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.16em]",
        toneClassName(tone || "neutral"),
        className,
      )}
    >
      {label || "Unknown"}
    </span>
  );
}

export function JsonPanel({
  title,
  value,
  defaultOpen = false,
}: {
  title: string;
  value: unknown;
  defaultOpen?: boolean;
}) {
  return (
    <details
      open={defaultOpen}
      className="rounded-none border border-slate-200 bg-white"
    >
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-slate-900">
        {title}
      </summary>
      <pre className="overflow-x-auto border-t border-slate-200 bg-slate-950 px-4 py-4 text-xs leading-6 text-slate-100">
        {JSON.stringify(value ?? {}, null, 2)}
      </pre>
    </details>
  );
}

export function SummaryStatCard({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: string;
}) {
  return (
    <Card className="rounded-none border-slate-200 shadow-none">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className={cn("text-2xl font-semibold", toneClassName(tone).split(" ").at(-1))}>
          {value}
        </div>
        {hint ? <p className="mt-2 text-xs text-slate-500">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

export function DetailGrid({
  items,
}: {
  items: Array<{ label: string; value: string }>;
}) {
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      {items.map((item) => (
        <div key={`${item.label}-${item.value}`} className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            {item.label}
          </p>
          <p className="text-sm text-slate-900">{item.value}</p>
        </div>
      ))}
    </div>
  );
}
