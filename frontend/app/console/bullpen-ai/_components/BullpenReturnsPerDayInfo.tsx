"use client";

import { useEffect, useState, type ReactNode } from "react";

import { Info, Loader2, Save, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { apiService } from "@/services/api";

export const DEFAULT_RETURNS_PER_DAY_FORMULA =
  "=(100-CURRENT_CHOSEN_SIDE_BULLPEN_ODDS)/(DAYS_UNTIL_CLOSE+4)";

type BullpenReturnsPerDayFormulaDialogProps = {
  onClose: () => void;
  loadFormula?: () => Promise<string>;
  saveFormula?: (formula: string) => Promise<string>;
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
  loadFormula,
  saveFormula: saveFormulaOverride,
}: BullpenReturnsPerDayFormulaDialogProps) {
  const [formula, setFormula] = useState(DEFAULT_RETURNS_PER_DAY_FORMULA);
  const [savedFormula, setSavedFormula] = useState(DEFAULT_RETURNS_PER_DAY_FORMULA);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const request = loadFormula
      ? loadFormula()
      : apiService
          .getBullpenAutoLiveSettings()
          .then((settings) => settings.returns_per_day_formula);
    void request
      .then((saved) => {
        if (!active) return;
        const next = saved || DEFAULT_RETURNS_PER_DAY_FORMULA;
        setFormula(next);
        setSavedFormula(next);
      })
      .catch(() => {
        if (active) setMessage("Could not load the saved formula. The default is shown.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [loadFormula]);

  const saveFormula = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const saved = saveFormulaOverride
        ? await saveFormulaOverride(formula)
        : (
            await apiService.updateBullpenAutoLiveSettings({
              returns_per_day_formula: formula,
            })
          ).returns_per_day_formula;
      setFormula(saved);
      setSavedFormula(saved);
      setMessage("Formula saved. It will be used for all new event calculations.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Formula could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[190] flex items-center justify-center bg-slate-950/60 p-4 text-slate-950" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="w-full max-w-xl overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.55)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-sky-700">
              Returns/day formula
            </p>
            <h2 className="mt-2 text-xl font-semibold text-slate-950">Returns/day formula</h2>
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
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Excel-style formula</span>
            <textarea
              value={formula}
              onChange={(event) => setFormula(event.target.value)}
              disabled={loading || saving}
              rows={3}
              spellCheck={false}
              className="mt-2 w-full resize-y rounded-2xl border border-slate-300 bg-slate-50 px-4 py-3 font-mono text-sm font-semibold text-slate-950 outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-200 disabled:opacity-60"
              aria-label="Returns/day Excel-style formula"
            />
          </label>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs">
            <p className="font-semibold text-slate-700">Available fields</p>
            <code className="mt-2 block break-all text-sky-800">CURRENT_CHOSEN_SIDE_BULLPEN_ODDS</code>
            <code className="mt-1 block break-all text-sky-800">DAYS_UNTIL_CLOSE</code>
            <p className="mt-3 text-slate-500">Start with = and use numbers, parentheses, +, -, *, / or ^.</p>
          </div>
          {message && <p role="status" className={`rounded-xl px-3 py-2 text-xs font-semibold ${message.startsWith("Formula saved") ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-900"}`}>{message}</p>}
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-slate-500">The saved formula is remembered for future runs and all event types.</p>
            <button type="button" onClick={saveFormula} disabled={loading || saving || formula.trim() === savedFormula} className="inline-flex shrink-0 items-center rounded-xl bg-sky-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-800 disabled:cursor-not-allowed disabled:opacity-50">
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              Save formula
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
