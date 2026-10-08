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
  extractRebalanceInputFingerprint,
  fetchDashboardRecentFullRuns,
  isCompletedRebalanceRun,
  type DashboardRunCoverage,
  type ScoreMatrixFormulaConfig,
  type StockConsensus,
} from "@/app/console/_components/FinalActionablesConsole";
import { Button } from "@/components/ui/button";
import {
  getStandardActionBadgeClass,
  type StandardActionCategory,
} from "@/lib/actionColorScheme";
import { isAnalysisRunForStage } from "@/lib/rebalanceRunIdentity";
import { buildSwingFlow, inspectStockJob, sameFlowSequence, selectFlowStage, stockOutputMessage, type StockOutputState } from "@/lib/stockFlowEvidence";
import { formatAuditTime } from "@/lib/recommendationAuditPresentation";
import type { SwingTradeMarket } from "@/lib/swingTrade";
import { apiService } from "@/services/api";
import type {
  IndMoneyUsPortfolioSnapshotDetail,
  RunResponse,
  ZerodhaPortfolioSnapshotDetail,
} from "@/types/api";
import { cn } from "@/lib/utils";

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

function latestMatchingRebalanceRuns(
  runs: RunResponse[],
  market: SwingTradeMarket,
) {
  const marketRuns = runs
    .filter((run) => isCompletedRebalanceRun(run, market))
    .sort(
      (a, b) => Date.parse(b.created_at || "") - Date.parse(a.created_at || ""),
    );
  const latestRun = marketRuns[0];
  if (!latestRun) return [];
  const fingerprint = extractRebalanceInputFingerprint(latestRun.prompt);
  if (!fingerprint) return [latestRun];
  return marketRuns.filter(
    (run) => latestRun.auto_rebalance_portfolio && typeof latestRun.auto_rebalance_sequence === "number"
      ? sameFlowSequence(run, latestRun) && extractRebalanceInputFingerprint(run.prompt) === fingerprint
      : extractRebalanceInputFingerprint(run.prompt) === fingerprint && Math.abs(Date.parse(latestRun.created_at) - Date.parse(run.created_at)) <= 30 * 60 * 1000,
  );
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

function isAboveBuyThreshold(
  row: ReturnType<typeof buildDashboardActionRows>[number],
  buyThreshold: number,
) {
  return (
    (row.formulaAction === "Buy New" || row.formulaAction === "Add more")
    && row.formulaScore !== null
    && Number.isFinite(row.formulaScore)
    && row.formulaScore > buyThreshold
  );
}

function compareFinalActionablesForThreshold(
  buyThreshold: number,
) {
  return (
    left: ReturnType<typeof buildDashboardActionRows>[number],
    right: ReturnType<typeof buildDashboardActionRows>[number],
  ) => {
    const eligibilityComparison = Number(isAboveBuyThreshold(right, buyThreshold))
      - Number(isAboveBuyThreshold(left, buyThreshold));
    return eligibilityComparison || compareFinalActionables(left, right);
  };
}

function stageRunMeta(run: RunResponse | undefined) {
  if (!run) return null;
  const models = Array.from(new Set((run.run_jobs ?? []).map(({ job }) => job?.model).filter(Boolean)));
  const timestamp = `#${run.id} · ${formatAuditTime(run.created_at)} · ${run.status || "unknown"}${typeof run.auto_rebalance_sequence === "number" ? ` · sequence ${run.auto_rebalance_sequence}` : ""}`;
  return { models: models.length ? models.join(", ") : "Model unavailable", timestamp };
}

function EmptyStage() {
  return <p className="py-8 text-center text-sm text-slate-500">No stock rows available in this selection. Check job status and parsing coverage.</p>;
}

function actionBadgeClass(action: string) {
  if (BASKET_ACTION_ORDER.includes(action)) {
    return getStandardActionBadgeClass(action as StandardActionCategory);
  }
  return "border-slate-200 bg-slate-100 text-slate-700";
}

const REBALANCE_ACTION_HEADER = "Action (Buy/Add/Sell All/Trim/Hold/Buy New)";

type StageJobOutput = {
  key: string;
  jobId: number;
  runId: number;
  provider: string;
  model: string;
  status: string;
  state: StockOutputState;
  symbols: string[];
  actions: Map<string, string>;
};

function normalizeStageAction(value: string) {
  const normalized = value.trim().toLowerCase();
  if (normalized.includes("sell all")) return "Sell All";
  if (normalized.includes("trim")) return "Trim";
  if (normalized.includes("add more") || normalized === "add") return "Add more";
  if (normalized.includes("buy new") || normalized === "new") return "Buy New";
  if (normalized.includes("hold")) return "Hold";
  return value.trim() || "Not covered";
}

function buildStageJobOutputs(stocks: StockConsensus[], runs: RunResponse[]) {
  const jobs = new Map<string, StageJobOutput>();

  runs.forEach(run => (run.run_jobs ?? []).forEach((link) => {
    if (!link.job) return;
    const key = `${run?.id ?? 0}:${link.job_id}`;
    jobs.set(key, {
      key,
      jobId: link.job_id,
      runId: run.id,
      provider: link.job.provider || "Provider",
      model: link.job.model || "Model unavailable",
      status: link.job.status || "unknown",
      state: inspectStockJob(run, link, true).state,
      symbols: [],
      actions: new Map(),
    });
  }));

  stocks.forEach((stock) => {
    stock.rows.forEach((row) => {
      const key = `${row.meta.runId}:${row.meta.jobId}`;
      const output = jobs.get(key) ?? {
        key,
        jobId: row.meta.jobId,
        runId: row.meta.runId,
        provider: row.meta.provider || "Provider",
        model: row.meta.model || "Model unavailable",
        status: row.meta.status || "unknown",
        state: "populated" as StockOutputState,
        symbols: [],
        actions: new Map<string, string>(),
      };
      if (!output.symbols.includes(stock.symbol)) output.symbols.push(stock.symbol);
      output.actions.set(
        stock.key,
        normalizeStageAction(row.cells[REBALANCE_ACTION_HEADER] || ""),
      );
      jobs.set(key, output);
    });
  });

  return Array.from(jobs.values())
    .map((output) => ({
      ...output,
      symbols: [...output.symbols].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })),
    }))
    .sort((a, b) => a.jobId - b.jobId);
}

