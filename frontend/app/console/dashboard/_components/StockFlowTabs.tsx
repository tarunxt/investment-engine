"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronUp,
  GitCompareArrows,
  Loader2,
  X,
} from "lucide-react";

import {
  buildConsensusRows,
  buildDashboardActionRows,
  buildTechnicalScanMap,
  fetchDashboardRecentFullRuns,
  isCompletedRebalanceRun,
  type ActionCategory,
  type ScoreMatrixFormulaConfig,
  type StockConsensus,
} from "@/app/console/_components/FinalActionablesConsole";
import { Button } from "@/components/ui/button";
import { inferRebalanceMarketFromPrompt } from "@/lib/rebalance";
import { isRunInSwingTradeMarket } from "@/lib/runPresentation";
import type { SwingTradeMarket } from "@/lib/swingTrade";
import type { RunResponse } from "@/types/api";
import { cn } from "@/lib/utils";
import { getStandardActionBadgeClass } from "@/lib/actionColorScheme";

export type RebalanceStockFlowPortfolio = "zerodha" | "indmoneyUs";

const PORTFOLIOS: Array<{
  id: RebalanceStockFlowPortfolio;
  title: string;
  market: SwingTradeMarket;
}> = [
  { id: "zerodha", title: "Zerodha Rebalance Stock Flow", market: "india" },
  { id: "indmoneyUs", title: "IndMoney Rebalance Stock Flow", market: "us" },
];

function newest(runs: RunResponse[]) {
  return [...runs].sort(
    (a, b) => Date.parse(b.created_at || "") - Date.parse(a.created_at || ""),
  )[0];
}

function consensusLabel(stock: StockConsensus) {
  return `${stock.actionCounts[stock.consensusAction]}/${stock.totalSuggestions}`;
}

const BASKET_ACTION_ORDER = ["Sell All", "Trim", "Buy New", "Add more", "Hold"];

function compareFinalActionables(
  left: ReturnType<typeof buildDashboardActionRows>[number],
  right: ReturnType<typeof buildDashboardActionRows>[number],
) {
  const leftIndex = BASKET_ACTION_ORDER.indexOf(left.formulaAction);
  const rightIndex = BASKET_ACTION_ORDER.indexOf(right.formulaAction);
  const actionComparison = (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex)
    - (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex);
  if (actionComparison !== 0) return actionComparison;

  const leftScore = left.formulaScore;
  const rightScore = right.formulaScore;
  const leftMissing = leftScore === null || !Number.isFinite(leftScore);
  const rightMissing = rightScore === null || !Number.isFinite(rightScore);
  if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
  if (!leftMissing && !rightMissing) {
    const increasing = left.formulaAction === "Sell All" || left.formulaAction === "Trim";
    const decreasing = left.formulaAction === "Buy New" || left.formulaAction === "Add more";
    const scoreComparison = increasing
      ? leftScore - rightScore
      : decreasing
        ? rightScore - leftScore
        : 0;
    if (scoreComparison !== 0) return scoreComparison;
  }

  return left.stock.symbol.localeCompare(right.stock.symbol, undefined, {
    sensitivity: "base",
    numeric: true,
  });
}

function stageRunMeta(run: RunResponse | undefined) {
  if (!run) return null;
  const models = Array.from(new Set(run.run_jobs.map(({ job }) => job.model).filter(Boolean)));
  const timestamp = new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(run.created_at));
  return { models: models.length ? models.join(", ") : "Model unavailable", timestamp };
}

function EmptyStage() {
  return <p className="py-8 text-center text-sm text-slate-500">No stocks found in the latest completed scan.</p>;
}

type RebalanceStockFlowWidgetProps = {
  formulaConfig: ScoreMatrixFormulaConfig;
  initialPortfolio?: RebalanceStockFlowPortfolio;
};

type RebalanceStockFlowSubwidgetProps = {
  formulaConfig: ScoreMatrixFormulaConfig;
  portfolio: RebalanceStockFlowPortfolio;
};

