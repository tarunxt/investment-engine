"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  buildTradeAnalysisFiltersKey,
  readTradeAnalysisCache,
  writeTradeAnalysisCache,
} from "@/lib/bullpenTradeAnalysisFallback";
import { URLs } from "@/lib/urls";
import { apiService } from "@/services/api";
import { sessionStorage as authSessionStorage } from "@/services/session";
import type {
  BullpenTradeAnalysisLearningInsights,
  BullpenTradeAnalysisListItem,
  BullpenTradeAnalysisListResponse,
} from "@/types/api";

import {
  formatCurrency,
  formatDateTime,
  formatDuration,
  formatPercent,
  formatNumber,
  humanizeTag,
  JsonPanel,
  StatCard,
  TradeAnalysisBadge,
  tradeAnalysisSelectClassName,
} from "./tradeAnalysisShared";

type AnalysisFilters = {
  status: string;
  finalTag: string;
  fromDate: string;
  toDate: string;
  strategyVersion: string;
  category: string;
  topic: string;
};

const defaultFilters: AnalysisFilters = {
  status: "",
  finalTag: "",
  fromDate: "",
  toDate: "",
  strategyVersion: "",
  category: "",
  topic: "",
};

function cardToneClassName(item: BullpenTradeAnalysisListItem) {
  if (item.status === "FAILED") return "border-amber-200 bg-amber-50/40";
  if (item.final_tag === "OPEN") return "border-sky-200 bg-sky-50/40";
  if (item.pnl_outcome_tag === "PROFIT") return "border-emerald-200 bg-emerald-50/40";
  if (item.pnl_outcome_tag === "LOSS") return "border-rose-200 bg-rose-50/40";
  return "border-slate-200 bg-white";
}

