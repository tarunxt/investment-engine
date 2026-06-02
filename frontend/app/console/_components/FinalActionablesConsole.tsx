"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronUp, RefreshCw } from "lucide-react";

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
import { BULLISH_SETUPS, BEARISH_SETUPS } from "@/lib/technicalSetups";
import { cn } from "@/lib/utils";
import { useUsdInrRate } from "@/hooks/useUsdInrRate";
import { apiService } from "@/services/api";
import type { PortfolioAnalysisHistoryItem, ProviderModelTarget, RunResponse } from "@/types/api";

type ActionCategory = "Sell All" | "Trim" | "Hold" | "Add more" | "Buy New";

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
  units: number | null;
  amount: number | null;
};

type StockConsensus = {
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


const ACTION_CATEGORIES: ActionCategory[] = [
  "Sell All",
  "Trim",
  "Hold",
  "Add more",
  "Buy New",
];
const ACTION_HEADER: RebalanceHeader =
  "Action (Buy/Add/Sell All/Trim/Hold/Buy New)";
const ACTION_ESTIMATE_CATEGORIES = new Set<ActionCategory>([
  "Sell All",
  "Trim",
  "Add more",
  "Buy New",
]);
const CONSOLIDATED_DISPLAY_HEADERS = [
  "Exchange Symbol",
  "Stock Symbol",
  "Current Units",
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
  Trim: "border-orange-200 bg-orange-50 text-orange-700",
  Hold: "border-slate-200 bg-slate-50 text-slate-700",
  "Add more": "border-blue-200 bg-blue-50 text-blue-700",
  "Buy New": "border-emerald-200 bg-emerald-50 text-emerald-700",
};

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

function extractRebalanceInputFingerprint(prompt?: string | null) {
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

function getStockKey(row: CanonicalRow) {
  const exchange = (row["Exchange Symbol"] || "UNKNOWN").trim().toUpperCase();
  const symbol = (row["Stock Symbol"] || row["Stock Name"] || "UNKNOWN")
    .trim()
    .toUpperCase();
  return `${exchange}:${symbol}`;
}

function getStockIdentityKey(exchange: string, symbol: string) {
  return `${(exchange || "UNKNOWN").trim().toUpperCase()}:${(symbol || "UNKNOWN").trim().toUpperCase()}`;
}

function normalizeScanCell(value?: string | null) {
  return String(value || "").replace(/^`+|`+$/g, "").trim();
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
    if (!line.includes("|") || !/stock symbol/i.test(line) || !/primary setup/i.test(line)) {
      continue;
    }

    const headers = splitMarkdownRow(line).map((header) => header.toLowerCase());
    const getIndex = (names: string[]) =>
      headers.findIndex((header) => names.some((name) => header === name || header.includes(name)));
    const exchangeIndex = getIndex(["exchange symbol", "exchange"]);
    const symbolIndex = getIndex(["stock symbol", "symbol"]);
    const primaryIndex = getIndex(["primary setup"]);
    const secondaryIndex = getIndex(["secondary setups", "secondary setup"]);
    const biasIndex = getIndex(["bias"]);
    const confidenceIndex = getIndex(["confidence score", "confidence"]);
    const triggerIndex = getIndex(["trigger level", "trigger"]);
    const invalidationIndex = getIndex(["invalidation level", "invalidation"]);

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
      if (!stockSymbol || /^stock symbol$/i.test(stockSymbol)) continue;
      const exchangeSymbol = normalizeScanCell(cells[exchangeIndex] || "");
      const primarySetup = normalizeScanCell(cells[primaryIndex] || "");
      const secondarySetups = normalizeScanCell(cells[secondaryIndex] || "");
      const rawBias = normalizeScanCell(cells[biasIndex] || `${primarySetup} ${secondarySetups}`).toLowerCase();
      const bias = rawBias.includes("bear")
        ? "bearish"
        : rawBias.includes("bull")
          ? "bullish"
          : "neutral";

      results.push({
        stockSymbol,
        exchangeSymbol,
        primarySetup,
        secondarySetups,
        confidenceScore: normalizeScanCell(cells[confidenceIndex] || ""),
        bias,
        triggerLevel: normalizeScanCell(cells[triggerIndex] || ""),
        invalidationLevel: normalizeScanCell(cells[invalidationIndex] || ""),
        ...meta,
      });
    }
    break;
  }

  return results;
}

function buildTechnicalScanMap(runs: RunResponse[]): TechnicalScanMap {
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
  return scanMap[getStockIdentityKey(stock.exchange, stock.symbol)] ?? scanMap[getStockIdentityKey("UNKNOWN", stock.symbol)] ?? null;
}

