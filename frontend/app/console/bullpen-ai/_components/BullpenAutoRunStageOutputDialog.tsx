"use client";

import type { ReactNode } from "react";
import { ExternalLink, X } from "lucide-react";

type BullpenAutoRunStageOutputDialogProps = {
  stageTitle: string;
  stageDetail: string;
  eyebrow?: string;
  outputs: Record<string, unknown>;
  outputLabel?: string;
  onClose: () => void;
};

type Tone = "slate" | "sky" | "emerald" | "amber" | "rose";

const SUMMARY_COLUMN_PRIORITY = [
  "question",
  "market_title",
  "theme",
  "source_kind",
  "close_time",
  "current_yes_odds",
  "current_no_odds",
  "llm_yes_odds",
  "llm_no_odds",
  "fair_yes_probability_pct",
  "fair_no_probability_pct",
  "returns_per_day",
  "amount_to_be_invested",
  "current_exposure_usd",
  "target_exposure_usd",
  "decision",
  "side",
  "selected_side",
  "confidence",
  "evidence_status",
  "event_state",
  "adjudication_required",
];

const DETAIL_FIELD_PRIORITY = [
  "question",
  "market_title",
  "theme",
  "market_id",
  "question_id",
  "slug",
  "source_kind",
  "position_key",
  "position_side",
  "market_url",
  "close_time",
  "selected",
  "force_include",
  "selected_side",
  "decision",
  "side",
  "current_yes_odds",
  "current_no_odds",
  "llm_yes_odds",
  "llm_no_odds",
  "fair_yes_probability_pct",
  "fair_no_probability_pct",
  "returns_per_day",
  "amount_to_be_invested",
  "current_exposure_usd",
  "target_exposure_usd",
  "confidence",
  "evidence_status",
  "event_state",
  "llm_disagreement_level",
  "llm_disagreement_category",
  "disagreement_level",
  "disagreement_category",
  "adjudication_required",
  "yes_definition",
  "deadline_et",
  "hours_remaining",
  "rules_fail_reason",
];

const METRIC_KEYS = [
  "current_yes_odds",
  "current_no_odds",
  "llm_yes_odds",
  "llm_no_odds",
  "fair_yes_probability_pct",
  "fair_no_probability_pct",
  "returns_per_day",
  "amount_to_be_invested",
  "current_exposure_usd",
  "target_exposure_usd",
  "confidence",
  "evidence_status",
  "event_state",
  "selected_side",
  "decision",
  "side",
  "adjudication_required",
];

const LONG_TEXT_KEYS = new Set([
  "rules",
  "reason",
  "rationale",
  "summary",
  "detail",
  "content",
  "resolution_criteria",
  "yes_definition",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPrimitive(value: unknown): value is string | number | boolean | null | undefined {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    value === undefined
  );
}

function renderJson(value: Record<string, unknown>) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "{}";
  }
}

