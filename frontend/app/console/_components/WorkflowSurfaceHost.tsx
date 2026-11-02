"use client";

import dynamic from "next/dynamic";
import { Component, useCallback, useEffect, useState, type ReactNode } from "react";
import { useAuth } from "@/hooks/useAuth";
import { setWorkflowOwner } from "@/lib/workflowOwnerLifetime";
import { reconcileBrowserPrivateCacheOwner } from "@/lib/privateDashboardCache";

import { SurfaceContext, type WorkflowSurface } from "./WorkflowSurfaceSlots";
export type { WorkflowSurface, WorkflowMarket } from "./WorkflowSurfaceSlots";
export { PortfolioWorkflowSlot, DashboardStockFlowSlot } from "./WorkflowSurfaceSlots";
const SessionSurfaces = dynamic(() => import("./WorkflowSessionSurfaces"), { ssr: false });

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

