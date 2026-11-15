"use client";

import { useEffect, useRef, type RefObject } from "react";

/** For a single modal portalled to body. Keep the session stable across content rerenders. */
export function useModalFocus(open: boolean, panel: RefObject<HTMLElement | null>, onClose: () => void) {
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; }, [onClose]);
  useEffect(() => {
    const dialog = panel.current;
    if (!open || !dialog) return;
    const opener = document.activeElement;
    const siblings = Array.from(document.body.children)
      .filter((element): element is HTMLElement => element instanceof HTMLElement && !element.contains(dialog))
      .map(element => ({ element, inert: element.inert }));
    const previousOverflow = document.body.style.overflow;
    for (const { element } of siblings) element.inert = true;
    document.body.style.overflow = "hidden";
    const controls = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button, summary, a[href], input, select, textarea, [tabindex]',
    )).filter(element => element.tabIndex >= 0 && !element.matches(':disabled, [inert], [inert] *') && element.getClientRects().length > 0);
    const focusFirst = () => (dialog.querySelector<HTMLElement>('[data-dialog-initial-focus]') ?? controls()[0] ?? dialog).focus();
    const containFocus = (event: FocusEvent) => {
      if (!dialog.contains(event.target as Node)) focusFirst();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close.current();
      }
      if (event.key !== "Tab") return;
      const items = controls(), first = items[0], last = items.at(-1);
      if (!first) { event.preventDefault(); dialog.focus(); }
      else if (!dialog.contains(document.activeElement) || document.activeElement === dialog) {
        event.preventDefault(); (event.shiftKey ? last : first)?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    focusFirst();
    document.addEventListener("focusin", containFocus);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("focusin", containFocus);
      document.removeEventListener("keydown", handleKeyDown, true);
      for (const { element, inert } of siblings) element.inert = inert;
      document.body.style.overflow = previousOverflow;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [open, panel]);
}