function formatLabel(key: string) {
  return key
    .split("_")
    .map((part) => {
      const normalized = part.toLowerCase();
      if (normalized === "llm") return "LLM";
      if (normalized === "usd") return "USD";
      if (normalized === "url") return "URL";
      if (normalized === "id") return "ID";
      if (normalized === "et") return "ET";
      if (normalized === "api") return "API";
      if (normalized === "pnl") return "PnL";
      if (normalized === "yes") return "Yes";
      if (normalized === "no") return "No";
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function isUrlString(value: string) {
  return value.startsWith("https://") || value.startsWith("http://");
}

function looksLikeDateString(value: string) {
  return /^\d{4}-\d{2}-\d{2}(?:[T ]|$)/.test(value);
}

function isLongTextField(key: string, value: unknown) {
  return typeof value === "string" && (LONG_TEXT_KEYS.has(key) || value.length > 160);
}

function formatNumber(value: number, key: string) {
  const normalizedKey = key.toLowerCase();
  const formatted = value.toLocaleString("en-IN", {
    maximumFractionDigits: normalizedKey.includes("shares") ? 6 : 2,
  });

  if (
    normalizedKey.includes("odds") ||
    normalizedKey.includes("probability") ||
    normalizedKey.includes("edge_pp")
  ) {
    return `${formatted}%`;
  }
  if (normalizedKey.includes("returns_per_day")) {
    return `${formatted} / day`;
  }
  if (normalizedKey.includes("hours_remaining")) {
    return `${formatted}h`;
  }
  if (normalizedKey.includes("price_cents")) {
    return `${formatted}c`;
  }
  if (normalizedKey.includes("usd") || normalizedKey.includes("amount_to_be_invested")) {
    return `$${formatted}`;
  }
  return formatted;
}

function badgeToneForValue(value: string | boolean, key: string): Tone {
  if (typeof value === "boolean") {
    return value ? "emerald" : "slate";
  }

  const normalizedKey = key.toLowerCase();
  const normalized = value.toLowerCase();

  if (
    normalized === "high" ||
    normalized === "strong" ||
    normalized === "pass" ||
    normalized === "completed" ||
    normalized === "ready" ||
    normalized === "buy_new" ||
    normalized === "buy" ||
    normalized === "hold" ||
    normalized === "yes" ||
    normalized === "consensus"
  ) {
    return "emerald";
  }

  if (
    normalized === "medium" ||
    normalized === "moderate" ||
    normalized === "low" ||
    normalized.includes("warning") ||
    normalized.includes("uncertainty") ||
    normalized.includes("queued") ||
    normalized.includes("scheduled_not_occurred") ||
    normalized.includes("outlier")
  ) {
    return "amber";
  }

  if (
    normalized.includes("fail") ||
    normalized.includes("error") ||
    normalized.includes("blocked") ||
    normalized.includes("conflicting") ||
    normalized === "exit" ||
    normalized === "skip" ||
    normalized === "no"
  ) {
    return "rose";
  }

  if (
    normalizedKey.includes("status") ||
    normalizedKey.includes("confidence") ||
    normalizedKey.includes("state") ||
    normalizedKey.includes("category") ||
    normalizedKey.includes("decision") ||
    normalizedKey.includes("side")
  ) {
    return "sky";
  }

  return "sky";
}

function badgeClasses(tone: Tone) {
  if (tone === "emerald") {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }
  if (tone === "amber") {
    return "border-amber-200 bg-amber-50 text-amber-800";
  }
  if (tone === "rose") {
    return "border-rose-200 bg-rose-50 text-rose-800";
  }
  if (tone === "sky") {
    return "border-sky-200 bg-sky-50 text-sky-800";
  }
  return "border-slate-200 bg-slate-100 text-slate-700";
}

function shouldRenderAsBadge(value: string, key: string) {
  if (isUrlString(value) || isLongTextField(key, value) || value.length > 40) {
    return false;
  }

  const normalizedKey = key.toLowerCase();
  const normalized = value.toLowerCase();
  return (
    normalizedKey.includes("status") ||
    normalizedKey.includes("confidence") ||
    normalizedKey.includes("state") ||
    normalizedKey.includes("category") ||
    normalizedKey.includes("decision") ||
    normalizedKey.includes("side") ||
    normalizedKey.includes("theme") ||
    normalized.includes("consensus") ||
    normalized.includes("warning") ||
    normalized.includes("conflicting") ||
    normalized.includes("scheduled_not_occurred") ||
    normalized === "high" ||
    normalized === "medium" ||
    normalized === "low" ||
    normalized === "strong" ||
    normalized === "moderate" ||
    normalized === "yes" ||
    normalized === "no"
  );
}

function orderEntries(entries: [string, unknown][]) {
  const positions = new Map(
    DETAIL_FIELD_PRIORITY.map((key, index) => [key, index] as const),
  );
  return [...entries].sort((a, b) => {
    const aIndex = positions.get(a[0]) ?? Number.MAX_SAFE_INTEGER;
    const bIndex = positions.get(b[0]) ?? Number.MAX_SAFE_INTEGER;
    if (aIndex !== bIndex) return aIndex - bIndex;
    return a[0].localeCompare(b[0]);
  });
}

function renderCompactValue(value: unknown, key: string): ReactNode {
  if (value === null || value === undefined || value === "") {
    return <span className="text-slate-400">—</span>;
  }

  if (typeof value === "number") {
    return <span className="font-semibold text-slate-900">{formatNumber(value, key)}</span>;
  }

  if (typeof value === "boolean") {
    return (
      <span
        className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${badgeClasses(
          badgeToneForValue(value, key),
        )}`}
      >
        {value ? "Yes" : "No"}
      </span>
    );
  }

  if (typeof value === "string") {
    if (isUrlString(value)) {
      return (
        <a
          href={value}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-semibold text-sky-700 hover:text-sky-900"
        >
          Open
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      );
    }
    if (shouldRenderAsBadge(value, key)) {
      return (
        <span
          className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${badgeClasses(
            badgeToneForValue(value, key),
          )}`}
        >
          {value}
        </span>
      );
    }
    return <span className="break-words text-slate-700">{value}</span>;
  }

  if (Array.isArray(value)) {
    return (
      <span className="inline-flex rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700">
        {value.length} {value.length === 1 ? "item" : "items"}
      </span>
    );
  }

  if (isRecord(value)) {
    return (
      <span className="inline-flex rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700">
        {Object.keys(value).length} fields
      </span>
    );
  }

  return <span className="text-slate-500">{String(value)}</span>;
}

function StructuredValue({
  value,
  fieldKey,
  depth = 0,
}: {
  value: unknown;
  fieldKey: string;
  depth?: number;
}) {
  if (value === null || value === undefined || value === "") {
    return <span className="text-slate-400">—</span>;
  }

  if (typeof value === "number") {
    return <span className="font-semibold text-slate-900">{formatNumber(value, fieldKey)}</span>;
  }

  if (typeof value === "boolean") {
    return (
      <span
        className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${badgeClasses(
          badgeToneForValue(value, fieldKey),
        )}`}
      >
        {value ? "Yes" : "No"}
      </span>
    );
  }

  if (typeof value === "string") {
    if (isUrlString(value)) {
      return (
        <a
          href={value}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-semibold text-sky-700 hover:text-sky-900"
        >
          {value}
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      );
    }

    if (shouldRenderAsBadge(value, fieldKey)) {
      return (
        <span
          className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${badgeClasses(
            badgeToneForValue(value, fieldKey),
          )}`}
        >
          {value}
        </span>
      );
    }

    if (looksLikeDateString(value)) {
      return (
        <span className="font-mono text-xs text-slate-700">
          {value}
        </span>
      );
    }

    if (isLongTextField(fieldKey, value)) {
      return (
        <div className="rounded-xl border border-sky-100 bg-sky-50/70 px-3 py-3 text-sm leading-7 text-slate-700">
          {value}
        </div>
      );
    }

    return <span className="break-words text-slate-700">{value}</span>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="text-slate-400">No items</span>;
    }

    if (value.every((item) => isPrimitive(item))) {
      return (
        <div className="flex flex-wrap gap-2">
          {value.map((item, index) => (
            <span
              key={`${fieldKey}-${index}`}
              className="rounded-full border border-slate-200 bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700"
            >
              {item === null || item === undefined || item === "" ? "—" : String(item)}
            </span>
          ))}
        </div>
      );
    }

    if (value.every((item) => isRecord(item))) {
      const records = value as Record<string, unknown>[];
      return (
        <div className="space-y-3">
          {records.map((record, index) => (
            <div
              key={`${fieldKey}-${index}`}
              className="rounded-2xl border border-slate-200 bg-white/80 p-3"
            >
              <div className="mb-2 flex items-center justify-between gap-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  {formatLabel(fieldKey)} {index + 1}
                </p>
                <span className="rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700">
                  {Object.keys(record).length} fields
                </span>
              </div>
              <KeyValueTable entries={orderEntries(Object.entries(record))} nested />
            </div>
          ))}
        </div>
      );
    }

    return (
      <div className="space-y-2">
        {value.map((item, index) => (
          <div
            key={`${fieldKey}-${index}`}
            className="rounded-xl border border-slate-200 bg-slate-50/70 p-3"
          >
            <StructuredValue value={item} fieldKey={`${fieldKey}_${index}`} depth={depth + 1} />
          </div>
        ))}
      </div>
    );
  }

  if (isRecord(value)) {
    return (
      <div className={depth === 0 ? "" : "rounded-2xl border border-slate-200 bg-white/80 p-3"}>
        <KeyValueTable entries={orderEntries(Object.entries(value))} nested={depth > 0} />
      </div>
    );
  }

  return <span className="text-slate-500">{String(value)}</span>;
}

