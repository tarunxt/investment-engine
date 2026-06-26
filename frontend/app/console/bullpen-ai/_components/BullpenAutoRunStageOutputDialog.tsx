"use client";

import { X } from "lucide-react";

type BullpenAutoRunStageOutputDialogProps = {
  stageTitle: string;
  stageDetail: string;
  eyebrow?: string;
  outputs: Record<string, unknown>;
  outputLabel?: string;
  onClose: () => void;
};

function renderJson(value: Record<string, unknown>) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "{}";
  }
}

export function BullpenAutoRunStageOutputDialog({
  stageTitle,
  stageDetail,
  eyebrow = "Stage Output",
  outputs,
  outputLabel = "Outputs",
  onClose,
}: BullpenAutoRunStageOutputDialogProps) {
  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-slate-950/55 p-4">
      <div className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.45)]">
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
          <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              {outputLabel}
            </p>
            <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words text-xs leading-6 text-slate-700">
              {renderJson(outputs)}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
