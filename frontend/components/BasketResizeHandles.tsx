"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";

const edges = {
  left: { axis: "width", sign: -1, position: "-left-[8px]" },
  right: { axis: "width", sign: 1, position: "-right-[8px]" },
  top: { axis: "height", sign: -1, position: "-top-[8px]" },
  bottom: { axis: "height", sign: 1, position: "-bottom-[8px]" },
} as const;
type Side = keyof typeof edges;
type Axis = "width" | "height";
const minimum = { width: 320, height: 280 };
const axes = ["width", "height"] as const;

export function BasketResizeHandles({ panelRef, owner, label = "basket" }: { owner?: number | null; label?: string; panelRef: RefObject<HTMLElement | null> }) {
  const variablePrefix = label === "basket" ? "--basket-" : "--popup-";
  const drag = useRef<{ pointerId: number; start: number; size: number } | null>(null);
  const [sizes, setSizes] = useState({ width: 0, height: 0, availableWidth: 0, availableHeight: 0 });

  useEffect(() => {
    const panel = panelRef.current;
    const backdrop = panel?.parentElement;
    if (!panel || !backdrop) return;
    for (const axis of axes) {
      panel.style.removeProperty(variablePrefix + axis);
      if (!owner) continue;
      try {
        const saved = Number(localStorage.getItem(`basket-${axis}:user:${owner}`));
        if (Number.isFinite(saved) && saved >= minimum[axis]) panel.style.setProperty(variablePrefix + axis, saved + "px");
      } catch { /* Storage can be disabled. */ }
    }
    const measure = () => {
      const css = getComputedStyle(backdrop);
      const rect = panel.getBoundingClientRect();
      setSizes({ width: Math.round(rect.width), height: Math.round(rect.height),
        availableWidth: Math.round(backdrop.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight)),
        availableHeight: Math.round(backdrop.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom)) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    observer.observe(backdrop);
    return () => observer.disconnect();
  }, [panelRef, owner, variablePrefix]);

  function resize(axis: Axis, size: number, persist: boolean) {
    const available = axis === "width" ? sizes.availableWidth : sizes.availableHeight;
    if (available <= 0) return;
    const clamped = Math.min(available, Math.max(minimum[axis], size));
    panelRef.current?.style.setProperty(variablePrefix + axis, clamped + "px");
    if (persist && owner) {
      try { localStorage.setItem(`basket-${axis}:user:${owner}`, String(clamped)); } catch { /* Keep the in-session size. */ }
    }
  }

  return (Object.keys(edges) as Side[]).map(side => {
    const { axis, sign, position } = edges[side];
    const horizontal = axis === "width";
    const available = horizontal ? sizes.availableWidth : sizes.availableHeight;
    const coordinate = (event: PointerEvent<HTMLDivElement>) => horizontal ? event.clientX : event.clientY;
    function move(event: PointerEvent<HTMLDivElement>, persist = false) {
      const active = drag.current;
      if (active?.pointerId === event.pointerId) resize(axis, active.size + 2 * sign * (coordinate(event) - active.start), persist);
    }
    function finish(event: PointerEvent<HTMLDivElement>) {
      if (drag.current?.pointerId !== event.pointerId) return;
      if (event.type === "pointerup") move(event, true);
      drag.current = null;
    }
    function keyDown(event: KeyboardEvent<HTMLDivElement>) {
      const size = panelRef.current?.getBoundingClientRect()[axis];
      if (size === undefined) return;
      if (event.key === "Home") resize(axis, 0, true);
      else if (event.key === "End") resize(axis, available, true);
      else if (event.key === (horizontal ? "ArrowLeft" : "ArrowUp")) resize(axis, size - 32 * sign, true);
      else if (event.key === (horizontal ? "ArrowRight" : "ArrowDown")) resize(axis, size + 32 * sign, true);
      else return;
      event.preventDefault();
    }
    return <div key={side} data-side={side} role="separator" tabIndex={0}
      aria-label={`Resize ${label} from ${side} edge`} aria-orientation={horizontal ? "vertical" : "horizontal"}
      aria-valuemin={Math.min(minimum[axis], available)} aria-valuemax={available} aria-valuenow={sizes[axis]}
      aria-valuetext={`${sizes[axis]} pixels ${horizontal ? "wide" : "high"}`}
      className={`absolute z-30 touch-none select-none rounded-full focus-visible:outline-2 focus-visible:outline-blue-600 ${horizontal ? "inset-y-3 w-[12px] cursor-ew-resize" : "inset-x-3 h-[12px] cursor-ns-resize"} ${position}`}
      onPointerDown={event => {
        const panel = panelRef.current;
        if (!panel || !event.isPrimary || event.button !== 0 || drag.current) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, start: coordinate(event), size: panel.getBoundingClientRect()[axis] };
      }}
      onPointerMove={event => move(event)} onPointerUp={finish} onPointerCancel={finish}
      onLostPointerCapture={finish} onKeyDown={keyDown} />;
  });
}