function KeyValueTable({
  entries,
  nested = false,
}: {
  entries: [string, unknown][];
  nested?: boolean;
}) {
  return (
    <div className={`overflow-hidden rounded-2xl border ${nested ? "border-slate-200" : "border-slate-200 bg-white"}`}>
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50 text-left text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          <tr>
            <th className="w-52 px-4 py-3">Field</th>
            <th className="px-4 py-3">Value</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">
          {entries.map(([key, value]) => (
            <tr key={key} className="align-top">
              <th className="bg-slate-50/70 px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                {formatLabel(key)}
              </th>
              <td className="px-4 py-3 leading-6 text-slate-700">
                <StructuredValue value={value} fieldKey={key} depth={nested ? 2 : 1} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function buildSummaryColumns(rows: Record<string, unknown>[]) {
  const discoveredKeys: string[] = [];

  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!discoveredKeys.includes(key)) {
        discoveredKeys.push(key);
      }
    }
  }

  const summaryFriendlyKeys = discoveredKeys.filter((key) => {
    if (key === "market_url" || LONG_TEXT_KEYS.has(key)) return false;

    return rows.some((row) => {
      const value = row[key];
      if (value === null || value === undefined || value === "") return false;
      if (Array.isArray(value) || isRecord(value)) return false;
      if (typeof value === "string" && isLongTextField(key, value)) return false;
      return true;
    });
  });

  const priorityKeys = SUMMARY_COLUMN_PRIORITY.filter((key) =>
    summaryFriendlyKeys.includes(key),
  );
  const extraKeys = summaryFriendlyKeys.filter((key) => !priorityKeys.includes(key));

  return [...priorityKeys, ...extraKeys];
}

function SummaryTable({
  rows,
  title,
}: {
  rows: Record<string, unknown>[];
  title: string;
}) {
  const columns = buildSummaryColumns(rows);
  if (columns.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          {title}
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-white text-left text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
            <tr>
              {columns.map((column) => (
                <th key={column} className="px-4 py-3">
                  {formatLabel(column)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {rows.map((row, index) => (
              <tr key={index} className="align-top hover:bg-slate-50/80">
                {columns.map((column) => (
                  <td key={`${index}-${column}`} className="px-4 py-3">
                    {renderCompactValue(row[column], column)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MetricStrip({
  record,
}: {
  record: Record<string, unknown>;
}) {
  const metrics = METRIC_KEYS.filter((key) => record[key] !== null && record[key] !== undefined);
  if (metrics.length === 0) return null;

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {metrics.map((key) => (
        <div
          key={key}
          className="rounded-2xl border border-slate-200 bg-slate-50/80 px-3 py-3"
        >
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
            {formatLabel(key)}
          </p>
          <div className="mt-2 text-sm font-semibold text-slate-900">
            <StructuredValue value={record[key]} fieldKey={key} />
          </div>
        </div>
      ))}
    </div>
  );
}

function RecordDetailsCard({
  record,
  index,
}: {
  record: Record<string, unknown>;
  index: number;
}) {
  const title =
    (typeof record.question === "string" && record.question) ||
    (typeof record.market_title === "string" && record.market_title) ||
    (typeof record.market_id === "string" && record.market_id) ||
    (typeof record.slug === "string" && record.slug) ||
    `Item ${index + 1}`;
  const marketUrl =
    typeof record.market_url === "string" && isUrlString(record.market_url)
      ? record.market_url
      : null;
  const ordered = orderEntries(Object.entries(record));
  const metricKeys = new Set(METRIC_KEYS);
  const details = ordered.filter(
    ([key, value]) =>
      key !== "question" &&
      key !== "market_title" &&
      !(metricKeys.has(key) && value !== null && value !== undefined),
  );
  const longTextEntries = details.filter(([key, value]) => isLongTextField(key, value));
  const regularEntries = details.filter(([key, value]) => !isLongTextField(key, value));

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-sky-800">
              Event {index + 1}
            </span>
            {typeof record.theme === "string" && record.theme ? (
              <span className="rounded-full border border-fuchsia-200 bg-fuchsia-50 px-2.5 py-1 text-[11px] font-semibold text-fuchsia-800">
                {record.theme}
              </span>
            ) : null}
            {typeof record.source_kind === "string" && record.source_kind ? (
              <span className="rounded-full border border-slate-200 bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-700">
                {record.source_kind}
              </span>
            ) : null}
          </div>
          <h4 className="text-lg font-semibold text-slate-950">{title}</h4>
          <div className="flex flex-wrap gap-2 text-xs text-slate-500">
            {typeof record.market_id === "string" && record.market_id ? (
              <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 font-mono">
                {record.market_id}
              </span>
            ) : null}
            {typeof record.slug === "string" && record.slug ? (
              <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 font-mono">
                {record.slug}
              </span>
            ) : null}
          </div>
        </div>
        {marketUrl ? (
          <a
            href={marketUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-full border border-sky-200 bg-sky-50 px-3 py-2 text-sm font-semibold text-sky-800 transition hover:bg-sky-100"
          >
            Open market
            <ExternalLink className="h-4 w-4" />
          </a>
        ) : null}
      </div>

      <div className="mt-4">
        <MetricStrip record={record} />
      </div>

      {regularEntries.length > 0 ? (
        <div className="mt-4">
          <KeyValueTable entries={regularEntries} />
        </div>
      ) : null}

      {longTextEntries.length > 0 ? (
        <div className="mt-4 space-y-3">
          {longTextEntries.map(([key, value]) => (
            <div
              key={key}
              className="rounded-2xl border border-sky-100 bg-sky-50/70 p-4"
            >
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-800">
                {formatLabel(key)}
              </p>
              <div className="mt-3 text-sm leading-7 text-slate-700">
                <StructuredValue value={value} fieldKey={key} />
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RecordArraySection({
  sectionKey,
  rows,
}: {
  sectionKey: string;
  rows: Record<string, unknown>[];
}) {
  return (
    <section className="rounded-3xl border border-slate-200 bg-slate-50/70 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            {formatLabel(sectionKey)}
          </p>
          <p className="mt-1 text-sm text-slate-600">
            {rows.length} {rows.length === 1 ? "record" : "records"}
          </p>
        </div>
        <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700">
          Detailed table view
        </span>
      </div>

      <div className="mt-4">
        <SummaryTable rows={rows} title="Summary Table" />
      </div>

      <div className="mt-4 space-y-4">
        {rows.map((row, index) => (
          <RecordDetailsCard
            key={`${sectionKey}-${index}-${String(row.market_id ?? row.question ?? row.slug ?? index)}`}
            record={row}
            index={index}
          />
        ))}
      </div>
    </section>
  );
}

function StructuredSection({
  sectionKey,
  value,
}: {
  sectionKey: string;
  value: unknown;
}) {
  if (Array.isArray(value) && value.every((item) => isRecord(item))) {
    return <RecordArraySection sectionKey={sectionKey} rows={value as Record<string, unknown>[]} />;
  }

  return (
    <section className="rounded-3xl border border-slate-200 bg-slate-50/70 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
          {formatLabel(sectionKey)}
        </p>
        {Array.isArray(value) ? (
          <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700">
            {value.length} {value.length === 1 ? "item" : "items"}
          </span>
        ) : null}
      </div>
      <div className="mt-4">
        <StructuredValue value={value} fieldKey={sectionKey} />
      </div>
    </section>
  );
}

export function BullpenAutoRunStageOutputDialog({
  stageTitle,
  stageDetail,
  eyebrow = "Stage Output",
  outputs,
  outputLabel = "Outputs",
  onClose,
}: BullpenAutoRunStageOutputDialogProps) {
  const entries = Object.entries(outputs);
  const overviewEntries = orderEntries(
    entries.filter(([, value]) => {
      if (isPrimitive(value)) return true;
      return Array.isArray(value) && value.every((item) => isPrimitive(item));
    }),
  );
  const sectionEntries = entries.filter(([, value]) => {
    if (isPrimitive(value)) return false;
    return !(Array.isArray(value) && value.every((item) => isPrimitive(item)));
  });

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-slate-950/55 p-4">
      <div className="flex max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.45)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
              {eyebrow}
            </p>
            <h3 className="text-lg font-semibold text-slate-950">{stageTitle}</h3>
            <p className="max-w-3xl text-sm leading-6 text-slate-600">{stageDetail}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label={`Close ${eyebrow.toLowerCase()}`}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="overflow-y-auto px-6 py-5">
          <div className="space-y-4">
            {overviewEntries.length > 0 ? (
              <section className="rounded-3xl border border-slate-200 bg-slate-50/70 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    {outputLabel} Overview
                  </p>
                  <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700">
                    Key fields
                  </span>
                </div>
                <div className="mt-4">
                  <KeyValueTable entries={overviewEntries} />
                </div>
              </section>
            ) : null}

            {sectionEntries.map(([key, value]) => (
              <StructuredSection key={key} sectionKey={key} value={value} />
            ))}

            {entries.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center text-sm text-slate-500">
                No structured {outputLabel.toLowerCase()} were recorded for this stage.
              </div>
            ) : null}

            <details className="rounded-3xl border border-slate-200 bg-slate-50/70 p-4">
              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                Raw JSON
              </summary>
              <pre className="mt-4 overflow-x-auto whitespace-pre-wrap break-words rounded-2xl border border-slate-200 bg-white p-4 text-xs leading-6 text-slate-700">
                {renderJson(outputs)}
              </pre>
            </details>
          </div>
        </div>
      </div>
    </div>
  );
}
