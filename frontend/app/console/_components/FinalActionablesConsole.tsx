"use client";

import { useCallback, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, ChevronDown, ChevronUp, Info, RefreshCw, X } from "lucide-react";

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

type LlmBreakupRow = {
  cells: CanonicalRow;
  meta: {
    runId: number;
    jobId: number;
    provider: string;
    model: string;
    createdAt: string;
  };
};

type ActionEstimate = {
  currentUnits: number | null;
  currentInvestmentAmount: number | null;
  units: number | null;
  amount: number | null;
};

export type SetupStockDetail = {
  key: string;
  name: string;
  symbol: string;
  exchange: string;
  market: SwingTradeMarket;
  currentUnits: string;
  currentInvestment: string;
  action: ActionCategory;
};

export type SetupStockGroup = {
  setup: string;
  stocks: SetupStockDetail[];
};

const SETUP_STOCK_ACTION_PRIORITY: Record<ActionCategory, number> = {
  "Sell All": 0,
  "Add more": 1,
  "Buy New": 2,
  Trim: 3,
  Hold: 4,
};

const SETUP_STOCK_ACTION_CLASSES: Record<
  ActionCategory,
  { row: string; nameCell: string; cell: string }
> = {
  "Sell All": {
    row: "bg-red-100",
    nameCell: "text-red-950",
    cell: "text-red-900",
  },
  "Add more": {
    row: "bg-emerald-100",
    nameCell: "text-emerald-950",
    cell: "text-emerald-900",
  },
  Trim: {
    row: "bg-red-50",
    nameCell: "text-red-950",
    cell: "text-red-800",
  },
  "Buy New": {
    row: "bg-emerald-50",
    nameCell: "text-emerald-950",
    cell: "text-emerald-800",
  },
  Hold: {
    row: "bg-yellow-50",
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
};

type TechnicalScanResult = {
  stockSymbol: string;
  exchangeSymbol: string;
  primarySetup: string;
  secondarySetups: string;
  confidenceScore: string;
  bias: "bullish" | "bearish" | "neutral";
  triggerLevel: string;
  invalidationLevel: string;
  runId: number;
  jobId: number;
  provider: string;
  model: string;
  createdAt: string;
};

type TechnicalScanMap = Record<string, TechnicalScanResult>;

type StockDetailsData = {
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

type CachedFinalActionablesRuns = {
  version: number;
  cachedAt: number;
  runs: RunResponse[];
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
        className={cn("text-left underline-offset-4 transition hover:text-blue-700 hover:underline focus:outline-none focus:ring-2 focus:ring-blue-500", className)}
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
      className={cn("underline-offset-4 transition hover:text-blue-700 hover:underline", className)}
      onClick={stopRowToggle}
    >
      {label}
    </Link>
  );
}

const ACTION_CATEGORIES: ActionCategory[] = [
  "Sell All",
  "Add more",
  "Buy New",
  "Trim",
  "Hold",
];
const ACTION_HEADER: RebalanceHeader =
  "Action (Buy/Add/Sell All/Trim/Hold/Buy New)";
const CURRENT_INVESTMENT_AMOUNT_HEADER = "Current Investment Amount";
const ACTION_ESTIMATE_CATEGORIES = new Set<ActionCategory>([
  "Sell All",
  "Trim",
  "Add more",
  "Buy New",
]);
const REBALANCE_DISPLAY_HEADERS = [
  ...REBALANCE_HEADER_ORDER.slice(0, 3),
  CURRENT_INVESTMENT_AMOUNT_HEADER,
  ...REBALANCE_HEADER_ORDER.slice(3),
] as const;

const CONSOLIDATED_DISPLAY_HEADERS = [
  "Exchange Symbol",
  "Stock Symbol",
  "Current Units",
  CURRENT_INVESTMENT_AMOUNT_HEADER,
  "Action (Buy/Add/Sell All/Trim/Hold/Buy New)",
  "Units to Sell/Buy",
  "Amount",
  "Technical Setup",
  "Confidence Score",
  ...REBALANCE_HEADER_ORDER.filter(
    (header) =>
      ![
        "Exchange Symbol",
        "Stock Symbol",
        "Current Units",
        "Action (Buy/Add/Sell All/Trim/Hold/Buy New)",
      ].includes(header),
  ),
] as const;

type ConsolidatedDisplayHeader =
  | (typeof CONSOLIDATED_DISPLAY_HEADERS)[number]
  | RebalanceHeader;

const CATEGORY_BADGE_CLASS: Record<ActionCategory, string> = {
  "Sell All": "border-red-200 bg-red-50 text-red-700",
  "Add more": "border-blue-200 bg-blue-50 text-blue-700",
  "Buy New": "border-emerald-200 bg-emerald-50 text-emerald-700",
  Trim: "border-orange-200 bg-orange-50 text-orange-700",
  Hold: "border-slate-200 bg-slate-50 text-slate-700",
};

const ACTION_CATEGORY_LABEL: Record<ActionCategory, string> = {
  "Sell All": "Sell All",
  "Add more": "Add More",
  "Buy New": "Buy New",
  Trim: "Trim",
  Hold: "Hold",
};

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
  const currentUnits = parseNumericCell(row["Current Units"]);
  const price = parseNumericCell(row["Price Per Unit"]);
  if (currentUnits === null || price === null) return null;
  return Math.abs(currentUnits * price);
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
): ActionEstimate {
  const matchingRows = rows.filter(
    (row) => normalizeAction(row.cells[ACTION_HEADER] || "") === action,
  );
  const currentUnitValues = matchingRows
    .map((row) => parseNumericCell(row.cells["Current Units"]))
    .filter((value): value is number => value !== null);
  const currentInvestmentValues = matchingRows
    .map((row) => getCurrentInvestmentAmount(row.cells))
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
    maximumFractionDigits: 0,
  }).format(value);
}

