"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Eye,
  EyeOff,
  Loader2,
  RefreshCw,
  Sparkles,
  Target,
  Upload,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useUsdInrRate } from "@/hooks/useUsdInrRate";
import { URLs } from "@/lib/urls";
import { apiService } from "@/services/api";
import type {
  IndMoneyUsPortfolioOverviewResponse,
  IndMoneyUsPortfolioSnapshotSummary,
  IndMoneyUsThreatAnalysis,
  PolymarketBotState,
  ZerodhaPortfolioOverviewResponse,
  ZerodhaPortfolioSnapshotSummary,
  ZerodhaStatusResponse,
  ZerodhaThreatAnalysis,
} from "@/types/api";

import { DashboardFinalActionablesTables } from "@/app/console/_components/FinalActionablesConsole";
import {
  MarketPortfolioCard,
  type PortfolioCardTopHolding,
} from "./_components/MarketPortfolioCard";
import { ThreatMarketCard } from "./_components/ThreatMarketCard";
import {
  RebalanceWorkflowSections,
  ZERODHA_DASHBOARD_SYNC_NOW_EVENT,
} from "./_components/RebalanceWorkflowSections";
import {
  countThreatSeverities,
  extractUrgentActionRows,
  formatInr,
  formatPercent,
  formatSnapshotDate,
  formatSnapshotTime,
  formatTs,
  getThreatSummaryPoints,
  normalizeError,
  sortUrgentActionRows,
  toneClass,
} from "./_components/dashboardOverviewUtils";

type DashboardState = {
  zerodhaStatus: ZerodhaStatusResponse | null;
  zerodhaOverview: ZerodhaPortfolioOverviewResponse | null;
  zerodhaThreat: ZerodhaThreatAnalysis | null;
  indmoneyOverview: IndMoneyUsPortfolioOverviewResponse | null;
  indmoneyThreat: IndMoneyUsThreatAnalysis | null;
  polymarketState: PolymarketBotState | null;
};

const INITIAL_STATE: DashboardState = {
  zerodhaStatus: null,
  zerodhaOverview: null,
  zerodhaThreat: null,
  indmoneyOverview: null,
  indmoneyThreat: null,
  polymarketState: null,
};

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
  usdInrRate: number,
) {
  if (value == null) return formatInr(value);
  return formatInr(value * usdInrRate);
}

function maskInvestmentValue(value: string) {
  return value.replace(/\p{N}/gu, "*");
}

