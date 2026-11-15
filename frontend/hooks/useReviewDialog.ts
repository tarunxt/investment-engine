"use client";

import { useCallback, useEffect, useRef, type KeyboardEvent } from "react";

/** Local review overlays retain their opener; nested dialogs own their own keys. */
export function useReviewDialog<T extends HTMLElement>(open: boolean, onClose: () => void) {
  const panel = useRef<T | null>(null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; }, [onClose]);
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement;
    panel.current?.focus();
    return () => { if (opener instanceof HTMLElement && opener.isConnected) opener.focus(); };
  }, [open]);
  const onKeyDown = useCallback((event: KeyboardEvent<T>) => {
    if (!(event.target instanceof Element) || event.target.closest('[role="dialog"],dialog') !== panel.current) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close.current(); return; }
    if (event.key !== "Tab") return;
    event.stopPropagation();
    const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]') ?? []).filter(node => node.getClientRects().length > 0 && !node.closest('[inert]'));
    const first = controls[0], last = controls.at(-1);
    if (!first) { event.preventDefault(); panel.current?.focus(); }
    else if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first.focus(); }
  }, []);
  return { ref: panel, tabIndex: -1, onKeyDown };
}
