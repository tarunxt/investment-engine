"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Presentation and focus boundary only; selection and execution stay with the caller. */
export function ModelPickerDialogFrame({ enabled, title, onClose, children }: {
  enabled: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!enabled) return;
    const opener = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    const siblings = Array.from(document.body.children)
      .filter((element): element is HTMLElement => element instanceof HTMLElement && !element.contains(panelRef.current))
      .map(element => ({ element, inert: element.inert }));
    for (const { element } of siblings) element.inert = true;
    document.body.style.overflow = "hidden";
    panelRef.current?.querySelector<HTMLElement>('button[aria-label="Close LLM selector"]')?.focus();
    return () => {
      for (const { element, inert } of siblings) element.inert = inert;
      document.body.style.overflow = previousOverflow;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [enabled]);
  const content = (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 px-4 py-6 backdrop-blur-sm" onClick={onClose}>
      <div ref={panelRef} role={enabled ? "dialog" : undefined} aria-modal={enabled ? true : undefined} aria-label={enabled ? title : undefined}
        onClick={event => event.stopPropagation()}
        onKeyDown={event => {
          if (!enabled) return;
          if (event.key === "Escape") { event.stopPropagation(); onClose(); return; }
          if (event.key !== "Tab") return;
          const controls = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? [])
            .filter(element => element.tabIndex >= 0 && element.getClientRects().length > 0);
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}
        className={`flex ${enabled ? "max-h-[90dvh]" : "max-h-[90vh]"} w-full max-w-3xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl`}>
        {children}
      </div>
    </div>
  );
  return enabled ? createPortal(content, document.body) : content;
}
