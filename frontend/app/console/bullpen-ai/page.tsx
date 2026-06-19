"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, ExternalLink, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  BULLPEN_SOURCE_URLS,
  buildBullpenScanQueryParams,
  createBullpenScanFilters,
  normalizeBullpenScanFilters,
  type BullpenQuestion,
  type BullpenScanFilters,
  type ScanMode,
  type ScanResult,
} from "@/lib/bullpen-ai";
import { URLs } from "@/lib/urls";

const TABS: {
  mode: ScanMode;
  label: string;
  href: string;
}[] = [
  {
    mode: "30-days",
    label: "30 days",
    href: URLs.routes.console.bullpenAi30Days(),
  },
  {
    mode: "end-of-month",
    label: "End of Month",
    href: URLs.routes.console.bullpenAiEndOfMonth(),
  },
];

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatDateOnly(value: string) {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-IN", { dateStyle: "long" });
}

function formatOdds(value: number | null) {
  if (value === null) return "—";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}x`;
}

function formatDays(value: number | null) {
  if (value === null) return "—";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}d`;
}

function formatOutcomeSummary(question: BullpenQuestion) {
  if (question.outcomeLabels.length > 0) return question.outcomeLabels.join(" / ");
  if (question.isBinaryYesNo) return "Yes / No";
  if (question.outcomeCount !== null) return `${question.outcomeCount} outcomes`;
  return "—";
}

function getModeDescription(mode: ScanMode, filters: BullpenScanFilters) {
  if (mode === "end-of-month") {
    return `Bullpen questions ending exactly on ${formatDateOnly(filters.targetDate)}.`;
  }

  return `Bullpen questions closing within ${filters.maxClosingDays} days.`;
}

function filtersEqual(left: BullpenScanFilters, right: BullpenScanFilters) {
  return (
    left.maxClosingDays === right.maxClosingDays &&
    left.targetDate === right.targetDate &&
    left.excludeSports === right.excludeSports &&
    left.excludeWeather === right.excludeWeather &&
    left.excludeMarketPredictions === right.excludeMarketPredictions &&
    left.onlyBinaryYesNo === right.onlyBinaryYesNo &&
    left.minYesOdds === right.minYesOdds &&
    left.minNoOdds === right.minNoOdds
  );
}

function FilterToggle({
  checked,
  label,
  description,
  onChange,
}: {
  checked: boolean;
  label: string;
  description: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 h-4 w-4 rounded border-slate-300 text-slate-950 focus:ring-slate-400"
      />
      <span className="space-y-1">
        <span className="block text-sm font-semibold text-slate-900">
          {label}
        </span>
        <span className="block text-xs leading-5 text-slate-600">
          {description}
        </span>
      </span>
    </label>
  );
}