function formatTechnicalSetup(scan: TechnicalScanResult | null) {
  if (!scan) return "";
  const secondary = scan.secondarySetups && scan.secondarySetups !== "—" ? `; ${scan.secondarySetups}` : "";
  return `${scan.primarySetup || "No clean setup"}${secondary}`;
}

function formatTechnicalConfidence(scan: TechnicalScanResult | null) {
  if (!scan) return "";
  return scan.confidenceScore || "";
}

function getTechnicalScanClass(scan: TechnicalScanResult | null) {
  if (!scan) return "text-gray-400";
  if (scan.bias === "bullish") return "text-emerald-700";
  if (scan.bias === "bearish") return "text-red-700";
  return "text-gray-700";
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

function buildTechnicalScanPrompt(stocks: StockConsensus[], market: SwingTradeMarket) {
  const stockRows = stocks
    .map(
      (stock) =>
        `| ${stock.exchange || (market === "us" ? "US" : "NSE")} | ${stock.symbol} | ${stock.consensusAction} | ${stock.totalSuggestions} |`,
    )
    .join("\n");

  return `${TECHNICAL_SCAN_MARKER}\nMarket: ${market === "us" ? "US equities" : "India equities"}\n\nStock list:\n| Exchange Symbol | Stock Symbol | Consensus Action | Suggestions Count |\n|---|---|---|---:|\n${stockRows}\n\nApproved Technical Setups list from sidebar:\n${setupListMarkdown()}\n\nAct as a top-tier technical analyst and swing-trading strategist.\n\nObjective:\nFor the stock list given above, search the internet for the latest available technical data, price action, chart structure, moving averages, volume behaviour, RSI/divergence, support-resistance, breakout/breakdown levels, 52-week high/low position, and recent trend strength. Then tag each stock with the most relevant Bullish and/or Bearish setup names from the approved Technical Setups list above.\n\nImportant rules:\n- Use current fresh internet data only. Do not rely on stale memory.\n- Prefer sources such as TradingView, StockCharts, Yahoo Finance, MarketWatch, Investing.com, Screener, NSE/BSE, Nasdaq, Trendlyne, Chartink, StockEdge, or other reliable chart/technical sources.\n- Check at least daily chart data. If possible, also consider weekly chart for broader trend.\n- Tag only from the approved setup names above. Do not invent new setup names.\n- Every stock must receive a Primary Setup. Use "No clean setup" only if the setup is unclear after checking the chart.\n- A stock can have more than one tag, but choose one Primary Setup and optionally 1-3 Secondary Setups.\n- For bearish setups, treat them as sell/trim/avoid fresh buying/exit weak holdings — not short-selling.\n- Give a confidence score for the stock-specific tag based on chart clarity, volume confirmation, trend alignment, and invalidation level.\n- Always mention the exact trigger level and invalidation level wherever possible.\n- Do not give generic advice. Make the tagging specific to the latest chart structure.\n\nReturn ONLY this markdown table and no extra prose:\n| ${TECHNICAL_SCAN_TABLE_COLUMNS.join(" | ")} |\n| ${TECHNICAL_SCAN_TABLE_COLUMNS.map(() => "---").join(" | ")} |\n| EXCHANGE | SYMBOL | Approved setup name or No clean setup | Optional approved setup names | Bullish/Bearish/Neutral | 0-100 | exact price/level | exact price/level |`;
}

function isCompletedRebalanceRun(run: RunResponse, market: SwingTradeMarket) {
  return (
    run.status === "completed" &&
    inferRebalanceMarketFromPrompt(run.prompt) === market
  );
}

async function fetchAllFullRuns() {
  const firstPage = await apiService.getFullRuns({ page: 1, limit: 100 });
  const items = [...firstPage.items];

  for (let page = 2; page <= firstPage.pages; page += 1) {
    const nextPage = await apiService.getFullRuns({ page, limit: 100 });
    items.push(...nextPage.items);
  }

  return items;
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

function buildConsensusRows(
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

      const first = rows[0].cells;
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

function ActionSummarySections({
  consensus,
  market,
  technicalScans,
}: {
  consensus: StockConsensus[];
  market: SwingTradeMarket;
  technicalScans: TechnicalScanMap;
}) {
  return (
    <div className="space-y-4">
      {ACTION_CATEGORIES.map((action) => {
        const stocks = consensus.filter(
          (item) => item.consensusAction === action,
        );
        return (
          <Card
            key={action}
            className={cn("border", CATEGORY_BADGE_CLASS[action])}
          >
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">{action}</CardTitle>
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
                        <th className="px-3 py-2 font-semibold">Units to {getActionVerb(action)}</th>
                        <th className="px-3 py-2 font-semibold">Amount</th>
                        <th className="px-3 py-2 font-semibold">Technical Setup</th>
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
                        return (
                          <tr key={stock.key} className="bg-white/40">
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
                              {showActionColumns ? formatQuantity(estimate.units) : "—"}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 align-top text-gray-700">
                              {showActionColumns ? formatDisplayAmount(estimate.amount, market) : "—"}
                            </td>
                            <td className={cn("min-w-56 px-3 py-2 align-top font-medium", getTechnicalScanClass(scan))}>
                              {formatTechnicalSetup(scan)}
                            </td>
                            <td className={cn("whitespace-nowrap px-3 py-2 align-top font-semibold", getTechnicalScanClass(scan))}>
                              {formatTechnicalConfidence(scan)}
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
}: {
  row: CanonicalRow;
  header: ConsolidatedDisplayHeader;
  market: SwingTradeMarket;
  technicalScan?: TechnicalScanResult | null;
}) {
  if (header === "Technical Setup") {
    return (
      <span className={cn("font-medium", getTechnicalScanClass(technicalScan || null))}>
        {formatTechnicalSetup(technicalScan || null)}
      </span>
    );
  }
  if (header === "Confidence Score") {
    return (
      <span className={cn("font-semibold", getTechnicalScanClass(technicalScan || null))}>
        {formatTechnicalConfidence(technicalScan || null)}
      </span>
    );
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

export function FinalActionablesConsole({
  portfolio,
  market,
}: {
  portfolio: RebalancePortfolioKey;
  market: SwingTradeMarket;
}) {
  const [runs, setRuns] = useState<RunResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showRunDetails, setShowRunDetails] = useState(false);
  const [technicalScanRunning, setTechnicalScanRunning] = useState(false);
  const [technicalScanMessage, setTechnicalScanMessage] = useState<string | null>(null);
  const usdInrRate = useUsdInrRate();

  const loadRuns = useCallback(async (showLoading = true) => {
    if (showLoading) {
      setLoading(true);
      setError(null);
    }
    try {
      const response = await fetchAllFullRuns();
      setRuns(response);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load rebalance runs.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  const loadTechnicalScanHistory = useCallback(async () => {
    const response = await fetchAllFullRuns();
    setRuns(response);
    return buildTechnicalScanHistory(response);
  }, []);

  useEffect(() => {
    let ignore = false;
    fetchAllFullRuns()
      .then((response) => {
        if (!ignore) setRuns(response);
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
  }, []);

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
  const totalStocksConsolidated = consensus.reduce(
    (sum, stock) => sum + stock.totalSuggestions,
    0,
  );
  const technicalScans = useMemo(() => buildTechnicalScanMap(runs), [runs]);
  const technicalScanHistory = useMemo(() => buildTechnicalScanHistory(runs), [runs]);
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
    setTechnicalScanMessage(null);
    try {
      const run = await apiService.createRun({
        prompt: buildTechnicalScanPrompt(consensus, market),
        targets: [target],
        allow_parallel: true,
      });
      setTechnicalScanMessage(`Queued technical scan run #${run.id} with ${target.provider}/${target.model}. Refresh after it completes to map the latest setup data.`);
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
              buttonLabel="Technical Scan"
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

        {technicalScanMessage ? (
          <Card className="border-blue-200 bg-blue-50">
            <CardContent className="pt-6 text-sm text-blue-700">
              {technicalScanMessage}
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
                            {header}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {consensus.map((stock) => {
                        const isExpanded = expanded.has(stock.key);
                        return (
                          <FragmentRows
                            key={stock.key}
                            stock={stock}
                            isExpanded={isExpanded}
                            onToggle={() => toggleExpanded(stock.key)}
                            market={market}
                            technicalScan={getTechnicalScanForStock(technicalScans, stock)}
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
    </div>
  );
}

function FragmentRows({
  stock,
  isExpanded,
  onToggle,
  market,
  technicalScan,
}: {
  stock: StockConsensus;
  isExpanded: boolean;
  onToggle: () => void;
  market: SwingTradeMarket;
  technicalScan: TechnicalScanResult | null;
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
            <RebalanceCell
              row={stock.representative}
              header={header}
              market={market}
              technicalScan={technicalScan}
            />
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
                    {REBALANCE_HEADER_ORDER.map((header) => (
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
                      {REBALANCE_HEADER_ORDER.map((header) => (
                        <td
                          key={`${row.meta.runId}-${row.meta.jobId}-${header}`}
                          className="px-3 py-2 align-top text-gray-700"
                        >
                          <RebalanceCell
                            row={row.cells}
                            header={header}
                            market={market}
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
