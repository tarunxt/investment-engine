"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";

type Side = "left" | "right";
type Drag = { pointerId: number; startX: number; startWidth: number };

export function BasketResizeHandles({ panelRef }: { panelRef: RefObject<HTMLDivElement | null> }) {
  const drag = useRef<Drag | null>(null);
  const [widths, setWidths] = useState({ current: 0, available: 0 });

  useEffect(() => {
    const panel = panelRef.current;
    const backdrop = panel?.parentElement;
    if (!panel || !backdrop) return;
    const measure = () => {
      const style = getComputedStyle(backdrop);
      const available = backdrop.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      setWidths({ current: Math.round(panel.getBoundingClientRect().width), available: Math.round(available) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    observer.observe(backdrop);
    return () => observer.disconnect();
  }, [panelRef]);

  function start(event: PointerEvent<HTMLDivElement>) {
    const panel = panelRef.current;
    if (!panel || !event.isPrimary || event.button !== 0 || drag.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: panel.getBoundingClientRect().width };
  }

  function move(event: PointerEvent<HTMLDivElement>, side: Side) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const outward = (event.clientX - active.startX) * (side === "right" ? 1 : -1);
    // The grabbed edge follows the pointer and the opposite edge moves just as far.
    resize(active.startWidth + 2 * outward);
  }

  function resize(width: number) {
    const clamped = Math.min(widths.available, Math.max(320, width));
    panelRef.current?.style.setProperty("--basket-width", clamped + "px");
  }

  function finish(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>, side: Side) {
    const width = panelRef.current?.getBoundingClientRect().width;
    if (width === undefined) return;
    const step = side === "right" ? 32 : -32;
    switch (event.key) {
      case "ArrowLeft": resize(width - step); break;
      case "ArrowRight": resize(width + step); break;
      case "Home": resize(0); break;
      case "End": resize(widths.available); break;
      default: return;
    }
    event.preventDefault();
  }

  return (["left", "right"] as const).map(side => (
    <div
      key={side}
      role="separator"
      tabIndex={0}
      aria-label={`Resize basket from ${side} edge`}
      aria-orientation="vertical"
      aria-valuemin={Math.min(320, widths.available)}
      aria-valuemax={widths.available}
      aria-valuenow={widths.current}
      aria-valuetext={`${widths.current} pixels wide`}
      className={`absolute inset-y-3 z-30 w-[12px] touch-none cursor-ew-resize select-none rounded-full focus-visible:outline-2 focus-visible:outline-blue-600 ${side === "left" ? "-left-[8px]" : "-right-[8px]"}`}
      onPointerDown={start}
      onPointerMove={event => move(event, side)}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onKeyDown={event => keyDown(event, side)}
    />
  ));
}
