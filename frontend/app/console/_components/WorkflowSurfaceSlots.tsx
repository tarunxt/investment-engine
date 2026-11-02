"use client";
import { LazyMount } from "@/components/shared/LazyMount";
import { createContext, useContext, useEffect, useState } from "react";
export type WorkflowMarket = "zerodha" | "indmoneyUs";
export type WorkflowSurface = { target: HTMLElement; market: WorkflowMarket };
export const SurfaceContext = createContext<{
  registerWorkflow: (surface: WorkflowSurface | null) => void;
  registerStockFlow: (target: HTMLElement | null) => void;
} | null>(null);


function useWorkflowAnchor(target: HTMLElement | null) {
  useEffect(() => {
    if (!target) return;
    let frame = 0;
    const focus = () => {
      if (window.location.hash !== `#${target.id}` || !target.childElementCount) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { target.focus({ preventScroll: true }); target.scrollIntoView({ block: "start" }); });
    };
    const observer = new MutationObserver(focus);
    observer.observe(target, { childList: true });
    window.addEventListener("hashchange", focus);
    focus();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); window.removeEventListener("hashchange", focus); };
  }, [target]);
}

export function PortfolioWorkflowSlot({ market }: { market: WorkflowMarket }) {
  const host = useContext(SurfaceContext);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const register = host?.registerWorkflow;
  useWorkflowAnchor(target);
  useEffect(() => {
    if (!target || !register) return;
    register({ target, market });
    return () => register(null);
  }, [market, target, register]);
  return <section id={market === "zerodha" ? "india-workflow" : "us-workflow"} tabIndex={-1} className="mt-8 min-w-0 scroll-mt-6" ref={setTarget} aria-label={market === "zerodha" ? "India portfolio workflow" : "US portfolio workflow"} />;
}

export function DashboardStockFlowSlot({ deferred = false }: { deferred?: boolean }) {
  const host = useContext(SurfaceContext);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const register = host?.registerStockFlow;
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  useWorkflowAnchor(anchor);
  useEffect(() => {
    if (!target || !register) return;
    register(target);
    return () => register(null);
  }, [target, register]);
  return <section id="rebalance-stock-flow" tabIndex={-1} className="min-w-0 scroll-mt-6" ref={setAnchor} aria-label="Shared Rebalance Stock Flow">
    {deferred ? <LazyMount deferUntilScroll minHeight={360}><div ref={setTarget} /></LazyMount> : <div ref={setTarget} />}
  </section>;
}
