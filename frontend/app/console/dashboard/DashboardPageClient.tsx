"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import {
  AlertCircle,
  Eye,
  EyeOff,
  Info,
  Loader2,
  RefreshCw,
  Target,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog } from "radix-ui";
import { LazyMount } from "@/components/shared/LazyMount";
import { useAuth } from "@/hooks/useAuth";
import {
  sumCurrentPositionValue,
  type BullpenPositionsResponse,
} from "@/lib/bullpenPositions";
import {
  isBullpenHistoryActivePosition,
  isBullpenHistoryClaimablePosition,
} from "@/lib/bullpenHistoryPositions";
import { validDashboardFxRate } from "@/lib/fxPresentation";
import { buildGenuineInrPortfolioTrend } from "@/lib/portfolioHistory";
import { URLs } from "@/lib/urls";
import { apiService } from "@/services/api";
import type {
  IndMoneyUsPortfolioOverviewResponse,
  DashboardSummaryResponse,
  IndMoneyUsThreatAnalysis,
  PolymarketBotState,
  ZerodhaPortfolioOverviewResponse,
  ZerodhaStatusResponse,
  ZerodhaThreatAnalysis,
} from "@/types/api";

import {
  DashboardMarketCardSkeleton,
  DashboardThreatCardSkeleton,
} from "./_components/DashboardSkeletons";
import {
  MarketPortfolioCard,
  type PortfolioCardTopHolding,
} from "./_components/MarketPortfolioCard";
import {
  INDMONEY_DASHBOARD_SYNC_NOW_EVENT,
  ZERODHA_DASHBOARD_SYNC_NOW_EVENT,
} from "./_components/dashboardEvents";
import {
  countThreatSeverities,
  extractUrgentActionRows,
  formatInr,
  formatPercent,
  formatSnapshotDate,
  formatSnapshotTime,
  formatTs,
  formatUsd,
  getThreatSummaryPoints,
  normalizeError,
  sortUrgentActionRows,
  toneClass,
} from "./_components/dashboardOverviewUtils";
import {
  buildDashboardPortfolioTrend,
  buildPersistedDashboardTrend,
  convertDashboardUsdTotalToInr,
  resolveBullpenPortfolioPlusCash,
} from "./_components/dashboardPortfolioTotals";
import {
  PortfolioCommandChart,
  type PortfolioCommandChartOption,
} from "./_components/PortfolioCommandChart";

import {
  dataAge,
  SnapshotAvailability,
  snapshotAvailability,
  type TotalDataStatusInfo,
} from "./_components/TotalDataStatus";

const ThreatMarketCard = dynamic(
  () =>
    import("./_components/ThreatMarketCard").then(
      (module) => module.ThreatMarketCard,
    ),
  { ssr: false, loading: () => <DashboardThreatCardSkeleton /> },
);

type DashboardState = {
  fx: DashboardSummaryResponse["fx"] | null;
  zerodhaStatus: ZerodhaStatusResponse | null;
  zerodhaOverview: ZerodhaPortfolioOverviewResponse | null;
  zerodhaThreat: ZerodhaThreatAnalysis | null;
  indmoneyOverview: IndMoneyUsPortfolioOverviewResponse | null;
  indmoneyThreat: IndMoneyUsThreatAnalysis | null;
  polymarketState: PolymarketBotState | null;
  bullpenPositions: BullpenPositionsResponse | null;
  portfolioHistory: DashboardSummaryResponse["portfolio_history"] | null;
};

const INITIAL_STATE: DashboardState = {
  fx: null,
  zerodhaStatus: null,
  zerodhaOverview: null,
  zerodhaThreat: null,
  indmoneyOverview: null,
  indmoneyThreat: null,
  polymarketState: null,
  bullpenPositions: null,
  portfolioHistory: null,
};

const DASHBOARD_OVERVIEW_CACHE_KEY_PREFIX =
  "investment-engine:dashboard-overview-cache:v3:user:";
const DASHBOARD_OVERVIEW_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const DASHBOARD_SECTION_KEYS = [
  "fx",
  "zerodhaStatus",
  "zerodhaOverview",
  "zerodhaThreat",
  "indmoneyOverview",
  "indmoneyThreat",
  "polymarketState",
  "bullpenPositions",
] as const;
const DASHBOARD_CRITICAL_KEYS = [
  "fx",
  "zerodhaStatus",
  "zerodhaOverview",
  "indmoneyOverview",
  "polymarketState",
  "bullpenPositions",
] as const;

type DashboardSectionKey = (typeof DASHBOARD_SECTION_KEYS)[number];
type DashboardPendingState = Record<DashboardSectionKey, boolean>;
type DashboardErrorsState = Partial<Record<DashboardSectionKey, string>>;
type DashboardCacheEntry = {
  cachedAt: number;
  value: DashboardState[DashboardSectionKey];
};
type DashboardOverviewCachePayload = {
  version: 2;
  entries: Partial<Record<DashboardSectionKey, DashboardCacheEntry>>;
};

type DashboardDataProvenance = {
  source: "server-summary" | "live-summary" | "browser-cache";
  asOf: number;
};

function createPendingSectionsState(isPending: boolean): DashboardPendingState {
  return {
    fx: isPending,
    zerodhaStatus: isPending,
    zerodhaOverview: isPending,
    zerodhaThreat: isPending,
    indmoneyOverview: isPending,
    indmoneyThreat: isPending,
    polymarketState: isPending,
    bullpenPositions: isPending,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isValidDashboardCacheValue(
  key: DashboardSectionKey,
  value: unknown,
): value is DashboardState[DashboardSectionKey] {
  if (value === null) return false;
  if (!isRecord(value)) return false;

  switch (key) {
    case "fx":
      return (
        typeof value.status === "string" &&
        typeof value.stale_after_seconds === "number"
      );
    case "zerodhaStatus":
      return typeof value.connected === "boolean";
    case "zerodhaOverview":
    case "indmoneyOverview":
      return "latest" in value && Array.isArray(value.history);
    case "zerodhaThreat":
    case "indmoneyThreat":
      return (
        typeof value.job_id === "number" &&
        typeof value.status === "string" &&
        typeof value.provider === "string" &&
        typeof value.model === "string"
      );
    case "polymarketState":
    case "bullpenPositions":
      return true;
  }
}

function sanitizeDashboardCacheValue(
  key: DashboardSectionKey,
  value: DashboardState[DashboardSectionKey],
) {
  if (
    (key === "zerodhaThreat" || key === "indmoneyThreat") &&
    value &&
    "report" in value &&
    value.report
  ) {
    // The dashboard renders structured threat fields, not the full prompt
    // markdown. Avoid duplicating a large raw model response in browser cache.
    return {
      ...value,
      report: {
        ...value.report,
        raw_markdown: "",
      },
    } as DashboardState[DashboardSectionKey];
  }
  return value;
}

function dashboardOverviewCacheKey(userId: number) {
  return `${DASHBOARD_OVERVIEW_CACHE_KEY_PREFIX}${userId}`;
}

function readDashboardOverviewCachePayload(
  userId: number | null | undefined,
): DashboardOverviewCachePayload {
  const emptyPayload: DashboardOverviewCachePayload = {
    version: 2,
    entries: {},
  };
  if (typeof window === "undefined" || !userId) return emptyPayload;

  try {
    const raw = window.localStorage.getItem(dashboardOverviewCacheKey(userId));
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DashboardOverviewCachePayload>;
      if (parsed.version === 2 && isRecord(parsed.entries)) {
        return {
          version: 2,
          entries: parsed.entries,
        };
      }
    }

    return emptyPayload;
  } catch {
    return emptyPayload;
  }
}

function readDashboardOverviewCache(
  userId: number | null | undefined,
): Partial<DashboardState> | null {
  if (typeof window === "undefined") return null;

  const payload = readDashboardOverviewCachePayload(userId);
  const result: Partial<DashboardState> = {};
  for (const key of DASHBOARD_SECTION_KEYS) {
    const entry = payload.entries[key];
    if (
      !entry ||
      !Number.isFinite(entry.cachedAt) ||
      Date.now() - entry.cachedAt > DASHBOARD_OVERVIEW_CACHE_MAX_AGE_MS ||
      !isValidDashboardCacheValue(key, entry.value)
    ) {
      continue;
    }
    Object.assign(result, { [key]: entry.value });
  }
  return Object.keys(result).length ? result : null;
}

function readDashboardOverviewCacheProvenance(
  userId: number | null | undefined,
): DashboardDataProvenance | null {
  const entries = Object.values(
    readDashboardOverviewCachePayload(userId).entries,
  ).filter(
    (entry): entry is DashboardCacheEntry =>
      Boolean(entry && Number.isFinite(entry.cachedAt)),
  );
  if (!entries.length) return null;
  return {
    source: "browser-cache",
    // Use the oldest displayed section so the label never understates age.
    asOf: Math.min(...entries.map((entry) => entry.cachedAt)),
  };
}

function formatDataAge(asOf: number | string | null | undefined) {
  const timestamp =
    typeof asOf === "number" ? asOf : asOf ? Date.parse(asOf) : Number.NaN;
  if (!Number.isFinite(timestamp)) return "age unavailable";
  const ageSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (ageSeconds < 60) return `${ageSeconds}s old`;
  if (ageSeconds < 60 * 60) return `${Math.floor(ageSeconds / 60)}m old`;
  return `${Math.floor(ageSeconds / (60 * 60))}h old`;
}

function writeDashboardOverviewCacheEntry(
  userId: number | null | undefined,
  key: DashboardSectionKey,
  value: DashboardState[DashboardSectionKey],
) {
  if (typeof window === "undefined" || !userId) return;
  if (!isValidDashboardCacheValue(key, value)) return;

  try {
    const payload = readDashboardOverviewCachePayload(userId);
    payload.entries[key] = {
      cachedAt: Date.now(),
      value: sanitizeDashboardCacheValue(key, value),
    };
    window.localStorage.setItem(
      dashboardOverviewCacheKey(userId),
      JSON.stringify(payload),
    );
  } catch {
    // Keep rendering fresh data even if local storage is unavailable.
  }
}

function logDashboardCacheFallback(key: DashboardSectionKey, reason: unknown) {
  console.warn(
    JSON.stringify({
      event: "dashboard_read_fallback_triggered",
      from_stage: "secondary",
      to_stage: "tertiary",
      to_transport: "last-known-good-cache",
      section: key,
      reason: normalizeError(reason),
    }),
  );
}

function hasCriticalDashboardContent(state: DashboardState) {
  return DASHBOARD_CRITICAL_KEYS.some((key) => state[key] !== null);
}

function buildIndiaTopHoldings(
  overview: ZerodhaPortfolioOverviewResponse | null,
): PortfolioCardTopHolding[] {
  const holdings = [...(overview?.latest?.holdings ?? [])]
    .sort((left, right) => (right.market_value ?? -Infinity) - (left.market_value ?? -Infinity))
    .slice(0, 4);

  return holdings.map((holding) => ({
    id: `${holding.exchange}-${holding.tradingsymbol}`,
    symbol: holding.tradingsymbol,
    exchange: holding.exchange,
    value: formatInr(holding.market_value),
    secondaryValue: `P&L ${formatInr(holding.pnl)}`,
    secondaryToneClass: toneClass(holding.pnl),
  }));
}

type SnapshotMarket = "india" | "us";
type SnapshotPillTone = "success" | "warning" | "danger";

const MARKET_SESSIONS: Record<
  SnapshotMarket,
  { timeZone: string; openMinutes: number; closeMinutes: number }
> = {
  india: {
    timeZone: "Asia/Kolkata",
    openMinutes: 9 * 60 + 15,
    closeMinutes: 15 * 60 + 30,
  },
  us: {
    timeZone: "America/New_York",
    openMinutes: 9 * 60 + 30,
    closeMinutes: 16 * 60,
  },
};

function getZonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: get("weekday"),
  };
}

