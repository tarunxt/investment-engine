"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { URLs } from "@/lib/urls";
import { apiService } from "@/services/api";
import type {
  BullpenTradeAnalysisDetailResponse,
  BullpenTradeAnalysisLlmEntry,
  BullpenTradeAnalysisSnapshot,
} from "@/types/api";

import {
  formatCurrency,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatPercent,
  humanizeTag,
  JsonPanel,
  TradeAnalysisBadge,
} from "./tradeAnalysisShared";

function DetailGrid({
  items,
}: {
  items: Array<{ label: string; value: string }>;
}) {
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      {items.map((item) => (
        <div key={`${item.label}-${item.value}`} className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            {item.label}
          </p>
          <p className="text-sm text-slate-900">{item.value}</p>
        </div>
      ))}
    </div>
  );
}

function llmEntriesForPhase(
  entries: BullpenTradeAnalysisLlmEntry[],
  phase: string,
) {
  return entries.filter((entry) => entry.phase === phase);
}

function snapshotByType(
  snapshots: BullpenTradeAnalysisSnapshot[],
  snapshotType: string,
) {
  return snapshots.find((snapshot) => snapshot.snapshot_type === snapshotType) ?? null;
}

function TimelineCard({
  label,
  timestamp,
  tone,
}: {
  label: string;
  timestamp?: string | null;
  tone: string;
}) {
  return (
    <div className={`rounded-none border px-4 py-4 ${tone}`}>
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
        {label}
      </p>
      <p className="mt-2 text-sm text-slate-900">{formatDateTime(timestamp)}</p>
    </div>
  );
}