function getActionVerb(action: ActionCategory) {
  return action === "Sell All" || action === "Trim" ? "sell" : "buy";
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

function getFormattedCurrentInvestmentAmount(row: CanonicalRow, market: SwingTradeMarket) {
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
  return `${(exchange || "UNKNOWN").trim().toUpperCase()}:${(symbol || "UNKNOWN").trim().toUpperCase()}`;
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
  meta: Pick<TechnicalScanResult, "runId" | "jobId" | "provider" | "model" | "createdAt">,
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

function getTechnicalScanForStock(scanMap: TechnicalScanMap, stock: StockConsensus) {
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
  const approvedSetup = resolveApprovedTechnicalSetup(scan, row);
  return approvedSetup ? approvedSetup.confidence.toFixed(1) : getFallbackTechnicalConfidence(row);
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
      currentInvestment: getFormattedCurrentInvestmentAmount(stock.representative, market),
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

  return `${TECHNICAL_SCAN_MARKER}\nMarket: ${market === "us" ? "US equities" : "India equities"}\n\nStock list:\n| Exchange Symbol | Stock Symbol | Consensus Action | Suggestions Count |\n|---|---|---|---:|\n${stockRows}\n\nApproved Technical Setups list from sidebar:\n${setupListMarkdown()}\n\nAct as a top-tier technical analyst and swing-trading strategist.\n\nObjective:\nFor the stock list given above, search the internet for the latest available technical data, price action, chart structure, moving averages, volume behaviour, RSI/divergence, support-resistance, breakout/breakdown levels, 52-week high/low position, and recent trend strength. Then tag each stock with the most relevant Bullish and/or Bearish setup names from the approved Technical Setups list above.\n\nImportant rules:\n- Use current fresh internet data only. Do not rely on stale memory.\n- Prefer sources such as TradingView, StockCharts, Yahoo Finance, MarketWatch, Investing.com, Screener, NSE/BSE, Nasdaq, Trendlyne, Chartink, StockEdge, or other reliable chart/technical sources.\n- Check at least daily chart data. If possible, also consider weekly chart for broader trend.\n- Tag only from the approved setup names above. Do not invent, paraphrase, or abbreviate setup names.\n- Every stock must receive a Primary Setup that exactly matches one Setup value from the approved Technical Setups list above.\n- A stock can have more than one tag, but choose one Primary Setup and optionally 1-3 Secondary Setups; every setup name must exactly match an approved Setup value.\n- For bearish setups, treat them as sell/trim/avoid fresh buying/exit weak holdings — not short-selling.\n- For Confidence Score, copy the numeric Confidence value from the approved Technical Setups list for the same Primary Setup. Return only the number, without /10, %, avg text, or LLM counts.\n- Always mention the exact trigger level and invalidation level wherever possible.\n- Do not give generic advice. Make the tagging specific to the latest chart structure.\n\nReturn ONLY this markdown table and no extra prose:\n| ${TECHNICAL_SCAN_TABLE_COLUMNS.join(" | ")} |\n| ${TECHNICAL_SCAN_TABLE_COLUMNS.map(() => "---").join(" | ")} |\n| EXCHANGE | SYMBOL | Exact approved primary setup name | Optional exact approved setup names | Bullish/Bearish/Neutral | approved confidence number only | exact price/level | exact price/level |`;
}

export function isCompletedRebalanceRun(run: RunResponse, market: SwingTradeMarket) {
  return (
    run.status === "completed" &&
    inferRebalanceMarketFromPrompt(run.prompt) === market
  );
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

function parseRunRows(run: RunResponse): LlmBreakupRow[] {
  return (run.run_jobs ?? []).flatMap((link) => {
    const job = link.job;
    if (!job) return [];
    const response = job.response;
    if (job.status !== "completed" || !response) return [];
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
        provider: job.provider,
        model: job.model,
        createdAt: job.created_at,
      },
    }));
  });
}

