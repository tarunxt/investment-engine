"use client";

import { useEffect } from "react";
import { X } from "lucide-react";

import {
  BULLPEN_SCAN_FILTER_DETAILS,
  type BullpenScanFilterDetailId,
} from "@/lib/bullpenScanExclusions";

type BullpenScanFilterDetailsDialogProps = {
  detailId: BullpenScanFilterDetailId;
  onClose: () => void;
};

function DetailList({
  title,
  items,
  monospace = false,
}: {
  title: string;
  items: string[];
  monospace?: boolean;
}) {
  if (items.length === 0) return null;

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-slate-950">{title}</h3>
      <div className="space-y-2">
        {items.map((item) => (
          <div
            key={item}
            className={`rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-700 ${monospace ? "font-mono text-xs leading-5" : ""}`}
          >
            {item}
          </div>
        ))}
      </div>
    </section>
  );
}

export function BullpenScanFilterDetailsDialog({
  detailId,
  onClose,
}: BullpenScanFilterDetailsDialogProps) {
  const detail = BULLPEN_SCAN_FILTER_DETAILS[detailId];
  const algorithmTitle =
    detailId === "onlyBinaryYesNo"
      ? "Exact keep algorithm"
      : "Exact exclusion algorithm";

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-slate-950/55 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`bullpen-scan-filter-${detailId}-title`}
        className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.45)]"
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
              {detail.dialogEyebrow}
            </p>
            <h2
              id={`bullpen-scan-filter-${detailId}-title`}
              className="text-xl font-semibold text-slate-950"
            >
              {detail.title}
            </h2>
            <p className="text-sm leading-6 text-slate-600">
              {detail.description}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close scan filter details"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
          <div className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm leading-6 text-sky-950">
            {detail.matcherScope}
          </div>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-950">
              {algorithmTitle}
            </h3>
            <ol className="space-y-3 pl-5 text-sm leading-6 text-slate-700">
              {detail.algorithmSteps.map((step) => (
                <li key={step} className="list-decimal">
                  {step}
                </li>
              ))}
            </ol>
          </section>

          <DetailList
            title="Whole-word keyword sets"
            items={detail.keywordGroups ?? []}
            monospace
          />
          <DetailList
            title="Pattern rules"
            items={detail.patternRules ?? []}
            monospace
          />
          <DetailList
            title="Excluded event examples"
            items={detail.excludedEventExamples ?? []}
          />
        </div>
      </div>
    </div>
  );
}
