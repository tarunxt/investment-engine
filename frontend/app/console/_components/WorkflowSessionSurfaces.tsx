"use client";

import dynamic from "next/dynamic";
import { createPortal } from "react-dom";
import { WorkflowConfigurationProvider, useWorkflowConfiguration } from "./WorkflowConfiguration";
import { WorkflowSurfaceBoundary, type WorkflowSurface } from "./WorkflowSurfaceHost";
import { RebalanceStockFlowWidget } from "@/app/console/dashboard/_components/StockFlowTabs";

const Runtime = dynamic(() => import("@/app/console/automated-rebalance/_components/AutomatedRebalanceClient").then(module => module.AutomatedRebalanceClient), { ssr: false });

function SharedStockFlow() {
  const config = useWorkflowConfiguration();
  return <RebalanceStockFlowWidget
    formulaConfig={config.scoreMatrixFormulaConfig}
    buyThresholds={{ zerodha: config.zerodhaBasketBuyThreshold, indmoneyUs: config.indmoneyBasketBuyThreshold }}
    buyThresholdDrafts={{ zerodha: config.zerodhaBasketBuyThresholdDraft, indmoneyUs: config.indmoneyBasketBuyThresholdDraft }}
    onBuyThresholdDraftChange={(market, value) => {
      const setDraft = market === "zerodha" ? config.setZerodhaBasketBuyThresholdDraft : config.setIndmoneyBasketBuyThresholdDraft;
      const setValue = market === "zerodha" ? config.setZerodhaBasketBuyThreshold : config.setIndmoneyBasketBuyThreshold;
      setDraft(value);
      if (value.trim() && Number.isFinite(Number(value))) setValue(Number(value));
    }}
    buyThresholdSaveError={config.buyThresholdSaveError}
    buyThresholdPersistence={config.buyThresholdPersistence}
  />;
}

export default function WorkflowSessionSurfaces({ workflow, stockFlow, workflowActivated }: {
  workflow: WorkflowSurface | null;
  stockFlow: HTMLElement | null;
  workflowActivated: boolean;
}) {
  return <WorkflowConfigurationProvider>
    {workflowActivated ? <Runtime surface={workflow} /> : null}
    {stockFlow ? createPortal(<WorkflowSurfaceBoundary><SharedStockFlow /></WorkflowSurfaceBoundary>, stockFlow) : null}
  </WorkflowConfigurationProvider>;
}
