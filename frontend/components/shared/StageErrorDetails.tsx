"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, X } from "lucide-react";
import type { StageInfo, StageTileRow } from "./WorkflowStageTile";

/** Native modal focus containment, Escape dismissal and focus restoration. */
export function StageErrorDetails({ stageLabel, info, row }: {
  stageLabel: string;
  info: StageInfo;
  row: StageTileRow;
}) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    if (open && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [open]);
  return <>
    <button type="button" aria-label={`Show error details for ${stageLabel}`} aria-haspopup="dialog"
      aria-expanded={open} aria-controls={open ? `${titleId}-dialog` : undefined}
      className="pointer-events-auto relative z-20 inline-flex size-6 items-center justify-center rounded-full align-middle text-red-600 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
      onClick={event => { event.preventDefault(); event.stopPropagation(); setOpen(true); }}>
      <AlertCircle aria-hidden="true" className="size-4" />
    </button>
    {open && typeof document !== "undefined" ? createPortal(
      <dialog ref={dialog} id={`${titleId}-dialog`} aria-labelledby={titleId} aria-describedby={descriptionId}
        onClose={() => setOpen(false)}
        onKeyDown={event => {
          if (event.key !== "Tab") return;
          const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), summary, a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
            .filter(element => element.getClientRects().length > 0);
          const first = controls[0], last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}
        onClick={event => {
          event.stopPropagation();
          const bounds = event.currentTarget.getBoundingClientRect();
          if (event.target === event.currentTarget && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) dialog.current?.close();
        }}
        className="pointer-events-auto fixed inset-0 m-auto max-h-[70vh] w-[calc(100vw-2rem)] max-w-md overflow-auto rounded-xl border border-red-200 bg-white p-0 text-left text-sm text-slate-700 shadow-2xl backdrop:bg-slate-950/40">
        <div className="sticky top-0 flex items-start justify-between gap-3 border-b border-red-100 bg-red-50 px-4 py-3">
          <div>
            <h2 id={titleId} className="font-semibold text-slate-950">{stageLabel} · Error details</h2>
            <p className="mt-1 text-xs text-slate-600">Status: {info.runStatus || info.state}
              {info.activeRunId || info.lastRunId ? ` · Run #${info.activeRunId ?? info.lastRunId}` : ""}
              {info.jobId ? ` · Job #${info.jobId}` : ""}
            </p>
          </div>
          <button type="button" aria-label="Close error details" onClick={() => dialog.current?.close()}
            className="shrink-0 rounded-full p-1 text-slate-600 hover:bg-red-100 focus-visible:ring-2 focus-visible:ring-red-500"><X aria-hidden="true" className="size-4" /></button>
        </div>
        <div className="space-y-3 p-4">
          <p id={descriptionId} className="whitespace-pre-wrap break-words">{row.detail}</p>
          {row.errorDetails?.map((detail, index) => <section key={`${detail.jobId ?? index}-${detail.runId ?? "job"}`} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <h3 className="font-semibold">{detail.provider || "Unknown provider"} / {detail.model || "Unknown model"}</h3>
            <p className="mt-1 text-xs">{detail.jobId ? `Job #${detail.jobId}` : "Job ID unavailable"}{detail.runId ? ` · Run #${detail.runId}` : ""}{detail.status ? ` · Status: ${detail.status}` : ""}</p>
            <p className="mt-2 whitespace-pre-wrap break-words">{detail.message}</p>
            <dl className="mt-2 space-y-1 break-words text-xs">
              <div><dt className="inline font-semibold">HTTP status: </dt><dd className="inline">{detail.httpStatus ?? "Unavailable"}</dd></div>
              <div><dt className="inline font-semibold">Retry safe: </dt><dd className="inline">{detail.retrySafe === true ? "Yes" : detail.retrySafe === false ? "No" : "Unavailable"}</dd></div>
              <div><dt className="inline font-semibold">Correlation ID: </dt><dd className="inline">{detail.correlationId || "Unavailable"}</dd></div>
              <div><dt className="inline font-semibold">Attempt: </dt><dd className="inline">{detail.attempt ?? "Unavailable"}</dd></div>
              <div><dt className="inline font-semibold">Exception type: </dt><dd className="inline">{detail.exceptionType || "Unavailable"}</dd></div>
              <div><dt className="inline font-semibold">Trace reference: </dt><dd className="inline">{detail.traceReference || "Unavailable"}</dd></div>
            </dl>
            {detail.providerResponseBody ? <details className="mt-2 text-xs"><summary className="cursor-pointer font-semibold">Provider response body</summary><pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words">{detail.providerResponseBody}</pre></details> : null}
          </section>)}
        </div>
      </dialog>, document.body,
    ) : null}
  </>;
}
