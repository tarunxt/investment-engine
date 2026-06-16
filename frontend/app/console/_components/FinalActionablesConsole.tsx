"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type MouseEvent, type ReactNode } from "react";
import Link from "next/link";
import { ArrowDown, ArrowLeft, ArrowUp, ChevronDown, ChevronRight, ChevronUp, FileSpreadsheet, FunctionSquare, Info, RefreshCw, Triangle, X } from "lucide-react";

import {
  parseInvestmentRecommendationContent,
  REBALANCE_HEADER_ORDER,
  type CanonicalRow,
  type RebalanceHeader,
} from "@/components/InvestmentRecommendationTable";
import { EventScanRunControls } from "@/components/shared/EventScanRunControls";
import { ScanHistoryButton } from "@/components/shared/ScanHistoryButton";
import { PortfolioAnalysisNav } from "@/components/shared/PortfolioAnalysisNav";
import { TradingViewSymbolLink } from "@/components/shared/TradingViewSymbolLink";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  inferRebalanceMarketFromPrompt,
  type RebalancePortfolioKey,
} from "@/lib/rebalance";
import type { SwingTradeMarket } from "@/lib/swingTrade";
import {
  BULLISH_SETUPS,
  BEARISH_SETUPS,
  technicalSetupDomId,
  type SetupRow,
} from "@/lib/technicalSetups";
import { STANDARD_ACTION_ORDER, getStandardActionBadgeClass } from "@/lib/actionColorScheme";
import { getAutoRebalanceRunDisplayLabel } from "@/lib/runPresentation";
import { URLs } from "@/lib/urls";
import { cn } from "@/lib/utils";
import { useUsdInrRate } from "@/hooks/useUsdInrRate";
import { apiService } from "@/services/api";
import type {
  IndMoneyUsEventsAnalysis,
  IndMoneyUsPortfolioSnapshotDetail,
  IndMoneyUsThreatAnalysis,
  PortfolioAnalysisHistoryItem,
  ProviderModelTarget,
  RunResponse,
  ZerodhaEventsAnalysis,
  ZerodhaPortfolioSnapshotDetail,
  ZerodhaThreatAnalysis,
} from "@/types/api";

export type ActionCategory = "Sell All" | "Trim" | "Hold" | "Add more" | "Buy New";

type LlmMeta = {
  runId: number;
  jobId: number;
  runLabel: string;
  provider: string;
  model: string;
  createdAt: string;
  status: string;
  error?: string | null;
};

type LlmBreakupRow = {
  cells: CanonicalRow;
  meta: LlmMeta;
};

type ActionablesInputSelectionKind = "rebalance" | "technical";

type ActionablesInputCandidate = {
  id: string;
  kind: ActionablesInputSelectionKind;
  label: string;
  jobNo: string;
  timestamp: string | null;
  status: string;
  costUsd: number | null;
  error: string | null;
  runId: number;
  jobId: number;
  runLabel: string;
  market: SwingTradeMarket;
};

type ConsensusBreakupEntry = {
  meta: LlmMeta;
  row: LlmBreakupRow | null;
};

function getInputMarketLabel(market?: SwingTradeMarket) {
  if (market === "india") return "India";
  if (market === "us") return "US";
  return "Market unknown";
}

function getInputMarketBadgeClass(market?: SwingTradeMarket) {
  if (market === "india") return "border-orange-200 bg-orange-50 text-orange-800";
  if (market === "us") return "border-indigo-200 bg-indigo-50 text-indigo-800";
  return "border-slate-200 bg-slate-50 text-slate-600";
}

export type ActionEstimate = {
  currentUnits: number | null;
  currentInvestmentAmount: number | null;
  units: number | null;
  amount: number | null;
};

type CurrentValueSnapshot = {
  units: number | null;
  currentValue: number | null;
};

type CurrentValueSnapshotMap = Map<string, CurrentValueSnapshot>;

type ScoreMatrixEntry = {
  id: string;
  source: string;
  action: ActionCategory | null;
  actionScore: number | null;
  unitsChange: number | null;
  note: string;
  isSummary?: boolean;
  isCalculated?: boolean;
};

type ScoreMatrixRuleEvaluation = {
  id: string;
  label: string;
  when: string;
  action: ActionCategory;
  unitsStrategy: string;
  summary: string;
  matched: boolean;
};

type DetailedRationaleScoreRow = {
  id: string;
  parameter: string;
  score: number | null;
  multiplier: number;
  denominatorWeight?: number;
  missingReason?: string;
};

type TechnicalScanMultiplierKey = "bullish" | "bearish";

type ScoreMatrixFormulaConfig = {
  detailedRationaleMultipliers: Record<string, number>;
  detailedRationaleDenominator: number | null;
  actionScores: Record<ActionCategory, number>;
  technicalScanMultipliers: Record<TechnicalScanMultiplierKey, number>;
};

export type ActionablesCalculationFocusTarget = {
  stockKey: string;
  header: ActionablesCalculationHeader;
};

type ActionablesCalculationRowGroup = {
  stockKey: string;
  stock: StockConsensus;
  stockInfo: ReactNode;
  sortValues: Record<string, string | number>;
  rows: ActionablesCalculationRow[];
};

type ScoreMatrixContext = {
  currentUnits: number | null;
  meanScore: number | null;
  meanUnitsChange: number | null;
  calculatedScore: number | null;
  modeAction: ActionCategory | null;
  bullishVotes: number;
  bearishVotes: number;
  holdVotes: number;
  totalVotes: number;
  bullishMeanUnits: number | null;
  bearishMeanUnits: number | null;
};

export type ScoreMatrixDetail = {
  stockKey: string;
  stockSymbol: string;
  stockName: string;
  stockExchange: string;
  currentUnits: number | null;
  modeAction: ActionCategory | null;
  meanScore: number | null;
  meanUnitsChange: number | null;
  calculatedScore: number | null;
  meanModeAction: ActionCategory | null;
  meanModeUnitsChange: number | null;
  calculatedAction: ActionCategory;
  calculatedUnitsChange: number | null;
  matchedRuleId: string;
  rows: ScoreMatrixEntry[];
  rules: ScoreMatrixRuleEvaluation[];
  detailedRationaleRows: DetailedRationaleScoreRow[];
  detailedRationaleFinalScore: number | null;
  detailedRationaleDenominator: number;
  rebalanceSourceLabel: string | null;
  rebalanceSourceRunId: number | null;
  technicalScanSourceLabel: string | null;
  technicalScanSourceRunId: number | null;
};

export type SetupStockDetail = {
  key: string;
  name: string;
  symbol: string;
  exchange: string;
  market: SwingTradeMarket;
  currentUnits: string;
  currentValue: string;
  action: ActionCategory;
};

export type SetupStockGroup = {
  setup: string;
  stocks: SetupStockDetail[];
};

const SETUP_STOCK_ACTION_PRIORITY: Record<ActionCategory, number> = STANDARD_ACTION_ORDER.reduce((acc, action, index) => {
  acc[action] = index;
  return acc;
}, {} as Record<ActionCategory, number>);

const SETUP_STOCK_ACTION_CLASSES: Record<
  ActionCategory,
  { row: string; nameCell: string; cell: string }
> = {
  "Sell All": {
    row: "bg-red-50/90",
    nameCell: "text-red-950",
    cell: "text-red-900",
  },
  Trim: {
    row: "bg-red-50/70",
    nameCell: "text-red-900",
    cell: "text-red-700",
  },
  "Add more": {
    row: "bg-emerald-100/70",
    nameCell: "text-emerald-950",
    cell: "text-emerald-900",
  },
  "Buy New": {
    row: "bg-emerald-50/70",
    nameCell: "text-emerald-900",
    cell: "text-emerald-800",
  },
  Hold: {
    row: "bg-yellow-50/80",
    nameCell: "text-yellow-950",
    cell: "text-yellow-800",
  },
};

export function compareSetupStocksByAction(a: SetupStockDetail, b: SetupStockDetail) {
  const actionComparison =
    SETUP_STOCK_ACTION_PRIORITY[a.action] - SETUP_STOCK_ACTION_PRIORITY[b.action];
  if (actionComparison !== 0) return actionComparison;

  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

export function getSetupStockActionClasses(action: ActionCategory) {
  return SETUP_STOCK_ACTION_CLASSES[action];
}

export type StockConsensus = {
  key: string;
  exchange: string;
  symbol: string;
  consensusAction: ActionCategory;
  actionCounts: Record<ActionCategory, number>;
  actionAverages: Record<ActionCategory, ActionEstimate>;
  totalSuggestions: number;
  representative: CanonicalRow;
  rows: LlmBreakupRow[];
  breakupEntries: ConsensusBreakupEntry[];
};

export type TechnicalScanResult = {
  stockSymbol: string;
  exchangeSymbol: string;
  primarySetup: string;
  secondarySetups: string;
  confidenceScore: string;
  bias: "bullish" | "bearish" | "neutral";
  premarketTrend: string;
  last5CandlesTrend: string;
  triggerLevel: string;
  invalidationLevel: string;
  runId: number;
  jobId: number;
  provider: string;
  model: string;
  createdAt: string;
  runLabel: string;
};

export type TechnicalScanMap = Record<string, TechnicalScanResult>;

export type StockDetailsData = {
  portfolioSnapshot: ZerodhaPortfolioSnapshotDetail | IndMoneyUsPortfolioSnapshotDetail | null;
  eventsAnalysis: ZerodhaEventsAnalysis | IndMoneyUsEventsAnalysis | null;
  threatsAnalysis: ZerodhaThreatAnalysis | IndMoneyUsThreatAnalysis | null;
  error: string | null;
};

const TECHNICAL_SCAN_MARKER = "## Technical Scan Input Bundle";
const TECHNICAL_SCAN_TABLE_COLUMNS = [
  "Exchange Symbol",
  "Stock Symbol",
  "Primary Setup",
  "Secondary Setups",
  "Bias",
  "Premarket trend",
  "Last 5 candles trend",
  "Confidence Score",
  "Trigger Level",
  "Invalidation Level",
] as const;
const TECHNICAL_SCAN_ACTIVE_STATUSES = new Set([
  "pending",
  "processing",
  "scheduled",
]);
const TECHNICAL_SCAN_POLL_INTERVAL_MS = 5000;


const FINAL_ACTIONABLES_RUN_CACHE_VERSION = 1;
const DASHBOARD_FINAL_ACTIONABLES_CACHE_VERSION = 1;
const DASHBOARD_FINAL_ACTIONABLES_CACHE_KEY = `investor:dashboard:final-actionables:v${DASHBOARD_FINAL_ACTIONABLES_CACHE_VERSION}`;

type CachedFinalActionablesRuns = {
  version: number;
  cachedAt: number;
  runs: RunResponse[];
};

type CachedDashboardFinalActionables = {
  version: number;
  cachedAt: number;
  runs: RunResponse[];
  portfolioSnapshots: {
    india: ZerodhaPortfolioSnapshotDetail | null;
    us: IndMoneyUsPortfolioSnapshotDetail | null;
  };
};

function buildFinalActionablesCacheKey(portfolio: RebalancePortfolioKey, market: SwingTradeMarket) {
  return `investor:final-actionables:runs:${portfolio}:${market}:v${FINAL_ACTIONABLES_RUN_CACHE_VERSION}`;
}

function readFinalActionablesRunCache(cacheKey: string) {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(cacheKey);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<CachedFinalActionablesRuns>;
    if (parsed.version !== FINAL_ACTIONABLES_RUN_CACHE_VERSION || !Array.isArray(parsed.runs)) {
      return null;
    }

    return parsed.runs;
  } catch (error) {
    console.warn("Failed to restore cached final actionables runs:", error);
    return null;
  }
}

function writeFinalActionablesRunCache(cacheKey: string, runs: RunResponse[]) {
  if (typeof window === "undefined") return;

  try {
    const payload: CachedFinalActionablesRuns = {
      version: FINAL_ACTIONABLES_RUN_CACHE_VERSION,
      cachedAt: Date.now(),
      runs,
    };
    window.localStorage.setItem(cacheKey, JSON.stringify(payload));
  } catch (error) {
    console.warn("Failed to cache final actionables runs:", error);
  }
}

function selectCacheableFinalActionablesRuns(runs: RunResponse[], market: SwingTradeMarket) {
  const marketRuns = runs
    .filter((run) => isCompletedRebalanceRun(run, market))
    .sort((a, b) => parseTimestampMs(b.created_at) - parseTimestampMs(a.created_at));
  const latestRun = marketRuns[0];
  const latestFingerprint = latestRun ? extractRebalanceInputFingerprint(latestRun.prompt) : null;
  const cacheableRuns = new Map<number, RunResponse>();

  if (latestFingerprint) {
    marketRuns
      .filter((run) => extractRebalanceInputFingerprint(run.prompt) === latestFingerprint)
      .forEach((run) => cacheableRuns.set(run.id, run));
  }

  runs
    .filter((run) => run.prompt?.includes(TECHNICAL_SCAN_MARKER))
    .forEach((run) => cacheableRuns.set(run.id, run));

  return Array.from(cacheableRuns.values()).sort((a, b) => b.id - a.id);
}

function cacheFinalActionablesRuns(cacheKey: string, runs: RunResponse[], market: SwingTradeMarket) {
  writeFinalActionablesRunCache(cacheKey, selectCacheableFinalActionablesRuns(runs, market));
}


function readDashboardFinalActionablesCache() {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(DASHBOARD_FINAL_ACTIONABLES_CACHE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<CachedDashboardFinalActionables>;
    if (parsed.version !== DASHBOARD_FINAL_ACTIONABLES_CACHE_VERSION || !Array.isArray(parsed.runs) || !parsed.portfolioSnapshots) {
      return null;
    }

    return {
      runs: parsed.runs,
      portfolioSnapshots: {
        india: parsed.portfolioSnapshots.india ?? null,
        us: parsed.portfolioSnapshots.us ?? null,
      },
    };
  } catch (error) {
    console.warn("Failed to restore cached dashboard final actionables:", error);
    return null;
  }
}

function writeDashboardFinalActionablesCache(
  runs: RunResponse[],
  portfolioSnapshots: CachedDashboardFinalActionables["portfolioSnapshots"],
) {
  if (typeof window === "undefined") return;

  try {
    const cacheableRuns = new Map<number, RunResponse>();
    selectCacheableFinalActionablesRuns(runs, "india").forEach((run) => cacheableRuns.set(run.id, run));
    selectCacheableFinalActionablesRuns(runs, "us").forEach((run) => cacheableRuns.set(run.id, run));

    const payload: CachedDashboardFinalActionables = {
      version: DASHBOARD_FINAL_ACTIONABLES_CACHE_VERSION,
      cachedAt: Date.now(),
      runs: Array.from(cacheableRuns.values()).sort((a, b) => b.id - a.id),
      portfolioSnapshots,
    };
    window.localStorage.setItem(DASHBOARD_FINAL_ACTIONABLES_CACHE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn("Failed to cache dashboard final actionables:", error);
  }
}

function getTechnicalSetupsHref(setup?: string | null) {
  const baseHref = URLs.routes.console.technicalSetups();
  const normalizedSetup = normalizeEmptyTechnicalValue(setup);
  if (!normalizedSetup) return baseHref;

  return `${baseHref}?setup=${encodeURIComponent(normalizedSetup)}#${technicalSetupDomId(normalizedSetup)}`;
}

function stopRowToggle(event: MouseEvent<HTMLAnchorElement>) {
  event.stopPropagation();
}

function TechnicalSetupsHeaderLink({ children }: { children: ReactNode }) {
  return (
    <Link
      href={URLs.routes.console.technicalSetups()}
      className="underline-offset-4 transition hover:text-blue-700 hover:underline"
      onClick={stopRowToggle}
    >
      {children}
    </Link>
  );
}

function TechnicalSetupLink({
  setup,
  className,
  setupGroup,
  onSetupClick,
}: {
  setup: string;
  className?: string;
  setupGroup?: SetupStockGroup;
  onSetupClick?: (group: SetupStockGroup) => void;
}) {
  if (!setup) return null;

  const label = setupGroup ? `${setup} (${setupGroup.stocks.length})` : setup;

  if (setupGroup && onSetupClick) {
    return (
      <button
        type="button"
        className={cn("cursor-pointer text-left underline-offset-4 transition hover:text-blue-700 hover:underline focus:outline-none focus:ring-2 focus:ring-blue-500", className)}
        onClick={(event) => {
          event.stopPropagation();
          onSetupClick(setupGroup);
        }}
      >
        {label}
      </button>
    );
  }

  return (
    <Link
      href={getTechnicalSetupsHref(setup)}
      className={cn("cursor-pointer underline-offset-4 transition hover:text-blue-700 hover:underline", className)}
      onClick={stopRowToggle}
    >
      {label}
    </Link>
  );
}

const ACTION_CATEGORIES: ActionCategory[] = STANDARD_ACTION_ORDER;
const ACTION_HEADER: RebalanceHeader =
  "Action (Buy/Add/Sell All/Trim/Hold/Buy New)";
const CURRENT_INVESTMENT_AMOUNT_HEADER = "Current Value";
const ACTION_ESTIMATE_CATEGORIES = new Set<ActionCategory>([
  "Sell All",
  "Trim",
  "Add more",
  "Buy New",
]);
const LLM_BREAKUP_RATIONALE_HEADERS = [
  "Rationale Cruxx",
  "Rationale Technical Setup Short Term 1–3 Months",
  "Rationale - Technical Setup (Medium Term)",
  "Rationale - Technical Setup (Long Term)",
  "Rationale - Fundamentals Short Term",
  "Rationale - Fundamentals Medium/Long Term",
] as const;
const REBALANCE_DISPLAY_HEADERS = [
  ...REBALANCE_HEADER_ORDER.slice(0, 3),
  CURRENT_INVESTMENT_AMOUNT_HEADER,
  ...REBALANCE_HEADER_ORDER.slice(3),
] as const;

const CONSOLIDATED_DISPLAY_HEADERS = [
  "Current Units",
  CURRENT_INVESTMENT_AMOUNT_HEADER,
  "Action (Buy/Add/Sell All/Trim/Hold/Buy New)",
  "Units to Sell/Buy",
  "Amount",
  "Technical Setup",
  "Premarket trend",
  "Last 5 candles trend",
  "Confidence Score",
  ...REBALANCE_HEADER_ORDER.filter(
    (header) =>
      ![
        "Exchange Symbol",
        "Stock Symbol",
        "Stock Name",
        "Current Units",
        "Action (Buy/Add/Sell All/Trim/Hold/Buy New)",
      ].includes(header),
  ),
] as const;

type ConsolidatedDisplayHeader =
  | (typeof CONSOLIDATED_DISPLAY_HEADERS)[number]
  | RebalanceHeader;

const CATEGORY_BADGE_CLASS: Record<ActionCategory, string> = {
  "Sell All": getStandardActionBadgeClass("Sell All"),
  Trim: getStandardActionBadgeClass("Trim"),
  Hold: getStandardActionBadgeClass("Hold"),
  "Buy New": getStandardActionBadgeClass("Buy New"),
  "Add more": getStandardActionBadgeClass("Add more"),
};

const CONSENSUS_BREAKUP_ACTION_SORT: Record<ActionCategory, number> = {
  "Sell All": 0,
  Trim: 1,
  "Add more": 2,
  "Buy New": 3,
  Hold: 4,
};

const NOT_MENTIONED_SORT_INDEX = 5;

const CONSENSUS_BREAKUP_ROW_CLASS: Record<ActionCategory, string> = {
  "Sell All": "border-red-200 bg-red-50/70",
  Trim: "border-red-100 bg-red-50/50",
  "Add more": "border-emerald-200 bg-emerald-50/70",
  "Buy New": "border-emerald-100 bg-emerald-50/50",
  Hold: "border-yellow-200 bg-yellow-50/80",
};

const ACTION_CATEGORY_LABEL: Record<ActionCategory, string> = {
  "Sell All": "Sell All",
  "Add more": "Add More",
  "Buy New": "Buy New",
  Trim: "Trim",
  Hold: "Hold",
};

const ACTION_SCORE_BY_CATEGORY: Record<ActionCategory, number> = {
  "Sell All": -2,
  Trim: -1,
  Hold: 0,
  "Add more": 1,
  "Buy New": 2,
};

const ACTION_SCORE_TABLE_ROWS: Array<{ label: string; category: ActionCategory }> = [
  { label: "Sell All", category: "Sell All" },
  { label: "Trim", category: "Trim" },
  { label: "Hold", category: "Hold" },
  { label: "Buy / Buy New", category: "Buy New" },
  { label: "Add/Add more", category: "Add more" },
];

const DEFAULT_DETAILED_RATIONALE_ACTION_SCORE_BY_CATEGORY: Record<ActionCategory, number> = {
  "Sell All": -2.5,
  Trim: -1.5,
  Hold: 0,
  "Buy New": 1.5,
  "Add more": 2.5,
};

const TECHNICAL_SCAN_MULTIPLIER_ROWS: Array<{ label: string; key: TechnicalScanMultiplierKey }> = [
  { label: "Bullish", key: "bullish" },
  { label: "Bearish", key: "bearish" },
];

const DEFAULT_SCORE_MATRIX_FORMULA_CONFIG: ScoreMatrixFormulaConfig = {
  detailedRationaleMultipliers: {
    cruxx: 3,
    "technical-short": 3,
    "technical-medium": 2,
    "technical-long": 1,
    "fundamentals-short": 3,
    "fundamentals-medium-long": 1,
    "technical-scan-confidence": 1,
    "premarket-trend": 5,
    "last-5-candles-trend": 5,
    "mean-mode-action": 4,
  },
  detailedRationaleDenominator: null,
  actionScores: DEFAULT_DETAILED_RATIONALE_ACTION_SCORE_BY_CATEGORY,
  technicalScanMultipliers: {
    bullish: 1,
    bearish: -1,
  },
};

const SCORE_MATRIX_FORMULA_CONFIG_STORAGE_KEY = "investor:final-actionables:score-matrix-formula-config:v1";

const DASHBOARD_WORKFLOW_STORAGE_KEY = "investor:rebalance-workflow-state:v1";

type DashboardActionablesRefreshDetail = {
  market?: SwingTradeMarket;
  completedAt?: string | null;
};

function readDashboardActionablesCompletedAt(market: SwingTradeMarket) {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(DASHBOARD_WORKFLOW_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      states?: Partial<Record<"zerodha" | "indmoneyUs", {
        actionables?: { completedAt?: string | null; endedAt?: string | null };
      }>>;
    };
    const portfolio = market === "us" ? "indmoneyUs" : "zerodha";
    const actionables = parsed.states?.[portfolio]?.actionables;
    return actionables?.completedAt ?? actionables?.endedAt ?? null;
  } catch {
    return null;
  }
}

function readDashboardActionablesCompletedAtByMarket() {
  return {
    india: readDashboardActionablesCompletedAt("india"),
    us: readDashboardActionablesCompletedAt("us"),
  } satisfies Record<SwingTradeMarket, string | null>;
}

function normalizeScoreMatrixFormulaConfig(
  config?: Partial<ScoreMatrixFormulaConfig> | null,
): ScoreMatrixFormulaConfig {
  const detailedRationaleMultipliers = {
    ...DEFAULT_SCORE_MATRIX_FORMULA_CONFIG.detailedRationaleMultipliers,
  };
  if (config?.detailedRationaleMultipliers) {
    Object.entries(config.detailedRationaleMultipliers).forEach(([key, value]) => {
      if (Number.isFinite(value)) detailedRationaleMultipliers[key] = value;
    });
  }

  const actionScores = { ...DEFAULT_SCORE_MATRIX_FORMULA_CONFIG.actionScores };
  if (config?.actionScores) {
    ACTION_CATEGORIES.forEach((action) => {
      const value = config.actionScores?.[action];
      if (Number.isFinite(value)) actionScores[action] = value as number;
    });
  }

  const technicalScanMultipliers = { ...DEFAULT_SCORE_MATRIX_FORMULA_CONFIG.technicalScanMultipliers };
  if (config?.technicalScanMultipliers) {
    TECHNICAL_SCAN_MULTIPLIER_ROWS.forEach((row) => {
      const value = config.technicalScanMultipliers?.[row.key];
      if (Number.isFinite(value)) technicalScanMultipliers[row.key] = value as number;
    });
  }

  const denominator = config?.detailedRationaleDenominator;

  return {
    detailedRationaleMultipliers,
    detailedRationaleDenominator:
      typeof denominator === "number" && Number.isFinite(denominator) ? denominator : null,
    actionScores,
    technicalScanMultipliers,
  };
}

function loadScoreMatrixFormulaConfig() {
  if (typeof window === "undefined") return DEFAULT_SCORE_MATRIX_FORMULA_CONFIG;

  try {
    const raw = window.localStorage.getItem(SCORE_MATRIX_FORMULA_CONFIG_STORAGE_KEY);
    if (!raw) return DEFAULT_SCORE_MATRIX_FORMULA_CONFIG;
    return normalizeScoreMatrixFormulaConfig(JSON.parse(raw));
  } catch (error) {
    console.warn("Failed to restore score matrix formula config:", error);
    return DEFAULT_SCORE_MATRIX_FORMULA_CONFIG;
  }
}

function saveScoreMatrixFormulaConfig(config: ScoreMatrixFormulaConfig) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      SCORE_MATRIX_FORMULA_CONFIG_STORAGE_KEY,
      JSON.stringify(normalizeScoreMatrixFormulaConfig(config)),
    );
  } catch (error) {
    console.warn("Failed to save score matrix formula config:", error);
  }
}

function parseFiniteDraft(value: string) {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}


function ActionablesCalculationsIcon({ className }: { className?: string }) {
  return <FileSpreadsheet className={cn("size-5", className)} />;
}

function FinalActionTag({
  action,
  className,
}: {
  action: ActionCategory;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap",
        CATEGORY_BADGE_CLASS[action],
        className,
      )}
    >
      {ACTION_CATEGORY_LABEL[action]}
    </span>
  );
}

function FinalActionValue({ value }: { value?: string | null }) {
  const action = normalizeAction(value || "");
  if (!action) return <span>{value || "—"}</span>;
  return <FinalActionTag action={action} />;
}

export function finalActionCategoryDomId(action: ActionCategory) {
  return `final-actionables-${ACTION_CATEGORY_LABEL[action].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

const PAGE_COPY: Record<
  RebalancePortfolioKey,
  { title: string; description: string }
> = {
  zerodha: {
    title: "Zerodha Final Actionables",
    description:
      "Consolidated stock-wise rebalance actions across all LLM runs that used the same India portfolio, swing-trade, and threats inputs.",
  },
  indmoneyUs: {
    title: "IndMoney US Final Actionables",
    description:
      "Consolidated stock-wise rebalance actions across all LLM runs that used the same US portfolio, swing-trade, and threats inputs.",
  },
};

function normalizeWhitespace(value?: string | null) {
  return (value || "").replace(/\s+/g, " ").trim();
}

export function extractRebalanceInputFingerprint(prompt?: string | null) {
  const text = prompt || "";
  const marker = "## Rebalance Input Bundle";
  const markerIndex = text.indexOf(marker);
  if (markerIndex >= 0) {
    return normalizeWhitespace(text.slice(markerIndex));
  }
  return normalizeWhitespace(text);
}

function parseTimestampMs(value?: string | null) {
  if (!value) return 0;
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const parsed = /[zZ]|[+-]\d{2}:\d{2}$/.test(normalized)
    ? new Date(normalized)
    : new Date(`${normalized}Z`);
  const ms = parsed.getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function formatDateTime(value: string) {
  const ms = parseTimestampMs(value);
  if (!ms) return value;
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(ms));
}

function formatJobRunTimestamp(meta: LlmMeta) {
  return `#${meta.jobId} / #${meta.runId} (${formatDateTime(meta.createdAt)})`;
}

function RunJobLink({
  runId,
  children,
  className,
}: {
  runId: number;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={URLs.routes.console.runDetail(runId)}
      className={cn("cursor-pointer underline-offset-4 transition hover:text-blue-700 hover:underline focus:outline-none focus:ring-2 focus:ring-blue-500", className)}
      onClick={stopRowToggle}
    >
      {children}
    </Link>
  );
}


function getInputStatusBadgeClass(status?: string | null) {
  const normalized = (status || "").toLowerCase();
  if (["reserved", "queued", "pending"].includes(normalized)) {
    return "bg-blue-50 text-blue-700 ring-blue-200";
  }
  if (normalized === "partial") {
    return "bg-amber-50 text-amber-700 ring-amber-200";
  }
  if (normalized === "completed" || normalized === "synced" || normalized === "parsed") {
    return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  }
  if (normalized === "failed" || normalized === "error") {
    return "bg-red-50 text-red-700 ring-red-200";
  }
  return "bg-slate-100 text-slate-700 ring-slate-200";
}

function normalizeAction(value: string): ActionCategory | null {
  const action = value
    .toLowerCase()
    .replace(/[\s_-]+/g, " ")
    .trim();
  if (!action) return null;
  if (action.includes("sell all") || action === "sell") return "Sell All";
  if (action.includes("trim") || action.includes("reduce")) return "Trim";
  if (action.includes("buy new") || action.includes("new buy"))
    return "Buy New";
  if (action.includes("add") || action.includes("buy more")) return "Add more";
  if (action.includes("hold")) return "Hold";
  return null;
}