export function RebalanceStockFlowWidget({
  formulaConfig,
  initialPortfolio = "zerodha",
}: RebalanceStockFlowWidgetProps) {
  const [active, setActive] = useState<RebalanceStockFlowPortfolio>(initialPortfolio);

  return (
    <section
      aria-labelledby="rebalance-stock-flow-title"
      className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm"
    >
      <div>
        <h2
          id="rebalance-stock-flow-title"
          className="text-xl font-bold text-slate-950"
        >
          Rebalance Stock Flow
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          Track each portfolio from Swing Scan through the final rebalance actionables.
        </p>
      </div>

      <div
        className="mt-4 flex flex-wrap gap-2"
        role="tablist"
        aria-label="Rebalance stock flow portfolio"
      >
        {PORTFOLIOS.map((portfolio) => (
          <button
            key={portfolio.id}
            type="button"
            role="tab"
            aria-selected={active === portfolio.id}
            aria-controls={`${portfolio.id}-rebalance-stock-flow`}
            onClick={() => setActive(portfolio.id)}
            className={cn(
              "rounded-full border px-5 py-2.5 text-sm font-semibold transition focus:outline-none focus:ring-2 focus:ring-blue-500",
              active === portfolio.id
                ? "border-blue-600 bg-blue-600 text-white shadow-sm"
                : "border-slate-200 bg-white text-slate-700 hover:border-blue-300 hover:text-blue-700",
            )}
          >
            {portfolio.title}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {active === "zerodha" ? (
          <ZerodhaRebalanceStockFlowWidget formulaConfig={formulaConfig} />
        ) : (
          <IndMoneyRebalanceStockFlowWidget formulaConfig={formulaConfig} />
        )}
      </div>
    </section>
  );
}

export function ZerodhaRebalanceStockFlowWidget({
  formulaConfig,
}: Pick<RebalanceStockFlowSubwidgetProps, "formulaConfig">) {
  return (
    <RebalanceStockFlowSubwidget
      formulaConfig={formulaConfig}
      portfolio="zerodha"
    />
  );
}

export function IndMoneyRebalanceStockFlowWidget({
  formulaConfig,
}: Pick<RebalanceStockFlowSubwidgetProps, "formulaConfig">) {
  return (
    <RebalanceStockFlowSubwidget
      formulaConfig={formulaConfig}
      portfolio="indmoneyUs"
    />
  );
}

function RebalanceStockFlowSubwidget({
  formulaConfig,
  portfolio: portfolioId,
}: RebalanceStockFlowSubwidgetProps) {
  const [detailed, setDetailed] = useState(false);
  const [runs, setRuns] = useState<RunResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchDashboardRecentFullRuns()
      .then((result) => { if (!cancelled) setRuns(result); })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Unable to load stock flow.");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const flow = useMemo(() => {
    const portfolio = PORTFOLIOS.find((item) => item.id === portfolioId)!;
    const swingRun = newest(runs.filter((run) => isRunInSwingTradeMarket(run.prompt, portfolio.market)));
    const rebalanceRun = newest(runs.filter((run) => isCompletedRebalanceRun(run, portfolio.market)));
    const swing = swingRun ? buildConsensusRows([swingRun], portfolio.market, null, runs) : [];
    const rebalance = rebalanceRun ? buildConsensusRows([rebalanceRun], portfolio.market, null, runs) : [];
    const actionables = buildDashboardActionRows(
      rebalance,
      portfolio.market,
      buildTechnicalScanMap(runs),
      formulaConfig,
    ).sort(compareFinalActionables);
    return {
      portfolio,
      swing,
      rebalance,
      actionables,
      rebalanceRun,
      swingMeta: stageRunMeta(swingRun),
      rebalanceMeta: stageRunMeta(rebalanceRun),
    };
  }, [formulaConfig, portfolioId, runs]);

  return (
    <section
      id={`${portfolioId}-rebalance-stock-flow`}
      role="tabpanel"
      aria-label={flow.portfolio.title}
      className="rounded-2xl border border-slate-200 bg-white p-5"
    >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-950">{flow.portfolio.title}</h2>
              <p className="mt-1 text-sm text-slate-500">Stocks identified across the latest Swing Scan, Rebalance Scan, and Final Actionables stages.</p>
            </div>
            <Button type="button" variant="outline" onClick={() => setDetailed((value) => !value)} aria-pressed={detailed} className="rounded-full">
              {detailed ? <ChevronUp className="mr-2 size-4" /> : <ChevronDown className="mr-2 size-4" />}
              {detailed ? "Summary View" : "Detailed View"}
            </Button>
          </div>

          {loading ? <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500"><Loader2 className="size-4 animate-spin" /> Loading stock flow…</div>
          : error ? <p className="mt-5 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</p>
          : (
            <div className="mt-5 grid gap-4 xl:grid-cols-3">
              <Stage title="Swing Scan" count={flow.swing.length} meta={flow.swingMeta}>
                {flow.swing.length ? flow.swing.map((stock) => (
                  <StockRow key={stock.key} name={stock.symbol} detailed={detailed} details={[`Exchange: ${stock.exchange || "—"}`, `Suggestions: ${stock.totalSuggestions}`]} />
                )) : <EmptyStage />}
              </Stage>
              <Stage title="Rebalance Scan" count={flow.rebalance.length} meta={flow.rebalanceMeta}>
                {flow.rebalance.length ? flow.rebalance.map((stock) => (
                  <StockRow key={stock.key} name={stock.symbol} action={stock.consensusAction} detailed={detailed} details={[`Consensus: ${consensusLabel(stock)}`, `Exchange: ${stock.exchange || "—"}`]} />
                )) : <EmptyStage />}
              </Stage>
              <Stage title="Final Actionables" count={flow.actionables.length} meta={flow.rebalanceMeta}>
                {flow.actionables.length ? flow.actionables.map((row) => (
                  <StockRow key={row.id} name={row.stock.symbol} action={row.formulaAction} score={row.formulaScore} consensus={consensusLabel(row.stock)} detailed={detailed} details={[`Exchange: ${row.stock.exchange || "—"}`, `Suggestions: ${row.stock.totalSuggestions}`, `Source: ${inferRebalanceMarketFromPrompt(flow.rebalanceRun?.prompt || "") ? "Latest rebalance scan" : "Rebalance scan"}`]} />
                )) : <EmptyStage />}
              </Stage>
            </div>
          )}
    </section>
  );
}

export function RebalanceStockFlowTrigger({
  portfolio,
  onClick,
}: {
  portfolio: RebalanceStockFlowPortfolio;
  onClick: () => void;
}) {
  const portfolioLabel = portfolio === "zerodha" ? "Zerodha" : "IndMoney";
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex shrink-0 items-center gap-2 rounded-full border border-emerald-200 bg-white px-3.5 py-2 text-sm font-semibold text-emerald-800 shadow-sm transition hover:border-emerald-300 hover:bg-emerald-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
      aria-label={`Open ${portfolioLabel} Rebalance Stock Flow`}
      title={`Open ${portfolioLabel} Rebalance Stock Flow`}
    >
      <GitCompareArrows className="size-4" />
      Stock Flow
    </button>
  );
}

