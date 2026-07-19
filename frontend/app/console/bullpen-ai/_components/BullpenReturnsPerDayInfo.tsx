"use client";

import type { ReactNode } from "react";

import { Info, X } from "lucide-react";

import { cn } from "@/lib/utils";

type BullpenReturnsPerDayFormulaDialogProps = {
  onClose: () => void;
};

type BullpenReturnsPerDayHeaderInfoProps = {
  onOpen: () => void;
  className?: string;
};

type BullpenReturnsPerDayValueButtonProps = {
  children: ReactNode;
  disabled?: boolean;
  onOpen: () => void;
  ariaLabel: string;
  className?: string;
};

export function BullpenReturnsPerDayHeaderInfo({
  onOpen,
  className,
}: BullpenReturnsPerDayHeaderInfoProps) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      className={cn(
        "inline-flex h-4 w-4 items-center justify-center rounded-full border border-slate-400 text-slate-500 transition hover:border-sky-500 hover:bg-sky-50 hover:text-sky-700 focus:outline-none focus:ring-2 focus:ring-sky-300",
        className,
      )}
      aria-label="Show Returns/day formula"
      title="Show Returns/day formula"
    >
      <Info className="h-3 w-3" />
    </button>
  );
}

export function BullpenReturnsPerDayHeader({
  onOpen,
}: BullpenReturnsPerDayHeaderInfoProps) {
  return (
    <span className="inline-flex items-center gap-1">
      <span>Returns/day</span>
      <BullpenReturnsPerDayHeaderInfo onOpen={onOpen} />
    </span>
  );
}

export function BullpenReturnsPerDayValueButton({
  children,
  disabled = false,
  onOpen,
  ariaLabel,
  className,
}: BullpenReturnsPerDayValueButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      className={cn(
        "rounded-md px-2 py-1 text-left underline decoration-slate-300 underline-offset-4 transition hover:text-sky-700 disabled:cursor-not-allowed disabled:no-underline disabled:opacity-60",
        className,
      )}
      aria-label={ariaLabel}
      title={disabled ? undefined : "Show Returns/day calculation"}
    >
      {children}
    </button>
  );
}

export function BullpenReturnsPerDayFormulaDialog({
  onClose,
}: BullpenReturnsPerDayFormulaDialogProps) {
  return (
    <div className="fixed inset-0 z-[190] flex items-center justify-center bg-slate-950/60 p-4 text-slate-950">
      <div className="w-full max-w-xl overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.55)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-sky-700">
              Returns/day formula
            </p>
            <h2 className="mt-2 text-xl font-semibold text-slate-950">
              How Returns/day is calculated
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close Returns/day formula"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-4 px-6 py-5 text-sm leading-6 text-slate-600">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
              New event rows
            </div>
            <p className="mt-3 font-semibold text-slate-950">
              Max(Current Yes odds, Current No odds) / days left
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
              Active position rows
            </div>
            <p className="mt-3 font-semibold text-slate-950">
              (100 - current position price) / days until close
            </p>
          </div>
          <p>
            Click any Returns/day value to see the event-specific inputs and arithmetic used for that displayed percentage.
          </p>
        </div>
      </div>
    </div>
  );
}