type RebalanceStockFlowWidgetProps = {
  formulaConfig: ScoreMatrixFormulaConfig;
  initialPortfolio?: RebalanceStockFlowPortfolio;
  buyThresholds: Record<RebalanceStockFlowPortfolio, number>;
  buyThresholdDrafts: Record<RebalanceStockFlowPortfolio, string>;
  onBuyThresholdDraftChange: (
    portfolio: RebalanceStockFlowPortfolio,
    value: string,
  ) => void;
  buyThresholdSaveError?: string | null;
  buyThresholdPersistence?: string;
};

type RebalanceStockFlowSubwidgetProps = {
  formulaConfig: ScoreMatrixFormulaConfig;
  portfolio: RebalanceStockFlowPortfolio;
  buyThreshold: number;
  buyThresholdDraft: string;
  onBuyThresholdDraftChange: (value: string) => void;
  buyThresholdSaveError?: string | null;
  buyThresholdPersistence?: string;
};

type StockFlowSourceData = {
  runs: RunResponse[];
  coverage?: DashboardRunCoverage;
  cachedAt?: number;
  warning?: string;
  portfolioSnapshot:
    | ZerodhaPortfolioSnapshotDetail
    | IndMoneyUsPortfolioSnapshotDetail
    | null;
};

const stockFlowSourcePromises = new Map<
  RebalanceStockFlowPortfolio,
  Promise<StockFlowSourceData>
>();
const stockFlowLastSuccessfulSources = new Map<
  RebalanceStockFlowPortfolio,
  { data: StockFlowSourceData; cachedAt: number }
>();
const STOCK_FLOW_TRANSIENT_FALLBACK_MAX_AGE_MS = 5 * 60 * 1000;

