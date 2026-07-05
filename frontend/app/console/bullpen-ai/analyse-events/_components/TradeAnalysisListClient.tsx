"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { URLs } from "@/lib/urls";
import { apiService } from "@/services/api";
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

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
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
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : "Failed to load trade analysis.");
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
            Bullpen x AI
          </p>
          <h1 className="text-3xl font-bold tracking-tight text-slate-950">
            Bullpen Trade Analysis
          </h1>
          <p className="max-w-3xl text-sm leading-6 text-slate-600">
            Review executed Bullpen trades with entry and exit snapshots, order details,
            LLM reasoning, computed tags, realized P&amp;L, and reinforcement signals.
          </p>
        </div>
        <Button asChild className="shrink-0 bg-purple-700 text-white hover:bg-purple-800">
          <Link href={URLs.routes.console.bullpenAi()}>Bullpen x AI</Link>
        </Button>
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
                        {item.buy_tags.slice(0, 4).map((tag) => (
                          <TradeAnalysisBadge key={tag} value={tag} className="border-slate-200 bg-white text-slate-700" />
                        ))}
                      </div>
                    </div>
                    <div className="text-right text-xs uppercase tracking-[0.18em] text-slate-500">
                      <div>{item.strategy_name || "Bullpen x AI"}</div>
                      <div className="mt-2">{item.strategy_version || "—"}</div>
                    </div>
                  </CardHeader>
                  <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    <div className="space-y-1 text-sm text-slate-700">
                      <p className="font-semibold text-slate-950">Entry</p>
                      <p>Buy time: {formatDateTime(item.bought_at)}</p>
                      <p>Buy price: {formatNumber(item.buy_price, 4)}</p>
                      <p>Buy odds: {formatPercent(item.buy_odds, 2)}</p>
                      <p>Buy amount: {formatCurrency(item.buy_amount)}</p>
                    </div>
                    <div className="space-y-1 text-sm text-slate-700">
                      <p className="font-semibold text-slate-950">Exit</p>
                      <p>Exit time: {formatDateTime(item.closed_at || item.sold_at || item.redeemed_at)}</p>
                      <p>Exit price: {formatNumber(item.exit_price, 4)}</p>
                      <p>Exit odds: {formatPercent(item.exit_odds, 2)}</p>
                      <p>Current price: {formatNumber(item.current_price, 2)}</p>
                    </div>
                    <div className="space-y-1 text-sm text-slate-700">
                      <p className="font-semibold text-slate-950">Outcome</p>
                      <p>Net P&amp;L: {formatCurrency(item.net_pnl)}</p>
                      <p>P&amp;L %: {formatPercent(item.pnl_percent)}</p>
                      <p>Holding: {formatDuration(item.holding_period_seconds)}</p>
                      <p>Risk score: {formatNumber(item.risk_score, 2)}</p>
                    </div>
                    <div className="space-y-1 text-sm text-slate-700">
                      <p className="font-semibold text-slate-950">Reasoning</p>
                      <p>Confidence: {formatPercent((item.confidence ?? 0) * 100)}</p>
                      <p>{item.short_reason || "No buy summary stored."}</p>
                      <p>{item.exit_reason ? `Exit reason: ${item.exit_reason}` : "Position still open or exit reason unavailable."}</p>
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
