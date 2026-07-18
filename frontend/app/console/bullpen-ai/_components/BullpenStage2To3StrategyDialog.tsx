"use client";

import { useEffect, useId, useRef } from "react";
import { Info, ShieldAlert, Wallet, X, Zap } from "lucide-react";

type BullpenStage2To3StrategyDialogProps = {
  open: boolean;
  onClose: () => void;
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
  minLlmSideOdds: number;
  maxPositions: number;
  rankingFieldLabel: string;
  rankingTieBreakLabel: string;
  sizingFormulaLabel: string;
  universeStatus?: {
    totalEligibleRows: number | null;
    reviewedRows: number | null;
    skippedRows: number | null;
    isComplete: boolean;
    blockerCode: string | null;
    blockerSummary: string | null;
    blockerFix: string | null;
  } | null;
};

function StrategySection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-slate-50/85 p-4">
      <h3 className="text-sm font-semibold text-slate-950">{title}</h3>
      <div className="mt-2 text-sm leading-6 text-slate-700">{children}</div>
    </section>
  );
}

export function BullpenStage2To3StrategyDialog({
  open,
  onClose,
  triggerRef,
  minLlmSideOdds,
  maxPositions,
  rankingFieldLabel,
  rankingTieBreakLabel,
  sizingFormulaLabel,
  universeStatus = null,
}: BullpenStage2To3StrategyDialogProps) {
  const titleId = useId();
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (!open) {
      if (wasOpenRef.current) {
        triggerRef?.current?.focus();
      }
      wasOpenRef.current = false;
      return;
    }

    wasOpenRef.current = true;
    window.queueMicrotask(() => {
      closeButtonRef.current?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, open, triggerRef]);

  if (!open) return null;

  const reviewedRowsText =
    universeStatus?.reviewedRows !== null && universeStatus?.reviewedRows !== undefined
      ? universeStatus.reviewedRows.toLocaleString("en-IN")
      : "all reviewed rows";
  const totalEligibleRowsText =
    universeStatus?.totalEligibleRows !== null &&
    universeStatus?.totalEligibleRows !== undefined
      ? universeStatus.totalEligibleRows.toLocaleString("en-IN")
      : "all eligible rows";
  const skippedRowsText =
    universeStatus?.skippedRows !== null && universeStatus?.skippedRows !== undefined
      ? universeStatus.skippedRows.toLocaleString("en-IN")
      : "0";

  return (
    <div
      className="fixed inset-0 z-[140] flex items-center justify-center bg-slate-950/70 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="stage2-to-3-strategy-dialog"
        className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.55)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-sky-600">
              Stage 3 Reference
            </p>
            <h2 id={titleId} className="text-xl font-semibold text-slate-950">
              Stage 2 → Stage 3 Planned Strategy
            </h2>
            <p className="max-w-3xl text-sm text-slate-600">
              Stage 3 keeps the strongest combined Bullpen portfolio of up to{" "}
              {maxPositions} active and new events without triggering a run from
              this dialog.
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close Stage 2 to Stage 3 planned strategy"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
          <StrategySection title="1. Investment philosophy">
            Maintain the strongest combined portfolio of up to {maxPositions}{" "}
            active and new Bullpen events.
          </StrategySection>

          <StrategySection title="2. Stage 2 universe">
            Stage 2 must review every eligible active Bullpen position plus
            every new event that passed Stage 1.
            <div className="mt-2 rounded-xl border border-sky-100 bg-sky-50/80 px-3 py-2 text-xs text-sky-900">
              Eligible rows: {totalEligibleRowsText} · Reviewed rows:{" "}
              {reviewedRowsText} · Skipped rows: {skippedRowsText} · Universe{" "}
              {universeStatus?.isComplete === false ? "incomplete" : "complete"}
            </div>
            {universeStatus?.isComplete === false &&
            (universeStatus.blockerSummary || universeStatus.blockerFix) ? (
              <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50/80 px-3 py-2 text-xs text-amber-950">
                {universeStatus.blockerSummary ? (
                  <p>
                    <span className="font-semibold">Why:</span>{" "}
                    {universeStatus.blockerSummary}
                  </p>
                ) : null}
                {universeStatus.blockerFix ? (
                  <p className={universeStatus.blockerSummary ? "mt-1" : undefined}>
                    <span className="font-semibold">What to do:</span>{" "}
                    {universeStatus.blockerFix}
                  </p>
                ) : null}
              </div>
            ) : null}
          </StrategySection>

          <StrategySection title="3. Eligibility">
            The stronger LLM Yes or No side must be at least{" "}
            <span className="font-semibold">{minLlmSideOdds}</span>, including
            exactly {minLlmSideOdds}. Returns/day must also be usable and the
            required market data must be valid.
          </StrategySection>

          <StrategySection title="4. Ranking">
            Qualifying active positions and qualifying new opportunities enter
            one combined ranking sorted by{" "}
            <span className="font-semibold">{rankingFieldLabel}</span>{" "}
            descending with a deterministic tie-break on{" "}
            <span className="font-semibold">{rankingTieBreakLabel}</span>. Only
            the first {maxPositions} rows survive.
          </StrategySection>

          <div className="grid gap-4 lg:grid-cols-2">
            <StrategySection title="5. Existing-position treatment">
              <div className="flex items-start gap-2">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose-700" />
                <p>
                  Active positions that stay inside the final top {maxPositions}{" "}
                  are retained. Displaced positions move to Event Exit, but
                  forced exits, dust handling, and redeem/claim logic can still
                  override a normal hold decision.
                </p>
              </div>
            </StrategySection>

            <StrategySection title="6. New-position treatment">
              <div className="flex items-start gap-2">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-700" />
                <p>
                  Stage 3 buys only new rows that survive the final top{" "}
                  {maxPositions} and are not already active, pending, submitted,
                  or duplicated in the current run.
                </p>
              </div>
            </StrategySection>
          </div>

          <StrategySection title="7. Execution sequence">
            <div className="flex items-start gap-2">
              <Zap className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
              <p>
                Event Exits run first, wallet positions and pending orders
                refresh second, and new investments are sized and submitted
                third. Failed or unsettled exits do not free cash or slots.
              </p>
            </div>
          </StrategySection>

          <div className="grid gap-4 lg:grid-cols-2">
            <StrategySection title="8. Formula">
              <div className="flex items-start gap-2">
                <Wallet className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />
                <div>
                  <p className="font-semibold text-slate-950">
                    {sizingFormulaLabel}
                  </p>
                  <p className="mt-2">
                    Post-exit buys use fresh live cash only. A stale cached
                    amount can be shown for diagnostics, but it never authorizes
                    a live buy.
                  </p>
                </div>
              </div>
            </StrategySection>

            <StrategySection title="9. Side selection">
              Buy the stronger qualifying LLM side. Example: Yes 83 / No 17 buys
              Yes, while Yes 20 / No 80 buys No.
            </StrategySection>
          </div>

          <StrategySection title="10. Safety overlays">
            Forced exits, dust handling, and redeem/claim logic can override the
            normal ranking action when they are needed for safe execution.
          </StrategySection>

          <StrategySection title="11. Worked example">
            <div className="rounded-xl border border-slate-200 bg-white px-3 py-3 text-xs leading-6 text-slate-700">
              Combined ranking after Stage 2 review:
              <br />
              1. Active A 4.8 returns/day
              <br />
              2. New B 4.5 returns/day
              <br />
              …
              <br />
              9. Active I 2.1 returns/day
              <br />
              10. New J 2.0 returns/day
              <br />
              11. Active K 1.9 returns/day → moves to Event Exit
              <br />
              If exits settle and the refreshed wallet shows $30 cash with 8
              occupied positions, available slots = 2, so each new planned buy
              is sized at $15 before live revalidation.
            </div>
          </StrategySection>
        </div>
      </div>
    </div>
  );
}