function getTimeZoneOffsetMs(utcDate: Date, timeZone: string) {
  const parts = getZonedParts(utcDate, timeZone);
  const zonedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return zonedAsUtc - utcDate.getTime();
}

function zonedTimeToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
) {
  const approximateUtc = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const offsetMs = getTimeZoneOffsetMs(approximateUtc, timeZone);
  return new Date(approximateUtc.getTime() - offsetMs);
}

function isWeekday(weekday: string) {
  return weekday !== "Sat" && weekday !== "Sun";
}

function getPreviousMarketClose(now: Date, market: SnapshotMarket) {
  const session = MARKET_SESSIONS[market];
  const parts = getZonedParts(now, session.timeZone);
  const localMinutes = parts.hour * 60 + parts.minute;
  const todayClose = zonedTimeToUtc(
    session.timeZone,
    parts.year,
    parts.month,
    parts.day,
    Math.floor(session.closeMinutes / 60),
    session.closeMinutes % 60,
  );

  if (isWeekday(parts.weekday) && localMinutes >= session.closeMinutes) {
    return todayClose;
  }

  for (let daysBack = 1; daysBack <= 7; daysBack += 1) {
    const candidate = new Date(todayClose);
    candidate.setUTCDate(candidate.getUTCDate() - daysBack);
    const candidateParts = getZonedParts(candidate, session.timeZone);
    if (isWeekday(candidateParts.weekday)) {
      return zonedTimeToUtc(
        session.timeZone,
        candidateParts.year,
        candidateParts.month,
        candidateParts.day,
        Math.floor(session.closeMinutes / 60),
        session.closeMinutes % 60,
      );
    }
  }

  return todayClose;
}

function isMarketOpen(now: Date, market: SnapshotMarket) {
  const session = MARKET_SESSIONS[market];
  const parts = getZonedParts(now, session.timeZone);
  if (!isWeekday(parts.weekday)) return false;
  const localMinutes = parts.hour * 60 + parts.minute;
  return (
    localMinutes >= session.openMinutes && localMinutes < session.closeMinutes
  );
}

function getSnapshotPillTone(
  capturedAt: string | null | undefined,
  market: SnapshotMarket,
): SnapshotPillTone {
  if (!capturedAt) return "danger";
  const now = new Date();
  if (isMarketOpen(now, market)) return "warning";

  const capturedMs = Date.parse(capturedAt);
  if (!Number.isFinite(capturedMs)) return "danger";

  return capturedMs >= getPreviousMarketClose(now, market).getTime()
    ? "success"
    : "danger";
}

function formatUsdValueAsInr(
  value: number | null | undefined,
  usdInrRate: number | null,
) {
  if (usdInrRate == null) return formatUsd(value);
  if (value == null) return formatInr(value);
  return formatInr(value * usdInrRate);
}

function maskInvestmentValue(value: string) {
  return value.replace(/\p{N}/gu, "*");
}

type CommandTileInfoKey = "zerodha" | "indmoney" | "bullpen";

const COMMAND_TILE_INFO: Record<
  CommandTileInfoKey,
  { title: string; body: string }
> = {
  zerodha: {
    title: "Zerodha tile details",
    body: "Broker-backed India total. Portfolio is latest holdings market value; Cash is latest available margin from the Kite portfolio sync.",
  },
  indmoney: {
    title: "INDmoney tile details",
    body: "Portfolio is current holdings value and Cash is wallet balance from the latest INDmoney snapshot. Values are converted only when the displayed verified USD/INR rate is valid; otherwise they remain in USD.",
  },
  bullpen: {
    title: "Bullpen tile details",
    body: "Portfolio is the Bullpen wallet position value and Cash is the available balance. Values are converted only when the displayed verified USD/INR rate is valid; otherwise they remain in USD.",
  },
};

