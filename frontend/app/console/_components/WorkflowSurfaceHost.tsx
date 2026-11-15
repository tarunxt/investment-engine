"use client";

import dynamic from "next/dynamic";
import { createPortal } from "react-dom";
import { Component, useCallback, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { useAuth } from "@/hooks/useAuth";
import { captureWorkflowOwner, setWorkflowOwner } from "@/lib/workflowOwnerLifetime";
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
  const [reconciledGeneration, setReconciledGeneration] = useState(0);
  const [reconciledOwner, setReconciledOwner] = useState<number | null>(null);
  const owner = !loading && user?.is_active && Number.isSafeInteger(user.id) && user.id > 0 ? user.id : null;
  // Invalidate during commit, before old passive-effect queues can use new ambient auth.
  useLayoutEffect(() => {
    setWorkflowOwner(null);
    return () => setWorkflowOwner(null);
  }, [owner]);
  useEffect(() => {
    if (owner !== null) reconcileBrowserPrivateCacheOwner(owner);
    setWorkflowOwner(owner);
    // Reconciliation is an external storage boundary, completed before private surfaces mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReconciledGeneration(captureWorkflowOwner()?.generation ?? 0);
    setReconciledOwner(owner);
    return () => setWorkflowOwner(null);
  }, [owner]);
  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== "investment-engine:private-cache-owner:v1") return;
      // Storage is only a reconciliation hint. It cannot authenticate a new owner.
      let storedOwner: string | null = null;
      try { storedOwner = window.localStorage.getItem("investment-engine:private-cache-owner:v1"); } catch { /* Stay closed when storage cannot be verified. */ }
      if (owner !== null && event.newValue === String(owner) && storedOwner === String(owner)) {
        reconcileBrowserPrivateCacheOwner(owner);
        setWorkflowOwner(owner);
        setReconciledGeneration(captureWorkflowOwner()?.generation ?? 0);
        setReconciledOwner(owner);
        return;
      }
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
    {activated === owner && owner !== null && reconciledOwner !== owner ? [workflow?.target, stockFlow].filter((target): target is HTMLElement => Boolean(target)).map((target, index) => createPortal(
      <p role="alert">Account confirmation changed in another tab. This workflow will return when the same signed-in account is confirmed. <button type="button" className="underline" onClick={() => window.location.reload()}>Reload to retry</button></p>, target, `owner-reconciliation-${index}`,
    )) : null}
    {activated === owner && owner !== null && reconciledOwner === owner ? <WorkflowSurfaceBoundary key={`${owner}:${reconciledGeneration}`}>
      <SessionSurfaces workflow={workflow} stockFlow={stockFlow} workflowActivated={workflowActivated === owner} />
    </WorkflowSurfaceBoundary> : null}
  </SurfaceContext.Provider>;
}

