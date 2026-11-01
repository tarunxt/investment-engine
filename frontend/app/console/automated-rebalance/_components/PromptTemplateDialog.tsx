"use client";

import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

/** Read-only template inspection. This component never assembles runtime inputs. */
export function PromptTemplateDialog({ title, body, onClose }: {
  title: string;
  body: string;
  onClose: () => void;
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
      className="m-auto max-h-[85dvh] w-full max-w-[calc(100vw-2rem)] overflow-hidden rounded-3xl border-0 bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-slate-950/50 xl:max-w-[95vw]"
    >
      <div className="flex max-h-[85dvh] flex-col">
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-200 p-5">
          <div className="min-w-0">
            <h3 id={titleId} className="text-lg font-semibold text-slate-950">{title}</h3>
            <p id={descriptionId} className="mt-1 text-sm text-slate-500">
              Prompt template used by this Auto-Rebalance stage. Runtime input bundles are added when the workflow runs.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close prompt view"
            className="shrink-0 rounded-full px-3 py-1 text-sm hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600">
            Close
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto overscroll-contain p-5" tabIndex={0} aria-label="Prompt template text">
          <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-6 text-slate-700 [overflow-wrap:anywhere]">{body}</pre>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
