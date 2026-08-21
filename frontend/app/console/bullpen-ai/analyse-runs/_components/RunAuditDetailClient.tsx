"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import {
  AlertTriangle,
  Copy,
  Download,
  Loader2,
  RefreshCw,
} from "lucide-react";

import { LlmModelSelectionPanel } from "@/components/shared/LlmModelSelectionPanel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { URLs } from "@/lib/urls";
import { formatApiErrorSummary } from "@/lib/apiErrors";
import { APIError, apiService } from "@/services/api";
import type {
  BullpenRunAuditDetailResponse,
  BullpenRunAuditFeedbackDetail,
  BullpenRunAuditFeedbackSummary,
  BullpenRunAuditManualCheck,
  BullpenRunAuditSectionResponse,
  ProviderInfo,
} from "@/types/api";

import {
  AuditBadge,
  DetailGrid,
  formatCurrency,
  formatDateTime,
  formatDuration,
  formatPercent,
  humanizeToken,
  JsonPanel,
  runAuditSelectClassName,
  severityTone,
  statusTone,
  SummaryStatCard,
} from "./runAuditShared";

type SectionMap = Record<string, BullpenRunAuditSectionResponse | undefined>;
type ManualEditMap = Record<
  number,
  {
    status: BullpenRunAuditManualCheck["status"];
    remark: string;
  }
>;

type RunAuditLoadError = {
  summary: string;
  httpStatus: number | null;
  code: string | null;
  runId: string;
  diagnosticId: string | null;
  failedPhase: string | null;
  causeType: string | null;
  technicalDetail: string | null;
  likelyCause: string | null;
  requiredMigration: string | null;
  fixSteps: string[];
};