export function RebalanceStockFlowDialog({
  portfolio,
  formulaConfig,
  onClose,
}: {
  portfolio: RebalanceStockFlowPortfolio | null;
  formulaConfig: ScoreMatrixFormulaConfig;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!portfolio) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, portfolio]);

  if (!portfolio) return null;
  const title = PORTFOLIOS.find((item) => item.id === portfolio)!.title;

  return (
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-slate-950/55 p-3 sm:p-5"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="rebalance-stock-flow-dialog-title"
        className="flex max-h-[92vh] w-full max-w-[96rem] flex-col overflow-hidden rounded-[28px] border border-slate-200 bg-slate-50 shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 bg-white px-5 py-4 sm:px-6">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-blue-600">
              Rebalance Stock Flow
            </p>
            <h2
              id="rebalance-stock-flow-dialog-title"
              className="mt-1 text-xl font-bold text-slate-950"
            >
              {title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-slate-200 bg-white p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            aria-label="Close Rebalance Stock Flow"
          >
            <X className="size-4" />
          </button>
        </header>
        <div className="min-h-0 overflow-auto p-3 sm:p-5">
          {portfolio === "zerodha" ? (
            <ZerodhaRebalanceStockFlowWidget formulaConfig={formulaConfig} />
          ) : (
            <IndMoneyRebalanceStockFlowWidget formulaConfig={formulaConfig} />
          )}
        </div>
      </section>
    </div>
  );
}

/** @deprecated Use RebalanceStockFlowWidget. */
export function StockFlowTabs(props: RebalanceStockFlowWidgetProps) {
  return <RebalanceStockFlowWidget {...props} />;
}

function Stage({ title, count, meta, children }: { title: string; count: number; meta: { models: string; timestamp: string } | null; children: ReactNode }) {
  return <article className="flex max-h-[34rem] min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-slate-50/60"><header className="shrink-0 border-b border-slate-200 bg-slate-100 px-4 py-3"><div className="flex items-center justify-between gap-3"><h3 className="font-semibold text-slate-950">{title}</h3><span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-600">{count}</span></div>{meta ? <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500"><span><b className="font-semibold text-slate-700">LLM:</b> {meta.models}</span><time><b className="font-semibold text-slate-700">Run:</b> {meta.timestamp}</time></div> : <p className="mt-1.5 text-[11px] text-slate-500">No completed run metadata</p>}</header><div className="min-h-0 overflow-y-auto divide-y divide-slate-200">{children}</div></article>;
}

function StockRow({ name, action, score, consensus, detailed, details = [] }: { name: string; action?: ActionCategory; score?: number | null; consensus?: string; detailed: boolean; details?: string[] }) {
  return <div className="bg-white px-4 py-3"><div className="flex flex-wrap items-center gap-x-3 gap-y-1"><strong className="text-sm text-slate-950">{name}</strong>{action ? <span className={cn("rounded-full border px-2 py-0.5 text-xs font-semibold", getStandardActionBadgeClass(action))}>{action}</span> : null}{score !== undefined ? <span className="text-xs text-slate-600">Final Score: <b>{score === null ? "—" : score.toFixed(2)}</b></span> : null}{consensus ? <span className="text-xs text-slate-600">Consensus: <b>{consensus}</b></span> : null}</div>{detailed ? <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">{details.map((detail) => <span key={detail}>{detail}</span>)}</div> : null}</div>;
}