export function fetchRebalanceStockFlowSource(
  portfolio: RebalanceStockFlowPortfolio,
): Promise<StockFlowSourceData> {
  const cached = stockFlowSourcePromises.get(portfolio);
  if (cached) return cached;

  let coverage: DashboardRunCoverage | undefined;
  const request = Promise.all([
    fetchDashboardRecentFullRuns((result) => { coverage = result; }),
    portfolio === "zerodha"
      ? apiService.zerodhaPortfolioOverview()
      : apiService.indmoneyUsPortfolioOverview(),
  ]).then(
    ([runs, overview]) => {
      stockFlowSourcePromises.delete(portfolio);
      const data = {
        runs,
        coverage,
        portfolioSnapshot: overview.latest,
      };
      stockFlowLastSuccessfulSources.set(portfolio, {
        data,
        cachedAt: Date.now(),
      });
      return data;
    },
    (error) => {
      stockFlowSourcePromises.delete(portfolio);
      const fallback = stockFlowLastSuccessfulSources.get(portfolio);
      if (
        fallback
        && Date.now() - fallback.cachedAt <= STOCK_FLOW_TRANSIENT_FALLBACK_MAX_AGE_MS
      ) {
        return { ...fallback.data, cachedAt: fallback.cachedAt, warning: "Refresh failed; showing a previously loaded snapshot. " + (error instanceof Error ? error.message : "Source unavailable") };
      }
      throw error;
    },
  );
  // Coalesce only concurrent requests. A settled response must never survive a
  // later scan or portfolio sync, otherwise reopening the popup shows stale data.
  stockFlowSourcePromises.set(portfolio, request);
  return request;
}

export function RebalanceStockFlowWidget({
  formulaConfig,
  initialPortfolio = "zerodha",
  buyThresholds,
  buyThresholdDrafts,
  onBuyThresholdDraftChange,
  buyThresholdSaveError,
  buyThresholdPersistence,
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
          <ZerodhaRebalanceStockFlowWidget
            formulaConfig={formulaConfig}
            buyThreshold={buyThresholds.zerodha}
            buyThresholdDraft={buyThresholdDrafts.zerodha}
            onBuyThresholdDraftChange={(value) => onBuyThresholdDraftChange("zerodha", value)}
            buyThresholdSaveError={buyThresholdSaveError}
              buyThresholdPersistence={buyThresholdPersistence}
          />
        ) : (
          <IndMoneyRebalanceStockFlowWidget
            formulaConfig={formulaConfig}
            buyThreshold={buyThresholds.indmoneyUs}
            buyThresholdDraft={buyThresholdDrafts.indmoneyUs}
            onBuyThresholdDraftChange={(value) => onBuyThresholdDraftChange("indmoneyUs", value)}
            buyThresholdSaveError={buyThresholdSaveError}
              buyThresholdPersistence={buyThresholdPersistence}
          />
        )}
      </div>
    </section>
  );
}

export function ZerodhaRebalanceStockFlowWidget({
  formulaConfig,
  buyThreshold,
  buyThresholdDraft,
  onBuyThresholdDraftChange,
  buyThresholdSaveError,
  buyThresholdPersistence,
}: Omit<RebalanceStockFlowSubwidgetProps, "portfolio">) {
  return (
    <RebalanceStockFlowSubwidget
      formulaConfig={formulaConfig}
      portfolio="zerodha"
      buyThreshold={buyThreshold}
      buyThresholdDraft={buyThresholdDraft}
      onBuyThresholdDraftChange={onBuyThresholdDraftChange}
      buyThresholdSaveError={buyThresholdSaveError}
              buyThresholdPersistence={buyThresholdPersistence}
    />
  );
}

export function IndMoneyRebalanceStockFlowWidget({
  formulaConfig,
  buyThreshold,
  buyThresholdDraft,
  onBuyThresholdDraftChange,
  buyThresholdSaveError,
  buyThresholdPersistence,
}: Omit<RebalanceStockFlowSubwidgetProps, "portfolio">) {
  return (
    <RebalanceStockFlowSubwidget
      formulaConfig={formulaConfig}
      portfolio="indmoneyUs"
      buyThreshold={buyThreshold}
      buyThresholdDraft={buyThresholdDraft}
      onBuyThresholdDraftChange={onBuyThresholdDraftChange}
      buyThresholdSaveError={buyThresholdSaveError}
              buyThresholdPersistence={buyThresholdPersistence}
    />
  );
}

