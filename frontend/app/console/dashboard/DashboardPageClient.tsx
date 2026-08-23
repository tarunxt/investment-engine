"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import {
  AlertCircle,
  Clock,
  Eye,
  EyeOff,
  Info,
  Loader2,
  RefreshCw,
  Sparkles,
  Target,
} from "lucide-react";

import { Button } from "@/components/ui/button";
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
  DashboardHeroSkeleton,
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
  convertDashboardUsdTotalToInr,
  resolveBullpenPortfolioPlusCash,
} from "./_components/dashboardPortfolioTotals";
import {
  PortfolioCommandChart,
  type PortfolioCommandChartOption,
} from "./_components/PortfolioCommandChart";

const ThreatMarketCard = dynamic(
  () =>
    import("./_components/ThreatMarketCard").then(
      (module) => module.ThreatMarketCard,
    ),
  { ssr: false },
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

function logDashboardCacheFallback(
  key: DashboardSectionKey,
  reason: unknown,
) {
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
    .sort((left, right) => right.market_value - left.market_value)
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

function formatCommandTileUpdatedAt(value?: string | null) {
  if (!value) return "Not synced yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not synced yet";

  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
  const day = new Intl.DateTimeFormat("en-GB", { day: "2-digit" }).format(date);
  const month = new Intl.DateTimeFormat("en-GB", { month: "long" }).format(date);
  const year = new Intl.DateTimeFormat("en-GB", { year: "numeric" }).format(date);

  return `${time} | ${day} ${month}, ${year}`;
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
}: {
  totalValue: number | null;
  zerodhaValue: number;
  zerodhaPortfolioValue: number | null | undefined;
  zerodhaMargin: number;
  indmoneyValue: number;
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
  const formatPrivateInvestmentValue = (
    value: number | null | undefined,
    currency: "INR" | "USD" = "INR",
  ) => {
    const formattedValue =
      currency === "USD" ? formatUsd(value) : formatInr(value);
    return showInvestmentNumbers
      ? formattedValue
      : maskInvestmentValue(formattedValue);
  };
  const VisibilityIcon = showInvestmentNumbers ? EyeOff : Eye;
  const [infoDialog, setInfoDialog] = useState<CommandTileInfoKey | null>(null);

  const renderTile = ({
    keyName,
    title,
    value,
    portfolioValue,
    cashValue,
    cashLabel = "Cash",
    updatedAt,
    onRefresh,
    refreshingTile,
    currency = "INR",
  }: {
    keyName: CommandTileInfoKey;
    title: string;
    value: number | null | undefined;
    portfolioValue: number | null | undefined;
    cashValue: number | null | undefined;
    cashLabel?: string;
    updatedAt?: string | null;
    onRefresh: () => void;
    refreshingTile: boolean;
    currency?: "INR" | "USD";
  }) => {
    const formatter = (amount: number | null | undefined) =>
      formatPrivateInvestmentValue(amount, currency);

    return (
      <div className="relative rounded-[18px] border border-white/10 bg-white/8 px-4 py-4 text-slate-200">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-white">
            {title}
            <button
              type="button"
              onClick={() => setInfoDialog(keyName)}
              className="rounded-full text-slate-300 transition hover:text-white"
              aria-label={`${title} info`}
            >
              <Info className="size-3.5" />
            </button>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshingTile}
            className="rounded-full text-slate-300 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
            aria-label={`Refresh ${title}`}
          >
            <RefreshCw
              className={`size-3.5 ${refreshingTile ? "animate-spin" : ""}`}
            />
          </button>
        </div>
        <div className="mt-1 text-sm font-bold text-white">
          {formatter(value)}
        </div>
        <div className="mt-3 space-y-1 text-xs leading-5 text-slate-200">
          <div>Portfolio: {formatter(portfolioValue)}</div>
          <div>{cashLabel}: {formatter(cashValue)}</div>
        </div>
        <div className="mt-3 flex items-center gap-1.5 text-[10px] leading-4 text-slate-300">
          <Clock className="size-3" />
          <span>{formatCommandTileUpdatedAt(updatedAt)}</span>
        </div>
      </div>
    );
  };

  const info = infoDialog ? COMMAND_TILE_INFO[infoDialog] : null;

  return (
    <div className="rounded-[28px] border border-white/10 bg-white/8 p-5 shadow-2xl shadow-slate-950/15 backdrop-blur">
      <div className="flex flex-col gap-5">
        <div>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-300">
              <Target className="size-3.5" />
              Total Investments
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-pressed={showInvestmentNumbers}
              aria-label={
                showInvestmentNumbers
                  ? "Hide investment numbers"
                  : "Show investment numbers"
              }
              title={
                showInvestmentNumbers
                  ? "Hide investment numbers"
                  : "Show investment numbers"
              }
              onClick={() =>
                setShowInvestmentNumbers((currentValue) => !currentValue)
              }
              className="size-9 shrink-0 rounded-full border border-white/10 bg-white/8 text-slate-200 hover:bg-white/15 hover:text-white"
            >
              <VisibilityIcon className="size-4" />
            </Button>
          </div>
          <div className="mt-4 text-3xl font-bold tracking-tight text-white md:text-4xl">
            {totalValue == null
              ? "Combined INR unavailable"
              : formatPrivateInvestmentValue(totalValue)}
          </div>
          <div
            className={`mt-2 text-xs leading-5 ${
              fx?.status === "valid" ? "text-slate-300" : "text-amber-200"
            }`}
            data-fx-status={fx?.status ?? "unavailable"}
          >
            {fx?.status === "valid" && fx.source && fx.as_of
              ? `USD/INR ${fx.value?.toFixed(4)} from ${fx.source}, as of ${formatTs(fx.as_of)}`
              : fx?.status === "stale"
                ? `USD/INR is stale as of ${fx.as_of ? formatTs(fx.as_of) : "an unknown time"}; combined INR totals are omitted.`
                : "USD/INR is unavailable; combined INR totals are omitted and USD values remain in USD."}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {renderTile({
            keyName: "zerodha",
            title: "Zerodha",
            value: zerodhaValue,
            portfolioValue: zerodhaPortfolioValue,
            cashValue: zerodhaMargin,
            updatedAt: zerodhaUpdatedAt,
            onRefresh: onRefreshZerodha,
            refreshingTile: refreshingZerodha,
          })}
          {renderTile({
            keyName: "indmoney",
            title: "INDmoney",
            value: indmoneyValue,
            portfolioValue: indmoneyPortfolioValue,
            cashValue: indmoneyFundsValue,
            updatedAt: indmoneyUpdatedAt,
            onRefresh: onRefreshIndmoney,
            refreshingTile: refreshingIndmoney,
            currency: fx?.status === "valid" ? "INR" : "USD",
          })}
          {renderTile({
            keyName: "bullpen",
            title: "Bullpen",
            value: bullpenTotalValueInr,
            portfolioValue: bullpenAccountValueInr,
            cashValue: bullpenCashValueInr,
            updatedAt: bullpenUpdatedAt,
            onRefresh: onRefreshBullpen,
            refreshingTile: refreshingBullpen,
            currency: fx?.status === "valid" ? "INR" : "USD",
          })}
        </div>

        {info ? (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 px-4 backdrop-blur-sm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="command-tile-info-title"
            onClick={() => setInfoDialog(null)}
          >
            <div
              className="w-full max-w-sm rounded-[24px] border border-white/10 bg-slate-950 p-5 text-white shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <h2 id="command-tile-info-title" className="text-lg font-bold">
                {info.title}
              </h2>
              <p className="mt-3 text-sm leading-6 text-slate-300">
                {info.body}
              </p>
              <Button
                type="button"
                onClick={() => setInfoDialog(null)}
                className="mt-5 rounded-full bg-white text-slate-950 hover:bg-slate-200"
              >
                Close
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
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
          positionsSource: "last-successful-live-snapshot",
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
    {},
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
  }, [userId]);

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
  const zerodhaAvailableMargin = indiaSnapshot?.available_margin ?? 0;
  const zerodhaCommandValue =
    (indiaSnapshot?.holdings_market_value ?? 0) + zerodhaAvailableMargin;
  const usdInrRate = validDashboardFxRate(dashboard.fx);
  const effectiveFx =
    dashboard.fx?.status === "valid" && usdInrRate == null
      ? { ...dashboard.fx, status: "stale" as const }
      : dashboard.fx;
  const indmoneyInvestedValue = usSnapshot?.invested_value ?? 0;
  const indmoneyPortfolioValue =
    usSnapshot?.current_value == null
      ? undefined
      : usSnapshot.current_value * (usdInrRate ?? 1);
  const indmoneyAvailableFundsValue =
    usSnapshot?.wallet_balance == null
      ? undefined
      : usSnapshot.wallet_balance * (usdInrRate ?? 1);
  const indmoneyCommandValue =
    (indmoneyPortfolioValue ?? 0) + (indmoneyAvailableFundsValue ?? 0);
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
    usdInrRate == null
      ? null
      : bullpenTotalValue == null
        ? null
        : zerodhaCommandValue + indmoneyCommandValue + bullpenTotalValue;
  const indmoneyAvailableFunds = usSnapshot?.wallet_balance ?? 0;
  const portfolioCommandTrend = buildGenuineInrPortfolioTrend(
    dashboard.zerodhaOverview?.history ?? [],
  );
  const indmoneyCommandTrend =
    usdInrRate == null
      ? []
      : buildDashboardPortfolioTrend(
          (dashboard.indmoneyOverview?.history ?? []).map((snapshot) => ({
            capturedAt: snapshot.captured_at,
            portfolioValue: snapshot.current_value,
            cashValue: snapshot.wallet_balance,
          })),
          usdInrRate,
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
  const combinedChartCapturedAt =
    [indiaSnapshot?.captured_at, usSnapshot?.captured_at, bullpenUpdatedAt]
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
  const portfolioChartOptions: Record<
    "india" | "indmoney" | "bullpen" | "combined",
    PortfolioCommandChartOption
  > = {
    india: {
      label: "India portfolio value",
      currentValue: zerodhaCommandValue,
      trendPoints: portfolioCommandTrend,
      capturedAt: indiaSnapshot?.captured_at,
    },
    indmoney: {
      label: "IndMoney portfolio value",
      currentValue: usdInrRate == null ? null : indmoneyCommandValue,
      trendPoints: indmoneyCommandTrend,
      capturedAt: usSnapshot?.captured_at,
    },
    bullpen: {
      label: "Bullpen portfolio value",
      currentValue: usdInrRate == null ? null : (bullpenTotalValue ?? null),
      trendPoints: [],
      capturedAt: bullpenUpdatedAt,
    },
    combined: {
      label: "Combined portfolio value",
      currentValue: totalCommandValue,
      trendPoints: [],
      capturedAt: combinedChartCapturedAt,
    },
  };
  const refreshBullpenTile = useCallback(async (forceFresh = true) => {
    setRefreshingBullpenTile(true);
    try {
      const positions = await fetchBullpenPositions(forceFresh);
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
      <section
        className="rounded-3xl border border-indigo-100 bg-white p-6 shadow-sm"
        data-performance-usable="dashboard-portfolio-summary"
      >
        <p className="text-sm font-semibold uppercase tracking-[0.22em] text-indigo-600">
          Portfolio overview
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">
          Dashboard
        </h1>
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          {[
            {
              label: "India total (portfolio + cash)",
              value: formatInr(zerodhaCommandValue),
            },
            {
              label: "INDmoney total (portfolio + cash)",
              value:
                usdInrRate == null
                  ? "Unavailable"
                  : formatInr(indmoneyCommandValue),
            },
            {
              label: "Bullpen total (portfolio + cash)",
              value:
                usdInrRate == null || bullpenTotalValue == null
                  ? "Unavailable"
                  : formatInr(bullpenTotalValue),
            },
          ].map((metric) => (
            <div key={metric.label} className="rounded-2xl bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {metric.label}
              </p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {metric.value}
              </p>
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs text-slate-500">
          {usdInrRate != null && effectiveFx?.source && effectiveFx.as_of
            ? `USD/INR ${usdInrRate.toFixed(4)} from ${effectiveFx.source}; as of ${formatTs(effectiveFx.as_of)}.`
            : "USD/INR conversion unavailable or stale. INDmoney and Bullpen INR totals are omitted until a verified rate is available."}
        </p>
      </section>

      {dataProvenance ? (
        <div
          className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-xs leading-5 text-slate-600 shadow-sm"
          data-dashboard-data-source={dataProvenance.source}
        >
          <span className="font-semibold text-slate-900">
            {dataProvenance.source === "server-summary"
              ? "Server dashboard summary"
              : dataProvenance.source === "live-summary"
                ? "Live dashboard summary"
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
      {showHeroSkeleton ? (
        <DashboardHeroSkeleton />
      ) : (
        <section className="relative overflow-hidden rounded-[36px] border border-slate-200 bg-linear-to-br from-slate-950 via-slate-900 to-slate-800 text-white shadow-lg">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(245,158,11,0.22),_transparent_30%),radial-gradient(circle_at_bottom_right,_rgba(59,130,246,0.22),_transparent_35%)]" />

          <div className="relative px-6 py-7 lg:px-8">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/8 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-100">
                  <Sparkles className="size-3.5" />
                  Investments Control Room
                </div>
                <h1 className="mt-4 max-w-3xl font-serif text-3xl tracking-tight text-white md:text-4xl">
                  Portfolio Command Center
                </h1>
              </div>
              <div className="flex shrink-0 flex-wrap gap-3">
                <Button
                  onClick={() => {
                    window.dispatchEvent(
                      new Event(ZERODHA_DASHBOARD_SYNC_NOW_EVENT),
                    );
                    void Promise.allSettled([
                      loadDashboard(false),
                      refreshBullpenTile(true),
                    ]);
                  }}
                  disabled={refreshing}
                  className="rounded-full bg-amber-400 text-slate-950 hover:bg-amber-300"
                >
                  {refreshing ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-2 size-4" />
                  )}
                  Refresh Board
                </Button>
              </div>
            </div>

            <div className="mt-7 grid gap-6 xl:grid-cols-2 xl:items-stretch">
              <PortfolioCommandSummary
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

              <PortfolioCommandChart
                userId={userId}
                options={portfolioChartOptions}
              />
            </div>
          </div>
        </section>
      )}

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
          <DashboardMarketCardSkeleton />
        ) : (
          <MarketPortfolioCard
            market="india"
            title="Zerodha India"
            description="Live broker-backed holdings, P&L, and top concentration pockets from your latest synced India book."
            statusPills={[
              {
                label: "Connection",
                value: dashboard.zerodhaStatus?.connected
                  ? "Connected"
                  : "Disconnected",
                tone: dashboard.zerodhaStatus?.connected ? "success" : "danger",
              },
              {
                label: "Snapshot",
                value: indiaSnapshot
                  ? formatSnapshotDate(indiaSnapshot.snapshot_date)
                  : "Missing",
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
                  : "No synced snapshot yet",
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
                : "Connect Zerodha and sync at least one snapshot to unlock India portfolio cards and threat prioritization here."
            }
          />
        )}

        {showUsPortfolioSkeleton ? (
          <DashboardMarketCardSkeleton />
        ) : (
          <MarketPortfolioCard
            market="us"
            title="INDmoney US"
            description="Manual US snapshot tracking, top allocations, and return posture for the INDmoney portfolio."
            statusPills={[
              {
                label: "Parse",
                value: usSnapshot?.parse_status ?? "Missing",
                tone:
                  usSnapshot?.parse_status?.toLowerCase() === "parsed"
                    ? "success"
                    : "danger",
              },
              {
                label: "Snapshot",
                value: usSnapshot
                  ? formatSnapshotDate(usSnapshot.snapshot_date)
                  : "Missing",
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
                  : "No pasted snapshot yet",
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
            <DashboardThreatCardSkeleton />
            <DashboardThreatCardSkeleton />
          </section>
        }
        onVisible={() => {
          void loadThreats();
        }}
      >
        <section className="grid gap-6 xl:grid-cols-2">
        {showIndiaThreatSkeleton ? (
          <DashboardThreatCardSkeleton />
        ) : (
          <ThreatMarketCard
            market="india"
            title="India Threat Pulse"
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
                : indiaSnapshot
                  ? "Run a Zerodha threat scan to populate Table 10 actionables and the India severity pulse."
                  : "Threat insights will appear here after your first India portfolio sync."
            }
          />
        )}

        {showUsThreatSkeleton ? (
          <DashboardThreatCardSkeleton />
        ) : (
          <ThreatMarketCard
            market="us"
            title="US Threat Pulse"
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
