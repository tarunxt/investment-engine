"use client";

import { useEffect, useState } from "react";
import { Check, Info, Loader2, X } from "lucide-react";

import {
  BULLPEN_SCAN_FILTER_DETAILS,
  type BullpenScanFilterDetailId,
} from "@/lib/bullpenScanExclusions";
import {
  BULLPEN_SCAN_FILTER_SETTING_KEYS,
  BULLPEN_STAGE_ONE_REAPPLY_FILTERS_EVENT,
  BULLPEN_STAGE_ONE_REAPPLY_FINISHED_EVENT,
  BULLPEN_STAGE_ONE_SETTINGS_UPDATED_EVENT,
  getBullpenScanFilterToggles,
  type BullpenScanFilterToggleState,
} from "@/lib/bullpenStageOneSettings";
import { BullpenScanFilterDetailsDialog } from "./BullpenScanFilterDetailsDialog";
import { apiService } from "@/services/api";
import type {
  BullpenAutoLiveSettings,
  BullpenAutoLiveSettingsUpdate,
} from "@/types/api";

const FILTER_ORDER = Object.keys(
  BULLPEN_SCAN_FILTER_DETAILS,
) as BullpenScanFilterDetailId[];

const DEFAULT_FILTER_TOGGLES: BullpenScanFilterToggleState = {
  excludeSports: true,
  excludeWeather: true,
  excludeMarketPredictions: true,
  excludeTweetCountQuestions: true,
  excludeReleasedByEvents: true,
  onlyBinaryYesNo: true,
  excludeOthers: true,
};

function publishStageOneSettings(settings: BullpenAutoLiveSettings) {
  window.dispatchEvent(
    new CustomEvent(BULLPEN_STAGE_ONE_SETTINGS_UPDATED_EVENT, {
      detail: settings,
    }),
  );
}

