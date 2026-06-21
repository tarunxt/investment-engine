"use client";

import { Fragment, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  MinusCircle,
  XCircle,
} from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type {
  BullpenAutoLiveDecision,
  BullpenAutoLiveSummaryResponse,
} from "@/types/api";

import {
  AUTO_LIVE_TIMELINE_LABELS,
  buildAutoLiveDecisionRows,
  buildAutoLiveRunSummary,
  filterAutoLiveDecisionRows,
  getAutoLiveFilterLabel,
  getAutoLiveSortLabel,
  sortAutoLiveDecisionRows,
  type AutoLiveDecisionFilterKey,
  type AutoLiveDecisionRowView,
  type AutoLiveDecisionSectionValue,
  type AutoLiveDecisionSortKey,
  type AutoLiveDecisionStatusLabel,
  type AutoLiveTimelineStage,
} from "./bullpenAiAutoLivePresentation";

const FILTER_KEYS: AutoLiveDecisionFilterKey[] = [
  "all",
  "buy-add",
  "hold",
  "trim-exit",
  "skipped",
  "blocked",
  "executed",
  "high-disagreement",
  "low-evidence",
  "deadline-risk",
];

const SORT_KEYS: AutoLiveDecisionSortKey[] = [
  "highest-edge",
  "highest-score",
  "largest-exposure",
  "nearest-deadline",
  "latest-updated",
];

function formatMoney(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  return `${value.toFixed(1)}%`;
}

function formatPriceCents(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  return `${value.toFixed(1)}c`;
}

function formatEdge(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  return `${value.toFixed(1)}pp`;
}

function formatScore(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  return value.toFixed(2);
}

