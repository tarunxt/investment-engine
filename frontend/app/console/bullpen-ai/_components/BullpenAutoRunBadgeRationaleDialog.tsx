"use client";

import { useEffect } from "react";
import { Info, X } from "lucide-react";

import type { BullpenAutoRunBadgeRationale } from "./bullpenAutoRunStatus";

export function BullpenAutoRunBadgeRationaleDialog({
  rationale,
  onClose,
}: {
  rationale: BullpenAutoRunBadgeRationale;
  onClose: () => void;
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        aria-labelledby="auto-run-badge-rationale-title"
        aria-modal="true"
        className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 rounded-full bg-sky-100 p-2 text-sky-700">
              <Info aria-hidden="true" className="size-4" />
            </span>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-sky-700">
                Why this tag is visible
              </p>
              <h2
                className="mt-1 text-lg font-semibold text-slate-950"
                id="auto-run-badge-rationale-title"
              >
                {rationale.label}
              </h2>
            </div>
          </div>
          <button
            aria-label="Close rationale"
            className="rounded-full p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
        <div className="mt-5 rounded-xl border border-sky-100 bg-sky-50 p-4">
          <p className="text-sm font-medium leading-6 text-slate-900">
            {rationale.reason}
          </p>
        </div>
        <p className="mt-4 text-sm leading-6 text-slate-600">
          {rationale.context}
        </p>
        <div className="mt-6 flex justify-end">
          <button
            className="rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
            onClick={onClose}
            type="button"
          >
            Got it
          </button>
        </div>
      </section>
    </div>
  );
}
