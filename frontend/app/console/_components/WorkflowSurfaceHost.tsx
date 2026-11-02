"use client";

import dynamic from "next/dynamic";
import { Component, createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useAuth } from "@/hooks/useAuth";
import { setWorkflowOwner } from "@/lib/workflowOwnerLifetime";
import { reconcileBrowserPrivateCacheOwner } from "@/lib/privateDashboardCache";

export type WorkflowMarket = "zerodha" | "indmoneyUs";
export type WorkflowSurface = { target: HTMLElement; market: WorkflowMarket };
const SessionSurfaces = dynamic(() => import("./WorkflowSessionSurfaces"), { ssr: false });
const SurfaceContext = createContext<{
  registerWorkflow: (surface: WorkflowSurface | null) => void;
  registerStockFlow: (target: HTMLElement | null) => void;
} | null>(null);

export class WorkflowSurfaceBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <p role="alert">This workflow section could not be displayed. Reload to retry.</p> : this.props.children;
  }
}

/** Registers destinations only; importing this host never imports or hydrates workflow data. */
export function WorkflowSurfaceHost({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const [workflow, setWorkflow] = useState<WorkflowSurface | null>(null);
  const [stockFlow, setStockFlow] = useState<HTMLElement | null>(null);
  const [activated, setActivated] = useState<number | null>(null);
  const [workflowActivated, setWorkflowActivated] = useState<number | null>(null);
  const [reconciledOwner, setReconciledOwner] = useState<number | null>(null);
  const owner = !loading && user?.is_active && Number.isSafeInteger(user.id) && user.id > 0 ? user.id : null;
  useEffect(() => {
    if (owner !== null) reconcileBrowserPrivateCacheOwner(owner);
    setWorkflowOwner(owner);
    // Reconciliation is an external storage boundary, completed before private surfaces mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReconciledOwner(owner);
    return () => setWorkflowOwner(null);
  }, [owner]);
  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== "investment-engine:private-cache-owner:v1") return;
      if (event.newValue === String(owner)) return;
      setWorkflowOwner(null);
      setReconciledOwner(null);
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [owner]);
  const registerWorkflow = useCallback((surface: WorkflowSurface | null) => {
    setWorkflow(surface);
    if (surface) { setActivated(owner); setWorkflowActivated(owner); }
  }, [owner]);
  const registerStockFlow = useCallback((target: HTMLElement | null) => {
    setStockFlow(target);
    if (target) setActivated(owner);
  }, [owner]);
  return <SurfaceContext.Provider value={{ registerWorkflow, registerStockFlow }}>
    {children}
    {activated === owner && owner !== null && reconciledOwner === owner ? <WorkflowSurfaceBoundary key={owner}>
      <SessionSurfaces workflow={workflow} stockFlow={stockFlow} workflowActivated={workflowActivated === owner} />
    </WorkflowSurfaceBoundary> : null}
  </SurfaceContext.Provider>;
}

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

export function DashboardStockFlowSlot() {
  const host = useContext(SurfaceContext);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const register = host?.registerStockFlow;
  useWorkflowAnchor(target);
  useEffect(() => {
    if (!target || !register) return;
    register(target);
    return () => register(null);
  }, [target, register]);
  return <section id="rebalance-stock-flow" tabIndex={-1} className="min-w-0 scroll-mt-6" ref={setTarget} aria-label="Shared Rebalance Stock Flow" />;
}