function formatHours(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  return `${value.toFixed(1)}h`;
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function labelize(value: string) {
  return value.replace(/[_-]/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function renderJson(value: unknown) {
  if (
    value === null ||
    value === undefined ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" && value !== null && Object.keys(value).length === 0)
  ) {
    return "-";
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function getDecisionBadgeClass(decision: BullpenAutoLiveDecision["decision"]) {
  switch (decision) {
    case "BUY_NEW":
    case "ADD_MORE":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "TRIM":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "EXIT":
      return "border-rose-200 bg-rose-50 text-rose-700";
    case "SKIP":
      return "border-slate-200 bg-slate-100 text-slate-600";
    case "HOLD":
    default:
      return "border-slate-200 bg-white text-slate-700";
  }
}

function getStatusBadgeClass(statusLabel: AutoLiveDecisionStatusLabel) {
  switch (statusLabel) {
    case "EXECUTED":
      return "border-emerald-200 bg-emerald-600 text-white";
    case "BLOCKED":
      return "border-rose-200 bg-rose-50 text-rose-700";
    case "DRY-RUN":
      return "border-slate-200 bg-slate-100 text-slate-700";
    case "SKIP":
    default:
      return "border-slate-200 bg-white text-slate-600";
  }
}

function getStageStatusClass(status: AutoLiveTimelineStage["status"]) {
  switch (status) {
    case "pass":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "fail":
      return "border-rose-200 bg-rose-50 text-rose-700";
    case "warning":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "skipped":
    default:
      return "border-slate-200 bg-slate-100 text-slate-700";
  }
}

function getStageIconElement(status: AutoLiveTimelineStage["status"]) {
  if (status === "pass") return <CheckCircle2 className="size-4" />;
  if (status === "fail") return <XCircle className="size-4" />;
  if (status === "warning") return <AlertTriangle className="size-4" />;
  return <MinusCircle className="size-4" />;
}

function formatSectionValue(label: string, value: AutoLiveDecisionSectionValue["value"]) {
  if (value === null || value === undefined || value === "") {
    return <span className="text-slate-400">-</span>;
  }

  if (Array.isArray(value)) {
    return (
      <ul className="space-y-1">
        {value.map((item, index) => (
          <li className="flex gap-2" key={`${label}-${index}`}>
            <span className="mt-1 size-1.5 rounded-full bg-slate-300" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    );
  }

  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }

  if (typeof value === "number") {
    const normalizedLabel = label.toLowerCase();
    if (normalizedLabel.includes("hours")) return formatHours(value);
    if (normalizedLabel.includes("limit price")) return formatPriceCents(value);
    if (normalizedLabel.includes("slippage")) return formatPriceCents(value);
    if (normalizedLabel.includes("bankroll")) return formatMoney(value);
    if (normalizedLabel.includes("exposure")) return formatMoney(value);
    if (normalizedLabel.includes("order")) return formatMoney(value);
    if (normalizedLabel.includes("edge")) return formatEdge(value);
    if (normalizedLabel.includes("score")) return formatScore(value);
    if (normalizedLabel.includes("yes")) return formatPercent(value);
    if (normalizedLabel.includes("spread")) return formatEdge(value);
    return value.toFixed(2);
  }

  return value;
}

function SummaryMetric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white px-4 py-4 shadow-sm">
      <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">
        {label}
      </p>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">{value}</p>
      {detail ? <p className="mt-2 text-sm text-slate-600">{detail}</p> : null}
    </div>
  );
}

function SectionCard({
  title,
  values,
}: {
  title: string;
  values: AutoLiveDecisionSectionValue[];
}) {
  return (
    <section className="rounded-[28px] border border-slate-200 bg-white p-4 shadow-sm">
      <h4 className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-900">
        {title}
      </h4>
      <dl className="mt-4 space-y-4">
        {values.map((item) => (
          <div
            className="border-b border-slate-100 pb-3 last:border-b-0 last:pb-0"
            key={`${title}-${item.label}`}
          >
            <dt className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              {item.label}
            </dt>
            <dd className="mt-2 text-sm leading-6 text-slate-700">
              {formatSectionValue(item.label, item.value)}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function TimelineStageCard({ stage, isLast }: { stage: AutoLiveTimelineStage; isLast: boolean }) {
  return (
    <div className="relative pl-9">
      {!isLast ? (
        <span className="absolute left-[13px] top-7 h-[calc(100%-0.25rem)] w-px bg-slate-200" />
      ) : null}
      <span
        className={cn(
          "absolute left-0 top-0 flex size-7 items-center justify-center rounded-full border",
          getStageStatusClass(stage.status),
        )}
      >
        {getStageIconElement(stage.status)}
      </span>
      <details className="rounded-3xl border border-slate-200 bg-white px-4 py-4 shadow-sm">
        <summary className="cursor-pointer list-none">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                Stage {stage.stageNumber}
              </p>
              <h5 className="mt-1 text-sm font-semibold text-slate-950">{stage.label}</h5>
              <p className="mt-2 text-sm leading-6 text-slate-600">{stage.reason}</p>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <span
                className={cn(
                  "rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]",
                  getStageStatusClass(stage.status),
                )}
              >
                {stage.status}
              </span>
              {stage.hardBlock ? (
                <span className="rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-rose-700">
                  Hard block
                </span>
              ) : null}
            </div>
          </div>
        </summary>

        {stage.guardrailsChecked.length > 0 ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {stage.guardrailsChecked.map((check) => (
              <span
                className={cn(
                  "rounded-full border px-2.5 py-1 text-[11px] font-medium",
                  getStageStatusClass(check.status === "watch" ? "warning" : check.status),
                )}
                key={`${stage.stageNumber}-${check.id}`}
              >
                {check.label}
              </span>
            ))}
          </div>
        ) : null}

        <div className="mt-4 grid gap-3">
          <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Inputs
            </p>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-xs leading-5 text-slate-700">
              {renderJson(stage.inputs)}
            </pre>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Outputs
            </p>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-xs leading-5 text-slate-700">
              {renderJson(stage.outputs)}
            </pre>
          </div>
        </div>
      </details>
    </div>
  );
}

function ExpandedDecisionRow({
  row,
}: {
  row: AutoLiveDecisionRowView;
}) {
  const marketUrl = row.decision.market_url;

  return (
    <div className="grid gap-4 bg-[linear-gradient(180deg,_rgba(248,250,252,0.78),_rgba(255,255,255,0.92))] px-4 py-5 xl:grid-cols-[minmax(0,1.45fr)_360px]">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          {marketUrl ? (
            <a
              className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              href={marketUrl}
              rel="noreferrer"
              target="_blank"
            >
              Open market
              <ExternalLink className="size-4" />
            </a>
          ) : null}
          <span className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600">
            Theme: {row.decision.theme}
          </span>
          <span className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600">
            Side: {row.decision.side}
          </span>
          {row.decision.slug ? (
            <span className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600">
              {row.decision.slug}
            </span>
          ) : null}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <SectionCard title="1. Market Rules" values={row.marketRules.values} />
          <SectionCard title="2. Evidence" values={row.evidence.values} />
          <SectionCard title="3. LLM Consensus" values={row.llmConsensus.values} />
          <SectionCard title="4. Score Calculation" values={row.scoreCalculation.values} />
          <SectionCard title="5. Sizing Calculation" values={row.sizingCalculation.values} />
          <SectionCard title="6. Rebalance Decision" values={row.rebalanceDecision.values} />
          <div className="md:col-span-2">
            <SectionCard title="7. Execution / Pre-trade" values={row.execution.values} />
          </div>
        </div>
      </div>

      <aside className="rounded-[28px] border border-slate-200 bg-slate-50/80 p-4 shadow-sm">
        <div className="border-b border-slate-200 pb-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">
            7-stage timeline
          </p>
          <h4 className="mt-2 text-lg font-semibold text-slate-950">Decision audit trail</h4>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Each stage shows the persisted pass, fail, warning, or skipped state with its reason and details.
          </p>
        </div>
        <div className="mt-4 space-y-4">
          {row.timeline.map((stage, index) => (
            <TimelineStageCard
              isLast={index === row.timeline.length - 1}
              key={`${row.id}-stage-${AUTO_LIVE_TIMELINE_LABELS[index]}`}
              stage={stage}
            />
          ))}
        </div>
      </aside>
    </div>
  );
}

export function BullpenAiAutoLiveDecisionsPanel({
  summary,
}: {
  summary: BullpenAutoLiveSummaryResponse | null;
}) {
  const [filterKey, setFilterKey] = useState<AutoLiveDecisionFilterKey>("all");
  const [sortKey, setSortKey] = useState<AutoLiveDecisionSortKey>("highest-score");
  const [openRowIds, setOpenRowIds] = useState<string[]>([]);

  const latestRun = summary?.latest_run ?? summary?.recent_runs?.[0] ?? null;
  const latestRunDecisions = (summary?.recent_decisions ?? []).filter(
    (decision) => decision.run_id === latestRun?.id,
  );
  const rowViews = buildAutoLiveDecisionRows({
    decisions: latestRunDecisions,
    settings: summary?.settings ?? null,
    state: summary?.state ?? null,
  });
  const filteredRows = filterAutoLiveDecisionRows(rowViews, filterKey);
  const visibleRows = sortAutoLiveDecisionRows(filteredRows, sortKey);
  const runSummary = buildAutoLiveRunSummary({
    decisions: latestRunDecisions,
    run: latestRun,
    settings: summary?.settings ?? null,
  });
  const visibleRowIds = new Set(visibleRows.map((row) => row.id));
  const visibleOpenRowIds = openRowIds.filter((id) => visibleRowIds.has(id));
  const effectiveOpenRowIds =
    visibleOpenRowIds.length > 0
      ? visibleOpenRowIds
      : visibleRows.length > 0
        ? [visibleRows[0].id]
        : [];

  function toggleRow(rowId: string) {
    setOpenRowIds((currentIds) =>
      currentIds.includes(rowId)
        ? currentIds.filter((id) => id !== rowId)
        : [...currentIds, rowId],
    );
  }

  const maxThemeExposureLabel = runSummary.maxThemeExposureUsed.theme
    ? `${runSummary.maxThemeExposureUsed.theme} ${formatPercent(runSummary.maxThemeExposureUsed.pctBankroll)}`
    : "-";
  const maxThemeExposureDetail = runSummary.maxThemeExposureUsed.theme
    ? formatMoney(runSummary.maxThemeExposureUsed.exposureUsd)
    : "No theme target exposure was recorded in this run.";

  return (
    <div className="space-y-6">
      <Card className="overflow-hidden border-slate-200 bg-white/90 shadow-sm">
        <div className="border-b border-slate-200 bg-[linear-gradient(135deg,_rgba(16,185,129,0.10),_rgba(15,23,42,0.02))] px-6 py-6">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div className="max-w-3xl">
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-emerald-700">
                Top run summary
              </p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                Latest Auto-Live decision run
              </h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">
                {latestRun?.summary ||
                  "No persisted run is available yet. Once Auto-Live completes a cycle, the latest run summary will appear here."}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {latestRun ? (
                <>
                  <span className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-slate-700">
                    {labelize(latestRun.status)}
                  </span>
                  <span className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-slate-700">
                    {latestRun.dry_run ? "Dry run" : "Live path"}
                  </span>
                  <span className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-slate-700">
                    {labelize(latestRun.triggered_by)}
                  </span>
                </>
              ) : null}
            </div>
          </div>
          {latestRun ? (
            <p className="mt-4 text-sm text-slate-600">
              Started {formatDateTime(latestRun.started_at)}
              {latestRun.completed_at ? ` | Completed ${formatDateTime(latestRun.completed_at)}` : ""}
            </p>
          ) : null}
        </div>

        <CardContent className="space-y-5 px-6 py-6">
          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
            <SummaryMetric
              detail={`${runSummary.marketsRejected} rejected | ${runSummary.candidatesPassed} passed`}
              label="Markets scanned"
              value={String(runSummary.marketsScanned)}
            />
            <SummaryMetric
              detail="Rejected during scan and rules filtering"
              label="Markets rejected"
              value={String(runSummary.marketsRejected)}
            />
            <SummaryMetric
              detail={`${runSummary.executedCount} executed | ${runSummary.failedCount} failed`}
              label="Candidates passed"
              value={String(runSummary.candidatesPassed)}
            />
            <SummaryMetric
              detail="Latest run proposed order dollars across all actions"
              label="Total proposed exposure"
              value={formatMoney(runSummary.totalProposedExposureUsd)}
            />
            <SummaryMetric
              detail="Submitted order dollars for this run"
              label="Total executed exposure"
              value={formatMoney(runSummary.totalExecutedExposureUsd)}
            />
            <SummaryMetric
              detail="Based on target post-rebalance exposure"
              label="Remaining cash reserve"
              value={formatMoney(runSummary.remainingCashReserveUsd)}
            />
            <SummaryMetric
              detail={maxThemeExposureDetail}
              label="Max theme exposure used"
              value={maxThemeExposureLabel}
            />
            <SummaryMetric
              detail="Execution-stage failures and hard blocks"
              label="Failed count"
              value={String(runSummary.failedCount)}
            />
            <SummaryMetric
              detail="Orders successfully submitted"
              label="Executed count"
              value={String(runSummary.executedCount)}
            />
          </div>

          <div className="grid gap-4 xl:grid-cols-[1.15fr,1fr]">
            <div className="rounded-[28px] border border-slate-200 bg-slate-50/80 p-4 shadow-sm">
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">
                Decision mix
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                {(
                  [
                    "BUY_NEW",
                    "ADD_MORE",
                    "HOLD",
                    "TRIM",
                    "EXIT",
                    "SKIP",
                  ] as const
                ).map((decision) => (
                  <span
                    className={cn(
                      "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em]",
                      getDecisionBadgeClass(decision),
                    )}
                    key={decision}
                  >
                    {decision}
                    <span className="rounded-full bg-white/70 px-2 py-0.5 text-[11px]">
                      {runSummary.actionCounts[decision]}
                    </span>
                  </span>
                ))}
              </div>
            </div>

            <div className="rounded-[28px] border border-slate-200 bg-slate-50/80 p-4 shadow-sm">
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">
                Guardrail failures by category
              </p>
              {runSummary.guardrailFailures.length > 0 ? (
                <div className="mt-4 flex flex-wrap gap-2">
                  {runSummary.guardrailFailures.map((failure) => (
                    <span
                      className="inline-flex items-center gap-2 rounded-full border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700"
                      key={failure.category}
                    >
                      {failure.category}
                      <span className="rounded-full bg-white/80 px-2 py-0.5 text-[11px]">
                        {failure.count}
                      </span>
                    </span>
                  ))}
                </div>
              ) : (
                <p className="mt-4 text-sm text-slate-600">
                  No guardrail failures were persisted for the latest run.
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-slate-200 bg-white/90 shadow-sm">
        <CardHeader className="gap-4">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <CardTitle className="text-xl text-slate-950">Decision table</CardTitle>
              <CardDescription className="mt-2 max-w-2xl">
                Showing the persisted decisions for the latest Auto-Live run, with expandable rows for rules, evidence, consensus, scoring, sizing, rebalance, and execution detail.
              </CardDescription>
            </div>
            <div className="w-full max-w-[220px]">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                Sort
              </p>
              <Select
                onValueChange={(value) => setSortKey(value as AutoLiveDecisionSortKey)}
                value={sortKey}
              >
                <SelectTrigger className="mt-1 h-10 w-full rounded-full border border-slate-200 bg-white px-4 text-sm text-slate-700">
                  <SelectValue placeholder="Sort decisions" />
                </SelectTrigger>
                <SelectContent className="rounded-3xl border border-slate-200 bg-white">
                  {SORT_KEYS.map((key) => (
                    <SelectItem key={key} value={key}>
                      {getAutoLiveSortLabel(key)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {FILTER_KEYS.map((key) => {
              const count = filterAutoLiveDecisionRows(rowViews, key).length;
              const isActive = filterKey === key;
              return (
                <button
                  className={cn(
                    "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] transition-colors",
                    isActive
                      ? "border-slate-900 bg-slate-900 text-white"
                      : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
                  )}
                  key={key}
                  onClick={() => setFilterKey(key)}
                  type="button"
                >
                  {getAutoLiveFilterLabel(key)}
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[11px]",
                      isActive ? "bg-white/20 text-white" : "bg-slate-100 text-slate-600",
                    )}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        </CardHeader>

        <CardContent>
          {visibleRows.length > 0 ? (
            <div className="overflow-x-auto rounded-[28px] border border-slate-200">
              <table className="min-w-[1800px] w-full border-collapse">
                <thead className="bg-slate-50/80">
                  <tr className="border-b border-slate-200 text-left">
                    {[
                      "Market",
                      "Theme",
                      "Deadline",
                      "Hours remaining",
                      "Side",
                      "Current price",
                      "LLM fair probability",
                      "Market odds",
                      "Edge",
                      "Score",
                      "Current exposure",
                      "Target exposure",
                      "Proposed order",
                      "Decision",
                      "Status",
                      "Reason",
                      "Updated at",
                    ].map((column) => (
                      <th
                        className="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500"
                        key={column}
                      >
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((row) => {
                    const isOpen = effectiveOpenRowIds.includes(row.id);
                    return (
                      <Fragment key={row.id}>
                        <tr
                          className={cn(
                            "border-b border-slate-200 align-top transition-colors",
                            isOpen ? "bg-slate-50/60" : "bg-white hover:bg-slate-50/40",
                          )}
                        >
                          <td className="px-4 py-4">
                            <button
                              className="group flex w-full items-start gap-3 text-left"
                              onClick={() => toggleRow(row.id)}
                              type="button"
                            >
                              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 transition-colors group-hover:border-slate-300 group-hover:text-slate-900">
                                {isOpen ? (
                                  <ChevronUp className="size-4" />
                                ) : (
                                  <ChevronDown className="size-4" />
                                )}
                              </span>
                              <span className="min-w-0">
                                <span className="block text-sm font-semibold leading-6 text-slate-950">
                                  {row.decision.market_title}
                                </span>
                                <span className="mt-1 block text-xs text-slate-500">
                                  {row.decision.slug || row.decision.market_id}
                                </span>
                              </span>
                            </button>
                          </td>
                          <td className="px-4 py-4 text-sm text-slate-700">{row.decision.theme}</td>
                          <td className="px-4 py-4 text-sm text-slate-700">
                            <span className="whitespace-nowrap">{row.deadlineEt || "-"}</span>
                          </td>
                          <td className="px-4 py-4 text-sm text-slate-700">{formatHours(row.hoursRemaining)}</td>
                          <td className="px-4 py-4 text-sm font-medium text-slate-900">{row.decision.side}</td>
                          <td className="px-4 py-4 text-sm text-slate-700">{formatPriceCents(row.currentPriceCents)}</td>
                          <td className="px-4 py-4 text-sm text-slate-700">{formatPercent(row.fairProbabilityPct)}</td>
                          <td className="px-4 py-4 text-sm text-slate-700">{row.marketOddsLabel}</td>
                          <td className="px-4 py-4 text-sm font-medium text-slate-900">{formatEdge(row.decision.edge_pp)}</td>
                          <td className="px-4 py-4 text-sm font-medium text-slate-900">{formatScore(row.decision.score)}</td>
                          <td className="px-4 py-4 text-sm text-slate-700">{formatMoney(row.decision.current_exposure_usd)}</td>
                          <td className="px-4 py-4 text-sm text-slate-700">{formatMoney(row.decision.target_exposure_usd)}</td>
                          <td className="px-4 py-4 text-sm text-slate-700">{row.proposedOrderLabel}</td>
                          <td className="px-4 py-4">
                            <span
                              className={cn(
                                "inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]",
                                getDecisionBadgeClass(row.decision.decision),
                              )}
                            >
                              {row.decision.decision}
                            </span>
                          </td>
                          <td className="px-4 py-4">
                            <span
                              className={cn(
                                "inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]",
                                getStatusBadgeClass(row.statusLabel),
                              )}
                            >
                              {row.statusLabel}
                            </span>
                          </td>
                          <td className="px-4 py-4 text-sm leading-6 text-slate-700">
                            <div className="max-w-[24rem]">{row.decision.reason}</div>
                          </td>
                          <td className="px-4 py-4 text-sm text-slate-700">{formatDateTime(row.decision.updated_at)}</td>
                        </tr>
                        {isOpen ? (
                          <tr className="border-b border-slate-200 bg-white">
                            <td className="p-0" colSpan={17}>
                              <ExpandedDecisionRow row={row} />
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="rounded-[28px] border border-dashed border-slate-200 bg-slate-50/80 px-5 py-10 text-sm text-slate-500">
              No latest-run decisions matched the current filter. Try another filter or run the engine again.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
