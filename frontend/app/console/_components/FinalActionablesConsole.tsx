"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";

import {
  parseInvestmentRecommendationContent,
  REBALANCE_HEADER_ORDER,
  type CanonicalRow,
  type RebalanceHeader,
} from "@/components/InvestmentRecommendationTable";
import { PortfolioAnalysisNav } from "@/components/shared/PortfolioAnalysisNav";
import { TradingViewSymbolLink } from "@/components/shared/TradingViewSymbolLink";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { inferRebalanceMarketFromPrompt, type RebalancePortfolioKey } from "@/lib/rebalance";
import type { SwingTradeMarket } from "@/lib/swingTrade";
import { cn } from "@/lib/utils";
import { apiService } from "@/services/api";
import type { RunResponse } from "@/types/api";

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

type StockConsensus = {
  key: string;
  exchange: string;
  symbol: string;
  consensusAction: ActionCategory;
  actionCounts: Record<ActionCategory, number>;
  totalSuggestions: number;
  representative: CanonicalRow;
  rows: LlmBreakupRow[];
};

const ACTION_CATEGORIES: ActionCategory[] = ["Sell All", "Trim", "Hold", "Add more", "Buy New"];
const ACTION_HEADER: RebalanceHeader = "Action (Buy/Add/Sell All/Trim/Hold/Buy New)";
const CATEGORY_BADGE_CLASS: Record<ActionCategory, string> = {
  "Sell All": "border-red-200 bg-red-50 text-red-700",
  Trim: "border-orange-200 bg-orange-50 text-orange-700",
  Hold: "border-slate-200 bg-slate-50 text-slate-700",
  "Add more": "border-blue-200 bg-blue-50 text-blue-700",
  "Buy New": "border-emerald-200 bg-emerald-50 text-emerald-700",
};

const PAGE_COPY: Record<RebalancePortfolioKey, { title: string; description: string }> = {
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
  const action = value.toLowerCase().replace(/[\s_-]+/g, " ").trim();
  if (!action) return null;
  if (action.includes("sell all") || action === "sell") return "Sell All";
  if (action.includes("trim") || action.includes("reduce")) return "Trim";
  if (action.includes("buy new") || action.includes("new buy")) return "Buy New";
  if (action.includes("add") || action.includes("buy more")) return "Add more";
  if (action.includes("hold")) return "Hold";
  return null;
}

function getStockKey(row: CanonicalRow) {
  const exchange = (row["Exchange Symbol"] || "UNKNOWN").trim().toUpperCase();
  const symbol = (row["Stock Symbol"] || row["Stock Name"] || "UNKNOWN").trim().toUpperCase();
  return `${exchange}:${symbol}`;
}

function isCompletedRebalanceRun(run: RunResponse, market: SwingTradeMarket) {
  return run.status === "completed" && inferRebalanceMarketFromPrompt(run.prompt) === market;
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

function buildConsensusRows(runs: RunResponse[]): StockConsensus[] {
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
      const actionCounts = ACTION_CATEGORIES.reduce((acc, action) => {
        acc[action] = 0;
        return acc;
      }, {} as Record<ActionCategory, number>);

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
      representative[ACTION_HEADER] = ACTION_CATEGORIES
        .filter((action) => actionCounts[action] > 0)
        .map((action) => `${action} (${actionCounts[action]}/${rows.length})`)
        .join("; ") || "No action consensus";
      representative["Confidence Score (0-100)"] = summarizeNumeric(rows, "Confidence Score (0-100)");
      representative["Rationale Remarks"] = summarizeRationales(rows);

      return {
        key,
        exchange: first["Exchange Symbol"] || "",
        symbol: first["Stock Symbol"] || first["Stock Name"] || key,
        consensusAction,
        actionCounts,
        totalSuggestions: rows.length,
        representative,
        rows,
      };
    })
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function summarizeNumeric(rows: LlmBreakupRow[], header: RebalanceHeader) {
  const values = rows
    .map((row) => Number(String(row.cells[header] || "").replace(/[^\d.-]/g, "")))
    .filter((value) => Number.isFinite(value));
  if (!values.length) return "";
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return `${average.toFixed(0)} avg (${values.length} LLMs)`;
}

function summarizeRationales(rows: LlmBreakupRow[]) {
  return rows
    .slice(0, 3)
    .map((row) => `${row.meta.provider} ${row.meta.model}: ${row.cells["Rationale Remarks"] || row.cells["Technical Setup"] || "No rationale"}`)
    .join(" | ");
}

