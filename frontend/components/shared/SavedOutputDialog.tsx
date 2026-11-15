"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function SavedOutputDialog({ title, savedAt, provenance, routeUrl, onClose, onRetry, loading, children }: {
  title: string;
  savedAt?: string | null;
  provenance?: string | null;
  routeUrl: string;
  onClose: () => void;
  onRetry: () => void;
  loading: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useEffect(() => {
    const opener = document.activeElement;
    const siblings = Array.from(document.body.children)
      .filter((element): element is HTMLElement => element instanceof HTMLElement && !element.contains(ref.current))
      .map((element) => ({ element, inert: element.inert }));
    for (const { element } of siblings) element.inert = true;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      for (const { element, inert } of siblings) element.inert = inert;
      document.body.style.overflow = previousOverflow;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/50 p-4"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.stopPropagation(); onClose(); }
          if (event.key !== "Tab") return;
          const controls = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? [])
            .filter((element) => element.getClientRects().length > 0);
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}
        className="max-h-[85vh] w-full max-w-[calc(100vw-2rem)] overflow-auto rounded-3xl bg-white text-slate-900 shadow-2xl xl:max-w-[95vw]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 p-5">
          <div>
            <h3 id={titleId} className="text-lg font-semibold">{title}</h3>
            <p className="mt-1 text-sm text-slate-500">Latest saved stage output for the selected portfolio.</p>
            <p className="mt-1 text-sm text-slate-500">Saved output timestamp: {savedAt ? <time dateTime={savedAt}>{savedAt}</time> : "Unavailable"}</p>
            {provenance ? <p className="mt-1 text-xs text-slate-500">{provenance}</p> : null}
            <div className="mt-3 flex flex-wrap gap-4 text-sm">
              <button type="button" onClick={onRetry} disabled={loading} className="underline disabled:opacity-50">Retry saved output</button>
              <a href={routeUrl} target="_blank" rel="noopener noreferrer" className="underline">Open stage page in new tab</a>
            </div>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close output view" className="rounded-full px-3 py-1 hover:bg-slate-100">Close</button>
        </div>
        {children}
      </div>
    </div>, document.body,
  );
}