function listEntries(items: Array<Record<string, unknown>>, labelKey: string) {
  return items.slice(0, 6).map((item, index) => {
    const label = String(item[labelKey] ?? item.bucket ?? item.reason ?? `Item ${index + 1}`);
    const average = item.average_pnl;
    const total = item.total_pnl;
    const count = item.count;
    const details = [
      typeof count === "number" ? `${count} trades` : null,
      typeof average === "number" ? `avg ${formatCurrency(average)}` : null,
      typeof total === "number" ? `total ${formatCurrency(total)}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return `${label}: ${details || "No aggregate detail yet."}`;
  });
}

function formatExecutionSummary({
  amount,
  shares,
  price,
  odds,
}: {
  amount?: number | null;
  shares?: number | null;
  price?: number | null;
  odds?: number | null;
}) {
  const parts = [
    amount !== null && amount !== undefined ? formatCurrency(amount) : null,
    shares !== null && shares !== undefined ? `${formatNumber(shares, 4)} sh` : null,
    price !== null && price !== undefined ? `@ ${formatNumber(price, 4)}` : null,
    odds !== null && odds !== undefined ? formatPercent(odds, 2) : null,
  ].filter(Boolean);
  return parts.join(" · ") || "—";
}

function exitTimestamp(item: BullpenTradeAnalysisListItem) {
  return (
    item.sell_executed_at ||
    item.redeemed_at ||
    item.closed_at ||
    item.sold_at
  );
}

function pnlOutcomeLabel(item: BullpenTradeAnalysisListItem) {
  if (item.pnl_outcome_tag && item.pnl_outcome_tag !== "OPEN") {
    return humanizeTag(item.pnl_outcome_tag);
  }
  return item.is_squared_off ? "REALIZED" : "OPEN";
}

function LearningCard({
  title,
  items,
}: {
  title: string;
  items: string[];
}) {
  return (
    <Card className="rounded-none border-slate-200 shadow-none">
      <CardHeader>
        <CardTitle className="text-base text-slate-950">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-slate-700">
        {items.length > 0 ? (
          items.map((item) => (
            <p key={item} className="leading-6">
              {item}
            </p>
          ))
        ) : (
          <p className="text-slate-500">No signals yet.</p>
        )}
      </CardContent>
    </Card>
  );
}

export function TradeAnalysisListClient() {
  const [filters, setFilters] = useState<AnalysisFilters>(defaultFilters);
  const [draftFilters, setDraftFilters] = useState<AnalysisFilters>(defaultFilters);
  const [data, setData] = useState<BullpenTradeAnalysisListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      setFallbackNotice(null);
      const filtersKey = buildTradeAnalysisFiltersKey(filters);
      let userId: number | undefined;
      try {
        userId = authSessionStorage.getUserData()?.id;
      } catch {
        // A malformed legacy auth cache must not strand the page in loading.
        // It simply makes the user-scoped tertiary cache unavailable.
        userId = undefined;
      }
      try {
        const nextData = await apiService.bullpenAiTradeAnalysis({
          status: filters.status || undefined,
          finalTag: filters.finalTag || undefined,
          fromDate: filters.fromDate || undefined,
          toDate: filters.toDate || undefined,
          strategyVersion: filters.strategyVersion || undefined,
          category: filters.category || undefined,
          topic: filters.topic || undefined,
        });
        if (!cancelled) {
          setData(nextData);
          writeTradeAnalysisCache({
            userId,
            filtersKey,
            data: nextData,
          });
        }
      } catch (nextError) {
        if (!cancelled) {
          const cached = readTradeAnalysisCache({
            userId,
            filtersKey,
          });
          if (cached) {
            const reason =
              nextError instanceof Error
                ? nextError.message
                : "Live request failed.";
            console.warn(
              JSON.stringify({
                event: "bullpen_trade_analysis_fallback_triggered",
                from_stage: "secondary",
                to_stage: "tertiary",
                to_transport: "validated-session-cache",
                reason,
                cached_at: new Date(cached.cachedAt).toISOString(),
              }),
            );
            setData(cached.data);
            setFallbackNotice(
              `Live refresh failed; showing saved trade analysis from ${formatDateTime(
                new Date(cached.cachedAt).toISOString(),
              )}.`,
            );
          } else {
            setError(
              nextError instanceof Error
                ? nextError.message
                : "Failed to load trade analysis.",
            );
          }
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [filters]);

  const summary = data?.summary;
  const learning = data?.learning_insights;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-2">
          <p className="text-sm font-semibold uppercase tracking-[0.22em] text-purple-600">
            Trade Analysis
          </p>
          <h1 className="text-3xl font-bold tracking-tight text-slate-950">
            Bullpen Trade Analysis
          </h1>
          <p className="max-w-3xl text-sm leading-6 text-slate-600">
            Review executed Bullpen trades with entry and exit snapshots, order details,
            LLM reasoning, computed tags, realized P&amp;L, and reinforcement signals.
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          <Button asChild className="bg-purple-700 text-white hover:bg-purple-800">
            <Link href={URLs.routes.console.bullpenAi()}>Trade Analysis</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={URLs.routes.console.bullpenAiAnalyseRuns()}>
              Trade Analysis
            </Link>
          </Button>
        </div>
      </div>

      <Card className="rounded-none border-slate-200 shadow-none">
        <CardHeader>
          <CardTitle className="text-base text-slate-950">Filters</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <label className="space-y-2 text-sm text-slate-700">
              <span>Status</span>
              <select
                className={tradeAnalysisSelectClassName}
                value={draftFilters.status}
                onChange={(event) =>
                  setDraftFilters((current) => ({
                    ...current,
                    status: event.target.value,
                  }))
                }
              >
                <option value="">All</option>
                <option value="OPEN">Open</option>
                <option value="CLOSED">Closed</option>
                <option value="SOLD">Sold</option>
                <option value="REDEEMED">Redeemed</option>
                <option value="FAILED">Failed</option>
              </select>
            </label>
            <label className="space-y-2 text-sm text-slate-700">
              <span>Final Tag</span>
              <select
                className={tradeAnalysisSelectClassName}
                value={draftFilters.finalTag}
                onChange={(event) =>
                  setDraftFilters((current) => ({
                    ...current,
                    finalTag: event.target.value,
                  }))
                }
              >
                <option value="">All</option>
                <option value="OPEN">Open</option>
                <option value="PROFIT">Profit</option>
                <option value="LOSS">Loss</option>
                <option value="BREAKEVEN">Breakeven</option>
                <option value="REDEEMED">Redeemed</option>
                <option value="FORCED_EXIT">Forced Exit</option>
              </select>
            </label>
            <label className="space-y-2 text-sm text-slate-700">
              <span>From</span>
              <Input
                type="date"
                value={draftFilters.fromDate}
                onChange={(event) =>
                  setDraftFilters((current) => ({
                    ...current,
                    fromDate: event.target.value,
                  }))
                }
              />
            </label>
            <label className="space-y-2 text-sm text-slate-700">
              <span>To</span>
              <Input
                type="date"
                value={draftFilters.toDate}
                onChange={(event) =>
                  setDraftFilters((current) => ({
                    ...current,
                    toDate: event.target.value,
                  }))
                }
              />
            </label>
            <label className="space-y-2 text-sm text-slate-700">
              <span>Strategy Version</span>
              <Input
                value={draftFilters.strategyVersion}
                onChange={(event) =>
                  setDraftFilters((current) => ({
                    ...current,
                    strategyVersion: event.target.value,
                  }))
                }
                placeholder="bullpen_console_top10"
              />
            </label>
            <label className="space-y-2 text-sm text-slate-700">
              <span>Category</span>
              <Input
                value={draftFilters.category}
                onChange={(event) =>
                  setDraftFilters((current) => ({
                    ...current,
                    category: event.target.value,
                  }))
                }
                placeholder="Politics"
              />
            </label>
            <label className="space-y-2 text-sm text-slate-700">
              <span>Topic</span>
              <Input
                value={draftFilters.topic}
                onChange={(event) =>
                  setDraftFilters((current) => ({
                    ...current,
                    topic: event.target.value,
                  }))
                }
                placeholder="Election"
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => setFilters(draftFilters)}>Apply Filters</Button>
            <Button
              variant="outline"
              onClick={() => {
                setDraftFilters(defaultFilters);
                setFilters(defaultFilters);
              }}
            >
              Clear
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Executed Trades"
          value={loading ? "…" : String(summary?.total_executed_trades ?? 0)}
        />
        <StatCard
          label="Open Positions"
          value={loading ? "…" : String(summary?.open_positions ?? 0)}
        />
        <StatCard
          label="Closed Positions"
          value={loading ? "…" : String(summary?.closed_positions ?? 0)}
        />
        <StatCard
          label="Total Net P&L"
          value={loading ? "…" : formatCurrency(summary?.total_net_pnl)}
        />
        <StatCard
          label="Win Rate"
          value={loading ? "…" : formatPercent((summary?.win_rate ?? 0) * 100)}
        />
        <StatCard
          label="Average P&L %"
          value={loading ? "…" : formatPercent(summary?.average_pnl_percent)}
        />
        <StatCard
          label="Average Holding"
          value={loading ? "…" : formatDuration(summary?.average_holding_period_seconds)}
        />
        <StatCard
          label="Total Fees"
          value={loading ? "…" : formatCurrency(summary?.total_fees)}
        />
      </div>

      {error ? (
        <Card className="rounded-none border-rose-200 bg-rose-50 shadow-none">
          <CardContent className="flex flex-wrap items-center justify-between gap-4 py-6">
            <p className="text-sm text-rose-700">{error}</p>
            <Button onClick={() => setFilters((current) => ({ ...current }))}>Retry</Button>
          </CardContent>
        </Card>
      ) : null}

      {fallbackNotice ? (
        <Card className="rounded-none border-amber-200 bg-amber-50 shadow-none">
          <CardContent className="flex flex-wrap items-center justify-between gap-4 py-6">
            <p className="text-sm text-amber-800">{fallbackNotice}</p>
            <Button
              variant="outline"
              onClick={() => setFilters((current) => ({ ...current }))}
            >
              Retry live data
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <Tabs defaultValue="trades" className="gap-6">
        <TabsList variant="line">
          <TabsTrigger value="trades">Trades</TabsTrigger>
          <TabsTrigger value="learning">Learning Insights</TabsTrigger>
        </TabsList>

        <TabsContent value="trades" className="space-y-4">
          {loading ? (
            <Card className="rounded-none border-slate-200 shadow-none">
              <CardContent className="py-10 text-sm text-slate-500">
                Loading executed Bullpen trades…
              </CardContent>
            </Card>
          ) : data && data.items.length === 0 ? (
            <Card className="rounded-none border-slate-200 shadow-none">
              <CardContent className="py-10 text-sm text-slate-500">
                No executed Bullpen trades matched the current filters yet.
              </CardContent>
            </Card>
          ) : (
            data?.items.map((item) => (
              <Link
                key={item.id}
                href={URLs.routes.console.bullpenAiAnalyseEventDetail(item.id)}
                className="block"
              >
                <Card
                  className={`rounded-none shadow-none transition hover:border-slate-300 ${cardToneClassName(item)}`}
                >
                  <CardHeader className="gap-4 md:flex-row md:items-start md:justify-between">
                    <div className="space-y-2">
                      <CardTitle className="text-lg text-slate-950">{item.title}</CardTitle>
                      <div className="flex flex-wrap gap-2">
                        <TradeAnalysisBadge value={item.final_tag} />
                        <TradeAnalysisBadge value={item.status} />
                        {item.pnl_outcome_tag !== item.final_tag ? (
                          <TradeAnalysisBadge value={item.pnl_outcome_tag} />
                        ) : null}
                        {item.is_squared_off ? (
                          <TradeAnalysisBadge value="SQUARED_OFF" className="border-slate-200 bg-white text-slate-700" />
                        ) : null}
                        {item.buy_tags.slice(0, 4).map((tag) => (
                          <TradeAnalysisBadge key={tag} value={tag} className="border-slate-200 bg-white text-slate-700" />
                        ))}
                      </div>
                    </div>
                    <div className="text-right text-xs uppercase tracking-[0.18em] text-slate-500">
                      <div>{item.strategy_name || "Trade Analysis"}</div>
                      <div className="mt-2">{item.strategy_version || "—"}</div>
                    </div>
                  </CardHeader>
                  <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    <div className="space-y-1 text-sm text-slate-700">
                      <p className="font-semibold text-slate-950">Entry</p>
                      <p>Outcome: {item.outcome_name || "—"}</p>
                      <p>Buy submitted: {formatDateTime(item.buy_submitted_at || item.bought_at)}</p>
                      <p>Buy executed: {formatDateTime(item.buy_executed_at || item.bought_at)}</p>
                      <p>Requested: {formatExecutionSummary({
                        amount: item.buy_requested_amount ?? item.buy_amount,
                        shares: item.buy_requested_shares ?? item.buy_shares,
                        price: item.buy_requested_price ?? item.buy_price,
                        odds: item.buy_requested_odds ?? item.buy_odds,
                      })}</p>
                      <p>Filled: {formatExecutionSummary({
                        amount: item.buy_filled_amount ?? item.buy_amount,
                        shares: item.buy_filled_shares ?? item.buy_shares,
                        price: item.buy_average_fill_price ?? item.buy_price,
                        odds: item.buy_average_fill_odds ?? item.buy_odds,
                      })}</p>
                      <p>Status: {item.buy_status || "—"}</p>
                    </div>
                    <div className="space-y-1 text-sm text-slate-700">
                      <p className="font-semibold text-slate-950">Exit</p>
                      <p>Exit type: {item.exit_type ? humanizeTag(item.exit_type) : "—"}</p>
                      <p>Exit submitted: {formatDateTime(item.sell_submitted_at)}</p>
                      <p>Exit executed: {formatDateTime(exitTimestamp(item))}</p>
                      <p>Requested: {formatExecutionSummary({
                        amount: item.sell_requested_amount ?? item.exit_amount,
                        shares: item.sell_requested_shares ?? item.exit_shares,
                        price: item.sell_requested_price ?? item.exit_price,
                        odds: item.sell_requested_odds ?? item.exit_odds,
                      })}</p>
                      <p>Filled: {formatExecutionSummary({
                        amount: item.sell_filled_amount ?? item.exit_amount,
                        shares: item.sell_filled_shares ?? item.exit_shares,
                        price: item.sell_average_fill_price ?? item.exit_price,
                        odds: item.sell_average_fill_odds ?? item.exit_odds,
                      })}</p>
                      <p>Status: {item.sell_status || (item.is_squared_off ? "completed" : "—")}</p>
                    </div>
                    <div className="space-y-1 text-sm text-slate-700">
                      <p className="font-semibold text-slate-950">Outcome</p>
                      <p>P&amp;L outcome: {pnlOutcomeLabel(item)}</p>
                      <p>Gross P&amp;L: {formatCurrency(item.gross_pnl)}</p>
                      <p>Net P&amp;L: {formatCurrency(item.net_pnl)}</p>
                      <p>P&amp;L %: {formatPercent(item.pnl_percent)}</p>
                      <p>Realized return: {formatPercent(
                        item.realized_return !== null && item.realized_return !== undefined
                          ? item.realized_return * 100
                          : null,
                      )}</p>
                      <p>Fees: {formatCurrency(item.fees_total)}</p>
                      <p>Holding: {formatDuration(item.holding_period_seconds)}</p>
                      <p>Current odds: {formatPercent(item.current_price, 2)}</p>
                    </div>
                    <div className="space-y-1 text-sm text-slate-700">
                      <p className="font-semibold text-slate-950">Reasoning</p>
                      <p>Confidence: {formatPercent((item.confidence ?? 0) * 100)}</p>
                      <p>Risk score: {formatNumber(item.risk_score, 2)}</p>
                      <p>{item.short_reason || "No buy summary stored."}</p>
                      <p>{item.exit_reason ? `Exit reason: ${item.exit_reason}` : "Position still open or exit reason unavailable."}</p>
                      <p>{item.analysis_summary || "No post-trade learning summary stored yet."}</p>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))
          )}
        </TabsContent>

        <TabsContent value="learning" className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <LearningCard
              title="Recommendations"
              items={learning?.recommendations ?? []}
            />
            <LearningCard
              title="Profitable Tags"
              items={listEntries(learning?.profitable_tags ?? [], "tag")}
            />
            <LearningCard
              title="Unprofitable Tags"
              items={listEntries(learning?.unprofitable_tags ?? [], "tag")}
            />
            <LearningCard
              title="Exit Reasons Ranked By P&L"
              items={listEntries(learning?.exit_reasons_ranked_by_pnl ?? [], "reason")}
            />
            <LearningCard
              title="Buy Reasons Ranked By P&L"
              items={listEntries(learning?.buy_reasons_ranked_by_pnl ?? [], "reason")}
            />
            <LearningCard
              title="Confidence And Liquidity Buckets"
              items={[
                ...listEntries(learning?.average_pnl_by_confidence_bucket ?? [], "bucket"),
                ...listEntries(learning?.average_pnl_by_liquidity_bucket ?? [], "bucket"),
              ]}
            />
          </div>

          <Card className="rounded-none border-slate-200 shadow-none">
            <CardHeader>
              <CardTitle className="text-base text-slate-950">Learning Raw Data</CardTitle>
            </CardHeader>
            <CardContent>
              <JsonPanel
                title="Learning Insights JSON"
                value={learning as BullpenTradeAnalysisLearningInsights | null}
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
