"use client";

import { useEffect, useMemo, useState } from "react";
import { Upload } from "lucide-react";

import {
  MIN_GENUINE_PORTFOLIO_POINTS,
  filterGenuinePortfolioTrend,
  type GenuinePortfolioPoint,
  type PortfolioHistoryRange,
} from "@/lib/portfolioHistory";

import { formatInr } from "./dashboardOverviewUtils";

export type PortfolioCommandChartKey =
  | "india"
  | "indmoney"
  | "bullpen"
  | "combined";

export type PortfolioCommandChartOption = {
  label: string;
  currentValue: number | null;
  trendPoints: GenuinePortfolioPoint[];
  capturedAt?: string | null;
};

const PORTFOLIO_COMMAND_CHART_KEYS: PortfolioCommandChartKey[] = [
  "india",
  "indmoney",
  "bullpen",
  "combined",
];
const PORTFOLIO_COMMAND_RANGES: PortfolioHistoryRange[] = [
  "1D",
  "1W",
  "1M",
  "1Y",
  "YTD",
  "ALL",
];
const PORTFOLIO_COMMAND_RANGE_LABELS: Record<PortfolioHistoryRange, string> = {
  "1D": "Past Day",
  "1W": "Past Week",
  "1M": "Past Month",
  "1Y": "Past Year",
  YTD: "Year to Date",
  ALL: "All Time",
};
const CHART_PREFERENCE_KEY_PREFIX =
  "investment-engine:dashboard-command-chart:v1:user:";
const CHART_HISTORY_KEY_PREFIX =
  "investment-engine:dashboard-command-chart-history:v1:user:";
const MAX_LOCAL_HISTORY_POINTS = 500;

type LocalChartHistory = Record<
  PortfolioCommandChartKey,
  GenuinePortfolioPoint[]
>;

function emptyLocalHistory(): LocalChartHistory {
  return {
    india: [],
    indmoney: [],
    bullpen: [],
    combined: [],
  };
}

function chartPreferenceKey(userId: number | null | undefined) {
  return `${CHART_PREFERENCE_KEY_PREFIX}${userId ?? "anonymous"}`;
}

function chartHistoryKey(userId: number | null | undefined) {
  return `${CHART_HISTORY_KEY_PREFIX}${userId ?? "anonymous"}`;
}

function isChartKey(value: string | null): value is PortfolioCommandChartKey {
  return PORTFOLIO_COMMAND_CHART_KEYS.includes(
    value as PortfolioCommandChartKey,
  );
}

function readChartPreference(userId: number | null | undefined) {
  if (typeof window === "undefined") return "india" as const;
  try {
    const stored = window.localStorage.getItem(chartPreferenceKey(userId));
    return isChartKey(stored) ? stored : ("india" as const);
  } catch {
    return "india" as const;
  }
}

function readLocalChartHistory(
  userId: number | null | undefined,
): LocalChartHistory {
  if (typeof window === "undefined") return emptyLocalHistory();
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(chartHistoryKey(userId)) ?? "{}",
    ) as Partial<LocalChartHistory>;
    const result = emptyLocalHistory();
    for (const key of PORTFOLIO_COMMAND_CHART_KEYS) {
      result[key] = (Array.isArray(parsed[key]) ? parsed[key] : [])
        .filter(
          (point) =>
            Number.isFinite(point?.timestamp) &&
            Number.isFinite(point?.value) &&
            point.value >= 0,
        )
        .sort((left, right) => left.timestamp - right.timestamp)
        .slice(-MAX_LOCAL_HISTORY_POINTS);
    }
    return result;
  } catch {
    return emptyLocalHistory();
  }
}

function upsertLocalPoint(
  points: GenuinePortfolioPoint[],
  point: GenuinePortfolioPoint,
) {
  const existingIndex = points.findIndex(
    (existing) => existing.timestamp === point.timestamp,
  );
  if (existingIndex >= 0) {
    if (points[existingIndex].value === point.value) return points;
    const next = [...points];
    next[existingIndex] = point;
    return next.sort((left, right) => left.timestamp - right.timestamp);
  }
  return [...points, point]
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-MAX_LOCAL_HISTORY_POINTS);
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

