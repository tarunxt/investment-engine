"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ExternalLink,
  Loader2,
  PauseCircle,
  PlayCircle,
  RefreshCcw,
  Settings2,
  ShieldAlert,
  Square,
  Zap,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatUnknownError } from "@/lib/apiErrors";
import { URLs } from "@/lib/urls";
import { cn } from "@/lib/utils";
import { APIError, apiService } from "@/services/api";
import type {
  BullpenAutoLiveDecision,
  BullpenAutoLiveGuardrailCheck,
  BullpenAutoLiveRun,
  BullpenAutoLiveStageResult,
  BullpenAutoLiveSummaryResponse,
} from "@/types/api";

import { BullpenAiAutoLiveRiskGuardrailsDrawer } from "./BullpenAiAutoLiveRiskGuardrailsDrawer";

type ActionKey = "run-once" | "start" | "pause" | "resume" | "stop";

function normalizeError(error: unknown) {
  if (error instanceof APIError) return error.message;
  return formatUnknownError(error);
}

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

function getGuardrailClass(status: string) {
  switch (status) {
    case "pass":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "fail":
      return "border-rose-200 bg-rose-50 text-rose-700";
    case "warning":
    case "watch":
      return "border-amber-200 bg-amber-50 text-amber-800";
    default:
      return "border-slate-200 bg-slate-100 text-slate-700";
  }
}

function getDecisionClass(decision: string) {
  switch (decision) {
    case "BUY_NEW":
    case "ADD_MORE":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "TRIM":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "EXIT":
    case "SKIP":
      return "border-rose-200 bg-rose-50 text-rose-700";
    case "HOLD":
    default:
      return "border-slate-200 bg-slate-100 text-slate-700";
  }
}

function getModeClass(mode: string) {
  switch (mode) {
    case "live-trading":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "analysis-only":
      return "border-sky-200 bg-sky-50 text-sky-700";
    case "dry-run":
    default:
      return "border-slate-200 bg-slate-100 text-slate-700";
  }
}

function getRiskClass(status: string) {
  switch (status) {
    case "Ready":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "Blocked":
      return "border-rose-200 bg-rose-50 text-rose-700";
    case "Watch":
    default:
      return "border-amber-200 bg-amber-50 text-amber-800";
  }
}

function renderJson(value: unknown) {
  if (
    value === null ||
    value === undefined ||
    (typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value as Record<string, unknown>).length === 0) ||
    (Array.isArray(value) && value.length === 0)
  ) {
    return "-";
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function MetricCard({
  eyebrow,
  title,
  value,
  detail,
}: {
  eyebrow: string;
  title: string;
  value: string;
  detail: string;
}) {
  return (
    <Card className="border-slate-200 bg-white/90 shadow-sm">
      <CardHeader className="pb-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">
          {eyebrow}
        </p>
        <CardTitle className="text-base text-slate-950">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tracking-tight text-slate-950">
          {value}
        </div>
        <p className="mt-2 text-sm leading-6 text-slate-600">{detail}</p>
      </CardContent>
    </Card>
  );
}

function GuardrailPill({ check }: { check: BullpenAutoLiveGuardrailCheck }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-950">{check.label}</p>
          <p className="mt-1 text-sm leading-6 text-slate-600">{check.detail}</p>
        </div>
        <span
          className={cn(
            "rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]",
            getGuardrailClass(check.status),
          )}
        >
          {check.status}
        </span>
      </div>
      {check.value ? (
        <p className="mt-3 text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
          Value: {check.value}
        </p>
      ) : null}
    </div>
  );
}

