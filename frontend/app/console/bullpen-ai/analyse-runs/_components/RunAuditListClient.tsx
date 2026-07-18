"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { URLs } from "@/lib/urls";
import { apiService } from "@/services/api";
import type {
  BullpenRunAuditListResponse,
  BullpenRunAuditSummaryItem,
} from "@/types/api";

import {
  AuditBadge,
  formatDateTime,
  formatDuration,
  formatPercent,
  humanizeToken,
  runAuditSelectClassName,
} from "./runAuditShared";

type RunAuditFilters = {
  page: number;
  limit: number;
  status: string;
  triggeredBy: string;
  dryLiveMode: string;
  fromDate: string;
  toDate: string;
  stageFailure: string;
  auditStatus: string;
  findingSeverity: string;
  feedbackGenerated: string;
  runIdSearch: string;
};

const defaultFilters: RunAuditFilters = {
  page: 1,
  limit: 20,
  status: "",
  triggeredBy: "",
  dryLiveMode: "",
  fromDate: "",
  toDate: "",
  stageFailure: "",
  auditStatus: "",
  findingSeverity: "",
  feedbackGenerated: "",
  runIdSearch: "",
};

function cardToneClassName(item: BullpenRunAuditSummaryItem) {
  if (item.run_status === "failed") return "border-rose-200 bg-rose-50/50";
  if (item.lifecycle_status === "incomplete") return "border-amber-200 bg-amber-50/50";
  if (item.run_status === "partial_success") return "border-amber-200 bg-amber-50/50";
  if (item.feedback_status === "processing" || item.feedback_status === "queued") {
    return "border-sky-200 bg-sky-50/50";
  }
  return "border-slate-200 bg-white";
}

function metric(label: string, value: string) {
  return (
    <div key={`${label}-${value}`} className="space-y-1">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
        {label}
      </p>
      <p className="text-sm font-semibold text-slate-900">{value}</p>
    </div>
  );
}

function severityTotal(item: BullpenRunAuditSummaryItem) {
  return (
    item.findings_critical +
    item.findings_high +
    item.findings_medium +
    item.findings_low +
    item.findings_info
  );
}