function PortfolioCommandSummary({
  totalValue,
  zerodhaValue,
  zerodhaPortfolioValue,
  zerodhaMargin,
  indmoneyValue,
  indmoneyPortfolioValue,
  indmoneyFundsValue,
  bullpenTotalValueInr,
  bullpenAccountValueInr,
  bullpenCashValueInr,
  zerodhaUpdatedAt,
  indmoneyUpdatedAt,
  bullpenUpdatedAt,
  onRefreshZerodha,
  onRefreshIndmoney,
  onRefreshBullpen,
  refreshingZerodha,
  refreshingIndmoney,
  refreshingBullpen,
  fx,
  totalStatuses,
  onRefreshBoard,
  refreshingBoard,
}: {
  onRefreshBoard: () => void;
  refreshingBoard: boolean;
  totalStatuses: Record<CommandTileInfoKey, TotalDataStatusInfo>;
  totalValue: number | null;
  zerodhaValue: number | null;
  zerodhaPortfolioValue: number | null | undefined;
  zerodhaMargin: number | null;
  indmoneyValue: number | null;
  indmoneyPortfolioValue: number | null | undefined;
  indmoneyFundsValue: number | null | undefined;
  bullpenTotalValueInr: number | null | undefined;
  bullpenAccountValueInr: number | null | undefined;
  bullpenCashValueInr: number | null | undefined;
  zerodhaUpdatedAt?: string | null;
  indmoneyUpdatedAt?: string | null;
  bullpenUpdatedAt?: string | null;
  onRefreshZerodha: () => void;
  onRefreshIndmoney: () => void;
  onRefreshBullpen: () => void;
  refreshingZerodha: boolean;
  refreshingIndmoney: boolean;
  refreshingBullpen: boolean;
  fx: DashboardSummaryResponse["fx"] | null;
}) {
  const [showInvestmentNumbers, setShowInvestmentNumbers] = useState(false);
  const [view, setView] = useState("overview");
  const [infoDialog, setInfoDialog] = useState<CommandTileInfoKey | null>(null);
  const infoTrigger = useRef<HTMLButtonElement | null>(null);
  const VisibilityIcon = showInvestmentNumbers ? EyeOff : Eye;
  const info = infoDialog ? COMMAND_TILE_INFO[infoDialog] : null;
  const formatPrivateInvestmentValue = (
    value: number | null | undefined,
    currency: "INR" | "USD" = "INR",
  ) => {
    const formatted = currency === "USD" ? formatUsd(value) : formatInr(value);
    return showInvestmentNumbers ? formatted : maskInvestmentValue(formatted);
  };
  const rows: Array<{
    key: CommandTileInfoKey;
    label: string;
    identity: string;
    value: number | null | undefined;
    portfolio: number | null | undefined;
    cash: number | null | undefined;
    updatedAt?: string | null;
    onRefresh: () => void;
    refreshing: boolean;
    currency: "INR" | "USD";
  }> = [
    {
      key: "zerodha",
      label: "India",
      identity: "Zerodha",
      value: zerodhaValue,
      portfolio: zerodhaPortfolioValue,
      cash: zerodhaMargin,
      updatedAt: zerodhaUpdatedAt,
      onRefresh: onRefreshZerodha,
      refreshing: refreshingZerodha,
      currency: "INR",
    },
    {
      key: "indmoney",
      label: "INDmoney",
      identity: "INDmoney",
      value: indmoneyValue,
      portfolio: indmoneyPortfolioValue,
      cash: indmoneyFundsValue,
      updatedAt: indmoneyUpdatedAt,
      onRefresh: onRefreshIndmoney,
      refreshing: refreshingIndmoney,
      currency: fx?.status === "valid" ? "INR" : "USD",
    },
    {
      key: "bullpen",
      label: "Bullpen",
      identity: "Bullpen",
      value: bullpenTotalValueInr,
      portfolio: bullpenAccountValueInr,
      cash: bullpenCashValueInr,
      updatedAt: bullpenUpdatedAt,
      onRefresh: onRefreshBullpen,
      refreshing: refreshingBullpen,
      currency: fx?.status === "valid" ? "INR" : "USD",
    },
  ];
  const controls = (row: (typeof rows)[number]) => (
    <span className="inline-flex shrink-0 items-center gap-1">
      <button
        type="button"
        aria-label={`${row.label} total (portfolio + cash) info`}
        onClick={(event) => {
          infoTrigger.current = event.currentTarget;
          setInfoDialog(row.key);
        }}
        className="rounded p-1.5 text-slate-500 hover:text-violet-700 focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <Info className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label={`Refresh ${row.identity}`}
        onClick={row.onRefresh}
        disabled={row.refreshing}
        className="rounded p-1.5 text-slate-500 hover:text-violet-700 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
      >
        <RefreshCw
          className={`size-3.5 ${row.refreshing ? "animate-spin" : ""}`}
        />
      </button>
    </span>
  );
  const balance = (row: (typeof rows)[number]) => {
    const status = totalStatuses[row.key];
    return status.pending && !status.capturedAt
      ? "Loading…"
      : status.complete
        ? formatPrivateInvestmentValue(row.value, row.currency)
        : row.key === "zerodha" || status.capturedAt
          ? "Incomplete total"
          : "Unavailable";
  };
  const availability = (status: TotalDataStatusInfo) => (
    <div className="text-xs leading-5 text-slate-600" data-total-complete={status.complete}>
      <p>
        {status.pending ? "Refreshing… · " : ""}
        {status.complete
          ? "All components available"
          : status.failed || status.pending
            ? "Incomplete · Portfolio or cash unverified"
            : "Incomplete · Missing portfolio or cash"}
      </p>
      <SnapshotAvailability info={status} />
    </div>
  );
  const saved = (row: (typeof rows)[number]) => (
    <time
      dateTime={row.updatedAt ?? undefined}
      title={row.updatedAt ?? undefined}
    >
      {row.updatedAt ? formatTs(row.updatedAt) : "Time unavailable"}
    </time>
  );
  const age = (status: TotalDataStatusInfo) => (
    <div className="text-xs leading-5 text-slate-600">
      <p>Snapshot: {dataAge(status.capturedAt)}</p>
      {status.cachedAt !== undefined ? (
        <p>Browser cache: {dataAge(status.cachedAt)} · Saved copy</p>
      ) : null}
    </div>
  );
  const tableClass =
    "w-full text-left text-sm [&_th]:px-4 [&_th]:py-2 [&_th]:text-xs [&_th]:font-semibold [&_th]:text-slate-600 [&_td]:px-4 [&_td]:py-3 [&_td]:align-top";
  return (
    <>
      <Tabs value={view} onValueChange={setView} className="gap-3">
        <TabsList
          aria-label="Portfolio overview details"
          style={{ height: "auto" }}
          className="grid w-full max-w-full grid-cols-1 justify-start gap-1 bg-transparent p-0 sm:w-fit sm:grid-cols-3"
        >
          {[
            ["overview", "Overview"],
            ["sources", "Sources and freshness"],
            ["refresh", "Refresh behaviour"],
          ].map(([value, label]) => (
            <TabsTrigger
              key={value}
              value={value}
              className="h-auto rounded-lg bg-indigo-100 px-3 py-2 text-xs normal-case tracking-normal text-slate-700 transition-none data-active:bg-violet-700 data-active:text-white data-[state=active]:bg-violet-700 data-[state=active]:text-white"
            >
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        <div
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-xs leading-5 text-amber-950"
          data-fx-status={fx?.status ?? "unavailable"}
        >
          {fx?.status === "valid" && fx.source && fx.as_of
            ? `USD/INR ${fx.value?.toFixed(4)} from ${fx.source}, as of ${formatTs(fx.as_of)}.`
            : fx?.status === "stale"
              ? `USD/INR is stale as of ${fx.as_of ? formatTs(fx.as_of) : "an unknown time"}; combined INR totals are omitted and native USD stays USD.`
              : "USD/INR is unavailable; combined INR totals are omitted and USD values remain in USD."}{" "}
          Missing portfolio or cash keeps totals incomplete.
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button
            type="button"
            onClick={onRefreshBoard}
            disabled={refreshingBoard}
            className="bg-amber-400 text-slate-950 hover:bg-amber-300"
          >
            {refreshingBoard ? (
              <Loader2 className="mr-2 size-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 size-4" />
            )}
            Refresh Board
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-pressed={showInvestmentNumbers}
            aria-label={
              showInvestmentNumbers
                ? "Hide investment numbers"
                : "Show investment numbers"
            }
            onClick={() => setShowInvestmentNumbers((value) => !value)}
          >
            <VisibilityIcon className="size-4" />
          </Button>
          <p className="max-w-lg text-xs leading-5 text-slate-600">
            Reloads saved snapshots and FX; requests a fresh Bullpen wallet
            read. Stored prices stay at their snapshot time.
          </p>
        </div>
        <TabsContent value="overview" className="mt-0">
          <p className="mb-2 text-xs text-slate-600 sm:hidden">Scroll horizontally to see all columns.</p>
          <div
            className="overflow-x-auto rounded-xl border border-indigo-100 bg-white focus-visible:outline-2"
            tabIndex={0}
            role="region"
            aria-label="Portfolio overview table"
          >
            <table className={`${tableClass} min-w-[580px]`}>
              <thead className="bg-slate-50">
                <tr>
                  <th scope="col">Portfolio</th>
                  <th scope="col">Portfolio + cash</th>
                  <th scope="col">Snapshot age</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {rows.map((row) => (
                  <tr key={row.key}>
                    <th scope="row" className="w-[22%]">
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="text-sm font-semibold text-slate-950">
                          {row.label}
                        </span>
                        {controls(row)}
                      </div>
                    </th>
                    <td>
                      <p className="font-semibold text-slate-950">
                        {balance(row)}
                      </p>
                      <p className="mt-1 text-xs leading-5 text-slate-600">
                        Source: {totalStatuses[row.key].source} · Saved:{" "}
                        {saved(row)}
                      </p>
                      {availability(totalStatuses[row.key])}
                      {row.currency === "USD" ? (
                        <p className="text-xs leading-5 text-amber-900">
                          INR unavailable · Verified USD/INR required
                        </p>
                      ) : null}
                    </td>
                    <td className="w-[23%]">{age(totalStatuses[row.key])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabsContent>
        <TabsContent value="sources" className="mt-0">
          <p className="mb-2 text-xs text-slate-600 sm:hidden">Scroll horizontally to see all columns.</p>
          <div
            className="overflow-x-auto rounded-xl border border-indigo-100 bg-white focus-visible:outline-2"
            tabIndex={0}
            role="region"
            aria-label="Sources and freshness table"
          >
            <table className={`${tableClass} min-w-[780px]`}>
              <thead className="bg-slate-50">
                <tr>
                  {[
                    "Source",
                    "Refresh",
                    "Captured snapshot text",
                    "Age",
                    "INR",
                  ].map((label) => (
                    <th key={label} scope="col">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {rows.map((row) => {
                  const status = totalStatuses[row.key];
                  return (
                    <tr key={row.key}>
                      <th scope="row">
                        <div className="flex flex-wrap items-center">
                          <span className="text-sm text-slate-950">
                            {row.identity}
                          </span>
                          {controls(row)}
                        </div>
                      </th>
                      <td className="text-xs leading-5">
                        <SnapshotAvailability info={status} />
                      </td>
                      <td>
                        <p className="text-xs leading-5">
                          Source: {status.source}
                        </p>
                        <p className="text-xs leading-5">Saved: {saved(row)}</p>
                        <div className="mt-1 text-xs leading-5">
                          <p>
                            Portfolio:{" "}
                            {formatPrivateInvestmentValue(
                              row.portfolio,
                              row.currency,
                            )}
                          </p>
                          <p>
                            Cash:{" "}
                            {formatPrivateInvestmentValue(
                              row.cash,
                              row.currency,
                            )}
                          </p>
                        </div>
                      </td>
                      <td>{age(status)}</td>
                      <td>
                        <p className="text-xs font-medium">
                          {row.currency === "USD"
                            ? "Unavailable · Verified USD/INR required"
                            : status.complete
                              ? "Available"
                              : "Incomplete total"}
                        </p>
                        {availability(status)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </TabsContent>
        <TabsContent
          value="refresh"
          className="mt-0 rounded-xl border border-indigo-100 bg-white p-4 text-sm leading-6 text-slate-700"
        >
          <h2 className="font-semibold text-slate-950">Refresh behaviour</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>
              Refresh Board reloads stored portfolio snapshots and FX status.
            </li>
            <li>Requests a fresh Bullpen wallet read.</li>
            <li>Zerodha sync is requested when its workflow is open.</li>
            <li>
              INDmoney stays at the last imported snapshot until you import a
              new one.
            </li>
            <li>
              Reloading the board does not make stored snapshot prices current.
            </li>
            <li>
              If a read fails, the last available data is labelled beside each
              source.
            </li>
          </ul>
        </TabsContent>
      </Tabs>
      <div className="mt-3 border-t border-indigo-200 pt-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-2 text-xs font-semibold text-slate-600">
            <Target className="size-3.5" />
            Total Investments
          </span>
          <p className="font-semibold text-slate-950">
            {totalValue == null
              ? "Combined INR unavailable"
              : formatPrivateInvestmentValue(totalValue)}
          </p>
        </div>
        <p className="mt-1 text-xs leading-5 text-slate-600">
          Sources: Zerodha, INDmoney and Bullpen snapshots · Oldest snapshot:{" "}
          {dataAge(
            Math.min(
              ...Object.values(totalStatuses)
                .map((status) => Date.parse(status.capturedAt ?? ""))
                .filter(Number.isFinite),
            ),
          )}
          .
          {Object.values(totalStatuses).some(
            (status) => !status.complete || status.failed,
          )
            ? " Incomplete sources: combined total omitted."
            : ""}
        </p>
      </div>
      <details className="mt-3 text-xs text-slate-600">
        <summary className="w-fit cursor-pointer rounded-sm font-semibold underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2">
          How portfolio totals are calculated
        </summary>
        <div className="mt-3 space-y-2 leading-5">
          {Object.entries(COMMAND_TILE_INFO).map(([key, details]) => (
            <p key={key}>{details.body}</p>
          ))}
        </div>
      </details>
      <Dialog.Root
        open={info !== null}
        onOpenChange={(open) => {
          if (!open) setInfoDialog(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/50" />
          <Dialog.Content
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              infoTrigger.current?.focus();
            }}
            className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-5 text-slate-950 shadow-xl"
          >
            <Dialog.Title className="text-lg font-semibold">
              {info?.title}
            </Dialog.Title>
            <Dialog.Description className="mt-3 text-sm leading-6 text-slate-600">
              {info?.body}
            </Dialog.Description>
            <Dialog.Close asChild>
              <Button type="button" variant="outline" className="mt-5">
                Close
              </Button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

function buildUsTopHoldings(
  overview: IndMoneyUsPortfolioOverviewResponse | null,
  usdInrRate: number | null,
): PortfolioCardTopHolding[] {
  const topAllocations = overview?.latest?.derived.top_allocations ?? [];
  const holdings =
    topAllocations.length > 0
      ? topAllocations.slice(0, 4)
      : [...(overview?.latest?.holdings ?? [])]
          .sort(
            (left, right) =>
              (right.current_value ?? 0) - (left.current_value ?? 0),
          )
          .slice(0, 4);

  return holdings.map((holding) => ({
    id: holding.symbol,
    symbol: holding.symbol,
    value: formatUsdValueAsInr(holding.current_value, usdInrRate),
    name: holding.company_name,
    secondaryValue: `P&L ${formatPercent(holding.total_pnl_percent)}`,
    secondaryToneClass: toneClass(holding.total_pnl_percent),
  }));
}

async function fetchBullpenPositions(
  forceFresh = false,
): Promise<BullpenPositionsResponse> {
  const params = new URLSearchParams({
    caller_source: forceFresh ? "ui-dashboard-refresh" : "ui-passive-refresh",
    max_age_seconds: forceFresh ? "0" : "20",
    request_id: crypto.randomUUID(),
  });
  params.set(forceFresh ? "force_fresh" : "passive", "true");
  const response = await fetch(`/api/bullpen-ai/positions?${params}`, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { "Cache-Control": "no-cache" },
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || "Failed to load Bullpen wallet positions.");
  }

  return (await response.json()) as BullpenPositionsResponse;
}

function parseBullpenAccountValueUsd(message?: string | null) {
  if (!message) return null;
  const match = message.match(/(-?\d[\d,]*(?:\.\d+)?)/);
  if (!match) return null;
  const parsed = Number.parseFloat(match[1].replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function dashboardSummaryToState(
  summary: DashboardSummaryResponse,
): Partial<DashboardState> {
  const zerodhaSnapshot = summary.zerodha?.snapshot;
  const indmoneySnapshot = summary.indmoney_us?.snapshot;

  const zerodhaOverview: ZerodhaPortfolioOverviewResponse = {
    latest: zerodhaSnapshot
      ? {
          snapshot_date: zerodhaSnapshot.snapshot_date,
          captured_at: zerodhaSnapshot.captured_at,
          source: zerodhaSnapshot.source,
          holdings_count: zerodhaSnapshot.holdings_count,
          net_positions_count: 0,
          day_positions_count: 0,
          holdings_market_value: zerodhaSnapshot.holdings_market_value,
          holdings_invested_value:
            zerodhaSnapshot.holdings_invested_value,
          holdings_pnl: zerodhaSnapshot.holdings_pnl,
          holdings_day_change_value:
            zerodhaSnapshot.holdings_day_change_value,
          available_margin: zerodhaSnapshot.available_margin,
          positions_pnl: 0,
          positions_m2m: 0,
          holdings: zerodhaSnapshot.top_holdings.map((holding) => ({
            tradingsymbol: holding.symbol,
            exchange: "NSE",
            instrument_token: null,
            isin: null,
            product: null,
            quantity: 0,
            used_quantity: 0,
            t1_quantity: 0,
            realised_quantity: 0,
            authorised_quantity: 0,
            authorised_date: null,
            opening_quantity: 0,
            short_quantity: 0,
            collateral_quantity: 0,
            collateral_type: null,
            discrepancy: false,
            average_price: 0,
            last_price: 0,
            close_price: 0,
            pnl: holding.pnl,
            day_change: 0,
            day_change_percentage: 0,
            market_value: holding.current_value,
            invested_value: holding.invested_value,
            day_change_value: 0,
          })),
          positions: { net: [], day: [] },
        }
      : null,
    history:
      zerodhaSnapshot?.history.map((point) => ({
        snapshot_date: point.captured_at.slice(0, 10),
        captured_at: point.captured_at,
        source: "dashboard-summary",
        holdings_count: 0,
        net_positions_count: 0,
        day_positions_count: 0,
        holdings_market_value: point.value,
        holdings_invested_value: null,
        holdings_pnl: 0,
        holdings_day_change_value: 0,
        available_margin: 0,
        positions_pnl: 0,
        positions_m2m: 0,
      })) ?? [],
  };

  const indmoneyOverview: IndMoneyUsPortfolioOverviewResponse = {
    latest: indmoneySnapshot
      ? {
          id: 0,
          snapshot_date: indmoneySnapshot.snapshot_date,
          captured_at: indmoneySnapshot.captured_at,
          source: indmoneySnapshot.source,
          parse_status: indmoneySnapshot.parse_status,
          parse_warnings: [],
          holdings_count: indmoneySnapshot.holdings_count,
          reported_holdings_count: null,
          indices_count: 0,
          wallet_balance: indmoneySnapshot.wallet_balance,
          current_value: indmoneySnapshot.current_value,
          invested_value: indmoneySnapshot.invested_value,
          day_return_value: indmoneySnapshot.day_return_value,
          day_return_percent: indmoneySnapshot.day_return_percent,
          total_return_value: indmoneySnapshot.total_return_value,
          total_return_percent: indmoneySnapshot.total_return_percent,
          raw_text: "",
          market_indices: [],
          holdings: indmoneySnapshot.top_holdings.map((holding) => ({
            company_name: holding.company_name ?? holding.symbol,
            symbol: holding.symbol,
            market_price: null,
            market_change_percent: null,
            invested_value: holding.invested_value,
            quantity: null,
            average_price: null,
            current_value: holding.current_value,
            total_pnl: holding.pnl,
            total_pnl_percent: holding.pnl_percent,
            portfolio_weight_percent: holding.weight_percent,
            price_vs_average_percent: null,
          })),
          derived: {
            parsed_holdings_current_value: indmoneySnapshot.current_value ?? 0,
            parsed_holdings_invested_value:
              indmoneySnapshot.invested_value ?? 0,
            parsed_holdings_total_pnl:
              indmoneySnapshot.total_return_value ?? 0,
            profitable_holdings_count: 0,
            loss_making_holdings_count: 0,
            top_allocations: [],
            top_gainers: [],
            top_laggards: [],
            reconciliation: [],
          },
        }
      : null,
    history:
      indmoneySnapshot?.history.map((point) => ({
        id: 0,
        snapshot_date: point.captured_at.slice(0, 10),
        captured_at: point.captured_at,
        source: "dashboard-summary",
        parse_status: "parsed",
        parse_warnings: [],
        holdings_count: 0,
        reported_holdings_count: null,
        indices_count: 0,
        wallet_balance: 0,
        current_value: point.value,
        invested_value: null,
        day_return_value: null,
        day_return_percent: null,
        total_return_value: null,
        total_return_percent: null,
      })) ?? [],
  };

  return {
    fx: summary.fx,
    zerodhaStatus: summary.zerodha
      ? {
          connected: summary.zerodha.connected,
          login_time: summary.zerodha.login_time,
          expires_at: summary.zerodha.expires_at,
          last_portfolio_sync_at:
            summary.zerodha.snapshot?.captured_at ?? null,
          last_portfolio_snapshot_date:
            summary.zerodha.snapshot?.snapshot_date ?? null,
        }
      : null,
    zerodhaOverview,
    indmoneyOverview,
    portfolioHistory: summary.portfolio_history,
    bullpenPositions: summary.bullpen
      ? {
          summary: {
            activeCount: summary.bullpen.active_count,
            claimableCount: summary.bullpen.claimable_count,
            claimableValue: summary.bullpen.claimable_value,
            cashBalance: summary.bullpen.cash_balance,
            totalValue: summary.bullpen.total_value,
            unrealizedPnl: summary.bullpen.unrealized_pnl,
            walletValue: summary.bullpen.wallet_value,
          },
          fetchedAt: summary.bullpen.fetched_at ?? undefined,
          positionsSource: summary.bullpen.source,
        }
      : null,
  };
}

function DashboardPageForUser({
  userId,
  initialSummary,
}: {
  userId: number | null | undefined;
  initialSummary?: DashboardSummaryResponse | null;
}) {
  const [dashboard, setDashboard] = useState<DashboardState>(() => {
    if (initialSummary) {
      return {
        ...INITIAL_STATE,
        ...dashboardSummaryToState(initialSummary),
      };
    }
    const cachedOverview = readDashboardOverviewCache(userId);
    return cachedOverview
      ? { ...INITIAL_STATE, ...cachedOverview }
      : INITIAL_STATE;
  });
  const [pendingSections, setPendingSections] = useState<DashboardPendingState>(
    () => {
      const pending = createPendingSectionsState(true);
      if (initialSummary) {
        for (const key of DASHBOARD_CRITICAL_KEYS) pending[key] = false;
      }
      return pending;
    },
  );
  const [refreshing, setRefreshing] = useState(false);
  const [refreshingBullpenTile, setRefreshingBullpenTile] = useState(false);
  const [errorsBySection, setErrorsBySection] = useState<DashboardErrorsState>(
    () => {
      if (!initialSummary) return {};
      return Object.fromEntries(
        [
          ["zerodhaOverview", initialSummary.sections.zerodha],
          ["indmoneyOverview", initialSummary.sections.indmoney_us],
          ["bullpenPositions", initialSummary.sections.bullpen],
        ].flatMap(([key, section]) =>
          typeof section === "object" && section?.status === "unavailable"
            ? [[key, "Source temporarily unavailable."]]
            : [],
        ),
      );
    },
  );
  const [dataProvenance, setDataProvenance] =
    useState<DashboardDataProvenance | null>(() => {
      if (initialSummary) {
        return {
          source: "server-summary",
          asOf: Date.parse(initialSummary.generated_at),
        };
      }
      return readDashboardOverviewCacheProvenance(userId);
    });
  const [cacheTimes, setCacheTimes] = useState<
    Partial<Record<DashboardSectionKey, number>>
  >(() => {
    if (initialSummary) return {};
    const entries = readDashboardOverviewCachePayload(userId).entries;
    return Object.fromEntries(
      DASHBOARD_SECTION_KEYS.flatMap((key) =>
        entries[key] ? [[key, entries[key]!.cachedAt]] : [],
      ),
    );
  });
  const requestIdRef = useRef(0);
  const loadDashboardPromiseRef = useRef<Promise<void> | null>(null);
  const loadThreatsPromiseRef = useRef<Promise<void> | null>(null);

  const refreshZerodhaTile = useCallback(() => {
    window.dispatchEvent(new Event(ZERODHA_DASHBOARD_SYNC_NOW_EVENT));
  }, []);

  const refreshIndmoneyTile = useCallback(() => {
    window.dispatchEvent(new Event(INDMONEY_DASHBOARD_SYNC_NOW_EVENT));
  }, []);

  const errors = useMemo(
    () =>
      DASHBOARD_SECTION_KEYS.flatMap((key) =>
        errorsBySection[key] ? [errorsBySection[key] as string] : [],
      ),
    [errorsBySection],
  );

  const loadDashboard = useCallback((initialLoad = false) => {
    if (loadDashboardPromiseRef.current) {
      console.info(
        JSON.stringify({
          event: "dashboard_refresh_deduplicated",
          reason: "refresh_already_in_flight",
        }),
      );
      return loadDashboardPromiseRef.current;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    setPendingSections((current) => ({
      ...current,
      fx: true,
      zerodhaStatus: true,
      zerodhaOverview: true,
      indmoneyOverview: true,
      polymarketState: true,
      bullpenPositions: true,
    }));
    setErrorsBySection({});
    if (!initialLoad) {
      setRefreshing(true);
    }

      const loadPromise = apiService
        .getDashboardSummary()
        .then((summary) => {
          if (requestId !== requestIdRef.current) return;
          const update = dashboardSummaryToState(summary);
          setCacheTimes((current) => ({
            bullpenPositions: current.bullpenPositions,
          }));
          setDataProvenance({
            source: "live-summary",
            asOf: Date.parse(summary.generated_at),
          });
          setDashboard((current) => {
            const nextState = {
              ...current,
              ...update,
              // A temporarily unavailable summary must never erase a verified
              // Bullpen snapshot already displayed or cached in this browser.
              bullpenPositions:
                current.bullpenPositions ?? update.bullpenPositions ?? null,
            };
            for (const key of DASHBOARD_CRITICAL_KEYS) {
              writeDashboardOverviewCacheEntry(userId, key, nextState[key]);
            }
            return nextState;
          });
          const sectionErrors: DashboardErrorsState = {};
          if (summary.sections.zerodha?.status === "unavailable") {
            sectionErrors.zerodhaOverview =
              "India portfolio: temporarily unavailable.";
          }
          if (summary.sections.indmoney_us?.status === "unavailable") {
            sectionErrors.indmoneyOverview =
              "US portfolio: temporarily unavailable.";
          }
          if (summary.sections.bullpen?.status === "unavailable") {
            sectionErrors.bullpenPositions =
              "Bullpen wallet: no passive cached snapshot is available.";
          }
          setErrorsBySection(sectionErrors);
        })
        .catch((error) => {
          if (requestId !== requestIdRef.current) return;
          const cached = readDashboardOverviewCache(userId);
          if (cached) {
            logDashboardCacheFallback("zerodhaOverview", error);
            setDashboard((current) => ({ ...current, ...cached }));
            const entries = readDashboardOverviewCachePayload(userId).entries;
            setCacheTimes(
              Object.fromEntries(
                DASHBOARD_SECTION_KEYS.flatMap((key) =>
                  entries[key] ? [[key, entries[key]!.cachedAt]] : [],
                ),
              ),
            );
            setDataProvenance(readDashboardOverviewCacheProvenance(userId));
            setErrorsBySection({
              zerodhaOverview:
                "Dashboard summary: live refresh failed; showing last saved data.",
            });
            return;
          }
          setErrorsBySection({
            zerodhaOverview: `Dashboard summary: ${normalizeError(error)}`,
          });
        })
        .finally(() => {
          if (requestId === requestIdRef.current) {
            setPendingSections((current) => ({
              ...current,
              fx: false,
              zerodhaStatus: false,
              zerodhaOverview: false,
              indmoneyOverview: false,
              polymarketState: false,
              bullpenPositions: false,
            }));
            setRefreshing(false);
          }
          if (loadDashboardPromiseRef.current === loadPromise) {
            loadDashboardPromiseRef.current = null;
          }
        });
      loadDashboardPromiseRef.current = loadPromise;
      return loadPromise;
    },
    [userId],
  );

  const loadThreats = useCallback(() => {
    if (loadThreatsPromiseRef.current) return loadThreatsPromiseRef.current;
    setPendingSections((current) => ({
      ...current,
      zerodhaThreat: true,
      indmoneyThreat: true,
    }));

    const loaders = [
      apiService
        .zerodhaThreatsLatest()
        .then(({ analysis }) => {
          setDashboard((current) => {
            const nextState = { ...current, zerodhaThreat: analysis };
            writeDashboardOverviewCacheEntry(
              userId,
              "zerodhaThreat",
              nextState.zerodhaThreat,
            );
            return nextState;
          });
        })
        .catch((error) => {
          setErrorsBySection((current) => ({
            ...current,
            zerodhaThreat: `India threats: ${normalizeError(error)}`,
          }));
        })
        .finally(() =>
          setPendingSections((current) => ({
            ...current,
            zerodhaThreat: false,
          })),
        ),
      apiService
        .indmoneyUsThreatsLatest()
        .then(({ analysis }) => {
          setDashboard((current) => {
            const nextState = { ...current, indmoneyThreat: analysis };
            writeDashboardOverviewCacheEntry(
              userId,
              "indmoneyThreat",
              nextState.indmoneyThreat,
            );
            return nextState;
          });
        })
        .catch((error) => {
          setErrorsBySection((current) => ({
            ...current,
            indmoneyThreat: `US threats: ${normalizeError(error)}`,
          }));
        })
        .finally(() =>
          setPendingSections((current) => ({
            ...current,
            indmoneyThreat: false,
          })),
        ),
    ];
    const request = Promise.allSettled(loaders)
      .then(() => undefined)
      .finally(() => {
        loadThreatsPromiseRef.current = null;
      });
    loadThreatsPromiseRef.current = request;
    return request;
  }, [userId]);

  useEffect(() => {
    if (initialSummary) {
      const initialState = dashboardSummaryToState(initialSummary);
      for (const key of DASHBOARD_CRITICAL_KEYS) {
        const value = initialState[key];
        if (value !== undefined) {
          writeDashboardOverviewCacheEntry(userId, key, value);
        }
      }
      return;
    }
    const timeoutId = window.setTimeout(() => {
      void loadDashboard(true);
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [initialSummary, loadDashboard, userId]);

  const indiaSnapshot = dashboard.zerodhaOverview?.latest ?? null;
  const usSnapshot = dashboard.indmoneyOverview?.latest ?? null;
  const indiaSnapshotTone = getSnapshotPillTone(
    indiaSnapshot?.captured_at,
    "india",
  );
  const usSnapshotTone = getSnapshotPillTone(usSnapshot?.captured_at, "us");
  const indiaUrgentRows = sortUrgentActionRows(
    extractUrgentActionRows({
      analysis: dashboard.zerodhaThreat,
      market: "india",
      threatHref: URLs.routes.console.zerodhaThreats(),
    }),
  );
  const usUrgentRows = sortUrgentActionRows(
    extractUrgentActionRows({
      analysis: dashboard.indmoneyThreat,
      market: "us",
      threatHref: URLs.routes.console.indmoneyUsThreats(),
    }),
  );
  const zerodhaInvestedValue =
    indiaSnapshot?.holdings_invested_value ??
    (indiaSnapshot &&
    indiaSnapshot.holdings.length >= indiaSnapshot.holdings_count
      ? indiaSnapshot.holdings.reduce(
          (sum, holding) => sum + (holding.invested_value || 0),
          0,
        )
      : null);
  const zerodhaAvailableMargin = indiaSnapshot?.available_margin ?? null;
  const indiaComplete =
    indiaSnapshot != null &&
    Number.isFinite(indiaSnapshot.holdings_market_value) &&
    indiaSnapshot.available_margin != null && Number.isFinite(indiaSnapshot.available_margin);
  const zerodhaCommandValue = indiaComplete && indiaSnapshot.available_margin != null
    ? indiaSnapshot.holdings_market_value + indiaSnapshot.available_margin
    : null;
  const usdInrRate = validDashboardFxRate(dashboard.fx);
  const effectiveFx =
    dashboard.fx?.status === "valid" && usdInrRate == null
      ? { ...dashboard.fx, status: "stale" as const }
      : dashboard.fx;
  const indmoneyInvestedValue = usSnapshot?.invested_value ?? null;
  const indmoneyPortfolioValue =
    usSnapshot?.current_value == null
      ? undefined
      : usSnapshot.current_value * (usdInrRate ?? 1);
  const indmoneyAvailableFundsValue =
    usSnapshot?.wallet_balance == null
      ? undefined
      : usSnapshot.wallet_balance * (usdInrRate ?? 1);
  const usComplete =
    indmoneyPortfolioValue != null &&
    indmoneyAvailableFundsValue != null &&
    Number.isFinite(indmoneyPortfolioValue) &&
    Number.isFinite(indmoneyAvailableFundsValue);
  const indmoneyCommandValue = usComplete
    ? indmoneyPortfolioValue + indmoneyAvailableFundsValue
    : null;
  const bullpenSummary = dashboard.bullpenPositions?.summary;
  const bullpenPositionRows = dashboard.bullpenPositions?.positions;
  const bullpenVerifiedActivePositions =
    bullpenPositionRows?.filter(isBullpenHistoryActivePosition) ?? [];
  const bullpenVerifiedClaimablePositions =
    bullpenPositionRows?.filter(isBullpenHistoryClaimablePosition) ?? [];
  const bullpenClaimableValueUsd = bullpenVerifiedClaimablePositions.reduce(
    (total, position) =>
      total +
      Math.max(
        0,
        position.claimableValue ??
          position.expectedPayoutUsd ??
          position.currentValue ??
          0,
      ),
    0,
  );
  const bullpenPositionsValueUsd =
    bullpenPositionRows !== undefined
      ? (sumCurrentPositionValue(bullpenVerifiedActivePositions) ?? 0) +
        bullpenClaimableValueUsd
      : null;
  const bullpenWalletValueUsd =
    bullpenSummary?.walletValue ??
    bullpenSummary?.totalValue ??
    dashboard.polymarketState?.live.balance.account_value_usd ??
    parseBullpenAccountValueUsd(
      dashboard.polymarketState?.live.balance.message,
    );
  const bullpenCashValueUsd =
    bullpenSummary?.cashBalance ??
    dashboard.polymarketState?.live.balance.available_balance_usd ??
    null;
  const bullpenNativeValues = resolveBullpenPortfolioPlusCash({
    positionsValue: bullpenPositionsValueUsd,
    cashValue: bullpenCashValueUsd,
    walletValue: bullpenWalletValueUsd,
  });
  const bullpenDisplayValues =
    usdInrRate == null
      ? bullpenNativeValues
      : convertDashboardUsdTotalToInr(bullpenNativeValues, usdInrRate);
  const bullpenPortfolioValue = bullpenDisplayValues.portfolioValue;
  const bullpenCashValue = bullpenDisplayValues.cashValue;
  const bullpenTotalValue = bullpenDisplayValues.totalValue;
  const totalCommandValue =
    usdInrRate == null ||
    zerodhaCommandValue == null ||
    indmoneyCommandValue == null ||
    errorsBySection.zerodhaOverview ||
    errorsBySection.indmoneyOverview ||
    errorsBySection.bullpenPositions ||
    bullpenPortfolioValue == null ||
    bullpenCashValue == null
      ? null
      : bullpenTotalValue == null
        ? null
        : zerodhaCommandValue + indmoneyCommandValue + bullpenTotalValue;
  const indmoneyAvailableFunds = usSnapshot?.wallet_balance ?? null;
  const persistedIndiaTrend = buildPersistedDashboardTrend(
    dashboard.portfolioHistory?.india ?? [],
  );
  const portfolioCommandTrend =
    persistedIndiaTrend.length > 0
      ? persistedIndiaTrend
      : buildGenuineInrPortfolioTrend(dashboard.zerodhaOverview?.history ?? []);
  const persistedIndmoneyTrend = buildPersistedDashboardTrend(
    dashboard.portfolioHistory?.indmoney ?? [],
  );
  const indmoneyCommandTrend =
    persistedIndmoneyTrend.length > 0
      ? persistedIndmoneyTrend
      : usdInrRate == null
        ? []
        : buildDashboardPortfolioTrend(
            (dashboard.indmoneyOverview?.history ?? []).map((snapshot) => ({
              capturedAt: snapshot.captured_at,
              portfolioValue: snapshot.current_value,
              cashValue: snapshot.wallet_balance,
            })),
            usdInrRate,
          );
  const bullpenCommandTrend = buildPersistedDashboardTrend(
    dashboard.portfolioHistory?.bullpen ?? [],
  );
  const combinedCommandTrend = buildPersistedDashboardTrend(
    dashboard.portfolioHistory?.combined ?? [],
  );
  const showHeroSkeleton =
    !hasCriticalDashboardContent(dashboard) &&
    DASHBOARD_CRITICAL_KEYS.some((key) => pendingSections[key]);
  const showIndiaPortfolioSkeleton =
    !indiaSnapshot && pendingSections.zerodhaOverview;
  const showUsPortfolioSkeleton =
    !usSnapshot && pendingSections.indmoneyOverview;
  const showIndiaThreatSkeleton =
    !dashboard.zerodhaThreat && pendingSections.zerodhaThreat;
  const showUsThreatSkeleton =
    !dashboard.indmoneyThreat && pendingSections.indmoneyThreat;
  const bullpenUpdatedAt =
    dashboard.bullpenPositions?.fetchedAt ??
    dashboard.bullpenPositions?.lastSuccessfulLiveSnapshot?.fetchedAt ??
    dashboard.bullpenPositions?.health?.timestamp ??
    null;
  const totalStatuses: Record<CommandTileInfoKey, TotalDataStatusInfo> = {
    zerodha: {
      source: indiaSnapshot?.source ? `Zerodha · ${indiaSnapshot.source}` : "Zerodha",
      snapshotKnown: indiaSnapshot != null,
      historyHref: "/console/zerodha#saved-portfolio-snapshots",
      historyLabel: "View India saved portfolio history",
      capturedAt: indiaSnapshot?.captured_at,
      cachedAt: cacheTimes.zerodhaOverview,
      complete: indiaComplete,
      pending: pendingSections.zerodhaOverview,
      failed: Boolean(errorsBySection.zerodhaOverview),
    },
    indmoney: {
      source: usSnapshot?.source ? `INDmoney · ${usSnapshot.source}` : "INDmoney",
      snapshotKnown: usSnapshot != null,
      historyHref: "/console/indmoney-us#us-snapshot-panel-saved",
      historyLabel: "View US saved portfolio history",
      capturedAt: usSnapshot?.captured_at,
      cachedAt: cacheTimes.indmoneyOverview,
      complete: usComplete,
      pending: pendingSections.indmoneyOverview,
      failed: Boolean(
        errorsBySection.indmoneyOverview ||
        errorsBySection.zerodhaOverview?.startsWith("Dashboard summary:"),
      ),
    },
    bullpen: {
      source: dashboard.bullpenPositions?.positionsSource ? `Bullpen · ${dashboard.bullpenPositions.positionsSource}` : "Bullpen",
      snapshotKnown: dashboard.bullpenPositions != null,
      capturedAt: bullpenUpdatedAt,
      cachedAt: cacheTimes.bullpenPositions,
      complete:
        bullpenPortfolioValue != null &&
        bullpenCashValue != null &&
        bullpenTotalValue != null,
      pending: refreshingBullpenTile || pendingSections.bullpenPositions,
      failed: Boolean(
        errorsBySection.bullpenPositions ||
        errorsBySection.zerodhaOverview?.startsWith("Dashboard summary:"),
      ),
    },
  };
  const combinedChartCapturedAt =
    [indiaSnapshot?.captured_at, usSnapshot?.captured_at, bullpenUpdatedAt]
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null;
  const portfolioChartOptions: Record<
    "india" | "indmoney" | "bullpen" | "combined",
    PortfolioCommandChartOption
  > = {
    india: {
      label: "India portfolio value",
      currentValue: zerodhaCommandValue,
      trendPoints: portfolioCommandTrend,
      capturedAt: indiaSnapshot?.captured_at,
      dataStatus: totalStatuses.zerodha,
    },
    indmoney: {
      label: "IndMoney portfolio value",
      currentValue: usdInrRate == null ? null : indmoneyCommandValue,
      trendPoints: indmoneyCommandTrend,
      capturedAt: usSnapshot?.captured_at,
      dataStatus: totalStatuses.indmoney,
      historyUnavailable: usdInrRate == null,
    },
    bullpen: {
      label: "Bullpen portfolio value",
      currentValue: usdInrRate == null ? null : (bullpenTotalValue ?? null),
      trendPoints: bullpenCommandTrend,
      capturedAt: bullpenUpdatedAt,
      dataStatus: totalStatuses.bullpen,
      historyUnavailable: usdInrRate == null,
    },
    combined: {
      label: "Combined portfolio value",
      currentValue: totalCommandValue,
      trendPoints: combinedCommandTrend,
      historyUnavailable: usdInrRate == null,
      capturedAt: combinedChartCapturedAt,
      dataStatus: {
        source: "Zerodha + INDmoney + Bullpen · Verified FX required",
        failed: Object.values(totalStatuses).some((status) => status.failed),
        pending: Object.values(totalStatuses).some((status) => status.pending),
        cachedAt: Object.values(totalStatuses).find((status) => status.cachedAt !== undefined)?.cachedAt,
        capturedAt: combinedChartCapturedAt,
        complete: totalCommandValue != null,
      },
    },
  };
  const refreshBullpenTile = useCallback(async (forceFresh = true) => {
    setRefreshingBullpenTile(true);
    try {
      const positions = await fetchBullpenPositions(forceFresh);
      setCacheTimes((current) => ({ ...current, bullpenPositions: undefined }));
      setDashboard((current) => {
        const nextState = { ...current, bullpenPositions: positions };
        writeDashboardOverviewCacheEntry(
          userId,
          "bullpenPositions",
          nextState.bullpenPositions,
        );
        return nextState;
      });
      setErrorsBySection((current) => {
        if (!current.bullpenPositions) return current;
        const nextErrors = { ...current };
        delete nextErrors.bullpenPositions;
        return nextErrors;
      });
    } catch (error) {
      setErrorsBySection((current) => ({
        ...current,
        bullpenPositions: `Bullpen wallet: ${normalizeError(error)}`,
      }));
    } finally {
      setRefreshingBullpenTile(false);
    }
  }, [userId]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void refreshBullpenTile(false);
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [refreshBullpenTile]);

  useEffect(() => {
    if (!showHeroSkeleton && dataProvenance) {
      performance.mark("dashboard-above-fold-rendered");
    }
  }, [dataProvenance, showHeroSkeleton]);

  return (
    <div
      className="mx-auto flex flex-col gap-6"
      data-performance-usable={
        showHeroSkeleton ? undefined : "dashboard-summary"
      }
    >
      {dataProvenance ? (
        <div
          className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-xs leading-5 text-slate-600 shadow-sm"
          data-dashboard-data-source={dataProvenance.source}
        >
          <span className="font-semibold text-slate-900">
            {dataProvenance.source === "server-summary"
              ? "Server dashboard summary"
              : dataProvenance.source === "live-summary"
                ? "Reloaded stored dashboard summary"
                : "Browser cache"}
          </span>
          {` • ${formatDataAge(dataProvenance.asOf)}`}
          {indiaSnapshot?.captured_at
            ? ` • India stored snapshot ${formatDataAge(indiaSnapshot.captured_at)}`
            : ""}
          {usSnapshot?.captured_at
            ? ` • US stored snapshot ${formatDataAge(usSnapshot.captured_at)}`
            : ""}
        </div>
      ) : null}
      <section
        className="rounded-3xl border border-indigo-100 bg-indigo-50/70 text-slate-950 shadow-sm"
        data-performance-usable="dashboard-portfolio-summary"
      >
        <div className="relative p-4 sm:p-5">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-slate-950">
                Dashboard
              </h1>
              <p className="mt-1 text-sm text-slate-600">
                Portfolio overview · Saved snapshots
              </p>
            </div>
          </div>

          <div className="mt-4">
            <PortfolioCommandSummary
              onRefreshBoard={() => {
                window.dispatchEvent(
                  new Event(ZERODHA_DASHBOARD_SYNC_NOW_EVENT),
                );
                void Promise.allSettled([
                  loadDashboard(false),
                  refreshBullpenTile(true),
                ]);
              }}
              refreshingBoard={refreshing}
              totalStatuses={totalStatuses}
              totalValue={totalCommandValue}
              zerodhaValue={zerodhaCommandValue}
              zerodhaPortfolioValue={indiaSnapshot?.holdings_market_value}
              zerodhaMargin={zerodhaAvailableMargin}
              indmoneyValue={indmoneyCommandValue}
              indmoneyPortfolioValue={indmoneyPortfolioValue}
              indmoneyFundsValue={indmoneyAvailableFundsValue}
              bullpenTotalValueInr={bullpenTotalValue}
              bullpenAccountValueInr={bullpenPortfolioValue}
              bullpenCashValueInr={bullpenCashValue}
              zerodhaUpdatedAt={indiaSnapshot?.captured_at}
              indmoneyUpdatedAt={usSnapshot?.captured_at}
              bullpenUpdatedAt={bullpenUpdatedAt}
              onRefreshZerodha={refreshZerodhaTile}
              onRefreshIndmoney={refreshIndmoneyTile}
              onRefreshBullpen={() => void refreshBullpenTile(true)}
              refreshingZerodha={pendingSections.zerodhaOverview}
              refreshingIndmoney={pendingSections.indmoneyOverview}
              refreshingBullpen={
                refreshingBullpenTile || pendingSections.bullpenPositions
              }
              fx={effectiveFx}
            />
          </div>
        </div>
      </section>

      <section
        className="rounded-3xl bg-slate-950 p-5 text-white"
        aria-label="Portfolio history"
      >
        <PortfolioCommandChart
          userId={userId}
          options={portfolioChartOptions}
        />
      </section>

      {errors.length > 0 ? (
        <div className="flex items-start gap-3 rounded-[24px] border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>
            Some dashboard modules could not be refreshed: {errors.join(" | ")}
          </span>
        </div>
      ) : null}

      <section className="grid gap-6 xl:grid-cols-2">
        {showIndiaPortfolioSkeleton ? (
          <DashboardMarketCardSkeleton label="Loading saved Zerodha India snapshot…" />
        ) : (
          <MarketPortfolioCard
            dataStatus={totalStatuses.zerodha}
            market="india"
            title="Zerodha India"
            description="Live broker-backed holdings, P&L, and top concentration pockets from your latest synced India book."
            statusPills={[
              {
                label: "Connection",
                value: !dashboard.zerodhaStatus && (totalStatuses.zerodha.failed || totalStatuses.zerodha.pending)
                  ? "Unverified"
                  : dashboard.zerodhaStatus?.connected
                  ? "Connected"
                  : "Disconnected",
                tone: dashboard.zerodhaStatus?.connected ? "success" : "danger",
              },
              {
                label: "Snapshot",
                value: indiaSnapshot
                  ? formatSnapshotDate(indiaSnapshot.snapshot_date)
                  : snapshotAvailability(totalStatuses.zerodha),
                detail: indiaSnapshot
                  ? formatSnapshotTime(indiaSnapshot.captured_at)
                  : undefined,
                tone: indiaSnapshot ? indiaSnapshotTone : "danger",
              },
            ]}
            metrics={[
              {
                label: "Invested Amount",
                value: formatInr(zerodhaInvestedValue),
                detail: `Holdings value ${formatInr(indiaSnapshot?.holdings_market_value)}`,
              },
              {
                label: "Unrealized P&L",
                value: formatInr(indiaSnapshot?.holdings_pnl),
                tone:
                  (indiaSnapshot?.holdings_pnl ?? 0) >= 0
                    ? "positive"
                    : "negative",
              },
              {
                label: "Day Change",
                value: formatInr(indiaSnapshot?.holdings_day_change_value),
                tone:
                  (indiaSnapshot?.holdings_day_change_value ?? 0) >= 0
                    ? "positive"
                    : "negative",
              },
              {
                label: "Available Margin",
                value: formatInr(zerodhaAvailableMargin),
                detail: indiaSnapshot
                  ? `Captured ${formatTs(indiaSnapshot.captured_at)}`
                  : snapshotAvailability(totalStatuses.zerodha),
              },
            ]}
            topHoldings={buildIndiaTopHoldings(dashboard.zerodhaOverview)}
            portfolioHref={URLs.routes.console.zerodha()}
            threatsHref={URLs.routes.console.zerodhaThreats()}
            actionLinks={[
              {
                label: "Portfolio",
                href: URLs.routes.console.zerodha(),
                primary: true,
              },
              {
                label: "Threat Radar",
                href: URLs.routes.console.zerodhaThreats(),
              },
              {
                label: "Swing Trade",
                href: URLs.routes.console.zerodhaSwingTrade(),
              },
              { label: "Events", href: URLs.routes.console.zerodhaEvents() },
              {
                label: "Rebalance",
                href: URLs.routes.console.zerodhaRebalance(),
              },
              {
                label: "Final Actionables",
                href: URLs.routes.console.zerodhaFinalActionables(),
              },
            ]}
            emptyMessage={
              indiaSnapshot
                ? null
                : totalStatuses.zerodha.failed || totalStatuses.zerodha.pending || totalStatuses.zerodha.cachedAt !== undefined
                  ? snapshotAvailability(totalStatuses.zerodha)
                  : "Connect Zerodha and sync at least one snapshot to unlock India portfolio cards and threat prioritization here."
            }
          />
        )}

        {showUsPortfolioSkeleton ? (
          <DashboardMarketCardSkeleton label="Loading saved INDmoney US snapshot…" />
        ) : (
          <MarketPortfolioCard
            dataStatus={{
              ...totalStatuses.indmoney,
              source: `${totalStatuses.indmoney.source} · ${usdInrRate == null ? "USD · INR conversion unavailable" : `FX ${effectiveFx?.source ?? "unknown"}, ${formatDataAge(effectiveFx?.as_of)}`}`,
            }}
            market="us"
            title="INDmoney US"
            description="Manual US snapshot tracking, top allocations, and return posture for the INDmoney portfolio."
            statusPills={[
              {
                label: "Parse",
                value: usSnapshot?.parse_status ?? "Unverified",
                tone:
                  usSnapshot?.parse_status?.toLowerCase() === "parsed"
                    ? "success"
                    : "danger",
              },
              {
                label: "Snapshot",
                value: usSnapshot
                  ? formatSnapshotDate(usSnapshot.snapshot_date)
                  : snapshotAvailability(totalStatuses.indmoney),
                detail: usSnapshot
                  ? formatSnapshotTime(usSnapshot.captured_at)
                  : undefined,
                tone: usSnapshot ? usSnapshotTone : "danger",
              },
            ]}
            metrics={[
              {
                label: "Invested Amount",
                value: formatUsdValueAsInr(indmoneyInvestedValue, usdInrRate),
                detail: `Current value ${formatUsdValueAsInr(
                  usSnapshot?.current_value,
                  usdInrRate,
                )}`,
              },
              {
                label: "Total Return",
                value: formatUsdValueAsInr(
                  usSnapshot?.total_return_value,
                  usdInrRate,
                ),
                tone:
                  (usSnapshot?.total_return_value ?? 0) >= 0
                    ? "positive"
                    : "negative",
              },
              {
                label: "Day Return",
                value: formatUsdValueAsInr(
                  usSnapshot?.day_return_value,
                  usdInrRate,
                ),
                tone:
                  (usSnapshot?.day_return_value ?? 0) >= 0
                    ? "positive"
                    : "negative",
              },
              {
                label: "Available Funds",
                value: formatUsdValueAsInr(indmoneyAvailableFunds, usdInrRate),
                detail: usSnapshot
                  ? `Captured ${formatTs(usSnapshot.captured_at)}`
                  : snapshotAvailability(totalStatuses.indmoney),
              },
            ]}
            topHoldings={buildUsTopHoldings(
              dashboard.indmoneyOverview,
              usdInrRate,
            )}
            portfolioHref={URLs.routes.console.indmoneyUs()}
            threatsHref={URLs.routes.console.indmoneyUsThreats()}
            actionLinks={[
              {
                label: "Portfolio",
                href: URLs.routes.console.indmoneyUs(),
                primary: true,
              },
              {
                label: "Threat Radar",
                href: URLs.routes.console.indmoneyUsThreats(),
              },
              {
                label: "Swing Trade",
                href: URLs.routes.console.indmoneyUsSwingTrade(),
              },
              { label: "Events", href: URLs.routes.console.indmoneyUsEvents() },
              {
                label: "Rebalance",
                href: URLs.routes.console.indmoneyUsRebalance(),
              },
              {
                label: "Final Actionables",
                href: URLs.routes.console.indmoneyUsFinalActionables(),
              },
            ]}
            emptyMessage={
              usSnapshot
                ? null
                : totalStatuses.indmoney.failed || totalStatuses.indmoney.pending || totalStatuses.indmoney.cachedAt !== undefined
                  ? snapshotAvailability(totalStatuses.indmoney)
                  : "Paste an INDmoney US snapshot to surface allocations, return metrics, and threat signals on the dashboard."
            }
          />
        )}
      </section>

      <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
          Portfolio workflow
        </p>
        <h2 className="mt-2 text-xl font-semibold text-slate-950">
          Automated Rebalance
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
          Start and monitor the complete multi-stage workflow in its dedicated
          console. Its histories, editors, polling, and model output stay out
          of the dashboard runtime.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Button asChild className="rounded-full">
            <Link
              href={URLs.routes.console.automatedRebalance()}
              prefetch={false}
            >
              Open automated workflow
            </Link>
          </Button>
          <Button asChild variant="outline" className="rounded-full">
            <Link
              href={URLs.routes.console.autoRebalanceRuns("zerodha")}
              prefetch={false}
            >
              India run history
            </Link>
          </Button>
          <Button asChild variant="outline" className="rounded-full">
            <Link
              href={URLs.routes.console.autoRebalanceRuns("indmoneyUs")}
              prefetch={false}
            >
              US run history
            </Link>
          </Button>
        </div>
      </section>

      <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
          Detailed reports
        </p>
        <h2 className="mt-2 text-xl font-semibold text-slate-950">
          Final Actionables
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
          Full histories, model evidence, and action tables load only when you
          open the market-specific report.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Button asChild variant="outline" className="rounded-full">
            <Link
              href={URLs.routes.console.zerodhaFinalActionables()}
              prefetch={false}
            >
              India actionables
            </Link>
          </Button>
          <Button asChild variant="outline" className="rounded-full">
            <Link
              href={URLs.routes.console.indmoneyUsFinalActionables()}
              prefetch={false}
            >
              US actionables
            </Link>
          </Button>
        </div>
      </section>

      <LazyMount
        deferUntilScroll
        minHeight={360}
        fallback={
          <section className="grid gap-6 xl:grid-cols-2">
            <DashboardThreatCardSkeleton title="India Threat Pulse" deferred />
            <DashboardThreatCardSkeleton title="US Threat Pulse" deferred />
          </section>
        }
        onVisible={() => {
          void loadThreats();
        }}
      >
        <section className="grid gap-6 xl:grid-cols-2">
        {showIndiaThreatSkeleton ? (
          <DashboardThreatCardSkeleton title="India Threat Pulse" />
        ) : (
          <ThreatMarketCard
            market="india"
            title="India Threat Pulse"
            readPending={pendingSections.zerodhaThreat}
            readStatus={pendingSections.zerodhaThreat ? "Refreshing saved report…" : errorsBySection.zerodhaThreat ? "Saved report read failed. Displayed data has not been refreshed." : dashboard.zerodhaThreat?.report ? "Saved report loaded · See latest scan time below." : "No saved report available."}
            description="Summary of the most important downside signals, protection cues, and severity mix from the latest India threat scan."
            summaryPoints={getThreatSummaryPoints(dashboard.zerodhaThreat)}
            severityCounts={countThreatSeverities(
              dashboard.zerodhaThreat?.report?.tables,
            )}
            urgentActionCount={indiaUrgentRows.length}
            lastUpdated={formatTs(dashboard.zerodhaThreat?.updated_at)}
            href={URLs.routes.console.zerodhaThreats()}
            emptyMessage={
              dashboard.zerodhaThreat?.report
                ? null
                : errorsBySection.zerodhaThreat
                  ? "The saved report could not be loaded. Reopen the dashboard to retry the read."
                : indiaSnapshot
                  ? "Run a Zerodha threat scan to populate Table 10 actionables and the India severity pulse."
                  : "Threat insights will appear here after your first India portfolio sync."
            }
          />
        )}

        {showUsThreatSkeleton ? (
          <DashboardThreatCardSkeleton title="US Threat Pulse" />
        ) : (
          <ThreatMarketCard
            market="us"
            title="US Threat Pulse"
            readPending={pendingSections.indmoneyThreat}
            readStatus={pendingSections.indmoneyThreat ? "Refreshing saved report…" : errorsBySection.indmoneyThreat ? "Saved report read failed. Displayed data has not been refreshed." : dashboard.indmoneyThreat?.report ? "Saved report loaded · See latest scan time below." : "No saved report available."}
            description="Quick read on crowded winners, event risk, and capital-protection ideas from the latest INDmoney US threat radar."
            summaryPoints={getThreatSummaryPoints(dashboard.indmoneyThreat)}
            severityCounts={countThreatSeverities(
              dashboard.indmoneyThreat?.report?.tables,
            )}
            urgentActionCount={usUrgentRows.length}
            lastUpdated={formatTs(dashboard.indmoneyThreat?.updated_at)}
            href={URLs.routes.console.indmoneyUsThreats()}
            emptyMessage={
              dashboard.indmoneyThreat?.report
                ? null
                : errorsBySection.indmoneyThreat
                  ? "The saved report could not be loaded. Reopen the dashboard to retry the read."
                : usSnapshot
                  ? "Run the INDmoney US threat scan to surface Table 10 actionables on the dashboard."
                  : "Threat insights will appear here after your first INDmoney US snapshot."
            }
          />
        )}
        </section>
      </LazyMount>
    </div>
  );
}

export function DashboardPageClient({
  initialSummary = null,
}: {
  initialSummary?: DashboardSummaryResponse | null;
}) {
  const { user } = useAuth();
  return (
    <DashboardPageForUser
      key={user?.id ?? "no-authenticated-user"}
      userId={user?.id}
      initialSummary={initialSummary}
    />
  );
}
