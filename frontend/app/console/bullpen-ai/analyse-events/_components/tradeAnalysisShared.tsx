"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export const tradeAnalysisSelectClassName =
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

export function formatPercent(value?: number | null, digits = 2) {
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

export function humanizeTag(value?: string | null) {
  if (!value) return "Unknown";
  return value.replace(/_/g, " ");
}

export function TradeAnalysisBadge({
  value,
  className,
}: {
  value?: string | null;
  className?: string;
}) {
  const normalized = (value || "UNKNOWN").toUpperCase();
  const toneClassName =
    normalized === "PROFIT"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : normalized === "LOSS"
        ? "border-rose-200 bg-rose-50 text-rose-700"
        : normalized === "OPEN"
          ? "border-sky-200 bg-sky-50 text-sky-700"
          : normalized === "FAILED"
            ? "border-amber-200 bg-amber-50 text-amber-700"
            : "border-slate-200 bg-slate-50 text-slate-700";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-none border px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]",
        toneClassName,
        className,
      )}
    >
      {humanizeTag(normalized)}
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

export function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card className="rounded-none border-slate-200 shadow-none">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold text-slate-950">{value}</div>
        {hint ? <p className="mt-2 text-xs text-slate-500">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}