function LlmSection({
  title,
  entries,
}: {
  title: string;
  entries: BullpenTradeAnalysisLlmEntry[];
}) {
  if (entries.length === 0) {
    return (
      <Card className="rounded-none border-slate-200 shadow-none">
        <CardHeader>
          <CardTitle className="text-base text-slate-950">{title}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-slate-500">
          No LLM payloads were stored for this phase.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="rounded-none border-slate-200 shadow-none">
      <CardHeader>
        <CardTitle className="text-base text-slate-950">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {entries.map((entry) => (
          <div key={entry.id} className="space-y-3 border border-slate-200 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <TradeAnalysisBadge value={entry.phase} className="border-slate-200 bg-white text-slate-700" />
              <TradeAnalysisBadge
                value={entry.confidence !== null && entry.confidence !== undefined ? `${Math.round(entry.confidence * 100)}% confidence` : "No confidence"}
                className="border-slate-200 bg-white text-slate-700"
              />
            </div>
            <DetailGrid
              items={[
                { label: "Provider", value: entry.provider || "—" },
                { label: "Model", value: entry.model || "—" },
                { label: "Prompt Version", value: entry.prompt_version || "—" },
                { label: "Created", value: formatDateTime(entry.created_at) },
              ]}
            />
            <div className="space-y-2 text-sm text-slate-700">
              <p>{entry.decision_json?.rationale ? String(entry.decision_json.rationale) : entry.raw_output || "No LLM summary stored."}</p>
              <p>Tags: {(entry.tags_json || []).map((tag) => String(tag)).join(", ") || "—"}</p>
              <p>Computed tags: {(entry.computed_tags_json || []).map((tag) => String(tag)).join(", ") || "—"}</p>
            </div>
            <JsonPanel title="Parsed LLM Output" value={entry.parsed_output_json} />
            <JsonPanel title="Raw LLM Output" value={entry.raw_output || {}} />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function TradeAnalysisDetailClient() {
  const params = useParams<{ tradeId: string }>();
  const tradeId = params?.tradeId;
  const [data, setData] = useState<BullpenTradeAnalysisDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tradeId) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const nextData = await apiService.bullpenAiTradeAnalysisDetail(tradeId);
        if (!cancelled) {
          setData(nextData);
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : "Failed to load trade details.");
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
  }, [tradeId]);

  const buyPreSubmitSnapshot = useMemo(
    () => snapshotByType(data?.snapshots ?? [], "BUY_PRE_SUBMIT"),
    [data?.snapshots],
  );
  const buyPostExecutionSnapshot = useMemo(
    () => snapshotByType(data?.snapshots ?? [], "BUY_POST_EXECUTION"),
    [data?.snapshots],
  );
  const sellPreSubmitSnapshot = useMemo(
    () => snapshotByType(data?.snapshots ?? [], "SELL_PRE_SUBMIT"),
    [data?.snapshots],
  );
  const sellPostExecutionSnapshot = useMemo(
    () => snapshotByType(data?.snapshots ?? [], "SELL_POST_EXECUTION"),
    [data?.snapshots],
  );
  const redeemPostExecutionSnapshot = useMemo(
    () => snapshotByType(data?.snapshots ?? [], "REDEEM_POST_EXECUTION"),
    [data?.snapshots],
  );
  const periodicMonitorSnapshot = useMemo(
    () => snapshotByType(data?.snapshots ?? [], "PERIODIC_MONITOR"),
    [data?.snapshots],
  );
  const buyLlmEntries = useMemo(
    () => llmEntriesForPhase(data?.llm_entries ?? [], "BUY_ANALYSIS"),
    [data?.llm_entries],
  );
  const exitLlmEntries = useMemo(
    () => llmEntriesForPhase(data?.llm_entries ?? [], "EXIT_ANALYSIS"),
    [data?.llm_entries],
  );

  if (loading) {
    return (
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6">
        <Card className="rounded-none border-slate-200 shadow-none">
          <CardContent className="py-10 text-sm text-slate-500">
            Loading trade lifecycle details…
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6">
        <Card className="rounded-none border-rose-200 bg-rose-50 shadow-none">
          <CardContent className="flex flex-wrap items-center justify-between gap-4 py-6">
            <p className="text-sm text-rose-700">{error || "Trade record not found."}</p>
            <Button asChild variant="outline">
              <Link href={URLs.routes.console.bullpenAiAnalyseEvents()}>
                Back to Analyse Events
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const trade = data.trade;
  const exitSnapshot = sellPostExecutionSnapshot || redeemPostExecutionSnapshot;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-3">
          <Button asChild variant="outline" size="sm">
            <Link href={URLs.routes.console.bullpenAiAnalyseEvents()}>
              Back to Analyse Events
            </Link>
          </Button>
          <div className="space-y-2">
            <p className="text-sm font-semibold uppercase tracking-[0.22em] text-purple-600">
              Bullpen x AI
            </p>
            <h1 className="text-3xl font-bold tracking-tight text-slate-950">
              {trade.title}
            </h1>
            <div className="flex flex-wrap gap-2">
              <TradeAnalysisBadge value={trade.final_tag} />
              <TradeAnalysisBadge value={trade.status} />
              {trade.pnl_outcome_tag !== trade.final_tag ? (
                <TradeAnalysisBadge value={trade.pnl_outcome_tag} />
              ) : null}
              {trade.is_squared_off ? (
                <TradeAnalysisBadge value="SQUARED_OFF" className="border-slate-200 bg-white text-slate-700" />
              ) : null}
              <TradeAnalysisBadge value={trade.lifecycle_state} className="border-slate-200 bg-white text-slate-700" />
            </div>
          </div>
        </div>
        <div className="space-y-2 text-right text-sm text-slate-600">
          <p>Event ID: {trade.event_id || "—"}</p>
          <p>Run ID: {trade.run_id || "—"}</p>
          <p>Strategy: {trade.strategy_version || trade.strategy_name || "—"}</p>
        </div>
      </div>

      <Card className="rounded-none border-slate-200 shadow-none">
        <CardHeader>
          <CardTitle className="text-base text-slate-950">Lifecycle Summary</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
          <TimelineCard label="Buy Submitted" timestamp={trade.buy_submitted_at} tone="border-slate-200 bg-white" />
          <TimelineCard label="Buy Executed" timestamp={trade.buy_executed_at} tone="border-slate-200 bg-white" />
          <TimelineCard label="Exit Considered" timestamp={sellPreSubmitSnapshot?.captured_at} tone="border-slate-200 bg-white" />
          <TimelineCard label="Exit Submitted" timestamp={trade.sell_submitted_at} tone="border-slate-200 bg-white" />
          <TimelineCard label="Exit Executed" timestamp={trade.sell_executed_at || trade.redeemed_at} tone="border-slate-200 bg-white" />
          <TimelineCard label="Closed" timestamp={trade.closed_at} tone="border-slate-200 bg-white" />
        </CardContent>
      </Card>

      <Card className="rounded-none border-slate-200 shadow-none">
        <CardHeader>
          <CardTitle className="text-base text-slate-950">P&amp;L Panel</CardTitle>
        </CardHeader>
        <CardContent>
          <DetailGrid
            items={[
              { label: "P&L Outcome", value: humanizeTag(trade.pnl_outcome_tag) },
              { label: "Buy Notional", value: formatCurrency(trade.buy_notional) },
              { label: "Exit Notional", value: formatCurrency(trade.exit_notional) },
              { label: "Gross P&L", value: formatCurrency(trade.gross_pnl) },
              { label: "Net P&L", value: formatCurrency(trade.net_pnl) },
              { label: "P&L %", value: formatPercent(trade.pnl_percent) },
              { label: "Fees", value: formatCurrency(trade.fees_total) },
              { label: "Holding Period", value: formatDuration(trade.holding_period_seconds) },
              { label: "Average Buy Price", value: formatNumber(trade.buy_average_fill_price, 4) },
              { label: "Average Exit Price", value: formatNumber(trade.sell_average_fill_price, 4) },
              { label: "Buy Slippage", value: formatNumber(trade.buy_slippage, 4) },
              { label: "Exit Slippage", value: formatNumber(trade.sell_slippage, 4) },
              { label: "Best Observed Price", value: formatNumber(trade.best_possible_exit_price_after_buy, 2) },
              { label: "Worst Observed Price", value: formatNumber(trade.worst_price_after_buy, 2) },
              { label: "Missed Profit", value: formatNumber(trade.missed_profit_amount, 2) },
              { label: "Drawdown While Held", value: formatNumber(trade.drawdown_while_held, 4) },
            ]}
          />
        </CardContent>
      </Card>

      <Card className="rounded-none border-slate-200 shadow-none">
        <CardHeader>
          <CardTitle className="text-base text-slate-950">Buy Snapshot</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <DetailGrid
            items={[
              { label: "Outcome", value: trade.outcome_name || "—" },
              { label: "Buy Status", value: trade.buy_status || "—" },
              { label: "Requested Amount", value: formatCurrency(trade.buy_requested_amount) },
              { label: "Filled Amount", value: formatCurrency(trade.buy_filled_amount) },
              { label: "Requested Price", value: formatNumber(trade.buy_requested_price, 4) },
              { label: "Average Fill Price", value: formatNumber(trade.buy_average_fill_price, 4) },
              { label: "Requested Odds", value: formatPercent(trade.buy_requested_odds) },
              { label: "Average Fill Odds", value: formatPercent(trade.buy_average_fill_odds) },
              { label: "Confidence", value: formatPercent((trade.buy_confidence ?? 0) * 100) },
              { label: "Risk Score", value: formatNumber(trade.buy_risk_score, 2) },
              { label: "Expected Edge", value: formatNumber(trade.buy_expected_edge, 2) },
              { label: "Expected Value", value: formatCurrency(trade.buy_expected_value) },
            ]}
          />
          <p className="text-sm leading-6 text-slate-700">
            {trade.buy_reason || trade.buy_decision_summary || "No buy reasoning summary stored."}
          </p>
          <p className="text-sm text-slate-700">
            Generated tags: {(trade.buy_computed_tags_json || []).map((tag) => String(tag)).join(", ") || "—"}
          </p>
          <p className="text-sm text-slate-700">
            Rule checks: {(trade.buy_rule_checks_json || []).length > 0 ? `${(trade.buy_rule_checks_json || []).length} checks recorded.` : "No buy rule checks stored."}
          </p>
          <JsonPanel title="Buy Event Snapshot" value={buyPreSubmitSnapshot?.event_snapshot_json || {}} />
          <JsonPanel title="Buy Market Snapshot" value={buyPreSubmitSnapshot?.market_snapshot_json || {}} />
          <JsonPanel title="Buy Order Book Snapshot" value={buyPreSubmitSnapshot?.order_book_snapshot_json || {}} />
          <JsonPanel title="Buy Execution Response" value={buyPostExecutionSnapshot?.raw_api_response_json || {}} />
        </CardContent>
      </Card>

      <LlmSection title="Buy LLM Analysis" entries={buyLlmEntries} />

      {(trade.sell_submitted_at || trade.sell_executed_at || trade.redeemed_at || sellPreSubmitSnapshot || exitSnapshot) ? (
        <>
          <Card className="rounded-none border-slate-200 shadow-none">
            <CardHeader>
              <CardTitle className="text-base text-slate-950">Sell / Redeem Snapshot</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <DetailGrid
                items={[
                  { label: "Exit Type", value: humanizeTag(trade.exit_type) },
                  { label: "Exit Status", value: trade.sell_status || "—" },
                  { label: "Exit Reason", value: trade.sell_reason || "—" },
                  { label: "Requested Amount", value: formatCurrency(trade.sell_requested_amount) },
                  { label: "Filled Amount", value: formatCurrency(trade.sell_filled_amount) },
                  { label: "Requested Price", value: formatNumber(trade.sell_requested_price, 4) },
                  { label: "Average Exit Price", value: formatNumber(trade.sell_average_fill_price, 4) },
                  { label: "Requested Odds", value: formatPercent(trade.sell_requested_odds) },
                  { label: "Average Exit Odds", value: formatPercent(trade.sell_average_fill_odds) },
                  { label: "Confidence", value: formatPercent((trade.sell_confidence ?? 0) * 100) },
                  { label: "Risk Score", value: formatNumber(trade.sell_risk_score, 2) },
                  { label: "Expected Edge", value: formatNumber(trade.sell_expected_edge, 2) },
                ]}
              />
              <JsonPanel title="Exit Event Snapshot" value={sellPreSubmitSnapshot?.event_snapshot_json || {}} />
              <JsonPanel title="Exit Market Snapshot" value={sellPreSubmitSnapshot?.market_snapshot_json || {}} />
              <JsonPanel title="Exit Order Book Snapshot" value={sellPreSubmitSnapshot?.order_book_snapshot_json || {}} />
              <JsonPanel title="Exit Execution Response" value={exitSnapshot?.raw_api_response_json || {}} />
            </CardContent>
          </Card>

          <LlmSection title="Exit LLM Analysis" entries={exitLlmEntries} />
        </>
      ) : null}

      <Card className="rounded-none border-slate-200 shadow-none">
        <CardHeader>
          <CardTitle className="text-base text-slate-950">Buy vs Exit Comparison</CardTitle>
        </CardHeader>
        <CardContent>
          <DetailGrid
            items={[
              { label: "Buy Price vs Exit Price", value: `${formatNumber(data.comparison.buy_price, 4)} vs ${formatNumber(data.comparison.exit_price, 4)}` },
              { label: "Buy Odds vs Exit Odds", value: `${formatPercent(data.comparison.buy_odds)} vs ${formatPercent(data.comparison.exit_odds)}` },
              { label: "Liquidity Score", value: `${formatNumber(data.comparison.buy_liquidity_score, 2)} vs ${formatNumber(data.comparison.exit_liquidity_score, 2)}` },
              { label: "Volume Score", value: `${formatNumber(data.comparison.buy_volume_score, 2)} vs ${formatNumber(data.comparison.exit_volume_score, 2)}` },
              { label: "Spread Score", value: `${formatNumber(data.comparison.buy_spread_score, 2)} vs ${formatNumber(data.comparison.exit_spread_score, 2)}` },
              { label: "Confidence", value: `${formatPercent((data.comparison.buy_confidence ?? 0) * 100)} vs ${formatPercent((data.comparison.exit_confidence ?? 0) * 100)}` },
              { label: "Probability Estimate", value: `${formatNumber(data.comparison.buy_probability_estimate, 2)} vs ${formatNumber(data.comparison.exit_probability_estimate, 2)}` },
              { label: "Implied Probability", value: `${formatNumber(data.comparison.buy_market_implied_probability, 2)} vs ${formatNumber(data.comparison.exit_market_implied_probability, 2)}` },
              { label: "Probability Delta", value: `${formatNumber(data.comparison.buy_probability_delta, 2)} vs ${formatNumber(data.comparison.exit_probability_delta, 2)}` },
            ]}
          />
        </CardContent>
      </Card>

      <Card className="rounded-none border-slate-200 shadow-none">
        <CardHeader>
          <CardTitle className="text-base text-slate-950">Actionable Learning</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3 text-sm text-slate-700">
            <p>{data.actionable_learning.analysis_summary || "No summary yet."}</p>
            <p>Mistake category: {data.actionable_learning.mistake_category || "None"}</p>
            <p>Exit timing: {data.actionable_learning.exit_timing}</p>
            <p>Entry too expensive: {data.actionable_learning.entry_too_expensive ? "Yes" : "No"}</p>
            <p>Liquidity or spread issue: {data.actionable_learning.liquidity_or_spread_issue ? "Yes" : "No"}</p>
            <p>LLM confidence aligned: {data.actionable_learning.llm_confidence_aligned ? "Yes" : "No"}</p>
          </div>
          <div className="space-y-3 text-sm text-slate-700">
            <p>What worked: {data.actionable_learning.what_worked.join(" | ") || "—"}</p>
            <p>What went wrong: {data.actionable_learning.what_went_wrong.join(" | ") || "—"}</p>
            <p>Rule changes: {data.actionable_learning.suggested_platform_rule_changes.join(" | ") || "—"}</p>
            <p>Prompt changes: {data.actionable_learning.suggested_prompt_changes.join(" | ") || "—"}</p>
            <p>Risk changes: {data.actionable_learning.suggested_risk_management_changes.join(" | ") || "—"}</p>
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-none border-slate-200 shadow-none">
        <CardHeader>
          <CardTitle className="text-base text-slate-950">Raw Data</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <JsonPanel title="Buy Bullpen Snapshot" value={buyPreSubmitSnapshot?.bullpen_snapshot_json || {}} />
          <JsonPanel title="Sell Bullpen Snapshot" value={sellPreSubmitSnapshot?.bullpen_snapshot_json || {}} />
          <JsonPanel title="Computed Buy Tags" value={trade.buy_computed_tags_json || []} />
          <JsonPanel title="Computed Sell Tags" value={trade.sell_computed_tags_json || []} />
          <JsonPanel title="Buy Rule Checks" value={trade.buy_rule_checks_json || []} />
          <JsonPanel title="Sell Rule Checks" value={trade.sell_rule_checks_json || []} />
          <JsonPanel title="Periodic Monitor Snapshot" value={periodicMonitorSnapshot || {}} />
          <JsonPanel title="Event Log Timeline" value={data.event_logs} />
          <JsonPanel title="Trade Record" value={trade} />
        </CardContent>
      </Card>
    </div>
  );
}
