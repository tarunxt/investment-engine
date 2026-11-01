"use client";

import { useRef, type ReactNode } from "react";
import { useModalFocus } from "@/hooks/useModalFocus";
import { createPortal } from "react-dom";

/** Presentation and focus boundary only; selection and execution stay with the caller. */
export function ModelPickerDialogFrame({ enabled, title, titleId, panelClassName, overlayClassName, onClose, children }: {
  enabled: boolean;
  title: string;
  titleId?: string;
  panelClassName?: string;
  overlayClassName?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocus(enabled, panelRef, onClose);
  const content = (
    <div className={overlayClassName ?? "fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 px-4 py-6 backdrop-blur-sm"} onClick={onClose}>
      <div ref={panelRef} role={enabled ? "dialog" : undefined} aria-modal={enabled ? true : undefined} tabIndex={-1} aria-labelledby={enabled ? titleId : undefined} aria-label={enabled && !titleId ? title : undefined}
        onClick={event => event.stopPropagation()}
        className={panelClassName ?? `flex ${enabled ? "max-h-[90dvh]" : "max-h-[90vh]"} w-full max-w-3xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl`}>
        {children}
      </div>
    </div>
  );
  return enabled ? createPortal(content, document.body) : content;
}