function parseNumericCell(value?: string | null) {
  const match = String(value || "")
    .replace(/,/g, "")
    .match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseStrictNumericCell(value?: string | null) {
  const normalized = String(value || "")
    .replace(/,/g, "")
    .trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return null;

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRationaleScoreCell(value?: string | null) {
  const parsed = parseStrictNumericCell(value);
  return parsed !== null && parsed >= -3 && parsed <= 3 ? parsed : null;
}

function average(values: number[]) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function getActionUnits(row: CanonicalRow, action: ActionCategory) {
  const currentUnits = parseNumericCell(row["Current Units"]);
  const unitsChange = parseNumericCell(row["Units Change"]);
  const unitsToBuy = parseNumericCell(row["Units to Buy"]);
  if (action === "Sell All") {
    return Math.abs(currentUnits ?? unitsChange ?? 0) || null;
  }
  if (action === "Trim") {
    return Math.abs(unitsChange ?? unitsToBuy ?? 0) || null;
  }
  if (action === "Add more" || action === "Buy New") {
    return Math.abs(unitsToBuy ?? unitsChange ?? 0) || null;
  }
  return null;
}

function getCurrentInvestmentAmount(row: CanonicalRow) {
  const explicitCurrentValue = parseNumericCell(row["Current Value"]);
  if (explicitCurrentValue !== null) return Math.abs(explicitCurrentValue);
  const currentUnits = parseNumericCell(row["Current Units"]);
  const price = parseNumericCell(row["Price Per Unit"]);
  const investedAmount = parseNumericCell(row["Current Investment Amount"]);
  const pnl =
    parseNumericCell(row["PnL"]) ??
    parseNumericCell(row["P&L"]) ??
    parseNumericCell(row["Profit/Loss"]) ??
    parseNumericCell(row["Profit and Loss"]);
  if (investedAmount !== null && pnl !== null) return Math.abs(investedAmount + pnl);
  if (currentUnits === null || price === null) return investedAmount !== null ? Math.abs(investedAmount) : null;
  return Math.abs(currentUnits * price);
}

function indexCurrentValueSnapshot(
  map: CurrentValueSnapshotMap,
  key: string | null | undefined,
  snapshot: CurrentValueSnapshot,
) {
  const normalizedKey = normalizeStockSymbol(key);
  if (normalizedKey === "UNKNOWN") return;
  map.set(normalizedKey, snapshot);
}

function buildCurrentValueSnapshotMap(
  snapshot: ZerodhaPortfolioSnapshotDetail | IndMoneyUsPortfolioSnapshotDetail | null | undefined,
  market: SwingTradeMarket,
): CurrentValueSnapshotMap {
  const map: CurrentValueSnapshotMap = new Map();
  if (!snapshot) return map;

  if (market === "india") {
    const indiaSnapshot = snapshot as ZerodhaPortfolioSnapshotDetail;
    indiaSnapshot.holdings.forEach((holding) => {
      const value = {
        units: holding.quantity,
        currentValue: holding.market_value,
      };
      indexCurrentValueSnapshot(map, holding.tradingsymbol, value);
      indexCurrentValueSnapshot(map, `${holding.exchange}:${holding.tradingsymbol}`, value);
    });
    return map;
  }

  const usSnapshot = snapshot as IndMoneyUsPortfolioSnapshotDetail;
  usSnapshot.holdings.forEach((holding) => {
    const value = {
      units: holding.quantity,
      currentValue: holding.current_value,
    };
    indexCurrentValueSnapshot(map, holding.symbol, value);
    indexCurrentValueSnapshot(map, holding.company_name, value);
  });
  return map;
}

function getCurrentValueSnapshotForRow(
  row: CanonicalRow,
  snapshotMap?: CurrentValueSnapshotMap,
) {
  if (!snapshotMap?.size) return null;
  const symbol = normalizeStockSymbol(row["Stock Symbol"] || row["Stock Name"]);
  const exchangeSymbol = normalizeStockSymbol(row["Exchange Symbol"]);
  return snapshotMap.get(symbol) ?? snapshotMap.get(exchangeSymbol) ?? null;
}

function getCurrentUnits(row: CanonicalRow, snapshotMap?: CurrentValueSnapshotMap) {
  return getCurrentValueSnapshotForRow(row, snapshotMap)?.units ?? parseNumericCell(row["Current Units"]);
}

function getCurrentValueAmount(row: CanonicalRow, snapshotMap?: CurrentValueSnapshotMap) {
  const snapshotValue = getCurrentValueSnapshotForRow(row, snapshotMap)?.currentValue;
  return snapshotValue !== null && snapshotValue !== undefined
    ? Math.abs(snapshotValue)
    : getCurrentInvestmentAmount(row);
}

function getActionAmount(
  row: CanonicalRow,
  units: number | null,
  action: ActionCategory | null,
) {
  const explicitAmount = parseNumericCell(row["Total Buy Amount"]);
  const price = parseNumericCell(row["Price Per Unit"]);
  if (
    explicitAmount !== null &&
    (explicitAmount !== 0 || action === "Add more" || action === "Buy New")
  ) {
    return Math.abs(explicitAmount);
  }
  if (units !== null && price !== null) return Math.abs(units * price);
  return null;
}

function summarizeActionEstimate(
  rows: LlmBreakupRow[],
  action: ActionCategory,
  snapshotMap?: CurrentValueSnapshotMap,
): ActionEstimate {
  const matchingRows = rows.filter(
    (row) => normalizeAction(row.cells[ACTION_HEADER] || "") === action,
  );
  const currentUnitValues = matchingRows
    .map((row) => getCurrentUnits(row.cells, snapshotMap))
    .filter((value): value is number => value !== null);
  const currentInvestmentValues = matchingRows
    .map((row) => getCurrentValueAmount(row.cells, snapshotMap))
    .filter((value): value is number => value !== null);
  const unitValues = matchingRows
    .map((row) => getActionUnits(row.cells, action))
    .filter((value): value is number => value !== null);
  const amountValues = matchingRows
    .map((row) =>
      getActionAmount(row.cells, getActionUnits(row.cells, action), action),
    )
    .filter((value): value is number => value !== null);

  return {
    currentUnits: average(currentUnitValues),
    currentInvestmentAmount: average(currentInvestmentValues),
    units: average(unitValues),
    amount: average(amountValues),
  };
}

function formatQuantity(value: number | null) {
  if (value === null) return "—";
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(
    value,
  );
}

function formatCurrency(value: number | null, market: SwingTradeMarket) {
  if (value === null) return "amount unavailable";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: market === "us" ? "USD" : "INR",
    minimumFractionDigits: market === "us" ? 2 : 0,
    maximumFractionDigits: market === "us" ? 2 : 0,
  }).format(value);
}

function getActionVerb(action: ActionCategory) {
  return action === "Sell All" || action === "Trim" ? "sell" : "buy";
}

function formatSignedQuantity(value: number | null) {
  if (value === null) return "—";
  if (value === 0) return "0";
  const formatted = formatQuantity(Math.abs(value));
  return `${value > 0 ? "+" : "-"}${formatted}`;
}

function getBuyActionAmountTotal(rows: DashboardActionRow[]) {
  return rows.reduce((sum, row) => sum + (row.formulaEstimate.amount ?? 0), 0);
}

function formatActionScore(value: number | null) {
  return value === null ? "—" : value.toFixed(2);
}

type ScoreSymbolDefinition = {
  id: string;
  rangeLabel: string;
  symbolLabel: string;
  direction: "up" | "down";
  className: string;
  matches: (score: number) => boolean;
};

const SCORE_SYMBOL_MATRIX_ROWS: ScoreSymbolDefinition[] = [
  {
    id: "greater-than-2",
    rangeLabel: ">2",
    symbolLabel: "Up triangle (Green)",
    direction: "up",
    className: "text-emerald-600",
    matches: (score) => score > 2,
  },
  {
    id: "1-to-2",
    rangeLabel: "1-2",
    symbolLabel: "Up triangle (Light Green)",
    direction: "up",
    className: "text-lime-500",
    matches: (score) => score >= 1 && score <= 2,
  },
  {
    id: "0-to-1",
    rangeLabel: "0-1",
    symbolLabel: "Up triangle (Yellow)",
    direction: "up",
    className: "text-amber-400",
    matches: (score) => score >= 0 && score < 1,
  },
  {
    id: "minus-1-to-0",
    rangeLabel: "(-1) - 0",
    symbolLabel: "Down triangle (Yellow)",
    direction: "down",
    className: "text-amber-400",
    matches: (score) => score >= -1 && score < 0,
  },
  {
    id: "minus-2-to-minus-1",
    rangeLabel: "(-2) -(-1)",
    symbolLabel: "Down triangle (Light red)",
    direction: "down",
    className: "text-rose-400",
    matches: (score) => score >= -2 && score < -1,
  },
  {
    id: "minus-3-to-minus-2",
    rangeLabel: "(-3) -(-2)",
    symbolLabel: "Down triangle (Red)",
    direction: "down",
    className: "text-red-600",
    matches: (score) => score >= -3 && score < -2,
  },
];

function getScoreSymbolDefinition(score: number | null) {
  if (score === null || !Number.isFinite(score)) return null;
  const boundedScore = Math.max(-3, Math.min(3, score));
  return SCORE_SYMBOL_MATRIX_ROWS.find((row) => row.matches(boundedScore)) ?? null;
}

function ScoreSymbol({ score, className }: { score: number | null; className?: string }) {
  const symbol = getScoreSymbolDefinition(score);

  if (!symbol) {
    return <span className={cn("whitespace-nowrap text-slate-400", className)}>—</span>;
  }

  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap font-semibold text-slate-900", className)}>
      <Triangle
        className={cn("size-3.5 fill-current", symbol.className, symbol.direction === "down" ? "rotate-180" : "")}
        aria-hidden="true"
      />
      <span>{formatActionScore(score)}</span>
    </span>
  );
}

function ScoreTriangleIcon({ score, className }: { score: number | null; className?: string }) {
  const symbol = getScoreSymbolDefinition(score);
  if (!symbol) return null;

  return (
    <Triangle
      className={cn("mt-0.5 size-3.5 shrink-0 fill-current", symbol.className, symbol.direction === "down" ? "rotate-180" : "", className)}
      aria-hidden="true"
    />
  );
}

function SelectInputsIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      aria-hidden="true"
      className={className}
      fill="none"
    >
      <path
        d="M11 10h31v44H11z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="5"
      />
      <path
        d="M7 32h32"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="5"
      />
      <path
        d="M29 22l10 10-10 10"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="5"
      />
    </svg>
  );
}

export function ScoreMatrixButton({
  detail,
  onOpenDetail,
  className,
}: {
  detail: ScoreMatrixDetail;
  onOpenDetail: (detail: ScoreMatrixDetail) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpenDetail(detail);
      }}
      className={cn(
        "cursor-pointer rounded px-1.5 py-0.5 transition hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500",
        className,
      )}
      aria-label={`Open consolidated score matrix for ${detail.stockSymbol}`}
      title={`Open consolidated score matrix for ${detail.stockSymbol}`}
    >
      <ScoreSymbol score={detail.calculatedScore} />
    </button>
  );
}

function formatScoreValue(value: number | null) {
  if (value === null) return "—";
  if (Number.isInteger(value)) return value.toFixed(0);
  return value.toFixed(2);
}

function getAverageRationaleScoreCell(rows: LlmBreakupRow[], header: RebalanceHeader) {
  return average(
    rows
      .map((row) => parseRationaleScoreCell(row.cells[header]))
      .filter((value): value is number => value !== null),
  );
}

function calculateWeightedRationaleScore(
  rows: DetailedRationaleScoreRow[],
  denominatorOverride?: number | null,
) {
  const weightedRows = rows.filter((row) => row.multiplier !== 0);
  const defaultDenominator = weightedRows.reduce(
    (sum, row) => sum + (row.denominatorWeight ?? Math.abs(row.multiplier)),
    0,
  );
  const denominator = denominatorOverride !== undefined && denominatorOverride !== null
    ? denominatorOverride
    : defaultDenominator;
  if (!denominator) return { finalScore: null, denominator };
  const numerator = weightedRows.reduce(
    (sum, row) => sum + (row.score ?? 0) * row.multiplier,
    0,
  );
  return { finalScore: numerator / denominator, denominator };
}

function getTechnicalScanScoreMultiplier(
  technicalScan: TechnicalScanResult | null,
  row: CanonicalRow,
  score: number | null,
  config: ScoreMatrixFormulaConfig = DEFAULT_SCORE_MATRIX_FORMULA_CONFIG,
) {
  if (score === null) return 0;

  const approvedSetup = resolveApprovedTechnicalSetup(technicalScan, row);
  if (approvedSetup?.direction === "bearish") return config.technicalScanMultipliers.bearish;
  if (approvedSetup?.direction === "bullish") return config.technicalScanMultipliers.bullish;
  if (technicalScan?.bias === "bearish") return config.technicalScanMultipliers.bearish;
  if (technicalScan?.bias === "bullish") return config.technicalScanMultipliers.bullish;
  return 0;
}

function formatScanSourceLabel(runLabel: string | null | undefined, createdAt: string | null | undefined, scanType: "Rebalance Scan" | "Technical Scan") {
  const fallbackLabel = scanType === "Rebalance Scan" ? "Selected rebalance run" : "Selected technical run";
  const baseLabel = runLabel?.trim() || fallbackLabel;
  const typedLabel = new RegExp(`\\(${scanType.replace(" Scan", "")} Scan\\)`, "i").test(baseLabel)
    ? baseLabel
    : `${baseLabel} (${scanType})`;
  return createdAt ? `${typedLabel} · ${formatDateTime(createdAt)}` : typedLabel;
}

function formatTechnicalScanSourceLabel(scan: Pick<TechnicalScanResult, "runLabel" | "createdAt">) {
  return formatScanSourceLabel(scan.runLabel, scan.createdAt, "Technical Scan");
}

function getLatestTechnicalScanSourceLabel(scanMap: TechnicalScanMap) {
  const latestScan = Object.values(scanMap)
    .filter((scan, index, scans) => scans.findIndex((candidate) => candidate.runId === scan.runId && candidate.jobId === scan.jobId) === index)
    .sort((a, b) => parseTimestampMs(b.createdAt) - parseTimestampMs(a.createdAt))[0];
  return latestScan ? formatTechnicalScanSourceLabel(latestScan) : null;
}

function buildMissingTechnicalScanReason(stock: StockConsensus, technicalScanSourceLabel?: string | null) {
  const sourceClause = technicalScanSourceLabel ? ` (${technicalScanSourceLabel})` : "";
  return `Not updated: No matching Technical Scan${sourceClause} row was found for ${stock.exchange || "UNKNOWN"}/${stock.symbol}. Check that the selected Technical Scan output contains this ticker and that its Stock Symbol matches the rebalance/actionables ticker.`;
}

function buildDetailedRationaleScoreRows(
  stock: StockConsensus,
  technicalScan: TechnicalScanResult | null,
  meanModeAction: ActionCategory | null,
  config: ScoreMatrixFormulaConfig = DEFAULT_SCORE_MATRIX_FORMULA_CONFIG,
  technicalScanSourceLabel?: string | null,
): DetailedRationaleScoreRow[] {
  const missingTechnicalScanReason = technicalScan
    ? null
    : buildMissingTechnicalScanReason(stock, technicalScanSourceLabel);
  const technicalConfidenceValue = getTechnicalScanConfidence(technicalScan, stock.representative);
  const technicalConfidenceScore = parseNumericCell(technicalConfidenceValue);
  const technicalConfidenceMultiplier = getTechnicalScanScoreMultiplier(
    technicalScan,
    stock.representative,
    technicalConfidenceScore,
    config,
  );
  const meanModeActionScore = meanModeAction
    ? config.actionScores[meanModeAction]
    : null;
  const effectiveTechnicalConfidenceMultiplier = technicalScan ? technicalConfidenceMultiplier : 0;

  return [
    {
      id: "cruxx",
      parameter: "Average of Score Rationale Cruxx",
      score: getAverageRationaleScoreCell(stock.rows, "Score Rationale Cruxx"),
      multiplier: config.detailedRationaleMultipliers.cruxx,
    },
    {
      id: "technical-short",
      parameter: "Average of Score Rationale - Technical Setup (Short Term 1–3 Months)",
      score: getAverageRationaleScoreCell(stock.rows, "Score Rationale Technical Setup Short Term 1–3 Months"),
      multiplier: config.detailedRationaleMultipliers["technical-short"],
    },
    {
      id: "technical-medium",
      parameter: "Average of Score Rationale - Technical Setup (Medium Term)",
      score: getAverageRationaleScoreCell(stock.rows, "Score Rationale - Technical Setup (Medium Term)"),
      multiplier: config.detailedRationaleMultipliers["technical-medium"],
    },
    {
      id: "technical-long",
      parameter: "Average of Score Rationale - Technical Setup (Long Term)",
      score: getAverageRationaleScoreCell(stock.rows, "Score Rationale - Technical Setup (Long Term)"),
      multiplier: config.detailedRationaleMultipliers["technical-long"],
    },
    {
      id: "fundamentals-short",
      parameter: "Average of Score Rationale - Fundamentals Short Term",
      score: getAverageRationaleScoreCell(stock.rows, "Score Rationale - Fundamentals Short Term"),
      multiplier: config.detailedRationaleMultipliers["fundamentals-short"],
    },
    {
      id: "fundamentals-medium-long",
      parameter: "Average of Score Rationale - Fundamentals Medium/Long Term",
      score: getAverageRationaleScoreCell(stock.rows, "Score Rationale - Fundamentals Medium/Long Term"),
      multiplier: config.detailedRationaleMultipliers["fundamentals-medium-long"],
    },
    {
      id: "technical-scan-confidence",
      parameter: "Technical Scan Confidence Score",
      score: technicalScan ? technicalConfidenceScore : null,
      multiplier: effectiveTechnicalConfidenceMultiplier,
      denominatorWeight: effectiveTechnicalConfidenceMultiplier === 0 ? 0 : 2,
      missingReason: missingTechnicalScanReason || (technicalConfidenceScore === null ? `Technical Scan row was matched, but Confidence Score was empty or non-numeric: ${technicalConfidenceValue || "blank"}.` : undefined),
    },
    {
      id: "premarket-trend",
      parameter: "Technical Scan Premarket trend",
      score: technicalScan ? getTechnicalTrendScore(technicalScan.premarketTrend) : null,
      multiplier: technicalScan ? config.detailedRationaleMultipliers["premarket-trend"] : 0,
      missingReason: missingTechnicalScanReason || (technicalScan && getTechnicalTrendScore(technicalScan.premarketTrend) === null ? `Technical Scan row was matched, but Premarket trend was empty or non-numeric: ${technicalScan.premarketTrend || "blank"}.` : undefined),
    },
    {
      id: "last-5-candles-trend",
      parameter: "Technical Scan Last 5 candles trend",
      score: technicalScan ? getTechnicalTrendScore(technicalScan.last5CandlesTrend) : null,
      multiplier: technicalScan ? config.detailedRationaleMultipliers["last-5-candles-trend"] : 0,
      missingReason: missingTechnicalScanReason || (technicalScan && getTechnicalTrendScore(technicalScan.last5CandlesTrend) === null ? `Technical Scan row was matched, but Last 5 candles trend was empty or non-numeric: ${technicalScan.last5CandlesTrend || "blank"}.` : undefined),
    },
    {
      id: "mean-mode-action",
      parameter: "Action (Buy/Add/Sell All/Trim/Hold/Buy New) in final Consolidated (Mean and Mode) row",
      score: meanModeActionScore,
      multiplier: config.detailedRationaleMultipliers["mean-mode-action"],
    },
  ];
}

function getSignedUnitsChange(
  row: CanonicalRow,
  actionOverride?: ActionCategory | null,
) {
  const action = actionOverride ?? normalizeAction(row[ACTION_HEADER] || "");
  const currentUnits = parseNumericCell(row["Current Units"]);
  const unitsChange = parseNumericCell(row["Units Change"]);
  const unitsToBuy = parseNumericCell(row["Units to Buy"]);

  if (action === "Sell All") {
    if (currentUnits !== null) return -Math.abs(currentUnits);
    if (unitsChange !== null) return -Math.abs(unitsChange);
    return unitsToBuy !== null ? -Math.abs(unitsToBuy) : null;
  }
  if (action === "Trim") {
    if (unitsChange !== null) return -Math.abs(unitsChange);
    return unitsToBuy !== null ? -Math.abs(unitsToBuy) : null;
  }
  if (action === "Add more" || action === "Buy New") {
    if (unitsToBuy !== null) return Math.abs(unitsToBuy);
    return unitsChange !== null ? Math.abs(unitsChange) : null;
  }
  if (action === "Hold") return 0;
  return null;
}

function getDisplayActionEstimate(row: CanonicalRow) {
  const action = normalizeAction(row[ACTION_HEADER] || "");
  if (!action || !ACTION_ESTIMATE_CATEGORIES.has(action)) return null;
  const units = getActionUnits(row, action);
  return {
    action,
    units,
    amount: getActionAmount(row, units, action),
  };
}

function formatDisplayAmount(value: number | null, market: SwingTradeMarket) {
  return value === null ? "—" : formatCurrency(value, market);
}

function getModeAction(actions: ActionCategory[], meanScore: number | null) {
  if (!actions.length) return null;

  const counts = ACTION_CATEGORIES.reduce(
    (acc, action) => {
      acc[action] = 0;
      return acc;
    },
    {} as Record<ActionCategory, number>,
  );

  actions.forEach((action) => {
    counts[action] += 1;
  });

  return ACTION_CATEGORIES.reduce<ActionCategory | null>((winner, action) => {
    if (!counts[action]) return winner;
    if (!winner) return action;
    if (counts[action] > counts[winner]) return action;
    if (counts[action] < counts[winner]) return winner;

    if (meanScore !== null) {
      const actionDistance = Math.abs(ACTION_SCORE_BY_CATEGORY[action] - meanScore);
      const winnerDistance = Math.abs(ACTION_SCORE_BY_CATEGORY[winner] - meanScore);
      if (actionDistance < winnerDistance) return action;
      if (actionDistance > winnerDistance) return winner;
    }

    return ACTION_CATEGORIES.indexOf(action) < ACTION_CATEGORIES.indexOf(winner)
      ? action
      : winner;
  }, null);
}

function resolveMatrixUnitsForAction(
  action: ActionCategory,
  context: ScoreMatrixContext,
) {
  if (action === "Sell All") {
    if ((context.currentUnits ?? 0) > 0) return -Math.abs(context.currentUnits || 0);
    if (context.bearishMeanUnits !== null) return -Math.abs(context.bearishMeanUnits);
    return context.meanUnitsChange !== null ? -Math.abs(context.meanUnitsChange) : null;
  }

  if (action === "Trim") {
    const currentUnits = context.currentUnits ?? 0;
    if (currentUnits > 0) return -Math.abs(currentUnits * 0.5);
    if (context.bearishMeanUnits !== null) return -Math.abs(context.bearishMeanUnits);
    if (context.meanUnitsChange !== null) return -Math.abs(context.meanUnitsChange);
    return 0;
  }

  if (action === "Hold") return 0;

  if (context.bullishMeanUnits !== null) return Math.abs(context.bullishMeanUnits);
  return context.meanUnitsChange !== null ? Math.abs(context.meanUnitsChange) : null;
}

function evaluateScoreMatrixRules(context: ScoreMatrixContext) {
  const meanScore = Math.max(-3, Math.min(3, context.calculatedScore ?? context.meanScore ?? 0));
  const hasPosition = (context.currentUnits ?? 0) > 0;
  const positiveAction: ActionCategory = hasPosition ? "Add more" : "Buy New";
  const positiveUnitsStrategy = hasPosition
    ? "Add more using the average bullish units change."
    : "Buy New using the average bullish units change.";

  const rules: Array<Omit<ScoreMatrixRuleEvaluation, "matched"> & { matches: boolean }> = [
    {
      id: "score-2-to-3",
      label: "2–3",
      when: "Calculated Score is from 2 up to 3.",
      action: positiveAction,
      unitsStrategy: positiveUnitsStrategy,
      summary: `Strong bullish score resolves to ${ACTION_CATEGORY_LABEL[positiveAction]}.`,
      matches: meanScore >= 2 && meanScore <= 3,
    },
    {
      id: "score-1-to-2",
      label: "1–2",
      when: "Calculated Score is from 1 up to 2.",
      action: positiveAction,
      unitsStrategy: positiveUnitsStrategy,
      summary: `Moderate bullish score resolves to ${ACTION_CATEGORY_LABEL[positiveAction]}.`,
      matches: meanScore >= 1 && meanScore < 2,
    },
    {
      id: "score-0-to-1",
      label: "0–1",
      when: "Calculated Score is from 0 up to 1.",
      action: "Hold",
      unitsStrategy: "Keep Units Change at 0.",
      summary: "Mildly positive score stays at Hold.",
      matches: meanScore >= 0 && meanScore < 1,
    },
    {
      id: "score-minus-1-to-0",
      label: "(-1)–0",
      when: "Calculated Score is from -1 up to 0.",
      action: "Hold",
      unitsStrategy: "Keep Units Change at 0.",
      summary: "Mildly negative score stays at Hold.",
      matches: meanScore >= -1 && meanScore < 0,
    },
    {
      id: "score-minus-2-to-minus-1",
      label: "(-2)–(-1)",
      when: "Calculated Score is from -2 up to -1.",
      action: "Trim",
      unitsStrategy: "Trim 50% of current units.",
      summary: "Moderate bearish score trims half of the current position.",
      matches: meanScore >= -2 && meanScore < -1,
    },
    {
      id: "score-minus-3-to-minus-2",
      label: "(-3)–(-2)",
      when: "Calculated Score is from -3 up to -2.",
      action: "Sell All",
      unitsStrategy: "Sell 100% of current units.",
      summary: "Strong bearish score exits the full current position.",
      matches: meanScore >= -3 && meanScore < -2,
    },
  ];

  const matchedRuleIndex = rules.findIndex((rule) => rule.matches);

  return rules.map((rule, index) => ({
    id: rule.id,
    label: rule.label,
    when: rule.when,
    action: rule.action,
    unitsStrategy: rule.unitsStrategy,
    summary: rule.summary,
    matched: index === matchedRuleIndex,
  }));
}

function buildScoreMatrixDetail(
  stock: StockConsensus,
  technicalScan: TechnicalScanResult | null = null,
  formulaConfig: ScoreMatrixFormulaConfig = DEFAULT_SCORE_MATRIX_FORMULA_CONFIG,
  technicalScanSourceLabel?: string | null,
): ScoreMatrixDetail {
  const entries: ScoreMatrixEntry[] = stock.rows.map((row) => {
    const action = normalizeAction(row.cells[ACTION_HEADER] || "");
    return {
      id: `${row.meta.runId}-${row.meta.jobId}-matrix`,
      source: row.meta.runLabel,
      action,
      actionScore: action ? ACTION_SCORE_BY_CATEGORY[action] : null,
      unitsChange: getSignedUnitsChange(row.cells, action),
      note: `${row.meta.provider} ${row.meta.model} · ${formatDateTime(row.meta.createdAt)}`,
    };
  });

  const currentUnits = average(
    stock.rows
      .map((row) => parseNumericCell(row.cells["Current Units"]))
      .filter((value): value is number => value !== null),
  ) ?? parseNumericCell(stock.representative["Current Units"]);

  const meanScore = average(
    entries
      .map((entry) => entry.actionScore)
      .filter((value): value is number => value !== null),
  );
  const meanUnitsChange = average(
    entries
      .map((entry) => entry.unitsChange)
      .filter((value): value is number => value !== null),
  );
  const modeAction = getModeAction(
    entries
      .map((entry) => entry.action)
      .filter((value): value is ActionCategory => value !== null),
    meanScore,
  );

  const bullishVotes = entries.filter(
    (entry) => entry.action === "Add more" || entry.action === "Buy New",
  ).length;
  const bearishVotes = entries.filter(
    (entry) => entry.action === "Sell All" || entry.action === "Trim",
  ).length;
  const holdVotes = entries.filter((entry) => entry.action === "Hold").length;
  const totalVotes = entries.filter((entry) => entry.action !== null).length;
  const bullishMeanUnits = average(
    entries
      .map((entry) => entry.unitsChange)
      .filter((value): value is number => value !== null && value > 0),
  );
  const bearishMeanUnits = average(
    entries
      .map((entry) => entry.unitsChange)
      .filter((value): value is number => value !== null && value < 0)
      .map((value) => Math.abs(value)),
  );

  const rebalanceSourceMeta = [...stock.rows]
    .map((row) => row.meta)
    .sort((left, right) => parseTimestampMs(right.createdAt) - parseTimestampMs(left.createdAt))[0];
  const rebalanceSourceLabel = rebalanceSourceMeta
    ? formatScanSourceLabel(rebalanceSourceMeta.runLabel, rebalanceSourceMeta.createdAt, "Rebalance Scan")
    : null;
  const technicalScanSourceLabelForStock = technicalScan
    ? formatTechnicalScanSourceLabel(technicalScan)
    : (technicalScanSourceLabel ?? null);

  const detailedRationaleRows = buildDetailedRationaleScoreRows(
    stock,
    technicalScan,
    modeAction,
    formulaConfig,
    technicalScanSourceLabelForStock,
  );
  const { finalScore: detailedRationaleFinalScore, denominator: detailedRationaleDenominator } =
    calculateWeightedRationaleScore(detailedRationaleRows, formulaConfig.detailedRationaleDenominator);
  const calculatedScore = detailedRationaleFinalScore ?? meanScore;

  const context: ScoreMatrixContext = {
    currentUnits,
    meanScore,
    meanUnitsChange,
    calculatedScore,
    modeAction,
    bullishVotes,
    bearishVotes,
    holdVotes,
    totalVotes,
    bullishMeanUnits,
    bearishMeanUnits,
  };
  const rules = evaluateScoreMatrixRules(context);
  const matchedRule = rules.find((rule) => rule.matched) ?? rules[rules.length - 1];
  const calculatedAction = matchedRule.action;
  const calculatedUnitsChange = resolveMatrixUnitsForAction(calculatedAction, context);

  return {
    stockKey: stock.key,
    stockSymbol: stock.symbol,
    stockName: stock.representative["Stock Name"] || stock.symbol,
    stockExchange: stock.exchange,
    currentUnits,
    modeAction,
    meanScore,
    meanUnitsChange,
    calculatedScore,
    meanModeAction: modeAction,
    meanModeUnitsChange: meanUnitsChange,
    calculatedAction,
    calculatedUnitsChange,
    matchedRuleId: matchedRule.id,
    rules,
    detailedRationaleRows,
    detailedRationaleFinalScore,
    detailedRationaleDenominator,
    rebalanceSourceLabel,
    rebalanceSourceRunId: rebalanceSourceMeta?.runId ?? null,
    technicalScanSourceLabel: technicalScanSourceLabelForStock,
    technicalScanSourceRunId: technicalScan?.runId ?? null,
    rows: [
      ...entries,
      {
        id: `${stock.key}-matrix-mean-mode`,
        source: "Consolidated (Mean and Mode)",
        action: modeAction,
        actionScore: meanScore,
        unitsChange: meanUnitsChange,
        note: "Action follows the mode. Units Change uses the signed mean across all LLM rows.",
        isSummary: true,
      },
      {
        id: `${stock.key}-matrix-calculated`,
        source: "Consolidated (Formula)",
        action: calculatedAction,
        actionScore: calculatedScore,
        unitsChange: calculatedUnitsChange,
        note: matchedRule.summary,
        isSummary: true,
        isCalculated: true,
      },
    ],
  };
}

function getEditableRuleSummary(
  rule: ScoreMatrixRuleEvaluation,
  action: ActionCategory,
  unitsChange: number | null | undefined,
) {
  const unitsText = unitsChange === undefined
    ? rule.unitsStrategy
    : `Use manual Units Change ${formatSignedQuantity(unitsChange)}.`;
  return `${rule.label} manually resolves to ${ACTION_CATEGORY_LABEL[action]}. ${unitsText}`;
}

function applyScoreMatrixEdits(
  detail: ScoreMatrixDetail,
  multiplierDrafts: Record<string, string>,
  denominatorDraft: string,
  ruleDrafts: Record<string, { action?: ActionCategory; unitsChange?: string }>,
): ScoreMatrixDetail {
  const detailedRationaleRows = detail.detailedRationaleRows.map((row) => {
    const draft = multiplierDrafts[row.id];
    if (draft === undefined || draft.trim() === "") return row;
    const multiplier = Number(draft);
    return Number.isFinite(multiplier) ? { ...row, multiplier } : row;
  });
  const denominatorOverride = denominatorDraft.trim() === "" ? null : Number(denominatorDraft);
  const { finalScore: detailedRationaleFinalScore, denominator: detailedRationaleDenominator } =
    calculateWeightedRationaleScore(
      detailedRationaleRows,
      typeof denominatorOverride === "number" && Number.isFinite(denominatorOverride) ? denominatorOverride : null,
    );
  const calculatedScore = detailedRationaleFinalScore ?? detail.meanScore;
  const context: ScoreMatrixContext = {
    currentUnits: detail.currentUnits,
    meanScore: detail.meanScore,
    meanUnitsChange: detail.meanUnitsChange,
    calculatedScore,
    modeAction: detail.modeAction,
    bullishVotes: 0,
    bearishVotes: 0,
    holdVotes: 0,
    totalVotes: 0,
    bullishMeanUnits: average(
      detail.rows
        .filter((row) => !row.isSummary)
        .map((row) => row.unitsChange)
        .filter((value): value is number => value !== null && value > 0),
    ),
    bearishMeanUnits: average(
      detail.rows
        .filter((row) => !row.isSummary)
        .map((row) => row.unitsChange)
        .filter((value): value is number => value !== null && value < 0)
        .map((value) => Math.abs(value)),
    ),
  };
  const rules = evaluateScoreMatrixRules(context).map((rule) => {
    const draft = ruleDrafts[rule.id];
    const action = draft?.action ?? rule.action;
    const manualUnits = draft?.unitsChange?.trim() ? Number(draft.unitsChange) : undefined;
    return {
      ...rule,
      action,
      unitsStrategy: manualUnits === undefined || !Number.isFinite(manualUnits)
        ? rule.unitsStrategy
        : `Manual Units Change ${formatSignedQuantity(manualUnits)}.`,
      summary: getEditableRuleSummary(
        rule,
        action,
        manualUnits !== undefined && Number.isFinite(manualUnits) ? manualUnits : undefined,
      ),
    };
  });
  const matchedRule = rules.find((rule) => rule.matched) ?? rules[rules.length - 1];
  const matchedDraft = ruleDrafts[matchedRule.id];
  const manualUnits = matchedDraft?.unitsChange?.trim() ? Number(matchedDraft.unitsChange) : null;
  const calculatedUnitsChange = manualUnits !== null && Number.isFinite(manualUnits)
    ? manualUnits
    : resolveMatrixUnitsForAction(matchedRule.action, context);
  const rows = detail.rows.map((row) => row.isCalculated
    ? {
      ...row,
      action: matchedRule.action,
      actionScore: calculatedScore,
      unitsChange: calculatedUnitsChange,
      note: matchedRule.summary,
    }
    : row);

  return {
    ...detail,
    calculatedScore,
    calculatedAction: matchedRule.action,
    calculatedUnitsChange,
    rules,
    rows,
    detailedRationaleRows,
    detailedRationaleFinalScore,
    detailedRationaleDenominator,
  };
}