function ActionSummarySections({ consensus }: { consensus: StockConsensus[] }) {
  return (
    <div className="grid gap-4 lg:grid-cols-5">
      {ACTION_CATEGORIES.map((action) => {
        const stocks = consensus.filter((item) => item.consensusAction === action);
        return (
          <Card key={action} className={cn("border", CATEGORY_BADGE_CLASS[action])}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">{action}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              <div className="font-semibold">{stocks.length} stock{stocks.length === 1 ? "" : "s"}</div>
              <div className="space-y-1 text-gray-700">
                {stocks.length ? stocks.map((stock) => (
                  <div key={stock.key} className="flex items-center justify-between gap-2">
                    <span className="font-medium">{stock.symbol}</span>
                    <span>{stock.actionCounts[action]}/{stock.totalSuggestions}</span>
                  </div>
                )) : <span>No consensus stocks.</span>}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function RebalanceCell({ row, header, market }: { row: CanonicalRow; header: RebalanceHeader; market: SwingTradeMarket }) {
  const cellValue = row[header];
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

  const loadRuns = useCallback(async (showLoading = true) => {
    if (showLoading) {
      setLoading(true);
      setError(null);
    }
    try {
      const response = await fetchAllFullRuns();
      setRuns(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load rebalance runs.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let ignore = false;
    fetchAllFullRuns()
      .then((response) => {
        if (!ignore) setRuns(response);
      })
      .catch((err: unknown) => {
        if (!ignore) {
          setError(err instanceof Error ? err.message : "Failed to load rebalance runs.");
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
      .sort((a, b) => parseTimestampMs(b.created_at) - parseTimestampMs(a.created_at));
    const latestRun = marketRuns[0];
    if (!latestRun) return { latestRun: null, runs: [] as RunResponse[] };
    const fingerprint = extractRebalanceInputFingerprint(latestRun.prompt);
    return {
      latestRun,
      runs: marketRuns.filter((run) => extractRebalanceInputFingerprint(run.prompt) === fingerprint),
    };
  }, [market, runs]);

  const consensus = useMemo(() => buildConsensusRows(groupedRuns.runs), [groupedRuns.runs]);
  const copy = PAGE_COPY[portfolio];

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
        <PortfolioAnalysisNav portfolio={portfolio} active="finalActionables" className="justify-center" />

        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-blue-600">Final Actionables</p>
            <h1 className="mt-2 text-3xl font-bold text-gray-900">{copy.title}</h1>
            <p className="mt-2 max-w-3xl text-sm text-gray-600">{copy.description}</p>
          </div>
          <Button onClick={() => void loadRuns()} variant="outline" disabled={loading}>
            <RefreshCw className={cn("mr-2 h-4 w-4", loading ? "animate-spin" : "")} />
            Refresh
          </Button>
        </div>

        {error ? (
          <Card className="border-red-200 bg-red-50">
            <CardContent className="pt-6 text-sm text-red-700">{error}</CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Run Group</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 text-sm text-gray-600 sm:grid-cols-3">
            <div>
              <div className="font-semibold text-gray-900">Latest matching run</div>
              <div>{groupedRuns.latestRun ? `#${groupedRuns.latestRun.id}` : "None found"}</div>
            </div>
            <div>
              <div className="font-semibold text-gray-900">Runs consolidated</div>
              <div>{groupedRuns.runs.length}</div>
            </div>
            <div>
              <div className="font-semibold text-gray-900">LLM outputs consolidated</div>
              <div>{consensus.reduce((sum, stock) => sum + stock.totalSuggestions, 0)}</div>
            </div>
          </CardContent>
        </Card>

        <ActionSummarySections consensus={consensus} />

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Stock-wise Consolidated Rebalance Output</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="py-12 text-center text-sm text-gray-500">Loading final actionables…</div>
            ) : consensus.length ? (
              <div className="overflow-x-auto">
                <table className="min-w-max text-sm">
                  <thead>
                    <tr className="border-b border-gray-300 bg-gray-50">
                      {REBALANCE_HEADER_ORDER.map((header) => (
                        <th key={header} className="whitespace-nowrap px-3 py-2 text-left font-semibold text-gray-700">
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
                        />
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="mx-auto max-w-2xl py-12 text-center text-sm text-gray-500">
                No completed rebalance output tables were found for the latest matching input set. Runs with empty or missing prompts are ignored by the input-set matcher until a completed rebalance response is available.
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

function FragmentRows({
  stock,
  isExpanded,
  onToggle,
  market,
}: {
  stock: StockConsensus;
  isExpanded: boolean;
  onToggle: () => void;
  market: SwingTradeMarket;
}) {
  return (
    <>
      <tr className="cursor-pointer hover:bg-gray-50" onClick={onToggle}>
        {REBALANCE_HEADER_ORDER.map((header) => {
          const content = header === "Stock Symbol" ? (
            <span className="inline-flex items-center gap-2">
              {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              <RebalanceCell row={stock.representative} header={header} market={market} />
            </span>
          ) : (
            <RebalanceCell row={stock.representative} header={header} market={market} />
          );
          return <td key={`${stock.key}-${header}`} className="px-3 py-2 align-top text-gray-700">{content}</td>;
        })}
      </tr>
      {isExpanded ? (
        <tr className="bg-gray-50/70">
          <td colSpan={REBALANCE_HEADER_ORDER.length} className="px-3 py-4">
            <div className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-gray-500">
              LLM-wise breakup leading to consolidation
            </div>
            <div className="overflow-x-auto rounded-lg border bg-white">
              <table className="min-w-max text-xs">
                <thead>
                  <tr className="border-b bg-gray-50">
                    <th className="px-3 py-2 text-left font-semibold text-gray-700">Run / LLM</th>
                    {REBALANCE_HEADER_ORDER.map((header) => (
                      <th key={`breakup-${stock.key}-${header}`} className="whitespace-nowrap px-3 py-2 text-left font-semibold text-gray-700">
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {stock.rows.map((row) => (
                    <tr key={`${row.meta.runId}-${row.meta.jobId}`}>
                      <td className="whitespace-nowrap px-3 py-2 align-top text-gray-700">
                        <div className="font-semibold">Run #{row.meta.runId}</div>
                        <div>{row.meta.provider} {row.meta.model}</div>
                        <div className="text-gray-400">{formatDateTime(row.meta.createdAt)}</div>
                      </td>
                      {REBALANCE_HEADER_ORDER.map((header) => (
                        <td key={`${row.meta.runId}-${row.meta.jobId}-${header}`} className="px-3 py-2 align-top text-gray-700">
                          <RebalanceCell row={row.cells} header={header} market={market} />
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