export function buildConsensusRows(
  runs: RunResponse[],
  market: SwingTradeMarket,
): StockConsensus[] {
  const grouped = new Map<string, LlmBreakupRow[]>();

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
          acc[action] = summarizeActionEstimate(rows, action);
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

      const first = getRepresentativeConsensusRow(rows);
      const representative = { ...first };
      representative[ACTION_HEADER] =
        ACTION_CATEGORIES.filter((action) => actionCounts[action] > 0)
          .map((action) => `${action} (${actionCounts[action]}/${rows.length})`)
          .join("; ") || "No action consensus";
      representative["Confidence Score (0-100)"] = summarizeNumeric(
        rows,
        "Confidence Score (0-100)",
      );
      representative["Rationale Remarks"] = summarizeRationales(rows);
      const consensusEstimate = actionAverages[consensusAction];
      representative["Current Units"] = formatQuantity(
        consensusEstimate.currentUnits ?? parseNumericCell(first["Current Units"]),
      );
      representative[CURRENT_INVESTMENT_AMOUNT_HEADER] = formatDisplayAmount(
        consensusEstimate.currentInvestmentAmount ?? getCurrentInvestmentAmount(first),
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
        totalSuggestions: rows.length,
        representative,
        rows,
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
        `${row.meta.provider} ${row.meta.model}: ${row.cells["Rationale Remarks"] || row.cells["Technical Setup"] || "No rationale"}`,
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

function StockDetailsButton({
  stock,
  market,
  technicalScan,
  detailsData,
}: {
  stock: StockConsensus;
  market: SwingTradeMarket;
  technicalScan: TechnicalScanResult | null;
  detailsData: StockDetailsData;
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
        className="mr-2 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-gray-300 bg-white text-gray-500 transition hover:border-blue-400 hover:text-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
        aria-label={`Open ${stock.symbol} captured details`}
        title={`Open ${stock.symbol} captured details`}
      >
        <Info className="h-3 w-3" />
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
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-full p-2 text-gray-500 transition hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                aria-label="Close stock details"
              >
                <X className="h-5 w-5" />
              </button>
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
                    ["Consensus action", stock.consensusAction],
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
                        <th className="px-3 py-2">Rationale</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-violet-100">
                      {stock.rows.map((row) => (
                        <tr key={`${row.meta.runId}-${row.meta.jobId}-details`}>
                          <td className="whitespace-nowrap px-3 py-2 align-top">
                            Run #{row.meta.runId}<br />{row.meta.provider} {row.meta.model}<br />
                            <span className="text-gray-400">{formatDateTime(row.meta.createdAt)}</span>
                          </td>
                          <td className="px-3 py-2 align-top">{row.cells[ACTION_HEADER] || "—"}</td>
                          <td className="px-3 py-2 align-top">{row.cells["Units to Buy"] || row.cells["Units Change"] || "—"}</td>
                          <td className="px-3 py-2 align-top">{row.cells["Total Buy Amount"] || "—"}</td>
                          <td className="min-w-80 px-3 py-2 align-top">{row.cells["Rationale Remarks"] || row.cells["Technical Setup"] || "—"}</td>
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
}: {
  consensus: StockConsensus[];
  market: SwingTradeMarket;
  technicalScans: TechnicalScanMap;
  setupGroups: Record<string, SetupStockGroup>;
  detailsData: StockDetailsData;
  onSetupClick: (group: SetupStockGroup) => void;
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
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">{ACTION_CATEGORY_LABEL[action]}</CardTitle>
            </CardHeader>
            <CardContent className="text-xs">
              <div className="mb-3 font-semibold">
                {stocks.length} stock{stocks.length === 1 ? "" : "s"}
              </div>
              {stocks.length ? (
                <div className="overflow-x-auto">
                  <table className="min-w-full text-xs">
                    <thead>
                      <tr className="border-b border-gray-200 bg-white/60 text-left text-[11px] uppercase tracking-wide text-gray-500">
                        <th className="px-3 py-2 font-semibold">Stock</th>
                        <th className="px-3 py-2 font-semibold">Consensus</th>
                        <th className="px-3 py-2 font-semibold">Current Units</th>
                        <th className="px-3 py-2 font-semibold">Current Investment Amount</th>
                        <th className="px-3 py-2 font-semibold">Units to {getActionVerb(action)}</th>
                        <th className="px-3 py-2 font-semibold">Amount</th>
                        <th className="px-3 py-2 font-semibold">
                          <TechnicalSetupsHeaderLink>Technical Setup</TechnicalSetupsHeaderLink>
                        </th>
                        <th className="px-3 py-2 font-semibold">Confidence Score</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {stocks.map((stock) => {
                        const estimate = stock.actionAverages[action];
                        const showActionColumns =
                          action === "Sell All" ||
                          action === "Trim" ||
                          action === "Add more" ||
                          action === "Buy New";
                        const scan = getTechnicalScanForStock(technicalScans, stock);
                        const setup = formatTechnicalSetup(scan, stock.representative);
                        return (
                          <tr key={stock.key} className="bg-white/40">
                            <td className="whitespace-nowrap px-3 py-2 align-top">
                              <StockDetailsButton
                                stock={stock}
                                market={market}
                                technicalScan={scan}
                                detailsData={detailsData}
                              />
                              <TradingViewSymbolLink
                                symbol={stock.symbol}
                                market={market}
                                exchange={stock.exchange}
                                className="font-medium underline-offset-4 hover:text-blue-700 hover:underline"
                              >
                                {stock.symbol}
                              </TradingViewSymbolLink>
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 align-top text-gray-700">
                              {stock.actionCounts[action]}/{stock.totalSuggestions}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 align-top text-gray-700">
                              {formatQuantity(estimate.currentUnits)}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 align-top text-gray-700">
                              {formatDisplayAmount(estimate.currentInvestmentAmount ?? getCurrentInvestmentAmount(stock.representative), market)}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 align-top text-gray-700">
                              {showActionColumns ? formatQuantity(estimate.units) : "—"}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 align-top text-gray-700">
                              {showActionColumns ? formatDisplayAmount(estimate.amount, market) : "—"}
                            </td>
                            <td className={cn("min-w-56 px-3 py-2 align-top font-medium", getTechnicalScanClass(scan, stock.representative))}>
                              <TechnicalSetupLink
                                setup={setup}
                                setupGroup={getSetupStockGroup(setupGroups, setup)}
                                onSetupClick={onSetupClick}
                              />
                            </td>
                            <td className={cn("whitespace-nowrap px-3 py-2 align-top font-semibold", getTechnicalScanClass(scan, stock.representative))}>
                              {formatTechnicalConfidence(scan, stock.representative)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
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

function RebalanceCell({
  row,
  header,
  market,
  technicalScan,
  setupGroups,
  onSetupClick,
}: {
  row: CanonicalRow;
  header: ConsolidatedDisplayHeader;
  market: SwingTradeMarket;
  technicalScan?: TechnicalScanResult | null;
  setupGroups?: Record<string, SetupStockGroup>;
  onSetupClick?: (group: SetupStockGroup) => void;
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
  if (header === "Confidence Score") {
    return (
      <span className={cn("font-semibold", getTechnicalScanClass(technicalScan || null, row))}>
        {formatTechnicalConfidence(technicalScan || null, row)}
      </span>
    );
  }
  if (header === CURRENT_INVESTMENT_AMOUNT_HEADER) {
    return getFormattedCurrentInvestmentAmount(row, market);
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
      (run.run_jobs ?? []).filter((link) => link.job?.status === "completed")
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
  const [runs, setRuns] = useState<RunResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadRuns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRuns(await fetchAllFullRuns());
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

  const technicalScans = useMemo(() => buildTechnicalScanMap(runs), [runs]);
  const actionRowsByMarket = useMemo(() => ({
    india: buildConsensusRows(getLatestMatchingRuns(runs, "india"), "india").map((stock) => ({
      market: "india" as SwingTradeMarket,
      stock,
    })),
    us: buildConsensusRows(getLatestMatchingRuns(runs, "us"), "us").map((stock) => ({
      market: "us" as SwingTradeMarket,
      stock,
    })),
  }), [runs]);

  const renderMarketPanel = (market: SwingTradeMarket, title: string, description: string) => {
    const actionRows = actionRowsByMarket[market];

    return (
      <div id={market === "us" ? "final-actionable-us" : "final-actionable-zerodha"} className="scroll-mt-24 rounded-[28px] border border-slate-200 bg-white/80 p-4 shadow-sm">
        <div className="mb-4">
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            {market === "us" ? "US" : "Zerodha India"}
          </div>
          <h3 className="mt-1 font-serif text-xl tracking-tight text-slate-950">{title}</h3>
          <p className="mt-2 text-sm leading-6 text-slate-600">{description}</p>
        </div>

        <div className="space-y-4">
          {loading && actionRows.length === 0 ? (
            <div className="rounded-[20px] border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
              Loading final actionables…
            </div>
          ) : (
            ACTION_CATEGORIES.map((action) => {
              const rows = actionRows
                .filter(({ stock }) => stock.consensusAction === action)
                .sort((a, b) => {
                  const sorted = sortStocksByConfidence([a.stock, b.stock], technicalScans);
                  return sorted[0]?.key === a.stock.key ? -1 : 1;
                });

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
                              <th className="px-3 py-2 font-semibold">Stock</th>
                              <th className="px-3 py-2 font-semibold">Consensus</th>
                              <th className="px-3 py-2 font-semibold">Current Units</th>
                              <th className="px-3 py-2 font-semibold">Current Investment Amount</th>
                              <th className="px-3 py-2 font-semibold">Units to {getActionVerb(action)}</th>
                              <th className="px-3 py-2 font-semibold">Amount</th>
                              <th className="px-3 py-2 font-semibold">Technical Setup</th>
                              <th className="px-3 py-2 font-semibold">Confidence Score</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {rows.map(({ stock }) => {
                              const estimate = stock.actionAverages[action];
                              const showActionColumns = ACTION_ESTIMATE_CATEGORIES.has(action);
                              const scan = getTechnicalScanForStock(technicalScans, stock);
                              const setup = formatTechnicalSetup(scan, stock.representative);
                              return (
                                <tr key={`${market}-${stock.key}`} className="bg-white/40">
                                  <td className="whitespace-nowrap px-3 py-2 align-top">
                                    <TradingViewSymbolLink
                                      symbol={stock.symbol}
                                      market={market}
                                      exchange={stock.exchange}
                                      className="font-medium underline-offset-4 hover:text-blue-700 hover:underline"
                                    >
                                      {stock.symbol}
                                    </TradingViewSymbolLink>
                                  </td>
                                  <td className="whitespace-nowrap px-3 py-2 align-top text-gray-700">
                                    {stock.actionCounts[action]}/{stock.totalSuggestions}
                                  </td>
                                  <td className="whitespace-nowrap px-3 py-2 align-top text-gray-700">
                                    {formatQuantity(estimate.currentUnits)}
                                  </td>
                                  <td className="whitespace-nowrap px-3 py-2 align-top text-gray-700">
                                    {formatDisplayAmount(estimate.currentInvestmentAmount ?? getCurrentInvestmentAmount(stock.representative), market)}
                                  </td>
                                  <td className="whitespace-nowrap px-3 py-2 align-top text-gray-700">
                                    {showActionColumns ? formatQuantity(estimate.units) : "—"}
                                  </td>
                                  <td className="whitespace-nowrap px-3 py-2 align-top text-gray-700">
                                    {showActionColumns ? formatDisplayAmount(estimate.amount, market) : "—"}
                                  </td>
                                  <td className={cn("min-w-56 px-3 py-2 align-top font-medium", getTechnicalScanClass(scan, stock.representative))}>
                                    <TechnicalSetupLink setup={setup} />
                                  </td>
                                  <td className={cn("whitespace-nowrap px-3 py-2 align-top font-semibold", getTechnicalScanClass(scan, stock.representative))}>
                                    {formatTechnicalConfidence(scan, stock.representative)}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
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
    <section id="final-actionables" className="rounded-[32px] border border-slate-200 bg-white shadow-sm">
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
    () => buildConsensusRows(groupedRuns.runs, market),
    [groupedRuns.runs, market],
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
            />
          </>
        )}

        {!showRunDetails ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">
                Stock-wise Consolidated Rebalance Output
              </CardTitle>
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
                            setupGroups={setupStockGroups}
                            detailsData={detailsData}
                            onSetupClick={setSelectedSetupGroup}
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
      <SetupStocksModal
        group={selectedSetupGroup}
        onClose={() => setSelectedSetupGroup(null)}
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
                      {stock.action}
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
  setupGroups,
  detailsData,
  onSetupClick,
}: {
  stock: StockConsensus;
  isExpanded: boolean;
  onToggle: () => void;
  market: SwingTradeMarket;
  technicalScan: TechnicalScanResult | null;
  setupGroups: Record<string, SetupStockGroup>;
  detailsData: StockDetailsData;
  onSetupClick: (group: SetupStockGroup) => void;
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
          <td colSpan={CONSOLIDATED_DISPLAY_HEADERS.length + 1} className="px-3 py-4">
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
                          Run #{row.meta.runId}
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
                          <RebalanceCell
                            row={row.cells}
                            header={header}
                            market={market}
                            setupGroups={setupGroups}
                            onSetupClick={onSetupClick}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