function getFormattedCurrentValueAmount(row: CanonicalRow, market: SwingTradeMarket) {
  const explicitValue = normalizeWhitespace(row[CURRENT_INVESTMENT_AMOUNT_HEADER]);
  if (explicitValue) return explicitValue;
  return formatDisplayAmount(getCurrentInvestmentAmount(row), market);
}

function normalizeStockSymbol(value?: string | null) {
  const symbol = (value || "UNKNOWN")
    .trim()
    .toUpperCase()
    .replace(/^(?:NSE|BSE|NASDAQ|NYSE|AMEX|ARCA):/, "")
    .replace(/\.(?:NS|BO|NSE|BSE)$/i, "")
    .trim();
  return symbol || "UNKNOWN";
}

function getStockKey(row: CanonicalRow) {
  const symbol = normalizeStockSymbol(
    row["Stock Symbol"] || row["Stock Name"],
  );
  if (symbol !== "UNKNOWN") return symbol;

  const exchange = (row["Exchange Symbol"] || "UNKNOWN").trim().toUpperCase();
  return `${exchange}:UNKNOWN`;
}

function getRepresentativeConsensusRow(rows: LlmBreakupRow[]) {
  return (
    rows.find((row) => {
      const symbol = normalizeStockSymbol(
        row.cells["Stock Symbol"] || row.cells["Stock Name"],
      );
      const exchange = (row.cells["Exchange Symbol"] || "").trim();
      return symbol !== "UNKNOWN" && exchange.length > 0;
    }) ?? rows[0]
  ).cells;
}

function getStockIdentityKey(exchange: string, symbol: string) {
  const normalizedExchange = normalizeScanKey(exchange) || "UNKNOWN";
  const normalizedSymbol = normalizeScanKey(symbol) || "UNKNOWN";
  return `${normalizedExchange}:${normalizedSymbol}`;
}

function stripMarkdownLinks(value: string) {
  return value.replace(/\[([^\]]+)]\((?:[^)(]+|\([^)(]*\))*\)/g, "$1");
}