export function BullpenScanFiltersPopupBridge() {
  const [isOpen, setIsOpen] = useState(false);
  const [detailId, setDetailId] = useState<BullpenScanFilterDetailId | null>(null);
  const [oddsFloor, setOddsFloor] = useState(1);
  const [savedOddsFloor, setSavedOddsFloor] = useState(1);
  const [highestOddsFloor, setHighestOddsFloor] = useState(90);
  const [savedHighestOddsFloor, setSavedHighestOddsFloor] = useState(90);
  const [maxClosingDays, setMaxClosingDays] = useState(30);
  const [savedMaxClosingDays, setSavedMaxClosingDays] = useState(30);
  const [minVolumeUsd, setMinVolumeUsd] = useState(100);
  const [savedMinVolumeUsd, setSavedMinVolumeUsd] = useState(100);
  const [minLiquidityUsd, setMinLiquidityUsd] = useState(100);
  const [savedMinLiquidityUsd, setSavedMinLiquidityUsd] = useState(100);
  const [rejectedThemePattern, setRejectedThemePattern] = useState("crypto prices|twitter|Mentions");
  const [savedRejectedThemePattern, setSavedRejectedThemePattern] = useState("crypto prices|twitter|Mentions");
  const [isFloorLoading, setIsFloorLoading] = useState(false);
  const [isFloorSaving, setIsFloorSaving] = useState(false);
  const [isClosingDaysSaving, setIsClosingDaysSaving] = useState(false);
  const [floorMessage, setFloorMessage] = useState<string | null>(null);
  const [closingDaysMessage, setClosingDaysMessage] = useState<string | null>(null);
  const [additionalFiltersMessage, setAdditionalFiltersMessage] = useState<string | null>(null);
  const [isAdditionalFiltersSaving, setIsAdditionalFiltersSaving] = useState(false);
  const [customExcludePhrases, setCustomExcludePhrases] = useState<string[]>([]);
  const [filterToggles, setFilterToggles] = useState(DEFAULT_FILTER_TOGGLES);
  const [savingFilterId, setSavingFilterId] =
    useState<BullpenScanFilterDetailId | null>(null);
  const [filterMessage, setFilterMessage] = useState<string | null>(null);
  const [reapplyDirty, setReapplyDirty] = useState(false);
  const [isReapplying, setIsReapplying] = useState(false);
  const [reapplyMessage, setReapplyMessage] = useState<string | null>(null);

  useEffect(() => {
    async function loadOddsFloor() {
      setIsFloorLoading(true);
      setFloorMessage(null);
      setClosingDaysMessage(null);
      setFilterMessage(null);
      try {
        const settings = await apiService.getBullpenAutoLiveSettings();
        const saved = settings.console_min_market_odds ?? 1;
        const savedHighest = settings.console_min_highest_market_odds ?? 90;
        const savedClosingDays = settings.console_max_closing_days ?? 30;
        setOddsFloor(saved);
        setSavedOddsFloor(saved);
        setHighestOddsFloor(savedHighest);
        setSavedHighestOddsFloor(savedHighest);
        setMaxClosingDays(savedClosingDays);
        setSavedMaxClosingDays(savedClosingDays);
        const savedVolume = settings.console_min_volume_usd ?? 100;
        const savedLiquidity = settings.console_min_liquidity_usd ?? 100;
        const savedThemePattern = settings.console_rejected_theme_pattern ?? "crypto prices|twitter|Mentions";
        setMinVolumeUsd(savedVolume);
        setSavedMinVolumeUsd(savedVolume);
        setMinLiquidityUsd(savedLiquidity);
        setSavedMinLiquidityUsd(savedLiquidity);
        setRejectedThemePattern(savedThemePattern);
        setSavedRejectedThemePattern(savedThemePattern);
        setCustomExcludePhrases(settings.console_custom_exclude_phrases ?? []);
        setFilterToggles(getBullpenScanFilterToggles(settings));
        publishStageOneSettings(settings);
        setReapplyDirty(false);
      } catch {
        setFloorMessage("Could not load the saved odds thresholds. Defaults 1% and 90% are shown.");
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
    const handleReapplyFinished = (event: Event) => {
      const detail = (event as CustomEvent<{ success: boolean; message?: string }>).detail;
      setIsReapplying(false);
      setReapplyDirty(!detail.success);
      setReapplyMessage(
        detail.message ??
          (detail.success
            ? "Filters reapplied to the saved Full Universe scan."
            : "Filters could not be reapplied."),
      );
    };
    window.addEventListener(
      BULLPEN_STAGE_ONE_REAPPLY_FINISHED_EVENT,
      handleReapplyFinished,
    );
    return () => {
      document.removeEventListener("click", handleClick, true);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener(
        BULLPEN_STAGE_ONE_REAPPLY_FINISHED_EVENT,
        handleReapplyFinished,
      );
    };
  }, [detailId]);

  async function reapplyFilters() {
    if (!reapplyDirty || isReapplying) return;
    if (!Number.isInteger(maxClosingDays) || maxClosingDays < 1) {
      setReapplyMessage("Enter a valid whole-number expiry window first.");
      return;
    }
    if (!Number.isFinite(oddsFloor) || oddsFloor < 0 || oddsFloor >= 50) {
      setReapplyMessage("Enter a valid minimum lower-side odds value from 0 up to 49.9% first.");
      return;
    }
    if (!Number.isFinite(highestOddsFloor) || highestOddsFloor < 50 || highestOddsFloor >= 100) {
      setReapplyMessage("Enter a valid minimum higher-side odds value from 50 up to 99.9% first.");
      return;
    }
    if (!Number.isFinite(minVolumeUsd) || minVolumeUsd < 0 || !Number.isFinite(minLiquidityUsd) || minLiquidityUsd < 0) {
      setReapplyMessage("Volume and liquidity must be numbers of at least 0.");
      return;
    }
    setIsReapplying(true);
    setReapplyMessage("Saving and reapplying filters to the existing Full Universe data…");
    try {
      const settings = await apiService.updateBullpenAutoLiveSettings({
        console_max_closing_days: maxClosingDays,
        console_min_market_odds: oddsFloor,
        console_min_highest_market_odds: highestOddsFloor,
        console_min_volume_usd: minVolumeUsd,
        console_min_liquidity_usd: minLiquidityUsd,
        console_rejected_theme_pattern: rejectedThemePattern,
        console_custom_exclude_phrases: customExcludePhrases,
        ...Object.fromEntries(
          Object.entries(BULLPEN_SCAN_FILTER_SETTING_KEYS).map(([id, key]) => [
            key,
            filterToggles[id as BullpenScanFilterDetailId],
          ]),
        ),
      } as BullpenAutoLiveSettingsUpdate);
      publishStageOneSettings(settings);
      window.dispatchEvent(
        new CustomEvent(BULLPEN_STAGE_ONE_REAPPLY_FILTERS_EVENT, {
          detail: settings,
        }),
      );
    } catch {
      setIsReapplying(false);
      setReapplyMessage("The filters could not be saved. Check the values and try again.");
    }
  }

  async function saveOddsFloor() {
    if (!Number.isFinite(oddsFloor) || oddsFloor < 0 || oddsFloor >= 50) {
      setFloorMessage("Enter a number from 0 up to 49.9%.");
      return;
    }
    if (!Number.isFinite(highestOddsFloor) || highestOddsFloor < 50 || highestOddsFloor >= 100) {
      setFloorMessage("Enter a higher-side value from 50 up to 99.9%.");
      return;
    }
    setIsFloorSaving(true);
    setFloorMessage(null);
    try {
      const settings = await apiService.updateBullpenAutoLiveSettings({
        console_min_market_odds: oddsFloor,
        console_min_highest_market_odds: highestOddsFloor,
      });
      publishStageOneSettings(settings);
      const saved = settings.console_min_market_odds;
      const savedHighest = settings.console_min_highest_market_odds;
      setOddsFloor(saved);
      setSavedOddsFloor(saved);
      setHighestOddsFloor(savedHighest);
      setSavedHighestOddsFloor(savedHighest);
      setFloorMessage(
        `Saved. Future Stage 1 scans require min(Yes, No) > ${Number(saved.toFixed(2))}% and max(Yes, No) > ${Number(savedHighest.toFixed(2))}%.`,
      );
    } catch {
      setFloorMessage("The odds floor could not be saved. Please try again.");
    } finally {
      setIsFloorSaving(false);
    }
  }

  async function saveMaxClosingDays() {
    if (!Number.isInteger(maxClosingDays) || maxClosingDays < 1) {
      setClosingDaysMessage("Enter a whole number of at least 1 day.");
      return;
    }
    setIsClosingDaysSaving(true);
    setClosingDaysMessage(null);
    try {
      const settings = await apiService.updateBullpenAutoLiveSettings({
        console_max_closing_days: maxClosingDays,
      });
      publishStageOneSettings(settings);
      const saved = settings.console_max_closing_days;
      setMaxClosingDays(saved);
      setSavedMaxClosingDays(saved);
      setClosingDaysMessage(
        `Saved. Future Stage 1 scans will include events expiring within ${saved} day${saved === 1 ? "" : "s"}.`,
      );
    } catch {
      setClosingDaysMessage("The expiry window could not be saved. Please try again.");
    } finally {
      setIsClosingDaysSaving(false);
    }
  }

  async function saveAdditionalFilters() {
    if (!Number.isFinite(minVolumeUsd) || minVolumeUsd < 0 || !Number.isFinite(minLiquidityUsd) || minLiquidityUsd < 0) {
      setAdditionalFiltersMessage("Volume and liquidity must be numbers of at least 0.");
      return;
    }
    setIsAdditionalFiltersSaving(true);
    setAdditionalFiltersMessage(null);
    try {
      const settings = await apiService.updateBullpenAutoLiveSettings({
        console_min_volume_usd: minVolumeUsd,
        console_min_liquidity_usd: minLiquidityUsd,
        console_rejected_theme_pattern: rejectedThemePattern,
      });
      publishStageOneSettings(settings);
      setMinVolumeUsd(settings.console_min_volume_usd);
      setSavedMinVolumeUsd(settings.console_min_volume_usd);
      setMinLiquidityUsd(settings.console_min_liquidity_usd);
      setSavedMinLiquidityUsd(settings.console_min_liquidity_usd);
      setRejectedThemePattern(settings.console_rejected_theme_pattern);
      setSavedRejectedThemePattern(settings.console_rejected_theme_pattern);
      setAdditionalFiltersMessage("Saved. Every future Trending and Full Universe scan will use these filters.");
    } catch {
      setAdditionalFiltersMessage("The additional filters could not be saved. Check the theme pattern and try again.");
    } finally {
      setIsAdditionalFiltersSaving(false);
    }
  }

  async function saveCustomExcludePhrases(phrases: string[]) {
    setFloorMessage(null);
    try {
      const settings = await apiService.updateBullpenAutoLiveSettings({
        console_custom_exclude_phrases: phrases,
      });
      setCustomExcludePhrases(settings.console_custom_exclude_phrases ?? []);
      publishStageOneSettings(settings);
      setFloorMessage("Saved. Future Stage 1 scans will filter out these words and phrases.");
    } catch {
      setFloorMessage("The custom exclusions could not be saved. Please try again.");
    }
  }

  async function saveFilterToggle(
    id: BullpenScanFilterDetailId,
    enabled: boolean,
  ) {
    if (savingFilterId) return;
    const previous = filterToggles[id];
    const settingKey = BULLPEN_SCAN_FILTER_SETTING_KEYS[id];
    setSavingFilterId(id);
    setFilterMessage(null);
    setFilterToggles((current) => ({ ...current, [id]: enabled }));
    try {
      const settings = await apiService.updateBullpenAutoLiveSettings({
        [settingKey]: enabled,
      } as BullpenAutoLiveSettingsUpdate);
      const savedToggles = getBullpenScanFilterToggles(settings);
      setFilterToggles(savedToggles);
      publishStageOneSettings(settings);
      setFilterMessage(
        `${BULLPEN_SCAN_FILTER_DETAILS[id].label} is now ${savedToggles[id] ? "applied" : "not applied"} to every future Trending and Full Universe scan.`,
      );
    } catch {
      setFilterToggles((current) => ({ ...current, [id]: previous }));
      setFilterMessage("The filter choice could not be saved. Please try again.");
    } finally {
      setSavingFilterId(null);
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
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => void reapplyFilters()}
                disabled={!reapplyDirty || isReapplying || isFloorLoading}
                className={`inline-flex h-10 items-center gap-2 rounded-xl px-4 text-sm font-semibold text-white transition ${
                  reapplyDirty
                    ? "bg-blue-600 hover:bg-blue-700"
                    : "bg-slate-400"
                } disabled:cursor-not-allowed disabled:opacity-70`}
              >
                {isReapplying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                {isReapplying ? "Reapplying…" : "Reapply Filters"}
              </button>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-900 dark:hover:text-white"
                aria-label="Close scan filters"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {reapplyMessage ? (
            <p className="border-b border-slate-200 px-6 py-2 text-xs font-medium text-slate-700 dark:border-slate-700 dark:text-slate-200" role="status">
              {reapplyMessage}
            </p>
          ) : null}

          <div className="flex-1 overflow-y-auto px-6 py-5">
            <div className="space-y-3">
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-4 dark:border-emerald-500/40 dark:bg-emerald-950/30">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                  <div className="max-w-xl">
                    <p className="font-semibold text-slate-950 dark:text-slate-50">
                      Maximum days until expiry
                    </p>
                    <p className="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">
                      Include only events expiring within this many days. The saved value is used by every future Stage 1 scan until you change it.
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                      <span className="relative mt-1 block">
                      <span className="sr-only">Maximum days until event expiry</span>
                      <input
                        type="number"
                        min={1}
                        step={1}
                        value={maxClosingDays}
                        disabled={isFloorLoading || isClosingDaysSaving}
                        onChange={(event) => {
                          setMaxClosingDays(Number(event.target.value));
                          setReapplyDirty(true);
                        }}
                        className="h-10 w-28 rounded-xl border border-slate-300 bg-white px-3 pr-12 text-sm font-semibold text-slate-950 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-50"
                      />
                      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">days</span>
                    </label>
                    <button
                      type="button"
                      onClick={() => void saveMaxClosingDays()}
                      disabled={isFloorLoading || isClosingDaysSaving || maxClosingDays === savedMaxClosingDays}
                      className="inline-flex h-10 items-center gap-2 rounded-xl bg-emerald-700 px-4 text-sm font-semibold text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isClosingDaysSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                      Save window
                    </button>
                  </div>
                </div>
                {closingDaysMessage ? (
                  <p className="mt-3 text-xs font-medium text-slate-700 dark:text-slate-200" role="status">
                    {closingDaysMessage}
                  </p>
                ) : null}
              </div>
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-4 dark:border-emerald-500/40 dark:bg-emerald-950/30">
                <div>
                  <p className="font-semibold text-slate-950 dark:text-slate-50">Volume, liquidity and theme names</p>
                  <p className="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">
                    Keep only markets strictly above the USD floors, and reject themes matching the case-insensitive regular expression.
                  </p>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <label className="text-sm font-medium text-slate-700 dark:text-slate-200">
                    Volume (USD) &gt;
                    <input aria-label="Minimum Volume USD" type="number" min={0} step={1} value={minVolumeUsd} disabled={isFloorLoading || isAdditionalFiltersSaving} onChange={(event) => { setMinVolumeUsd(Number(event.target.value)); setReapplyDirty(true); }} className="mt-1 h-10 w-full rounded-xl border border-slate-300 bg-white px-3 font-semibold text-slate-950 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-50" />
                  </label>
                  <label className="text-sm font-medium text-slate-700 dark:text-slate-200">
                    Liquidity (USD) &gt;
                    <input aria-label="Minimum Liquidity USD" type="number" min={0} step={1} value={minLiquidityUsd} disabled={isFloorLoading || isAdditionalFiltersSaving} onChange={(event) => { setMinLiquidityUsd(Number(event.target.value)); setReapplyDirty(true); }} className="mt-1 h-10 w-full rounded-xl border border-slate-300 bg-white px-3 font-semibold text-slate-950 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-50" />
                  </label>
                  <label className="text-sm font-medium text-slate-700 dark:text-slate-200 sm:col-span-2">
                    Theme Names to reject (regular expression)
                    <input aria-label="Rejected Theme Names pattern" type="text" value={rejectedThemePattern} disabled={isFloorLoading || isAdditionalFiltersSaving} onChange={(event) => { setRejectedThemePattern(event.target.value); setReapplyDirty(true); }} placeholder="crypto prices|twitter|Mentions" className="mt-1 h-10 w-full rounded-xl border border-slate-300 bg-white px-3 font-mono text-sm text-slate-950 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-50" />
                  </label>
                </div>
                <div className="mt-3 flex items-center justify-end gap-3">
                  <button type="button" onClick={() => void saveAdditionalFilters()} disabled={isFloorLoading || isAdditionalFiltersSaving || (minVolumeUsd === savedMinVolumeUsd && minLiquidityUsd === savedMinLiquidityUsd && rejectedThemePattern === savedRejectedThemePattern)} className="inline-flex h-10 items-center gap-2 rounded-xl bg-emerald-700 px-4 text-sm font-semibold text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50">
                    {isAdditionalFiltersSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    Save filters
                  </button>
                </div>
                {additionalFiltersMessage ? <p className="mt-3 text-xs font-medium text-slate-700 dark:text-slate-200" role="status">{additionalFiltersMessage}</p> : null}
              </div>
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-4 dark:border-emerald-500/40 dark:bg-emerald-950/30">
                <div className="space-y-4">
                  <div>
                    <p className="font-semibold text-slate-950 dark:text-slate-50">
                      Yes/No odds thresholds
                    </p>
                    <p className="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">
                      Both conditions must pass. Values are saved for every future Stage 1 scan.
                    </p>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="text-sm font-medium text-slate-700 dark:text-slate-200">
                      i) Minimum value of min(Yes, No Odds) &gt;
                      <span className="relative mt-1 block">
                        <input
                          aria-label="Minimum value of min Yes No Odds"
                          type="number"
                          min={0}
                          max={49.9}
                          step={0.1}
                          value={oddsFloor}
                          disabled={isFloorLoading || isFloorSaving}
                          onChange={(event) => {
                            setOddsFloor(Number(event.target.value));
                            setReapplyDirty(true);
                          }}
                          className="h-10 w-full rounded-xl border border-slate-300 bg-white px-3 pr-8 text-sm font-semibold text-slate-950 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-50"
                        />
                        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">%</span>
                      </span>
                      <span className="mt-1 block text-xs font-normal text-slate-500">Default: above 1%</span>
                    </label>
                    <label className="text-sm font-medium text-slate-700 dark:text-slate-200">
                      ii) Minimum value of max(Yes, No Odds) &gt;
                    <label className="relative">
                      <input
                        aria-label="Minimum value of max Yes No Odds"
                        type="number"
                        min={50}
                        max={99.9}
                        step={0.1}
                        value={highestOddsFloor}
                        disabled={isFloorLoading || isFloorSaving}
                        onChange={(event) => {
                          setHighestOddsFloor(Number(event.target.value));
                          setReapplyDirty(true);
                        }}
                        className="h-10 w-full rounded-xl border border-slate-300 bg-white px-3 pr-8 text-sm font-semibold text-slate-950 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-50"
                      />
                      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">%</span>
                      </span>
                      <span className="mt-1 block text-xs font-normal text-slate-500">Default: above 90%</span>
                    </label>
                  </div>
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => void saveOddsFloor()}
                      disabled={isFloorLoading || isFloorSaving || (oddsFloor === savedOddsFloor && highestOddsFloor === savedHighestOddsFloor)}
                      className="inline-flex h-10 items-center gap-2 rounded-xl bg-emerald-700 px-4 text-sm font-semibold text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isFloorSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                      Save thresholds
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
                const enabled = filterToggles[id];
                return (
                  <div
                    key={id}
                    className={`flex w-full items-start gap-4 rounded-2xl border px-4 py-4 text-left transition ${
                      enabled
                        ? "border-emerald-200 bg-emerald-50 dark:border-emerald-500/40 dark:bg-emerald-950/30"
                        : "border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900/70"
                    }`}
                  >
                    <label className="mt-0.5 inline-flex shrink-0 cursor-pointer items-center">
                      <input
                        type="checkbox"
                        checked={enabled}
                        disabled={isFloorLoading || savingFilterId !== null}
                        onChange={(event) => {
                          setReapplyDirty(true);
                          void saveFilterToggle(id, event.target.checked);
                        }}
                        aria-label={`Apply ${detail.label} filter`}
                        className="h-5 w-5 cursor-pointer rounded border-slate-300 text-emerald-700 focus:ring-2 focus:ring-emerald-300 disabled:cursor-wait"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => setDetailId(id)}
                      className="min-w-0 flex-1 text-left focus:outline-none focus-visible:rounded-lg focus-visible:ring-2 focus-visible:ring-emerald-300"
                    >
                      <p className="font-semibold text-slate-950 dark:text-slate-50">
                        {detail.label}
                      </p>
                      <p className="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">
                        {detail.description}
                      </p>
                    </button>
                    <button
                      type="button"
                      onClick={() => setDetailId(id)}
                      aria-label={`View ${detail.label} filter details`}
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 transition hover:border-emerald-300 hover:text-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-300 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300"
                    >
                      <Info className="h-4 w-4" />
                    </button>
                  </div>
                );
              })}
              {filterMessage ? (
                <p className="px-1 text-xs font-medium text-slate-700 dark:text-slate-200" role="status">
                  {filterMessage}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {detailId ? (
        <BullpenScanFilterDetailsDialog
          detailId={detailId}
          customKeywords={detailId === "excludeOthers" ? customExcludePhrases : []}
          onSaveCustomKeywords={(keywords) => {
            if (detailId === "excludeOthers") {
              setReapplyDirty(true);
              void saveCustomExcludePhrases(keywords);
            }
          }}
          onClose={() => setDetailId(null)}
        />
      ) : null}
    </>
  );
}
