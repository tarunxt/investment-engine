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
import {
  tradeExecutionFill,
  tradeOutcomeLabel,
} from "@/lib/tradeAnalysisExecution";
import { apiService } from "@/services/api";
import { useAuth } from "@/hooks/useAuth";
import type {
  BullpenTradeAnalysisListItem,
  BullpenTradeAnalysisListResponse,
} from "@/types/api";

import {
  formatConfidence,
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
  if (item.pnl_outcome_tag === "PROFIT")
    return "border-emerald-200 bg-emerald-50/40";
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
  return humanizeTag(tradeOutcomeLabel(item));
}

function LearningCard({ title, items }: { title: string; items?: string[] }) {
  return (
    <Card className="rounded-none border-slate-200 shadow-none">
      <CardHeader>
        <CardTitle className="text-base text-slate-950">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-slate-700">
        {items === undefined ? (
          <p className="text-slate-500">Learning insights unavailable.</p>
        ) : items.length > 0 ? (
          items.map((item) => (
            <p key={item} className="leading-6">
              {item}
            </p>
          ))
        ) : (
          <p className="text-slate-500">No observations in this category.</p>
        )}
      </CardContent>
    </Card>
  );
}

export function TradeAnalysisListClient() {
  const { user } = useAuth();
  const [filters, setFilters] = useState<AnalysisFilters>(defaultFilters);
  const [draftFilters, setDraftFilters] =
    useState<AnalysisFilters>(defaultFilters);
  const [data, setData] = useState<BullpenTradeAnalysisListResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      // A previous request may belong to another filter set or user.
      setData(null);
      setError(null);
      setFallbackNotice(null);
      const filtersKey = buildTradeAnalysisFiltersKey(filters);
      const userId = user?.id;
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
  }, [filters, user?.id]);

  const summary = data?.summary;
  const learning = data?.learning_insights;
  const hasUnknownPnl = data?.items.some((item) => !Number.isFinite(item.net_pnl));
  const hasUnknownFees = data?.items.some((item) => !Number.isFinite(item.fees_total));
  // Summary covers the selected cohort; visible rows may be limited independently.
  // Legacy responses lack these fields and retain the conservative visible-row guard.
  const hasOutcomeCoverage = summary != null
    && typeof summary.known_outcomes === "number" && Number.isInteger(summary.known_outcomes) && summary.known_outcomes >= 0
    && typeof summary.unknown_outcomes === "number" && Number.isInteger(summary.unknown_outcomes) && summary.unknown_outcomes >= 0
    && summary.known_outcomes + summary.unknown_outcomes === summary.closed_positions
    && summary.win_rate_denominator === summary.known_outcomes;
  const hasPnlCoverage = ["complete", "partial", "unknown"].includes(summary?.net_pnl_coverage ?? "");
  const hasFeeCoverage = ["complete", "partial", "unknown"].includes(summary?.fee_coverage ?? "");
  const canShowWinRate = summary != null && Number.isFinite(summary.win_rate)
    && (summary.win_rate_denominator != null ? Number.isInteger(summary.win_rate_denominator) && summary.win_rate_denominator > 0 : !hasUnknownPnl && summary.closed_positions > 0);

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
          value={
            loading
              ? "…"
              : summary
                ? String(summary.total_executed_trades)
                : "Unavailable"
          }
        />
        <StatCard
          label="Confirmed Open Positions"
          value={
            loading
              ? "…"
              : summary
                ? String(summary.open_positions)
                : "Unavailable"
          }
        />
        <StatCard
          label="Closed Positions"
          value={
            loading
              ? "…"
              : summary
                ? String(summary.closed_positions)
                : "Unavailable"
          }
        />
        <StatCard
          label={`Recorded Net P&L Subtotal (${summary?.net_pnl_coverage ?? "unknown"} coverage)`}
          value={loading ? "…" : (!hasPnlCoverage && hasUnknownPnl) || summary?.net_pnl_coverage === "unknown" ? "Not evaluated" : formatCurrency(summary?.total_net_pnl)}
        />
        <StatCard
          label={hasOutcomeCoverage ? `Known-outcome Win Rate (n=${summary?.win_rate_denominator})` : "Recorded Win Rate (outcome coverage unavailable)"}
          value={
            loading
              ? "…"
              : canShowWinRate && summary && summary.win_rate != null
                ? formatPercent(summary.win_rate * 100)
                : "Unavailable"
          }
        />
        <StatCard
          label="Recorded Average P&L % (known returns)"
          value={loading ? "…" : !hasOutcomeCoverage && hasUnknownPnl ? "Not evaluated" : formatPercent(summary?.average_pnl_percent)}
        />
        <StatCard
          label="Average Holding"
          value={
            loading
              ? "…"
              : formatDuration(summary?.average_holding_period_seconds)
          }
        />
        <StatCard
          label={`Recorded Fees Subtotal (${summary?.fee_coverage ?? "unknown"} coverage)`}
          value={loading ? "…" : (!hasFeeCoverage && hasUnknownFees) || summary?.fee_coverage === "unknown" ? "Not evaluated" : formatCurrency(summary?.total_fees)}
        />
      </div>

      {hasOutcomeCoverage ? (<p className="text-sm text-slate-600">
        Selected cohort: {summary?.closed_positions ?? 0} closed, {summary?.known_outcomes ?? 0} known outcomes,
        {" "}{summary?.unknown_outcomes ?? 0} unknown. Known zero is a non-win; win requires net P&amp;L &gt; 0.
        Recorded execution fees only; tax, spread and FX are not verified.
        Measured fee components: {formatCurrency(summary?.measured_fee_components_total)}
        {" "}({summary?.known_fee_components ?? "unavailable"} known, {summary?.unknown_fee_components ?? "unavailable"} missing).
      </p>) : null}

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

      <section aria-label="Analysis scope and coverage" className="space-y-2 text-sm text-slate-700">
        <p>Applied filters: {Object.entries(filters).map(([key, value]) => `${key}: ${value || "All"}`).join(" · ")}</p>
        <p>Displayed records: {data ? data.items.length : "Unavailable"}. {hasOutcomeCoverage ? "Selected-cohort outcome coverage is reported separately above." : "Outcome-label and fee coverage denominators: unavailable in this response."} Aggregate subtotals do not establish complete coverage.</p>
        {data ? <p>Displayed-record coverage only: known net P&amp;L {data.items.filter((item) => Number.isFinite(item.net_pnl)).length}/{data.items.length}; known fees {data.items.filter((item) => Number.isFinite(item.fees_total)).length}/{data.items.length}. These counts do not establish full-cohort coverage.</p> : null}
        {hasFeeCoverage ? <p>Selected-cohort fee records: {summary?.known_fee_records ?? "Unavailable"} known, {summary?.unknown_fee_records ?? "Unavailable"} missing. Coverage: {summary?.fee_coverage}.</p> : null}
        {data ? <JsonPanel title="Reported Summary Raw Evidence" value={summary} /> : null}
        <p>Source and analysis versions: unavailable unless supplied in the raw evidence. Exit observations do not establish post-exit performance.</p>
      </section>

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
                        <TradeAnalysisBadge value={item.final_tag === "OPEN" ? tradeOutcomeLabel(item) : item.final_tag} />
                        <TradeAnalysisBadge value={item.status} />
                        {item.pnl_outcome_tag !== item.final_tag ? (
                          <TradeAnalysisBadge value={tradeOutcomeLabel(item)} />
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
                      <p>Filled: {formatExecutionSummary(tradeExecutionFill(item, "buy"))}</p>
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
                      <p>Filled: {formatExecutionSummary(tradeExecutionFill(item, "sell"))}</p>
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
                      <p>Confidence: {formatConfidence(item.confidence)}</p>
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
          {loading ? (
            <p role="status" className="text-sm text-slate-500">
              Loading learning insights…
            </p>
          ) : (
            <>
              <p className="text-sm leading-6 text-slate-700">
                Descriptive observations only. Calibration, causal attribution and weight
                changes are not evaluated. Stored recommendations are unvalidated hypotheses.
              </p>
              <div className="grid gap-4 lg:grid-cols-2">
                <LearningCard
                  title="Recommendations"
                  items={learning?.recommendations}
                />
                <LearningCard
                  title="Profitable Tags"
                  items={
                    learning?.profitable_tags
                      ? listEntries(learning.profitable_tags, "tag")
                      : undefined
                  }
                />
                <LearningCard
                  title="Unprofitable Tags"
                  items={
                    learning?.unprofitable_tags
                      ? listEntries(learning.unprofitable_tags, "tag")
                      : undefined
                  }
                />
                <LearningCard
                  title="Exit Reasons Ranked By P&L"
                  items={
                    learning?.exit_reasons_ranked_by_pnl
                      ? listEntries(
                          learning.exit_reasons_ranked_by_pnl,
                          "reason",
                        )
                      : undefined
                  }
                />
                <LearningCard
                  title="Buy Reasons Ranked By P&L"
                  items={
                    learning?.buy_reasons_ranked_by_pnl
                      ? listEntries(
                          learning.buy_reasons_ranked_by_pnl,
                          "reason",
                        )
                      : undefined
                  }
                />
                <LearningCard
                  title="Confidence And Liquidity Buckets"
                  items={
                    learning?.average_pnl_by_confidence_bucket &&
                    learning?.average_pnl_by_liquidity_bucket
                      ? [
                          ...listEntries(
                            learning?.average_pnl_by_confidence_bucket ?? [],
                            "bucket",
                          ),
                          ...listEntries(
                            learning?.average_pnl_by_liquidity_bucket ?? [],
                            "bucket",
                          ),
                        ]
                      : undefined
                  }
                />
              </div>

              <Card className="rounded-none border-slate-200 shadow-none">
                <CardHeader>
                  <CardTitle className="text-base text-slate-950">
                    Learning Raw Data
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {learning && Object.keys(learning).length > 0 ? (
                    <JsonPanel
                      title="Learning Insights JSON"
                      value={learning}
                    />
                  ) : (
                    <p className="text-sm text-slate-500">
                      Learning insights unavailable.
                    </p>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
