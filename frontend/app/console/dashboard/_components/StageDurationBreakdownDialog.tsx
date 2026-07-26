"use client";

import { useEffect, useMemo, useState } from "react";
import { Clock3, Loader2, X } from "lucide-react";

import { apiService } from "@/services/api";
import type { JobResponse, RunResponse } from "@/types/api";

type StageDurationInfo = {
  state: string;
  startedAt?: string | null;
  endedAt?: string | null;
  completedAt?: string | null;
  provider?: string | null;
  model?: string | null;
  activeRunId?: number | null;
  lastRunId?: number | null;
  totalLlms?: number | null;
};

type DurationBreakdownStep = {
  id: string;
  label: string;
  duration: string;
  detail: string;
};

type DurationBreakdown = {
  totalDuration: string;
  steps: DurationBreakdownStep[];
  hasParallelJobs: boolean;
};

function parseTimestampMs(value?: string | null) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDurationMs(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "n/a";
  const totalSeconds = Math.max(0, Math.floor(value / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function getDurationMs(startMs: number | null, endMs: number | null) {
  if (startMs === null || endMs === null) return null;
  return Math.max(0, endMs - startMs);
}

function isActiveStatus(status?: string | null) {
  return ["pending", "queued", "processing", "running"].includes(
    (status || "").toLowerCase(),
  );
}

function getJobEndMs(job: JobResponse, now: number) {
  if (isActiveStatus(job.status)) return now;
  return parseTimestampMs(job.updated_at) ?? now;
}

function buildFallbackBreakdown(
  info: StageDurationInfo,
  totalDuration: string,
): DurationBreakdown {
  const llmLabel = [info.provider, info.model].filter(Boolean).join(" / ");
  return {
    totalDuration,
    hasParallelJobs: false,
    steps: [
      {
        id: "setup",
        label: "Stage setup and request dispatch",
        duration: "Not recorded",
        detail: "This stage did not save a separate setup timestamp.",
      },
      {
        id: "execution",
        label: llmLabel ? `LLM execution · ${llmLabel}` : "LLM execution and stage processing",
        duration: totalDuration,
        detail:
          "The available timestamps cover the complete execution window, including provider processing and any queue time.",
      },
      {
        id: "finalisation",
        label: "Validation and persistence",
        duration: "Not recorded",
        detail: "This stage did not save a separate finalisation timestamp.",
      },
    ],
  };
}

function buildDurationBreakdown(
  info: StageDurationInfo,
  run: RunResponse | null,
  now: number,
): DurationBreakdown {
  const stageStartMs = parseTimestampMs(info.startedAt);
  const recordedStageEndMs = parseTimestampMs(info.endedAt ?? info.completedAt);
  const stageEndMs = recordedStageEndMs ?? (isActiveStatus(info.state) ? now : null);
  const totalDuration = formatDurationMs(getDurationMs(stageStartMs, stageEndMs));
  const jobs = (run?.run_jobs ?? [])
    .map((link) => link.job)
    .filter((job): job is JobResponse => Boolean(job))
    .sort(
      (left, right) =>
        (parseTimestampMs(left.created_at) ?? Number.MAX_SAFE_INTEGER) -
        (parseTimestampMs(right.created_at) ?? Number.MAX_SAFE_INTEGER),
    );

  if (jobs.length === 0) {
    return buildFallbackBreakdown(info, totalDuration);
  }

  const jobWindows = jobs.map((job) => ({
    job,
    startMs: parseTimestampMs(job.created_at),
    endMs: getJobEndMs(job, now),
  }));
  const jobStartValues = jobWindows
    .map((window) => window.startMs)
    .filter((value): value is number => value !== null);
  const jobEndValues = jobWindows
    .map((window) => window.endMs)
    .filter((value): value is number => value !== null);
  const earliestJobStartMs = jobStartValues.length
    ? Math.min(...jobStartValues)
    : null;
  const latestJobEndMs = jobEndValues.length ? Math.max(...jobEndValues) : null;

  const steps: DurationBreakdownStep[] = [
    {
      id: "setup",
      label: "Stage setup and LLM dispatch",
      duration: formatDurationMs(
        getDurationMs(stageStartMs, earliestJobStartMs),
      ),
      detail: "Time between the stage starting and the first LLM job being created.",
    },
    ...jobWindows.map(({ job, startMs, endMs }) => ({
      id: `job-${job.id}`,
      label: `LLM execution · ${job.provider} / ${job.model}`,
      duration: formatDurationMs(getDurationMs(startMs, endMs)),
      detail: `Job #${job.id} · ${job.status || "unknown status"} · includes queue and provider processing time.`,
    })),
    {
      id: "finalisation",
      label: "Validation, aggregation and finalisation",
      duration: formatDurationMs(getDurationMs(latestJobEndMs, stageEndMs)),
      detail: "Time after the last LLM job update until the stage reached its recorded end.",
    },
  ];

  return {
    totalDuration,
    steps,
    hasParallelJobs: jobs.length > 1,
  };
}

export function StageDurationBreakdownDialog({
  open,
  stageLabel,
  info,
  now,
  onClose,
}: {
  open: boolean;
  stageLabel: string;
  info: StageDurationInfo;
  now: number;
  onClose: () => void;
}) {
  const runId = info.activeRunId ?? info.lastRunId ?? null;
  const [run, setRun] = useState<RunResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      if (!runId) {
        setRun(null);
        setError(null);
        setLoading(false);
        return;
      }
      setRun(null);
      setError(null);
      setLoading(true);
      void apiService
        .getRun(runId, { signal: controller.signal })
        .then((response) => {
          if (!controller.signal.aborted) setRun(response);
        })
        .catch((reason: unknown) => {
          if (controller.signal.aborted) return;
          setError(
            reason instanceof Error
              ? reason.message
              : "Detailed LLM timing could not be loaded.",
          );
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 0);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, runId]);

  const breakdown = useMemo(
    () => buildDurationBreakdown(info, run, now),
    [info, now, run],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/55 px-4 py-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="stage-duration-breakdown-title"
        className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-blue-600">
              <Clock3 className="size-4" /> Duration breakdown
            </p>
            <h3
              id="stage-duration-breakdown-title"
              className="mt-1 truncate text-xl font-extrabold text-slate-950"
            >
              {stageLabel}
            </h3>
            <p className="mt-2 text-sm text-slate-600">
              Total wall-clock duration: {breakdown.totalDuration}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-950 focus:outline-none focus:ring-2 focus:ring-blue-500"
            aria-label="Close duration breakdown"
          >
            <X className="size-5" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {loading ? (
            <div className="mb-4 flex items-center gap-2 rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-800">
              <Loader2 className="size-4 animate-spin" /> Loading detailed LLM timings…
            </div>
          ) : null}
          {error ? (
            <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
              Detailed run timing could not be loaded. The recorded stage timing is shown below. {error}
            </div>
          ) : null}

          <ol className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
            {breakdown.steps.map((step, index) => (
              <li
                key={step.id}
                className="grid grid-cols-[2rem_minmax(0,1fr)_auto] items-start gap-3 border-b border-slate-100 px-4 py-4 last:border-b-0"
              >
                <span className="inline-flex size-7 items-center justify-center rounded-full bg-slate-100 text-xs font-extrabold text-slate-600">
                  {index + 1}
                </span>
                <span className="min-w-0">
                  <span className="block font-bold text-slate-950">{step.label}</span>
                  <span className="mt-1 block text-xs leading-5 text-slate-500">
                    {step.detail}
                  </span>
                </span>
                <span className="whitespace-nowrap font-mono text-sm font-extrabold text-slate-800">
                  {step.duration}
                </span>
              </li>
            ))}
          </ol>

          {breakdown.hasParallelJobs ? (
            <p className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-600">
              LLM rows can overlap because providers run in parallel. Their individual durations therefore do not add up to the wall-clock total.
            </p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