function PortfolioCommandSummary({
  totalValue,
  zerodhaValue,
  zerodhaPortfolioValue,
  zerodhaMargin,
  indmoneyValue,
  indmoneyPortfolioValue,
  indmoneyFundsValue,
  bullpenValueInr,
}: {
  totalValue: number;
  zerodhaValue: number;
  zerodhaPortfolioValue: number | null | undefined;
  zerodhaMargin: number;
  indmoneyValue: number;
  indmoneyPortfolioValue: number | null | undefined;
  indmoneyFundsValue: number | null | undefined;
  bullpenValueInr: number | null | undefined;
}) {
  const [showInvestmentNumbers, setShowInvestmentNumbers] = useState(false);
  const formatPrivateInvestmentValue = (value: number | null | undefined) => {
    const formattedValue = formatInr(value);
    return showInvestmentNumbers
      ? formattedValue
      : maskInvestmentValue(formattedValue);
  };
  const VisibilityIcon = showInvestmentNumbers ? EyeOff : Eye;

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
            {formatPrivateInvestmentValue(totalValue)}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <div className="rounded-[18px] border border-white/10 bg-white/8 px-4 py-4 text-slate-200">
            <div className="text-xs font-semibold text-white">Zerodha</div>
            <div className="mt-1 text-sm font-bold text-white">
              {formatPrivateInvestmentValue(zerodhaValue)}
            </div>
            <div className="mt-3 text-xs leading-5 text-slate-200">
              {formatPrivateInvestmentValue(zerodhaPortfolioValue)} portfolio +{" "}
              {formatPrivateInvestmentValue(zerodhaMargin)} margin
            </div>
          </div>

          <div className="rounded-[18px] border border-white/10 bg-white/8 px-4 py-4 text-slate-200">
            <div className="text-xs font-semibold text-white">INDmoney</div>
            <div className="mt-1 text-sm font-bold text-white">
              {formatPrivateInvestmentValue(indmoneyValue)}
            </div>
            <div className="mt-3 text-xs leading-5 text-slate-200">
              {formatPrivateInvestmentValue(indmoneyPortfolioValue)} total
              portfolio + {formatPrivateInvestmentValue(indmoneyFundsValue)}{" "}
              available funds
            </div>
          </div>

          <div className="rounded-[18px] border border-white/10 bg-white/8 px-4 py-4 text-slate-200">
            <div className="text-xs font-semibold text-white">Bullpen</div>
            <div className="mt-1 text-sm font-bold text-white">
              {formatPrivateInvestmentValue(bullpenValueInr)}
            </div>
            <div className="mt-3 text-xs leading-5 text-slate-200">
              {formatPrivateInvestmentValue(bullpenValueInr)} included in total investments
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

type PortfolioCommandRange = "1D" | "1W" | "1M" | "1Y" | "YTD" | "ALL";

type PortfolioCommandPoint = {
  timestamp: number;
  value: number;
};

const PORTFOLIO_COMMAND_RANGES: PortfolioCommandRange[] = [
  "1D",
  "1W",
  "1M",
  "1Y",
  "YTD",
  "ALL",
];

const PORTFOLIO_COMMAND_RANGE_LABELS: Record<PortfolioCommandRange, string> = {
  "1D": "Past Day",
  "1W": "Past Week",
  "1M": "Past Month",
  "1Y": "Past Year",
  YTD: "Year to Date",
  ALL: "All Time",
};

function getPortfolioCommandRangeStart(
  range: PortfolioCommandRange,
  endTimestamp: number,
) {
  const endDate = new Date(endTimestamp);

  if (range === "ALL") return null;
  if (range === "YTD") return Date.UTC(endDate.getUTCFullYear(), 0, 1);

  const startDate = new Date(endTimestamp);
  if (range === "1D") startDate.setUTCDate(startDate.getUTCDate() - 1);
  if (range === "1W") startDate.setUTCDate(startDate.getUTCDate() - 7);
  if (range === "1M") startDate.setUTCMonth(startDate.getUTCMonth() - 1);
  if (range === "1Y") startDate.setUTCFullYear(startDate.getUTCFullYear() - 1);
  return startDate.getTime();
}

function buildPortfolioCommandTrend(
  zerodhaHistory: ZerodhaPortfolioSnapshotSummary[],
  indmoneyHistory: IndMoneyUsPortfolioSnapshotSummary[],
  usdInrRate: number,
): PortfolioCommandPoint[] {
  const events = [
    ...zerodhaHistory.map((snapshot) => ({
      source: "india" as const,
      timestamp: Date.parse(snapshot.captured_at),
      value: Math.max(
        0,
        snapshot.holdings_market_value + snapshot.available_margin,
      ),
    })),
    ...indmoneyHistory.map((snapshot) => ({
      source: "us" as const,
      timestamp: Date.parse(snapshot.captured_at),
      value: Math.max(
        0,
        ((snapshot.current_value ?? 0) + (snapshot.wallet_balance ?? 0)) *
          usdInrRate,
      ),
    })),
  ]
    .filter(
      (event) =>
        Number.isFinite(event.timestamp) &&
        Number.isFinite(event.value) &&
        event.value > 0,
    )
    .sort((left, right) => left.timestamp - right.timestamp);

  let indiaValue = 0;
  let usValue = 0;

  const points = events
    .map((event) => {
      if (event.source === "india") {
        indiaValue = event.value;
      } else {
        usValue = event.value;
      }

      return {
        timestamp: event.timestamp,
        value: indiaValue + usValue,
      };
    })
    .filter((point) => point.value > 0);

  if (points.length >= 4) {
    return points;
  }

  const now = Date.now();
  const fallbackValues = [
    0.18, 0.16, 0.19, 0.21, 0.36, 0.58, 0.64, 0.46, 0.48, 0.38, 0.34, 0.42,
    0.49, 0.47, 0.32, 0.33, 0.35, 0.31, 0.72, 0.82, 0.75, 0.71,
  ];

  return fallbackValues.map((value, index) => ({
    timestamp: now - (fallbackValues.length - index - 1) * 60 * 60 * 1000,
    value,
  }));
}

function getVisiblePortfolioCommandPoints(
  points: PortfolioCommandPoint[],
  range: PortfolioCommandRange,
) {
  if (points.length <= 1) return points;

  const lastPoint = points[points.length - 1];
  const rangeStart = getPortfolioCommandRangeStart(range, lastPoint.timestamp);
  const visiblePoints =
    rangeStart == null
      ? points
      : points.filter((point) => point.timestamp >= rangeStart);

  if (visiblePoints.length >= 2) return visiblePoints;

  const fallbackPointCount: Record<PortfolioCommandRange, number> = {
    "1D": 8,
    "1W": 12,
    "1M": 16,
    "1Y": 20,
    YTD: 20,
    ALL: points.length,
  };

  return points.slice(-Math.min(points.length, fallbackPointCount[range]));
}

function buildCommandChartCoordinates(
  values: number[],
  width: number,
  height: number,
) {
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const valueRange = maxValue - minValue || 1;
  const xStep = width / (values.length - 1 || 1);

  return values.map((value, index) => ({
    x: index * xStep,
    y: height - ((value - minValue) / valueRange) * height,
  }));
}

function formatCommandChartTooltipDate(timestamp: number) {
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    timeZone: "Asia/Kolkata",
    year: "numeric",
  }).format(new Date(timestamp));
}

