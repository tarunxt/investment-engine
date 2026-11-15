"use client";

import { useEffect, useState } from "react";
import { Download, FileSpreadsheet, Loader2, X } from "lucide-react";

import { formatApiTimestamp } from "@/lib/datetime";
import type { BullpenWorkspaceProfile } from "@/lib/bullpenStageOneSettings";
import { apiService } from "@/services/api";
import type {
  BullpenAutoLiveHistoryItem,
  BullpenAutoLiveRun,
} from "@/types/api";

import { buildBullpenAutoRunWorkflowView } from "./bullpenAutoRunProgress";
import { downloadCompleteStageOneRunExcel } from "./bullpenStageOneExcel";

type ExcelScanHistoryEntry = {
  runId: string;
  universalScanAt: string | null;
  filtersRunAt: string | null;
  passedFilters: number | null;
};

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function fallbackEntry(item: BullpenAutoLiveHistoryItem): ExcelScanHistoryEntry {
  const stage = item.stages.find((candidate) => candidate.key === "scan");
  return {
    runId: item.id,
    universalScanAt: stage?.started_at ?? item.started_at,
    filtersRunAt: stage?.completed_at ?? item.completed_at ?? null,
    passedFilters: stage?.succeeded_count ?? stage?.processed_count ?? null,
  };
}

function entryFromRun(
  item: BullpenAutoLiveHistoryItem,
  run: BullpenAutoLiveRun,
): ExcelScanHistoryEntry {
  const stage = buildBullpenAutoRunWorkflowView(run).stages.find(
    (candidate) => candidate.key === "scan",
  );
  if (!stage) return fallbackEntry(item);

  const requestContext = run.request_context?.console_profile;
  return {
    runId: run.id,
    universalScanAt:
      readString(stage.outputs.scanned_at) ??
      readString(stage.outputs.source_scan_completed_at) ??
      requestContext?.scanned_at ??
      requestContext?.source_scan_completed_at ??
      stage.timerStartedAt,
    filtersRunAt:
      readString(stage.outputs.filters_completed_at) ??
      stage.timerCompletedAt ??
      readString(stage.outputs.scanned_at),
    passedFilters:
      readNumber(stage.outputs.accepted_candidates_count) ??
      readNumber(stage.outputs.candidate_rows_before_llm) ??
      stage.scanCandidates.length,
  };
}

function formatTimestamp(value: string | null) {
  return formatApiTimestamp(value, {
    emptyValue: "Not recorded",
    timeZone: "Asia/Kolkata",
    timeZoneName: "short",
    second: "2-digit",
  });
}

export function BullpenStageOneExcelHistoryDialog({
  open,
  onClose,
  workspaceProfile,
}: {
  open: boolean;
  onClose: () => void;
  workspaceProfile: BullpenWorkspaceProfile;
}) {
  const [entries, setEntries] = useState<ExcelScanHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();

    const loadEntries = async () => {
      setLoading(true);
      setError(null);
      try {
        const history = await apiService.getBullpenAutoLiveHistory(
          { page: 1, size: 30, workspaceProfile },
          { signal: controller.signal, timeoutMs: 12_000 },
        );
        const completedScans = history.items
          .filter((item) => {
            const stage = item.stages.find((candidate) => candidate.key === "scan");
            return Boolean(stage?.completed_at || item.completed_at);
          })
          .slice(0, 10);
        const detailResults = await Promise.allSettled(
          completedScans.map((item) =>
            apiService.getBullpenAutoLiveRunConsole(item.id, {
              signal: controller.signal,
              timeoutMs: 10_000,
            }),
          ),
        );
        if (controller.signal.aborted) return;
        setEntries(
          completedScans.map((item, index) => {
            const detail = detailResults[index];
            return detail.status === "fulfilled"
              ? entryFromRun(item, detail.value.run)
              : fallbackEntry(item);
          }),
        );
      } catch (nextError) {
        if (controller.signal.aborted) return;
        setEntries([]);
        setError(
          nextError instanceof Error
            ? nextError.message
            : "Excel scan history is temporarily unavailable.",
        );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    void loadEntries();
    return () => controller.abort();
  }, [open, workspaceProfile]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="stage-one-excel-history-title"
        className="max-h-[min(48rem,calc(100vh-2rem))] w-full max-w-3xl overflow-hidden rounded-2xl border border-emerald-200 bg-white shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-emerald-100 bg-emerald-50/80 px-5 py-4">
          <div>
            <div className="flex items-center gap-2 text-emerald-800">
              <FileSpreadsheet className="h-5 w-5" aria-hidden="true" />
              <h2 id="stage-one-excel-history-title" className="text-lg font-bold">
                Last 10 Excel scans
              </h2>
            </div>
            <p className="mt-1 text-sm text-slate-600">
              Download the filtered-events workbook saved for each Stage 1 scan.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-emerald-200 bg-white text-slate-600 transition hover:bg-emerald-100 hover:text-emerald-900 focus:outline-none focus:ring-2 focus:ring-emerald-400"
            aria-label="Close Excel scan history"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <div className="max-h-[calc(100vh-10rem)] overflow-y-auto p-4 sm:p-5">
          {loading ? (
            <div className="flex min-h-48 items-center justify-center gap-2 text-sm font-semibold text-emerald-800" role="status">
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
              Loading Excel scans…
            </div>
          ) : error ? (
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800" role="alert">
              {error}
            </div>
          ) : entries.length === 0 ? (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-5 text-center text-sm text-slate-600">
              No completed Stage 1 Excel scans are available yet.
            </div>
          ) : (
            <ol className="space-y-3">
              {entries.map((entry, index) => (
                <li
                  key={entry.runId}
                  className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-[6rem_minmax(0,1fr)_auto] sm:items-center"
                >
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                      Scan number
                    </p>
                    <p className="mt-1 text-lg font-bold tabular-nums text-slate-950">
                      #{index + 1}
                    </p>
                  </div>
                  <dl className="grid min-w-0 gap-2 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="font-semibold text-slate-600">
                        Universal Polymarket Scan timestamp
                      </dt>
                      <dd className="mt-0.5 break-words tabular-nums text-slate-950">
                        {formatTimestamp(entry.universalScanAt)}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-semibold text-slate-600">Filters run</dt>
                      <dd className="mt-0.5 break-words tabular-nums text-slate-950">
                        {formatTimestamp(entry.filtersRunAt)}
                      </dd>
                    </div>
                    <div className="sm:col-span-2">
                      <dt className="font-semibold text-slate-600">
                        Events that Passed Filters
                      </dt>
                      <dd className="mt-0.5 text-base font-bold tabular-nums text-emerald-800">
                        {entry.passedFilters === null
                          ? "Not recorded"
                          : entry.passedFilters.toLocaleString("en-IN")}
                      </dd>
                    </div>
                  </dl>
                  <button
                    type="button"
                    onClick={() =>
                      void downloadCompleteStageOneRunExcel(entry.runId, "filtered")
                    }
                    className="inline-flex h-11 w-11 items-center justify-center justify-self-end rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-700 transition hover:-translate-y-0.5 hover:bg-emerald-100 focus:outline-none focus:ring-2 focus:ring-emerald-400"
                    aria-label={`Download filtered-events Excel for scan ${index + 1}`}
                    title="Download this Excel"
                  >
                    <Download className="h-5 w-5" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>
    </div>
  );
}