function StageAuditCard({ stage }: { stage: BullpenAutoLiveStageResult }) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white px-4 py-4 shadow-sm">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">
            Stage {stage.stage_number}
          </p>
          <h4 className="mt-1 text-base font-semibold text-slate-950">
            {stage.stage_name}
          </h4>
          <p className="mt-2 text-sm leading-6 text-slate-600">{stage.reason}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]",
              getGuardrailClass(stage.status),
            )}
          >
            {stage.status}
          </span>
          {stage.hard_block ? (
            <span className="rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-rose-700">
              Hard Block
            </span>
          ) : null}
        </div>
      </div>

      {stage.guardrails_checked.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {stage.guardrails_checked.map((check) => (
            <span
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs font-medium",
                getGuardrailClass(check.status),
              )}
              key={check.id}
            >
              {check.label}
            </span>
          ))}
        </div>
      ) : null}

      <details className="mt-4 rounded-2xl border border-dashed border-slate-200 bg-slate-50/80 px-4 py-3">
        <summary className="cursor-pointer list-none text-sm font-semibold text-slate-900">
          Inputs and outputs
        </summary>
        <div className="mt-3 grid gap-3 xl:grid-cols-2">
          <div className="rounded-2xl border border-slate-200 bg-white p-3">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Inputs
            </p>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-xs leading-5 text-slate-700">
              {renderJson(stage.inputs)}
            </pre>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-3">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
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