const severityOrder = ["critical", "high", "medium", "low", "info"] as const;
const auditScopeOptions = [
  "run",
  "stage",
  "event",
  "candidate",
  "llm_invocation",
  "formula",
  "guardrail",
  "order",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown) {
  return isRecord(value) ? value : null;
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown, fallback = "—") {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseRunAuditLoadError(error: unknown, runId: string): RunAuditLoadError {
  const fallback = "Failed to load Bullpen run audit detail.";
  if (!(error instanceof APIError)) {
    return {
      summary: error instanceof Error ? error.message : fallback,
      httpStatus: null,
      code: null,
      runId,
      diagnosticId: null,
      failedPhase: null,
      causeType: null,
      technicalDetail: null,
      likelyCause: null,
      requiredMigration: null,
      fixSteps: ["Retry the request.", "If it fails again, check the backend service logs for this run ID."],
    };
  }

  const envelope = asRecord(error.details);
  const detail = asRecord(envelope?.detail) ?? envelope;
  const steps = asArray(detail?.fix_steps).filter(
    (step): step is string => typeof step === "string" && Boolean(step.trim()),
  );
  return {
    summary: formatApiErrorSummary(error),
    httpStatus: error.status,
    code: typeof detail?.error === "string" ? detail.error : null,
    runId: typeof detail?.run_id === "string" ? detail.run_id : runId,
    diagnosticId: typeof detail?.diagnostic_id === "string" ? detail.diagnostic_id : null,
    failedPhase: typeof detail?.failed_phase === "string" ? detail.failed_phase : null,
    causeType: typeof detail?.cause_type === "string" ? detail.cause_type : null,
    technicalDetail: typeof detail?.technical_detail === "string" ? detail.technical_detail : null,
    likelyCause: typeof detail?.likely_cause === "string" ? detail.likely_cause : null,
    requiredMigration:
      typeof detail?.required_migration === "string" ? detail.required_migration : null,
    fixSteps: steps.length > 0 ? steps : ["Retry the request and inspect backend logs using this run ID."],
  };
}

function jsonDownload(filename: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function copyText(value: string) {
  await navigator.clipboard.writeText(value);
}

function modelKey(provider: string, model: string) {
  return `${provider}::${model}`;
}

function parseModelKey(value: string | null) {
  if (!value || !value.includes("::")) return null;
  const [provider, ...rest] = value.split("::");
  const model = rest.join("::");
  if (!provider || !model) return null;
  return { provider, model };
}

function selectedKeySet(selectedModelKey: string | null) {
  return selectedModelKey ? new Set([selectedModelKey]) : new Set<string>();
}

function SectionShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <Card className="rounded-none border-slate-200 shadow-none">
      <CardHeader>
        <CardTitle className="text-base text-slate-950">{title}</CardTitle>
        {subtitle ? <p className="text-sm text-slate-500">{subtitle}</p> : null}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

function TimelineList({ items }: { items: unknown[] }) {
  if (items.length === 0) {
    return <p className="text-sm text-slate-500">No timeline events were captured.</p>;
  }

  return (
    <div className="space-y-3">
      {items.map((item, index) => {
        const record = asRecord(item);
        if (!record) return null;
        return (
          <div
            key={`${record.event_key || index}`}
            className="border border-slate-200 bg-slate-50 px-4 py-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <AuditBadge
                label={humanizeToken(stringValue(record.event_type, "event"))}
                tone={statusTone(stringValue(record.event_type, "event"))}
              />
              {record.logical_stage_number ? (
                <AuditBadge
                  label={`Stage ${record.logical_stage_number}`}
                  tone="info"
                />
              ) : null}
              <AuditBadge
                label={humanizeToken(stringValue(record.scope_type, "scope"))}
                tone="neutral"
              />
            </div>
            <p className="mt-3 text-sm font-semibold text-slate-900">
              {stringValue(record.scope_id, stringValue(record.event_key, "Event"))}
            </p>
            <p className="mt-1 text-sm text-slate-600">
              {formatDateTime(
                typeof record.occurred_at === "string" ? record.occurred_at : null,
              )}{" "}
              · {stringValue(record.source_location)}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function FindingsGroup({
  severity,
  items,
}: {
  severity: (typeof severityOrder)[number];
  items: BullpenRunAuditDetailResponse["findings"];
}) {
  if (items.length === 0) return null;

  return (
    <SectionShell
      title={`${humanizeToken(severity)} Findings`}
      subtitle={`${items.length} persisted ${severity} finding${items.length !== 1 ? "s" : ""}`}
    >
      {items.map((finding) => (
        <div
          key={finding.id}
          className="space-y-3 border border-slate-200 bg-white p-4"
        >
          <div className="flex flex-wrap items-center gap-2">
            <AuditBadge label={finding.code} tone={severityTone(finding.severity)} />
            <AuditBadge label={humanizeToken(finding.stage)} tone="info" />
            <AuditBadge label={humanizeToken(finding.category)} tone="neutral" />
            {finding.blocking ? <AuditBadge label="Blocking" tone="critical" /> : null}
          </div>
          <div>
            <h4 className="text-lg font-semibold text-slate-950">{finding.title}</h4>
            <p className="mt-2 text-sm leading-6 text-slate-700">{finding.explanation}</p>
          </div>
          <DetailGrid
            items={[
              { label: "Observed", value: finding.observed_value || "—" },
              { label: "Expected", value: finding.expected_value || "—" },
              { label: "Classification", value: humanizeToken(finding.classification) },
              { label: "Rule Version", value: finding.rule_version },
            ]}
          />
          {finding.suggested_remediation ? (
            <div className="rounded-none border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
              <span className="font-semibold text-slate-950">Suggested remediation:</span>{" "}
              {finding.suggested_remediation}
            </div>
          ) : null}
          {finding.evidence_pointers.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                Evidence Pointers
              </p>
              <div className="flex flex-wrap gap-2">
                {finding.evidence_pointers.map((pointer, index) => (
                  <code
                    key={`${finding.id}-pointer-${index}`}
                    className="rounded-none border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700"
                  >
                    {String(pointer)}
                  </code>
                ))}
              </div>
            </div>
          ) : null}
          {Object.keys(finding.detection_metadata).length > 0 ? (
            <JsonPanel title="Detection Metadata" value={finding.detection_metadata} />
          ) : null}
        </div>
      ))}
    </SectionShell>
  );
}

function GenericListCard({
  title,
  items,
}: {
  title: string;
  items: unknown[];
}) {
  return (
    <SectionShell title={title}>
      {items.length === 0 ? (
        <p className="text-sm text-slate-500">No entries were recorded.</p>
      ) : (
        <div className="space-y-3">
          {items.map((item, index) => (
            <div key={`${title}-${index}`} className="border border-slate-200 bg-slate-50 p-4">
              {typeof item === "string" || typeof item === "number" ? (
                <p className="text-sm text-slate-700">{String(item)}</p>
              ) : (
                <pre className="overflow-x-auto text-xs leading-6 text-slate-700">
                  {JSON.stringify(item, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </SectionShell>
  );
}

function FeedbackHistoryRow({
  item,
  active,
  onSelect,
}: {
  item: BullpenRunAuditFeedbackSummary;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full border p-4 text-left transition ${
        active
          ? "border-indigo-300 bg-indigo-50"
          : "border-slate-200 bg-white hover:border-slate-300"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <AuditBadge label={humanizeToken(item.status)} tone={statusTone(item.status)} />
        <AuditBadge
          label={`${item.provider} / ${item.model}`}
          tone="info"
          className="normal-case tracking-normal"
        />
        <AuditBadge label={`Coverage ${formatPercent(item.chunk_coverage_pct)}`} tone="neutral" />
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <div className="text-sm text-slate-700">
          <span className="font-semibold text-slate-950">Created:</span>{" "}
          {formatDateTime(item.created_at)}
        </div>
        <div className="text-sm text-slate-700">
          <span className="font-semibold text-slate-950">Cost:</span>{" "}
          {formatCurrency(item.estimated_cost)}
        </div>
        <div className="text-sm text-slate-700">
          <span className="font-semibold text-slate-950">Latency:</span>{" "}
          {formatDuration(item.latency_seconds)}
        </div>
        <div className="text-sm text-slate-700">
          <span className="font-semibold text-slate-950">Snapshot Hash:</span>{" "}
          {item.snapshot_hash || "—"}
        </div>
      </div>
      {item.error_message ? (
        <p className="mt-3 text-sm text-rose-700">{item.error_message}</p>
      ) : null}
    </button>
  );
}

function FeedbackReportView({
  feedback,
}: {
  feedback: BullpenRunAuditFeedbackDetail;
}) {
  const report = asRecord(feedback.report_json) ?? {};
  const criticalFindings = asArray(report.critical_findings);
  const highFindings = asArray(report.high_findings);
  const mediumFindings = asArray(report.medium_findings);
  const lowFindings = asArray(report.low_findings);
  const rootCauseHypotheses = asArray(report.root_cause_hypotheses);
  const recommendedChanges = asArray(report.recommended_changes);
  const recommendedTests = asArray(report.recommended_tests);
  const priorityPlan = asArray(report.priority_plan);
  const dataCaptureGaps = asArray(report.data_capture_gaps);
  const codexPrompt = stringValue(report.codex_prompt, "");

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <SummaryStatCard
          label="Overall Grade"
          value={stringValue(report.overall_grade)}
          tone={stringValue(report.overall_grade) === "A" ? "success" : "warning"}
        />
        <SummaryStatCard
          label="Score"
          value={String(report.overall_score ?? "—")}
          tone="info"
        />
        <SummaryStatCard
          label="Confidence"
          value={humanizeToken(stringValue(report.confidence))}
          tone="info"
        />
        <SummaryStatCard
          label="Reliability"
          value={humanizeToken(stringValue(report.run_reliability))}
          tone={stringValue(report.run_reliability) === "reliable" ? "success" : "warning"}
        />
        <SummaryStatCard
          label="Chunk Count"
          value={String(feedback.chunk_count)}
          hint={`Coverage ${formatPercent(feedback.chunk_coverage_pct)}`}
          tone="neutral"
        />
      </div>

      <SectionShell title="Executive Summary">
        <p className="text-sm leading-6 text-slate-700">
          {stringValue(report.executive_summary)}
        </p>
      </SectionShell>

      <div className="grid gap-4 xl:grid-cols-2">
        <GenericListCard title="Critical Findings" items={criticalFindings} />
        <GenericListCard title="High Findings" items={highFindings} />
        <GenericListCard title="Medium Findings" items={mediumFindings} />
        <GenericListCard title="Low Findings" items={lowFindings} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <SectionShell title="Stage Assessments">
          <JsonPanel title="Stage 1 Assessment" value={report.stage_1_assessment} />
          <JsonPanel title="Stage 2 Assessment" value={report.stage_2_assessment} />
          <JsonPanel title="Stage 3 Assessment" value={report.stage_3_assessment} />
          <JsonPanel title="Handoff Assessment" value={report.handoff_assessment} />
        </SectionShell>
        <SectionShell title="System Assessments">
          <JsonPanel
            title="Formula and Algorithm Assessment"
            value={report.formula_and_algorithm_assessment}
          />
          <JsonPanel title="Guardrail Assessment" value={report.guardrail_assessment} />
          <JsonPanel title="Execution Assessment" value={report.execution_assessment} />
        </SectionShell>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <GenericListCard
          title="Root-Cause Hypotheses"
          items={rootCauseHypotheses}
        />
        <GenericListCard title="Data Capture Gaps" items={dataCaptureGaps} />
        <GenericListCard
          title="Recommended Code Changes"
          items={recommendedChanges}
        />
        <GenericListCard title="Recommended Tests" items={recommendedTests} />
      </div>

      <GenericListCard title="Priority Plan" items={priorityPlan} />

      <SectionShell title="Ready-to-Use Codex Prompt">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void copyText(codexPrompt)}
          >
            <Copy className="mr-2 h-4 w-4" />
            Copy Prompt
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              jsonDownload(
                `bullpen-run-audit-feedback-${feedback.id}-prompt.json`,
                { codex_prompt: codexPrompt },
              )
            }
          >
            <Download className="mr-2 h-4 w-4" />
            Download Prompt
          </Button>
        </div>
        <pre className="overflow-x-auto bg-slate-950 p-4 text-xs leading-6 text-slate-100">
          {codexPrompt || "No Codex prompt was persisted for this feedback version."}
        </pre>
      </SectionShell>

      <SectionShell title="Feedback Subcalls">
        {feedback.subcalls.length === 0 ? (
          <p className="text-sm text-slate-500">No subcall telemetry was stored yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-500">
                  <th className="px-3 py-2">Chunk</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Coverage</th>
                  <th className="px-3 py-2">Tokens</th>
                  <th className="px-3 py-2">Cost</th>
                  <th className="px-3 py-2">Latency</th>
                </tr>
              </thead>
              <tbody>
                {feedback.subcalls.map((subcall) => (
                  <tr
                    key={subcall.id}
                    className="border-b border-slate-100 text-slate-700"
                  >
                    <td className="px-3 py-2">{subcall.chunk_index}</td>
                    <td className="px-3 py-2">{humanizeToken(subcall.status)}</td>
                    <td className="px-3 py-2">{formatPercent(subcall.coverage_pct)}</td>
                    <td className="px-3 py-2">
                      {subcall.tokens_in} / {subcall.tokens_out}
                    </td>
                    <td className="px-3 py-2">{formatCurrency(subcall.estimated_cost)}</td>
                    <td className="px-3 py-2">{formatDuration(subcall.latency_seconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionShell>

      <JsonPanel title="Persisted Report JSON" value={feedback.report_json} />
    </div>
  );
}

function renderSectionData(section: string, data: unknown) {
  const record = asRecord(data);

  if (section === "overview") {
    const overview = record ?? {};
    const timeline = asArray(overview.timeline);
    return (
      <div className="space-y-4">
        <SectionShell title="Run Overview">
          <DetailGrid
            items={[
              { label: "Run Status", value: humanizeToken(stringValue(overview.run_status)) },
              { label: "Trigger", value: humanizeToken(stringValue(overview.triggered_by)) },
              { label: "Started", value: formatDateTime(typeof overview.started_at === "string" ? overview.started_at : null) },
              { label: "Completed", value: formatDateTime(typeof overview.completed_at === "string" ? overview.completed_at : null) },
              { label: "Duration", value: formatDuration(numberValue(overview.duration_seconds)) },
              { label: "Settings Hash", value: stringValue(overview.settings_hash) },
              { label: "Error Message", value: stringValue(overview.error_message) },
              { label: "Summary", value: stringValue(overview.summary) },
            ]}
          />
        </SectionShell>
        <SectionShell title="Timeline">
          <TimelineList items={timeline} />
        </SectionShell>
        <SectionShell title="Context and Diagnostics">
          <JsonPanel title="Request Context" value={overview.request_context} />
          <JsonPanel
            title="Execution Handoff Fallbacks"
            value={overview.execution_handoff}
            defaultOpen
          />
          <JsonPanel title="Settings Snapshot" value={overview.settings_snapshot} />
          <JsonPanel title="Diagnostics" value={overview.diagnostics} />
          <JsonPanel title="Code Provenance" value={overview.code_provenance} />
        </SectionShell>
      </div>
    );
  }

  if (section === "stage-1") {
    const stage = record ?? {};
    const candidateInputs = asArray(stage.candidate_inputs);
    const candidateReviews = asArray(stage.candidate_reviews);
    const activePositions = asArray(stage.active_positions);
    const runStages = asArray(stage.run_stages);
    const verifiedPortfolio = asRecord(stage.verified_portfolio_snapshot);
    const portfolioSnapshotAvailable =
      verifiedPortfolio !== null &&
      typeof verifiedPortfolio.verified === "boolean";
    const portfolioSnapshotIsVerified =
      portfolioSnapshotAvailable && verifiedPortfolio.verified === true;
    const portfolioSnapshotStatus = portfolioSnapshotAvailable
      ? portfolioSnapshotIsVerified
        ? "Verified"
        : "Unverified"
      : "Unavailable";
    const portfolioSnapshotMetricPrefix = portfolioSnapshotAvailable
      ? portfolioSnapshotStatus
      : "Portfolio Snapshot";
    const portfolioSnapshotVerificationReason = portfolioSnapshotAvailable
      ? stringValue(
          verifiedPortfolio.verification_reason,
          portfolioSnapshotIsVerified
            ? "Stage 1 portfolio snapshot verification passed."
            : "Stage 1 portfolio snapshot verification was not confirmed.",
        )
      : "No Stage 1 portfolio snapshot was captured.";
    const verifiedPositionRows = asArray(
      verifiedPortfolio?.active_positions_found,
    );
    const scanContext = asRecord(stage.scan_context);
    return (
      <div className="space-y-4">
        <SectionShell title="Stage 1 Summary">
          <DetailGrid
            items={[
              { label: "Run Stage Records", value: String(runStages.length) },
              { label: "Raw Candidate Inputs", value: String(candidateInputs.length) },
              { label: "Candidate Reviews", value: String(candidateReviews.length) },
              { label: "Active Positions", value: String(activePositions.length) },
              {
                label: "Portfolio Snapshot Status",
                value: portfolioSnapshotStatus,
              },
              {
                label: "Verification Reason",
                value: portfolioSnapshotVerificationReason,
              },
              {
                label: `${portfolioSnapshotMetricPrefix} Portfolio Positions`,
                value: portfolioSnapshotAvailable
                  ? String(verifiedPositionRows.length)
                  : "—",
              },
              {
                label: `${portfolioSnapshotMetricPrefix} Available Slots`,
                value: String(verifiedPortfolio?.available_slots ?? "—"),
              },
              {
                label: `${portfolioSnapshotMetricPrefix} Trade Amount`,
                value:
                  typeof verifiedPortfolio?.trade_amount_usd === "number"
                    ? formatCurrency(verifiedPortfolio.trade_amount_usd)
                    : "—",
              },
              { label: "Scan Source", value: stringValue(scanContext?.scan_source_label) },
              { label: "Scanned Candidates", value: String(scanContext?.scanned_candidates ?? "—") },
              { label: "Rows Before LLM", value: String(scanContext?.candidate_rows_before_llm ?? "—") },
              { label: "Manual Rows Reused", value: String(scanContext?.used_manual_console_rows ?? "—") },
              { label: "Wallet Snapshot", value: stringValue(scanContext?.wallet_snapshot_status) },
              { label: "Wallet Handoff Budget", value: scanContext?.wallet_refresh_timeout_seconds ? `${String(scanContext.wallet_refresh_timeout_seconds)} sec` : "—" },
            ]}
          />
        </SectionShell>
        {scanContext?.stage2_candidate_only === true ? (
          <SectionShell
            title="Wallet Handoff Safety Gate"
            subtitle="The fresh wallet read timed out or was contended. Stage 2 continued in read-only candidate mode; Stage 3 was blocked, so no orders could be planned or submitted."
          >
            <p className="text-sm text-slate-700">
              {stringValue(scanContext.wallet_refresh_error) || "Fresh wallet state was unavailable for this run."}
            </p>
          </SectionShell>
        ) : null}
        <JsonPanel title="Scan Context" value={stage.scan_context} defaultOpen />
        <JsonPanel
          title={`${portfolioSnapshotStatus} Stage 1 Portfolio Snapshot`}
          value={portfolioSnapshotAvailable ? verifiedPortfolio : null}
          defaultOpen
        />
        <JsonPanel title="Run Stage Records" value={runStages} />
        <JsonPanel title="Candidate Inputs" value={candidateInputs} />
        <JsonPanel title="Candidate Reviews" value={candidateReviews} />
        <JsonPanel title="Active Positions" value={activePositions} />
      </div>
    );
  }

  if (section === "stage-2") {
    const stage = record ?? {};
    const candidateReviews = asArray(stage.candidate_reviews);
    const llmInvocations = asArray(stage.llm_invocations);
    const qualifiedIds = asArray(stage.qualified_candidate_market_ids);
    const handoffIds = asArray(stage.stage3_handoff_candidate_market_ids);
    const runStages = asArray(stage.run_stages);
    const universeStatus = asRecord(stage.universe_status);
    const candidateOnly = stage.candidate_only === true;
    return (
      <div className="space-y-4">
        <SectionShell title="Stage 2 Summary">
          <DetailGrid
            items={[
              { label: "Run Stage Records", value: String(runStages.length) },
              { label: "Candidate Reviews", value: String(candidateReviews.length) },
              { label: "LLM Invocations", value: String(llmInvocations.length) },
              { label: "Qualified Candidates", value: String(qualifiedIds.length) },
              { label: "Stage 3 Handoff Rows", value: String(handoffIds.length) },
              { label: "Configured Targets", value: String(asRecord(stage.llm_runtime)?.llm_target_count ?? "—") },
              { label: "Runtime Coverage", value: String(asRecord(stage.llm_runtime)?.llm_target_count ?? "—") },
              { label: "Eligible Rows", value: String(universeStatus?.total_eligible_rows ?? "—") },
              { label: "Reviewed Rows", value: String(universeStatus?.reviewed_rows ?? "—") },
              { label: "Skipped Rows", value: String(universeStatus?.skipped_rows ?? "—") },
              {
                label: "Universe Complete",
                value:
                  universeStatus?.is_complete === false
                    ? "No"
                    : universeStatus?.is_complete === true
                      ? "Yes"
                      : "—",
              },
              { label: "Selected Model Mix", value: stringValue(asRecord(stage.llm_runtime)?.llm_execution_mode) },
              { label: "Prompt Version", value: stringValue(asRecord(stage.llm_runtime)?.prompt_version) },
              { label: "Candidate-only Review", value: candidateOnly ? "Yes" : "No" },
            ]}
          />
        </SectionShell>
        {candidateOnly ? (
          <SectionShell
            title="Read-only Candidate Review"
            subtitle="Stage 2 ran without a fresh wallet snapshot. Its output is analysis only; Stage 3 execution was deliberately blocked."
          >
            <p className="text-sm text-slate-700">
              {stringValue(stage.stage1_wallet_refresh_error) || "Fresh wallet state was unavailable for this run."}
            </p>
          </SectionShell>
        ) : null}
        {universeStatus?.is_complete === false &&
        (stringValue(universeStatus?.blocker_summary) ||
          stringValue(universeStatus?.blocker_fix)) ? (
          <SectionShell
            title="Universe Blocker"
            subtitle="Why Stage 2 could not finish the full eligible-universe review and the recommended remediation."
          >
            <div className="space-y-2 text-sm text-slate-700">
              {stringValue(universeStatus?.blocker_summary) ? (
                <p>
                  <span className="font-semibold text-slate-950">Why:</span>{" "}
                  {stringValue(universeStatus?.blocker_summary)}
                </p>
              ) : null}
              {stringValue(universeStatus?.blocker_fix) ? (
                <p>
                  <span className="font-semibold text-slate-950">What to do:</span>{" "}
                  {stringValue(universeStatus?.blocker_fix)}
                </p>
              ) : null}
            </div>
          </SectionShell>
        ) : null}
        <JsonPanel title="LLM Runtime" value={stage.llm_runtime} defaultOpen />
        <JsonPanel title="Universe Status" value={stage.universe_status} />
        <JsonPanel title="Run Stage Records" value={runStages} />
        <JsonPanel title="LLM Invocations" value={llmInvocations} />
        <JsonPanel title="Candidate Reviews" value={candidateReviews} />
        <JsonPanel title="Qualified Candidate IDs" value={qualifiedIds} />
        <JsonPanel title="Stage 3 Handoff Candidate IDs" value={handoffIds} />
      </div>
    );
  }

  if (section === "stage-3") {
    const stage = record ?? {};
    const decisions = asArray(stage.decisions);
    const decisionRows = asArray(stage.decision_rows);
    const orderIntents = asArray(stage.order_intents);
    const handoffIds = asArray(stage.stage2_handoff_candidate_market_ids);
    const runStages = asArray(stage.run_stages);
    const recovery = asRecord(stage.recovery);
    const handoffCheckpoint = asRecord(stage.handoff_checkpoint);
    const checkpointCandidateIds = asArray(handoffCheckpoint?.candidate_market_ids);
    const persistedCounters = asRecord(stage.persisted_execution_counters);
    const blockedByWalletRefresh = stage.blocked_by_stage1_wallet_refresh === true;
    return (
      <div className="space-y-4">
        <SectionShell title="Stage 3 Summary">
          <DetailGrid
            items={[
              { label: "Run Stage Records", value: String(runStages.length) },
              { label: "Decision Rows", value: String(decisionRows.length) },
              { label: "Decisions", value: String(decisions.length) },
              { label: "Order Intents", value: String(orderIntents.length) },
              { label: "Execution Steps", value: String(asArray(stage.execution_steps).length) },
              { label: "Max Positions", value: String(stage.max_positions ?? "—") },
              { label: "Stage 2 Handoff Rows", value: String(handoffIds.length) },
              {
                label: "Handoff Checkpoint",
                value: handoffCheckpoint
                  ? humanizeToken(stringValue(handoffCheckpoint.status, "unknown"))
                  : "Legacy / not captured",
              },
              {
                label: "Checkpoint Candidates",
                value: handoffCheckpoint ? String(checkpointCandidateIds.length) : "—",
              },
              { label: "Order Metrics", value: String(Object.keys(asRecord(stage.order_metrics) ?? {}).length) },
              { label: "Selected Decisions", value: String(decisions.filter((item) => asRecord(item)?.stage3_result === "SELECTED").length) },
              { label: "Recovery Required", value: recovery?.required ? "Yes" : "No" },
              { label: "Counter Source", value: String(persistedCounters?.source ?? "legacy") },
              { label: "Blocked by Wallet Refresh", value: blockedByWalletRefresh ? "Yes" : "No" },
            ]}
          />
        </SectionShell>
        {handoffCheckpoint ? (
          <SectionShell
            title="Stage 2 to Stage 3 Handoff Checkpoint"
            subtitle={
              decisions.length === 0 && orderIntents.length === 0
                ? "Stage 3 received the saved transfer queue but did not persist concrete decisions or orders before this snapshot."
                : "The saved Stage 2 transfer queue was durably received before Stage 3 planning."
            }
          >
            <DetailGrid
              items={[
                { label: "Status", value: stringValue(handoffCheckpoint.status) },
                { label: "Received At", value: stringValue(handoffCheckpoint.received_at) },
                { label: "Candidate IDs", value: String(checkpointCandidateIds.length) },
                {
                  label: "Decision Rows at Receipt",
                  value: String(handoffCheckpoint.decision_rows_persisted ?? "—"),
                },
              ]}
            />
          </SectionShell>
        ) : null}
        {blockedByWalletRefresh ? (
          <SectionShell
            title="Execution Safely Blocked"
            subtitle="Stage 3 did not create decisions or order intents because Stage 1 could not obtain a fresh wallet snapshot."
          >
            <p className="text-sm text-slate-700">
              {stringValue(stage.stage1_wallet_refresh_error) || "Fresh wallet state was unavailable for this run."}
            </p>
          </SectionShell>
        ) : null}
        <JsonPanel title="Order Metrics" value={stage.order_metrics} defaultOpen />
        <JsonPanel title="Execution Steps" value={stage.execution_steps} />
        <JsonPanel title="Persisted Execution Counters" value={stage.persisted_execution_counters} defaultOpen />
        <JsonPanel title="Restart Recovery" value={stage.recovery} />
        <JsonPanel title="Stage 2 Handoff Candidate IDs" value={handoffIds} />
        <JsonPanel title="Stage 2 to Stage 3 Handoff Checkpoint" value={handoffCheckpoint} />
        <JsonPanel title="Run Stage Records" value={runStages} />
        <JsonPanel title="Decision Rows" value={decisionRows} />
        <JsonPanel title="Decisions" value={decisions} />
        <JsonPanel title="Order Intents" value={orderIntents} />
      </div>
    );
  }

  if (section === "formulas") {
    const items = asArray(data);
    return (
      <div className="space-y-4">
        <SectionShell
          title="Formula and Algorithm Ledger"
          subtitle="Persisted formula inputs, intermediates, outputs, hashes, and validation status."
        >
          {items.length === 0 ? (
            <p className="text-sm text-slate-500">No formula ledger entries were persisted.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-slate-500">
                    <th className="px-3 py-2">Algorithm</th>
                    <th className="px-3 py-2">Stage</th>
                    <th className="px-3 py-2">Scope</th>
                    <th className="px-3 py-2">Version</th>
                    <th className="px-3 py-2">Validation</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, index) => {
                    const row = asRecord(item);
                    if (!row) return null;
                    return (
                      <tr key={`${row.algorithm_key || index}`} className="border-b border-slate-100 text-slate-700">
                        <td className="px-3 py-2">{stringValue(row.human_name)}</td>
                        <td className="px-3 py-2">{row.logical_stage_number ? `Stage ${row.logical_stage_number}` : "—"}</td>
                        <td className="px-3 py-2">{stringValue(row.scope_id, stringValue(row.scope_type))}</td>
                        <td className="px-3 py-2">{stringValue(row.algorithm_version)}</td>
                        <td className="px-3 py-2">{humanizeToken(stringValue(row.validation_status))}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </SectionShell>
        <JsonPanel title="Formula Ledger JSON" value={items} />
      </div>
    );
  }

  if (section === "guardrails") {
    const guardrails = record ?? {};
    return (
      <div className="space-y-4">
        <SectionShell title="Guardrails Summary">
          <DetailGrid
            items={[
              { label: "Run Guardrails", value: String(asArray(guardrails.run_guardrails).length) },
              { label: "Decision Guardrails", value: String(asArray(guardrails.decision_guardrails).length) },
            ]}
          />
        </SectionShell>
        <JsonPanel title="Run Guardrails" value={guardrails.run_guardrails} defaultOpen />
        <JsonPanel title="Decision Guardrails" value={guardrails.decision_guardrails} />
      </div>
    );
  }

  if (section === "raw") {
    const raw = record ?? {};
    return (
      <div className="space-y-4">
        {Object.entries(raw).map(([key, value]) => (
          <JsonPanel
            key={key}
            title={humanizeToken(key)}
            value={value}
            defaultOpen={key === "run_payload"}
          />
        ))}
      </div>
    );
  }

  return <JsonPanel title={humanizeToken(section)} value={data} defaultOpen />;
}

export function RunAuditDetailClient() {
  const params = useParams<{ runId: string }>();
  const runId = params?.runId;

  const [detail, setDetail] = useState<BullpenRunAuditDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<RunAuditLoadError | null>(null);
  const [activeSection, setActiveSection] = useState("overview");
  const [sections, setSections] = useState<SectionMap>({});
  const [sectionLoading, setSectionLoading] = useState<string | null>(null);
  const [sectionError, setSectionError] = useState<string | null>(null);
  const [materializing, setMaterializing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [remarkScopeType, setRemarkScopeType] = useState<(typeof auditScopeOptions)[number]>("run");
  const [remarkScopeId, setRemarkScopeId] = useState("");
  const [remarkType, setRemarkType] = useState("note");
  const [remarkBody, setRemarkBody] = useState("");
  const [supersedesRemarkId, setSupersedesRemarkId] = useState("");
  const [savingRemark, setSavingRemark] = useState(false);
  const [manualEdits, setManualEdits] = useState<ManualEditMap>({});
  const [savingManualId, setSavingManualId] = useState<number | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [selectedModelKey, setSelectedModelKey] = useState<string | null>(null);
  const [forceRerunFeedback, setForceRerunFeedback] = useState(false);
  const [submittingFeedback, setSubmittingFeedback] = useState(false);
  const [feedbackDetails, setFeedbackDetails] = useState<Record<number, BullpenRunAuditFeedbackDetail | undefined>>({});
  const [activeFeedbackId, setActiveFeedbackId] = useState<number | null>(null);
  const [feedbackDetailLoading, setFeedbackDetailLoading] = useState(false);
  const [feedbackDetailError, setFeedbackDetailError] = useState<string | null>(null);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;

    async function loadDetail() {
      setLoading(true);
      setLoadError(null);
      try {
        const nextDetail = await apiService.getBullpenRunAuditDetail(runId);
        if (!cancelled) {
          setDetail(nextDetail);
          setSections({});
        }
      } catch (nextError) {
        if (!cancelled) {
          setLoadError(parseRunAuditLoadError(nextError, runId));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadDetail();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;

    async function loadProviders() {
      setProvidersLoading(true);
      try {
        const nextProviders = await apiService.getProviders({
          prompt: "Bullpen run audit feedback",
        });
        if (!cancelled) {
          setProviders(nextProviders);
        }
      } catch {
        if (!cancelled) {
          setProviders([]);
        }
      } finally {
        if (!cancelled) {
          setProvidersLoading(false);
        }
      }
    }

    void loadProviders();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  useEffect(() => {
    if (!detail?.available_sections.includes(activeSection) || !runId) return;
    if (sections[activeSection]) return;
    let cancelled = false;

    async function loadSection() {
      setSectionLoading(activeSection);
      setSectionError(null);
      try {
        const nextSection = await apiService.getBullpenRunAuditSection(runId, activeSection);
        if (!cancelled) {
          setSections((current) => ({
            ...current,
            [activeSection]: nextSection,
          }));
        }
      } catch (nextError) {
        if (!cancelled) {
          setSectionError(
            nextError instanceof Error
              ? nextError.message
              : `Failed to load ${activeSection}.`,
          );
        }
      } finally {
        if (!cancelled) {
          setSectionLoading(null);
        }
      }
    }

    void loadSection();
    return () => {
      cancelled = true;
    };
  }, [activeSection, detail?.available_sections, runId, sections]);

  useEffect(() => {
    const feedbackId = activeFeedbackId ?? detail?.feedback_history[0]?.id;
    if (feedbackId == null || !runId) return;
    if (feedbackDetails[feedbackId]) return;
    const resolvedFeedbackId = feedbackId;
    let cancelled = false;

    async function loadFeedbackDetail() {
      setFeedbackDetailLoading(true);
      setFeedbackDetailError(null);
      try {
        const nextDetail = await apiService.getBullpenRunAuditFeedbackDetail(
          runId,
          resolvedFeedbackId,
        );
        if (!cancelled) {
          setFeedbackDetails((current) => ({
            ...current,
            [resolvedFeedbackId]: nextDetail,
          }));
        }
      } catch (nextError) {
        if (!cancelled) {
          setFeedbackDetailError(
            nextError instanceof Error
              ? nextError.message
              : "Failed to load feedback detail.",
          );
        }
      } finally {
        if (!cancelled) {
          setFeedbackDetailLoading(false);
        }
      }
    }

    void loadFeedbackDetail();
    return () => {
      cancelled = true;
    };
  }, [activeFeedbackId, detail?.feedback_history, feedbackDetails, runId]);

  useEffect(() => {
    const feedbackId = activeFeedbackId ?? detail?.feedback_history[0]?.id;
    if (!detail?.feedback_history.some((item) => ["queued", "processing"].includes(item.status)) || !runId) {
      return;
    }

    const interval = window.setInterval(async () => {
      try {
        const nextDetail = await apiService.getBullpenRunAuditDetail(runId);
        setDetail(nextDetail);
        if (feedbackId) {
          const nextFeedbackDetail = await apiService.getBullpenRunAuditFeedbackDetail(
            runId,
            feedbackId,
          );
          setFeedbackDetails((current) => ({
            ...current,
            [feedbackId]: nextFeedbackDetail,
          }));
        }
      } catch {
        return;
      }
    }, 4000);

    return () => {
      window.clearInterval(interval);
    };
  }, [activeFeedbackId, detail?.feedback_history, runId]);

  const groupedFindings = useMemo(() => {
    const result: Record<(typeof severityOrder)[number], BullpenRunAuditDetailResponse["findings"]> = {
      critical: [],
      high: [],
      medium: [],
      low: [],
      info: [],
    };
    for (const finding of detail?.findings ?? []) {
      if (severityOrder.includes(finding.severity)) {
        result[finding.severity].push(finding);
      }
    }
    return result;
  }, [detail?.findings]);

  const resolvedActiveFeedbackId =
    activeFeedbackId ?? detail?.feedback_history[0]?.id ?? null;

  const resolvedSelectedModelKey = (() => {
    if (selectedModelKey) return selectedModelKey;
    if (providers.length === 0) return null;
    const feedbackTarget = detail?.feedback_history[0]
      ? modelKey(detail.feedback_history[0].provider, detail.feedback_history[0].model)
      : null;
    const allModelKeys = providers.flatMap((provider) =>
      provider.models
        .filter(
          (model) =>
            provider.configured &&
            provider.model_compatibility?.[model]?.compatible !== false,
        )
        .map((model) => modelKey(provider.name, model)),
    );
    return feedbackTarget && allModelKeys.includes(feedbackTarget)
      ? feedbackTarget
      : allModelKeys[0] ?? null;
  })();

  const activeFeedbackDetail =
    resolvedActiveFeedbackId !== null
      ? feedbackDetails[resolvedActiveFeedbackId]
      : undefined;

  if (loading) {
    return (
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6">
        <Card className="rounded-none border-slate-200 shadow-none">
          <CardContent className="py-10 text-sm text-slate-500">
            Loading Bullpen run audit workspace…
          </CardContent>
        </Card>
      </div>
    );
  }

  if (loadError || !detail) {
    const displayedError = loadError ?? parseRunAuditLoadError(null, runId || "unknown");
    return (
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6">
        <Card className="rounded-none border-rose-200 bg-rose-50 shadow-none">
          <CardHeader className="border-b border-rose-200">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-700" />
              <div>
                <CardTitle className="text-lg text-rose-950">Run audit could not be opened</CardTitle>
                <p className="mt-2 text-sm leading-6 text-rose-800">{displayedError.summary}</p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-5 py-6">
            <DetailGrid
              items={[
                { label: "HTTP Status", value: displayedError.httpStatus ? String(displayedError.httpStatus) : "Unavailable" },
                { label: "Error Code", value: displayedError.code || "Unavailable" },
                { label: "Failed Phase", value: humanizeToken(displayedError.failedPhase || "unknown") },
                { label: "Cause Type", value: displayedError.causeType || "Unavailable" },
                { label: "Run ID", value: displayedError.runId },
                { label: "Diagnostic ID", value: displayedError.diagnosticId || "Unavailable" },
              ]}
            />
            {displayedError.technicalDetail ? (
              <div className="border border-rose-200 bg-white p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-rose-700">Technical detail</p>
                <code className="mt-2 block whitespace-pre-wrap break-words text-sm leading-6 text-slate-800">
                  {displayedError.technicalDetail}
                </code>
              </div>
            ) : null}
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="border border-amber-200 bg-amber-50 p-4">
                <p className="text-sm font-semibold text-amber-950">Likely cause</p>
                <p className="mt-2 text-sm leading-6 text-amber-900">
                  {displayedError.likelyCause || "The backend could not provide additional cause information."}
                </p>
                {displayedError.requiredMigration ? (
                  <p className="mt-2 text-sm text-amber-900">
                    Required migration: <code>{displayedError.requiredMigration}</code>
                  </p>
                ) : null}
              </div>
              <div className="border border-slate-200 bg-white p-4">
                <p className="text-sm font-semibold text-slate-950">Steps to fix</p>
                <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm leading-6 text-slate-700">
                  {displayedError.fixSteps.map((step) => <li key={step}>{step}</li>)}
                </ol>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => window.location.reload()}>
                <RefreshCw className="mr-2 h-4 w-4" /> Retry
              </Button>
              <Button
                variant="outline"
                disabled={materializing || !runId}
                onClick={async () => {
                  if (!runId) return;
                  setMaterializing(true);
                  try {
                    await apiService.materializeBullpenRunAudit(runId);
                    const refreshed = await apiService.getBullpenRunAuditDetail(runId);
                    setDetail(refreshed);
                    setSections({});
                    setLoadError(null);
                  } catch (nextError) {
                    setLoadError(parseRunAuditLoadError(nextError, runId));
                  } finally {
                    setMaterializing(false);
                  }
                }}
              >
                {materializing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                Rematerialize
              </Button>
              <Button asChild variant="outline">
                <Link href={URLs.routes.console.bullpenAiAnalyseRuns()}>Back to Runs Audit</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const snapshot = detail.snapshot;
  const latestRemarks = detail.remarks;
  const latestManualChecks = detail.latest_manual_checks;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-3">
          <Button asChild variant="outline" size="sm">
            <Link href={URLs.routes.console.bullpenAiAnalyseRuns()}>
              Back to Runs Audit
            </Link>
          </Button>
          <div className="space-y-2">
            <p className="text-sm font-semibold uppercase tracking-[0.22em] text-purple-600">
              Trade Analysis
            </p>
            <h1 className="text-3xl font-bold tracking-tight text-slate-950">
              Bullpen Run Audit
            </h1>
            <p className="text-sm text-slate-600">Run ID: {snapshot.run_id}</p>
            <div className="flex flex-wrap gap-2">
              <AuditBadge label={humanizeToken(snapshot.run_status)} tone={statusTone(snapshot.run_status)} />
              <AuditBadge label={`Audit ${humanizeToken(snapshot.audit_status)}`} tone={statusTone(snapshot.audit_status)} />
              <AuditBadge label={snapshot.dry_run ? "Dry Run" : "Live Requested"} tone={snapshot.dry_run ? "info" : "warning"} />
              <AuditBadge label={humanizeToken(snapshot.source_kind)} tone={snapshot.source_kind === "native" ? "success" : "info"} />
              <AuditBadge label={humanizeToken(snapshot.lifecycle_status)} tone={statusTone(snapshot.lifecycle_status)} />
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={materializing}
            onClick={async () => {
              if (!runId) return;
              setMaterializing(true);
              try {
                await apiService.materializeBullpenRunAudit(runId);
                const refreshed = await apiService.getBullpenRunAuditDetail(runId);
                setDetail(refreshed);
                setSections({});
              } finally {
                setMaterializing(false);
              }
            }}
          >
            {materializing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            Rematerialize
          </Button>
          <Button
            variant="outline"
            onClick={() => void copyText(snapshot.canonical_bundle_hash || "")}
          >
            <Copy className="mr-2 h-4 w-4" />
            Copy Snapshot Hash
          </Button>
          <Button
            variant="outline"
            disabled={exporting}
            onClick={async () => {
              if (!runId) return;
              setExporting(true);
              try {
                const bundle = await apiService.exportBullpenRunAudit(runId);
                jsonDownload(`bullpen-run-audit-${runId}.json`, bundle);
              } finally {
                setExporting(false);
              }
            }}
          >
            {exporting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            Download Audit JSON
          </Button>
        </div>
      </div>

      <Card className="rounded-none border-slate-200 shadow-none">
        <CardContent className="grid gap-4 p-5 md:grid-cols-2 xl:grid-cols-5">
          <SummaryStatCard label="Started" value={formatDateTime(snapshot.started_at)} />
          <SummaryStatCard
            label="Completed"
            value={formatDateTime(snapshot.completed_at)}
          />
          <SummaryStatCard
            label="Duration"
            value={formatDuration(snapshot.duration_seconds)}
          />
          <SummaryStatCard
            label="Completeness"
            value={formatPercent(snapshot.completeness_pct)}
            tone={snapshot.completeness_pct >= 90 ? "success" : "warning"}
          />
          <SummaryStatCard
            label="Snapshot Version"
            value={`${snapshot.snapshot_version}`}
            hint={`Schema ${snapshot.snapshot_schema_version}`}
          />
        </CardContent>
      </Card>

      <Card className="rounded-none border-slate-200 shadow-none">
        <CardHeader>
          <CardTitle className="text-base text-slate-950">Run Identity and Provenance</CardTitle>
        </CardHeader>
        <CardContent>
          <DetailGrid
            items={[
              { label: "Trigger", value: humanizeToken(snapshot.triggered_by) },
              { label: "Execution Version", value: snapshot.execution_version || "—" },
              { label: "Strategy Version", value: snapshot.strategy_version || "—" },
              { label: "Backend SHA", value: snapshot.backend_commit_sha || "—" },
              { label: "Frontend SHA", value: snapshot.frontend_build_sha || "—" },
              { label: "Deployment ID", value: snapshot.deployment_id || "—" },
              { label: "Build Time", value: snapshot.build_time || "—" },
              { label: "Alembic Revision", value: snapshot.alembic_revision || "—" },
              { label: "Settings Hash", value: snapshot.settings_hash || "—" },
              { label: "Bundle Hash", value: snapshot.canonical_bundle_hash || "—" },
            ]}
          />
        </CardContent>
      </Card>

      {snapshot.missing_fields.length > 0 ? (
        <Card className="rounded-none border-amber-200 bg-amber-50 shadow-none">
          <CardContent className="space-y-3 py-5">
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-amber-700">
              Legacy Capture Gap Notice
            </p>
            <p className="text-sm leading-6 text-amber-900">
              This snapshot is missing data that was not originally captured by the
              historical run. The audit preserves those gaps explicitly instead of
              inventing missing facts.
            </p>
            <JsonPanel title="Missing Fields" value={snapshot.missing_fields} defaultOpen />
          </CardContent>
        </Card>
      ) : null}

      <div className="space-y-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
            Section I
          </p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-950">
            Complete Run Record
          </h2>
        </div>

        <Tabs value={activeSection} onValueChange={setActiveSection} className="space-y-4">
          <TabsList className="h-auto w-full flex-wrap justify-start rounded-none border border-slate-200 bg-white p-1">
            {detail.available_sections.map((section) => (
              <TabsTrigger
                key={section}
                value={section}
                className="rounded-none px-3 py-2 text-xs uppercase tracking-[0.16em]"
              >
                {humanizeToken(section)}
              </TabsTrigger>
            ))}
          </TabsList>

          {detail.available_sections.map((section) => (
            <TabsContent key={section} value={section} className="space-y-4">
              {sectionLoading === section ? (
                <Card className="rounded-none border-slate-200 shadow-none">
                  <CardContent className="py-10 text-sm text-slate-500">
                    Loading {humanizeToken(section)}…
                  </CardContent>
                </Card>
              ) : sectionError && activeSection === section ? (
                <Card className="rounded-none border-rose-200 bg-rose-50 shadow-none">
                  <CardContent className="py-6 text-sm text-rose-700">
                    {sectionError}
                  </CardContent>
                </Card>
              ) : sections[section] ? (
                renderSectionData(section, sections[section]?.data)
              ) : (
                <Card className="rounded-none border-slate-200 shadow-none">
                  <CardContent className="py-10 text-sm text-slate-500">
                    {humanizeToken(section)} has not been requested yet.
                  </CardContent>
                </Card>
              )}
            </TabsContent>
          ))}
        </Tabs>
      </div>

      <div className="space-y-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
            Section II
          </p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-950">
            Errors, Validation Failures and Manual Checks
          </h2>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <SummaryStatCard
            label="Critical"
            value={String(detail.findings_summary.critical || 0)}
            tone="critical"
          />
          <SummaryStatCard
            label="High"
            value={String(detail.findings_summary.high || 0)}
            tone="high"
          />
          <SummaryStatCard
            label="Validation Failures"
            value={String(detail.findings_summary.validation_failures || 0)}
            tone="warning"
          />
          <SummaryStatCard
            label="Manual Deficiencies"
            value={String(detail.findings_summary.manual_deficiencies || 0)}
            tone="warning"
          />
        </div>

        {severityOrder.map((severity) => (
          <FindingsGroup
            key={severity}
            severity={severity}
            items={groupedFindings[severity]}
          />
        ))}

        <SectionShell
          title="Manual Audit Checklist"
          subtitle="Each update appends a new audit record and preserves history."
        >
          <div className="space-y-4">
            {latestManualChecks.map((check) => {
              const edit = manualEdits[check.id] || {
                status: check.status,
                remark: check.remark || "",
              };
              const historyCount = detail.manual_check_history.filter(
                (item) => item.check_key === check.check_key,
              ).length;
              return (
                <div key={check.id} className="border border-slate-200 bg-white p-4">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <AuditBadge
                          label={humanizeToken(check.status)}
                          tone={statusTone(check.status)}
                        />
                        <AuditBadge label={check.check_key} tone="neutral" />
                        <AuditBadge label={`${historyCount} version${historyCount !== 1 ? "s" : ""}`} tone="info" />
                      </div>
                      <div>
                        <h3 className="text-base font-semibold text-slate-950">
                          {check.check_label}
                        </h3>
                        <p className="mt-1 text-sm text-slate-600">
                          {check.description || "No checklist description was stored."}
                        </p>
                      </div>
                    </div>
                    <p className="text-sm text-slate-500">
                      Updated {formatDateTime(check.updated_at)}
                    </p>
                  </div>
                  <div className="mt-4 grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)_auto]">
                    <label className="space-y-2 text-sm text-slate-700">
                      <span>Status</span>
                      <select
                        className={runAuditSelectClassName}
                        value={edit.status}
                        onChange={(event) =>
                          setManualEdits((current) => ({
                            ...current,
                            [check.id]: {
                              ...edit,
                              status: event.target.value as BullpenRunAuditManualCheck["status"],
                            },
                          }))
                        }
                      >
                        <option value="unchecked">Unchecked</option>
                        <option value="pass">Pass</option>
                        <option value="fail">Fail</option>
                        <option value="not_applicable">Not applicable</option>
                      </select>
                    </label>
                    <label className="space-y-2 text-sm text-slate-700">
                      <span>Remark</span>
                      <textarea
                        className="min-h-24 w-full rounded-none border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400"
                        value={edit.remark}
                        onChange={(event) =>
                          setManualEdits((current) => ({
                            ...current,
                            [check.id]: {
                              ...edit,
                              remark: event.target.value,
                            },
                          }))
                        }
                        placeholder="Record the audit evidence or why this check failed."
                      />
                    </label>
                    <div className="flex items-end">
                      <Button
                        disabled={savingManualId === check.id || !runId}
                        onClick={async () => {
                          if (!runId) return;
                          setSavingManualId(check.id);
                          try {
                            await apiService.updateBullpenRunAuditManualCheck(runId, {
                              check_key: check.check_key,
                              status: edit.status,
                              scope_type: check.scope_type,
                              scope_id: check.scope_id,
                              remark: edit.remark || null,
                              metadata: check.metadata,
                            });
                            const refreshed = await apiService.getBullpenRunAuditDetail(runId);
                            setDetail(refreshed);
                          } finally {
                            setSavingManualId(null);
                          }
                        }}
                      >
                        {savingManualId === check.id ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : null}
                        Save Check
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <JsonPanel title="Manual Check History" value={detail.manual_check_history} />
        </SectionShell>

        <SectionShell
          title="Remarks"
          subtitle="Remarks are append-only audit records. Superseding a remark preserves the original."
        >
          <div className="space-y-3">
            {latestRemarks.length === 0 ? (
              <p className="text-sm text-slate-500">No audit remarks have been recorded yet.</p>
            ) : (
              latestRemarks.map((remark) => (
                <div key={remark.id} className="border border-slate-200 bg-white p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <AuditBadge label={humanizeToken(remark.scope_type)} tone="info" />
                    <AuditBadge label={humanizeToken(remark.remark_type)} tone="neutral" />
                    {remark.scope_id ? <AuditBadge label={remark.scope_id} tone="neutral" /> : null}
                    {remark.supersedes_remark_id ? (
                      <AuditBadge
                        label={`Supersedes #${remark.supersedes_remark_id}`}
                        tone="warning"
                      />
                    ) : null}
                  </div>
                  <p className="mt-3 text-sm leading-6 text-slate-700">{remark.body}</p>
                  <p className="mt-3 text-sm text-slate-500">
                    {remark.author_label || "Unknown author"} · {formatDateTime(remark.created_at)}
                  </p>
                </div>
              ))
            )}
          </div>

          <div className="grid gap-4 border border-slate-200 bg-slate-50 p-4 xl:grid-cols-2">
            <label className="space-y-2 text-sm text-slate-700">
              <span>Scope Type</span>
              <select
                className={runAuditSelectClassName}
                value={remarkScopeType}
                onChange={(event) =>
                  setRemarkScopeType(
                    event.target.value as (typeof auditScopeOptions)[number],
                  )
                }
              >
                {auditScopeOptions.map((option) => (
                  <option key={option} value={option}>
                    {humanizeToken(option)}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-2 text-sm text-slate-700">
              <span>Scope ID</span>
              <Input
                value={remarkScopeId}
                onChange={(event) => setRemarkScopeId(event.target.value)}
                placeholder="Optional stage, event, formula, or order identifier"
              />
            </label>
            <label className="space-y-2 text-sm text-slate-700">
              <span>Remark Type</span>
              <Input
                value={remarkType}
                onChange={(event) => setRemarkType(event.target.value)}
                placeholder="note"
              />
            </label>
            <label className="space-y-2 text-sm text-slate-700">
              <span>Supersede Existing Remark</span>
              <select
                className={runAuditSelectClassName}
                value={supersedesRemarkId}
                onChange={(event) => setSupersedesRemarkId(event.target.value)}
              >
                <option value="">None</option>
                {latestRemarks.map((remark) => (
                  <option key={remark.id} value={String(remark.id)}>
                    #{remark.id} · {remark.scope_type} · {remark.remark_type}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-2 text-sm text-slate-700 xl:col-span-2">
              <span>Remark Body</span>
              <textarea
                className="min-h-32 w-full rounded-none border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400"
                value={remarkBody}
                onChange={(event) => setRemarkBody(event.target.value)}
                placeholder="Record the audit note, scope, and evidence."
              />
            </label>
          </div>

          <div>
            <Button
              disabled={savingRemark || !remarkBody.trim() || !runId}
              onClick={async () => {
                if (!runId) return;
                setSavingRemark(true);
                try {
                  await apiService.addBullpenRunAuditRemark(runId, {
                    scope_type: remarkScopeType,
                    scope_id: remarkScopeId || null,
                    remark_type: remarkType || "note",
                    body: remarkBody.trim(),
                    metadata: {},
                    supersedes_remark_id: supersedesRemarkId
                      ? Number(supersedesRemarkId)
                      : null,
                  });
                  setRemarkBody("");
                  setRemarkScopeId("");
                  setSupersedesRemarkId("");
                  const refreshed = await apiService.getBullpenRunAuditDetail(runId);
                  setDetail(refreshed);
                } finally {
                  setSavingRemark(false);
                }
              }}
            >
              {savingRemark ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Add Remark
            </Button>
          </div>
        </SectionShell>
      </div>

      <div className="space-y-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
            Section III
          </p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-950">
            LLM Audit & Improvement
          </h2>
        </div>

        <SectionShell
          title="Select LLM"
          subtitle="Choose exactly one configured provider/model. Feedback is generated asynchronously and persisted as a new immutable version."
        >
          {providersLoading ? (
            <p className="text-sm text-slate-500">Loading configured LLM providers…</p>
          ) : (
            <LlmModelSelectionPanel
              providers={providers}
              selectedKeys={selectedKeySet(resolvedSelectedModelKey)}
              selectionMode="single"
              showBulkActions={false}
              onToggle={(key) =>
                setSelectedModelKey((current) => (current === key ? null : key))
              }
            />
          )}

          <div className="flex flex-wrap items-center gap-4">
            <label className="inline-flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={forceRerunFeedback}
                onChange={(event) => setForceRerunFeedback(event.target.checked)}
              />
              Force a new immutable feedback version
            </label>
            <Button
              disabled={submittingFeedback || !resolvedSelectedModelKey || !runId}
              onClick={async () => {
                if (!runId || !resolvedSelectedModelKey) return;
                const target = parseModelKey(resolvedSelectedModelKey);
                if (!target) return;
                setSubmittingFeedback(true);
                try {
                  const feedback = await apiService.createBullpenRunAuditFeedback(runId, {
                    provider: target.provider,
                    model: target.model,
                    force_rerun: forceRerunFeedback,
                  });
                  setActiveFeedbackId(feedback.id);
                  setFeedbackDetails((current) => ({
                    ...current,
                    [feedback.id]: undefined,
                  }));
                  const refreshed = await apiService.getBullpenRunAuditDetail(runId);
                  setDetail(refreshed);
                } finally {
                  setSubmittingFeedback(false);
                }
              }}
            >
              {submittingFeedback ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Run Audit Feedback
            </Button>
          </div>
        </SectionShell>

        <SectionShell title="Feedback Generation History">
          {detail.feedback_history.length === 0 ? (
            <p className="text-sm text-slate-500">
              No LLM audit feedback has been generated for this run yet.
            </p>
          ) : (
            <div className="space-y-3">
              {detail.feedback_history.map((item) => (
                <FeedbackHistoryRow
                  key={item.id}
                  item={item}
                  active={resolvedActiveFeedbackId === item.id}
                  onSelect={() => setActiveFeedbackId(item.id)}
                />
              ))}
            </div>
          )}
        </SectionShell>

        <SectionShell title="Structured Feedback Report">
          {feedbackDetailLoading ? (
            <p className="text-sm text-slate-500">Loading persisted feedback report…</p>
          ) : feedbackDetailError ? (
            <p className="text-sm text-rose-700">{feedbackDetailError}</p>
          ) : activeFeedbackDetail ? (
            <FeedbackReportView feedback={activeFeedbackDetail} />
          ) : (
            <p className="text-sm text-slate-500">
              Select a feedback generation above to inspect its persisted report and
              Codex remediation prompt.
            </p>
          )}
        </SectionShell>
      </div>
    </div>
  );
}
