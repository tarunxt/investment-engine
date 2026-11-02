"use client";

import { lazy, Suspense, useLayoutEffect, type ComponentProps, type ComponentType, type RefObject } from "react";
import { useReviewDialog } from "@/hooks/useReviewDialog";
import type * as Views from "./BullpenDetailPresentation";

function deferPanel<P extends { onClose: () => void }>(
  load: () => Promise<{ default: ComponentType<P> }>,
  label: string,
  layer: number,
) {
  const View = lazy(async () => {
    const { default: Content } = await load();
    return {
      default: function LoadedPanel({ props, panel }: { props: P; panel: RefObject<HTMLDivElement | null> }) {
        useLayoutEffect(() => {
          if (document.activeElement === document.body || document.activeElement === panel.current) {
            panel.current?.querySelector<HTMLElement>('button[aria-label^="Close "]')?.focus();
          }
        }, [panel]);
        return <Content {...props} />;
      },
    };
  });
  return function DeferredPanel(props: P) {
    const review = useReviewDialog<HTMLDivElement>(true, props.onClose);
    return (
      <div {...review} role="dialog" aria-modal="true" aria-label={label} className="fixed inset-0 outline-none" style={{ zIndex: layer }}>
        <Suspense fallback={
          <div className="flex h-full items-center justify-center bg-slate-950/60 p-4 text-slate-950">
            <div className="rounded-3xl bg-white p-6">
              <p role="status">Loading details…</p>
              <button type="button" aria-label="Close loading details" onClick={props.onClose}>Close</button>
            </div>
          </div>
        }>
          <View props={props} panel={review.ref} />
        </Suspense>
      </div>
    );
  };
}

export const RunWarningsDialog = deferPanel<ComponentProps<typeof Views.RunWarningsDialog>>(
  () => import("./BullpenDetailPresentation").then((m) => ({ default: m.RunWarningsDialog })), "Run warnings", 155,
);
export const DecisionLlmOddsDialog = deferPanel<ComponentProps<typeof Views.DecisionLlmOddsDialog>>(
  () => import("./BullpenDetailPresentation").then((m) => ({ default: m.DecisionLlmOddsDialog })), "LLM odds breakdown", 155,
);
export const PlannedOrderDetailDialog = deferPanel<ComponentProps<typeof Views.PlannedOrderDetailDialog>>(
  () => import("./BullpenDetailPresentation").then((m) => ({ default: m.PlannedOrderDetailDialog })), "Planned order details", 155,
);
export const StageTwoInputPromptDialog = deferPanel<ComponentProps<typeof Views.StageTwoInputPromptDialog>>(
  () => import("./BullpenDetailPresentation").then((m) => ({ default: m.StageTwoInputPromptDialog })), "Stage 2 input prompt", 170,
);
export const StageTwoLlmFailureDialog = deferPanel<ComponentProps<typeof Views.StageTwoLlmFailureDialog>>(
  () => import("./BullpenDetailPresentation").then((m) => ({ default: m.StageTwoLlmFailureDialog })), "LLM failure details", 170,
);
export const StageTwoLlmEventInputDialog = deferPanel<ComponentProps<typeof Views.StageTwoLlmEventInputDialog>>(
  () => import("./BullpenDetailPresentation").then((m) => ({ default: m.StageTwoLlmEventInputDialog })), "Event LLM input", 170,
);
export const StageTwoDecisionDetailDialog = deferPanel<ComponentProps<typeof Views.StageTwoDecisionDetailDialog>>(
  () => import("./BullpenDetailPresentation").then((m) => ({ default: m.StageTwoDecisionDetailDialog })), "Decision details", 170,
);
