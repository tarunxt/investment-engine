"use client";
import { useEffect, useRef, useState } from "react";
import { BasketModalLayer } from "./BasketMetricPopup";

export function basketClosedMarketMessage(mode: "direct_market" | "publisher_limit") {
  return mode === "direct_market"
    ? "NSE/BSE regular market appears closed now. Protected MARKET orders can be submitted only during regular market hours."
    : "NSE/BSE regular market appears closed now. This Basket’s Market drafts require enabled direct broker access during regular market hours. Place Order is unavailable in the current mode.";
}

/** Status explanation only: never changes mode, refreshes quotes or submits orders. */
export function BasketMarketClosedNotice({ closed, executionMode, onOpenChange }: {
  closed: boolean; executionMode: "direct_market" | "publisher_limit"; onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const visible = closed && open;
  useEffect(() => {
    onOpenChange?.(visible);
    return () => onOpenChange?.(false);
  }, [visible, onOpenChange]);
  useEffect(() => { if (!closed) setOpen(false); }, [closed]);
  const close = () => {
    setOpen(false);
    onOpenChange?.(false);
    requestAnimationFrame(() => trigger.current?.focus());
  };
  if (!closed) return null;
  return <>
    <button ref={trigger} type="button" aria-haspopup="dialog" aria-expanded={visible}
      className="rounded-full border border-amber-300 bg-amber-100 px-3 py-1 text-xs font-bold text-amber-900 transition hover:bg-amber-200 focus:outline-none focus:ring-2 focus:ring-amber-500"
      onClick={() => { setOpen(true); onOpenChange?.(true); }}>Markets closed</button>
    {visible && <BasketModalLayer title="Markets closed" eyebrow="Zerodha Basket" onClose={close}
      footer={<button type="button" className="rounded-full bg-emerald-100 px-5 py-2 font-semibold text-emerald-950" onClick={close}>Done</button>}>
      <p>{basketClosedMarketMessage(executionMode)}</p>
    </BasketModalLayer>}
  </>;
}
