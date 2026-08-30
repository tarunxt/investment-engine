"use client";

import { useEffect, useState } from "react";
import { Check, Info, Loader2, X } from "lucide-react";

import {
  BULLPEN_SCAN_FILTER_DETAILS,
  type BullpenScanFilterDetailId,
} from "@/lib/bullpenScanExclusions";
import { BullpenScanFilterDetailsDialog } from "./BullpenScanFilterDetailsDialog";
import { apiService } from "@/services/api";

const FILTER_ORDER = Object.keys(
  BULLPEN_SCAN_FILTER_DETAILS,
) as BullpenScanFilterDetailId[];

export function BullpenScanFiltersPopupBridge() {
  const [isOpen, setIsOpen] = useState(false);
  const [detailId, setDetailId] = useState<BullpenScanFilterDetailId | null>(null);
  const [oddsFloor, setOddsFloor] = useState(5);
  const [savedOddsFloor, setSavedOddsFloor] = useState(5);
  const [isFloorLoading, setIsFloorLoading] = useState(false);
  const [isFloorSaving, setIsFloorSaving] = useState(false);
  const [floorMessage, setFloorMessage] = useState<string | null>(null);
  const [customExcludePhrases, setCustomExcludePhrases] = useState<string[]>([]);

  useEffect(() => {
    async function loadOddsFloor() {
      setIsFloorLoading(true);
      setFloorMessage(null);
      try {
        const settings = await apiService.getBullpenAutoLiveSettings();
        const saved = settings.console_min_market_odds ?? 5;
        setOddsFloor(saved);
        setSavedOddsFloor(saved);
        setCustomExcludePhrases(settings.console_custom_exclude_phrases ?? []);
      } catch {
        setFloorMessage("Could not load the saved odds floor. The default 5% is shown.");
      } finally {
        setIsFloorLoading(false);
      }
    }

    function handleClick(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const trigger = target.closest(
        'button[aria-label="Open scan filters"],button[title="Open scan filters"]',
      );
      if (!trigger) return;
      setIsOpen(true);
      void loadOddsFloor();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (detailId) {
        setDetailId(null);
        return;
      }
      setIsOpen(false);
    }

    document.addEventListener("click", handleClick, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("click", handleClick, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [detailId]);

  async function saveOddsFloor() {
    if (!Number.isFinite(oddsFloor) || oddsFloor < 0 || oddsFloor >= 50) {
      setFloorMessage("Enter a number from 0 up to 49.9%.");
      return;
    }
    setIsFloorSaving(true);
    setFloorMessage(null);
    try {
      const settings = await apiService.updateBullpenAutoLiveSettings({
        console_min_market_odds: oddsFloor,
      });
      const saved = settings.console_min_market_odds;
      setOddsFloor(saved);
      setSavedOddsFloor(saved);
      setFloorMessage(
        `Saved. Future Stage 1 scans will use a ${Number(saved.toFixed(2))}% odds floor.`,
      );
    } catch {
      setFloorMessage("The odds floor could not be saved. Please try again.");
    } finally {
      setIsFloorSaving(false);
    }
  }

  async function saveCustomExcludePhrases(phrases: string[]) {
    setFloorMessage(null);
    try {
      const settings = await apiService.updateBullpenAutoLiveSettings({
        console_custom_exclude_phrases: phrases,
      });
      setCustomExcludePhrases(settings.console_custom_exclude_phrases ?? []);
      setFloorMessage("Saved. Future Stage 1 scans will filter out these words and phrases.");
    } catch {
      setFloorMessage("The custom exclusions could not be saved. Please try again.");
    }
  }

  if (!isOpen) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/55 p-4"
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) setIsOpen(false);
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="bullpen-stage-one-scan-filters-title"
          className="flex max-h-[86vh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.55)] dark:border-slate-700 dark:bg-slate-950"
        >
          <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5 dark:border-slate-700">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-300">
                Stage 1 · Bullpen Scan
              </p>
              <h2
                id="bullpen-stage-one-scan-filters-title"
                className="mt-1 text-xl font-semibold text-slate-950 dark:text-slate-50"
              >
                Scan Filters
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
                These are the filters used by Stage 1 before events are passed to the LLM stage. Select any filter to see its exact matching logic.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-900 dark:hover:text-white"
              aria-label="Close scan filters"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-5">
            <div className="space-y-3">
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-4 dark:border-emerald-500/40 dark:bg-emerald-950/30">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                  <div className="max-w-xl">
                    <p className="font-semibold text-slate-950 dark:text-slate-50">
                      Yes/No odds floor
                    </p>
                    <p className="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">
                      Exclude a market when either its Yes or No odds are below this percentage. The saved value is used by every future Stage 1 scan.
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <label className="relative">
                      <span className="sr-only">Yes/No odds floor percentage</span>
                      <input
                        type="number"
                        min={0}
                        max={49.9}
                        step={0.1}
                        value={oddsFloor}
                        disabled={isFloorLoading || isFloorSaving}
                        onChange={(event) => setOddsFloor(Number(event.target.value))}
                        className="h-10 w-28 rounded-xl border border-slate-300 bg-white px-3 pr-8 text-sm font-semibold text-slate-950 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-50"
                      />
                      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">%</span>
                    </label>
                    <button
                      type="button"
                      onClick={() => void saveOddsFloor()}
                      disabled={isFloorLoading || isFloorSaving || oddsFloor === savedOddsFloor}
                      className="inline-flex h-10 items-center gap-2 rounded-xl bg-emerald-700 px-4 text-sm font-semibold text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isFloorSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                      Save floor
                    </button>
                  </div>
                </div>
                {floorMessage ? (
                  <p className="mt-3 text-xs font-medium text-slate-700 dark:text-slate-200" role="status">
                    {floorMessage}
                  </p>
                ) : null}
              </div>
              {FILTER_ORDER.map((id) => {
                const detail = BULLPEN_SCAN_FILTER_DETAILS[id];
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setDetailId(id)}
                    className="flex w-full items-start justify-between gap-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-left transition hover:border-emerald-300 hover:bg-emerald-50 focus:outline-none focus:ring-2 focus:ring-emerald-300 dark:border-slate-700 dark:bg-slate-900/70 dark:hover:border-emerald-500/60 dark:hover:bg-emerald-950/30"
                  >
                    <div>
                      <p className="font-semibold text-slate-950 dark:text-slate-50">
                        {detail.label}
                      </p>
                      <p className="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">
                        {detail.description}
                      </p>
                    </div>
                    <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300">
                      <Info className="h-4 w-4" />
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {detailId ? (
        <BullpenScanFilterDetailsDialog
          detailId={detailId}
          customKeywords={detailId === "excludeOthers" ? customExcludePhrases : []}
          onSaveCustomKeywords={(keywords) => {
            if (detailId === "excludeOthers") void saveCustomExcludePhrases(keywords);
          }}
          onClose={() => setDetailId(null)}
        />
      ) : null}
    </>
  );
}
