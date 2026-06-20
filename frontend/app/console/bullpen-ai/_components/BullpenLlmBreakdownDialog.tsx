"use client";

import { X } from "lucide-react";

import type { BullpenQuestionRow } from "@/lib/bullpen-ai";

type BullpenLlmBreakdownDialogProps = {
  question: BullpenQuestionRow;
  onClose: () => void;
};

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatOdds(value: number | null) {
  if (value === null) return "—";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

export function BullpenLlmBreakdownDialog({
  question,
  onClose,
}: BullpenLlmBreakdownDialogProps) {
  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/55 p-4">
      <div className="flex max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.45)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
              LLM Odds Breakdown
            </p>
            <h2 className="max-w-4xl text-xl font-semibold text-slate-950">
              {question.question}
            </h2>
            <div className="flex flex-wrap gap-3 text-sm text-slate-600">
              <span>Average Yes: {formatOdds(question.llmYesOdds)}</span>
              <span>Average No: {formatOdds(question.llmNoOdds)}</span>
              <span>
                Current Yes vs LLM:{" "}
                {question.currentVsLlmOddsDifference === null
                  ? "—"
                  : question.currentVsLlmOddsDifference.toLocaleString(undefined, {
                      maximumFractionDigits: 2,
                    })}
              </span>
              <span>{question.llmBreakdown.length} model outputs</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close LLM odds breakdown"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-6 py-5">
          {question.llmBreakdown.length > 0 ? (
            <div className="overflow-hidden rounded-2xl border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Provider</th>
                    <th className="px-4 py-3">Model</th>
                    <th className="px-4 py-3">LLM Yes Odds</th>
                    <th className="px-4 py-3">LLM No Odds</th>
                    <th className="px-4 py-3">Timestamp</th>
                    <th className="px-4 py-3">Rationale</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {question.llmBreakdown.map((entry) => (
                    <tr key={`${entry.provider}::${entry.model}::${entry.jobId ?? "job"}`}>
                      <td className="whitespace-nowrap px-4 py-3 font-medium text-slate-900">
                        {entry.provider}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                        {entry.model}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-semibold text-indigo-700">
                        {formatOdds(entry.llmYesOdds)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-semibold text-violet-700">
                        {formatOdds(entry.llmNoOdds)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                        {formatDate(entry.timestamp)}
                      </td>
                      <td className="min-w-[320px] px-4 py-3 leading-6 text-slate-700">
                        {entry.rationale || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-600">
              No per-model LLM breakdown is available for this question yet.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