function ChartSelector({
  options,
  selectedChart,
  onChange,
}: {
  options: Record<PortfolioCommandChartKey, PortfolioCommandChartOption>;
  selectedChart: PortfolioCommandChartKey;
  onChange: (value: PortfolioCommandChartKey) => void;
}) {
  return (
    <label className="block">
      <span className="sr-only">Choose portfolio chart</span>
      <select
        aria-label="Choose portfolio chart"
        value={selectedChart}
        onChange={(event) =>
          onChange(event.target.value as PortfolioCommandChartKey)
        }
        className="max-w-full rounded-xl border border-white/20 bg-slate-900 px-3 py-2 text-sm font-semibold text-slate-100 outline-none transition hover:border-white/40 focus:border-blue-300 focus:ring-2 focus:ring-blue-400/30"
      >
        {PORTFOLIO_COMMAND_CHART_KEYS.map((key) => (
          <option key={key} value={key}>
            {options[key].label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function PortfolioCommandChart({
  userId,
  options,
}: {
  userId: number | null | undefined;
  options: Record<PortfolioCommandChartKey, PortfolioCommandChartOption>;
}) {
  const [selectedChart, setSelectedChart] =
    useState<PortfolioCommandChartKey>(() => readChartPreference(userId));
  const [selectedRange, setSelectedRange] =
    useState<PortfolioHistoryRange>("ALL");
  const [hoveredPointIndex, setHoveredPointIndex] = useState<number | null>(
    null,
  );
  const [localHistory, setLocalHistory] = useState<LocalChartHistory>(() =>
    readLocalChartHistory(userId),
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(
        chartPreferenceKey(userId),
        selectedChart,
      );
    } catch {
      // The in-memory selection still works when browser storage is blocked.
    }
  }, [selectedChart, userId]);

  useEffect(() => {
    setLocalHistory((current) => {
      let changed = false;
      const next: LocalChartHistory = { ...current };
      for (const key of PORTFOLIO_COMMAND_CHART_KEYS) {
        const option = options[key];
        const timestamp = option.capturedAt
          ? Date.parse(option.capturedAt)
          : Number.NaN;
        if (
          option.currentValue == null ||
          !Number.isFinite(option.currentValue) ||
          option.currentValue < 0 ||
          !Number.isFinite(timestamp)
        ) {
          continue;
        }
        const updated = upsertLocalPoint(current[key], {
          timestamp,
          value: option.currentValue,
        });
        if (updated !== current[key]) {
          next[key] = updated;
          changed = true;
        }
      }
      if (!changed) return current;
      try {
        window.localStorage.setItem(
          chartHistoryKey(userId),
          JSON.stringify(next),
        );
      } catch {
        // Keep the current-session history even if persistence is unavailable.
      }
      return next;
    });
  }, [options, userId]);

  const selectedOption = options[selectedChart];
  const trendPoints =
    selectedOption.trendPoints.length >= MIN_GENUINE_PORTFOLIO_POINTS
      ? selectedOption.trendPoints
      : localHistory[selectedChart];
  const visibleTrendPoints = useMemo(
    () => filterGenuinePortfolioTrend(trendPoints, selectedRange),
    [selectedRange, trendPoints],
  );
  const displayedRangeLabel = PORTFOLIO_COMMAND_RANGE_LABELS[selectedRange];
  const chartWidth = 420;
  const chartHeight = 80;

  const selector = (
    <ChartSelector
      options={options}
      selectedChart={selectedChart}
      onChange={(value) => {
        setSelectedChart(value);
        setHoveredPointIndex(null);
      }}
    />
  );

  if (visibleTrendPoints.length < MIN_GENUINE_PORTFOLIO_POINTS) {
    return (
      <div className="rounded-[30px] border border-white/15 bg-slate-950/70 p-4 shadow-2xl shadow-slate-950/20 backdrop-blur xl:min-w-[430px]">
        {selector}
        <div className="mt-5 text-4xl font-semibold tracking-tight text-white md:text-5xl">
          {formatInr(selectedOption.currentValue)}
        </div>
        <div className="mt-2 text-xs uppercase tracking-[0.16em] text-slate-400">
          Current portfolio + cash
        </div>
        <div
          className="mt-5 rounded-2xl border border-white/10 bg-white/5 px-4 py-5 text-sm leading-6 text-slate-300"
          data-portfolio-history-state="insufficient"
        >
          Insufficient genuine snapshot history for {displayedRangeLabel}. The
          chart appears after at least {MIN_GENUINE_PORTFOLIO_POINTS} verified
          snapshots are available.
        </div>
      </div>
    );
  }

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
  const firstTrendValue = visibleTrendValues[0];
  const latestTrendValue = visibleTrendValues[visibleTrendValues.length - 1];
  const selectedRangeChangeValue = latestTrendValue - firstTrendValue;
  const hoveredPoint =
    hoveredPointIndex == null ? null : visibleTrendPoints[hoveredPointIndex];
  const hoveredCoordinates =
    hoveredPointIndex == null ? null : chartCoordinates[hoveredPointIndex];
  const hoveredPreviousValue =
    hoveredPointIndex == null
      ? null
      : visibleTrendValues[Math.max(0, hoveredPointIndex - 1)];
  const hoveredSnapshotChange =
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
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          {selector}
          <div className="mt-5 flex items-center gap-4">
            <div className="text-4xl font-semibold tracking-tight text-white md:text-5xl">
              {formatInr(selectedOption.currentValue ?? latestTrendValue)}
            </div>
            <Upload className="size-6 text-slate-200" aria-hidden="true" />
          </div>
          <div
            className={`mt-3 text-base font-semibold ${
              selectedRangeChangeValue >= 0
                ? "text-emerald-300"
                : "text-rose-300"
            }`}
          >
            {formatInr(selectedRangeChangeValue)} {displayedRangeLabel}
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
        aria-label={`${displayedRangeLabel} genuine ${selectedOption.label} history`}
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
        {hoveredCoordinates && hoveredPoint && hoveredSnapshotChange != null ? (
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
                    hoveredSnapshotChange >= 0
                      ? "text-emerald-300"
                      : "text-rose-300"
                  }
                >
                  Snapshot change {formatInr(hoveredSnapshotChange)}
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