function PortfolioCommandChart({
  profitLossValue,
  dayChangeValue,
  trendPoints,
}: {
  profitLossValue: number;
  dayChangeValue: number;
  trendPoints: PortfolioCommandPoint[];
}) {
  const [selectedRange, setSelectedRange] =
    useState<PortfolioCommandRange>("ALL");
  const [hoveredPointIndex, setHoveredPointIndex] = useState<number | null>(
    null,
  );
  const chartWidth = 420;
  const chartHeight = 80;
  const visibleTrendPoints = useMemo(
    () => getVisiblePortfolioCommandPoints(trendPoints, selectedRange),
    [selectedRange, trendPoints],
  );
  const visibleTrendValues = visibleTrendPoints.map((point) => point.value);
  const chartCoordinates = buildCommandChartCoordinates(
    visibleTrendValues,
    chartWidth,
    chartHeight,
  );
  const linePath = chartCoordinates
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`,
    )
    .join(" ");
  const areaPath = `${linePath} L ${chartWidth} ${chartHeight} L 0 ${chartHeight} Z`;
  const isPositive = profitLossValue >= 0;
  const firstTrendValue = visibleTrendValues[0];
  const latestTrendValue = visibleTrendValues[visibleTrendValues.length - 1];
  const selectedRangeChangeValue =
    firstTrendValue != null && latestTrendValue != null
      ? latestTrendValue - firstTrendValue
      : dayChangeValue;
  const displayedRangeChangeValue =
    selectedRange === "1D" ? dayChangeValue : selectedRangeChangeValue;
  const displayedRangeLabel = PORTFOLIO_COMMAND_RANGE_LABELS[selectedRange];
  const hoveredPoint =
    hoveredPointIndex == null ? null : visibleTrendPoints[hoveredPointIndex];
  const hoveredCoordinates =
    hoveredPointIndex == null ? null : chartCoordinates[hoveredPointIndex];
  const hoveredPreviousValue =
    hoveredPointIndex == null
      ? null
      : visibleTrendValues[Math.max(0, hoveredPointIndex - 1)];
  const hoveredDayPnlValue =
    hoveredPoint == null || hoveredPreviousValue == null
      ? null
      : hoveredPoint.value - hoveredPreviousValue;

  const handleChartMouseMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const relativeX = Math.min(
      Math.max(event.clientX - bounds.left, 0),
      bounds.width,
    );
    const chartX = (relativeX / bounds.width) * chartWidth;
    const nearestPointIndex = chartCoordinates.reduce(
      (nearestIndex, point, index) =>
        Math.abs(point.x - chartX) <
        Math.abs(chartCoordinates[nearestIndex].x - chartX)
          ? index
          : nearestIndex,
      0,
    );

    setHoveredPointIndex(nearestPointIndex);
  };

  return (
    <div className="rounded-[30px] border border-white/15 bg-slate-950/70 p-4 shadow-2xl shadow-slate-950/20 backdrop-blur xl:min-w-[430px]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3 text-lg font-semibold text-slate-200">
            <span
              className={`h-4 w-5 rounded-full ${
                isPositive ? "bg-emerald-400" : "bg-rose-400"
              } [clip-path:polygon(50%_0%,100%_100%,0%_100%)]`}
              aria-hidden="true"
            />
            Profit/Loss
          </div>
          <div className="mt-5 flex items-center gap-4">
            <div className="text-4xl font-semibold tracking-tight text-white md:text-5xl">
              {formatInr(profitLossValue)}
            </div>
            <Upload className="size-6 text-slate-200" aria-hidden="true" />
          </div>
          <div
            className={`mt-3 text-base font-semibold ${
              displayedRangeChangeValue >= 0
                ? "text-emerald-300"
                : "text-rose-300"
            }`}
          >
            {formatInr(displayedRangeChangeValue)} {displayedRangeLabel}
          </div>
        </div>

        <div
          className="flex max-w-[17rem] flex-wrap items-center justify-end gap-1 text-sm font-semibold text-slate-400 sm:max-w-none"
          aria-label="Portfolio chart time range"
        >
          {PORTFOLIO_COMMAND_RANGES.map((range) => {
            const selected = range === selectedRange;

            return (
              <button
                key={range}
                type="button"
                aria-pressed={selected}
                onClick={() => setSelectedRange(range)}
                className={
                  selected
                    ? "rounded-2xl border border-white/60 bg-blue-500/35 px-2.5 py-2 text-white shadow-sm shadow-blue-950/30 transition hover:bg-blue-500/45 sm:px-3 sm:py-2.5"
                    : "rounded-2xl px-2 py-2 text-slate-300 transition hover:bg-white/10 hover:text-white sm:py-2.5"
                }
              >
                {range}
              </button>
            );
          })}
        </div>
      </div>

      <svg
        viewBox={`0 0 ${chartWidth} ${chartHeight}`}
        preserveAspectRatio="none"
        className="mt-4 h-20 w-full cursor-crosshair overflow-visible"
        role="img"
        aria-label={`${displayedRangeLabel} portfolio profit and loss trend`}
        onMouseMove={handleChartMouseMove}
        onMouseLeave={() => setHoveredPointIndex(null)}
      >
        <defs>
          <linearGradient id="commandChartLine" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="#a855f7" />
            <stop offset="55%" stopColor="#6366f1" />
            <stop offset="100%" stopColor="#0ea5e9" />
          </linearGradient>
          <linearGradient id="commandChartArea" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#2563eb" stopOpacity="0.34" />
            <stop offset="100%" stopColor="#1e293b" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={areaPath} fill="url(#commandChartArea)" />
        <path
          d={linePath}
          fill="none"
          stroke="url(#commandChartLine)"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="4"
        />
        {hoveredCoordinates && hoveredPoint && hoveredDayPnlValue != null ? (
          <g className="pointer-events-none">
            <line
              x1={hoveredCoordinates.x}
              x2={hoveredCoordinates.x}
              y1="0"
              y2={chartHeight}
              stroke="rgba(248,250,252,0.95)"
              strokeWidth="2"
            />
            <circle
              cx={hoveredCoordinates.x}
              cy={hoveredCoordinates.y}
              r="4"
              fill="#3b82f6"
              stroke="#bfdbfe"
              strokeWidth="1.5"
            />
            <foreignObject
              x={Math.min(
                Math.max(hoveredCoordinates.x - 92, 4),
                chartWidth - 188,
              )}
              y={
                hoveredCoordinates.y > 38
                  ? hoveredCoordinates.y - 48
                  : hoveredCoordinates.y + 14
              }
              width="184"
              height="44"
            >
              <div className="rounded-lg border border-white/30 bg-slate-950/95 px-3 py-2 text-xs font-semibold leading-tight text-white shadow-2xl shadow-black/40 backdrop-blur">
                <div
                  className={
                    hoveredDayPnlValue >= 0
                      ? "text-emerald-300"
                      : "text-rose-300"
                  }
                >
                  Day P/L {formatInr(hoveredDayPnlValue)}
                </div>
                <div className="mt-1 text-slate-200">
                  {formatCommandChartTooltipDate(hoveredPoint.timestamp)}
                </div>
              </div>
            </foreignObject>
          </g>
        ) : null}
      </svg>
    </div>
  );
}

function buildUsTopHoldings(
  overview: IndMoneyUsPortfolioOverviewResponse | null,
  usdInrRate: number,
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


function parseBullpenAccountValueUsd(message?: string | null) {
  if (!message) return 0;
  const match = message.match(/(-?\d[\d,]*(?:\.\d+)?)/);
  if (!match) return 0;
  return Number.parseFloat(match[1].replace(/,/g, "")) || 0;
}

export default function DashboardPage() {
  const [dashboard, setDashboard] = useState<DashboardState>(INITIAL_STATE);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const usdInrRate = useUsdInrRate();

  const loadDashboard = useCallback(async (initialLoad = false) => {
    if (initialLoad) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }

    const results = await Promise.allSettled([
      apiService.zerodhaStatus(),
      apiService.zerodhaPortfolioOverview(),
      apiService.zerodhaThreatsLatest(),
      apiService.indmoneyUsPortfolioOverview(),
      apiService.indmoneyUsThreatsLatest(),
      apiService.polymarketState(),
    ] as const);

    const nextErrors: string[] = [];

    setDashboard((current) => {
      const nextState = { ...current };

      if (results[0].status === "fulfilled") {
        nextState.zerodhaStatus = results[0].value;
      } else {
        nextErrors.push(
          `India connection status: ${normalizeError(results[0].reason)}`,
        );
      }

      if (results[1].status === "fulfilled") {
        nextState.zerodhaOverview = results[1].value;
      } else {
        nextErrors.push(
          `India portfolio: ${normalizeError(results[1].reason)}`,
        );
      }

      if (results[2].status === "fulfilled") {
        nextState.zerodhaThreat = results[2].value.analysis;
      } else {
        nextErrors.push(`India threats: ${normalizeError(results[2].reason)}`);
      }

      if (results[3].status === "fulfilled") {
        nextState.indmoneyOverview = results[3].value;
      } else {
        nextErrors.push(`US portfolio: ${normalizeError(results[3].reason)}`);
      }

      if (results[4].status === "fulfilled") {
        nextState.indmoneyThreat = results[4].value.analysis;
      } else {
        nextErrors.push(`US threats: ${normalizeError(results[4].reason)}`);
      }

      if (results[5].status === "fulfilled") {
        nextState.polymarketState = results[5].value;
      } else {
        nextErrors.push(`Bullpen account: ${normalizeError(results[5].reason)}`);
      }

      return nextState;
    });

    setErrors(nextErrors);
    if (initialLoad) {
      setLoading(false);
    } else {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadDashboard(true);
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [loadDashboard]);

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
  const zerodhaInvestedValue = (indiaSnapshot?.holdings ?? []).reduce(
    (sum, holding) => sum + (holding.invested_value || 0),
    0,
  );
  const zerodhaAvailableMargin = indiaSnapshot?.available_margin ?? 0;
  const zerodhaCommandValue =
    (indiaSnapshot?.holdings_market_value ?? 0) + zerodhaAvailableMargin;
  const indmoneyInvestedValue = usSnapshot?.invested_value ?? 0;
  const indmoneyPortfolioValueInr =
    usSnapshot?.current_value == null
      ? undefined
      : usSnapshot.current_value * usdInrRate;
  const indmoneyAvailableFundsValueInr =
    usSnapshot?.wallet_balance == null
      ? undefined
      : usSnapshot.wallet_balance * usdInrRate;
  const indmoneyCommandValue =
    (indmoneyPortfolioValueInr ?? 0) + (indmoneyAvailableFundsValueInr ?? 0);
  const bullpenAccountValueUsd =
    dashboard.polymarketState?.live.balance.account_value_usd ??
    parseBullpenAccountValueUsd(dashboard.polymarketState?.live.balance.message);
  const bullpenAccountValueInr = bullpenAccountValueUsd * usdInrRate;
  const totalCommandValue =
    zerodhaCommandValue + indmoneyCommandValue + bullpenAccountValueInr;
  const indmoneyAvailableFunds = usSnapshot?.wallet_balance ?? 0;
  const totalProfitLossValue =
    (indiaSnapshot?.holdings_pnl ?? 0) +
    (usSnapshot?.total_return_value == null
      ? 0
      : usSnapshot.total_return_value * usdInrRate);
  const totalDayChangeValue =
    (indiaSnapshot?.holdings_day_change_value ?? 0) +
    (usSnapshot?.day_return_value == null
      ? 0
      : usSnapshot.day_return_value * usdInrRate);
  const portfolioCommandTrend = buildPortfolioCommandTrend(
    dashboard.zerodhaOverview?.history ?? [],
    dashboard.indmoneyOverview?.history ?? [],
    usdInrRate,
  );
  if (
    loading &&
    !indiaSnapshot &&
    !usSnapshot &&
    !dashboard.zerodhaThreat &&
    !dashboard.indmoneyThreat
  ) {
    return (
      <div className="flex items-center gap-3 text-sm text-slate-500">
        <Loader2 className="size-4 animate-spin" />
        Loading investor dashboard...
      </div>
    );
  }

  return (
    <div className="mx-auto flex flex-col gap-6">
      <section className="relative overflow-hidden rounded-[36px] border border-slate-200 bg-linear-to-br from-slate-950 via-slate-900 to-slate-800 text-white shadow-lg">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(245,158,11,0.22),_transparent_30%),radial-gradient(circle_at_bottom_right,_rgba(59,130,246,0.22),_transparent_35%)]" />

        <div className="relative grid gap-6 px-6 py-7 lg:grid-cols-[minmax(0,1fr)_minmax(420px,0.85fr)] lg:items-center lg:px-8 2xl:grid-cols-[minmax(0,1fr)_minmax(420px,0.75fr)_minmax(430px,0.9fr)]">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/8 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-100">
              <Sparkles className="size-3.5" />
              Investments Control Room
            </div>
            <h1 className="mt-4 max-w-3xl font-serif text-3xl tracking-tight text-white md:text-4xl">
              Portfolio Command Center
            </h1>
            <div className="mt-5 flex flex-wrap gap-3">
              <Button
                onClick={() => {
                  window.dispatchEvent(
                    new Event(ZERODHA_DASHBOARD_SYNC_NOW_EVENT),
                  );
                  void loadDashboard(false);
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

          <PortfolioCommandSummary
            totalValue={totalCommandValue}
            zerodhaValue={zerodhaCommandValue}
            zerodhaPortfolioValue={indiaSnapshot?.holdings_market_value}
            zerodhaMargin={zerodhaAvailableMargin}
            indmoneyValue={indmoneyCommandValue}
            indmoneyPortfolioValue={indmoneyPortfolioValueInr}
            indmoneyFundsValue={indmoneyAvailableFundsValueInr}
            bullpenValueInr={bullpenAccountValueInr}
          />

          <PortfolioCommandChart
            profitLossValue={totalProfitLossValue}
            dayChangeValue={totalDayChangeValue}
            trendPoints={portfolioCommandTrend}
          />
        </div>
      </section>

      {errors.length > 0 ? (
        <div className="flex items-start gap-3 rounded-[24px] border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>
            Some dashboard modules could not be refreshed: {errors.join(" | ")}
          </span>
        </div>
      ) : null}

      <RebalanceWorkflowSections
        onDashboardRefresh={() => loadDashboard(false)}
      />

      <section className="grid gap-6 xl:grid-cols-2">
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
      </section>

      <DashboardFinalActionablesTables />

      <section className="grid gap-6 xl:grid-cols-2">
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
      </section>
    </div>
  );
}