function RebalanceStockFlowSubwidget({
  formulaConfig,
  portfolio: portfolioId,
  buyThreshold,
  buyThresholdDraft,
  onBuyThresholdDraftChange,
  buyThresholdSaveError,
  buyThresholdPersistence,
}: RebalanceStockFlowSubwidgetProps) {
  const [detailed, setDetailed] = useState(false);
  const [runs, setRuns] = useState<RunResponse[]>([]);
  const [portfolioSnapshot, setPortfolioSnapshot] = useState<
    ZerodhaPortfolioSnapshotDetail | IndMoneyUsPortfolioSnapshotDetail | null
  >(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sourceInfo, setSourceInfo] = useState<StockFlowSourceData | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchRebalanceStockFlowSource(portfolioId)
      .then((source) => {
        const { runs: result, portfolioSnapshot: snapshot } = source;
        if (!cancelled) {
          setSourceInfo(source);
          setRuns(result);
          setPortfolioSnapshot(snapshot);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Unable to load stock flow.");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [portfolioId]);

  const flow = useMemo(() => {
    const portfolio = PORTFOLIOS.find((item) => item.id === portfolioId)!;
    const swingSelection = selectFlowStage(runs, "swing", portfolio.market);
    const swingRun = swingSelection.selected;
    const technicalSelection = selectFlowStage(runs, "technical", portfolio.market);
    const technicalRun = technicalSelection.selected;
    const matchingRebalanceRuns = latestMatchingRebalanceRuns(runs, portfolio.market);
    const rebalanceRun = newest(matchingRebalanceRuns);
    const swingRuns = swingRun?.auto_rebalance_portfolio && typeof swingRun.auto_rebalance_sequence === "number"
      ? runs.filter(run => isAnalysisRunForStage(run, "swing", portfolio.market) && sameFlowSequence(run, swingRun))
      : swingRun ? [swingRun] : [];
    const swingEvidence = buildSwingFlow(swingRuns);
    const swing = swingEvidence.stocks;
    const rebalance = matchingRebalanceRuns.length
      ? buildConsensusRows(matchingRebalanceRuns, portfolio.market, portfolioSnapshot, runs)
      : [];
    const actionables = buildDashboardActionRows(
      rebalance,
      portfolio.market,
      buildTechnicalScanMap(technicalRun ? [technicalRun] : []),
      formulaConfig,
    )
      .filter((row) => {
        if (
          portfolioId !== "zerodha"
          || (row.formulaAction !== "Sell All" && row.formulaAction !== "Trim")
        ) {
          return true;
        }
        const symbol = row.stock.symbol
          .trim()
          .toUpperCase()
          .replace(/^(?:NSE|BSE):/, "")
          .replace(/\.(?:NS|BO|NSE|BSE)$/i, "");
        const zerodhaSnapshot = portfolioSnapshot as ZerodhaPortfolioSnapshotDetail | null;
        return Boolean(
          zerodhaSnapshot?.holdings.some(
            (holding) =>
              holding.tradingsymbol.trim().toUpperCase() === symbol
              && holding.quantity > 0,
          ),
        );
      })
      .sort(compareFinalActionablesForThreshold(buyThreshold));
    const swingJobOutputs = swingEvidence.outputs;
    const rebalanceJobOutputs = buildStageJobOutputs(rebalance, matchingRebalanceRuns);
    return {
      portfolio,
      swing,
      rebalance,
      actionables,
      swingJobOutputs,
      rebalanceJobOutputs,
      rebalanceRun,
      swingRun,
      technicalRun,
      swingSelection,
      technicalSelection,
      sequenceLinked: sameFlowSequence(swingRun, rebalanceRun) && sameFlowSequence(rebalanceRun, technicalRun),
      swingMeta: stageRunMeta(swingRun),
      rebalanceMeta: stageRunMeta(rebalanceRun),
    };
  }, [buyThreshold, formulaConfig, portfolioId, portfolioSnapshot, runs]);

  return (
    <section
      id={`${portfolioId}-rebalance-stock-flow`}
      role="tabpanel"
      aria-label={flow.portfolio.title}
      className="min-w-0 rounded-2xl border border-slate-200 bg-white p-3 [overflow-wrap:anywhere] sm:p-5"
    >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-950">{flow.portfolio.title}</h2>
              <p className="mt-1 text-sm text-slate-500">Stored stage outputs and a calculation using the current formula. Source stages may come from different runs.</p>
            </div>
            <Button type="button" variant="outline" onClick={() => setDetailed((value) => !value)} aria-pressed={detailed} className="rounded-full">
              {detailed ? <ChevronUp className="mr-2 size-4" /> : <ChevronDown className="mr-2 size-4" />}
              {detailed ? "Summary View" : "Detailed View"}
            </Button>
          </div>

          {!loading && !error && <div className="mt-4 space-y-2 text-xs text-slate-700">
            <p>Sources: Swing {flow.swingJobOutputs.length ? [...new Set(flow.swingJobOutputs.map(output => output.runId))].map(id => "#" + id).join(", ") : "unavailable"}; Rebalance {flow.rebalanceJobOutputs.length ? [...new Set(flow.rebalanceJobOutputs.map(output => output.runId))].map(id => "#" + id).join(", ") : "unavailable"}; Technical #{flow.technicalRun?.id ?? "unavailable"} ({formatAuditTime(flow.technicalRun?.created_at)}). Final Actionables is a current-formula calculation, not a separately saved scan.</p>
            <p className={flow.sequenceLinked ? "text-blue-900" : "rounded border border-amber-300 bg-amber-50 p-2 text-amber-950"}>{flow.sequenceLinked ? "All selected stages share the recorded workflow sequence; this does not certify source quality." : "⚠ Stages selected independently. A shared workflow sequence is not established; do not read this as one verified run."}</p>
            {flow.swingSelection.newerIncomplete && <p className="text-amber-950">⚠ Newer Swing run #{flow.swingSelection.newerIncomplete.id} is {flow.swingSelection.newerIncomplete.status}; showing explicitly labeled older completed output.</p>}
            {flow.technicalSelection.newerIncomplete && <p className="text-amber-950">⚠ Newer technical run #{flow.technicalSelection.newerIncomplete.id} is {flow.technicalSelection.newerIncomplete.status}; selected older technical coverage may be stale.</p>}
            {!flow.technicalRun && <p className="text-amber-950">⚠ Technical evidence is unavailable for this market. Scores use only the available inputs.</p>}
            {sourceInfo?.warning && <p className="rounded border border-amber-300 bg-amber-50 p-2 text-amber-950">⚠ {sourceInfo.warning} Previously loaded {formatAuditTime(new Date(sourceInfo.cachedAt ?? 0).toISOString())}.</p>}
            {Boolean(sourceInfo?.coverage?.failed_run_ids.length) && <p className="text-amber-950">⚠ Missing run details: {sourceInfo?.coverage?.failed_run_ids.map(id => "#" + id).join(", ")}. Stage coverage is partial.</p>}
            <p>Bounded recent-run coverage{sourceInfo?.coverage?.history_has_more ? "; older runs may exist outside this view" : ""}. No live market refresh is performed by this popup.</p>
          </div>}
          {loading ? <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500"><Loader2 className="size-4 animate-spin" /> Loading stock flow…</div>
          : error ? <p className="mt-5 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</p>
          : detailed ? (
            <div className="mt-5 grid min-h-0 min-w-0 gap-4 xl:grid-cols-[repeat(3,minmax(0,1fr))]">
              <Stage title="Swing Scan" count={flow.swing.length} meta={flow.swingMeta}>
                {flow.swing.length ? flow.swing.map((stock) => (
                  <StockRow key={stock.key} name={stock.symbol} detailed details={[`Exchange: ${stock.exchange || "—"}`, `Suggestions: ${stock.totalSuggestions}`]} />
                )) : <EmptyStage />}
              </Stage>
              <Stage title="Rebalance Scan" count={flow.rebalance.length} meta={flow.rebalanceMeta}>
                {flow.rebalance.length ? flow.rebalance.map((stock) => (
                  <StockRow key={stock.key} name={stock.symbol} action={stock.consensusAction} detailed details={[`Consensus: ${consensusLabel(stock)}`, `Exchange: ${stock.exchange || "—"}`]} />
                )) : <EmptyStage />}
              </Stage>
              <Stage
                title="Final Actionables"
                count={flow.actionables.length}
                meta={flow.rebalanceMeta}
                toolbar={(
                  <BuyThresholdEditor
                    portfolio={portfolioId}
                    value={buyThresholdDraft}
                    threshold={buyThreshold}
                    onChange={onBuyThresholdDraftChange}
                    saveError={buyThresholdSaveError}
                      persistence={buyThresholdPersistence}
                  />
                )}
              >
                {flow.actionables.length ? flow.actionables.map((row) => (
                  <StockRow key={row.id} name={row.stock.symbol} action={row.formulaAction} score={row.formulaScore} consensus={consensusLabel(row.stock)} detailed highlighted={isAboveBuyThreshold(row, buyThreshold)} details={[`Exchange: ${row.stock.exchange || "—"}`, `Suggestions: ${row.stock.totalSuggestions}`, `Source: ${flow.rebalanceRun && isAnalysisRunForStage(flow.rebalanceRun, "rebalance", flow.portfolio.market) ? "Latest rebalance scan" : "Rebalance scan"}`]} />
                )) : <EmptyStage />}
              </Stage>
            </div>
          ) : (
            <div className="mt-5">
              <h3 className="mb-4 text-center text-xl font-bold uppercase tracking-[0.08em] text-slate-950">Summary View</h3>
              <div className="grid min-h-0 min-w-0 gap-4 xl:grid-cols-[minmax(0,0.72fr)_minmax(0,1.08fr)_minmax(0,1.4fr)]">
                <SwingJobOutputsStage
                  count={flow.swing.length}
                  meta={flow.swingMeta}
                  outputs={flow.swingJobOutputs}
                />

                <RebalanceJobOutputsStage
                  count={flow.rebalance.length}
                  meta={flow.rebalanceMeta}
                  stocks={flow.rebalance}
                  outputs={flow.rebalanceJobOutputs}
                />

                <SummaryStage
                  title="Final Actionables"
                  count={flow.actionables.length}
                  meta={flow.rebalanceMeta}
                  toolbar={(
                    <BuyThresholdEditor
                      portfolio={portfolioId}
                      value={buyThresholdDraft}
                      threshold={buyThreshold}
                      onChange={onBuyThresholdDraftChange}
                      saveError={buyThresholdSaveError}
                      persistence={buyThresholdPersistence}
                    />
                  )}
                >
                  <thead className="sticky top-0 z-10 bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-600">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Stock Symbol</th>
                      <th className="px-4 py-3 font-semibold">Action</th>
                      <th className="whitespace-nowrap px-4 py-3 text-right font-semibold">Final Score</th>
                      <th className="px-4 py-3 text-center font-semibold">Consensus</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 bg-white">
                    {flow.actionables.length ? flow.actionables.map((row) => (
                      <tr
                        key={row.id}
                        data-buy-threshold-eligible={isAboveBuyThreshold(row, buyThreshold) ? "true" : undefined}
                        className={isAboveBuyThreshold(row, buyThreshold) ? "bg-emerald-50" : undefined}
                      >
                        <td className="px-4 py-3 text-sm font-semibold text-slate-950">{row.stock.symbol}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <ActionBadge action={row.formulaAction} />
                            {isAboveBuyThreshold(row, buyThreshold) ? (
                              <span className="whitespace-nowrap rounded-full bg-emerald-600 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-white">Above threshold</span>
                            ) : null}
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right text-sm tabular-nums text-slate-700">{row.formulaScore === null ? "—" : row.formulaScore.toFixed(2)}</td>
                        <td className="px-4 py-3 text-center text-sm font-semibold tabular-nums text-slate-700">{consensusLabel(row.stock)}</td>
                      </tr>
                    )) : <EmptyTableRow colSpan={4} />}
                  </tbody>
                </SummaryStage>
              </div>
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
  buyThresholds,
  buyThresholdDrafts,
  onBuyThresholdDraftChange,
  buyThresholdSaveError,
  buyThresholdPersistence,
  onClose,
}: {
  portfolio: RebalanceStockFlowPortfolio | null;
  formulaConfig: ScoreMatrixFormulaConfig;
  buyThresholds: Record<RebalanceStockFlowPortfolio, number>;
  buyThresholdDrafts: Record<RebalanceStockFlowPortfolio, string>;
  onBuyThresholdDraftChange: (
    portfolio: RebalanceStockFlowPortfolio,
    value: string,
  ) => void;
  buyThresholdSaveError?: string | null;
  buyThresholdPersistence?: string;
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
        className="flex max-h-[92vh] min-w-0 w-full max-w-[96rem] flex-col overflow-hidden rounded-[28px] border border-slate-200 bg-slate-50 shadow-2xl"
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
        <div className="min-h-0 min-w-0 overflow-auto p-3 sm:p-5">
          {portfolio === "zerodha" ? (
            <ZerodhaRebalanceStockFlowWidget
              formulaConfig={formulaConfig}
              buyThreshold={buyThresholds.zerodha}
              buyThresholdDraft={buyThresholdDrafts.zerodha}
              onBuyThresholdDraftChange={(value) => onBuyThresholdDraftChange("zerodha", value)}
              buyThresholdSaveError={buyThresholdSaveError}
              buyThresholdPersistence={buyThresholdPersistence}
            />
          ) : (
            <IndMoneyRebalanceStockFlowWidget
              formulaConfig={formulaConfig}
              buyThreshold={buyThresholds.indmoneyUs}
              buyThresholdDraft={buyThresholdDrafts.indmoneyUs}
              onBuyThresholdDraftChange={(value) => onBuyThresholdDraftChange("indmoneyUs", value)}
              buyThresholdSaveError={buyThresholdSaveError}
              buyThresholdPersistence={buyThresholdPersistence}
            />
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

function Stage({ title, count, meta, toolbar, children }: { title: string; count: number; meta: { models: string; timestamp: string } | null; toolbar?: ReactNode; children: ReactNode }) {
  return <article className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-slate-50/60"><StageHeader title={title} count={count} meta={meta} />{toolbar}<div className="max-h-[min(58vh,36rem)] min-h-0 divide-y divide-slate-200 overflow-auto overscroll-contain">{children}</div></article>;
}

function StockRow({ name, action, score, consensus, detailed, highlighted = false, details = [] }: { name: string; action?: string; score?: number | null; consensus?: string; detailed: boolean; highlighted?: boolean; details?: string[] }) {
  return <div className={cn("px-4 py-3", highlighted ? "bg-emerald-50" : "bg-white")}><div className="flex flex-wrap items-center gap-x-3 gap-y-1"><strong className="text-sm text-slate-950">{name}</strong>{action ? <ActionBadge action={action} /> : null}{highlighted ? <span className="rounded-full bg-emerald-600 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-white">Above threshold</span> : null}{score !== undefined ? <span className="text-xs text-slate-600">Final Score: <b>{score === null ? "—" : score.toFixed(2)}</b></span> : null}{consensus ? <span className="text-xs text-slate-600">Consensus: <b>{consensus}</b></span> : null}</div>{detailed ? <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">{details.map((detail) => <span key={detail}>{detail}</span>)}</div> : null}</div>;
}

function StageHeader({ title, count, meta }: { title: string; count: number; meta: { models: string; timestamp: string } | null }) {
  return <header className="shrink-0 border-b border-slate-200 bg-slate-100 px-4 py-3"><div className="flex items-center justify-between gap-3"><h3 className="font-semibold text-slate-950">{title}</h3><span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-600">{count}</span></div>{meta ? <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500"><span><b className="font-semibold text-slate-700">LLM:</b> {meta.models}</span><time><b className="font-semibold text-slate-700">Run:</b> {meta.timestamp}</time></div> : <p className="mt-1.5 text-[11px] text-slate-500">No completed run metadata</p>}</header>;
}

function JobOutputHeading({ output, index }: { output: StageJobOutput; index: number }) {
  return (
    <div className="border-b border-slate-200 bg-blue-50/70 px-4 py-3">
      <p className="text-sm font-bold text-slate-950">
        {output.provider} · {output.model} {index + 1}
      </p>
      <p className="mt-0.5 text-xs font-semibold text-blue-700">Run #{output.runId} · Job #{output.jobId} · {output.status}</p>
    </div>
  );
}

function SwingJobOutputsStage({ count, meta, outputs }: { count: number; meta: { models: string; timestamp: string } | null; outputs: StageJobOutput[] }) {
  return (
    <article className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-300 bg-white shadow-sm">
      <StageHeader title="Swing Scan" count={count} meta={meta} />
      <div role="region" aria-label="Swing job outputs, scroll to inspect" tabIndex={0} className="max-h-[min(58vh,36rem)] min-h-0 overflow-auto overscroll-contain focus-visible:outline-2 focus-visible:outline-blue-700">
        {outputs.length ? outputs.map((output, index) => (
          <section key={output.key} aria-label={`${output.model} ${index + 1} Job #${output.jobId} output`} className="border-b border-slate-300 last:border-b-0">
            <JobOutputHeading output={output} index={index} />
            <table className="w-full border-collapse">
              <thead className="bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-600">
                <tr><th className="px-4 py-2.5 font-semibold">Stock Symbol</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-200 bg-white">
                {output.symbols.length ? output.symbols.map((symbol) => (
                  <tr key={`${output.key}:${symbol}`}><td className="px-4 py-3 text-sm font-semibold text-slate-950">{symbol}</td></tr>
                )) : (
                  <tr><td className="px-4 py-5 text-sm text-slate-500">{stockOutputMessage(output.state)} · {output.status}</td></tr>
                )}
              </tbody>
            </table>
          </section>
        )) : <EmptyStage />}
      </div>
    </article>
  );
}

function RebalanceJobOutputsStage({ count, meta, stocks, outputs }: { count: number; meta: { models: string; timestamp: string } | null; stocks: StockConsensus[]; outputs: StageJobOutput[] }) {
  return (
    <article className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-300 bg-white shadow-sm">
      <StageHeader title="Rebalance Scan" count={count} meta={meta} />
      <div role="region" aria-label="Rebalance job outputs, scroll to inspect" tabIndex={0} className="max-h-[min(58vh,36rem)] min-h-0 overflow-auto overscroll-contain focus-visible:outline-2 focus-visible:outline-blue-700">
        <table className="w-full min-w-max border-collapse">
          <thead className="sticky top-0 z-10 bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-600">
            <tr>
              <th className="px-4 py-3 font-semibold">Stock Symbol</th>
              {outputs.map((output, index) => (
                <th key={output.key} className="w-48 min-w-36 max-w-48 whitespace-normal break-words border-l border-slate-200 px-4 py-3 font-semibold normal-case tracking-normal">
                  <span className="block text-xs font-bold text-slate-800">{output.provider} · {output.model} {index + 1}</span>
                  <span className="mt-0.5 block text-[11px] font-semibold text-blue-700">Run #{output.runId} · Job #{output.jobId}</span><span className="mt-1 block max-w-48 whitespace-normal text-[11px] font-normal text-slate-600">{stockOutputMessage(output.state)} · {output.status}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 bg-white">
            {stocks.length ? stocks.map((stock) => (
              <tr key={stock.key}>
                <td className="px-4 py-3 text-sm font-semibold text-slate-950">{stock.symbol}</td>
                {outputs.map((output) => {
                  const action = output.actions.get(stock.key) || "Not covered";
                  return <td key={`${stock.key}:${output.key}`} className="border-l border-slate-100 px-4 py-3"><ActionBadge action={action} /></td>;
                })}
              </tr>
            )) : <EmptyTableRow colSpan={Math.max(1, outputs.length + 1)} />}
          </tbody>
        </table>
      </div>
    </article>
  );
}

function SummaryStage({ title, count, meta, toolbar, children }: { title: string; count: number; meta: { models: string; timestamp: string } | null; toolbar?: ReactNode; children: ReactNode }) {
  return <article className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-300 bg-white shadow-sm"><StageHeader title={title} count={count} meta={meta} />{toolbar}<div role="region" aria-label={title + " table, scroll to inspect"} tabIndex={0} className="max-h-[min(58vh,36rem)] min-h-0 overflow-auto overscroll-contain focus-visible:outline-2 focus-visible:outline-blue-700"><table className="w-full min-w-max border-collapse">{children}</table></div></article>;
}

function BuyThresholdEditor({
  portfolio,
  value,
  threshold,
  onChange,
  saveError,
  persistence,
}: {
  portfolio: RebalanceStockFlowPortfolio;
  value: string;
  threshold: number;
  onChange: (value: string) => void;
  saveError?: string | null;
  persistence?: string;
}) {
  const id = `${portfolio}-stock-flow-buy-threshold`;
  return (
    <div className="shrink-0 border-b border-blue-100 bg-blue-50 px-4 py-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <label className="block text-xs font-bold uppercase tracking-wide text-blue-700" htmlFor={id}>
            Buy Threshold
          </label>
          <p className="mt-1 text-[11px] leading-4 text-blue-800">
            Buy New and Buy More rows are highlighted when Final Score is greater than {threshold.toFixed(2)}.
          </p>
        </div>
        <input
          id={id}
          type="number"
          step="0.01"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="w-28 rounded-xl border border-blue-200 bg-white px-3 py-2 text-base font-black text-slate-950 shadow-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
          aria-label={`${portfolio === "zerodha" ? "Zerodha" : "IndMoney"} stock flow buy threshold`}
        />
      </div>
      <p className="mt-2 text-xs text-blue-950">{persistence === "local_only" ? "Local preview only · saving is disabled during analysis-only recovery. Saved preferences are unchanged." : persistence === "saving" ? "Saving threshold preferences…" : persistence === "saved" ? "Saved threshold preferences loaded." : persistence === "error" ? "Local preview only · preferences were not saved." : "Preference persistence is unconfirmed; shown values are a local preview."}</p>
      {saveError ? <p className="mt-2 text-xs font-semibold text-red-700">{saveError}</p> : null}
    </div>
  );
}

function ActionBadge({ action }: { action: string }) {
  return <span className={cn("inline-flex whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-semibold", actionBadgeClass(action))}>{action}</span>;
}

function EmptyTableRow({ colSpan }: { colSpan: number }) {
  return <tr><td colSpan={colSpan} className="px-4 py-8 text-center text-sm text-slate-500">No stock rows available in this selection. Check source coverage above.</td></tr>;
}