export default function BullpenAiPage() {
  const searchParams = useSearchParams();
  const activeMode: ScanMode =
    searchParams.get("tab") === "end-of-month" ? "end-of-month" : "30-days";
  const activeTab = TABS.find((tab) => tab.mode === activeMode) || TABS[0];
  const [filtersByMode, setFiltersByMode] = useState<Record<ScanMode, BullpenScanFilters>>(() => ({
    "30-days": normalizeBullpenScanFilters("30-days", searchParams),
    "end-of-month": normalizeBullpenScanFilters("end-of-month", searchParams),
  }));
  const [resultsByMode, setResultsByMode] = useState<Record<ScanMode, ScanResult | null>>({
    "30-days": null,
    "end-of-month": null,
  });
  const [messagesByMode, setMessagesByMode] = useState<Record<ScanMode, string | null>>({
    "30-days": null,
    "end-of-month": null,
  });
  const [scanningMode, setScanningMode] = useState<ScanMode | null>(null);

  const activeFilters = filtersByMode[activeMode];
  const activeResult = resultsByMode[activeMode];
  const hasFreshResult =
    activeResult !== null && filtersEqual(activeResult.filters, activeFilters);
  const visibleResult = hasFreshResult ? activeResult : null;
  const hasStaleResult = activeResult !== null && !hasFreshResult;
  const notice = messagesByMode[activeMode];
  const isScanning = scanningMode === activeMode;

  function updateActiveFilters(patch: Partial<BullpenScanFilters>) {
    setFiltersByMode((current) => ({
      ...current,
      [activeMode]: {
        ...current[activeMode],
        ...patch,
      },
    }));
  }

  function resetActiveFilters() {
    setFiltersByMode((current) => ({
      ...current,
      [activeMode]: createBullpenScanFilters(activeMode),
    }));
  }

  async function runScan() {
    const params = buildBullpenScanQueryParams(activeMode, activeFilters);
    setScanningMode(activeMode);
    setMessagesByMode((current) => ({ ...current, [activeMode]: null }));

    try {
      const response = await fetch(`/api/bullpen-ai?${params.toString()}`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as ScanResult;

      setResultsByMode((current) => ({ ...current, [activeMode]: payload }));
      setMessagesByMode((current) => ({
        ...current,
        [activeMode]:
          !response.ok || payload.error
            ? payload.error || "Bullpen scan failed."
            : payload.warning
              ? payload.warning
              : payload.questions.length === 0
                ? "No Bullpen questions matched the current scan filters. Adjust the filters or rerun later."
                : null,
      }));
    } catch (scanError) {
      setMessagesByMode((current) => ({
        ...current,
        [activeMode]:
          scanError instanceof Error
            ? scanError.message
            : "Bullpen scan failed.",
      }));
    } finally {
      setScanningMode(null);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6">
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.22em] text-purple-600">
          Copy Trading Bots
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">
          Bullpen x AI
        </h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-600">
          Run Bullpen scans for non-sports, non-weather, non-market binary
          Yes/No questions inside the selected time window, then inspect the
          matching markets in a single table.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
        {TABS.map((tab) => (
          <Link
            key={tab.mode}
            href={tab.href}
            className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${activeMode === tab.mode ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-slate-100 hover:text-slate-950"}`}
          >
            {tab.label}
          </Link>
        ))}
      </div>

      <Card className="border-slate-200 shadow-sm">
        <CardHeader className="gap-2">
          <CardTitle>{activeTab.label} Bullpen Scan</CardTitle>
          <CardDescription>
            {getModeDescription(activeMode, activeFilters)}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 rounded-2xl border border-slate-200 bg-white p-4 lg:grid-cols-2 2xl:grid-cols-4">
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                {activeMode === "30-days" ? "Closing Window" : "Target Date"}
              </p>
              {activeMode === "30-days" ? (
                <>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={activeFilters.maxClosingDays}
                    onChange={(event) => {
                      const parsed = Number(event.target.value);
                      if (!Number.isFinite(parsed)) return;
                      updateActiveFilters({
                        maxClosingDays: Math.max(1, parsed),
                      });
                    }}
                    className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm text-slate-900 outline-none transition focus:border-slate-400"
                  />
                  <p className="text-xs leading-5 text-slate-600">
                    Include only questions closing within this many days.
                  </p>
                </>
              ) : (
                <>
                  <input
                    type="date"
                    value={activeFilters.targetDate}
                    onChange={(event) =>
                      updateActiveFilters({ targetDate: event.target.value })
                    }
                    className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm text-slate-900 outline-none transition focus:border-slate-400"
                  />
                  <p className="text-xs leading-5 text-slate-600">
                    Only questions whose closing date matches this calendar day.
                  </p>
                </>
              )}
            </div>

            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                Min Yes Odds
              </p>
              <input
                type="number"
                min={0}
                step={0.1}
                value={activeFilters.minYesOdds}
                onChange={(event) => {
                  const parsed = Number(event.target.value);
                  if (!Number.isFinite(parsed)) return;
                  updateActiveFilters({ minYesOdds: Math.max(0, parsed) });
                }}
                className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm text-slate-900 outline-none transition focus:border-slate-400"
              />
              <p className="text-xs leading-5 text-slate-600">
                Require the Yes side to meet or exceed this decimal odds floor.
              </p>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                Min No Odds
              </p>
              <input
                type="number"
                min={0}
                step={0.1}
                value={activeFilters.minNoOdds}
                onChange={(event) => {
                  const parsed = Number(event.target.value);
                  if (!Number.isFinite(parsed)) return;
                  updateActiveFilters({ minNoOdds: Math.max(0, parsed) });
                }}
                className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm text-slate-900 outline-none transition focus:border-slate-400"
              />
              <p className="text-xs leading-5 text-slate-600">
                Require the No side to meet or exceed this decimal odds floor.
              </p>
            </div>

            <div className="flex flex-col justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Source
                </p>
                <p className="mt-2 text-sm text-slate-700">
                  Scan Bullpen’s trending source for this tab, then fall back to
                  alternate market feeds only if Bullpen access fails.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => runScan()}
                  disabled={isScanning}
                  className="gap-2 whitespace-nowrap"
                >
                  {isScanning ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  Run Bullpen Scan
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => resetActiveFilters()}
                >
                  Reset Filters
                </Button>
                <a
                  href={BULLPEN_SOURCE_URLS[activeMode]}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 self-center whitespace-nowrap text-sm font-medium text-purple-700 hover:text-purple-900"
                >
                  Open source <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <FilterToggle
              checked={activeFilters.excludeSports}
              onChange={(checked) => updateActiveFilters({ excludeSports: checked })}
              label="Exclude sports"
              description="Remove sports leagues, teams, games, tournaments, and match-result markets."
            />
            <FilterToggle
              checked={activeFilters.excludeWeather}
              onChange={(checked) =>
                updateActiveFilters({ excludeWeather: checked })
              }
              label="Exclude weather"
              description="Remove temperature, storm, rainfall, hurricane, and climate-style markets."
            />
            <FilterToggle
              checked={activeFilters.excludeMarketPredictions}
              onChange={(checked) =>
                updateActiveFilters({ excludeMarketPredictions: checked })
              }
              label="Exclude market predictions"
              description="Remove finance, macro, stocks, commodities, and crypto-price style questions."
            />
            <FilterToggle
              checked={activeFilters.onlyBinaryYesNo}
              onChange={(checked) =>
                updateActiveFilters({ onlyBinaryYesNo: checked })
              }
              label="Only Yes / No"
              description="Keep only binary markets that resolve between a Yes and No outcome."
            />
          </div>

          {notice ? (
            <div className="flex gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="space-y-1">
                <p>{notice}</p>
                <p className="text-xs text-amber-800">
                  If Bullpen blocks server-side access, rerun after network
                  access or session availability is restored.
                </p>
              </div>
            </div>
          ) : null}

          {hasStaleResult ? (
            <div className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
              Filters changed for this tab after the last scan. Run Bullpen Scan
              again to refresh the table with the current settings.
            </div>
          ) : null}

          {visibleResult ? (
            <div className="flex flex-wrap gap-x-6 gap-y-2 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
              <span>{visibleResult.questions.length} matches</span>
              <span>{visibleResult.totalCandidates} markets scanned</span>
              <span>Source used: {visibleResult.sourceLabel}</span>
              <span>Scanned at: {formatDate(visibleResult.scannedAt)}</span>
            </div>
          ) : null}

          <div className="overflow-hidden rounded-2xl border border-slate-200">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Question</th>
                    <th className="px-4 py-3">Closing time</th>
                    <th className="px-4 py-3">Days left</th>
                    <th className="px-4 py-3">Category</th>
                    <th className="px-4 py-3">Outcomes</th>
                    <th className="px-4 py-3">Yes odds</th>
                    <th className="px-4 py-3">No odds</th>
                    <th className="px-4 py-3">Volume</th>
                    <th className="px-4 py-3">Liquidity</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {visibleResult?.questions.length ? (
                    visibleResult.questions.map((question) => (
                      <tr key={question.id} className="align-top hover:bg-slate-50">
                        <td className="max-w-xl px-4 py-3 font-medium text-slate-900">
                          <div>{question.question}</div>
                          {question.marketUrl || question.slug ? (
                            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs font-normal text-slate-500">
                              {question.marketUrl ? (
                                <a
                                  href={question.marketUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 text-purple-700 hover:text-purple-900"
                                >
                                  Open market
                                  <ExternalLink className="h-3.5 w-3.5" />
                                </a>
                              ) : null}
                              {question.slug ? <span>{question.slug}</span> : null}
                            </div>
                          ) : null}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                          {formatDate(question.closeTime)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                          {formatDays(question.daysUntilClose)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                          {question.category}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                          {formatOutcomeSummary(question)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 font-semibold text-emerald-700">
                          {formatOdds(question.yesOdds)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 font-semibold text-rose-700">
                          {formatOdds(question.noOdds)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                          {question.volume || "—"}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                          {question.liquidity || "—"}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td
                        colSpan={9}
                        className="px-4 py-12 text-center text-slate-500"
                      >
                        {isScanning
                          ? "Scanning Bullpen..."
                          : hasStaleResult
                            ? "Filters changed. Click Run Bullpen Scan to refresh the table for this tab."
                            : "No scan results yet. Click Run Bullpen Scan to load matching Bullpen questions."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
