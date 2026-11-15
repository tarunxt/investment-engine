"use client";

import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

/** Read-only template inspection. This component never assembles runtime inputs. */
export function PromptTemplateDialog({ title, body, onClose, onReviewInputs }: {
  title: string;
  body: string;
  onClose: () => void;
  onReviewInputs: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    const opener = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    dialog?.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      dialog?.close();
      document.body.style.overflow = previousOverflow;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  return createPortal(
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button, [tabindex="0"]'));
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
      }}
      className="m-auto max-h-[85dvh] w-full max-w-[calc(100vw-2rem)] overflow-hidden rounded-3xl border border-violet-200 bg-violet-50 p-0 text-slate-900 shadow-2xl backdrop:bg-slate-950/50 xl:max-w-[95vw]"
    >
      <div className="flex max-h-[85dvh] flex-col">
        <div className="flex shrink-0 items-start justify-between gap-4 p-5">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-violet-700">Template only</p>
            <h3 id={titleId} className="text-lg font-semibold text-slate-950">{title}</h3>
            <p id={descriptionId} className="mt-1 text-sm text-slate-600">
              Prompt template used by this Auto-Rebalance stage. Runtime input bundles are added when the workflow runs.
            </p>
            <p className="mt-2 text-sm text-slate-700">This stage analyzes the portfolio and scan results selected for the workflow. This read-only preview is not the eventual request: selected data is added only when the workflow runs.</p>
            <button type="button" onClick={onReviewInputs} className="mt-2 rounded text-sm font-medium text-violet-800 underline focus-visible:outline-2 focus-visible:outline-blue-600">Review selected inputs</button>
          </div>
          <button type="button" onClick={onClose} aria-label="Close prompt view"
            className="shrink-0 rounded-full px-3 py-1 text-sm hover:bg-violet-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600">
            Close
          </button>
        </div>
        <div className="mx-5 mb-5 min-h-0 overflow-y-auto overscroll-contain rounded-xl bg-slate-950 p-5 text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600" tabIndex={0} aria-label="Prompt template text">
          <details>
            <summary tabIndex={0} className="cursor-pointer text-sm font-medium">Advanced: raw prompt template</summary>
          <pre className="max-w-[100ch] whitespace-pre-wrap break-words font-mono text-sm leading-6 [overflow-wrap:anywhere]">{body}</pre>
          </details>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