function stripInlineCitations(value: string) {
  return value
    .replace(/【[^】]*】/g, "")
    .replace(/\[(?:\d+(?:\s*[,;-]\s*\d+)*|source|ref|reference|citation)\]/gi, "")
    .replace(/(?:^|\s)(?:source|ref|citation):\s*\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeScanCell(value?: string | null) {
  return stripInlineCitations(stripMarkdownLinks(String(value || "")))
    .replace(/^`+|`+$/g, "")
    .trim();
}

function normalizeScanHeader(value?: string | null) {
  return normalizeScanCell(value)
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeScanKey(value?: string | null) {
  return normalizeScanCell(value)
    .toUpperCase()
    .replace(/^(NSE|BSE|NASDAQ|NYSE|NYSEARCA|AMEX)[:\s-]+/, "")
    .replace(/\.(NS|BO|NSE|BSE)$/, "")
    .replace(/[^A-Z0-9]+/g, "");
}


const APPROVED_TECHNICAL_SETUPS: Array<SetupRow & { direction: "bullish" | "bearish" }> = [
  ...BULLISH_SETUPS.map((setup) => ({ ...setup, direction: "bullish" as const })),
  ...BEARISH_SETUPS.map((setup) => ({ ...setup, direction: "bearish" as const })),
];

function normalizeSetupLookupKey(value?: string | null) {
  return normalizeScanCell(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(?:technical setup|setup|pattern|primary|secondary)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function getApprovedSetupByName(value?: string | null) {
  const lookup = normalizeSetupLookupKey(value);
  if (!lookup) return null;

  return APPROVED_TECHNICAL_SETUPS.find(
    (setup) => normalizeSetupLookupKey(setup.setup) === lookup,
  ) ?? null;
}

function findApprovedSetupInText(value?: string | null) {
  const lookup = normalizeSetupLookupKey(value);
  if (!lookup) return null;

  return APPROVED_TECHNICAL_SETUPS.find((setup) => {
    const setupKey = normalizeSetupLookupKey(setup.setup);
    return lookup.includes(setupKey) || setupKey.includes(lookup);
  }) ?? null;
}

function inferApprovedSetupFromText(
  value: string,
  preferredDirection?: "bullish" | "bearish" | "neutral" | null,
) {
  const lookup = normalizeSetupLookupKey(value);
  if (!lookup) return null;

  const bearishAliases: Array<[RegExp, string]> = [
    [/relative\s+(?:weakness|underperformance)|underperform|significant\s+loss|weak\s+momentum|poor\s+earnings|valuation\s+concerns/, "Relative weakness breakdown"],
    [/downtrend|falling\s+channel|sell\s+bounce/, "Top of falling channel"],
    [/lower\s+high|weakening\s+trend|corrective\s+phase|choppy\s+trend|pre\s+earnings\s+risk/, "Lower-high pullback"],
    [/resistance|rejection|supply/, "Resistance rejection"],
    [/support\s+break|breakdown/, "Support breakdown"],
    [/bear\s+flag|consolidation\s+after\s+rally/, "Bear flag"],
    [/double\s+top|\bm\s+pattern/, "Double top / M pattern"],
    [/head\s+(?:and|&)\s+shoulders/, "Head & shoulders"],
    [/descending\s+triangle/, "Descending triangle"],
    [/200\s*(?:dma|day)|moving\s+average/, "200 DMA rejection"],
    [/vwap/, "VWAP rejection"],
    [/gap\s*up|gap\s*fade/, "Gap-up fade"],
    [/parabolic|blow\s*off/, "Parabolic blow-off top"],
    [/rsi|divergence/, "RSI bearish divergence at resistance"],
  ];
  const bullishAliases: Array<[RegExp, string]> = [
    [/relative\s+strength|outperform/, "Relative strength breakout"],
    [/higher\s+low|pullback|dip/, "Higher-low pullback"],
    [/breakout\s*(?:and|\+)\s*retest|retest/, "Breakout + retest"],
    [/resistance\s+break|breakout|momentum/, "Resistance breakout"],
    [/support|demand|bounce/, "Support bounce"],
    [/bull\s+flag|consolidation\s+after\s+rally/, "Bull flag"],
    [/double\s+bottom|\bw\s+pattern/, "Double bottom / W pattern"],
    [/inverse\s+head\s+(?:and|&)\s+shoulders/, "Inverse head & shoulders"],
    [/ascending\s+triangle/, "Ascending triangle"],
    [/200\s*(?:dma|day)|moving\s+average/, "200 DMA reclaim"],
    [/vwap/, "VWAP reclaim"],
    [/gap\s*up|gap\s*and\s*go/, "Gap-up hold / gap-and-go"],
    [/rsi|divergence/, "RSI bullish divergence at support"],
  ];

  const aliasGroups = preferredDirection === "bullish"
    ? [bullishAliases, bearishAliases]
    : [bearishAliases, bullishAliases];

  for (const aliases of aliasGroups) {
    for (const [pattern, setupName] of aliases) {
      if (pattern.test(lookup)) return getApprovedSetupByName(setupName);
    }
  }

  return null;
}

function getDefaultApprovedSetup(
  scan: TechnicalScanResult | null,
  row?: CanonicalRow | null,
) {
  const action = normalizeAction(row?.[ACTION_HEADER] || "");
  if (scan?.bias === "bearish" || action === "Sell All" || action === "Trim") {
    return getApprovedSetupByName("Lower-high pullback");
  }
  return getApprovedSetupByName("Higher-low pullback");
}

function resolveApprovedTechnicalSetup(
  scan: TechnicalScanResult | null,
  row?: CanonicalRow | null,
) {
  const setupCandidates = [
    scan?.primarySetup,
    scan?.secondarySetups,
    row?.["Technical Setup"],
  ];
  const preferredDirection = scan?.bias
    || (normalizeAction(row?.[ACTION_HEADER] || "") === "Sell All" || normalizeAction(row?.[ACTION_HEADER] || "") === "Trim"
      ? "bearish"
      : "bullish");

  for (const candidate of setupCandidates) {
    const exactSetup = getApprovedSetupByName(candidate);
    if (exactSetup) return exactSetup;
  }

  for (const candidate of setupCandidates) {
    const textSetup = findApprovedSetupInText(candidate);
    if (textSetup) return textSetup;
  }

  for (const candidate of setupCandidates) {
    const inferredSetup = inferApprovedSetupFromText(candidate || "", preferredDirection);
    if (inferredSetup) return inferredSetup;
  }

  return getDefaultApprovedSetup(scan, row);
}

function getApprovedTechnicalSetupClass(setup?: (SetupRow & { direction: "bullish" | "bearish" }) | null) {
  if (!setup) return "text-gray-400";
  return setup.direction === "bearish" ? "text-red-700" : "text-emerald-700";
}

function getScanSymbolCandidates(...values: Array<string | null | undefined>) {
  const candidates = new Set<string>();

  values.forEach((value) => {
    const cleaned = normalizeScanCell(value || "");
    if (!cleaned) return;

    const pieces = [cleaned];
    const whitespaceParts = cleaned.split(/\s+/).filter(Boolean);
    if (whitespaceParts.length > 1) {
      whitespaceParts.forEach((part) => pieces.push(part));
      const uniqueParts = Array.from(new Set(whitespaceParts.map((part) => normalizeScanKey(part))));
      if (uniqueParts.length === 1) pieces.push(whitespaceParts[0]);
    }
    const colonPart = cleaned.split(":").pop();
    if (colonPart && colonPart !== cleaned) pieces.push(colonPart);
    const slashPart = cleaned.split("/").pop();
    if (slashPart && slashPart !== cleaned) pieces.push(slashPart);

    pieces.forEach((piece) => {
      const key = normalizeScanKey(piece);
      if (key && !["NSE", "BSE", "NASDAQ", "NYSE", "NYSEARCA", "AMEX", "US"].includes(key)) {
        candidates.add(key);
      }
    });
  });

  return Array.from(candidates);
}

function splitMarkdownRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => normalizeScanCell(cell));
}

function isMarkdownSeparator(cells: string[]) {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function parseTechnicalScanResponse(
  response: string,
  meta: Pick<TechnicalScanResult, "runId" | "jobId" | "provider" | "model" | "createdAt" | "runLabel">,
): TechnicalScanResult[] {
  const lines = response.split(/\r?\n/);
  const results: TechnicalScanResult[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.includes("|")) continue;

    const headers = splitMarkdownRow(line).map(normalizeScanHeader);
    const hasStockColumn = headers.some((header) =>
      ["stock symbol", "symbol", "stock", "ticker"].includes(header),
    );
    const hasSetupColumn = headers.some((header) =>
      header.includes("setup") || header.includes("pattern"),
    );
    if (!hasStockColumn || !hasSetupColumn) continue;

    const getIndex = (names: string[]) =>
      headers.findIndex((header) =>
        names.some((name) => header === name || header.includes(name)),
      );
    const exchangeIndex = getIndex(["exchange symbol", "exchange", "market"]);
    const symbolIndex = getIndex(["stock symbol", "ticker symbol", "symbol", "ticker", "stock"]);
    const primaryIndex = getIndex(["primary setup", "primary technical setup", "technical setup", "setup name", "setup", "pattern", "technical pattern"]);
    const secondaryIndex = getIndex(["secondary setups", "secondary setup", "other setups", "additional setups", "supporting setups"]);
    const biasIndex = getIndex(["bias", "sentiment", "direction", "view"]);
    const premarketTrendIndex = getIndex(["premarket trend", "pre-market trend", "pre market trend", "premarket"]);
    const last5CandlesTrendIndex = getIndex(["last 5 candles trend", "last five candles trend", "5 candles trend", "last 5 daily candles", "five daily candles trend"]);
    const confidenceIndex = getIndex(["confidence score", "confidence", "score", "conviction"]);
    const triggerIndex = getIndex(["trigger level", "trigger", "entry level", "entry range"]);
    const invalidationIndex = getIndex(["invalidation level", "invalidation", "stop loss", "stop"]);
    if (symbolIndex < 0 || primaryIndex < 0) continue;

    const parsedFromTable: TechnicalScanResult[] = [];
    let rowIndex = index + 1;
    if (rowIndex < lines.length && isMarkdownSeparator(splitMarkdownRow(lines[rowIndex]))) {
      rowIndex += 1;
    }

    for (; rowIndex < lines.length; rowIndex += 1) {
      const rowLine = lines[rowIndex];
      if (!rowLine.includes("|")) break;
      const cells = splitMarkdownRow(rowLine);
      if (isMarkdownSeparator(cells) || cells.length < 3) continue;
      const stockSymbol = normalizeScanCell(cells[symbolIndex] || "");
      if (!stockSymbol || /^stock(?: symbol)?$/i.test(stockSymbol)) continue;
      const exchangeSymbol = exchangeIndex >= 0 ? normalizeScanCell(cells[exchangeIndex] || "") : "";
      const primarySetup = normalizeScanCell(cells[primaryIndex] || "");
      const secondarySetups = secondaryIndex >= 0 ? normalizeScanCell(cells[secondaryIndex] || "") : "";
      const rawBias = (biasIndex >= 0
        ? normalizeScanCell(cells[biasIndex] || "")
        : `${primarySetup} ${secondarySetups}`).toLowerCase();
      const bias = rawBias.includes("bear")
        ? "bearish"
        : rawBias.includes("bull")
          ? "bullish"
          : "neutral";

      parsedFromTable.push({
        stockSymbol,
        exchangeSymbol,
        primarySetup,
        secondarySetups,
        confidenceScore: confidenceIndex >= 0 ? normalizeScanCell(cells[confidenceIndex] || "") : "",
        bias,
        premarketTrend: premarketTrendIndex >= 0 ? normalizeScanCell(cells[premarketTrendIndex] || "") : "",
        last5CandlesTrend: last5CandlesTrendIndex >= 0 ? normalizeScanCell(cells[last5CandlesTrendIndex] || "") : "",
        triggerLevel: triggerIndex >= 0 ? normalizeScanCell(cells[triggerIndex] || "") : "",
        invalidationLevel: invalidationIndex >= 0 ? normalizeScanCell(cells[invalidationIndex] || "") : "",
        ...meta,
      });
    }

    results.push(...parsedFromTable);
  }

  return results;
}

export function buildTechnicalScanMap(runs: RunResponse[]): TechnicalScanMap {
  const scanRows = runs
    .filter((run) => run.prompt?.includes(TECHNICAL_SCAN_MARKER))
    .flatMap((run) =>
      (run.run_jobs ?? []).flatMap((link) => {
        const job = link.job;
        if (!job || job.status !== "completed" || !job.response) return [];
        return parseTechnicalScanResponse(job.response, {
          runId: run.id,
          jobId: link.job_id,
          provider: job.provider,
          model: job.model,
          createdAt: job.created_at,
          runLabel: getAutoRebalanceRunDisplayLabel(run),
        });
      }),
    )
    .sort((a, b) => parseTimestampMs(a.createdAt) - parseTimestampMs(b.createdAt));

  return scanRows.reduce<TechnicalScanMap>((acc, row) => {
    acc[getStockIdentityKey(row.exchangeSymbol, row.stockSymbol)] = row;
    getScanSymbolCandidates(row.stockSymbol, row.exchangeSymbol).forEach((candidate) => {
      acc[`SYMBOL:${candidate}`] = row;
    });
    return acc;
  }, {});
}

function buildTechnicalScanHistory(runs: RunResponse[]): PortfolioAnalysisHistoryItem[] {
  return runs
    .filter((run) => run.prompt?.includes(TECHNICAL_SCAN_MARKER))
    .flatMap((run) =>
      (run.run_jobs ?? []).flatMap((link) => {
        const job = link.job;
        if (!job) return [];
        return [
          {
            job_id: link.job_id,
            run_id: run.id,
            status: job.status,
            provider: job.provider,
            model: job.model,
            snapshot_date: null,
            captured_at: null,
            created_at: job.created_at,
            updated_at: job.updated_at,
            estimated_cost: job.estimated_cost,
            error_message: job.error_message,
          },
        ];
      }),
    )
    .sort((a, b) => parseTimestampMs(b.created_at) - parseTimestampMs(a.created_at));
}

export function getTechnicalScanForStock(scanMap: TechnicalScanMap, stock: StockConsensus) {
  const symbolCandidates = [
    stock.symbol,
    stock.representative["Stock Symbol"],
    stock.representative["Stock Name"],
  ].filter((value): value is string => Boolean(value));

  for (const symbol of symbolCandidates) {
    const exactScan = scanMap[getStockIdentityKey(stock.exchange, symbol)]
      ?? scanMap[getStockIdentityKey("UNKNOWN", symbol)];
    if (exactScan) return exactScan;

    for (const candidate of getScanSymbolCandidates(symbol)) {
      const symbolScan = scanMap[`SYMBOL:${candidate}`];
      if (symbolScan) return symbolScan;
    }
  }

  return null;
}

function hasActiveTechnicalScan(runs: RunResponse[]) {
  return runs.some((run) =>
    run.prompt?.includes(TECHNICAL_SCAN_MARKER)
    && (
      TECHNICAL_SCAN_ACTIVE_STATUSES.has(run.status)
      || (run.run_jobs ?? []).some((link) =>
        TECHNICAL_SCAN_ACTIVE_STATUSES.has(link.job?.status || ""),
      )
    ),
  );
}

function isTechnicalScanRunComplete(run: RunResponse) {
  return (
    !TECHNICAL_SCAN_ACTIVE_STATUSES.has(run.status)
    && (run.run_jobs ?? []).every((link) =>
      !TECHNICAL_SCAN_ACTIVE_STATUSES.has(link.job?.status || ""),
    )
  );
}

async function waitForTechnicalScanRunCompletion(runId: number) {
  for (;;) {
    await new Promise((resolve) => window.setTimeout(resolve, TECHNICAL_SCAN_POLL_INTERVAL_MS));
    const run = await apiService.getRun(runId);
    if (isTechnicalScanRunComplete(run)) return run;
  }
}

function normalizeEmptyTechnicalValue(value?: string | null) {
  const normalized = normalizeScanCell(value || "");
  return normalized && !/^(?:—|-|n\/?a|na|none|null)$/i.test(normalized)
    ? normalized
    : "";
}

function getFallbackTechnicalSetup(row?: CanonicalRow | null) {
  return normalizeEmptyTechnicalValue(row?.["Technical Setup"]);
}

function getFallbackTechnicalConfidence(row?: CanonicalRow | null) {
  return (
    normalizeEmptyTechnicalValue(row?.["Confidence Score"]) ||
    normalizeEmptyTechnicalValue(row?.["Confidence Score (0-100)"])
  );
}

function formatTechnicalScanConfidenceValue(value?: string | null) {
  const normalized = normalizeEmptyTechnicalValue(value);
  if (!normalized) return "";
  const parsed = parseNumericCell(normalized);
  if (parsed === null) return normalized;
  return Number.isInteger(parsed) ? parsed.toFixed(0) : String(parsed);
}

function getTechnicalScanConfidence(scan: TechnicalScanResult | null, row?: CanonicalRow | null) {
  return formatTechnicalScanConfidenceValue(scan?.confidenceScore) || formatTechnicalScanConfidenceValue(getFallbackTechnicalConfidence(row));
}

function formatTechnicalSetup(scan: TechnicalScanResult | null, row?: CanonicalRow | null) {
  return resolveApprovedTechnicalSetup(scan, row)?.setup || getFallbackTechnicalSetup(row);
}

function getDisplayedSetupNameForStock(
  stock: StockConsensus,
  technicalScan: TechnicalScanResult | null,
) {
  return formatTechnicalSetup(technicalScan, stock.representative);
}

function formatTechnicalConfidence(scan: TechnicalScanResult | null, row?: CanonicalRow | null) {
  return getTechnicalScanConfidence(scan, row);
}

function formatTechnicalTrendValue(value?: string | null) {
  const normalized = normalizeEmptyTechnicalValue(value);
  if (!normalized) return "";
  const parsed = parseNumericCell(normalized);
  if (parsed === null) return normalized;
  return String(Math.max(-3, Math.min(3, parsed)));
}

function getTechnicalTrendScore(value?: string | null) {
  const parsed = parseNumericCell(formatTechnicalTrendValue(value));
  return parsed === null ? null : Math.max(-3, Math.min(3, parsed));
}

function formatTechnicalPremarketTrend(scan: TechnicalScanResult | null, row?: CanonicalRow | null) {
  return formatTechnicalTrendValue(scan?.premarketTrend || row?.["Premarket trend"]);
}

function formatTechnicalLast5CandlesTrend(scan: TechnicalScanResult | null, row?: CanonicalRow | null) {
  return formatTechnicalTrendValue(scan?.last5CandlesTrend || row?.["Last 5 candles trend"]);
}

function getSortableConfidence(scan: TechnicalScanResult | null, row?: CanonicalRow | null) {
  const parsed = parseNumericCell(formatTechnicalConfidence(scan, row));
  return parsed ?? Number.NEGATIVE_INFINITY;
}

function sortStocksByConfidence(
  stocks: StockConsensus[],
  technicalScans: TechnicalScanMap,
) {
  return [...stocks].sort((a, b) => {
    const bConfidence = getSortableConfidence(
      getTechnicalScanForStock(technicalScans, b),
      b.representative,
    );
    const aConfidence = getSortableConfidence(
      getTechnicalScanForStock(technicalScans, a),
      a.representative,
    );
    if (bConfidence !== aConfidence) return bConfidence - aConfidence;
    return a.symbol.localeCompare(b.symbol);
  });
}

function getTechnicalScanClass(scan: TechnicalScanResult | null, row?: CanonicalRow | null) {
  return getApprovedTechnicalSetupClass(resolveApprovedTechnicalSetup(scan, row));
}

export function getSetupStockGroups(
  consensus: StockConsensus[],
  technicalScans: TechnicalScanMap,
  market: SwingTradeMarket,
) {
  const groups = new Map<string, Map<string, SetupStockDetail>>();

  const addStockToSetup = (setup: string, stock: StockConsensus) => {
    const normalizedSetup = normalizeEmptyTechnicalValue(setup);
    if (!normalizedSetup) return;

    const stockMap = groups.get(normalizedSetup) ?? new Map<string, SetupStockDetail>();
    stockMap.set(stock.key, {
      key: stock.key,
      name: stock.symbol,
      symbol: stock.symbol,
      exchange: stock.exchange,
      market,
      currentUnits: stock.representative["Current Units"] || "—",
      currentValue: getFormattedCurrentValueAmount(stock.representative, market),
      action: stock.consensusAction,
    });
    groups.set(normalizedSetup, stockMap);
  };

  consensus.forEach((stock) => {
    addStockToSetup(
      getDisplayedSetupNameForStock(stock, getTechnicalScanForStock(technicalScans, stock)),
      stock,
    );
  });

  return Array.from(groups.entries()).reduce(
    (acc, [setup, stockMap]) => {
      acc[setup] = {
        setup,
        stocks: Array.from(stockMap.values()).sort(compareSetupStocksByAction),
      };
      return acc;
    },
    {} as Record<string, SetupStockGroup>,
  );
}

function getSetupStockGroup(
  setupGroups: Record<string, SetupStockGroup> | undefined,
  setup: string,
) {
  if (!setupGroups) return undefined;
  return setupGroups[setup];
}

function setupListMarkdown() {
  const formatRows = (label: string, rows: typeof BULLISH_SETUPS) => [
    `### ${label}`,
    "| Setup | Bias | Confidence | Best use | Trigger | Invalidation |",
    "|---|---:|---:|---|---|---|",
    ...rows.map(
      (row) =>
        `| ${row.setup} | ${row.bias} | ${row.confidence.toFixed(1)}/10 | ${row.bestUse} | ${row.trigger} | ${row.invalidation} |`,
    ),
  ].join("\n");
  return `${formatRows("Bullish Setups", BULLISH_SETUPS)}\n\n${formatRows("Bearish / Sell-Trim Setups", BEARISH_SETUPS)}`;
}

export function buildTechnicalScanPrompt(stocks: StockConsensus[], market: SwingTradeMarket) {
  const stockRows = stocks
    .map(
      (stock) =>
        `| ${stock.exchange || (market === "us" ? "US" : "NSE")} | ${stock.symbol} | ${stock.consensusAction} | ${stock.totalSuggestions} |`,
    )
    .join("\n");

  return `${TECHNICAL_SCAN_MARKER}\nMarket: ${market === "us" ? "US equities" : "India equities"}\n\nStock list:\n| Exchange Symbol | Stock Symbol | Consensus Action | Suggestions Count |\n|---|---|---|---:|\n${stockRows}\n\nApproved Technical Setups list from sidebar:\n${setupListMarkdown()}\n\nAct as a top-tier technical analyst and swing-trading strategist.\n\nObjective:\nFor the stock list given above, search the internet for the latest available technical data, price action, chart structure, moving averages, volume behaviour, RSI/divergence, support-resistance, breakout/breakdown levels, 52-week high/low position, and recent trend strength. Then tag each stock with the most relevant Bullish and/or Bearish setup names from the approved Technical Setups list above.\n\nImportant rules:\n- Use current fresh internet data only. Do not rely on stale memory.\n- Prefer sources such as TradingView, StockCharts, Yahoo Finance, MarketWatch, Investing.com, Screener, NSE/BSE, Nasdaq, Trendlyne, Chartink, StockEdge, or other reliable chart/technical sources.\n- Check at least daily chart data. If possible, also consider weekly chart for broader trend.\n- For Premarket trend: if current scan time is before market opening and the relevant premarket session is open, return only one integer from this exact scale: -3 = very bearish, -2 = bearish, -1 = slightly bearish, 0 = neutral, 1 = slightly bullish, 2 = bullish, 3 = very bullish. If premarket is not applicable, closed, unavailable, or current scan time is not before market opening, return 0.\n- For Last 5 candles trend: analyse the trend of the last 5 daily candles and return only one integer from this exact scale: -3 = very bearish, -2 = bearish, -1 = slightly bearish, 0 = neutral, 1 = slightly bullish, 2 = bullish, 3 = very bullish.\n- Tag only from the approved setup names above. Do not invent, paraphrase, or abbreviate setup names.\n- Every stock must receive a Primary Setup that exactly matches one Setup value from the approved Technical Setups list above.\n- A stock can have more than one tag, but choose one Primary Setup and optionally 1-3 Secondary Setups; every setup name must exactly match an approved Setup value.\n- For bearish setups, treat them as sell/trim/avoid fresh buying/exit weak holdings — not short-selling.\n- For Premarket trend and Last 5 candles trend, return the integer only; do not include words, symbols, explanations, or ranges.\n- For Confidence Score, copy the numeric Confidence value from the approved Technical Setups list for the same Primary Setup. Return only the number, without /10, %, avg text, or LLM counts.\n- Always mention the exact trigger level and invalidation level wherever possible.\n- Do not give generic advice. Make the tagging specific to the latest chart structure.\n\nReturn ONLY this markdown table and no extra prose:\n| ${TECHNICAL_SCAN_TABLE_COLUMNS.join(" | ")} |\n| ${TECHNICAL_SCAN_TABLE_COLUMNS.map(() => "---").join(" | ")} |\n| EXCHANGE | SYMBOL | Exact approved primary setup name | Optional exact approved setup names | Bullish/Bearish/Neutral | -3 to 3 integer only | -3 to 3 integer only | approved confidence number only | exact price/level | exact price/level |`;
}

function isUsableModelOutputStatus(status?: string | null) {
  return ["completed", "partial"].includes((status || "").toLowerCase());
}

export function hasUsableRebalanceLlmOutput(run: RunResponse) {
  return (run.run_jobs ?? []).some(
    (link) =>
      isUsableModelOutputStatus(link.job?.status) &&
      Boolean(link.job?.response?.trim()),
  );
}

export function isCompletedRebalanceRun(run: RunResponse, market: SwingTradeMarket) {
  return (
    inferRebalanceMarketFromPrompt(run.prompt) === market &&
    (isUsableModelOutputStatus(run.status) || hasUsableRebalanceLlmOutput(run))
  );
}

function hasUsableTechnicalScanLlmOutput(run: RunResponse) {
  return (run.run_jobs ?? []).some(
    (link) =>
      isUsableModelOutputStatus(link.job?.status) &&
      Boolean(link.job?.response?.trim()),
  );
}

function isCompletedTechnicalScanRun(run: RunResponse, market: SwingTradeMarket) {
  const prompt = run.prompt || "";
  return (
    prompt.includes(TECHNICAL_SCAN_MARKER) &&
    prompt.includes(market === "us" ? "Market: US equities" : "Market: India equities") &&
    (isUsableModelOutputStatus(run.status) || hasUsableTechnicalScanLlmOutput(run))
  );
}

function getRunJobCandidateId(kind: ActionablesInputSelectionKind, runId: number, jobId: number) {
  return `${kind}:${runId}:${jobId}`;
}

function buildActionablesInputCandidates(runs: RunResponse[], market: SwingTradeMarket) {
  const buildCandidatesForKind = (
    kind: ActionablesInputSelectionKind,
    label: string,
    matchingRuns: RunResponse[],
  ): ActionablesInputCandidate[] =>
    matchingRuns.flatMap((run) =>
      (run.run_jobs ?? []).flatMap((link) => {
        const job = link.job;
        if (!job) return [];
        return [{
          id: getRunJobCandidateId(kind, run.id, link.job_id),
          kind,
          label: `${label} · ${job.provider}/${job.model}`,
          jobNo: `#${run.id} / #${link.job_id}`,
          timestamp: job.created_at || run.created_at || null,
          status: job.status || run.status || "unknown",
          costUsd: job.estimated_cost ?? null,
          error: job.error_message ?? null,
          runId: run.id,
          jobId: link.job_id,
          runLabel: getAutoRebalanceRunDisplayLabel(run),
          market,
        }];
      }),
    );

  return [
    ...buildCandidatesForKind(
      "rebalance",
      "Rebalance Scan",
      runs.filter((run) => isCompletedRebalanceRun(run, market)),
    ),
    ...buildCandidatesForKind(
      "technical",
      "Technical Scan",
      runs.filter((run) => isCompletedTechnicalScanRun(run, market)),
    ),
  ].sort((a, b) => parseTimestampMs(b.timestamp) - parseTimestampMs(a.timestamp));
}

function getDefaultActionablesInputIds(candidates: ActionablesInputCandidate[], runs: RunResponse[], market: SwingTradeMarket) {
  const latestRebalanceRuns = getLatestMatchingRuns(runs, market);
  const latestRebalanceRunIds = new Set(latestRebalanceRuns.map((run) => run.id));
  const latestTechnicalRunId = runs
    .filter((run) => isCompletedTechnicalScanRun(run, market))
    .sort((a, b) => parseTimestampMs(b.created_at) - parseTimestampMs(a.created_at))[0]?.id;

  const ids = candidates
    .filter((candidate) => {
      if (candidate.kind === "rebalance") return latestRebalanceRunIds.has(candidate.runId);
      return candidate.runId === latestTechnicalRunId;
    })
    .map((candidate) => candidate.id);

  if (ids.length) return ids;
  const latestRebalance = candidates.find((candidate) => candidate.kind === "rebalance")?.id;
  const latestTechnical = candidates.find((candidate) => candidate.kind === "technical")?.id;
  return [latestRebalance, latestTechnical].filter(Boolean) as string[];
}

function filterRunsBySelectedActionablesInputs(
  runs: RunResponse[],
  kind: ActionablesInputSelectionKind,
  selectedIds: Set<string>,
) {
  return runs.flatMap((run) => {
    const runJobs = (run.run_jobs ?? []).filter((link) =>
      selectedIds.has(getRunJobCandidateId(kind, run.id, link.job_id)),
    );
    return runJobs.length ? [{ ...run, run_jobs: runJobs }] : [];
  });
}

export async function fetchAllFullRuns() {
  const firstPage = await apiService.getFullRuns({ page: 1, limit: 100 });
  if (firstPage.pages <= 1) return firstPage.items;

  const remainingPages = Array.from(
    { length: firstPage.pages - 1 },
    (_, index) => index + 2,
  );
  const remainingResults = await Promise.all(
    remainingPages.map((page) => apiService.getFullRuns({ page, limit: 100 })),
  );

  return [
    ...firstPage.items,
    ...remainingResults.flatMap((page) => page.items),
  ];
}

function getRunDisplayLabelForBreakup(run: RunResponse) {
  if (run.auto_rebalance_label?.trim() || (typeof run.auto_rebalance_sequence === "number" && run.auto_rebalance_sequence > 0)) {
    return getAutoRebalanceRunDisplayLabel(run);
  }
  return `Run #${run.id}`;
}

function getRunJobMetas(run: RunResponse): LlmMeta[] {
  const runLabel = getRunDisplayLabelForBreakup(run);
  return (run.run_jobs ?? []).flatMap((link) => {
    const job = link.job;
    if (!job) return [];
    return [{
      runId: run.id,
      jobId: link.job_id,
      runLabel,
      provider: job.provider,
      model: job.model,
      createdAt: job.created_at,
      status: job.status || "unknown",
      error: job.error_message ?? null,
    }];
  });
}

function getMetaKey(meta: Pick<LlmMeta, "runId" | "jobId">) {
  return `${meta.runId}:${meta.jobId}`;
}

function parseRunRows(run: RunResponse): LlmBreakupRow[] {
  return (run.run_jobs ?? []).flatMap((link) => {
    const job = link.job;
    if (!job) return [];
    const response = job.response;
    if (!isUsableModelOutputStatus(job.status) || !response) return [];
    const parsed = parseInvestmentRecommendationContent(response, {
      provider: job.provider,
      model: job.model,
      runNumber: run.id,
      runCreatedAt: run.created_at,
    });
    if (!parsed || !parsed.headers.includes(ACTION_HEADER)) return [];
    return parsed.rows.map((row) => ({
      cells: row,
      meta: {
        runId: run.id,
        jobId: link.job_id,
        runLabel: getRunDisplayLabelForBreakup(run),
        provider: job.provider,
        model: job.model,
        createdAt: job.created_at,
        status: job.status || "completed",
        error: job.error_message ?? null,
      },
    }));
  });
}

export function buildConsensusRows(
  runs: RunResponse[],
  market: SwingTradeMarket,
  portfolioSnapshot?: ZerodhaPortfolioSnapshotDetail | IndMoneyUsPortfolioSnapshotDetail | null,
): StockConsensus[] {
  const grouped = new Map<string, LlmBreakupRow[]>();
  const currentValueSnapshots = buildCurrentValueSnapshotMap(portfolioSnapshot, market);
  const llmMetas = runs.flatMap(getRunJobMetas);

  runs.flatMap(parseRunRows).forEach((row) => {
    if (!Object.values(row.cells).some((value) => value.trim())) return;
    const key = getStockKey(row.cells);
    const rows = grouped.get(key) ?? [];
    rows.push(row);
    grouped.set(key, rows);
  });

  return Array.from(grouped.entries())
    .map(([key, rows]) => {
      const actionCounts = ACTION_CATEGORIES.reduce(
        (acc, action) => {
          acc[action] = 0;
          return acc;
        },
        {} as Record<ActionCategory, number>,
      );
      const actionAverages = ACTION_CATEGORIES.reduce(
        (acc, action) => {
          acc[action] = summarizeActionEstimate(rows, action, currentValueSnapshots);
          return acc;
        },
        {} as Record<ActionCategory, ActionEstimate>,
      );

      rows.forEach((row) => {
        const category = normalizeAction(row.cells[ACTION_HEADER] || "");
        if (category) actionCounts[category] += 1;
      });

      const consensusAction = ACTION_CATEGORIES.reduce((winner, action) => {
        if (actionCounts[action] > actionCounts[winner]) return action;
        return winner;
      }, "Hold" as ActionCategory);

      const rowByMeta = new Map(rows.map((row) => [getMetaKey(row.meta), row]));
      const breakupEntries = (llmMetas.length ? llmMetas : rows.map((row) => row.meta))
        .map((meta) => ({
          meta,
          row: rowByMeta.get(getMetaKey(meta)) ?? null,
        }))
        .sort(compareConsensusBreakupEntries);
      const totalSuggestions = llmMetas.length || rows.length;

      const first = getRepresentativeConsensusRow(rows);
      const representative = { ...first };
      representative[ACTION_HEADER] =
        ACTION_CATEGORIES.filter((action) => actionCounts[action] > 0)
          .map((action) => `${action} (${actionCounts[action]}/${totalSuggestions})`)
          .join("; ") || "No action consensus";
      representative["Confidence Score (0-100)"] = summarizeNumeric(
        rows,
        "Confidence Score (0-100)",
      );
      representative["Rationale Cruxx"] = summarizeRationales(rows);
      const consensusEstimate = actionAverages[consensusAction];
      representative["Current Units"] = formatQuantity(
        consensusEstimate.currentUnits ?? getCurrentUnits(first, currentValueSnapshots),
      );
      representative[CURRENT_INVESTMENT_AMOUNT_HEADER] = formatDisplayAmount(
        consensusEstimate.currentInvestmentAmount ?? getCurrentValueAmount(first, currentValueSnapshots),
        market,
      );
      representative["Units to Sell/Buy"] = ACTION_ESTIMATE_CATEGORIES.has(
        consensusAction,
      )
        ? formatQuantity(consensusEstimate.units)
        : "—";
      representative["Amount"] = ACTION_ESTIMATE_CATEGORIES.has(consensusAction)
        ? formatCurrency(consensusEstimate.amount, market)
        : "—";

      return {
        key,
        exchange: first["Exchange Symbol"] || "",
        symbol: first["Stock Symbol"] || first["Stock Name"] || key,
        consensusAction,
        actionCounts,
        actionAverages,
        totalSuggestions,
        representative,
        rows,
        breakupEntries,
      };
    })
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function summarizeNumeric(rows: LlmBreakupRow[], header: RebalanceHeader) {
  const values = rows
    .map((row) =>
      Number(String(row.cells[header] || "").replace(/[^\d.-]/g, "")),
    )
    .filter((value) => Number.isFinite(value));
  if (!values.length) return "";
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return `${average.toFixed(0)} avg (${values.length} LLMs)`;
}

function summarizeRationales(rows: LlmBreakupRow[]) {
  return rows
    .slice(0, 3)
    .map(
      (row) =>
        `${row.meta.provider} ${row.meta.model}: ${row.cells["Rationale Cruxx"] || row.cells["Rationale Remarks"] || row.cells["Technical Setup"] || "No rationale"}`,
    )
    .join(" | ");
}

function stockSymbolMatches(value: string | null | undefined, stock: StockConsensus) {
  const normalized = normalizeStockSymbol(value || "");
  return normalized !== "UNKNOWN" && normalized === normalizeStockSymbol(stock.symbol);
}

function getAnalysisTableRowsForStock(
  tables: Array<{ title: string; columns: string[]; rows: Record<string, string>[] }> | undefined,
  stock: StockConsensus,
) {
  return (tables ?? []).flatMap((table) =>
    table.rows
      .filter((row) => Object.values(row).some((value) => stockSymbolMatches(value, stock)))
      .map((row) => ({ ...table, row })),
  );
}

function KeyValueGrid({
  values,
  itemClassName,
}: {
  values: Array<[string, ReactNode]>;
  itemClassName?: string;
}) {
  return (
    <dl className="grid gap-2 sm:grid-cols-2">
      {values.map(([label, value]) => (
        <div key={label} className={cn("rounded-lg border p-2", itemClassName ?? "border-gray-100 bg-gray-50")}>
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{label}</dt>
          <dd className="mt-1 break-words text-sm text-gray-800">{value || "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

function formatRecommendationLabel(value: string) {
  const action = normalizeAction(value);
  return action ? ACTION_CATEGORY_LABEL[action] : value || "No recommendation";
}

const RATIONALE_SECTION_GROUPS: Array<{
  title: string;
  subtitle?: string;
  className: string;
  titleClassName: string;
  items: Array<{ header: (typeof LLM_BREAKUP_RATIONALE_HEADERS)[number]; label: string | null }>;
}> = [
  {
    title: "Cruxx",
    className: "border-rose-200 bg-rose-50/80 text-rose-700",
    titleClassName: "text-rose-800",
    items: [{ header: "Rationale Cruxx", label: null }],
  },
  {
    title: "Technical setup",
    className: "border-blue-200 bg-blue-50/80 text-blue-700",
    titleClassName: "text-blue-800",
    items: [
      { header: "Rationale Technical Setup Short Term 1–3 Months", label: "Short" },
      { header: "Rationale Technical Setup Short Term 1–3 Months", label: "Short" },
      { header: "Rationale - Technical Setup (Medium Term)", label: "Medium" },
      { header: "Rationale - Technical Setup (Long Term)", label: "Long" },
      { header: "Rationale - Technical Setup (Long Term)", label: "Long" },
    ],
  },
  {
    title: "Fundamental Setup",
    className: "border-emerald-200 bg-emerald-50/80 text-emerald-700",
    titleClassName: "text-emerald-800",
    items: [
      { header: "Rationale - Fundamentals Short Term", label: "Short" },
      { header: "Rationale - Fundamentals Medium/Long Term", label: "Medium" },
    ],
  },
];

const RATIONALE_TEXT_HEADERS: RebalanceHeader[] = [
  "Rationale Cruxx",
  "Rationale Technical Setup Short Term 1–3 Months",
  "Rationale - Technical Setup (Medium Term)",
  "Rationale - Technical Setup (Long Term)",
  "Rationale - Fundamentals Short Term",
  "Rationale - Fundamentals Medium/Long Term",
];

const RATIONALE_SCORE_HEADERS: RebalanceHeader[] = [
  "Score Rationale Cruxx",
  "Score Rationale Technical Setup Short Term 1–3 Months",
  "Score Rationale - Technical Setup (Medium Term)",
  "Score Rationale - Technical Setup (Long Term)",
  "Score Rationale - Fundamentals Short Term",
  "Score Rationale - Fundamentals Medium/Long Term",
];

const RATIONALE_SCORE_HEADER_BY_RATIONALE_HEADER: Partial<Record<RebalanceHeader, RebalanceHeader>> = {
  "Rationale Cruxx": "Score Rationale Cruxx",
  "Rationale Technical Setup Short Term 1–3 Months": "Score Rationale Technical Setup Short Term 1–3 Months",
  "Rationale - Technical Setup (Medium Term)": "Score Rationale - Technical Setup (Medium Term)",
  "Rationale - Technical Setup (Long Term)": "Score Rationale - Technical Setup (Long Term)",
  "Rationale - Fundamentals Short Term": "Score Rationale - Fundamentals Short Term",
  "Rationale - Fundamentals Medium/Long Term": "Score Rationale - Fundamentals Medium/Long Term",
};

function getRowRationaleDisplayScore(row: CanonicalRow) {
  return average(
    RATIONALE_SCORE_HEADERS.map((header) => parseNumericCell(row[header])).filter(
      (value): value is number => value !== null,
    ),
  );
}

function CapturedRationaleScoreCell({ row }: { row: CanonicalRow }) {
  return <ScoreSymbol score={getRowRationaleDisplayScore(row)} />;
}

function CapturedRationalesCell({ row }: { row: CanonicalRow }) {
  const groups = RATIONALE_SECTION_GROUPS.map((group) => {
    const seenLabels = new Set<string>();
    const items = group.items
      .map((item) => ({
        ...item,
        score: parseNumericCell(row[RATIONALE_SCORE_HEADER_BY_RATIONALE_HEADER[item.header] ?? item.header]),
        value: row[item.header] || "",
      }))
      .filter((item) => item.value.trim())
      .filter((item) => {
        const key = `${item.label ?? ""}:${normalizeWhitespace(item.value)}`;
        if (seenLabels.has(key)) return false;
        seenLabels.add(key);
        return true;
      });
    return { ...group, items };
  }).filter((group) => group.items.length > 0);

  if (!groups.length) {
    return <span>{row["Technical Setup"] || "—"}</span>;
  }

  return (
    <div className="space-y-2">
      {groups.map((group) => (
        <section key={group.title} className={cn("rounded-lg border px-3 py-2", group.className)}>
          <div className={cn("text-[11px] font-bold uppercase tracking-wide", group.titleClassName)}>
            {group.title}
          </div>
          {group.subtitle ? <div className="mt-0.5 text-[10px] font-medium opacity-80">{group.subtitle}</div> : null}
          <div className="mt-1.5 space-y-1 text-xs leading-5">
            {group.items.map(({ header, label, score, value }) => (
              <p key={`${header}-${label ?? "plain"}`} className="flex items-start gap-1.5 whitespace-pre-wrap break-words">
                <ScoreTriangleIcon score={score} />
                <span>
                  {label ? <span className="font-semibold">{label}: </span> : null}
                  {value}
                </span>
              </p>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function getConsensusBreakupAction(entry: ConsensusBreakupEntry) {
  return entry.row ? normalizeAction(entry.row.cells[ACTION_HEADER] || "") : null;
}

function compareConsensusBreakupEntries(a: ConsensusBreakupEntry, b: ConsensusBreakupEntry) {
  const actionA = getConsensusBreakupAction(a);
  const actionB = getConsensusBreakupAction(b);
  const actionComparison =
    (actionA ? CONSENSUS_BREAKUP_ACTION_SORT[actionA] : NOT_MENTIONED_SORT_INDEX) -
    (actionB ? CONSENSUS_BREAKUP_ACTION_SORT[actionB] : NOT_MENTIONED_SORT_INDEX);
  if (actionComparison !== 0) return actionComparison;

  const providerComparison = (a.meta.provider || "").localeCompare(b.meta.provider || "", undefined, {
    sensitivity: "base",
  });
  if (providerComparison !== 0) return providerComparison;

  return (a.meta.model || "").localeCompare(b.meta.model || "", undefined, { sensitivity: "base" });
}

export function ConsensusBreakupButton({
  stock,
  action,
}: {
  stock: StockConsensus;
  action: ActionCategory;
}) {
  const [open, setOpen] = useState(false);
  const consensusText = `${stock.actionCounts[action]}/${stock.totalSuggestions}`;

  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
        className="cursor-pointer rounded px-1.5 py-0.5 font-semibold text-blue-700 underline underline-offset-2 transition hover:bg-blue-50 hover:text-blue-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
        aria-label={`Show ${stock.symbol} LLM recommendation breakup`}
        title={`Show ${stock.symbol} LLM recommendation breakup`}
      >
        {consensusText}
      </button>
      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 px-4 py-10"
          role="dialog"
          aria-modal="true"
          aria-label={`${stock.symbol} consensus breakup`}
          onClick={() => setOpen(false)}
        >
          <div className="w-full max-w-3xl rounded-2xl bg-white shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="sticky top-0 z-10 flex items-start justify-between gap-4 rounded-t-2xl border-b bg-white px-5 py-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-blue-600">Consensus breakup</p>
                <h2 className="mt-1 flex flex-wrap items-baseline gap-2 text-2xl font-bold text-gray-900">
                  <span>{stock.symbol} · {consensusText}</span>
                  <span className={cn("rounded-full border px-2.5 py-1 text-sm font-bold", CATEGORY_BADGE_CLASS[action])}>
                    {formatRecommendationLabel(action)}
                  </span>
                </h2>
                <p className="mt-2 text-sm text-gray-500">
                  Recommendation from every LLM included in the consolidated actionables run; missing stock mentions are marked as Not mentioned.
                </p>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="rounded-full p-2 text-gray-500 transition hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" aria-label="Close consensus breakup">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="max-h-[75vh] overflow-y-auto px-5 py-4">
              <div className="space-y-3">
                {stock.breakupEntries.map((entry, index) => {
                  const rowAction = getConsensusBreakupAction(entry);
                  const recommendationLabel = rowAction ? formatRecommendationLabel(rowAction) : "Not mentioned";
                  return (
                    <div
                      key={`${entry.meta.runId}-${entry.meta.jobId}-${index}`}
                      className={cn(
                        "rounded-xl border px-4 py-3",
                        rowAction ? CONSENSUS_BREAKUP_ROW_CLASS[rowAction] : "border-slate-200 bg-slate-50",
                      )}
                    >
                      <div className="grid items-center gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
                        <div className="min-w-0">
                          <Link
                            href={`/console/runs/${entry.meta.runId}#llm-output-job-${entry.meta.jobId}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              setOpen(false);
                            }}
                            className="block cursor-pointer truncate text-base font-bold text-slate-900 underline-offset-4 transition hover:text-blue-700 hover:underline focus:outline-none focus:ring-2 focus:ring-blue-500"
                            title={`Open ${entry.meta.provider || "Unknown provider"} ${entry.meta.model || "Unknown model"} output`}
                          >
                            {index + 1}. {entry.meta.provider || "Unknown provider"} {entry.meta.model || "Unknown model"}
                          </Link>
                          <div className="mt-0.5 text-sm text-slate-500">
                            {entry.meta.runLabel} · Job #{entry.meta.jobId}
                          </div>
                        </div>
                        <div className="whitespace-nowrap text-sm text-slate-500">
                          {formatDateTime(entry.meta.createdAt)}
                        </div>
                        <span
                          className={cn(
                            "justify-self-start rounded-full border px-3 py-1 text-sm font-bold sm:justify-self-end",
                            rowAction ? CATEGORY_BADGE_CLASS[rowAction] : "border-slate-200 bg-slate-100 text-slate-600",
                          )}
                        >
                          {recommendationLabel}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function StockDetailsButton({
  stock,
  market,
  technicalScan,
  detailsData,
  onFocusCalculation,
}: {
  stock: StockConsensus;
  market: SwingTradeMarket;
  technicalScan: TechnicalScanResult | null;
  detailsData: StockDetailsData;
  onFocusCalculation?: (target: ActionablesCalculationFocusTarget) => void;
}) {
  const [open, setOpen] = useState(false);
  const eventRows = getAnalysisTableRowsForStock(
    detailsData.eventsAnalysis?.table ? [{ title: "Events Calendar", ...detailsData.eventsAnalysis.table }] : [],
    stock,
  );
  const threatRows = getAnalysisTableRowsForStock(detailsData.threatsAnalysis?.report?.tables, stock);

  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
        className="mr-2 inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-full border border-gray-300 bg-white text-gray-500 transition hover:border-blue-400 hover:text-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
        aria-label={`Open ${stock.symbol} captured details`}
        title={`Open ${stock.symbol} captured details`}
      >
        <Info className="h-[18px] w-[18px]" />
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 px-4 py-10"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`stock-details-${stock.key}`}
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-5xl rounded-2xl bg-white shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="sticky top-0 z-10 flex items-start justify-between gap-4 rounded-t-2xl border-b bg-white px-5 py-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">Captured stock details</p>
                <h2 id={`stock-details-${stock.key}`} className="mt-1 text-xl font-bold text-gray-900">
                  <TradingViewSymbolLink
                    symbol={stock.symbol}
                    market={market}
                    exchange={stock.exchange}
                    className="underline-offset-4 transition hover:text-blue-700 hover:underline"
                  >
                    {stock.symbol}
                  </TradingViewSymbolLink>
                </h2>
                <p className="text-sm text-gray-500">
                  Swing/all LLM runs, technical scan, threats, and events context captured in prior flows.
                </p>
              </div>
              <div className="flex items-center gap-2">
                {onFocusCalculation ? (
                  <button
                    type="button"
                    onClick={() => {
                      onFocusCalculation({ stockKey: stock.key, header: "Stock Info" });
                      setOpen(false);
                    }}
                    className="inline-flex size-9 cursor-pointer items-center justify-center rounded-full border border-blue-200 bg-blue-50 text-blue-700 shadow-sm transition hover:border-blue-400 hover:bg-blue-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    aria-label={`Open Actionables Calculations for ${stock.symbol}`}
                    title="Actionables Calculations"
                  >
                    <ActionablesCalculationsIcon className="size-4" />
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-full p-2 text-gray-500 transition hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  aria-label="Close stock details"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            <div className="max-h-[75vh] space-y-5 overflow-y-auto px-5 py-5 text-sm">
              {detailsData.error ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-800">
                  Some latest captured details could not be loaded: {detailsData.error}
                </div>
              ) : null}

              <section className="rounded-xl border border-blue-100 bg-blue-50/70 p-4">
                <h3 className="mb-3 font-semibold text-blue-950">Final action & technical scan</h3>
                <KeyValueGrid
                  itemClassName="border-blue-100 bg-white/75"
                  values={[
                    ["Consensus action", <FinalActionTag key="consensus-action" action={stock.consensusAction} />],
                    ["Consensus", `${stock.actionCounts[stock.consensusAction]}/${stock.totalSuggestions}`],
                    ["Technical setup", formatTechnicalSetup(technicalScan, stock.representative)],
                    ["Confidence score", formatTechnicalConfidence(technicalScan, stock.representative)],
                    ["Trigger level", technicalScan?.triggerLevel || "—"],
                    ["Invalidation level", technicalScan?.invalidationLevel || "—"],
                  ]}
                />
              </section>

              <section className="rounded-xl border border-violet-100 bg-violet-50/70 p-4">
                <h3 className="mb-3 font-semibold text-violet-950">Swing / rebalance all-runs LLM breakup</h3>
                <div className="overflow-x-auto rounded-lg border border-violet-100 bg-white/75">
                  <table className="min-w-full text-xs">
                    <thead className="bg-violet-100/70 text-left text-violet-900">
                      <tr>
                        <th className="px-3 py-2">Run / LLM</th>
                        <th className="px-3 py-2">Action</th>
                        <th className="px-3 py-2">Units</th>
                        <th className="px-3 py-2">Amount</th>
                        <th className="px-3 py-2">Score</th>
                        <th className="px-3 py-2">Rationale</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-violet-100">
                      {stock.rows.map((row) => (
                        <tr key={`${row.meta.runId}-${row.meta.jobId}-details`}>
                          <td className="whitespace-nowrap px-3 py-2 align-top">
                            {row.meta.runLabel}<br />{row.meta.provider} {row.meta.model}<br />
                            <span className="text-gray-400">{formatDateTime(row.meta.createdAt)}</span>
                          </td>
                          <td className="px-3 py-2 align-top">
                            <FinalActionValue value={row.cells[ACTION_HEADER]} />
                          </td>
                          <td className="px-3 py-2 align-top">{row.cells["Units to Buy"] || row.cells["Units Change"] || "—"}</td>
                          <td className="px-3 py-2 align-top">{row.cells["Total Buy Amount"] || "—"}</td>
                          <td className="whitespace-nowrap px-3 py-2 align-top"><CapturedRationaleScoreCell row={row.cells} /></td>
                          <td className="min-w-80 px-3 py-2 align-top"><CapturedRationalesCell row={row.cells} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="rounded-xl border border-rose-100 bg-rose-50/70 p-4">
                <h3 className="mb-3 font-semibold text-rose-950">Threats</h3>
                {threatRows.length ? (
                  <div className="space-y-2">
                    {threatRows.map((item, index) => (
                      <div key={`${item.title}-${index}`} className="rounded-lg border border-rose-100 bg-white/75 p-3">
                        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-rose-700">{item.title}</div>
                        <KeyValueGrid
                          itemClassName="border-rose-100 bg-rose-50/60"
                          values={Object.entries(item.row).map(([key, value]) => [key, value])}
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="rounded-lg border border-rose-100 bg-white/75 p-3 text-rose-700">
                    No matching threat rows were found in the latest threats scan.
                  </p>
                )}
              </section>

              <section className="rounded-xl border border-emerald-100 bg-emerald-50/70 p-4">
                <h3 className="mb-3 font-semibold text-emerald-950">Events</h3>
                {eventRows.length ? (
                  <div className="space-y-2">
                    {eventRows.map((item, index) => (
                      <div key={`${item.title}-${index}`} className="rounded-lg border border-emerald-100 bg-white/75 p-3">
                        <KeyValueGrid
                          itemClassName="border-emerald-100 bg-emerald-50/60"
                          values={Object.entries(item.row).map(([key, value]) => [key, value])}
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="rounded-lg border border-emerald-100 bg-white/75 p-3 text-emerald-700">
                    No matching event rows were found in the latest events scan.
                  </p>
                )}
              </section>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function ActionSummarySections({
  consensus,
  market,
  technicalScans,
  setupGroups,
  detailsData,
  onSetupClick,
  onFocusCalculation,
}: {
  consensus: StockConsensus[];
  market: SwingTradeMarket;
  technicalScans: TechnicalScanMap;
  setupGroups: Record<string, SetupStockGroup>;
  detailsData: StockDetailsData;
  onSetupClick: (group: SetupStockGroup) => void;
  onFocusCalculation?: (target: ActionablesCalculationFocusTarget) => void;
}) {
  return (
    <div className="space-y-4">
      {ACTION_CATEGORIES.map((action) => {
        const stocks = sortStocksByConfidence(
          consensus.filter((item) => item.consensusAction === action),
          technicalScans,
        );
        return (
          <Card
            key={action}
            id={finalActionCategoryDomId(action)}
            className={cn("scroll-mt-24 border", CATEGORY_BADGE_CLASS[action])}
          >
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <CardTitle className="text-sm">{ACTION_CATEGORY_LABEL[action]}</CardTitle>
                <span className="text-xs font-semibold text-slate-600">
                  {stocks.length} stock{stocks.length === 1 ? "" : "s"}
                </span>
              </div>
            </CardHeader>
            <CardContent className="text-xs">
              {stocks.length ? (
                <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
                  {stocks.map((stock) => (
                    <ActionSummaryStockTile
                      key={stock.key}
                      action={action}
                      stock={stock}
                      market={market}
                      technicalScan={getTechnicalScanForStock(technicalScans, stock)}
                      setupGroups={setupGroups}
                      detailsData={detailsData}
                      onSetupClick={onSetupClick}
                      onFocusCalculation={onFocusCalculation}
                    />
                  ))}
                </div>
              ) : (
                <span className="text-gray-600">No consensus stocks.</span>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function ActionSummaryStockTile({
  action,
  stock,
  market,
  technicalScan,
  setupGroups,
  detailsData,
  onSetupClick,
  onFocusCalculation,
}: {
  action: ActionCategory;
  stock: StockConsensus;
  market: SwingTradeMarket;
  technicalScan: TechnicalScanResult | null;
  setupGroups: Record<string, SetupStockGroup>;
  detailsData: StockDetailsData;
  onSetupClick: (group: SetupStockGroup) => void;
  onFocusCalculation?: (target: ActionablesCalculationFocusTarget) => void;
}) {
  const estimate = stock.actionAverages[action];
  const showActionColumns = ACTION_ESTIMATE_CATEGORIES.has(action);
  const setup = formatTechnicalSetup(technicalScan, stock.representative);
  const confidence = formatTechnicalConfidence(technicalScan, stock.representative) || "—";

  return (
    <article className="rounded-2xl border border-white/80 bg-white/75 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <StockDetailsButton
              stock={stock}
              market={market}
              technicalScan={technicalScan}
              detailsData={detailsData}
              onFocusCalculation={onFocusCalculation}
            />
            <TradingViewSymbolLink
              symbol={stock.symbol}
              market={market}
              exchange={stock.exchange}
              className="truncate text-sm font-semibold underline-offset-4 hover:text-blue-700 hover:underline"
            >
              {stock.symbol}
            </TradingViewSymbolLink>
          </div>
          <div className="mt-1 text-[11px] uppercase tracking-[0.16em] text-slate-500">
            {stock.exchange || (market === "us" ? "US" : "NSE")}
          </div>
        </div>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-700">
          <ConsensusBreakupButton stock={stock} action={action} />
        </span>
      </div>

      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-3">
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Current Units
          </dt>
          <dd className="mt-1 text-sm font-medium text-slate-900">
            {formatQuantity(estimate.currentUnits)}
          </dd>
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-3">
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Current Value
          </dt>
          <dd className="mt-1 text-sm font-medium text-slate-900">
            {formatDisplayAmount(
              estimate.currentInvestmentAmount ??
                getCurrentValueAmount(stock.representative),
              market,
            )}
          </dd>
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-3">
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Units to {getActionVerb(action)}
          </dt>
          <dd className="mt-1 text-sm font-medium text-slate-900">
            {showActionColumns ? formatQuantity(estimate.units) : "—"}
          </dd>
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-3">
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Amount
          </dt>
          <dd className="mt-1 text-sm font-medium text-slate-900">
            {showActionColumns ? formatDisplayAmount(estimate.amount, market) : "—"}
          </dd>
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-3 sm:col-span-2">
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Technical Setup
          </dt>
          <dd className={cn("mt-1 text-sm font-medium", getTechnicalScanClass(technicalScan, stock.representative))}>
            <TechnicalSetupLink
              setup={setup}
              setupGroup={getSetupStockGroup(setupGroups, setup)}
              onSetupClick={onSetupClick}
            />
          </dd>
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-3 sm:col-span-2">
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Confidence Score
          </dt>
          <dd className={cn("mt-1 text-sm font-semibold", getTechnicalScanClass(technicalScan, stock.representative))}>
            {confidence}
          </dd>
        </div>
      </dl>
    </article>
  );
}

function RebalanceCell({
  row,
  header,
  market,
  technicalScan,
  setupGroups,
  onSetupClick,
  preferActionTag,
}: {
  row: CanonicalRow;
  header: ConsolidatedDisplayHeader;
  market: SwingTradeMarket;
  technicalScan?: TechnicalScanResult | null;
  setupGroups?: Record<string, SetupStockGroup>;
  onSetupClick?: (group: SetupStockGroup) => void;
  preferActionTag?: boolean;
}) {
  if (header === "Technical Setup") {
    const setup = formatTechnicalSetup(technicalScan || null, row);
    return (
      <span className={cn("font-medium", getTechnicalScanClass(technicalScan || null, row))}>
        <TechnicalSetupLink
          setup={setup}
          setupGroup={getSetupStockGroup(setupGroups, setup)}
          onSetupClick={onSetupClick}
        />
      </span>
    );
  }
  if (header === "Premarket trend") {
    return formatTechnicalPremarketTrend(technicalScan || null, row);
  }
  if (header === "Last 5 candles trend") {
    return formatTechnicalLast5CandlesTrend(technicalScan || null, row);
  }
  if (header === "Confidence Score") {
    return (
      <span className={cn("font-semibold", getTechnicalScanClass(technicalScan || null, row))}>
        {formatTechnicalConfidence(technicalScan || null, row)}
      </span>
    );
  }
  if (header === CURRENT_INVESTMENT_AMOUNT_HEADER) {
    return getFormattedCurrentValueAmount(row, market);
  }
  if (header === ACTION_HEADER && preferActionTag) {
    const action = normalizeAction(row[header] || "");
    if (action) return <FinalActionTag action={action} />;
  }
  const actionEstimate = getDisplayActionEstimate(row);
  const cellValue =
    header === "Units to Sell/Buy"
      ? row[header] ||
        (actionEstimate ? formatQuantity(actionEstimate.units) : "—")
      : header === "Amount"
        ? row[header] ||
          (actionEstimate ? formatDisplayAmount(actionEstimate.amount, market) : "—")
        : row[header];
  if (header === "Stock Symbol" && cellValue) {
    return (
      <TradingViewSymbolLink
        symbol={row["Stock Symbol"] || cellValue}
        market={market}
        exchange={row["Exchange Symbol"]}
        className="hover:text-blue-700"
      >
        <span className="underline-offset-4 hover:underline">{cellValue}</span>
      </TradingViewSymbolLink>
    );
  }
  return cellValue || "";
}

function ScoreMatrixSection({
  stock,
  technicalScan,
  formulaConfig,
  onOpenDetail,
}: {
  stock: StockConsensus;
  technicalScan: TechnicalScanResult | null;
  formulaConfig: ScoreMatrixFormulaConfig;
  onOpenDetail: (detail: ScoreMatrixDetail) => void;
}) {
  const detail = useMemo(
    () => buildScoreMatrixDetail(stock, technicalScan, formulaConfig),
    [formulaConfig, stock, technicalScan],
  );
  const matchedRule = detail.rules.find((rule) => rule.matched);

  return (
    <section className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
      <div className="mb-3">
        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
          Consolidated score matrix
        </div>
        <p className="mt-1 text-xs leading-5 text-slate-600">
          The Mean and Mode row keeps the mode action and the signed mean units change. The
          Formula row applies the Calculated Score matrix to fill the final Action and Units
          Change. Click the formula action to inspect the matched score range.
        </p>
        {matchedRule ? (
          <div className="mt-2 text-xs font-medium text-blue-700">
            Matched rule: {matchedRule.label}
          </div>
        ) : null}
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="min-w-full text-xs">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-100/80 text-left uppercase tracking-wide text-slate-600">
              <th className="px-3 py-2 font-semibold">Source</th>
              <th className="px-3 py-2 font-semibold">Action</th>
              <th className="px-3 py-2 font-semibold">Action Score</th>
              <th className="px-3 py-2 font-semibold">Units Change</th>
              <th className="px-3 py-2 font-semibold">Notes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {detail.rows.map((row) => (
              <tr
                key={row.id}
                className={cn(
                  row.isCalculated
                    ? "bg-rose-100/80"
                    : row.isSummary
                      ? "bg-amber-100/70"
                      : "bg-white",
                )}
              >
                <td className="whitespace-nowrap px-3 py-2 align-top font-medium text-slate-900">
                  {row.source}
                </td>
                <td className="whitespace-nowrap px-3 py-2 align-top">
                  {row.isCalculated && row.action ? (
                    <button
                      type="button"
                      className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-blue-200 bg-white px-2 py-1 transition hover:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      onClick={() => onOpenDetail(detail)}
                    >
                      <FinalActionTag action={row.action} />
                      <span className="text-[11px] font-semibold text-blue-700">View matrix</span>
                    </button>
                  ) : row.action ? (
                    <FinalActionTag action={row.action} />
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2 align-top text-slate-700">
                  {formatActionScore(row.actionScore)}
                </td>
                <td className="whitespace-nowrap px-3 py-2 align-top font-medium text-slate-700">
                  {formatSignedQuantity(row.unitsChange)}
                </td>
                <td className="min-w-[18rem] px-3 py-2 align-top text-slate-600">
                  {row.note}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DetailedRationaleScoreSection({
  detail,
  multiplierDrafts,
  denominatorDraft,
  onMultiplierChange,
  onDenominatorChange,
  onFocusCalculation,
}: {
  detail: ScoreMatrixDetail;
  multiplierDrafts?: Record<string, string>;
  denominatorDraft?: string;
  onMultiplierChange?: (rowId: string, value: string) => void;
  onDenominatorChange?: (value: string) => void;
  onFocusCalculation?: (target: ActionablesCalculationFocusTarget) => void;
}) {
  const openCalculationColumn = (row: DetailedRationaleScoreRow) => {
    const header = getDetailedRationaleCalculationHeader(row);
    if (!header) return;
    onFocusCalculation?.({ stockKey: detail.stockKey, header });
  };

  const rebalanceRows = detail.detailedRationaleRows.filter((row) =>
    [
      "cruxx",
      "technical-short",
      "technical-medium",
      "technical-long",
      "fundamentals-short",
      "fundamentals-medium-long",
    ].includes(row.id),
  );
  const technicalScanRows = detail.detailedRationaleRows.filter((row) =>
    ["technical-scan-confidence", "premarket-trend", "last-5-candles-trend"].includes(row.id),
  );
  const remainingRows = detail.detailedRationaleRows.filter(
    (row) => !rebalanceRows.includes(row) && !technicalScanRows.includes(row),
  );

  const renderRow = (row: DetailedRationaleScoreRow) => (
    <tr key={row.id}>
      <td className="min-w-[24rem] px-4 py-2 text-slate-900">
        {onFocusCalculation && getDetailedRationaleCalculationHeader(row) ? (
          <button
            type="button"
            className="cursor-pointer rounded px-1 py-0.5 text-left underline-offset-4 transition hover:bg-blue-50 hover:text-blue-700 hover:underline focus:outline-none focus:ring-2 focus:ring-blue-500"
            onClick={() => openCalculationColumn(row)}
            title={`Open ${getActionablesCalculationColumnLabel(getDetailedRationaleCalculationHeader(row) ?? "")} for ${detail.stockSymbol}`}
          >
            {row.parameter}
          </button>
        ) : row.parameter}
        {row.missingReason ? (
          <p className="mt-1 max-w-2xl text-xs leading-5 text-amber-700">
            Not updated: {row.missingReason}
          </p>
        ) : null}
      </td>
      <td className="whitespace-nowrap px-4 py-2 text-right font-medium text-slate-900">
        {onFocusCalculation && getDetailedRationaleCalculationHeader(row) ? (
          <button
            type="button"
            className="cursor-pointer rounded px-1.5 py-0.5 font-semibold underline-offset-4 transition hover:bg-blue-50 hover:text-blue-700 hover:underline focus:outline-none focus:ring-2 focus:ring-blue-500"
            onClick={() => openCalculationColumn(row)}
            title={`Open ${getActionablesCalculationColumnLabel(getDetailedRationaleCalculationHeader(row) ?? "")} for ${detail.stockSymbol}`}
          >
            {formatScoreValue(row.score)}
          </button>
        ) : formatScoreValue(row.score)}
      </td>
      <td className="whitespace-nowrap px-4 py-2 text-right font-medium text-slate-900">
        {onMultiplierChange ? (
          <input
            type="number"
            step="0.1"
            value={multiplierDrafts?.[row.id] ?? String(row.multiplier)}
            onChange={(event) => onMultiplierChange(row.id, event.target.value)}
            className="w-20 rounded-md border border-blue-200 bg-blue-50/40 px-2 py-1 text-right font-semibold text-slate-950 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
            aria-label={`Multiplier for ${row.parameter}`}
          />
        ) : row.multiplier}
      </td>
    </tr>
  );

  const renderSourceTag = (label: string | null, runId: number | null) => {
    if (!label) return null;
    const className = "inline-flex max-w-full items-center rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-[11px] font-semibold text-blue-700 shadow-sm transition hover:border-blue-400 hover:bg-blue-100 focus:outline-none focus:ring-2 focus:ring-blue-500";
    return runId ? (
      <Link href={URLs.routes.console.runDetail(runId)} className={className} title={`Open ${label}`}>
        <span className="truncate">{label}</span>
      </Link>
    ) : (
      <span className={cn(className, "text-slate-600")} title={label}>
        <span className="truncate">{label}</span>
      </span>
    );
  };

  const renderGroup = (title: string, description: string, rows: DetailedRationaleScoreRow[], sourceLabel?: string | null, sourceRunId?: number | null) => rows.length ? (
    <section className="rounded-xl border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold text-slate-950">{title}</h3>
          {renderSourceTag(sourceLabel ?? null, sourceRunId ?? null)}
        </div>
        <p className="mt-1 text-xs text-slate-500">{description}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-xs sm:text-sm">
          <thead className="bg-slate-50 text-left text-slate-700">
            <tr>
              <th className="px-4 py-2 font-semibold">Parameter</th>
              <th className="whitespace-nowrap px-4 py-2 text-right font-semibold">Score</th>
              <th className="whitespace-nowrap px-4 py-2 text-right font-semibold">Multiplier</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">{rows.map(renderRow)}</tbody>
        </table>
      </div>
    </section>
  ) : null;

  return (
    <div className="space-y-4">
      {renderGroup(
        "Rebalance Scan",
        `Values drawn from the Rebalance Scan for ${detail.stockSymbol}. Click a parameter or score to open the Actionables Calculations Excel layout at this stock and column.`,
        rebalanceRows,
        detail.rebalanceSourceLabel,
        detail.rebalanceSourceRunId,
      )}
      {renderGroup(
        "Technical Scan",
        `Values drawn from the Technical Scan for ${detail.stockSymbol}. Click a parameter or score to open the technical scan columns at this stock.`,
        technicalScanRows,
        detail.technicalScanSourceLabel,
        detail.technicalScanSourceRunId,
      )}
      {renderGroup(
        "Consolidated action",
        "Final consolidated action score used by the weighted formula.",
        remainingRows,
      )}
      <section className="rounded-xl border border-slate-200 bg-slate-50">
        <div className="grid grid-cols-[1fr_auto_auto] items-center gap-4 px-4 py-3 text-sm font-semibold text-slate-950">
          <div className="text-right">Final score</div>
          <div className="whitespace-nowrap text-right">{formatActionScore(detail.detailedRationaleFinalScore)}</div>
          <div className="whitespace-nowrap text-right">
            {onDenominatorChange ? (
              <div className="inline-flex items-center justify-end gap-1">
                <span>/</span>
                <input
                  type="number"
                  step="0.1"
                  value={denominatorDraft ?? String(detail.detailedRationaleDenominator)}
                  onChange={(event) => onDenominatorChange(event.target.value)}
                  className="w-20 rounded-md border border-blue-200 bg-blue-50/40 px-2 py-1 text-right font-semibold text-slate-950 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
                  aria-label="Detailed rationale score denominator"
                />
              </div>
            ) : (`/ ${detail.detailedRationaleDenominator || "—"}`)}
          </div>
        </div>
      </section>
    </div>
  );
}

function ScoreReferenceTables({
  formulaConfig,
  onFormulaConfigChange,
}: {
  formulaConfig: ScoreMatrixFormulaConfig;
  onFormulaConfigChange?: (updater: (current: ScoreMatrixFormulaConfig) => ScoreMatrixFormulaConfig) => void;
}) {
  const updateActionScore = (action: ActionCategory, value: string) => {
    const parsed = parseFiniteDraft(value);
    if (parsed === null) return;
    onFormulaConfigChange?.((current) => normalizeScoreMatrixFormulaConfig({
      ...current,
      actionScores: { ...current.actionScores, [action]: parsed },
    }));
  };

  const updateTechnicalMultiplier = (key: TechnicalScanMultiplierKey, value: string) => {
    const parsed = parseFiniteDraft(value);
    if (parsed === null) return;
    onFormulaConfigChange?.((current) => normalizeScoreMatrixFormulaConfig({
      ...current,
      technicalScanMultipliers: { ...current.technicalScanMultipliers, [key]: parsed },
    }));
  };

  return (
    <section className="grid gap-4 lg:grid-cols-3">
      <div className="rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-4 py-3">
          <h3 className="font-semibold text-slate-950">Action (Buy/Add/Sell All/Trim/Hold/Buy New) &amp; Score</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-700">
              <tr>
                <th className="px-4 py-2 font-semibold">Action (Buy/Add/Sell All/Trim/Hold/Buy New)</th>
                <th className="px-4 py-2 text-right font-semibold">Score</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {ACTION_SCORE_TABLE_ROWS.map((row) => (
                <tr key={row.label}>
                  <td className="px-4 py-2 text-slate-900">{row.label}</td>
                  <td className="px-4 py-2 text-right font-medium text-slate-900">
                    {onFormulaConfigChange ? (
                      <input
                        type="number"
                        step="0.1"
                        value={formulaConfig.actionScores[row.category]}
                        onChange={(event) => updateActionScore(row.category, event.target.value)}
                        className="w-20 rounded-md border border-blue-200 bg-blue-50/40 px-2 py-1 text-right font-semibold text-slate-950 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
                        aria-label={`Score for ${row.label}`}
                      />
                    ) : formatScoreValue(formulaConfig.actionScores[row.category])}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-4 py-3">
          <h3 className="font-semibold text-slate-950">Technical Scan Confidence Score</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-700">
              <tr>
                <th className="px-4 py-2 font-semibold">Technical Scan</th>
                <th className="px-4 py-2 text-right font-semibold">Multiplier</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {TECHNICAL_SCAN_MULTIPLIER_ROWS.map((row) => (
                <tr key={row.label}>
                  <td className="px-4 py-2 text-slate-900">{row.label}</td>
                  <td className="px-4 py-2 text-right font-medium text-slate-900">
                    {onFormulaConfigChange ? (
                      <input
                        type="number"
                        step="0.1"
                        value={formulaConfig.technicalScanMultipliers[row.key]}
                        onChange={(event) => updateTechnicalMultiplier(row.key, event.target.value)}
                        className="w-20 rounded-md border border-blue-200 bg-blue-50/40 px-2 py-1 text-right font-semibold text-slate-950 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
                        aria-label={`Multiplier for ${row.label} technical scan`}
                      />
                    ) : formulaConfig.technicalScanMultipliers[row.key]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-4 py-3">
          <h3 className="font-semibold text-slate-950">Score Symbol matrix</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-700">
              <tr>
                <th className="px-4 py-2 font-semibold">Score range</th>
                <th className="px-4 py-2 font-semibold">Symbol</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {SCORE_SYMBOL_MATRIX_ROWS.map((row) => (
                <tr key={row.id}>
                  <td className="whitespace-nowrap px-4 py-2 text-slate-900">{row.rangeLabel}</td>
                  <td className="px-4 py-2 font-medium text-slate-900">
                    <span className="inline-flex items-center gap-2">
                      <Triangle
                        className={cn("size-3.5 fill-current", row.className, row.direction === "down" ? "rotate-180" : "")}
                        aria-hidden="true"
                      />
                      {row.symbolLabel}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

export function ScoreMatrixModal({
  detail,
  formulaConfig = DEFAULT_SCORE_MATRIX_FORMULA_CONFIG,
  onFormulaConfigChange,
  onClose,
  onFocusCalculation,
}: {
  detail: ScoreMatrixDetail | null;
  formulaConfig?: ScoreMatrixFormulaConfig;
  onFormulaConfigChange?: (updater: (current: ScoreMatrixFormulaConfig) => ScoreMatrixFormulaConfig) => void;
  onClose: () => void;
  onFocusCalculation?: (target: ActionablesCalculationFocusTarget) => void;
}) {
  const [editState, setEditState] = useState<{
    stockKey: string;
    multiplierDrafts: Record<string, string>;
    denominatorDraft: string;
    ruleDrafts: Record<string, { action?: ActionCategory; unitsChange?: string }>;
  }>({ stockKey: "", multiplierDrafts: {}, denominatorDraft: "", ruleDrafts: {} });
  const multiplierDrafts = useMemo(
    () => (detail && editState.stockKey === detail.stockKey ? editState.multiplierDrafts : {}),
    [detail, editState],
  );
  const denominatorDraft = useMemo(
    () => (detail && editState.stockKey === detail.stockKey ? editState.denominatorDraft : ""),
    [detail, editState],
  );
  const ruleDrafts = useMemo(
    () => (detail && editState.stockKey === detail.stockKey ? editState.ruleDrafts : {}),
    [detail, editState],
  );

  const configuredDetail = useMemo(() => {
    if (!detail) return null;
    return {
      ...detail,
      detailedRationaleRows: detail.detailedRationaleRows.map((row) => {
        if (row.id === "mean-mode-action") {
          return {
            ...row,
            score: detail.meanModeAction ? formulaConfig.actionScores[detail.meanModeAction] : null,
            multiplier: formulaConfig.detailedRationaleMultipliers[row.id] ?? row.multiplier,
          };
        }
        if (row.id === "technical-scan-confidence") {
          const multiplier = row.multiplier === 0
            ? 0
            : row.multiplier > 0
              ? formulaConfig.technicalScanMultipliers.bullish
              : formulaConfig.technicalScanMultipliers.bearish;
          return {
            ...row,
            multiplier,
            denominatorWeight: multiplier === 0 ? 0 : 2,
          };
        }
        return {
          ...row,
          multiplier: formulaConfig.detailedRationaleMultipliers[row.id] ?? row.multiplier,
        };
      }),
      detailedRationaleDenominator: formulaConfig.detailedRationaleDenominator ?? detail.detailedRationaleDenominator,
    };
  }, [detail, formulaConfig]);

  const editedDetail = useMemo(
    () => (configuredDetail ? applyScoreMatrixEdits(configuredDetail, multiplierDrafts, denominatorDraft, ruleDrafts) : null),
    [configuredDetail, multiplierDrafts, denominatorDraft, ruleDrafts],
  );

  if (!editedDetail) return null;

  const matchedRule = editedDetail.rules.find((rule) => rule.matched) ?? null;
  const sourceRows = editedDetail.rows.filter((row) => !row.isSummary);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/55 px-4 py-10"
      role="dialog"
      aria-modal="true"
      aria-labelledby="score-matrix-modal-title"
      onClick={onClose}
    >
      <div
        className="w-full max-w-5xl rounded-2xl bg-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 rounded-t-2xl border-b border-slate-200 bg-white px-5 py-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">
              Consolidated score matrix
            </p>
            <h2 id="score-matrix-modal-title" className="mt-1 text-xl font-bold text-slate-950">
              Final Action Rule
            </h2>
            <div className="mt-2 flex flex-wrap items-baseline gap-2 text-slate-950">
              <span className="text-2xl font-extrabold tracking-tight">{editedDetail.stockSymbol}</span>
              <span className="text-lg font-bold text-slate-800">{editedDetail.stockName}</span>
            </div>
            <p className="mt-1 text-sm text-slate-500">
              {editedDetail.stockExchange || "Unknown exchange"} · {editedDetail.stockSymbol} · calculated score {formatActionScore(editedDetail.detailedRationaleFinalScore)} maps to{" "}
              <FinalActionTag action={editedDetail.calculatedAction} />
              {" "}with units change {formatSignedQuantity(editedDetail.calculatedUnitsChange)}.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {onFocusCalculation ? (
              <button
                type="button"
                onClick={() => onFocusCalculation({ stockKey: editedDetail.stockKey, header: "Stock Info" })}
                className="inline-flex size-9 cursor-pointer items-center justify-center rounded-full border border-blue-200 bg-blue-50 text-blue-700 shadow-sm transition hover:border-blue-400 hover:bg-blue-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                aria-label={`Open Actionables Calculations for ${editedDetail.stockSymbol}`}
                title="Actionables Calculations"
              >
                <ActionablesCalculationsIcon className="size-4" />
              </button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              className="rounded-full p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              aria-label="Close score matrix popup"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="max-h-[78vh] space-y-5 overflow-y-auto px-5 py-5 text-sm">
          <DetailedRationaleScoreSection
            detail={editedDetail}
            multiplierDrafts={multiplierDrafts}
            denominatorDraft={denominatorDraft || String(editedDetail.detailedRationaleDenominator)}
            onMultiplierChange={(rowId, value) => {
              const parsed = parseFiniteDraft(value);
              if (parsed !== null) {
                const editedRow = editedDetail.detailedRationaleRows.find((row) => row.id === rowId);
                onFormulaConfigChange?.((current) => {
                  if (rowId === "technical-scan-confidence") {
                    if (!editedRow || editedRow.multiplier === 0) return current;
                    const multiplierKey: TechnicalScanMultiplierKey = editedRow.multiplier > 0 ? "bullish" : "bearish";
                    return normalizeScoreMatrixFormulaConfig({
                      ...current,
                      technicalScanMultipliers: {
                        ...current.technicalScanMultipliers,
                        [multiplierKey]: parsed,
                      },
                    });
                  }

                  return normalizeScoreMatrixFormulaConfig({
                    ...current,
                    detailedRationaleMultipliers: {
                      ...current.detailedRationaleMultipliers,
                      [rowId]: parsed,
                    },
                  });
                });
              }
              setEditState((current) => ({
                stockKey: editedDetail.stockKey,
                multiplierDrafts: {
                  ...(current.stockKey === editedDetail.stockKey ? current.multiplierDrafts : {}),
                  [rowId]: value,
                },
                denominatorDraft: current.stockKey === editedDetail.stockKey ? current.denominatorDraft : "",
                ruleDrafts: current.stockKey === editedDetail.stockKey ? current.ruleDrafts : {},
              }));
            }}
            onDenominatorChange={(value) => {
              const parsed = parseFiniteDraft(value);
              onFormulaConfigChange?.((current) => normalizeScoreMatrixFormulaConfig({
                ...current,
                detailedRationaleDenominator: parsed,
              }));
              setEditState((current) => ({
                stockKey: editedDetail.stockKey,
                multiplierDrafts: current.stockKey === editedDetail.stockKey ? current.multiplierDrafts : {},
                denominatorDraft: value,
                ruleDrafts: current.stockKey === editedDetail.stockKey ? current.ruleDrafts : {},
              }));
            }}
            onFocusCalculation={onFocusCalculation}
          />

          <ScoreReferenceTables
            formulaConfig={formulaConfig}
            onFormulaConfigChange={onFormulaConfigChange}
          />

          {matchedRule ? (
            <section className="rounded-xl border border-blue-100 bg-blue-50/70 p-4">
              <div className="mb-3">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-700">
                  Matched rule
                </div>
                <h3 className="mt-1 text-base font-semibold text-blue-950">
                  {matchedRule.label}
                </h3>
                <p className="mt-1 text-sm text-blue-900">{matchedRule.summary}</p>
              </div>
              <KeyValueGrid
                itemClassName="border-blue-100 bg-white/80"
                values={[
                  [
                    "Mode action",
                    editedDetail.modeAction ? <FinalActionTag key="mode-action" action={editedDetail.modeAction} /> : "—",
                  ],
                  ["Mean score", formatActionScore(editedDetail.meanScore)],
                  ["Mean units change", formatSignedQuantity(editedDetail.meanUnitsChange)],
                  ["Current units", formatQuantity(editedDetail.currentUnits)],
                  ["Calculated action", <FinalActionTag key="calculated-action" action={editedDetail.calculatedAction} />],
                  [
                    "Calculated units change",
                    formatSignedQuantity(editedDetail.calculatedUnitsChange),
                  ],
                ]}
              />
            </section>
          ) : null}

          <section className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
            <h3 className="mb-3 text-center text-lg font-bold text-slate-950">Calculated Score matrix</h3>
            <div className="overflow-x-auto rounded-lg border border-slate-300 bg-white">
              <table className="mx-auto min-w-[34rem] text-sm">
                <thead className="text-left text-slate-950">
                  <tr className="border-b-2 border-slate-900">
                    <th className="px-3 py-2 text-center font-bold">Score range</th>
                    <th className="px-3 py-2 font-bold">Action</th>
                    <th className="px-3 py-2 font-bold">Units Change</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {editedDetail.rules.map((rule) => (
                    <tr
                      key={rule.id}
                      className={cn(
                        rule.matched
                          ? "bg-blue-50/90 ring-2 ring-inset ring-blue-400"
                          : "bg-white",
                      )}
                    >
                      <td className="whitespace-nowrap px-3 py-2 text-center font-semibold text-slate-900">
                        {rule.label}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">
                        <div className="flex items-center gap-2">
                          <FinalActionTag action={rule.action} />
                          <select
                            value={ruleDrafts[rule.id]?.action ?? rule.action}
                            onChange={(event) =>
                              setEditState((current) => {
                                const currentRules = current.stockKey === editedDetail.stockKey ? current.ruleDrafts : {};
                                return {
                                  stockKey: editedDetail.stockKey,
                                  multiplierDrafts: current.stockKey === editedDetail.stockKey ? current.multiplierDrafts : {},
                                  denominatorDraft: current.stockKey === editedDetail.stockKey ? current.denominatorDraft : "",
                                  ruleDrafts: {
                                    ...currentRules,
                                    [rule.id]: {
                                      ...currentRules[rule.id],
                                      action: event.target.value as ActionCategory,
                                    },
                                  },
                                };
                              })
                            }
                            className="rounded-md border border-blue-200 bg-white px-2 py-1 text-xs font-semibold text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
                            aria-label={`Formula action for ${rule.label}`}
                          >
                            {ACTION_CATEGORIES.map((action) => (
                              <option key={action} value={action}>{ACTION_CATEGORY_LABEL[action]}</option>
                            ))}
                          </select>
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right font-medium text-slate-800">
                        <input
                          type="number"
                          step="0.01"
                          placeholder={rule.action === "Hold"
                            ? "0"
                            : rule.action === "Trim"
                              ? "50%"
                              : rule.action === "Sell All"
                                ? "100%"
                                : "auto"}
                          value={ruleDrafts[rule.id]?.unitsChange ?? ""}
                          onChange={(event) =>
                            setEditState((current) => {
                              const currentRules = current.stockKey === editedDetail.stockKey ? current.ruleDrafts : {};
                              return {
                                stockKey: editedDetail.stockKey,
                                multiplierDrafts: current.stockKey === editedDetail.stockKey ? current.multiplierDrafts : {},
                                denominatorDraft: current.stockKey === editedDetail.stockKey ? current.denominatorDraft : "",
                                ruleDrafts: {
                                  ...currentRules,
                                  [rule.id]: {
                                    ...currentRules[rule.id],
                                    unitsChange: event.target.value,
                                  },
                                },
                              };
                            })
                          }
                          className="w-24 rounded-md border border-blue-200 bg-white px-2 py-1 text-right text-xs font-semibold text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
                          aria-label={`Manual units change for ${rule.label}`}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs leading-5 text-slate-600">
              The highlighted score range drives the Consolidated (Formula) action and units change.
              Actions and manual Units Change values are editable here for what-if formula changes; blank units use the default auto sizing.
            </p>
          </section>

          <section className="rounded-xl border border-violet-100 bg-violet-50/60 p-4">
            <h3 className="mb-3 font-semibold text-violet-950">Rows feeding the matrix</h3>
            <div className="overflow-x-auto rounded-lg border border-violet-100 bg-white/80">
              <table className="min-w-full text-xs">
                <thead className="bg-violet-100/70 text-left uppercase tracking-wide text-violet-900">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Source</th>
                    <th className="px-3 py-2 font-semibold">Action</th>
                    <th className="px-3 py-2 font-semibold">Action Score</th>
                    <th className="px-3 py-2 font-semibold">Units Change</th>
                    <th className="px-3 py-2 font-semibold">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-violet-100">
                  {sourceRows.map((row) => (
                    <tr key={row.id}>
                      <td className="whitespace-nowrap px-3 py-2 align-top font-medium text-slate-900">
                        {row.source}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 align-top">
                        {row.action ? <FinalActionTag action={row.action} /> : "—"}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 align-top text-slate-700">
                        {formatActionScore(row.actionScore)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 align-top text-slate-700">
                        {formatSignedQuantity(row.unitsChange)}
                      </td>
                      <td className="min-w-[18rem] px-3 py-2 align-top text-slate-600">
                        {row.note}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function RunGroupDetails({
  runs,
  latestRun,
  market,
  onBack,
}: {
  runs: RunResponse[];
  latestRun: RunResponse | null;
  market: SwingTradeMarket;
  onBack: () => void;
}) {
  const marketLabel = market === "us" ? "US" : "India";
  const totalLlmJobs = runs.reduce(
    (sum, run) => sum + (run.run_jobs?.length ?? 0),
    0,
  );
  const completedLlmJobs = runs.reduce(
    (sum, run) =>
      sum +
      (run.run_jobs ?? []).filter((link) => isUsableModelOutputStatus(link.job?.status))
        .length,
    0,
  );
  const uniqueLlms = new Set(
    runs.flatMap((run) =>
      (run.run_jobs ?? []).map(
        (link) =>
          `${link.job?.provider || "provider"} ${link.job?.model || "model"}`,
      ),
    ),
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-blue-600">
            Run consolidation details
          </p>
          <h2 className="mt-2 text-2xl font-bold text-gray-900">
            {runs.length} run{runs.length === 1 ? "" : "s"} considered
          </h2>
          <p className="mt-2 max-w-3xl text-sm text-gray-600">
            A run is considered when it is completed, is detected as a{" "}
            {marketLabel} rebalance run, and uses the same rebalance input
            bundle as the latest matching run
            {latestRun ? ` (#${latestRun.id})` : ""}.
          </p>
        </div>
        <Button type="button" variant="outline" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to final actionables
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Consideration summary</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 text-sm text-gray-700 md:grid-cols-4">
          <div>
            <div className="font-semibold text-gray-900">Runs considered</div>
            <div>{runs.length}</div>
          </div>
          <div>
            <div className="font-semibold text-gray-900">
              Latest matching run
            </div>
            <div>{latestRun ? `#${latestRun.id}` : "None found"}</div>
          </div>
          <div>
            <div className="font-semibold text-gray-900">LLMs run</div>
            <div>{uniqueLlms.size}</div>
          </div>
          <div>
            <div className="font-semibold text-gray-900">
              Completed LLM jobs
            </div>
            <div>
              {completedLlmJobs}/{totalLlmJobs}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Runs and LLMs included</CardTitle>
        </CardHeader>
        <CardContent>
          {runs.length ? (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-300 bg-gray-50">
                    <th className="px-3 py-2 text-left font-semibold text-gray-700">
                      Run
                    </th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-700">
                      Run date
                    </th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-700">
                      Rationale for consideration
                    </th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-700">
                      LLMs run
                    </th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-700">
                      Rows used
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {runs.map((run) => {
                    const parsedRows = parseRunRows(run);
                    return (
                      <tr key={run.id}>
                        <td className="whitespace-nowrap px-3 py-3 align-top font-semibold text-gray-900">
                          #{run.id}
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 align-top text-gray-700">
                          {formatDateTime(run.created_at)}
                        </td>
                        <td className="min-w-72 px-3 py-3 align-top text-gray-700">
                          Completed {marketLabel} rebalance run with the same
                          normalized rebalance input bundle as the latest
                          matching run{latestRun ? ` #${latestRun.id}` : ""}.
                        </td>
                        <td className="min-w-64 px-3 py-3 align-top text-gray-700">
                          <div className="space-y-1">
                            {(run.run_jobs ?? []).map((link) => (
                              <div
                                key={link.id}
                                className="rounded border border-gray-200 bg-white px-2 py-1"
                              >
                                <div className="font-medium text-gray-900">
                                  {link.job?.provider || "Unknown provider"}{" "}
                                  {link.job?.model || "Unknown model"}
                                </div>
                                <div className="text-xs text-gray-500">
                                  Job #{link.job_id} ·{" "}
                                  {link.job?.status || "unknown"}
                                </div>
                              </div>
                            ))}
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 align-top text-gray-700">
                          {parsedRows.length}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="py-8 text-center text-sm text-gray-500">
              No runs matched the completed rebalance criteria yet.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

type ActionablesCalculationSortState = {
  key: string;
  direction: "asc" | "desc";
};

type ActionablesCalculationRow = {
  id: string;
  stock: StockConsensus;
  stockLabel: string;
  llmName: string;
  values: Record<string, ReactNode>;
  sortValues: Record<string, string | number>;
  rowClassName: string;
  detail?: ScoreMatrixDetail;
  isFormula?: boolean;
};

const ACTIONABLES_CALCULATION_HEADERS = [
  "Stock Info",
  "Job / Run No (Timestamp)",
  "LLMs",
  ...REBALANCE_HEADER_ORDER.filter(
    (header) => !["Exchange Symbol", "Stock Symbol", "Stock Name"].includes(header),
  ),
  "Technical Setup",
  "Premarket trend",
  "Last 5 candles trend",
  "Confidence Score",
] as const;

type ActionablesCalculationHeader = (typeof ACTIONABLES_CALCULATION_HEADERS)[number];
type ActionablesCalculationColumnLayout = {
  order: ActionablesCalculationHeader[];
  widths: Partial<Record<ActionablesCalculationHeader, number>>;
};

const ACTIONABLES_CALCULATION_LAYOUT_VERSION = 1;
const ACTIONABLES_CALCULATION_MIN_COLUMN_WIDTH = 140;
const ACTIONABLES_CALCULATION_MAX_COLUMN_WIDTH = 760;
const ACTIONABLES_CALCULATION_DEFAULT_WIDTHS: Record<ActionablesCalculationHeader, number> =
  ACTIONABLES_CALCULATION_HEADERS.reduce((acc, header) => {
    acc[header] = header === "Stock Info" ? 272 : 416;
    return acc;
  }, {} as Record<ActionablesCalculationHeader, number>);

function getActionablesCalculationLayoutStorageKey(market: SwingTradeMarket) {
  return `investor:final-actionables:calculation-layout:${market}:v${ACTIONABLES_CALCULATION_LAYOUT_VERSION}`;
}

function isActionablesCalculationHeader(value: string): value is ActionablesCalculationHeader {
  return (ACTIONABLES_CALCULATION_HEADERS as readonly string[]).includes(value);
}

function clampActionablesCalculationColumnWidth(width: number) {
  if (!Number.isFinite(width)) return ACTIONABLES_CALCULATION_DEFAULT_WIDTHS["Stock Info"];
  return Math.min(
    ACTIONABLES_CALCULATION_MAX_COLUMN_WIDTH,
    Math.max(ACTIONABLES_CALCULATION_MIN_COLUMN_WIDTH, Math.round(width)),
  );
}

function createDefaultActionablesCalculationLayout(): ActionablesCalculationColumnLayout {
  return {
    order: [...ACTIONABLES_CALCULATION_HEADERS],
    widths: { ...ACTIONABLES_CALCULATION_DEFAULT_WIDTHS },
  };
}

function normalizeActionablesCalculationLayout(
  layout?: Partial<ActionablesCalculationColumnLayout> | null,
): ActionablesCalculationColumnLayout {
  const seen = new Set<ActionablesCalculationHeader>();
  const order = [
    ...(layout?.order ?? []).filter((header): header is ActionablesCalculationHeader => {
      if (!isActionablesCalculationHeader(header) || seen.has(header)) return false;
      seen.add(header);
      return true;
    }),
    ...ACTIONABLES_CALCULATION_HEADERS.filter((header) => !seen.has(header)),
  ];

  const widths = ACTIONABLES_CALCULATION_HEADERS.reduce((acc, header) => {
    acc[header] = clampActionablesCalculationColumnWidth(
      layout?.widths?.[header] ?? ACTIONABLES_CALCULATION_DEFAULT_WIDTHS[header],
    );
    return acc;
  }, {} as Record<ActionablesCalculationHeader, number>);

  return { order, widths };
}

function loadActionablesCalculationLayout(market: SwingTradeMarket) {
  if (typeof window === "undefined") return createDefaultActionablesCalculationLayout();
  try {
    const raw = window.localStorage.getItem(getActionablesCalculationLayoutStorageKey(market));
    if (!raw) return createDefaultActionablesCalculationLayout();
    return normalizeActionablesCalculationLayout(JSON.parse(raw));
  } catch {
    return createDefaultActionablesCalculationLayout();
  }
}

function reorderActionablesCalculationHeaders(
  order: ActionablesCalculationHeader[],
  from: ActionablesCalculationHeader,
  to: ActionablesCalculationHeader,
) {
  if (from === to) return order;
  const next = order.filter((header) => header !== from);
  const targetIndex = next.indexOf(to);
  if (targetIndex === -1) return order;
  next.splice(targetIndex, 0, from);
  return next;
}

function getActionablesCalculationColumnLabel(header: string) {
  if (header === ACTION_HEADER) return "Action (Buy/Add/Sell All/Trim/Hold/Buy New)";
  return header;
}

function getDetailedRationaleCalculationHeader(row: DetailedRationaleScoreRow): ActionablesCalculationHeader | null {
  const rowHeaderMap: Record<string, ActionablesCalculationHeader> = {
    cruxx: "Score Rationale Cruxx",
    "technical-short": "Score Rationale Technical Setup Short Term 1–3 Months",
    "technical-medium": "Score Rationale - Technical Setup (Medium Term)",
    "technical-long": "Score Rationale - Technical Setup (Long Term)",
    "fundamentals-short": "Score Rationale - Fundamentals Short Term",
    "fundamentals-medium-long": "Score Rationale - Fundamentals Medium/Long Term",
    "technical-scan-confidence": "Confidence Score",
    "premarket-trend": "Premarket trend",
    "last-5-candles-trend": "Last 5 candles trend",
    "mean-mode-action": ACTION_HEADER,
  };

  return rowHeaderMap[row.id] ?? null;
}

function buildSummaryRowCells(
  stock: StockConsensus,
  detail: ScoreMatrixDetail,
  action: ActionCategory | null,
  unitsChange: number | null,
): CanonicalRow {
  const summaryCells = {
    ...stock.representative,
    [ACTION_HEADER]: action ? ACTION_CATEGORY_LABEL[action] : "",
    "Units Change": unitsChange === null ? "" : String(unitsChange),
    "Final Units": unitsChange === null || detail.currentUnits === null ? "" : String(detail.currentUnits + unitsChange),
    "Units to Buy": unitsChange !== null && unitsChange > 0 ? String(unitsChange) : stock.representative["Units to Buy"] || "",
  };

  RATIONALE_TEXT_HEADERS.forEach((header) => {
    summaryCells[header] = "";
  });

  return summaryCells;
}

function getCalculationCellSortValue(value: ReactNode) {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const numeric = parseNumericCell(value);
    return numeric ?? value;
  }
  return "";
}


function getStockSummaryJobRunLabel(stock: StockConsensus) {
  const newestMeta = [...stock.rows]
    .map((row) => row.meta)
    .sort((left, right) => parseTimestampMs(right.createdAt) - parseTimestampMs(left.createdAt))[0];

  return newestMeta ? formatJobRunTimestamp(newestMeta) : "—";
}

function renderStockInfoBlock(
  stock: StockConsensus,
  detailsData?: StockDetailsData,
  market?: SwingTradeMarket,
  technicalScan?: TechnicalScanResult | null,
  onFocusCalculation?: (target: ActionablesCalculationFocusTarget) => void,
) {
  const stockName = stock.representative["Stock Name"] || stock.symbol;
  return (
    <div className="flex min-w-[16rem] items-start gap-2 py-1">
      {detailsData && market ? (
        <StockDetailsButton
          stock={stock}
          market={market}
          technicalScan={technicalScan ?? null}
          detailsData={detailsData}
          onFocusCalculation={onFocusCalculation}
        />
      ) : null}
      <div className="space-y-2 whitespace-normal text-slate-950">
        <div>
          <div className="text-xl font-extrabold leading-6 tracking-tight">{stock.symbol}</div>
          <div className="text-sm font-medium leading-5 text-slate-900">{stockName}</div>
        </div>
        <div className="text-sm font-semibold uppercase tracking-wide text-slate-800">{stock.exchange || "—"}</div>
      </div>
    </div>
  );
}

function buildActionablesCalculationRows(
  stocks: StockConsensus[],
  market: SwingTradeMarket,
  technicalScans: TechnicalScanMap,
  formulaConfig: ScoreMatrixFormulaConfig,
  setupGroups?: Record<string, SetupStockGroup>,
  onSetupClick?: (group: SetupStockGroup) => void,
  onMatrixOpen?: (detail: ScoreMatrixDetail) => void,
): ActionablesCalculationRow[] {
  const technicalScanSourceLabel = getLatestTechnicalScanSourceLabel(technicalScans);

  return stocks.flatMap((stock) => {
    const technicalScan = getTechnicalScanForStock(technicalScans, stock);
    const detail = buildScoreMatrixDetail(stock, technicalScan, formulaConfig, technicalScanSourceLabel);
    const meanModeCells = buildSummaryRowCells(stock, detail, detail.meanModeAction, detail.meanModeUnitsChange);
    const formulaCells = buildSummaryRowCells(stock, detail, detail.calculatedAction, detail.calculatedUnitsChange);
    const stockLabel = `${stock.exchange || "—"} · ${stock.symbol} · ${stock.representative["Stock Name"] || stock.symbol}`;

    const sourceRows: Array<{
      id: string;
      jobRun: string;
      llmName: string;
      cells: CanonicalRow;
      rowClassName: string;
      detail?: ScoreMatrixDetail;
      runId?: number;
      isConsolidated?: boolean;
      isFormula?: boolean;
    }> = [
      ...stock.rows.map((row) => ({
        id: `${stock.key}-${row.meta.runId}-${row.meta.jobId}`,
        jobRun: formatJobRunTimestamp(row.meta),
        llmName: `${row.meta.provider} ${row.meta.model}`.trim(),
        cells: row.cells,
        rowClassName: "bg-white",
        runId: row.meta.runId,
      })),
      {
        id: `${stock.key}-mean-mode`,
        jobRun: getStockSummaryJobRunLabel(stock),
        llmName: "Consolidated (Mean and Mode)",
        cells: meanModeCells,
        rowClassName: "bg-amber-100/70 font-semibold",
        isConsolidated: true,
      },
      {
        id: `${stock.key}-formula`,
        jobRun: getStockSummaryJobRunLabel(stock),
        llmName: "Consolidated (Formula)",
        cells: formulaCells,
        rowClassName: "bg-rose-100/75 font-semibold",
        detail,
        isConsolidated: true,
        isFormula: true,
      },
    ];

    return sourceRows.map((source) => {
      const jobRunValue = source.isConsolidated
        ? source.llmName
        : source.runId
          ? <RunJobLink runId={source.runId}>{source.jobRun}</RunJobLink>
          : source.jobRun;
      const values: Record<string, ReactNode> = {
        "Stock Info": stockLabel,
        "Job / Run No (Timestamp)": jobRunValue,
        LLMs: source.isConsolidated ? "" : source.llmName,
      };
      const sortValues: Record<string, string | number> = {
        "Stock Info": stockLabel,
        "Job / Run No (Timestamp)": source.isConsolidated ? source.llmName : source.jobRun,
        LLMs: source.isConsolidated ? "" : source.llmName,
      };

      ACTIONABLES_CALCULATION_HEADERS.forEach((header) => {
        if (header === "Stock Info" || header === "Job / Run No (Timestamp)" || header === "LLMs") return;
        if (header === ACTION_HEADER && source.isFormula && source.detail) {
          values[header] = (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-blue-200 bg-white px-2 py-1 transition hover:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                onClick={() => onMatrixOpen?.(source.detail!)}
              >
                <FinalActionTag action={source.detail.calculatedAction} />
                <span className="text-[11px] font-semibold text-blue-700">Matrix</span>
              </button>
              <span className="whitespace-nowrap text-xs font-bold text-blue-700">
                Final Score = {formatActionScore(source.detail.calculatedScore)}
              </span>
            </div>
          );
          sortValues[header] = ACTION_CATEGORY_LABEL[source.detail.calculatedAction];
          return;
        }
        if (header === ACTION_HEADER) {
          const action = normalizeAction(source.cells[ACTION_HEADER] || "");
          values[header] = action ? <FinalActionTag action={action} /> : source.cells[ACTION_HEADER] || "";
          sortValues[header] = action ? ACTION_CATEGORY_LABEL[action] : source.cells[ACTION_HEADER] || "";
          return;
        }
        if (header === "Technical Setup") {
          if (source.isConsolidated) {
            values[header] = "";
            sortValues[header] = "";
            return;
          }
          const setup = formatTechnicalSetup(technicalScan, stock.representative);
          values[header] = (
            <span className={cn("font-medium", getTechnicalScanClass(technicalScan, stock.representative))}>
              <TechnicalSetupLink
                setup={setup}
                setupGroup={getSetupStockGroup(setupGroups, setup)}
                onSetupClick={onSetupClick}
              />
            </span>
          );
          sortValues[header] = setup;
          return;
        }
        if (header === "Premarket trend") {
          const premarketTrend = formatTechnicalPremarketTrend(technicalScan, stock.representative);
          values[header] = premarketTrend;
          sortValues[header] = parseNumericCell(premarketTrend) ?? premarketTrend;
          return;
        }
        if (header === "Last 5 candles trend") {
          const last5CandlesTrend = formatTechnicalLast5CandlesTrend(technicalScan, stock.representative);
          values[header] = last5CandlesTrend;
          sortValues[header] = parseNumericCell(last5CandlesTrend) ?? last5CandlesTrend;
          return;
        }
        if (header === "Confidence Score") {
          const confidence = formatTechnicalConfidence(technicalScan, stock.representative);
          values[header] = (
            <span className={cn("font-semibold", getTechnicalScanClass(technicalScan, stock.representative))}>
              {confidence}
            </span>
          );
          sortValues[header] = parseNumericCell(confidence) ?? confidence;
          return;
        }
        const shouldClearConsolidatedCell = source.isConsolidated && header === "Analyst/Source";
        const cellValue = shouldClearConsolidatedCell ? "" : source.cells[header as RebalanceHeader] || "";
        values[header] = cellValue;
        sortValues[header] = getCalculationCellSortValue(cellValue);
      });

      return {
        id: source.id,
        stock,
        stockLabel,
        llmName: source.llmName,
        values,
        sortValues,
        rowClassName: source.rowClassName,
        detail: source.detail,
        isFormula: source.isFormula,
      };
    });
  });
}

function compareActionablesCalculationRows(
  left: ActionablesCalculationRow,
  right: ActionablesCalculationRow,
  sortState: ActionablesCalculationSortState,
) {
  const leftValue = left.sortValues[sortState.key] ?? "";
  const rightValue = right.sortValues[sortState.key] ?? "";
  let comparison = 0;
  if (typeof leftValue === "number" && typeof rightValue === "number") {
    comparison = leftValue - rightValue;
  } else {
    comparison = String(leftValue).localeCompare(String(rightValue), undefined, {
      sensitivity: "base",
      numeric: true,
    });
  }
  if (comparison === 0) comparison = left.id.localeCompare(right.id);
  return sortState.direction === "asc" ? comparison : -comparison;
}

function buildActionablesCalculationRowGroups(
  rows: ActionablesCalculationRow[],
  sortState: ActionablesCalculationSortState,
  market: SwingTradeMarket,
  technicalScans: TechnicalScanMap,
  detailsData?: StockDetailsData,
  onFocusCalculation?: (target: ActionablesCalculationFocusTarget) => void,
): ActionablesCalculationRowGroup[] {
  const groupMap = new Map<string, ActionablesCalculationRowGroup>();

  rows.forEach((row) => {
    const existing = groupMap.get(row.stock.key);
    if (existing) {
      existing.rows.push(row);
      return;
    }

    groupMap.set(row.stock.key, {
      stockKey: row.stock.key,
      stock: row.stock,
      stockInfo: renderStockInfoBlock(
        row.stock,
        detailsData,
        market,
        getTechnicalScanForStock(technicalScans, row.stock),
        onFocusCalculation,
      ),
      sortValues: row.sortValues,
      rows: [row],
    });
  });

  return [...groupMap.values()].sort((left, right) => {
    const representativeLeft = { ...left.rows[0], sortValues: left.sortValues };
    const representativeRight = { ...right.rows[0], sortValues: right.sortValues };
    return compareActionablesCalculationRows(representativeLeft, representativeRight, sortState);
  });
}

function ScrollableCalculationCell({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "max-h-24 max-w-full overflow-auto whitespace-normal break-words pr-1",
        className,
      )}
    >
      {children}
    </div>
  );
}

function SortableCalculationHeader({
  header,
  sortState,
  onSort,
}: {
  header: string;
  sortState: ActionablesCalculationSortState;
  onSort: (header: string) => void;
}) {
  const isActive = sortState.key === header;
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 text-left font-bold text-slate-800 transition hover:text-blue-700"
      onClick={() => onSort(header)}
      title={`Sort ${getActionablesCalculationColumnLabel(header)}`}
    >
      {getActionablesCalculationColumnLabel(header)}
      {isActive ? (
        sortState.direction === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />
      ) : (
        <span className="text-slate-300">↕</span>
      )}
    </button>
  );
}

function ActionablesFormulaModal({
  open,
  formulaConfig,
  onFormulaConfigChange,
  onClose,
}: {
  open: boolean;
  formulaConfig: ScoreMatrixFormulaConfig;
  onFormulaConfigChange: (updater: (current: ScoreMatrixFormulaConfig) => ScoreMatrixFormulaConfig) => void;
  onClose: () => void;
}) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-slate-950/55 px-4 py-10"
      role="dialog"
      aria-modal="true"
      aria-labelledby="actionables-formula-modal-title"
      onClick={onClose}
    >
      <div className="w-full max-w-4xl rounded-2xl bg-white shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">Actionables calculations</p>
            <h2 id="actionables-formula-modal-title" className="mt-1 text-xl font-bold text-slate-950">Logics and formulas</h2>
          </div>
          <button type="button" onClick={onClose} className="rounded-full p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500" aria-label="Close formulas popup">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="max-h-[75vh] space-y-4 overflow-y-auto p-5 text-sm text-slate-700">
          <DetailedRationaleScoreSection detail={{
            stockKey: "formula-reference",
            stockSymbol: "Reference",
            stockName: "Reference",
            stockExchange: "",
            currentUnits: null,
            modeAction: null,
            meanScore: null,
            meanUnitsChange: null,
            calculatedScore: null,
            meanModeAction: null,
            meanModeUnitsChange: null,
            calculatedAction: "Hold",
            calculatedUnitsChange: 0,
            matchedRuleId: "",
            rows: [],
            rules: [],
            detailedRationaleRows: [
              { id: "cruxx", parameter: "Average of Score Rationale Cruxx", score: null, multiplier: 3 },
              { id: "technical-short", parameter: "Average of Score Rationale - Technical Setup (Short Term 1–3 Months)", score: null, multiplier: 3 },
              { id: "technical-medium", parameter: "Average of Score Rationale - Technical Setup (Medium Term)", score: null, multiplier: 2 },
              { id: "technical-long", parameter: "Average of Score Rationale - Technical Setup (Long Term)", score: null, multiplier: 1 },
              { id: "fundamentals-short", parameter: "Average of Score Rationale - Fundamentals Short Term", score: null, multiplier: 3 },
              { id: "fundamentals-medium-long", parameter: "Average of Score Rationale - Fundamentals Medium/Long Term", score: null, multiplier: 1 },
            ],
            detailedRationaleFinalScore: null,
            detailedRationaleDenominator: 13,
            rebalanceSourceLabel: null,
            rebalanceSourceRunId: null,
            technicalScanSourceLabel: null,
            technicalScanSourceRunId: null,
          }} />
          <ScoreReferenceTables
            formulaConfig={formulaConfig}
            onFormulaConfigChange={onFormulaConfigChange}
          />
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <h3 className="font-semibold text-slate-950">Consolidation rules</h3>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>Consolidated (Mean and Mode) uses the mode action across LLM rows and averages numeric sizing/rationale columns.</li>
              <li>Consolidated (Formula) uses the weighted Calculated Score and the Calculated Score matrix to set Action and Units Change.</li>
              <li>Technical Setup, Premarket trend, Last 5 candles trend, and Confidence Score are appended from the latest Technical Scan for the stock.</li>
              <li>Rows with no stocks for Sell All, Add More, Buy New, Trim, or Hold are hidden.</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

function ActionablesInputSelectionDialog({
  open,
  candidates,
  selectedIds,
  usdInrRate,
  onToggle,
  onToggleAll,
  onResetDefaults,
  onClose,
}: {
  open: boolean;
  candidates: ActionablesInputCandidate[];
  selectedIds: Set<string>;
  usdInrRate: number;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  onResetDefaults: () => void;
  onClose: () => void;
}) {
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const [expandedRunKeys, setExpandedRunKeys] = useState<Set<string>>(() => new Set());
  const allSelected = candidates.length > 0 && candidates.every((candidate) => selectedIds.has(candidate.id));
  const someSelected = candidates.some((candidate) => selectedIds.has(candidate.id));
  const selectedCount = candidates.filter((candidate) => selectedIds.has(candidate.id)).length;

  const runGroups = useMemo(() => {
    const groups = new Map<
      string,
      {
        key: string;
        runId: number;
        title: string;
        timestamp: string | null;
        market: SwingTradeMarket;
        candidates: ActionablesInputCandidate[];
      }
    >();

    candidates.forEach((candidate) => {
      const key = `run:${candidate.runId}`;
      const existing = groups.get(key);
      if (existing) {
        existing.candidates.push(candidate);
        if (
          candidate.timestamp &&
          (!existing.timestamp || parseTimestampMs(candidate.timestamp) > parseTimestampMs(existing.timestamp))
        ) {
          existing.timestamp = candidate.timestamp;
        }
        return;
      }

      groups.set(key, {
        key,
        runId: candidate.runId,
        title: candidate.runLabel,
        timestamp: candidate.timestamp,
        market: candidate.market,
        candidates: [candidate],
      });
    });

    return Array.from(groups.values()).sort(
      (left, right) => parseTimestampMs(right.timestamp) - parseTimestampMs(left.timestamp),
    );
  }, [candidates]);

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someSelected && !allSelected;
    }
  }, [allSelected, someSelected]);

  if (!open) return null;

  const toggleRunGroup = (groupCandidates: ActionablesInputCandidate[]) => {
    const groupAllSelected = groupCandidates.every((candidate) => selectedIds.has(candidate.id));
    groupCandidates.forEach((candidate) => {
      if (groupAllSelected ? selectedIds.has(candidate.id) : !selectedIds.has(candidate.id)) {
        onToggle(candidate.id);
      }
    });
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-[28px] bg-white shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex shrink-0 items-start justify-between gap-4 px-6 pb-4 pt-6">
          <div>
            <h3 className="text-2xl font-extrabold tracking-tight text-slate-950">Select Actionables inputs</h3>
            <p className="mt-2 text-base text-slate-500">
              Choose which previous-stage outputs should be included in the calculations table.
            </p>
            <div className="mt-3 max-w-3xl rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium leading-6 text-amber-800">
              <span className="font-extrabold">Input selection rationale:</span>{" "}
              Use selected Rebalance Scan outputs and Technical Scan outputs so final actionables combine portfolio rebalance intent with chart validation.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close input selection"
          >
            <X className="size-5" />
          </button>
        </div>
        <div className="mx-6 mb-4 flex shrink-0 items-center justify-between gap-3 rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm font-semibold text-blue-950">
          <span>{selectedCount} output{selectedCount === 1 ? "" : "s"} selected.</span>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-[0.18em] text-blue-950">
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allSelected}
                onChange={onToggleAll}
                aria-label="Select or deselect all inputs"
              />
              Select all
            </label>
            <button
              type="button"
              onClick={onResetDefaults}
              className="rounded-full border border-slate-300 bg-white px-5 py-2 text-xs font-extrabold uppercase tracking-[0.18em] text-slate-900 shadow-sm hover:bg-slate-50"
            >
              Reset defaults
            </button>
          </div>
        </div>
        <div className="mx-6 min-h-0 flex-1 overflow-auto rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
          {candidates.length === 0 ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-8 text-sm text-slate-500">
              No eligible Rebalance Scan or Technical Scan outputs are available yet.
            </div>
          ) : (
            <div className="space-y-3">
              {runGroups.map((group) => {
                const groupSelectedCount = group.candidates.filter((candidate) => selectedIds.has(candidate.id)).length;
                const groupAllSelected = groupSelectedCount === group.candidates.length;
                const expanded = expandedRunKeys.has(group.key);
                const statusSummary = Array.from(new Set(group.candidates.map((candidate) => candidate.status || "unknown"))).join(", ");
                const stageSummary = Array.from(new Set(group.candidates.map((candidate) => candidate.kind === "rebalance" ? "Rebalance Scan" : "Technical Scan"))).join(" + ");
                const totalCostUsd = group.candidates.reduce(
                  (total, candidate) => total + (typeof candidate.costUsd === "number" ? candidate.costUsd : 0),
                  0,
                );

                return (
                  <div key={group.key} className="rounded-2xl border border-slate-200 bg-white shadow-sm">
                    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                      <input
                        type="checkbox"
                        checked={groupAllSelected}
                        onChange={() => toggleRunGroup(group.candidates)}
                        aria-label={`Select all LLM jobs in ${group.title}`}
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedRunKeys((current) => {
                            const next = new Set(current);
                            if (next.has(group.key)) next.delete(group.key);
                            else next.add(group.key);
                            return next;
                          })
                        }
                        className="flex items-center gap-2 rounded-full px-2 py-1 text-left font-extrabold text-slate-950 hover:bg-slate-100"
                        aria-expanded={expanded}
                      >
                        {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                        {group.title}
                      </button>
                      <span
                        className={cn(
                          "rounded-full border px-3 py-1 text-xs font-extrabold uppercase tracking-[0.14em]",
                          getInputMarketBadgeClass(group.market),
                        )}
                        title={`Scan market: ${getInputMarketLabel(group.market)}`}
                      >
                        {getInputMarketLabel(group.market)}
                      </span>
                      <RunJobLink runId={group.runId}>{stageSummary}</RunJobLink>
                      <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-bold text-blue-800">
                        {groupSelectedCount}/{group.candidates.length} LLM job{group.candidates.length === 1 ? "" : "s"} selected
                      </span>
                      <span className="text-sm text-slate-500">{group.timestamp ? formatDateTime(group.timestamp) : "—"}</span>
                      <span className="text-sm capitalize text-slate-500">{statusSummary}</span>
                      <span className="ml-auto text-sm font-semibold text-slate-600">
                        {totalCostUsd > 0 ? `₹${(totalCostUsd * usdInrRate).toFixed(2)}` : "Cost n/a"}
                      </span>
                    </div>
                    {expanded ? (
                      <div className="border-t border-slate-100 px-4 pb-4 pt-2">
                        <table className="w-full min-w-[760px] text-left text-sm">
                          <thead className="text-xs font-extrabold uppercase tracking-wide text-slate-500">
                            <tr>
                              <th className="w-10 py-2 pr-3">Select</th>
                              <th className="px-3 py-2">Job</th>
                              <th className="px-3 py-2">Timestamp</th>
                              <th className="px-3 py-2">Status</th>
                              <th className="px-3 py-2">Market</th>
                              <th className="px-3 py-2">LLM / Source</th>
                              <th className="px-3 py-2">Cost (INR)</th>
                              <th className="px-3 py-2">Error</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {group.candidates.map((candidate) => (
                              <tr key={candidate.id} className={candidate.kind === "technical" ? "bg-blue-50/60" : "bg-white"}>
                                <td className="py-3 pr-3 align-top">
                                  <input
                                    type="checkbox"
                                    checked={selectedIds.has(candidate.id)}
                                    onChange={() => onToggle(candidate.id)}
                                    aria-label={`Select ${candidate.label}`}
                                  />
                                </td>
                                <td className="px-3 py-3 align-top font-semibold text-slate-900">
                                  <RunJobLink runId={candidate.runId}>{candidate.jobNo}</RunJobLink>
                                </td>
                                <td className="px-3 py-3 align-top text-slate-600">{candidate.timestamp ? formatDateTime(candidate.timestamp) : "—"}</td>
                                <td className="px-3 py-3 align-top">
                                  <span className={cn("rounded-full px-2 py-1 text-xs font-semibold capitalize ring-1", getInputStatusBadgeClass(candidate.status))}>{candidate.status}</span>
                                </td>
                                <td className="px-3 py-3 align-top">
                                  <span className={cn("rounded-full border px-2 py-1 text-xs font-bold", getInputMarketBadgeClass(candidate.market))}>
                                    {getInputMarketLabel(candidate.market)}
                                  </span>
                                </td>
                                <td className="px-3 py-3 align-top text-slate-700">{candidate.label}</td>
                                <td className="px-3 py-3 align-top text-slate-600">
                                  {typeof candidate.costUsd === "number" ? `₹${(candidate.costUsd * usdInrRate).toFixed(2)}` : "n/a"}
                                </td>
                                <td className="max-w-xs px-3 py-3 align-top text-xs text-red-700">{candidate.error || "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="flex shrink-0 justify-end px-6 py-5">
          <Button
            type="button"
            onClick={onClose}
            className="rounded-full bg-slate-950 px-7 font-extrabold uppercase tracking-[0.18em] text-white hover:bg-slate-800"
          >
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}

function ActionablesCalculationsModal({
  open,
  onClose,
  title,
  market,
  stocks,
  technicalScans,
  formulaConfig,
  onFormulaConfigChange,
  setupGroups,
  runs,
  detailsData,
  onSetupClick,
  focusTarget,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  market: SwingTradeMarket;
  stocks: StockConsensus[];
  technicalScans: TechnicalScanMap;
  formulaConfig: ScoreMatrixFormulaConfig;
  onFormulaConfigChange: (updater: (current: ScoreMatrixFormulaConfig) => ScoreMatrixFormulaConfig) => void;
  setupGroups?: Record<string, SetupStockGroup>;
  runs?: RunResponse[];
  detailsData?: StockDetailsData;
  onSetupClick?: (group: SetupStockGroup) => void;
  focusTarget?: ActionablesCalculationFocusTarget | null;
}) {
  const [sortState, setSortState] = useState<ActionablesCalculationSortState>({ key: "Stock Info", direction: "asc" });
  const [columnLayout, setColumnLayout] = useState<ActionablesCalculationColumnLayout>(() => loadActionablesCalculationLayout(market));
  const [draggedHeader, setDraggedHeader] = useState<ActionablesCalculationHeader | null>(null);
  const resizeStateRef = useRef<{ header: ActionablesCalculationHeader; startX: number; startWidth: number } | null>(null);
  const targetCellRef = useRef<HTMLTableCellElement | null>(null);
  const [formulaOpen, setFormulaOpen] = useState(false);
  const [inputSelectionOpen, setInputSelectionOpen] = useState(false);
  const [selectedInputIds, setSelectedInputIds] = useState<Set<string> | null>(null);
  const [selectedMatrixDetail, setSelectedMatrixDetail] = useState<ScoreMatrixDetail | null>(null);
  const [internalFocusTarget, setInternalFocusTarget] = useState<ActionablesCalculationFocusTarget | null>(null);
  const activeFocusTarget = focusTarget ?? internalFocusTarget;
  const usdInrRate = useUsdInrRate();
  const allRuns = useMemo(() => runs ?? [], [runs]);
  const inputCandidates = useMemo(
    () => buildActionablesInputCandidates(allRuns, market),
    [allRuns, market],
  );
  const defaultInputIds = useMemo(
    () => getDefaultActionablesInputIds(inputCandidates, allRuns, market),
    [allRuns, inputCandidates, market],
  );

  const effectiveSelectedInputIds = useMemo(
    () => selectedInputIds ?? new Set(defaultInputIds),
    [defaultInputIds, selectedInputIds],
  );

  const selectedRebalanceRuns = useMemo(
    () => filterRunsBySelectedActionablesInputs(allRuns, "rebalance", effectiveSelectedInputIds),
    [allRuns, effectiveSelectedInputIds],
  );
  const selectedTechnicalRuns = useMemo(
    () => filterRunsBySelectedActionablesInputs(allRuns, "technical", effectiveSelectedInputIds),
    [allRuns, effectiveSelectedInputIds],
  );
  const hasSelectableRebalanceInputs = inputCandidates.some((candidate) => candidate.kind === "rebalance");
  const hasSelectableTechnicalInputs = inputCandidates.some((candidate) => candidate.kind === "technical");
  const displayedStocks = useMemo(
    () => hasSelectableRebalanceInputs
      ? buildConsensusRows(selectedRebalanceRuns, market, detailsData?.portfolioSnapshot)
      : stocks,
    [detailsData?.portfolioSnapshot, hasSelectableRebalanceInputs, market, selectedRebalanceRuns, stocks],
  );
  const displayedTechnicalScans = useMemo(
    () => hasSelectableTechnicalInputs ? buildTechnicalScanMap(selectedTechnicalRuns) : technicalScans,
    [hasSelectableTechnicalInputs, selectedTechnicalRuns, technicalScans],
  );
  const displayedSetupGroups = useMemo(
    () => getSetupStockGroups(displayedStocks, displayedTechnicalScans, market),
    [displayedStocks, displayedTechnicalScans, market],
  );
  const rows = useMemo(
    () => buildActionablesCalculationRows(displayedStocks, market, displayedTechnicalScans, formulaConfig, displayedSetupGroups ?? setupGroups, onSetupClick, setSelectedMatrixDetail),
    [displayedSetupGroups, displayedStocks, displayedTechnicalScans, formulaConfig, market, onSetupClick, setupGroups],
  );
  const rowGroups = useMemo(
    () => buildActionablesCalculationRowGroups(rows, sortState, market, displayedTechnicalScans, detailsData, setInternalFocusTarget),
    [detailsData, displayedTechnicalScans, market, rows, sortState],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      getActionablesCalculationLayoutStorageKey(market),
      JSON.stringify(normalizeActionablesCalculationLayout(columnLayout)),
    );
  }, [columnLayout, market]);

  useEffect(() => {
    return () => {
      resizeStateRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!open || !activeFocusTarget) return;

    targetCellRef.current = null;
    const frameId = window.requestAnimationFrame(() => {
      targetCellRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "center",
        inline: "center",
      });
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [activeFocusTarget, open, rowGroups]);

  if (!open) return null;

  const orderedHeaders = columnLayout.order;

  const updateColumnWidth = (header: ActionablesCalculationHeader, width: number) => {
    setColumnLayout((current) => ({
      ...current,
      widths: {
        ...current.widths,
        [header]: clampActionablesCalculationColumnWidth(width),
      },
    }));
  };

  const handleResizeStart = (header: ActionablesCalculationHeader, event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    resizeStateRef.current = {
      header,
      startX: event.clientX,
      startWidth: columnLayout.widths[header] ?? ACTIONABLES_CALCULATION_DEFAULT_WIDTHS[header],
    };

    const handleMouseMove = (moveEvent: globalThis.MouseEvent) => {
      const state = resizeStateRef.current;
      if (!state) return;
      updateColumnWidth(state.header, state.startWidth + moveEvent.clientX - state.startX);
    };
    const handleMouseUp = () => {
      resizeStateRef.current = null;
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  const handleHeaderDrop = (targetHeader: ActionablesCalculationHeader, event: ReactDragEvent<HTMLTableCellElement>) => {
    event.preventDefault();
    const sourceHeader = draggedHeader;
    setDraggedHeader(null);
    if (!sourceHeader || sourceHeader === targetHeader) return;
    setColumnLayout((current) => ({
      ...current,
      order: reorderActionablesCalculationHeaders(current.order, sourceHeader, targetHeader),
    }));
  };

  const toggleSort = (header: string) => {
    setSortState((current) => current.key === header
      ? { key: header, direction: current.direction === "asc" ? "desc" : "asc" }
      : { key: header, direction: header === "Stock Info" || header === "Job / Run No (Timestamp)" || header === "LLMs" || header === "Technical Setup" ? "asc" : "desc" });
  };

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/55 px-4 py-10"
        role="dialog"
        aria-modal="true"
        aria-labelledby="actionables-calculations-modal-title"
        onClick={onClose}
      >
        <div className="w-full max-w-[96vw] rounded-2xl bg-white shadow-2xl" onClick={(event) => event.stopPropagation()}>
          <div className="sticky top-0 z-10 flex items-start justify-between gap-4 rounded-t-2xl border-b border-slate-200 bg-white px-5 py-4">
            <div className="flex items-start gap-3">
              <button
                type="button"
                onClick={() => setInputSelectionOpen(true)}
                className="mt-1 inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full border border-blue-200 bg-white text-blue-700 shadow-sm transition hover:border-blue-400 hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
                aria-label="Select inputs for Actionables Calculations"
                title="Select Inputs"
              >
                <SelectInputsIcon className="size-6" />
              </button>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">Actionables Calculations</p>
                <h2 id="actionables-calculations-modal-title" className="mt-1 text-2xl font-bold text-slate-950">{title} Excel layout</h2>
                <p className="mt-1 text-sm text-slate-500">Grouped in the same rebalance export column order with sortable Excel-style headers.</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setFormulaOpen(true)} className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700 transition hover:border-blue-400 hover:bg-blue-100 focus:outline-none focus:ring-2 focus:ring-blue-500" title="Show logics and formulas">
                <FunctionSquare className="size-4" />
                Logics & formulas
              </button>
              <button type="button" onClick={onClose} className="rounded-full p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500" aria-label="Close Actionables Calculations popup">
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>
          <div className="border-b border-blue-100 bg-blue-50/50 px-5 py-3 text-sm text-blue-900">
            LLMs consolidated in this view: {Math.max(...displayedStocks.map((stock) => stock.rows.length), 0)}. Stocks: {displayedStocks.length}.
          </div>
          <div className="max-h-[76vh] overflow-auto p-5">
            {rowGroups.length ? (
              <table className="w-max table-fixed border-collapse text-sm">
                <thead className="sticky top-0 z-10 bg-slate-100 text-left">
                  <tr>
                    {orderedHeaders.map((header) => {
                      const width = columnLayout.widths[header] ?? ACTIONABLES_CALCULATION_DEFAULT_WIDTHS[header];
                      return (
                        <th
                          key={header}
                          draggable
                          onDragStart={(event) => {
                            setDraggedHeader(header);
                            event.dataTransfer.effectAllowed = "move";
                            event.dataTransfer.setData("text/plain", header);
                          }}
                          onDragOver={(event) => {
                            event.preventDefault();
                            event.dataTransfer.dropEffect = "move";
                          }}
                          onDrop={(event) => handleHeaderDrop(header, event)}
                          onDragEnd={() => setDraggedHeader(null)}
                          className={cn(
                            "group relative border border-slate-300 px-3 py-3 align-bottom transition",
                            draggedHeader === header ? "bg-blue-100" : "",
                          )}
                          style={{ width, minWidth: width, maxWidth: width }}
                          title="Drag left/right to reorder. Use the right edge to resize."
                        >
                          <ScrollableCalculationCell className="max-h-16 pr-3">
                            <SortableCalculationHeader header={header} sortState={sortState} onSort={toggleSort} />
                          </ScrollableCalculationCell>
                          <button
                            type="button"
                            className="absolute right-0 top-0 h-full w-2 cursor-col-resize border-r-2 border-transparent transition hover:border-blue-500 focus:border-blue-500 focus:outline-none"
                            aria-label={`Resize ${getActionablesCalculationColumnLabel(header)} column`}
                            onMouseDown={(event) => handleResizeStart(header, event)}
                          />
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {rowGroups.map((group, groupIndex) => (
                    <Fragment key={group.stockKey}>
                      {group.rows.map((row, rowIndex) => (
                        <tr key={row.id} className={cn(row.rowClassName, rowIndex === 0 ? "border-t-2 border-slate-900" : "border-t border-slate-900")}>
                          {orderedHeaders.map((header) => {
                            const width = columnLayout.widths[header] ?? ACTIONABLES_CALCULATION_DEFAULT_WIDTHS[header];
                            if (header === "Stock Info") {
                              return rowIndex === 0 ? (
                                <td
                                  key={`${group.stockKey}-stock-info`}
                                  ref={(node) => {
                                    if (activeFocusTarget?.stockKey === group.stockKey && activeFocusTarget.header === "Stock Info") {
                                      targetCellRef.current = node;
                                    }
                                  }}
                                  rowSpan={group.rows.length}
                                  className="sticky left-0 z-[1] overflow-hidden border border-slate-900 bg-white px-2 py-3 align-middle text-slate-900 shadow-[2px_0_0_rgba(15,23,42,0.08)]"
                                  style={{ width, minWidth: width, maxWidth: width }}
                                >
                                  <ScrollableCalculationCell
                                    className={cn(
                                      "max-h-36",
                                      activeFocusTarget?.stockKey === group.stockKey && activeFocusTarget.header === "Stock Info"
                                        ? "rounded bg-blue-100 p-1 ring-2 ring-blue-400"
                                        : "",
                                    )}
                                  >
                                    {group.stockInfo}
                                  </ScrollableCalculationCell>
                                </td>
                              ) : null;
                            }

                            return (
                              <td
                                key={`${row.id}-${header}`}
                                ref={(node) => {
                                  if (activeFocusTarget?.stockKey === group.stockKey && activeFocusTarget.header === header && rowIndex === 0) {
                                    targetCellRef.current = node;
                                  }
                                }}
                                className="overflow-hidden border border-slate-900 px-3 py-1.5 align-top text-slate-900"
                                style={{ width, minWidth: width, maxWidth: width }}
                              >
                                <ScrollableCalculationCell
                                  className={cn(
                                    activeFocusTarget?.stockKey === group.stockKey && activeFocusTarget.header === header
                                      ? "rounded bg-blue-100 p-1 ring-2 ring-blue-400"
                                      : "",
                                  )}
                                >
                                  {row.values[header]}
                                </ScrollableCalculationCell>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                      {groupIndex < rowGroups.length - 1 ? (
                        <tr aria-hidden="true" className="h-3 bg-white">
                          <td colSpan={ACTIONABLES_CALCULATION_HEADERS.length} className="border-0 bg-white p-0" />
                        </tr>
                      ) : null}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-500">No actionable calculation rows available.</div>
            )}
          </div>
        </div>
      </div>
      <ActionablesInputSelectionDialog
        open={inputSelectionOpen}
        candidates={inputCandidates}
        selectedIds={effectiveSelectedInputIds}
        usdInrRate={usdInrRate}
        onToggle={(id) => {
          setSelectedInputIds((current) => {
            const next = new Set(current ?? effectiveSelectedInputIds);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          });
        }}
        onToggleAll={() => {
          setSelectedInputIds((current) => {
            const currentIds = current ?? effectiveSelectedInputIds;
            const allSelected = inputCandidates.every((candidate) => currentIds.has(candidate.id));
            return allSelected ? new Set() : new Set(inputCandidates.map((candidate) => candidate.id));
          });
        }}
        onResetDefaults={() => setSelectedInputIds(null)}
        onClose={() => setInputSelectionOpen(false)}
      />
      <ActionablesFormulaModal
        open={formulaOpen}
        formulaConfig={formulaConfig}
        onFormulaConfigChange={onFormulaConfigChange}
        onClose={() => setFormulaOpen(false)}
      />
      <ScoreMatrixModal
        detail={selectedMatrixDetail}
        formulaConfig={formulaConfig}
        onFormulaConfigChange={onFormulaConfigChange}
        onClose={() => setSelectedMatrixDetail(null)}
        onFocusCalculation={(target) => {
          setInternalFocusTarget(target);
          setSelectedMatrixDetail(null);
        }}
      />
    </>
  );
}




export type DashboardActionRow = {
  id: string;
  market: SwingTradeMarket;
  stock: StockConsensus;
  formulaAction: ActionCategory;
  formulaScore: number | null;
  formulaEstimate: ActionEstimate;
  detail: ScoreMatrixDetail;
};

type DashboardActionSortKey =
  | "selected"
  | "stock"
  | "score"
  | "consensus"
  | "currentUnits"
  | "currentValue"
  | "units"
  | "actionCurrentUnits"
  | "amount"
  | "technicalSetup"
  | "confidence";

type FinalActionableColumnKey = "stock" | "score" | "consensus" | "currentValue" | "actionCurrentUnits" | "amount";

type FinalActionableColumnLayout = {
  order: FinalActionableColumnKey[];
  widths: Partial<Record<FinalActionableColumnKey, number>>;
};

const FINAL_ACTIONABLE_COLUMN_LAYOUT_VERSION = 1;
const FINAL_ACTIONABLE_COLUMNS: FinalActionableColumnKey[] = ["stock", "score", "consensus", "currentValue", "actionCurrentUnits", "amount"];
const FINAL_ACTIONABLE_COLUMN_LABELS: Record<FinalActionableColumnKey, string> = {
  stock: "Stock",
  score: "Score",
  consensus: "Consensus",
  currentValue: "Current Value",
  actionCurrentUnits: "Action/Current Units",
  amount: "Amount",
};
const FINAL_ACTIONABLE_COLUMN_SORT_KEYS: Record<FinalActionableColumnKey, DashboardActionSortKey> = {
  stock: "stock",
  score: "score",
  consensus: "consensus",
  currentValue: "currentValue",
  actionCurrentUnits: "actionCurrentUnits",
  amount: "amount",
};
const FINAL_ACTIONABLE_DEFAULT_WIDTHS: Record<FinalActionableColumnKey, number> = {
  stock: 168,
  score: 112,
  consensus: 132,
  currentValue: 148,
  actionCurrentUnits: 168,
  amount: 148,
};
const FINAL_ACTIONABLE_MIN_COLUMN_WIDTH = 96;
const FINAL_ACTIONABLE_MAX_COLUMN_WIDTH = 420;

function getFinalActionableLayoutStorageKey() {
  return `investor:final-actionable-table-layout:v${FINAL_ACTIONABLE_COLUMN_LAYOUT_VERSION}`;
}

function clampFinalActionableColumnWidth(width: number) {
  if (!Number.isFinite(width)) return FINAL_ACTIONABLE_DEFAULT_WIDTHS.stock;
  return Math.min(FINAL_ACTIONABLE_MAX_COLUMN_WIDTH, Math.max(FINAL_ACTIONABLE_MIN_COLUMN_WIDTH, Math.round(width)));
}

function normalizeFinalActionableLayout(layout?: Partial<FinalActionableColumnLayout> | null): FinalActionableColumnLayout {
  const seen = new Set<FinalActionableColumnKey>();
  const order = [
    ...(layout?.order ?? []).filter((column): column is FinalActionableColumnKey => {
      if (!FINAL_ACTIONABLE_COLUMNS.includes(column as FinalActionableColumnKey) || seen.has(column as FinalActionableColumnKey)) return false;
      seen.add(column as FinalActionableColumnKey);
      return true;
    }),
    ...FINAL_ACTIONABLE_COLUMNS.filter((column) => !seen.has(column)),
  ];
  const widths = FINAL_ACTIONABLE_COLUMNS.reduce((acc, column) => {
    acc[column] = clampFinalActionableColumnWidth(layout?.widths?.[column] ?? FINAL_ACTIONABLE_DEFAULT_WIDTHS[column]);
    return acc;
  }, {} as Record<FinalActionableColumnKey, number>);
  return { order, widths };
}

function loadFinalActionableLayout() {
  if (typeof window === "undefined") return normalizeFinalActionableLayout();
  try {
    const raw = window.localStorage.getItem(getFinalActionableLayoutStorageKey());
    return raw ? normalizeFinalActionableLayout(JSON.parse(raw)) : normalizeFinalActionableLayout();
  } catch {
    return normalizeFinalActionableLayout();
  }
}

function reorderFinalActionableColumns(order: FinalActionableColumnKey[], from: FinalActionableColumnKey, to: FinalActionableColumnKey) {
  if (from === to) return order;
  const next = order.filter((column) => column !== from);
  const targetIndex = next.indexOf(to);
  if (targetIndex === -1) return order;
  next.splice(targetIndex, 0, from);
  return next;
}

type DashboardActionSortState = {
  key: DashboardActionSortKey;
  direction: "asc" | "desc";
};

function getDefaultDashboardActionSortState(action: ActionCategory): DashboardActionSortState {
  return {
    key: "score",
    direction: action === "Add more" || action === "Buy New" ? "desc" : "asc",
  };
}

const EMPTY_SELECTED_DASHBOARD_ACTION_IDS = new Set<string>();

function getDashboardActionRowId(market: SwingTradeMarket, stock: StockConsensus) {
  return `${market}:${stock.key}`;
}

function getMarketActionUnits(
  unitsChange: number | null,
  action: ActionCategory,
  market: SwingTradeMarket,
) {
  if (!ACTION_ESTIMATE_CATEGORIES.has(action) || unitsChange === null) return null;
  const absoluteUnits = Math.abs(unitsChange);
  return market === "india" ? Math.floor(absoluteUnits) : absoluteUnits;
}

function buildFormulaActionEstimate(
  stock: StockConsensus,
  action: ActionCategory,
  unitsChange: number | null,
  market: SwingTradeMarket,
): ActionEstimate {
  const currentUnits = parseNumericCell(stock.representative["Current Units"]);
  const currentInvestmentAmount = getCurrentValueAmount(stock.representative);
  const units = getMarketActionUnits(unitsChange, action, market);
  const price = parseNumericCell(stock.representative["Price Per Unit"]);
  let amount: number | null = null;

  if (units !== null) {
    if (action === "Sell All" && currentInvestmentAmount !== null) {
      amount = currentInvestmentAmount;
    } else if (
      action === "Trim" &&
      currentUnits !== null &&
      currentUnits > 0 &&
      currentInvestmentAmount !== null
    ) {
      amount = Math.abs(units / currentUnits) * currentInvestmentAmount;
    } else if (price !== null) {
      amount = Math.abs(units * price);
    } else if (
      action === "Add more" &&
      currentUnits !== null &&
      currentUnits > 0 &&
      currentInvestmentAmount !== null
    ) {
      amount = Math.abs(units / currentUnits) * currentInvestmentAmount;
    } else {
      amount = getActionAmount(stock.representative, units, action);
    }
  }

  return {
    currentUnits,
    currentInvestmentAmount,
    units,
    amount,
  };
}

export function buildDashboardActionRows(
  stocks: StockConsensus[],
  market: SwingTradeMarket,
  technicalScans: TechnicalScanMap,
  formulaConfig: ScoreMatrixFormulaConfig = DEFAULT_SCORE_MATRIX_FORMULA_CONFIG,
): DashboardActionRow[] {
  return stocks.map((stock) => {
    const detail = buildScoreMatrixDetail(stock, getTechnicalScanForStock(technicalScans, stock), formulaConfig, getLatestTechnicalScanSourceLabel(technicalScans));
    const formulaAction = detail.calculatedAction;
    return {
      id: getDashboardActionRowId(market, stock),
      market,
      stock,
      formulaAction,
      formulaScore: detail.calculatedScore,
      formulaEstimate: buildFormulaActionEstimate(stock, formulaAction, detail.calculatedUnitsChange, market),
      detail,
    };
  });
}

function getDashboardActionSortValue(
  row: DashboardActionRow,
  action: ActionCategory,
  key: DashboardActionSortKey,
  technicalScans: TechnicalScanMap,
  selectedIds: Set<string>,
) {
  const scan = getTechnicalScanForStock(technicalScans, row.stock);
  switch (key) {
    case "selected":
      return selectedIds.has(row.id) ? 1 : 0;
    case "stock":
      return row.stock.symbol;
    case "score":
      return row.formulaScore ?? Number.POSITIVE_INFINITY;
    case "consensus":
      return row.stock.actionCounts[action] / Math.max(row.stock.totalSuggestions, 1);
    case "currentUnits":
      return row.formulaEstimate.currentUnits ?? Number.NEGATIVE_INFINITY;
    case "currentValue":
      return row.formulaEstimate.currentInvestmentAmount ?? getCurrentValueAmount(row.stock.representative) ?? Number.NEGATIVE_INFINITY;
    case "units":
      return row.formulaEstimate.units ?? Number.NEGATIVE_INFINITY;
    case "actionCurrentUnits":
      return row.formulaEstimate.units ?? 0;
    case "amount":
      return row.formulaEstimate.amount ?? Number.NEGATIVE_INFINITY;
    case "technicalSetup":
      return formatTechnicalSetup(scan, row.stock.representative);
    case "confidence":
      return parseNumericCell(formatTechnicalConfidence(scan, row.stock.representative)) ?? Number.NEGATIVE_INFINITY;
    default:
      return "";
  }
}

function compareDashboardActionRows(
  left: DashboardActionRow,
  right: DashboardActionRow,
  action: ActionCategory,
  sortState: DashboardActionSortState,
  technicalScans: TechnicalScanMap,
  selectedIds: Set<string> = EMPTY_SELECTED_DASHBOARD_ACTION_IDS,
) {
  if (sortState.key === "score") {
    const leftMissingScore = left.formulaScore === null;
    const rightMissingScore = right.formulaScore === null;
    if (leftMissingScore !== rightMissingScore) return leftMissingScore ? 1 : -1;
  }

  const leftValue = getDashboardActionSortValue(left, action, sortState.key, technicalScans, selectedIds);
  const rightValue = getDashboardActionSortValue(right, action, sortState.key, technicalScans, selectedIds);
  let comparison = 0;
  if (typeof leftValue === "number" && typeof rightValue === "number") {
    comparison = leftValue - rightValue;
  } else {
    comparison = String(leftValue).localeCompare(String(rightValue), undefined, { sensitivity: "base", numeric: true });
  }
  if (comparison === 0) {
    comparison = left.stock.symbol.localeCompare(right.stock.symbol, undefined, { sensitivity: "base" });
  }
  return sortState.direction === "asc" ? comparison : -comparison;
}

function SortableActionHeader({
  label,
  sortKey,
  currentSort,
  onSort,
  className,
}: {
  label: string;
  sortKey: DashboardActionSortKey;
  currentSort: DashboardActionSortState;
  onSort: (key: DashboardActionSortKey) => void;
  className?: string;
}) {
  const isActive = currentSort.key === sortKey;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      className={cn("inline-flex cursor-pointer items-center gap-1 whitespace-nowrap font-semibold text-gray-500 transition hover:text-gray-900", className)}
      title={`Sort by ${label}`}
    >
      {label}
      {isActive ? (
        currentSort.direction === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />
      ) : (
        <span className="text-gray-300">↕</span>
      )}
    </button>
  );
}

function getLatestMatchingRuns(runs: RunResponse[], market: SwingTradeMarket) {
  const marketRuns = runs
    .filter((run) => isCompletedRebalanceRun(run, market))
    .sort((a, b) => parseTimestampMs(b.created_at) - parseTimestampMs(a.created_at));
  const latestRun = marketRuns[0];
  if (!latestRun) return [];
  const fingerprint = extractRebalanceInputFingerprint(latestRun.prompt);
  return marketRuns.filter(
    (run) => extractRebalanceInputFingerprint(run.prompt) === fingerprint,
  );
}

export function DashboardFinalActionablesTables() {
  const cachedDashboardFinalActionablesOnFirstRender = useMemo(
    () => readDashboardFinalActionablesCache(),
    [],
  );
  const [runs, setRuns] = useState<RunResponse[]>(() => cachedDashboardFinalActionablesOnFirstRender?.runs ?? []);
  const [portfolioSnapshots, setPortfolioSnapshots] = useState<{
    india: ZerodhaPortfolioSnapshotDetail | null;
    us: IndMoneyUsPortfolioSnapshotDetail | null;
  }>(() => cachedDashboardFinalActionablesOnFirstRender?.portfolioSnapshots ?? { india: null, us: null });
  const [loading, setLoading] = useState(() => !cachedDashboardFinalActionablesOnFirstRender);
  const [error, setError] = useState<string | null>(null);
  const [sortStates, setSortStates] = useState<Record<string, DashboardActionSortState>>({});
  const [finalActionableLayout, setFinalActionableLayout] = useState<FinalActionableColumnLayout>(() => loadFinalActionableLayout());
  const [draggedFinalActionableColumn, setDraggedFinalActionableColumn] = useState<FinalActionableColumnKey | null>(null);
  const finalActionableResizeStateRef = useRef<{ column: FinalActionableColumnKey; startX: number; startWidth: number } | null>(null);
  const [calculationsMarket, setCalculationsMarket] = useState<SwingTradeMarket | null>(null);
  const [calculationFocusTarget, setCalculationFocusTarget] = useState<ActionablesCalculationFocusTarget | null>(null);
  const [selectedMatrixDetail, setSelectedMatrixDetail] = useState<ScoreMatrixDetail | null>(null);
  const [scoreMatrixFormulaConfig, setScoreMatrixFormulaConfig] = useState<ScoreMatrixFormulaConfig>(() => loadScoreMatrixFormulaConfig());
  const [detailsDataByMarket, setDetailsDataByMarket] = useState<Record<SwingTradeMarket, StockDetailsData>>(() => ({
    india: { portfolioSnapshot: cachedDashboardFinalActionablesOnFirstRender?.portfolioSnapshots.india ?? null, eventsAnalysis: null, threatsAnalysis: null, error: null },
    us: { portfolioSnapshot: cachedDashboardFinalActionablesOnFirstRender?.portfolioSnapshots.us ?? null, eventsAnalysis: null, threatsAnalysis: null, error: null },
  }));
  const [actionablesCompletedAtByMarket, setActionablesCompletedAtByMarket] = useState<Record<SwingTradeMarket, string | null>>(
    () => readDashboardActionablesCompletedAtByMarket(),
  );

  const loadRuns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [allRuns, zerodhaOverview, indmoneyOverview] = await Promise.all([
        fetchAllFullRuns(),
        apiService.zerodhaPortfolioOverview(),
        apiService.indmoneyUsPortfolioOverview(),
      ]);
      const nextPortfolioSnapshots = {
        india: zerodhaOverview.latest,
        us: indmoneyOverview.latest,
      };
      setRuns(allRuns);
      setPortfolioSnapshots(nextPortfolioSnapshots);
      writeDashboardFinalActionablesCache(allRuns, nextPortfolioSnapshots);
      setDetailsDataByMarket((current) => ({
        india: { ...current.india, portfolioSnapshot: zerodhaOverview.latest },
        us: { ...current.us, portfolioSnapshot: indmoneyOverview.latest },
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load final actionables.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadRuns();
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [loadRuns]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<DashboardActionablesRefreshDetail>).detail;
      if (detail?.market === "india" || detail?.market === "us") {
        setActionablesCompletedAtByMarket((current) => ({
          ...current,
          [detail.market as SwingTradeMarket]: detail.completedAt ?? new Date().toISOString(),
        }));
      } else {
        setActionablesCompletedAtByMarket(readDashboardActionablesCompletedAtByMarket());
      }
      void loadRuns();
    };
    window.addEventListener("final-actionables-refresh", handler);
    return () => window.removeEventListener("final-actionables-refresh", handler);
  }, [loadRuns]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(getFinalActionableLayoutStorageKey(), JSON.stringify(normalizeFinalActionableLayout(finalActionableLayout)));
  }, [finalActionableLayout]);

  useEffect(() => {
    return () => {
      finalActionableResizeStateRef.current = null;
    };
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ market?: SwingTradeMarket }>).detail;
      setCalculationsMarket(detail?.market === "us" ? "us" : "india");
    };
    window.addEventListener("open-actionables-calculations", handler);
    return () => window.removeEventListener("open-actionables-calculations", handler);
  }, []);

  const technicalScans = useMemo(() => buildTechnicalScanMap(runs), [runs]);

  useEffect(() => {
    let ignore = false;

    async function loadCapturedDetails() {
      try {
        const [zerodhaEvents, zerodhaThreats, indmoneyEvents, indmoneyThreats] = await Promise.all([
          apiService.zerodhaEventsLatest(),
          apiService.zerodhaThreatsLatest(),
          apiService.indmoneyUsEventsLatest(),
          apiService.indmoneyUsThreatsLatest(),
        ]);

        if (!ignore) {
          setDetailsDataByMarket((current) => ({
            india: {
              ...current.india,
              eventsAnalysis: zerodhaEvents.analysis,
              threatsAnalysis: zerodhaThreats.analysis,
              error: null,
            },
            us: {
              ...current.us,
              eventsAnalysis: indmoneyEvents.analysis,
              threatsAnalysis: indmoneyThreats.analysis,
              error: null,
            },
          }));
        }
      } catch (err) {
        if (!ignore) {
          const message = err instanceof Error ? err.message : "Failed to load captured stock details.";
          setDetailsDataByMarket((current) => ({
            india: { ...current.india, error: message },
            us: { ...current.us, error: message },
          }));
        }
      }
    }

    void loadCapturedDetails();

    return () => {
      ignore = true;
    };
  }, []);
  useEffect(() => {
    saveScoreMatrixFormulaConfig(scoreMatrixFormulaConfig);
  }, [scoreMatrixFormulaConfig]);

  const actionRowsByMarket = useMemo(() => ({
    india: buildDashboardActionRows(
      buildConsensusRows(getLatestMatchingRuns(runs, "india"), "india", portfolioSnapshots.india),
      "india",
      technicalScans,
      scoreMatrixFormulaConfig,
    ),
    us: buildDashboardActionRows(
      buildConsensusRows(getLatestMatchingRuns(runs, "us"), "us", portfolioSnapshots.us),
      "us",
      technicalScans,
      scoreMatrixFormulaConfig,
    ),
  }), [portfolioSnapshots.india, portfolioSnapshots.us, runs, scoreMatrixFormulaConfig, technicalScans]);

  const updateFinalActionableColumnWidth = useCallback((column: FinalActionableColumnKey, width: number) => {
    setFinalActionableLayout((current) => ({
      ...current,
      widths: {
        ...current.widths,
        [column]: clampFinalActionableColumnWidth(width),
      },
    }));
  }, []);

  const handleFinalActionableResizeStart = useCallback((column: FinalActionableColumnKey, event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    finalActionableResizeStateRef.current = {
      column,
      startX: event.clientX,
      startWidth: finalActionableLayout.widths[column] ?? FINAL_ACTIONABLE_DEFAULT_WIDTHS[column],
    };

    const handleMouseMove = (moveEvent: globalThis.MouseEvent) => {
      const state = finalActionableResizeStateRef.current;
      if (!state) return;
      updateFinalActionableColumnWidth(state.column, state.startWidth + moveEvent.clientX - state.startX);
    };
    const handleMouseUp = () => {
      finalActionableResizeStateRef.current = null;
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  }, [finalActionableLayout.widths, updateFinalActionableColumnWidth]);

  const handleFinalActionableColumnDrop = useCallback((targetColumn: FinalActionableColumnKey, event: ReactDragEvent<HTMLTableCellElement>) => {
    event.preventDefault();
    const sourceColumn = draggedFinalActionableColumn;
    setDraggedFinalActionableColumn(null);
    if (!sourceColumn || sourceColumn === targetColumn) return;
    setFinalActionableLayout((current) => ({
      ...current,
      order: reorderFinalActionableColumns(current.order, sourceColumn, targetColumn),
    }));
  }, [draggedFinalActionableColumn]);

  const toggleActionSort = useCallback((tableKey: string, action: ActionCategory, key: DashboardActionSortKey) => {
    setSortStates((current) => {
      const existing = current[tableKey] ?? getDefaultDashboardActionSortState(action);
      return {
        ...current,
        [tableKey]: existing.key === key
          ? { key, direction: existing.direction === "asc" ? "desc" : "asc" }
          : {
            key,
            direction: key === "score"
              ? getDefaultDashboardActionSortState(action).direction
              : key === "stock" || key === "technicalSetup" ? "asc" : "desc",
          },
      };
    });
  }, []);

  const renderMarketPanel = (market: SwingTradeMarket, title: string, description: string) => {
    const actionRows = actionRowsByMarket[market];
    const detailsData = detailsDataByMarket[market];
    const latestRebalanceAt = getLatestMatchingRuns(runs, market)[0]?.created_at ?? null;
    const latestTechnicalAt = Object.values(technicalScans)
      .filter((scan, index, scans) => scans.findIndex((candidate) => candidate.runId === scan.runId && candidate.jobId === scan.jobId) === index)
      .filter((scan) => {
        const run = runs.find((candidate) => candidate.id === scan.runId);
        return run ? isCompletedTechnicalScanRun(run, market) : false;
      })
      .map((scan) => scan.createdAt)
      .sort((a, b) => parseTimestampMs(b) - parseTimestampMs(a))[0] ?? null;
    const latestActionablesCompletedAt = actionablesCompletedAtByMarket[market];
    const lastUpdatedAt = [latestRebalanceAt, latestTechnicalAt, latestActionablesCompletedAt]
      .filter(Boolean)
      .sort((a, b) => parseTimestampMs(b) - parseTimestampMs(a))[0] ?? null;

    return (
      <div id={market === "us" ? "final-actionable-us" : "final-actionable-zerodha"} className="scroll-mt-24 rounded-[28px] border border-slate-200 bg-white/80 p-4 shadow-sm">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              {market === "us" ? "US" : "Zerodha India"}
            </div>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 className="font-serif text-xl tracking-tight text-slate-950">{title}</h3>
              <span className="text-xs font-medium text-slate-500">
                Last updated: {lastUpdatedAt ? formatDateTime(lastUpdatedAt) : "—"}
              </span>
            </div>
            <p className="mt-2 text-sm leading-6 text-slate-600">{description}</p>
          </div>
          <button
            type="button"
            onClick={() => {
              setCalculationFocusTarget(null);
              setCalculationsMarket(market);
            }}
            className="inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full border border-blue-200 bg-blue-50 text-blue-700 shadow-sm transition hover:border-blue-400 hover:bg-blue-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            aria-label={`Open ${title} Actionables Calculations`}
            title="Actionables Calculations"
          >
            <ActionablesCalculationsIcon />
          </button>
        </div>

        <div className="space-y-4">
          {loading && actionRows.length === 0 ? (
            <div className="rounded-[20px] border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
              Loading final actionables…
            </div>
          ) : (
            ACTION_CATEGORIES.map((action) => {
              const tableKey = `${market}:${action}`;
              const sortState = sortStates[tableKey] ?? getDefaultDashboardActionSortState(action);
              const rows = actionRows
                .filter((row) => row.formulaAction === action)
                .sort((a, b) => compareDashboardActionRows(a, b, action, sortState, technicalScans));
              const showBuyAmountTotal = action === "Add more" || action === "Buy New";
              const buyAmountTotal = showBuyAmountTotal ? getBuyActionAmountTotal(rows) : null;
              if (!rows.length) return null;
              return (
                <Card
                  key={`${market}-${action}`}
                  id={`dashboard-${market}-${finalActionCategoryDomId(action)}`}
                  className={cn("scroll-mt-24 border", CATEGORY_BADGE_CLASS[action])}
                >
                  <CardHeader className="pb-2">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <CardTitle className="text-sm">{ACTION_CATEGORY_LABEL[action]}</CardTitle>
                      <span className="text-xs font-semibold text-slate-600">
                        {rows.length} stock{rows.length === 1 ? "" : "s"}
                      </span>
                    </div>
                  </CardHeader>
                  <CardContent className="text-xs">
                    {rows.length ? (
                      <div className="overflow-x-auto">
                        <table className="min-w-[64rem] text-xs">
                          <thead>
                            <tr className="border-b border-gray-200 bg-white/60 text-left text-[11px] uppercase tracking-wide text-gray-500">
                              {finalActionableLayout.order.map((column) => {
                                const width = finalActionableLayout.widths[column] ?? FINAL_ACTIONABLE_DEFAULT_WIDTHS[column];
                                return (
                                  <th
                                    key={column}
                                    draggable
                                    onDragStart={(event) => {
                                      setDraggedFinalActionableColumn(column);
                                      event.dataTransfer.effectAllowed = "move";
                                      event.dataTransfer.setData("text/plain", column);
                                    }}
                                    onDragOver={(event) => {
                                      event.preventDefault();
                                      event.dataTransfer.dropEffect = "move";
                                    }}
                                    onDrop={(event) => handleFinalActionableColumnDrop(column, event)}
                                    onDragEnd={() => setDraggedFinalActionableColumn(null)}
                                    className={cn(
                                      "group relative px-3 py-2 font-semibold transition",
                                      draggedFinalActionableColumn === column ? "bg-blue-100" : "",
                                    )}
                                    style={{ width, minWidth: width, maxWidth: width }}
                                    title="Drag left/right to reorder. Use the right edge to resize."
                                  >
                                    <SortableActionHeader
                                      label={FINAL_ACTIONABLE_COLUMN_LABELS[column]}
                                      sortKey={FINAL_ACTIONABLE_COLUMN_SORT_KEYS[column]}
                                      currentSort={sortState}
                                      onSort={(key) => toggleActionSort(tableKey, action, key)}
                                      className="pr-3"
                                    />
                                    <button
                                      type="button"
                                      className="absolute right-0 top-0 h-full w-2 cursor-col-resize border-r-2 border-transparent transition hover:border-blue-500 focus:border-blue-500 focus:outline-none"
                                      aria-label={`Resize ${FINAL_ACTIONABLE_COLUMN_LABELS[column]} column`}
                                      onMouseDown={(event) => handleFinalActionableResizeStart(column, event)}
                                    />
                                  </th>
                                );
                              })}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {rows.map((row) => {
                              const { stock } = row;
                              const estimate = row.formulaEstimate;
                              const showActionColumns = ACTION_ESTIMATE_CATEGORIES.has(action);
                              const scan = getTechnicalScanForStock(technicalScans, stock);
                              const renderColumn = (column: FinalActionableColumnKey) => {
                                if (column === "stock") {
                                  return (
                                    <span className="inline-flex items-center whitespace-nowrap">
                                      <StockDetailsButton
                                        stock={stock}
                                        market={market}
                                        technicalScan={scan}
                                        detailsData={detailsData}
                                        onFocusCalculation={(target) => {
                                          setCalculationFocusTarget(target);
                                          setCalculationsMarket(market);
                                        }}
                                      />
                                      <TradingViewSymbolLink
                                        symbol={stock.symbol}
                                        market={market}
                                        exchange={stock.exchange}
                                        className="font-medium underline-offset-4 hover:text-blue-700 hover:underline"
                                      >
                                        {stock.symbol}
                                      </TradingViewSymbolLink>
                                    </span>
                                  );
                                }
                                if (column === "score") return <ScoreMatrixButton detail={row.detail} onOpenDetail={setSelectedMatrixDetail} />;
                                if (column === "consensus") return <ConsensusBreakupButton stock={stock} action={action} />;
                                if (column === "currentValue") return formatDisplayAmount(estimate.currentInvestmentAmount ?? getCurrentValueAmount(stock.representative), market);
                                if (column === "actionCurrentUnits") {
                                  const actionUnits = showActionColumns ? formatQuantity(estimate.units) : "0";
                                  return `${actionUnits}/${formatQuantity(estimate.currentUnits)}`;
                                }
                                return showActionColumns ? formatDisplayAmount(estimate.amount, market) : "—";
                              };
                              return (
                                <tr key={`${market}-${stock.key}`} className="bg-white/40">
                                  {finalActionableLayout.order.map((column) => {
                                    const width = finalActionableLayout.widths[column] ?? FINAL_ACTIONABLE_DEFAULT_WIDTHS[column];
                                    return (
                                      <td
                                        key={`${market}-${stock.key}-${column}`}
                                        className={cn(
                                          "overflow-hidden px-3 py-2 align-top text-gray-700",
                                          column === "score" ? "font-semibold text-gray-800" : "",
                                        )}
                                        style={{ width, minWidth: width, maxWidth: width }}
                                      >
                                        <div className="truncate">{renderColumn(column)}</div>
                                      </td>
                                    );
                                  })}
                                </tr>
                              );
                            })}
                          </tbody>
                          {showBuyAmountTotal ? (
                            <tfoot>
                              <tr className="border-t border-emerald-200 bg-white/80 text-slate-900">
                                <td colSpan={Math.max(finalActionableLayout.order.length - 1, 1)} className="px-3 py-3 text-right text-[11px] font-bold uppercase tracking-wide text-slate-600">
                                  Total new buy amount required
                                </td>
                                <td className="whitespace-nowrap px-3 py-3 font-black text-emerald-950">
                                  {formatDisplayAmount(buyAmountTotal, market)}
                                </td>
                              </tr>
                            </tfoot>
                          ) : null}
                        </table>
                      </div>
                    ) : (
                      <span className="text-gray-600">No consensus stocks.</span>
                    )}
                  </CardContent>
                </Card>
              );
            })
          )}
        </div>
      </div>
    );
  };

  return (
    <section
      id="final-actionables"
      tabIndex={-1}
      className="rounded-[32px] border border-slate-200 bg-white shadow-sm focus:outline-none"
    >
      <div className="flex flex-col gap-4 border-b border-slate-200 px-6 py-6 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Final Actionables
          </div>
          <h2 className="mt-2 font-serif text-2xl tracking-tight text-slate-950">
            Final Actionable Zerodha & Final Actionable US
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-7 text-slate-600">
            Latest rebalance decisions split into adjacent Zerodha India and INDmoney US action tables.
          </p>
        </div>

        <Button
          onClick={() => void loadRuns()}
          variant="outline"
          disabled={loading}
          className="rounded-full border-slate-300 bg-white/80"
        >
          <RefreshCw className={cn("mr-2 size-4", loading ? "animate-spin" : "")} />
          Refresh Actions
        </Button>
      </div>

      <div className="p-6">
        {error ? (
          <div className="mb-4 rounded-[20px] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {error}
          </div>
        ) : null}

        <div className="grid gap-6 xl:grid-cols-2">
          {renderMarketPanel(
            "india",
            "Final Actionable Zerodha",
            "Zerodha India rebalance decisions grouped into Sell All, Add More, Buy New, Trim, and Hold tables.",
          )}
          {renderMarketPanel(
            "us",
            "Final Actionable US",
            "INDmoney US rebalance decisions grouped into Sell All, Add More, Buy New, Trim, and Hold tables.",
          )}
        </div>
      </div>
      <ActionablesCalculationsModal
        key={calculationsMarket ?? "india"}
        open={calculationsMarket !== null}
        onClose={() => {
          setCalculationsMarket(null);
          setCalculationFocusTarget(null);
        }}
        title={calculationsMarket === "us" ? "Final Actionable US" : "Final Actionable Zerodha"}
        market={calculationsMarket ?? "india"}
        stocks={(calculationsMarket ? actionRowsByMarket[calculationsMarket] : actionRowsByMarket.india).map((row) => row.stock)}
        technicalScans={technicalScans}
        formulaConfig={scoreMatrixFormulaConfig}
        onFormulaConfigChange={setScoreMatrixFormulaConfig}
        runs={runs}
        detailsData={calculationsMarket ? detailsDataByMarket[calculationsMarket] : detailsDataByMarket.india}
        focusTarget={calculationFocusTarget}
      />
      <ScoreMatrixModal
        detail={selectedMatrixDetail}
        formulaConfig={scoreMatrixFormulaConfig}
        onFormulaConfigChange={setScoreMatrixFormulaConfig}
        onClose={() => setSelectedMatrixDetail(null)}
        onFocusCalculation={(target) => {
          const targetMarket = actionRowsByMarket.us.some((row) => row.stock.key === target.stockKey) ? "us" : "india";
          setCalculationFocusTarget(target);
          setCalculationsMarket(targetMarket);
          setSelectedMatrixDetail(null);
        }}
      />
    </section>
  );
}

export function FinalActionablesConsole({
  portfolio,
  market,
}: {
  portfolio: RebalancePortfolioKey;
  market: SwingTradeMarket;
}) {
  const runCacheKey = useMemo(
    () => buildFinalActionablesCacheKey(portfolio, market),
    [portfolio, market],
  );
  const cachedRunsOnFirstRender = useMemo(
    () => readFinalActionablesRunCache(runCacheKey),
    [runCacheKey],
  );
  const [runs, setRuns] = useState<RunResponse[]>(() => cachedRunsOnFirstRender ?? []);
  const [loading, setLoading] = useState(() => !cachedRunsOnFirstRender);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showRunDetails, setShowRunDetails] = useState(false);
  const [selectedSetupGroup, setSelectedSetupGroup] = useState<SetupStockGroup | null>(null);
  const [selectedMatrixDetail, setSelectedMatrixDetail] = useState<ScoreMatrixDetail | null>(null);
  const [scoreMatrixFormulaConfig, setScoreMatrixFormulaConfig] = useState<ScoreMatrixFormulaConfig>(() => loadScoreMatrixFormulaConfig());
  const [calculationsOpen, setCalculationsOpen] = useState(false);
  const [calculationFocusTarget, setCalculationFocusTarget] = useState<ActionablesCalculationFocusTarget | null>(null);
  const [technicalScanRunning, setTechnicalScanRunning] = useState(false);
  const [detailsData, setDetailsData] = useState<StockDetailsData>({
    portfolioSnapshot: null,
    eventsAnalysis: null,
    threatsAnalysis: null,
    error: null,
  });
  const usdInrRate = useUsdInrRate();

  const loadRuns = useCallback(async (showLoading = true) => {
    if (showLoading) {
      setLoading(true);
      setError(null);
    }
    try {
      const response = await fetchAllFullRuns();
      setRuns(response);
      cacheFinalActionablesRuns(runCacheKey, response, market);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load rebalance runs.",
      );
    } finally {
      setLoading(false);
    }
  }, [market, runCacheKey]);

  const loadTechnicalScanHistory = useCallback(async () => {
    const response = await fetchAllFullRuns();
    setRuns(response);
    cacheFinalActionablesRuns(runCacheKey, response, market);
    return buildTechnicalScanHistory(response);
  }, [market, runCacheKey]);

  useEffect(() => {
    let ignore = false;

    fetchAllFullRuns()
      .then((response) => {
        if (!ignore) {
          setRuns(response);
          cacheFinalActionablesRuns(runCacheKey, response, market);
        }
      })
      .catch((err: unknown) => {
        if (!ignore) {
          setError(
            err instanceof Error
              ? err.message
              : "Failed to load rebalance runs.",
          );
        }
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });

    return () => {
      ignore = true;
    };
  }, [market, runCacheKey]);

  useEffect(() => {
    let ignore = false;

    async function loadCapturedDetails() {
      try {
        const [portfolioResponse, eventsResponse, threatsResponse] = await Promise.all([
          portfolio === "zerodha"
            ? apiService.zerodhaPortfolioOverview()
            : apiService.indmoneyUsPortfolioOverview(),
          portfolio === "zerodha"
            ? apiService.zerodhaEventsLatest()
            : apiService.indmoneyUsEventsLatest(),
          portfolio === "zerodha"
            ? apiService.zerodhaThreatsLatest()
            : apiService.indmoneyUsThreatsLatest(),
        ]);

        if (!ignore) {
          setDetailsData({
            portfolioSnapshot: portfolioResponse.latest,
            eventsAnalysis: eventsResponse.analysis,
            threatsAnalysis: threatsResponse.analysis,
            error: null,
          });
        }
      } catch (err) {
        if (!ignore) {
          setDetailsData((current) => ({
            ...current,
            error: err instanceof Error ? err.message : "Failed to load captured stock details.",
          }));
        }
      }
    }

    void loadCapturedDetails();

    return () => {
      ignore = true;
    };
  }, [portfolio]);

  useEffect(() => {
    saveScoreMatrixFormulaConfig(scoreMatrixFormulaConfig);
  }, [scoreMatrixFormulaConfig]);

  const groupedRuns = useMemo(() => {
    const marketRuns = runs
      .filter((run) => isCompletedRebalanceRun(run, market))
      .sort(
        (a, b) =>
          parseTimestampMs(b.created_at) - parseTimestampMs(a.created_at),
      );
    const latestRun = marketRuns[0];
    if (!latestRun) return { latestRun: null, runs: [] as RunResponse[] };
    const fingerprint = extractRebalanceInputFingerprint(latestRun.prompt);
    return {
      latestRun,
      runs: marketRuns.filter(
        (run) => extractRebalanceInputFingerprint(run.prompt) === fingerprint,
      ),
    };
  }, [market, runs]);

  const consensus = useMemo(
    () => buildConsensusRows(groupedRuns.runs, market, detailsData.portfolioSnapshot),
    [detailsData.portfolioSnapshot, groupedRuns.runs, market],
  );
  const totalStocksConsolidated = consensus.length;
  const technicalScans = useMemo(() => buildTechnicalScanMap(runs), [runs]);
  const setupStockGroups = useMemo(
    () => getSetupStockGroups(consensus, technicalScans, market),
    [consensus, market, technicalScans],
  );
  const technicalScanHistory = useMemo(() => buildTechnicalScanHistory(runs), [runs]);
  const technicalScanIsActive = useMemo(() => hasActiveTechnicalScan(runs), [runs]);

  useEffect(() => {
    if (!technicalScanIsActive || technicalScanRunning) return;

    const interval = window.setInterval(() => {
      void loadRuns(false);
    }, TECHNICAL_SCAN_POLL_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [loadRuns, technicalScanIsActive, technicalScanRunning]);

  const technicalScanCostByTarget = useMemo(() => {
    const costs: Record<string, number> = {};
    technicalScanHistory.forEach((item) => {
      if (item.status !== "completed" || typeof item.estimated_cost !== "number") return;
      const key = `${item.provider}::${item.model}`;
      if (costs[key] === undefined) {
        costs[key] = Math.round(item.estimated_cost * usdInrRate * 100) / 100;
      }
    });
    return costs;
  }, [technicalScanHistory, usdInrRate]);
  const copy = PAGE_COPY[portfolio];

  const handleTechnicalScan = async (target: ProviderModelTarget | null) => {
    if (!target || !consensus.length) return;
    setTechnicalScanRunning(true);
    try {
      const run = await apiService.createRun({
        prompt: buildTechnicalScanPrompt(consensus, market),
        targets: [target],
        allow_parallel: true,
      });
      await loadRuns(false);
      await waitForTechnicalScanRunCompletion(run.id);
      await loadRuns(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to queue technical scan.");
    } finally {
      setTechnicalScanRunning(false);
    }
  };

  const toggleExpanded = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <main className="mx-auto max-w-7xl space-y-8 px-4 py-8 sm:px-6 lg:px-8">
        <PortfolioAnalysisNav
          portfolio={portfolio}
          active="finalActionables"
          className="justify-center"
        />

        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-blue-600">
              Final Actionables
            </p>
            <h1 className="mt-2 text-3xl font-bold text-gray-900">
              {copy.title}
            </h1>
            <p className="mt-2 max-w-3xl text-sm text-gray-600">
              {copy.description}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <EventScanRunControls
              buttonLabel="Run Technical Scan"
              defaultTarget={null}
              disabled={loading || !consensus.length}
              historicalEstimatedCostInrByTarget={technicalScanCostByTarget}
              onRun={handleTechnicalScan}
              pickerButtonClassName="border-gray-200 bg-white text-gray-700 shadow-sm hover:border-gray-300 hover:bg-gray-50 focus:ring-blue-500"
              running={technicalScanRunning}
            />
            <ScanHistoryButton
              title="Technical scan history"
              emptyMessage="No technical scan runs found yet."
              loadHistory={loadTechnicalScanHistory}
              usdInrRate={usdInrRate}
              buttonClassName="border-gray-200 bg-white text-gray-700 shadow-sm hover:border-gray-300 hover:bg-gray-50 focus:ring-blue-500"
            />
            <Button
              onClick={() => void loadRuns()}
              variant="outline"
              disabled={loading}
            >
              <RefreshCw
                className={cn("mr-2 h-4 w-4", loading ? "animate-spin" : "")}
              />
              Refresh
            </Button>
          </div>
        </div>

        {error ? (
          <Card className="border-red-200 bg-red-50">
            <CardContent className="pt-6 text-sm text-red-700">
              {error}
            </CardContent>
          </Card>
        ) : null}


        {showRunDetails ? (
          <RunGroupDetails
            runs={groupedRuns.runs}
            latestRun={groupedRuns.latestRun}
            market={market}
            onBack={() => setShowRunDetails(false)}
          />
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Run Group</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4 text-sm text-gray-600 sm:grid-cols-3">
                <div>
                  <div className="font-semibold text-gray-900">
                    Latest matching run
                  </div>
                  <div>
                    {groupedRuns.latestRun
                      ? `#${groupedRuns.latestRun.id}`
                      : "None found"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowRunDetails(true)}
                  className="rounded-lg border border-blue-100 bg-blue-50/60 p-3 text-left transition hover:border-blue-300 hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <div className="font-semibold text-gray-900">
                    Runs consolidated
                  </div>
                  <div>{groupedRuns.runs.length}</div>
                  <div className="mt-1 text-xs text-blue-700">
                    Open run consideration details
                  </div>
                </button>
                <div>
                  <div className="font-semibold text-gray-900">
                    Total Stocks consolidated
                  </div>
                  <div>{totalStocksConsolidated}</div>
                </div>
              </CardContent>
            </Card>

            <ActionSummarySections
              consensus={consensus}
              market={market}
              technicalScans={technicalScans}
              setupGroups={setupStockGroups}
              detailsData={detailsData}
              onSetupClick={setSelectedSetupGroup}
              onFocusCalculation={(target) => {
                setCalculationFocusTarget(target);
                setCalculationsOpen(true);
              }}
            />
          </>
        )}

        {!showRunDetails ? (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="text-lg">
                  Stock-wise Consolidated Rebalance Output
                </CardTitle>
                <button
                  type="button"
                  onClick={() => {
                    setCalculationFocusTarget(null);
                    setCalculationsOpen(true);
                  }}
                  className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700 transition hover:border-blue-400 hover:bg-blue-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  title="Actionables Calculations"
                >
                  <ActionablesCalculationsIcon className="size-4" />
                  Actionables Calculations
                </button>
              </div>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="py-12 text-center text-sm text-gray-500">
                  Loading final actionables…
                </div>
              ) : consensus.length ? (
                <div className="overflow-x-auto">
                  <table className="min-w-max text-sm">
                    <thead>
                      <tr className="border-b border-gray-300 bg-gray-50">
                        <th className="whitespace-nowrap px-3 py-2 text-left font-semibold text-gray-700">
                          Details
                        </th>
                        <th className="whitespace-nowrap px-3 py-2 text-left font-semibold text-gray-700">
                          Stock Info
                        </th>
                        {CONSOLIDATED_DISPLAY_HEADERS.map((header) => (
                          <th
                            key={header}
                            className="whitespace-nowrap px-3 py-2 text-left font-semibold text-gray-700"
                          >
                            {header === "Technical Setup" ? (
                              <TechnicalSetupsHeaderLink>Technical Setup</TechnicalSetupsHeaderLink>
                            ) : (
                              header
                            )}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {sortStocksByConfidence(consensus, technicalScans).map((stock) => {
                        const isExpanded = expanded.has(stock.key);
                        return (
                          <FragmentRows
                            key={stock.key}
                            stock={stock}
                            isExpanded={isExpanded}
                            onToggle={() => toggleExpanded(stock.key)}
                            market={market}
                            technicalScan={getTechnicalScanForStock(technicalScans, stock)}
                            formulaConfig={scoreMatrixFormulaConfig}
                            setupGroups={setupStockGroups}
                            detailsData={detailsData}
                            onSetupClick={setSelectedSetupGroup}
                            onMatrixDetailOpen={setSelectedMatrixDetail}
                            onFocusCalculation={(target) => {
                              setCalculationFocusTarget(target);
                              setCalculationsOpen(true);
                            }}
                          />
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="mx-auto max-w-2xl py-12 text-center text-sm text-gray-500">
                  No completed rebalance output tables were found for the latest
                  matching input set. Runs with empty or missing prompts are
                  ignored by the input-set matcher until a completed rebalance
                  response is available.
                </div>
              )}
            </CardContent>
          </Card>
        ) : null}
      </main>
      <ActionablesCalculationsModal
        key={market}
        open={calculationsOpen}
        onClose={() => {
          setCalculationsOpen(false);
          setCalculationFocusTarget(null);
        }}
        title={PAGE_COPY[portfolio].title}
        market={market}
        stocks={consensus}
        technicalScans={technicalScans}
        formulaConfig={scoreMatrixFormulaConfig}
        onFormulaConfigChange={setScoreMatrixFormulaConfig}
        setupGroups={setupStockGroups}
        runs={runs}
        detailsData={detailsData}
        onSetupClick={setSelectedSetupGroup}
        focusTarget={calculationFocusTarget}
      />
      <SetupStocksModal
        group={selectedSetupGroup}
        onClose={() => setSelectedSetupGroup(null)}
      />
      <ScoreMatrixModal
        detail={selectedMatrixDetail}
        formulaConfig={scoreMatrixFormulaConfig}
        onFormulaConfigChange={setScoreMatrixFormulaConfig}
        onClose={() => setSelectedMatrixDetail(null)}
        onFocusCalculation={(target) => {
          setCalculationFocusTarget(target);
          setCalculationsOpen(true);
          setSelectedMatrixDetail(null);
        }}
      />
    </div>
  );
}

function SetupStocksModal({
  group,
  onClose,
}: {
  group: SetupStockGroup | null;
  onClose: () => void;
}) {
  if (!group) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="setup-stocks-modal-title"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-3xl overflow-hidden rounded-2xl bg-white shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-5 py-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-500">Technical setup stocks</p>
            <h2 id="setup-stocks-modal-title" className="mt-1 text-lg font-semibold text-gray-950">
              {group.setup} ({group.stocks.length})
            </h2>
          </div>
          <button
            type="button"
            className="rounded-full p-1 text-gray-500 transition hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            onClick={onClose}
            aria-label="Close setup stocks popup"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="overflow-auto p-5">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <th className="px-3 py-2 font-semibold">Name</th>
                <th className="px-3 py-2 font-semibold">Current Units</th>
                <th className="px-3 py-2 font-semibold">Action Suggested in Rebalance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {group.stocks.map((stock) => {
                const actionClasses = getSetupStockActionClasses(stock.action);

                return (
                  <tr key={stock.key} className={actionClasses.row}>
                    <td className={`whitespace-nowrap px-3 py-2 font-medium ${actionClasses.nameCell}`}>
                      <TradingViewSymbolLink
                        symbol={stock.symbol || stock.name}
                        market={stock.market}
                        exchange={stock.exchange}
                        className="underline-offset-4 hover:text-blue-700 hover:underline"
                      >
                        {stock.name}
                      </TradingViewSymbolLink>
                    </td>
                    <td className={`whitespace-nowrap px-3 py-2 ${actionClasses.cell}`}>
                      {stock.currentUnits}
                    </td>
                    <td className={`whitespace-nowrap px-3 py-2 font-medium ${actionClasses.cell}`}>
                      <FinalActionTag action={stock.action} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function FragmentRows({
  stock,
  isExpanded,
  onToggle,
  market,
  technicalScan,
  formulaConfig,
  setupGroups,
  detailsData,
  onSetupClick,
  onMatrixDetailOpen,
  onFocusCalculation,
}: {
  stock: StockConsensus;
  isExpanded: boolean;
  onToggle: () => void;
  market: SwingTradeMarket;
  technicalScan: TechnicalScanResult | null;
  formulaConfig: ScoreMatrixFormulaConfig;
  setupGroups: Record<string, SetupStockGroup>;
  detailsData: StockDetailsData;
  onSetupClick: (group: SetupStockGroup) => void;
  onMatrixDetailOpen: (detail: ScoreMatrixDetail) => void;
  onFocusCalculation?: (target: ActionablesCalculationFocusTarget) => void;
}) {
  return (
    <>
      <tr className="cursor-pointer hover:bg-gray-50" onClick={onToggle}>
        <td className="px-3 py-2 align-top text-gray-700">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onToggle();
            }}
            className="inline-flex items-center gap-1 rounded border border-gray-200 px-2 py-1 text-xs font-medium text-gray-700 transition hover:border-blue-300 hover:text-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
            aria-label={`${isExpanded ? "Collapse" : "Expand"} ${stock.symbol} LLM-wise breakup`}
          >
            {isExpanded ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
            {isExpanded ? "Hide" : "Show"}
          </button>
        </td>
        <td className="whitespace-nowrap px-3 py-2 align-top text-gray-700">
          <div className="flex items-start gap-2">
            <StockDetailsButton
              stock={stock}
              market={market}
              technicalScan={technicalScan}
              detailsData={detailsData}
              onFocusCalculation={onFocusCalculation}
            />
            <div>
              <TradingViewSymbolLink
                symbol={stock.symbol}
                market={market}
                exchange={stock.exchange}
                className="font-semibold underline-offset-4 hover:text-blue-700 hover:underline"
              >
                {stock.symbol}
              </TradingViewSymbolLink>
              <div className="text-xs text-gray-500">{stock.exchange || "—"}</div>
              <div className="text-xs text-gray-600">{stock.representative["Stock Name"] || stock.symbol}</div>
            </div>
          </div>
        </td>
        {CONSOLIDATED_DISPLAY_HEADERS.map((header) => (
          <td
            key={`${stock.key}-${header}`}
            className="px-3 py-2 align-top text-gray-700"
          >
            {header === "Stock Symbol" ? (
              <span className="inline-flex items-center whitespace-nowrap">
                <StockDetailsButton
                  stock={stock}
                  market={market}
                  technicalScan={technicalScan}
                  detailsData={detailsData}
                  onFocusCalculation={onFocusCalculation}
                />
                <RebalanceCell
                  row={stock.representative}
                  header={header}
                  market={market}
                  technicalScan={technicalScan}
                />
              </span>
            ) : (
              <RebalanceCell
                row={stock.representative}
                header={header}
                market={market}
                technicalScan={technicalScan}
              />
            )}
          </td>
        ))}
      </tr>
      {isExpanded ? (
        <tr className="bg-gray-50/70">
          <td colSpan={CONSOLIDATED_DISPLAY_HEADERS.length + 2} className="px-3 py-4">
            <div className="space-y-4">
              <ScoreMatrixSection
                stock={stock}
                technicalScan={technicalScan}
                formulaConfig={formulaConfig}
                onOpenDetail={onMatrixDetailOpen}
              />

              <div>
                <div className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-gray-500">
                  LLM-wise breakup leading to consolidation
                </div>
                <div className="overflow-x-auto rounded-lg border bg-white">
                  <table className="min-w-max text-xs">
                    <thead>
                      <tr className="border-b bg-gray-50">
                        <th className="px-3 py-2 text-left font-semibold text-gray-700">
                          Run / LLM
                        </th>
                        {REBALANCE_DISPLAY_HEADERS.map((header) => (
                          <th
                            key={`breakup-${stock.key}-${header}`}
                            className="whitespace-nowrap px-3 py-2 text-left font-semibold text-gray-700"
                          >
                            {header}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {stock.rows.map((row) => (
                        <tr key={`${row.meta.runId}-${row.meta.jobId}`}>
                          <td className="whitespace-nowrap px-3 py-2 align-top text-gray-700">
                            <div className="font-semibold">
                              {row.meta.runLabel}
                            </div>
                            <div>
                              {row.meta.provider} {row.meta.model}
                            </div>
                            <div className="text-gray-400">
                              {formatDateTime(row.meta.createdAt)}
                            </div>
                          </td>
                          {REBALANCE_DISPLAY_HEADERS.map((header) => (
                            <td
                              key={`${row.meta.runId}-${row.meta.jobId}-${header}`}
                              className="px-3 py-2 align-top text-gray-700"
                            >
                              {header === ACTION_HEADER ? (
                                <div className="space-y-1">
                                  <RebalanceCell
                                    row={row.cells}
                                    header={header}
                                    market={market}
                                    setupGroups={setupGroups}
                                    onSetupClick={onSetupClick}
                                    preferActionTag
                                  />
                                </div>
                              ) : LLM_BREAKUP_RATIONALE_HEADERS.includes(header as (typeof LLM_BREAKUP_RATIONALE_HEADERS)[number]) ? (
                                <CapturedRationalesCell row={row.cells} />
                              ) : (
                                <RebalanceCell
                                  row={row.cells}
                                  header={header}
                                  market={market}
                                  setupGroups={setupGroups}
                                  onSetupClick={onSetupClick}
                                  preferActionTag
                                />
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
