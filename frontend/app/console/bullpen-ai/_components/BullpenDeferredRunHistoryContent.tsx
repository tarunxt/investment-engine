"use client";

import { lazy, Suspense, useLayoutEffect, type RefObject } from "react";
import { useReviewDialog } from "@/hooks/useReviewDialog";
import type { BullpenRunHistoryContentProps } from "./BullpenRunHistoryContent";

type PresentationProps = {
  historyProps: BullpenRunHistoryContentProps;
  panel: RefObject<HTMLDivElement | null>;
};

const HistoryPresentation = lazy(async () => {
  const { BullpenRunHistoryContent } = await import("./BullpenRunHistoryContent");
  return {
    default: function LoadedHistory({ historyProps, panel }: PresentationProps) {
      useLayoutEffect(() => {
        // The loading Close button is removed when the chunk resolves. Keep
        // keyboard focus in the same review overlay across that transition.
        if (document.activeElement === document.body || document.activeElement === panel.current) {
          panel.current?.querySelector<HTMLElement>('[aria-label="Close Bullpen run history"]')?.focus();
        }
      }, [panel]);
      return <BullpenRunHistoryContent {...historyProps} />;
    },
  };
});

export function BullpenDeferredRunHistoryContent(props: BullpenRunHistoryContentProps) {
  const review = useReviewDialog<HTMLDivElement>(true, props.onClose ?? (() => {}));
  return (
    <div {...review} role="dialog" aria-modal="true" aria-label="Bullpen run history">
      <Suspense fallback={
        <div className="rounded-3xl bg-white p-6 text-slate-950">
          <p role="status">Loading Bullpen run history…</p>
          <button type="button" aria-label="Close Bullpen run history" onClick={props.onClose}>
            Close
          </button>
        </div>
      }>
        <HistoryPresentation historyProps={props} panel={review.ref} />
      </Suspense>
    </div>
  );
}