function DecisionAuditCard({
  decision,
  defaultOpen,
}: {
  decision: BullpenAutoLiveDecision;
  defaultOpen?: boolean;
}) {
  return (
    <details
      className="rounded-[28px] border border-slate-200 bg-white shadow-sm"
      open={defaultOpen}
    >
      <summary className="cursor-pointer list-none px-5 py-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]",
                  getDecisionClass(decision.decision),
                )}
              >
                {decision.decision}
              </span>
              <span className="rounded-full border border-slate-200 bg-slate-100 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-700">
                {decision.side}
              </span>
              <span
                className={cn(
                  "rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]",
                  getRiskClass(decision.risk_status),
                )}
              >
                {decision.risk_status}
              </span>
            </div>
            <h3 className="mt-3 text-lg font-semibold tracking-tight text-slate-950">
              {decision.market_title}
            </h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              {decision.summary}
            </p>
          </div>
          <div className="grid gap-3 text-sm text-slate-600 sm:grid-cols-2 xl:min-w-[360px]">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                Price / Fair
              </p>
              <p className="mt-1 font-medium text-slate-950">
                {formatPercent(decision.price_cents)} / {formatPercent(decision.fair_probability_pct)}
              </p>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                Edge / Score
              </p>
              <p className="mt-1 font-medium text-slate-950">
                {formatPercent(decision.edge_pp)} / {decision.score.toFixed(2)}
              </p>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                Exposure
              </p>
              <p className="mt-1 font-medium text-slate-950">
                {formatMoney(decision.current_exposure_usd)} to {formatMoney(decision.target_exposure_usd)}
              </p>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                Evidence / Confidence
              </p>
              <p className="mt-1 font-medium text-slate-950">
                {decision.evidence_status} / {decision.confidence}
              </p>
            </div>
          </div>
        </div>
      </summary>

      <div className="border-t border-slate-200 px-5 py-5">
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            eyebrow="Timing"
            title="Hours Remaining"
            value={formatHours(decision.hours_remaining)}
            detail={`Updated ${formatDateTime(decision.updated_at)}`}
          />
          <MetricCard
            eyebrow="Probability"
            title="YES / NO Fair"
            value={`${formatPercent(decision.fair_yes_probability_pct)} / ${formatPercent(decision.fair_no_probability_pct)}`}
            detail={decision.disagreement_level ? `Disagreement: ${decision.disagreement_level}` : "Consensus spread stayed within the stored audit trail."}
          />
          <MetricCard
            eyebrow="Event"
            title="Event State"
            value={decision.event_state || "Unknown"}
            detail={decision.adjudication_required ? "Adjudication required before confidence is considered settled." : "No adjudication flag was raised in the persisted decision record."}
          />
          <MetricCard
            eyebrow="PnL"
            title="Realized PnL"
            value={formatMoney(decision.realized_pnl_usd)}
            detail={decision.reason}
          />
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          {decision.market_url ? (
            <a
              className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
              href={decision.market_url}
              rel="noreferrer"
              target="_blank"
            >
              Open market
              <ExternalLink className="size-4" />
            </a>
          ) : null}
          <span className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600">
            Theme: {decision.theme}
          </span>
          {decision.slug ? (
            <span className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600">
              Slug: {decision.slug}
            </span>
          ) : null}
        </div>

        <div className="mt-5 grid gap-4 xl:grid-cols-2">
          <div className="rounded-3xl border border-slate-200 bg-slate-50/80 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
              Key Evidence
            </p>
            {decision.key_evidence.length > 0 ? (
              <div className="mt-3 space-y-2">
                {decision.key_evidence.map((item, index) => (
                  <p className="text-sm leading-6 text-slate-700" key={`${decision.id}-evidence-${index}`}>
                    {item}
                  </p>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-sm text-slate-500">No key evidence was persisted for this decision.</p>
            )}
          </div>
          <div className="rounded-3xl border border-slate-200 bg-slate-50/80 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
              Red Flags
            </p>
            {decision.red_flags.length > 0 ? (
              <div className="mt-3 space-y-2">
                {decision.red_flags.map((item, index) => (
                  <p className="text-sm leading-6 text-slate-700" key={`${decision.id}-red-flag-${index}`}>
                    {item}
                  </p>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-sm text-slate-500">No red flags were persisted for this decision.</p>
            )}
          </div>
        </div>

        {decision.rationale ? (
          <div className="mt-5 rounded-3xl border border-slate-200 bg-white p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
              Rationale
            </p>
            <p className="mt-3 text-sm leading-6 text-slate-700">{decision.rationale}</p>
          </div>
        ) : null}

        {decision.order_plan ? (
          <div className="mt-5 rounded-3xl border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
                Order Plan
              </span>
              <span
                className={cn(
                  "rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]",
                  getGuardrailClass(decision.order_plan.status),
                )}
              >
                {decision.order_plan.status}
              </span>
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <p className="text-sm text-slate-700">
                <span className="font-semibold text-slate-950">Action:</span> {labelize(decision.order_plan.action)}
              </p>
              <p className="text-sm text-slate-700">
                <span className="font-semibold text-slate-950">Order Size:</span> {formatMoney(decision.order_plan.order_size_usd)}
              </p>
              <p className="text-sm text-slate-700">
                <span className="font-semibold text-slate-950">Limit Price:</span> {decision.order_plan.limit_price_cents.toFixed(1)}c
              </p>
              <p className="text-sm text-slate-700">
                <span className="font-semibold text-slate-950">Dry Run:</span> {decision.order_plan.dry_run ? "Yes" : "No"}
              </p>
            </div>
            <p className="mt-3 text-sm leading-6 text-slate-600">{decision.order_plan.detail}</p>
          </div>
        ) : null}

        {decision.llm_outputs.length > 0 ? (
          <div className="mt-5 rounded-3xl border border-slate-200 bg-white p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
              LLM Consensus Inputs
            </p>
            <div className="mt-3 grid gap-3 xl:grid-cols-2">
              {decision.llm_outputs.map((output, index) => (
                <div
                  className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4"
                  key={`${decision.id}-llm-${index}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-slate-950">
                        {output.provider}
                      </p>
                      <p className="text-xs uppercase tracking-[0.18em] text-slate-500">
                        {output.model}
                      </p>
                    </div>
                    {output.error ? (
                      <span className="rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-rose-700">
                        Error
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-3 grid gap-2 text-sm text-slate-700 sm:grid-cols-2">
                    <p>YES: {formatPercent(output.llm_yes_odds)}</p>
                    <p>NO: {formatPercent(output.llm_no_odds)}</p>
                    <p>Confidence: {output.confidence || "-"}</p>
                    <p>Evidence: {output.evidence_status || "-"}</p>
                  </div>
                  {output.rationale ? (
                    <p className="mt-3 text-sm leading-6 text-slate-600">{output.rationale}</p>
                  ) : null}
                  {output.error ? (
                    <p className="mt-3 text-sm leading-6 text-rose-700">{output.error}</p>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {decision.guardrail_checks.length > 0 ? (
          <div className="mt-5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
              Guardrails Checked
            </p>
            <div className="mt-3 grid gap-3 xl:grid-cols-2">
              {decision.guardrail_checks.map((check) => (
                <GuardrailPill check={check} key={check.id} />
              ))}
            </div>
          </div>
        ) : null}

        {decision.stage_results.length > 0 ? (
          <div className="mt-5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
              Stage Audit Trail
            </p>
            <div className="mt-3 space-y-3">
              {decision.stage_results.map((stage) => (
                <StageAuditCard
                  key={`${decision.id}-stage-${stage.stage_number}-${stage.stage_name}`}
                  stage={stage}
                />
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function RunAuditCard({
  run,
  defaultOpen,
}: {
  run: BullpenAutoLiveRun;
  defaultOpen?: boolean;
}) {
  return (
    <details
      className="rounded-[28px] border border-slate-200 bg-white shadow-sm"
      open={defaultOpen}
    >
      <summary className="cursor-pointer list-none px-5 py-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]",
                  getGuardrailClass(run.status),
                )}
              >
                {run.status}
              </span>
              <span className="rounded-full border border-slate-200 bg-slate-100 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-700">
                {labelize(run.triggered_by)}
              </span>
              <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-700">
                {run.dry_run ? "Dry Run" : "Live Path"}
              </span>
            </div>
            <h3 className="mt-3 text-lg font-semibold tracking-tight text-slate-950">
              {run.summary}
            </h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Started {formatDateTime(run.started_at)}
              {run.completed_at ? ` | Completed ${formatDateTime(run.completed_at)}` : ""}
            </p>
          </div>
          <div className="grid gap-3 text-sm text-slate-600 sm:grid-cols-2 xl:min-w-[320px]">
            <p>
              <span className="font-semibold text-slate-950">Decisions:</span> {run.decisions_count}
            </p>
            <p>
              <span className="font-semibold text-slate-950">Orders planned:</span> {run.orders_planned}
            </p>
            <p>
              <span className="font-semibold text-slate-950">Orders submitted:</span> {run.orders_submitted}
            </p>
            <p>
              <span className="font-semibold text-slate-950">Execution requested:</span> {run.live_execution_requested ? "Yes" : "No"}
            </p>
          </div>
        </div>
      </summary>

      <div className="border-t border-slate-200 px-5 py-5">
        {run.error_message ? (
          <Alert className="border-rose-200 bg-rose-50 text-rose-900">
            <AlertTriangle className="size-4" />
            <AlertTitle>Run error</AlertTitle>
            <AlertDescription>{run.error_message}</AlertDescription>
          </Alert>
        ) : null}

        {run.guardrail_checks.length > 0 ? (
          <div className="mt-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
              Run Guardrails
            </p>
            <div className="mt-3 grid gap-3 xl:grid-cols-2">
              {run.guardrail_checks.map((check) => (
                <GuardrailPill check={check} key={`${run.id}-${check.id}`} />
              ))}
            </div>
          </div>
        ) : null}

        {run.stage_results.length > 0 ? (
          <div className="mt-5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
              Stage Audit Trail
            </p>
            <div className="mt-3 space-y-3">
              {run.stage_results.map((stage) => (
                <StageAuditCard
                  key={`${run.id}-stage-${stage.stage_number}-${stage.stage_name}`}
                  stage={stage}
                />
              ))}
            </div>
          </div>
        ) : null}

        {run.decision_ids.length > 0 ? (
          <div className="mt-5 rounded-3xl border border-slate-200 bg-slate-50/80 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
              Decision IDs
            </p>
            <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words text-xs leading-5 text-slate-700">
              {renderJson(run.decision_ids)}
            </pre>
          </div>
        ) : null}
      </div>
    </details>
  );
}

async function requestDashboard(): Promise<BullpenAutoLiveSummaryResponse> {
  const [summary, runs, decisions] = await Promise.all([
    apiService.bullpenAiAutoLiveSummary(),
    apiService.bullpenAiAutoLiveRuns(),
    apiService.bullpenAiAutoLiveDecisions(),
  ]);

  return {
    ...summary,
    recent_runs: runs,
    recent_decisions: decisions,
  };
}

export function BullpenAiAutoLiveConsole() {
  const [summary, setSummary] = useState<BullpenAutoLiveSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<ActionKey | null>(null);
  const [guardrailsDrawerOpen, setGuardrailsDrawerOpen] = useState(false);

  async function reloadDashboard() {
    setRefreshing(true);
    try {
      const nextSummary = await requestDashboard();
      setSummary(nextSummary);
      setError(null);
      return nextSummary;
    } catch (nextError) {
      setError(normalizeError(nextError));
      return null;
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function loadInitialDashboard() {
      setLoading(true);
      try {
        const nextSummary = await requestDashboard();
        if (cancelled) return;
        setSummary(nextSummary);
        setError(null);
      } catch (nextError) {
        if (cancelled) return;
        setError(normalizeError(nextError));
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadInitialDashboard();

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleAction(action: ActionKey) {
    setActionBusy(action);
    try {
      if (action === "run-once") {
        await apiService.bullpenAiAutoLiveRunOnce();
      } else if (action === "start") {
        await apiService.bullpenAiAutoLiveStart();
      } else if (action === "pause") {
        await apiService.bullpenAiAutoLivePause();
      } else if (action === "resume") {
        await apiService.bullpenAiAutoLiveResume();
      } else if (action === "stop") {
        await apiService.bullpenAiAutoLiveStop();
      }

      await reloadDashboard();
    } catch (nextError) {
      setError(normalizeError(nextError));
    } finally {
      setActionBusy(null);
    }
  }

  const state = summary?.state;
  const settings = summary?.settings;
  const latestRun = summary?.latest_run ?? summary?.recent_runs?.[0] ?? null;
  const recentRuns = summary?.recent_runs ?? [];
  const recentDecisions = summary?.recent_decisions ?? [];
  const botCard = summary?.bot_card;
  const latestGuardrails = summary?.latest_guardrail_checks ?? [];

  if (loading && !summary) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center bg-[radial-gradient(circle_at_top,_rgba(251,191,36,0.10),_transparent_35%),linear-gradient(180deg,_#f8fafc_0%,_#eef2ff_100%)] px-6">
        <div className="flex items-center gap-3 rounded-full border border-slate-200 bg-white px-5 py-3 text-sm text-slate-600 shadow-sm">
          <Loader2 className="size-4 animate-spin" />
          Loading Bullpen AI Auto-Live audit trail...
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(251,191,36,0.12),_transparent_28%),radial-gradient(circle_at_right,_rgba(16,185,129,0.10),_transparent_30%),linear-gradient(180deg,_#f8fafc_0%,_#eef2ff_100%)]">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          <div className="space-y-6">
            <Card className="overflow-hidden border-slate-200 bg-white/90 shadow-sm backdrop-blur">
              <div className="border-b border-slate-200 bg-[linear-gradient(135deg,_rgba(15,23,42,0.03),_rgba(251,191,36,0.10))] px-6 py-6">
                <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
                  <div className="max-w-3xl">
                    <div className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-700">
                      Separate Auto-Live Service
                    </div>
                    <h1 className="mt-4 text-3xl font-semibold tracking-tight text-slate-950">
                      Bullpen AI Auto-Live
                    </h1>
                    <p className="mt-3 text-sm leading-7 text-slate-600 sm:text-base">
                      A standalone 7-stage decision engine that scans candidate
                      markets, parses rules, builds shared evidence, runs LLM
                      consensus, sizes positions, rebalances exposure, and only
                      executes limit orders when every hard guardrail passes.
                    </p>
                    <p className="mt-3 text-sm leading-6 text-slate-600">
                      Bullpen x AI remains the manual analysis surface.
                      Auto-Live uses its own persisted runs, decisions, and
                      stage-by-stage audit trail.
                    </p>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <span
                        className={cn(
                          "rounded-full border px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em]",
                          getGuardrailClass(state?.status || "watch"),
                        )}
                      >
                        {state ? labelize(state.status) : "Unknown Status"}
                      </span>
                      <span
                        className={cn(
                          "rounded-full border px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em]",
                          getModeClass(state?.mode || "dry-run"),
                        )}
                      >
                        {state ? labelize(state.mode) : "Dry Run"}
                      </span>
                      <span className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-slate-700">
                        {state?.live_armed ? "Live Armed" : "Simulation Only"}
                      </span>
                      <span className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-slate-700">
                        {state?.dry_run ? "Dry Run On" : "Dry Run Off"}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-3 xl:justify-end">
                    <Button
                      className="rounded-full"
                      disabled={refreshing || Boolean(actionBusy)}
                      onClick={() => {
                        void reloadDashboard();
                      }}
                      variant="outline"
                    >
                      {refreshing ? (
                        <Loader2 className="mr-2 size-4 animate-spin" />
                      ) : (
                        <RefreshCcw className="mr-2 size-4" />
                      )}
                      Refresh
                    </Button>
                    <Button
                      className="rounded-full bg-slate-950 text-white hover:bg-slate-800"
                      disabled={refreshing || Boolean(actionBusy)}
                      onClick={() => {
                        void handleAction("run-once");
                      }}
                    >
                      {actionBusy === "run-once" ? (
                        <Loader2 className="mr-2 size-4 animate-spin" />
                      ) : (
                        <Zap className="mr-2 size-4" />
                      )}
                      Run Now
                    </Button>
                    {state?.paused ? (
                      <Button
                        className="rounded-full"
                        disabled={refreshing || Boolean(actionBusy)}
                        onClick={() => {
                          void handleAction("resume");
                        }}
                        variant="outline"
                      >
                        {actionBusy === "resume" ? (
                          <Loader2 className="mr-2 size-4 animate-spin" />
                        ) : (
                          <PlayCircle className="mr-2 size-4" />
                        )}
                        Resume
                      </Button>
                    ) : state?.running ? (
                      <Button
                        className="rounded-full"
                        disabled={refreshing || Boolean(actionBusy)}
                        onClick={() => {
                          void handleAction("pause");
                        }}
                        variant="outline"
                      >
                        {actionBusy === "pause" ? (
                          <Loader2 className="mr-2 size-4 animate-spin" />
                        ) : (
                          <PauseCircle className="mr-2 size-4" />
                        )}
                        Pause
                      </Button>
                    ) : (
                      <Button
                        className="rounded-full"
                        disabled={refreshing || Boolean(actionBusy)}
                        onClick={() => {
                          void handleAction("start");
                        }}
                        variant="outline"
                      >
                        {actionBusy === "start" ? (
                          <Loader2 className="mr-2 size-4 animate-spin" />
                        ) : (
                          <PlayCircle className="mr-2 size-4" />
                        )}
                        Start Scheduler
                      </Button>
                    )}
                    {(state?.running || state?.paused) ? (
                      <Button
                        className="rounded-full"
                        disabled={refreshing || Boolean(actionBusy)}
                        onClick={() => {
                          void handleAction("stop");
                        }}
                        variant="outline"
                      >
                        {actionBusy === "stop" ? (
                          <Loader2 className="mr-2 size-4 animate-spin" />
                        ) : (
                          <Square className="mr-2 size-4" />
                        )}
                        Stop
                      </Button>
                    ) : null}
                    <Button
                      className="rounded-full"
                      onClick={() => setGuardrailsDrawerOpen(true)}
                      variant="outline"
                    >
                      <Settings2 className="mr-2 size-4" />
                      Risk Guardrails
                    </Button>
                  </div>
                </div>

                <div className="mt-5 flex flex-wrap items-center gap-3 text-sm text-slate-600">
                  <span>
                    Last action: <span className="font-medium text-slate-900">{state?.last_action || "-"}</span>
                  </span>
                  <span className="hidden text-slate-300 sm:inline">|</span>
                  <span>
                    Manual analysis page:{" "}
                    <Link
                      className="font-medium text-slate-900 underline decoration-amber-300 underline-offset-4"
                      href={URLs.routes.console.bullpenAi()}
                    >
                      Open Bullpen x AI
                    </Link>
                  </span>
                </div>
              </div>

              <CardContent className="space-y-5 px-6 py-6">
                {state?.emergency_stopped ? (
                  <Alert className="border-rose-300 bg-rose-50 text-rose-900">
                    <ShieldAlert className="size-4" />
                    <AlertTitle>Emergency stop is active</AlertTitle>
                    <AlertDescription>
                      New live actions are blocked until the emergency stop is
                      cleared from the risk guardrails drawer.
                    </AlertDescription>
                  </Alert>
                ) : null}

                {error ? (
                  <Alert className="border-amber-300 bg-amber-50 text-amber-900">
                    <AlertTriangle className="size-4" />
                    <AlertTitle>Console refresh needs attention</AlertTitle>
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                ) : null}

                <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
                  <MetricCard
                    eyebrow="Capital"
                    title="Invested"
                    value={formatMoney(state?.invested_usd)}
                    detail={`Current value ${formatMoney(state?.current_value_usd)}`}
                  />
                  <MetricCard
                    eyebrow="PnL"
                    title="Net Profit / Loss"
                    value={formatMoney(state?.pnl_usd)}
                    detail={`${state?.active_positions ?? 0} active positions | ${state?.today_executed_orders ?? state?.trades_today ?? 0} executed today`}
                  />
                  <MetricCard
                    eyebrow="Latest Run"
                    title={latestRun ? labelize(latestRun.status) : "No runs yet"}
                    value={latestRun ? formatDateTime(latestRun.started_at) : "-"}
                    detail={latestRun ? `${latestRun.decisions_count} decisions | ${latestRun.orders_planned} orders planned` : "Run the engine once to create the first persisted audit entry."}
                  />
                  <MetricCard
                    eyebrow="Scheduler"
                    title={state?.running ? "Active" : state?.paused ? "Paused" : "Stopped"}
                    value={formatDateTime(state?.next_run_at)}
                    detail={`Scan ${formatDateTime(state?.next_scan_at)} | Rebalance ${formatDateTime(state?.next_rebalance_at)}`}
                  />
                </div>

                <div className="grid gap-4 xl:grid-cols-[1.5fr,1fr]">
                  <Card className="border-slate-200 bg-slate-50/70">
                    <CardHeader>
                      <CardTitle className="text-lg text-slate-950">Strategy posture</CardTitle>
                      <CardDescription>
                        The bot card summarizes the standalone service status that also feeds the broader trading-bots overview.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="grid gap-4 md:grid-cols-2">
                      <div className="rounded-3xl border border-slate-200 bg-white p-4">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
                          Guardrails Summary
                        </p>
                        <p className="mt-3 text-sm leading-6 text-slate-700">
                          {botCard?.guardrails_summary || "No guardrail summary is available yet."}
                        </p>
                      </div>
                      <div className="rounded-3xl border border-slate-200 bg-white p-4">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
                          Strategy Summary
                        </p>
                        <p className="mt-3 text-sm leading-6 text-slate-700">
                          {botCard?.strategy_summary || "Strategy summary unavailable."}
                        </p>
                      </div>
                      <div className="rounded-3xl border border-slate-200 bg-white p-4 md:col-span-2">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
                          Risk Summary
                        </p>
                        <p className="mt-3 text-sm leading-6 text-slate-700">
                          {botCard?.risk_summary || "Risk summary unavailable."}
                        </p>
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="border-slate-200 bg-slate-50/70">
                    <CardHeader>
                      <CardTitle className="text-lg text-slate-950">Execution readiness</CardTitle>
                      <CardDescription>
                        Live execution still requires runtime, environment, and market guardrails to line up at stage 7.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3">
                        <span className="text-sm font-medium text-slate-700">Live armed</span>
                        <span className={cn("rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]", getGuardrailClass(state?.live_armed ? "pass" : "watch"))}>
                          {state?.live_armed ? "Armed" : "Simulation"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3">
                        <span className="text-sm font-medium text-slate-700">Live execution allowed</span>
                        <span className={cn("rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]", getGuardrailClass(state?.live_execution_allowed ? "pass" : "watch"))}>
                          {state?.live_execution_allowed ? "Ready" : "Blocked"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3">
                        <span className="text-sm font-medium text-slate-700">Dry run</span>
                        <span className={cn("rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]", getGuardrailClass(state?.dry_run ? "warning" : "pass"))}>
                          {state?.dry_run ? "On" : "Off"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3">
                        <span className="text-sm font-medium text-slate-700">Executed / skipped today</span>
                        <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-700">
                          {state?.today_executed_orders ?? 0} / {state?.today_skipped_orders ?? 0}
                        </span>
                      </div>
                      <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3">
                        <span className="text-sm font-medium text-slate-700">Consecutive failed orders</span>
                        <span className={cn("rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]", getGuardrailClass((state?.consecutive_failed_orders ?? 0) > 0 ? "warning" : "pass"))}>
                          {state?.consecutive_failed_orders ?? 0}
                        </span>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </CardContent>
            </Card>

            <Card className="border-slate-200 bg-white/90 shadow-sm">
              <CardHeader>
                <CardTitle className="text-xl text-slate-950">Latest guardrails</CardTitle>
                <CardDescription>
                  Every run and decision persists its own checks, and these are the most recent top-level runtime gates.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {latestGuardrails.length > 0 ? (
                  <div className="grid gap-3 xl:grid-cols-2">
                    {latestGuardrails.map((check) => (
                      <GuardrailPill check={check} key={check.id} />
                    ))}
                  </div>
                ) : (
                  <div className="rounded-3xl border border-dashed border-slate-200 bg-slate-50/80 px-5 py-8 text-sm text-slate-500">
                    No runtime guardrails have been persisted yet.
                  </div>
                )}
              </CardContent>
            </Card>

            <div className="grid gap-6 xl:grid-cols-[1.05fr,1fr]">
              <Card className="border-slate-200 bg-white/90 shadow-sm">
                <CardHeader>
                  <CardTitle className="text-xl text-slate-950">Runs audit trail</CardTitle>
                  <CardDescription>
                    Full engine runs persist stage-level status, reasons, inputs, outputs, and hard blocks.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {recentRuns.length > 0 ? (
                    <div className="space-y-4">
                      {recentRuns.map((run, index) => (
                        <RunAuditCard
                          defaultOpen={index === 0}
                          key={run.id}
                          run={run}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-3xl border border-dashed border-slate-200 bg-slate-50/80 px-5 py-8 text-sm text-slate-500">
                      No runs have been persisted yet. Use <span className="font-medium text-slate-700">Run Now</span> to seed the audit trail.
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card className="border-slate-200 bg-white/90 shadow-sm">
                <CardHeader>
                  <CardTitle className="text-xl text-slate-950">Decision audit trail</CardTitle>
                  <CardDescription>
                    Each candidate decision stores stage outputs, guardrails checked, LLM consensus data, and order-planning details.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {recentDecisions.length > 0 ? (
                    <div className="space-y-4">
                      {recentDecisions.map((decision, index) => (
                        <DecisionAuditCard
                          decision={decision}
                          defaultOpen={index === 0}
                          key={decision.id}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-3xl border border-dashed border-slate-200 bg-slate-50/80 px-5 py-8 text-sm text-slate-500">
                      No decisions have been persisted yet. Once stage 1 produces candidates, this pane will show the full audit trail per decision.
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </div>

      <BullpenAiAutoLiveRiskGuardrailsDrawer
        onClose={() => setGuardrailsDrawerOpen(false)}
        onSummaryReload={reloadDashboard}
        open={guardrailsDrawerOpen}
        settings={summary?.settings ?? null}
        settingsLoading={loading && !summary}
      />
    </>
  );
}