function feedbackGeneratedValue(value: string) {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

export function RunAuditListClient() {
  const [filters, setFilters] = useState<RunAuditFilters>(defaultFilters);
  const [draftFilters, setDraftFilters] = useState<RunAuditFilters>(defaultFilters);
  const [data, setData] = useState<BullpenRunAuditListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const nextData = await apiService.getBullpenRunAudits({
          page: filters.page,
          limit: filters.limit,
          status: filters.status || undefined,
          triggeredBy: filters.triggeredBy || undefined,
          dryLiveMode: filters.dryLiveMode || undefined,
          fromDate: filters.fromDate || undefined,
          toDate: filters.toDate || undefined,
          stageFailure: filters.stageFailure || undefined,
          auditStatus: filters.auditStatus || undefined,
          findingSeverity: filters.findingSeverity || undefined,
          feedbackGenerated: feedbackGeneratedValue(filters.feedbackGenerated),
          runIdSearch: filters.runIdSearch || undefined,
        });
        if (!cancelled) {
          setData(nextData);
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(
            nextError instanceof Error
              ? nextError.message
              : "Failed to load Bullpen run audits.",
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [filters]);

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = data?.total_pages ?? 0;
  const from = total === 0 ? 0 : (filters.page - 1) * filters.limit + 1;
  const to = total === 0 ? 0 : Math.min(total, filters.page * filters.limit);

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-2">
          <p className="text-sm font-semibold uppercase tracking-[0.22em] text-purple-600">
            Bullpen x AI
          </p>
          <h1 className="text-3xl font-bold tracking-tight text-slate-950">
            Bullpen Runs Audit
          </h1>
          <p className="max-w-3xl text-sm leading-6 text-slate-600">
            Review immutable Bullpen run snapshots, deterministic validation findings,
            manual audit checks, and versioned LLM feedback without loading the full raw
            bundle into the list view.
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          <Button asChild variant="outline">
            <Link href={URLs.routes.console.bullpenAiAnalyseEvents()}>
              Analyse Events
            </Link>
          </Button>
          <Button asChild className="bg-purple-700 text-white hover:bg-purple-800">
            <Link href={URLs.routes.console.bullpenAi()}>Bullpen x AI</Link>
          </Button>
        </div>
      </div>

      <Card className="rounded-none border-slate-200 shadow-none">
        <CardHeader>
          <CardTitle className="text-base text-slate-950">Filters</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <label className="space-y-2 text-sm text-slate-700">
              <span>Run ID</span>
              <Input
                value={draftFilters.runIdSearch}
                onChange={(event) =>
                  setDraftFilters((current) => ({
                    ...current,
                    runIdSearch: event.target.value,
                  }))
                }
                placeholder="Search run ID"
              />
            </label>
            <label className="space-y-2 text-sm text-slate-700">
              <span>Status</span>
              <select
                className={runAuditSelectClassName}
                value={draftFilters.status}
                onChange={(event) =>
                  setDraftFilters((current) => ({
                    ...current,
                    status: event.target.value,
                  }))
                }
              >
                <option value="">All</option>
                <option value="processing">Processing</option>
                <option value="completed">Completed</option>
                <option value="partial_success">Partial success</option>
                <option value="failed">Failed</option>
                <option value="skipped">Skipped</option>
              </select>
            </label>
            <label className="space-y-2 text-sm text-slate-700">
              <span>Trigger</span>
              <select
                className={runAuditSelectClassName}
                value={draftFilters.triggeredBy}
                onChange={(event) =>
                  setDraftFilters((current) => ({
                    ...current,
                    triggeredBy: event.target.value,
                  }))
                }
              >
                <option value="">All</option>
                <option value="manual">Manual</option>
                <option value="scheduler">Scheduler</option>
                <option value="start">Start</option>
                <option value="resume">Resume</option>
              </select>
            </label>
            <label className="space-y-2 text-sm text-slate-700">
              <span>Dry / Live</span>
              <select
                className={runAuditSelectClassName}
                value={draftFilters.dryLiveMode}
                onChange={(event) =>
                  setDraftFilters((current) => ({
                    ...current,
                    dryLiveMode: event.target.value,
                  }))
                }
              >
                <option value="">All</option>
                <option value="dry">Dry run</option>
                <option value="live">Live requested</option>
              </select>
            </label>
            <label className="space-y-2 text-sm text-slate-700">
              <span>From</span>
              <Input
                type="date"
                value={draftFilters.fromDate}
                onChange={(event) =>
                  setDraftFilters((current) => ({
                    ...current,
                    fromDate: event.target.value,
                  }))
                }
              />
            </label>
            <label className="space-y-2 text-sm text-slate-700">
              <span>To</span>
              <Input
                type="date"
                value={draftFilters.toDate}
                onChange={(event) =>
                  setDraftFilters((current) => ({
                    ...current,
                    toDate: event.target.value,
                  }))
                }
              />
            </label>
            <label className="space-y-2 text-sm text-slate-700">
              <span>Stage Failure</span>
              <select
                className={runAuditSelectClassName}
                value={draftFilters.stageFailure}
                onChange={(event) =>
                  setDraftFilters((current) => ({
                    ...current,
                    stageFailure: event.target.value,
                  }))
                }
              >
                <option value="">All</option>
                <option value="stage-1">Stage 1 failed</option>
                <option value="stage-2">Stage 2 failed</option>
                <option value="stage-3">Stage 3 failed</option>
              </select>
            </label>
            <label className="space-y-2 text-sm text-slate-700">
              <span>Audit Status</span>
              <select
                className={runAuditSelectClassName}
                value={draftFilters.auditStatus}
                onChange={(event) =>
                  setDraftFilters((current) => ({
                    ...current,
                    auditStatus: event.target.value,
                  }))
                }
              >
                <option value="">All</option>
                <option value="native">Native</option>
                <option value="reconstructed">Reconstructed</option>
                <option value="frozen">Frozen</option>
                <option value="incomplete">Incomplete</option>
              </select>
            </label>
            <label className="space-y-2 text-sm text-slate-700">
              <span>Finding Severity</span>
              <select
                className={runAuditSelectClassName}
                value={draftFilters.findingSeverity}
                onChange={(event) =>
                  setDraftFilters((current) => ({
                    ...current,
                    findingSeverity: event.target.value,
                  }))
                }
              >
                <option value="">All</option>
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
                <option value="info">Info</option>
              </select>
            </label>
            <label className="space-y-2 text-sm text-slate-700">
              <span>Feedback</span>
              <select
                className={runAuditSelectClassName}
                value={draftFilters.feedbackGenerated}
                onChange={(event) =>
                  setDraftFilters((current) => ({
                    ...current,
                    feedbackGenerated: event.target.value,
                  }))
                }
              >
                <option value="">All</option>
                <option value="true">Generated or queued</option>
                <option value="false">Not generated</option>
              </select>
            </label>
            <label className="space-y-2 text-sm text-slate-700">
              <span>Per Page</span>
              <select
                className={runAuditSelectClassName}
                value={String(draftFilters.limit)}
                onChange={(event) =>
                  setDraftFilters((current) => ({
                    ...current,
                    limit: Number(event.target.value) || 20,
                  }))
                }
              >
                <option value="10">10</option>
                <option value="20">20</option>
                <option value="50">50</option>
              </select>
            </label>
          </div>

          <div className="flex flex-wrap gap-3">
            <Button
              onClick={() =>
                setFilters({
                  ...draftFilters,
                  page: 1,
                })
              }
            >
              Apply Filters
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setDraftFilters(defaultFilters);
                setFilters(defaultFilters);
              }}
            >
              Reset
            </Button>
          </div>
        </CardContent>
      </Card>

      {error ? (
        <Card className="rounded-none border-rose-200 bg-rose-50 shadow-none">
          <CardContent className="py-6 text-sm text-rose-700">{error}</CardContent>
        </Card>
      ) : null}

      <div className="space-y-4">
        {loading ? (
          <Card className="rounded-none border-slate-200 shadow-none">
            <CardContent className="py-10 text-sm text-slate-500">
              Loading persisted Bullpen run audit summaries…
            </CardContent>
          </Card>
        ) : null}

        {!loading && items.length === 0 ? (
          <Card className="rounded-none border-slate-200 shadow-none">
            <CardContent className="py-10 text-sm text-slate-500">
              No Bullpen run audits matched the current filters.
            </CardContent>
          </Card>
        ) : null}

        {!loading
          ? items.map((item) => (
              <Link
                key={item.snapshot_id}
                href={URLs.routes.console.bullpenAiAnalyseRunDetail(item.run_id)}
                className="block"
              >
                <Card
                  className={`rounded-none shadow-none transition hover:border-slate-300 ${cardToneClassName(item)}`}
                >
                  <CardContent className="space-y-5 p-5">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div className="space-y-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <AuditBadge
                            label={humanizeToken(item.run_status)}
                            tone={item.run_status === "failed" ? "critical" : item.run_status === "completed" ? "success" : "warning"}
                          />
                          <AuditBadge
                            label={`Audit ${humanizeToken(item.audit_status)}`}
                            tone={item.lifecycle_status === "incomplete" ? "warning" : item.source_kind === "native" ? "success" : "info"}
                          />
                          <AuditBadge
                            label={item.dry_run ? "Dry Run" : "Live Requested"}
                            tone={item.dry_run ? "info" : "warning"}
                          />
                          {item.feedback_status ? (
                            <AuditBadge
                              label={`Feedback ${humanizeToken(item.feedback_status)}`}
                              tone={item.feedback_status === "completed" ? "success" : item.feedback_status === "failed" ? "critical" : "info"}
                            />
                          ) : null}
                        </div>
                        <div>
                          <h2 className="text-xl font-semibold text-slate-950">{item.run_id}</h2>
                          <p className="mt-1 text-sm text-slate-600">
                            Started {formatDateTime(item.started_at)} · Completed{" "}
                            {formatDateTime(item.completed_at)} · Duration{" "}
                            {formatDuration(item.duration_seconds)}
                          </p>
                        </div>
                      </div>
                      <div className="space-y-2 text-sm text-slate-600 lg:text-right">
                        <p>Trigger: {humanizeToken(item.triggered_by)}</p>
                        <p>Execution: {item.execution_version || "—"}</p>
                        <p>Strategy: {item.strategy_version || "—"}</p>
                        <p>Backend SHA: {item.backend_commit_sha || "—"}</p>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <AuditBadge label={`Stage 1 ${humanizeToken(item.stage1_status)}`} tone={item.stage1_status === "fail" ? "critical" : item.stage1_status === "pass" ? "success" : "warning"} />
                      <AuditBadge label={`Stage 2 ${humanizeToken(item.stage2_status)}`} tone={item.stage2_status === "fail" ? "critical" : item.stage2_status === "pass" ? "success" : "warning"} />
                      <AuditBadge label={`Stage 3 ${humanizeToken(item.stage3_status)}`} tone={item.stage3_status === "fail" ? "critical" : item.stage3_status === "pass" ? "success" : "warning"} />
                      <AuditBadge label={`${formatPercent(item.completeness_pct)} complete`} tone={item.completeness_pct >= 90 ? "success" : item.completeness_pct >= 70 ? "warning" : "critical"} />
                      {item.feedback_model ? (
                        <AuditBadge
                          label={`${item.feedback_provider} / ${item.feedback_model}`}
                          tone="info"
                          className="normal-case tracking-normal"
                        />
                      ) : null}
                    </div>

                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
                      {metric("Scanned", String(item.scanned_candidate_count))}
                      {metric("Pre-LLM Rows", String(item.candidate_rows_before_llm))}
                      {metric("LLM Candidates", String(item.llm_candidate_count))}
                      {metric("LLM Calls", `${item.llm_succeeded_call_count}/${item.llm_attempted_call_count}`)}
                      {metric("Qualified", String(item.qualified_candidate_count))}
                      {metric("Ranked", String(item.ranked_count))}
                      {metric("Final Selection", String(item.final_selection_count))}
                      {metric("Decisions", String(item.decisions_count))}
                      {metric("Orders", `${item.orders_planned}/${item.orders_submitted}/${item.orders_filled}`)}
                      {metric("Findings", String(severityTotal(item)))}
                      {metric("Critical / High", `${item.findings_critical} / ${item.findings_high}`)}
                      {metric("Manual Deficiencies", String(item.manual_deficiency_count))}
                      {metric("Provider Failures", String(item.provider_failure_count))}
                      {metric("Incomplete Fields", String(item.incomplete_data_count))}
                      {metric("Snapshot", `${item.snapshot_version} · ${humanizeToken(item.lifecycle_status)}`)}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))
          : null}
      </div>

      <Card className="rounded-none border-slate-200 shadow-none">
        <CardContent className="flex flex-wrap items-center justify-between gap-4 py-4">
          <p className="text-sm text-slate-600">
            {total === 0
              ? "No persisted audit snapshots yet."
              : `${from}–${to} of ${total} Bullpen run audit${total !== 1 ? "s" : ""}`}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={filters.page <= 1 || loading}
              onClick={() =>
                setFilters((current) => ({
                  ...current,
                  page: current.page - 1,
                }))
              }
            >
              Previous
            </Button>
            <span className="min-w-24 text-center text-sm text-slate-600">
              Page {filters.page} of {Math.max(totalPages, 1)}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={loading || filters.page >= Math.max(totalPages, 1)}
              onClick={() =>
                setFilters((current) => ({
                  ...current,
                  page: current.page + 1,
                }))
              }
            >
              Next
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
