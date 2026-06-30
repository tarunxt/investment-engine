"use client";

import { useState, type ComponentType, type ReactNode } from "react";
import { CheckCircle2, ExternalLink, X } from "lucide-react";

type BullpenAutoRunStageOutputDialogProps = {
  stageTitle: string;
  stageDetail: string;
  eyebrow?: string;
  outputs: Record<string, unknown>;
  alreadyInvestedRecords?: Array<{
    marketId: string;
    timestamp?: string | null;
    reason?: string | null;
    source?: string | null;
  }>;
  outputLabel?: string;
  onClose: () => void;
};

type Tone = "slate" | "sky" | "emerald" | "amber" | "rose";
type SummaryItem = {
  key: string;
  label: string;
  value: unknown;
};
type BreakdownDialogComponent = ComponentType<{
  question: Record<string, unknown>;
  onClose: () => void;
}>;
type ValueRationaleDialogState = {
  fieldKey: string;
  record: Record<string, unknown>;
};
type AlreadyInvestedRecord = {
  marketId: string;
  timestamp: string | null;
  reason: string | null;
  source: string | null;
};

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

const VALUE_RATIONALE_KEYS = new Set([
  "returns_per_day",
  "selected_side",
  "confidence",
  "evidence_status",
  "event_state",
  "adjudication_required",
]);
const STRONG_SIDE_THRESHOLD_PCT = 80;

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
  if (key === "fair_yes_probability_pct") return "LLM Yes %";
  if (key === "fair_no_probability_pct") return "LLM No %";
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

function formatPlainValue(value: unknown, key: string) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") return formatNumber(value, key);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? "item" : "items"}`;
  if (isRecord(value)) return `${Object.keys(value).length} fields`;
  return String(value);
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
  record = null,
  onOpenBreakdown,
  onOpenRationale,
}: {
  entries: [string, unknown][];
  nested?: boolean;
  record?: Record<string, unknown> | null;
  onOpenBreakdown?: (record: Record<string, unknown>) => void;
  onOpenRationale?: (record: Record<string, unknown>, fieldKey: string) => void;
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
                {renderRecordValue({
                  value,
                  key,
                  record,
                  depth: nested ? 2 : 1,
                  onOpenBreakdown,
                  onOpenRationale,
                })}
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

function readSummaryString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readSummaryBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return false;
}

function readNumberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readStringArrayValue(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function buildAlreadyInvestedLookup({
  explicitRecords = [],
  outputs,
}: {
  explicitRecords?: BullpenAutoRunStageOutputDialogProps["alreadyInvestedRecords"];
  outputs: Record<string, unknown>;
}) {
  const lookup = new Map<string, AlreadyInvestedRecord>();
  const appendRecord = (record: AlreadyInvestedRecord) => {
    if (!record.marketId) return;

    const existing = lookup.get(record.marketId);
    if (!existing) {
      lookup.set(record.marketId, record);
      return;
    }

    lookup.set(record.marketId, {
      marketId: record.marketId,
      timestamp: existing.timestamp ?? record.timestamp,
      reason: existing.reason ?? record.reason,
      source: existing.source ?? record.source,
    });
  };

  for (const record of explicitRecords) {
    const marketId = readSummaryString(record?.marketId);
    if (!marketId) continue;
    appendRecord({
      marketId,
      timestamp: readSummaryString(record?.timestamp),
      reason: readSummaryString(record?.reason),
      source: readSummaryString(record?.source),
    });
  }

  if (lookup.size > 0) {
    return lookup;
  }

  const serializedRecords = Array.isArray(outputs.already_invested_records)
    ? outputs.already_invested_records
    : [];
  for (const item of serializedRecords) {
    if (!isRecord(item)) continue;
    const marketId =
      readSummaryString(item.marketId) ?? readSummaryString(item.market_id);
    if (!marketId) continue;
    appendRecord({
      marketId,
      timestamp:
        readSummaryString(item.timestamp) ?? readSummaryString(item.invested_at),
      reason: readSummaryString(item.reason),
      source: readSummaryString(item.source),
    });
  }

  for (const marketId of readStringArrayValue(outputs.already_invested_market_ids)) {
    appendRecord({
      marketId,
      timestamp: null,
      reason: null,
      source: null,
    });
  }

  return lookup;
}

function isBreakdownProbabilityKey(key: string) {
  return key === "fair_yes_probability_pct" || key === "fair_no_probability_pct";
}

function canOpenLlmBreakdown(record: Record<string, unknown>) {
  const title = readSummaryString(record.question) ?? readSummaryString(record.market_title);
  if (!title) return false;
  return (
    Array.isArray(record.llm_outputs) ||
    readNumberValue(record.fair_yes_probability_pct) !== null ||
    readNumberValue(record.fair_no_probability_pct) !== null
  );
}

function buildStageOutputLlmBreakdown(record: Record<string, unknown>) {
  if (!Array.isArray(record.llm_outputs)) return [];

  return record.llm_outputs
    .map((item) => {
      if (!isRecord(item)) return null;
      return {
        provider: readSummaryString(item.provider) ?? "Unknown",
        model: readSummaryString(item.model) ?? "Unknown",
        jobId: null,
        runId: null,
        timestamp: readSummaryString(item.completed_at),
        llmYesOdds: readNumberValue(item.llm_yes_odds),
        llmNoOdds: readNumberValue(item.llm_no_odds),
        yesDefinition: readSummaryString(record.yes_definition),
        deadlineEt: readSummaryString(record.deadline_et),
        hoursRemaining: readNumberValue(record.hours_remaining),
        evidenceStatus:
          readSummaryString(item.evidence_status) ??
          readSummaryString(record.evidence_status),
        eventState:
          readSummaryString(item.event_state) ?? readSummaryString(record.event_state),
        confidence:
          readSummaryString(item.confidence) ?? readSummaryString(record.confidence),
        keyEvidence: readStringArrayValue(item.key_evidence),
        redFlags: readStringArrayValue(item.red_flags),
        rationale: readSummaryString(item.rationale),
        direction: null,
        rationaleOddsMismatch: false,
        rationaleOddsMismatchReason: null,
        effectiveWeight: null,
        webSearchUsed: null,
        webSearchQueries: [],
        webSources: [],
        internetVerified: null,
        evidenceBlockUsed: false,
        staleFactDetected: false,
        invalidReason: readSummaryString(item.error),
        invalidStaleFact: false,
        staleFactReason: null,
      };
    })
    .filter(Boolean) as Record<string, unknown>[];
}

function buildStageOutputBreakdownSeed(record: Record<string, unknown>) {
  const question = readSummaryString(record.question) ?? readSummaryString(record.market_title);
  const llmYesOdds = readNumberValue(record.fair_yes_probability_pct);
  const llmNoOdds = readNumberValue(record.fair_no_probability_pct);
  const llmBreakdown = buildStageOutputLlmBreakdown(record);
  const llmCompletedAt =
    [...llmBreakdown]
      .map((entry) => readSummaryString(entry.timestamp))
      .filter((timestamp): timestamp is string => Boolean(timestamp))
      .sort()
      .at(-1) ?? null;
  const singleBreakdown = llmBreakdown.length === 1 ? llmBreakdown[0] : null;

  if (!question || (llmYesOdds === null && llmNoOdds === null && llmBreakdown.length === 0)) {
    return null;
  }

  return {
    id:
      readSummaryString(record.position_key) ??
      readSummaryString(record.market_id) ??
      readSummaryString(record.slug) ??
      question,
    question,
    closeTime: readSummaryString(record.close_time),
    category:
      readSummaryString(record.theme) ??
      readSummaryString(record.source_kind) ??
      "Bullpen Auto-Run",
    yesOdds: readNumberValue(record.current_yes_odds),
    noOdds: readNumberValue(record.current_no_odds),
    currentOddsUpdatedAt: null,
    investmentTableAddedAt: null,
    volume: null,
    liquidity: null,
    sourceUrl: readSummaryString(record.market_url) ?? "",
    slug: readSummaryString(record.slug),
    marketUrl: readSummaryString(record.market_url),
    outcomeLabels: ["Yes", "No"],
    outcomeCount: 2,
    isBinaryYesNo: true,
    daysUntilClose: null,
    rules: null,
    marketContext: null,
    resolutionSource: null,
    llmYesOdds,
    llmNoOdds,
    llmDisagreementLevel: readSummaryString(record.disagreement_level),
    llmDisagreementCategory: readSummaryString(record.disagreement_category),
    llmRationaleMismatchCount: 0,
    adjudicationRequired: readSummaryBoolean(record.adjudication_required),
    evidenceStatus: readSummaryString(record.evidence_status),
    eventState: readSummaryString(record.event_state),
    llmNotes: null,
    llmProvider: readSummaryString(singleBreakdown?.provider),
    llmModel: readSummaryString(singleBreakdown?.model),
    llmRunId: null,
    llmCompletedAt,
    preflightEvidenceBlock: null,
    llmBreakdown,
  };
}

function isRationaleFieldKey(key: string) {
  return VALUE_RATIONALE_KEYS.has(key);
}

function getStageOutputRecordTitle(record: Record<string, unknown>) {
  return (
    readSummaryString(record.question) ??
    readSummaryString(record.market_title) ??
    readSummaryString(record.market_id) ??
    readSummaryString(record.slug) ??
    readSummaryString(record.position_key) ??
    "This row"
  );
}

function formatEnumLabel(value: string | null | undefined) {
  if (!value) return "—";
  return value
    .split(/[_\s]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getEventStateDescription(value: string | null | undefined) {
  switch ((value ?? "").toLowerCase()) {
    case "already_occurred":
      return "The review concluded that the underlying real-world event has already happened.";
    case "scheduled_not_occurred":
      return "The review concluded that the event is scheduled or expected, but has not happened yet.";
    case "preparatory_only":
      return "The signals pointed to setup or pre-event activity only, not the final event itself yet.";
    case "rumour_only":
    case "rumor_only":
      return "The evidence looked rumor-based or weakly sourced rather than confirmed.";
    case "no_confirmed_event":
      return "The review did not find enough reliable evidence that a qualifying event is actually confirmed.";
    case "conflicting":
      return "Different evidence or model outputs pointed to materially different event states, so the row stayed conflicting.";
    default:
      return value ? `${formatEnumLabel(value)} was the consensus event-state label for this row.` : null;
  }
}

function getConfidenceDescription(value: string | null | undefined) {
  switch ((value ?? "").toLowerCase()) {
    case "high":
      return "High means the per-model review leaned strongly in one direction after normalization and consensus.";
    case "medium":
      return "Medium means the review had usable conviction, but not enough to be treated as the strongest confidence bucket.";
    case "low":
      return "Low means the review stayed cautious, mixed, or weak after normalization and consensus.";
    default:
      return value ? `${formatEnumLabel(value)} was the consensus confidence label for this row.` : null;
  }
}

function getEvidenceStatusDescription(value: string | null | undefined) {
  switch ((value ?? "").toLowerCase()) {
    case "strong":
      return "Strong means the underlying evidence looked verified, confirmed, or otherwise materially supportive.";
    case "moderate":
    case "medium":
      return "Moderate means the evidence looked partial, mixed, or not fully conclusive.";
    case "low":
      return "Low means the evidence looked weak, incomplete, unverified, or not strong enough to clear higher buckets.";
    default:
      return value ? `${formatEnumLabel(value)} was the consensus evidence-strength label for this row.` : null;
  }
}

function buildValueRationale(record: Record<string, unknown>, fieldKey: string) {
  const stageReason = readSummaryString(record.reason);
  const rulesFailReason = readSummaryString(record.rules_fail_reason);
  const sourceKind = readSummaryString(record.source_kind);
  const closeTime = readSummaryString(record.close_time);
  const selectedSide = readSummaryString(record.selected_side);
  const confidence = readSummaryString(record.confidence);
  const evidenceStatus = readSummaryString(record.evidence_status);
  const eventState = readSummaryString(record.event_state);
  const disagreementLevel = readSummaryString(record.disagreement_level);
  const disagreementCategory = readSummaryString(record.disagreement_category);
  const fairYes = readNumberValue(record.fair_yes_probability_pct);
  const fairNo = readNumberValue(record.fair_no_probability_pct);
  const llmOutputs = Array.isArray(record.llm_outputs)
    ? record.llm_outputs.filter((item) => isRecord(item))
    : [];
  const hasAdjudicationValue =
    typeof record.adjudication_required === "boolean" ||
    typeof record.adjudication_required === "string";
  const adjudicationRequired = hasAdjudicationValue
    ? readSummaryBoolean(record.adjudication_required)
    : null;

  let summary = "This value was carried forward from the previous Bullpen review stage.";
  const supportingPoints: string[] = [];

  if (sourceKind) {
    supportingPoints.push(`Row type: ${formatEnumLabel(sourceKind)}.`);
  }

  switch (fieldKey) {
    case "returns_per_day":
      summary =
        readNumberValue(record.returns_per_day) === null
          ? "Returns Per Day is blank because the row did not have enough usable market timing/pricing data to carry a time-normalized ranking value into Invest."
          : "Returns Per Day is shown because this row had enough usable market data to carry a time-normalized ranking value into Invest. Stage 3 uses that value to compare rows on the same per-day basis.";
      if (closeTime) {
        supportingPoints.push(`Close time was available for ranking: ${closeTime}.`);
      }
      if (selectedSide) {
        supportingPoints.push(`The current stronger side on this row is ${selectedSide}.`);
      }
      break;
    case "selected_side":
      summary = selectedSide
        ? `Selected Side is ${selectedSide} because that side had the stronger LLM fair probability. Bullpen only treats a side as selected once the stronger side clears the ${STRONG_SIDE_THRESHOLD_PCT}% threshold.`
        : `Selected Side is blank because neither side cleared the ${STRONG_SIDE_THRESHOLD_PCT}% strong-side threshold, or the fair probabilities were unavailable.`;
      if (fairYes !== null || fairNo !== null) {
        supportingPoints.push(
          `LLM fair odds on this row were Yes ${formatPlainValue(fairYes, "fair_yes_probability_pct")} and No ${formatPlainValue(fairNo, "fair_no_probability_pct")}.`,
        );
      }
      break;
    case "confidence":
      summary = confidence
        ? `Confidence is shown as ${confidence} because the per-model LLM outputs are normalized into Low / Medium / High buckets and then collapsed into one consensus label for the row.`
        : "Confidence is blank because the LLM review did not produce a usable consensus confidence label for this row.";
      {
        const confidenceDescription = getConfidenceDescription(confidence);
        if (confidenceDescription) {
          supportingPoints.push(confidenceDescription);
        }
      }
      if (llmOutputs.length > 0) {
        supportingPoints.push(
          `${llmOutputs.length} LLM output${llmOutputs.length === 1 ? "" : "s"} contributed to the consensus shown here.`,
        );
      }
      break;
    case "evidence_status":
      summary = evidenceStatus
        ? `Evidence Status is shown as ${evidenceStatus} because the LLM review converts per-model evidence labels into Low / Moderate / Strong and then chooses a consensus label for the row.`
        : "Evidence Status is blank because the LLM review did not produce a usable evidence-strength label for this row.";
      {
        const evidenceDescription = getEvidenceStatusDescription(evidenceStatus);
        if (evidenceDescription) {
          supportingPoints.push(evidenceDescription);
        }
      }
      if (llmOutputs.length > 0) {
        supportingPoints.push(
          `${llmOutputs.length} LLM output${llmOutputs.length === 1 ? "" : "s"} were available when building this evidence-status label.`,
        );
      }
      break;
    case "event_state":
      summary = eventState
        ? `Event State is shown as ${eventState} because the LLM review assigns a consensus label for the underlying event lifecycle before the row moves into Invest.`
        : "Event State is blank because the LLM review did not settle on a usable event-state label for this row.";
      {
        const eventStateDescription = getEventStateDescription(eventState);
        if (eventStateDescription) {
          supportingPoints.push(eventStateDescription);
        }
      }
      break;
    case "adjudication_required":
      summary =
        adjudicationRequired === null
          ? "Adjudication Required is blank because this row did not carry a manual-review flag."
          : adjudicationRequired
            ? "Adjudication Required is Yes because the consensus was flagged for manual review before being treated as clean conviction."
            : "Adjudication Required is No because the consensus did not hit the manual-review / high-disagreement threshold.";
      if (disagreementLevel) {
        supportingPoints.push(`LLM disagreement level: ${disagreementLevel}.`);
      }
      if (disagreementCategory) {
        supportingPoints.push(`Consensus signal: ${formatEnumLabel(disagreementCategory)}.`);
      }
      break;
    default:
      break;
  }

  if (stageReason) {
    supportingPoints.push(`Stage note: ${stageReason}`);
  }
  if (rulesFailReason) {
    supportingPoints.push(`Rules note: ${rulesFailReason}`);
  }

  return { summary, supportingPoints };
}

function ValueRationaleDialog({
  state,
  onClose,
}: {
  state: ValueRationaleDialogState;
  onClose: () => void;
}) {
  const { fieldKey, record } = state;
  const title = getStageOutputRecordTitle(record);
  const fieldLabel = formatLabel(fieldKey);
  const { summary, supportingPoints } = buildValueRationale(record, fieldKey);

  return (
    <div className="fixed inset-0 z-[140] flex items-center justify-center bg-slate-950/40 p-4">
      <div className="w-full max-w-2xl overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_24px_70px_-24px_rgba(15,23,42,0.45)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
              Value Rationale
            </p>
            <h3 className="text-lg font-semibold text-slate-950">{fieldLabel}</h3>
            <p className="text-sm text-slate-600">{title}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label={`Close ${fieldLabel.toLowerCase()} rationale`}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-5 px-6 py-5">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Current Value
            </p>
            <div className="mt-2 text-sm font-semibold text-slate-900">
              <StructuredValue value={record[fieldKey]} fieldKey={fieldKey} />
            </div>
          </div>

          <div className="rounded-2xl border border-sky-100 bg-sky-50/70 px-4 py-4 text-sm leading-6 text-slate-700">
            {summary}
          </div>

          {supportingPoints.length > 0 ? (
            <div>
              <h4 className="text-sm font-semibold text-slate-950">Supporting context</h4>
              <ul className="mt-2 list-disc space-y-2 pl-5 text-sm leading-6 text-slate-700">
                {supportingPoints.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function renderRecordValue({
  value,
  key,
  record,
  compact = false,
  depth = 1,
  onOpenBreakdown,
  onOpenRationale,
}: {
  value: unknown;
  key: string;
  record?: Record<string, unknown> | null;
  compact?: boolean;
  depth?: number;
  onOpenBreakdown?: (record: Record<string, unknown>) => void;
  onOpenRationale?: (record: Record<string, unknown>, fieldKey: string) => void;
}) {
  const baseValue = compact ? (
    renderCompactValue(value, key)
  ) : (
    <StructuredValue value={value} fieldKey={key} depth={depth} />
  );

  if (
    record &&
    onOpenBreakdown &&
    isBreakdownProbabilityKey(key) &&
    value !== null &&
    value !== undefined &&
    canOpenLlmBreakdown(record)
  ) {
    return (
      <button
        type="button"
        onClick={() => onOpenBreakdown(record)}
        className="inline-flex items-center rounded-md underline decoration-sky-300 underline-offset-4 transition hover:text-sky-700"
        title="Open LLM odds breakdown"
        aria-label={`Open LLM odds breakdown for ${formatLabel(key)}`}
      >
        {baseValue}
      </button>
    );
  }

  if (record && onOpenRationale && isRationaleFieldKey(key)) {
    return (
      <button
        type="button"
        onClick={() => onOpenRationale(record, key)}
        className="inline-flex items-center rounded-md underline decoration-slate-300 underline-offset-4 transition hover:text-sky-700"
        title={`Open rationale for ${formatLabel(key)}`}
        aria-label={`Open rationale for ${formatLabel(key)}`}
      >
        {baseValue}
      </button>
    );
  }

  return baseValue;
}

function buildStageOutputEyebrow(stageTitle: string) {
  const stageMatch = stageTitle.match(/(Stage\s+\d+)/i);
  return stageMatch ? `${stageMatch[1]} Output` : "Stage Output";
}

function appendSummaryItem(
  items: SummaryItem[],
  nextItem: SummaryItem,
  seenKeys: Set<string>,
) {
  if (seenKeys.has(nextItem.key)) return;
  seenKeys.add(nextItem.key);
  items.push(nextItem);
}

function buildArraySummaryItems(sectionKey: string, rows: Record<string, unknown>[]) {
  const items: SummaryItem[] = [
    {
      key: `${sectionKey}_count`,
      label: `${formatLabel(sectionKey)} Count`,
      value: rows.length,
    },
  ];
  const sourceKindCounts = new Map<string, number>();
  const themes = new Set<string>();
  let forceIncludedCount = 0;
  let selectedCount = 0;
  let linkedMarketsCount = 0;
  let adjudicationRequiredCount = 0;

  for (const row of rows) {
    const sourceKind = readSummaryString(row.source_kind);
    if (sourceKind) {
      sourceKindCounts.set(sourceKind, (sourceKindCounts.get(sourceKind) ?? 0) + 1);
    }

    const theme = readSummaryString(row.theme);
    if (theme) {
      themes.add(theme);
    }

    if (readSummaryBoolean(row.force_include)) {
      forceIncludedCount += 1;
    }
    if (readSummaryBoolean(row.selected)) {
      selectedCount += 1;
    }
    if (readSummaryString(row.market_url)) {
      linkedMarketsCount += 1;
    }
    if (readSummaryBoolean(row.adjudication_required)) {
      adjudicationRequiredCount += 1;
    }
  }

  const activePositionCount = sourceKindCounts.get("active_position") ?? 0;
  if (activePositionCount > 0) {
    items.push({
      key: `${sectionKey}_active_positions`,
      label: "Active Position Rows",
      value: activePositionCount,
    });
  }

  const candidateCount = sourceKindCounts.get("candidate") ?? 0;
  if (candidateCount > 0) {
    items.push({
      key: `${sectionKey}_candidate_rows`,
      label: "Candidate Rows",
      value: candidateCount,
    });
  }

  if (themes.size > 0) {
    items.push({
      key: `${sectionKey}_themes`,
      label: "Unique Themes",
      value: themes.size,
    });
  }

  if (forceIncludedCount > 0) {
    items.push({
      key: `${sectionKey}_force_included`,
      label: "Force Included",
      value: forceIncludedCount,
    });
  }

  if (selectedCount > 0) {
    items.push({
      key: `${sectionKey}_selected_rows`,
      label: "Selected Rows",
      value: selectedCount,
    });
  }

  if (linkedMarketsCount > 0) {
    items.push({
      key: `${sectionKey}_market_links`,
      label: "Market Links",
      value: linkedMarketsCount,
    });
  }

  if (adjudicationRequiredCount > 0) {
    items.push({
      key: `${sectionKey}_adjudication_required`,
      label: "Adjudication Required",
      value: adjudicationRequiredCount,
    });
  }

  return items;
}

function buildInputSummaryItems(outputs: Record<string, unknown>) {
  const items: SummaryItem[] = [];
  const seenKeys = new Set<string>();

  for (const [key, value] of Object.entries(outputs)) {
    if (Array.isArray(value) && value.every((item) => isRecord(item))) {
      for (const item of buildArraySummaryItems(key, value as Record<string, unknown>[])) {
        appendSummaryItem(items, item, seenKeys);
      }
      continue;
    }

    if (
      isPrimitive(value) &&
      (key.endsWith("_count") ||
        key.endsWith("_rows") ||
        key.startsWith("total_") ||
        key.includes("candidate") ||
        key.includes("position"))
    ) {
      appendSummaryItem(
        items,
        {
          key,
          label: formatLabel(key),
          value,
        },
        seenKeys,
      );
    }
  }

  return items.slice(0, 8);
}

function InvestedPill({ record }: { record: AlreadyInvestedRecord }) {
  return (
    <div className="space-y-2">
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-100 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-900">
        <CheckCircle2 className="h-3.5 w-3.5" />
        Invested
      </span>
      {record.timestamp ? (
        <p className="font-mono text-[11px] text-emerald-900">{record.timestamp}</p>
      ) : null}
    </div>
  );
}

function SummaryTable({
  rows,
  title,
  alreadyInvestedLookup,
  onOpenBreakdown,
  onOpenRationale,
}: {
  rows: Record<string, unknown>[];
  title: string;
  alreadyInvestedLookup?: Map<string, AlreadyInvestedRecord>;
  onOpenBreakdown: (record: Record<string, unknown>) => void;
  onOpenRationale: (record: Record<string, unknown>, fieldKey: string) => void;
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
            {rows.map((row, index) => {
              const marketId = readSummaryString(row.market_id);
              const alreadyInvestedRecord =
                marketId ? alreadyInvestedLookup?.get(marketId) ?? null : null;
              const alreadyInvested = Boolean(alreadyInvestedRecord);

              return (
                <tr
                  key={index}
                  className={`align-top ${
                    alreadyInvested
                      ? "bg-emerald-50/80 hover:bg-emerald-100/60"
                      : "hover:bg-slate-50/80"
                  }`}
                >
                  {columns.map((column, columnIndex) => (
                    <td key={`${index}-${column}`} className="px-4 py-3">
                      {alreadyInvestedRecord && columnIndex === 0 ? (
                        <div className="space-y-2">
                          <InvestedPill record={alreadyInvestedRecord} />
                          {renderRecordValue({
                            value: row[column],
                            key: column,
                            record: row,
                            compact: true,
                            onOpenBreakdown,
                            onOpenRationale,
                          })}
                        </div>
                      ) : (
                        renderRecordValue({
                          value: row[column],
                          key: column,
                          record: row,
                          compact: true,
                          onOpenBreakdown,
                          onOpenRationale,
                        })
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SummaryCards({
  items,
  title,
}: {
  items: SummaryItem[];
  title: string;
}) {
  if (items.length === 0) return null;

  return (
    <section className="rounded-3xl border border-slate-200 bg-sky-50/50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
          {title}
        </p>
        <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700">
          Quick read
        </span>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {items.map((item) => (
          <div
            key={item.key}
            className="rounded-2xl border border-slate-200 bg-white px-3 py-3 shadow-sm"
          >
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
              {item.label}
            </p>
            <div className="mt-2 text-sm font-semibold text-slate-900">
              <StructuredValue value={item.value} fieldKey={item.key} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function MetricStrip({
  record,
  onOpenBreakdown,
  onOpenRationale,
}: {
  record: Record<string, unknown>;
  onOpenBreakdown: (record: Record<string, unknown>) => void;
  onOpenRationale: (record: Record<string, unknown>, fieldKey: string) => void;
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
            {renderRecordValue({
              value: record[key],
              key,
              record,
              onOpenBreakdown,
              onOpenRationale,
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function RecordDetailsCard({
  record,
  index,
  alreadyInvestedRecord,
  onOpenBreakdown,
  onOpenRationale,
}: {
  record: Record<string, unknown>;
  index: number;
  alreadyInvestedRecord?: AlreadyInvestedRecord | null;
  onOpenBreakdown: (record: Record<string, unknown>) => void;
  onOpenRationale: (record: Record<string, unknown>, fieldKey: string) => void;
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
            {alreadyInvestedRecord ? (
              <InvestedPill record={alreadyInvestedRecord} />
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
        <MetricStrip
          record={record}
          onOpenBreakdown={onOpenBreakdown}
          onOpenRationale={onOpenRationale}
        />
      </div>

      {regularEntries.length > 0 ? (
        <div className="mt-4">
          <KeyValueTable
            entries={regularEntries}
            record={record}
            onOpenBreakdown={onOpenBreakdown}
            onOpenRationale={onOpenRationale}
          />
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
  alreadyInvestedLookup,
  onOpenBreakdown,
  onOpenRationale,
}: {
  sectionKey: string;
  rows: Record<string, unknown>[];
  alreadyInvestedLookup?: Map<string, AlreadyInvestedRecord>;
  onOpenBreakdown: (record: Record<string, unknown>) => void;
  onOpenRationale: (record: Record<string, unknown>, fieldKey: string) => void;
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
        <SummaryTable
          rows={rows}
          title="Summary Table"
          alreadyInvestedLookup={alreadyInvestedLookup}
          onOpenBreakdown={onOpenBreakdown}
          onOpenRationale={onOpenRationale}
        />
      </div>

      <div className="mt-4 space-y-4">
        {rows.map((row, index) => {
          const marketId = readSummaryString(row.market_id);
          return (
            <RecordDetailsCard
              key={`${sectionKey}-${index}-${String(row.market_id ?? row.question ?? row.slug ?? index)}`}
              record={row}
              index={index}
              alreadyInvestedRecord={
                marketId ? alreadyInvestedLookup?.get(marketId) ?? null : null
              }
              onOpenBreakdown={onOpenBreakdown}
              onOpenRationale={onOpenRationale}
            />
          );
        })}
      </div>
    </section>
  );
}

function StructuredSection({
  sectionKey,
  value,
  alreadyInvestedLookup,
  onOpenBreakdown,
  onOpenRationale,
}: {
  sectionKey: string;
  value: unknown;
  alreadyInvestedLookup?: Map<string, AlreadyInvestedRecord>;
  onOpenBreakdown: (record: Record<string, unknown>) => void;
  onOpenRationale: (record: Record<string, unknown>, fieldKey: string) => void;
}) {
  if (Array.isArray(value) && value.every((item) => isRecord(item))) {
    return (
      <RecordArraySection
        sectionKey={sectionKey}
        rows={value as Record<string, unknown>[]}
        alreadyInvestedLookup={alreadyInvestedLookup}
        onOpenBreakdown={onOpenBreakdown}
        onOpenRationale={onOpenRationale}
      />
    );
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
  eyebrow,
  outputs,
  alreadyInvestedRecords = [],
  outputLabel = "Outputs",
  onClose,
}: BullpenAutoRunStageOutputDialogProps) {
  const [breakdownDialogState, setBreakdownDialogState] =
    useState<{ Component: BreakdownDialogComponent } | null>(null);
  const [breakdownQuestion, setBreakdownQuestion] =
    useState<Record<string, unknown> | null>(null);
  const [valueRationaleDialog, setValueRationaleDialog] =
    useState<ValueRationaleDialogState | null>(null);
  const alreadyInvestedLookup = buildAlreadyInvestedLookup({
    explicitRecords: alreadyInvestedRecords,
    outputs,
  });
  const visibleOutputs = Object.fromEntries(
    Object.entries(outputs).filter(
      ([key]) => key !== "already_invested_market_ids" && key !== "already_invested_records",
    ),
  );
  const entries = Object.entries(visibleOutputs);
  const baseInputSummaryItems =
    outputLabel === "Inputs" ? buildInputSummaryItems(visibleOutputs) : [];
  const inputSummaryItems =
    outputLabel === "Inputs" && alreadyInvestedLookup.size > 0
      ? [
          ...baseInputSummaryItems,
          {
            key: "already_invested_count",
            label: "Invested",
            value: alreadyInvestedLookup.size,
          },
        ].slice(0, 8)
      : baseInputSummaryItems;
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
  const resolvedEyebrow = eyebrow ?? buildStageOutputEyebrow(stageTitle);

  const handleOpenBreakdown = async (record: Record<string, unknown>) => {
    const seed = buildStageOutputBreakdownSeed(record);
    if (!seed) return;

    const [{ createBullpenQuestionRow }, { BullpenLlmBreakdownDialog }] =
      await Promise.all([
        import("@/lib/bullpen-ai"),
        import("./BullpenLlmBreakdownDialog"),
      ]);

    setBreakdownDialogState({
      Component: BullpenLlmBreakdownDialog as BreakdownDialogComponent,
    });
    setBreakdownQuestion(createBullpenQuestionRow(seed) as Record<string, unknown>);
  };
  const BreakdownDialog = breakdownDialogState?.Component ?? null;

  return (
    <>
      <div className="fixed inset-0 z-[130] flex items-center justify-center bg-slate-950/55 p-4">
        <div className="flex max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.45)]">
          <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                {resolvedEyebrow}
              </p>
              <h3 className="text-lg font-semibold text-slate-950">{stageTitle}</h3>
              <p className="max-w-3xl text-sm leading-6 text-slate-600">{stageDetail}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
              aria-label={`Close ${resolvedEyebrow.toLowerCase()}`}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="overflow-y-auto px-6 py-5">
            <div className="space-y-4">
              {inputSummaryItems.length > 0 ? (
                <SummaryCards items={inputSummaryItems} title="Input Summary" />
              ) : null}

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
                <StructuredSection
                  key={key}
                  sectionKey={key}
                  value={value}
                  alreadyInvestedLookup={alreadyInvestedLookup}
                  onOpenBreakdown={handleOpenBreakdown}
                  onOpenRationale={(record, fieldKey) =>
                    setValueRationaleDialog({ record, fieldKey })
                  }
                />
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
                  {renderJson(visibleOutputs)}
                </pre>
              </details>
            </div>
          </div>
        </div>
      </div>
      {BreakdownDialog && breakdownQuestion ? (
        <BreakdownDialog
          question={breakdownQuestion}
          onClose={() => setBreakdownQuestion(null)}
        />
      ) : null}
      {valueRationaleDialog ? (
        <ValueRationaleDialog
          state={valueRationaleDialog}
          onClose={() => setValueRationaleDialog(null)}
        />
      ) : null}
    </>
  );
}
