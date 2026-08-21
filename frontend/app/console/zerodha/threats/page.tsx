'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Clock3,
  LineChart,
  Loader2,
  Radar,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';

import { EventScanRunControls } from '@/components/shared/EventScanRunControls';
import MarkdownRenderer from '@/components/shared/MarkdownRenderer';
import { PortfolioAnalysisNav } from '@/components/shared/PortfolioAnalysisNav';
import { ScanHistoryButton } from '@/components/shared/ScanHistoryButton';
import { TradingViewSymbolLink } from '@/components/shared/TradingViewSymbolLink';
import { Button } from '@/components/ui/button';
import { useHistoricalAnalysisCosts } from '@/hooks/useHistoricalAnalysisCosts';
import { useUsdInrRate } from '@/hooks/useUsdInrRate';
import { formatApiTimestamp } from '@/lib/datetime';
import { formatUsdAsVerifiedInr } from '@/lib/fxPresentation';
import { URLs } from '@/lib/urls';
import { apiService, APIError } from '@/services/api';
import {
  type ProviderModelTarget,
  type ZerodhaPortfolioHolding,
  type ZerodhaPortfolioOverviewResponse,
  type ZerodhaStatusResponse,
  type ZerodhaThreatAnalysis,
  type ZerodhaThreatKeyValueItem,
  type ZerodhaThreatTableSection,
} from '@/types/api';

import { ThreatsReportTable, type ThreatHoldingMetric } from './_components/ThreatsReportTable';
import { ThreatsSummaryCards } from './_components/ThreatsSummaryCards';

function normalizeError(err: unknown) {
  if (err instanceof APIError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}

function formatTs(iso: string | null | undefined) {
  return formatApiTimestamp(iso);
}

function formatInr(value: number | null | undefined) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(value || 0);
}

function formatInrCost(value: number, usdInrRate: number) {
  return formatUsdAsVerifiedInr(value, usdInrRate);
}

function hasKnownCost(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function resolvePortfolioPercentage({
  amountInvested,
  totalAmountInvested,
  positionValue,
  totalPositionValue,
}: {
  amountInvested: number | null;
  totalAmountInvested: number;
  positionValue: number | null;
  totalPositionValue: number;
}) {
  if (totalPositionValue > 0) {
    if (positionValue === null) {
      return null;
    }
    return (positionValue / totalPositionValue) * 100;
  }

  if (totalAmountInvested > 0) {
    if (amountInvested === null) {
      return null;
    }
    return (amountInvested / totalAmountInvested) * 100;
  }

  return null;
}

function buildHoldingMetrics(holdings: ZerodhaPortfolioHolding[], totalPositionValue: number) {
  const totalAmountInvested = holdings.reduce((sum, holding) => sum + (holding.invested_value || 0), 0);

  return holdings.map<ThreatHoldingMetric>((holding) => ({
    exchange: holding.exchange,
    stockSymbol: holding.tradingsymbol,
    amountInvested: holding.invested_value,
    portfolioPercentage: resolvePortfolioPercentage({
      amountInvested: holding.invested_value,
      totalAmountInvested,
      positionValue: holding.market_value,
      totalPositionValue,
    }),
  }));
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isJobActive(status: string | null | undefined) {
  return status === 'pending' || status === 'processing' || status === 'scheduled';
}

function findSection(analysis: ZerodhaThreatAnalysis | null, key: string) {
  return analysis?.report?.tables.find((section) => section.key === key) ?? null;
}

function countSeverities(tables: ZerodhaThreatTableSection[]) {
  const counts = { veryHigh: 0, high: 0, medium: 0, low: 0 };

  for (const table of tables) {
    for (const row of table.rows) {
      for (const [column, value] of Object.entries(row)) {
        if (!/severity|risk|priority/i.test(column)) continue;
        const normalizedValues = value
          .split('\n')
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean);
        for (const normalized of normalizedValues) {
          if (normalized === 'very high') counts.veryHigh += 1;
          if (normalized === 'high') counts.high += 1;
          if (normalized === 'medium') counts.medium += 1;
          if (normalized === 'low') counts.low += 1;
        }
      }
    }
  }

  return counts;
}

function BottomLineCards({ items }: { items: ZerodhaThreatKeyValueItem[] }) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {items.map((item) => (
        <div
          key={item.label}
          className="rounded-[26px] border border-slate-200 bg-white px-5 py-4 shadow-sm"
        >
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            {item.label}
          </div>
          <div className="mt-2 text-sm leading-6 text-slate-700">{item.value}</div>
        </div>
      ))}
    </div>
  );
}

export default function ZerodhaThreatsPage() {
  const [status, setStatus] = useState<ZerodhaStatusResponse | null>(null);
  const [overview, setOverview] = useState<ZerodhaPortfolioOverviewResponse | null>(null);
  const [analysis, setAnalysis] = useState<ZerodhaThreatAnalysis | null>(null);
  const [lastReportAnalysis, setLastReportAnalysis] = useState<ZerodhaThreatAnalysis | null>(null);

  const [loadingPage, setLoadingPage] = useState(true);
  const [syncingPortfolio, setSyncingPortfolio] = useState(false);
  const [runningAnalysis, setRunningAnalysis] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const usdInrRate = useUsdInrRate();

  const loadStatusAndPortfolio = useCallback(async () => {
    const [statusResponse, overviewResponse] = await Promise.all([
      apiService.zerodhaStatus(),
      apiService.zerodhaPortfolioOverview(),
    ]);
    setStatus(statusResponse);
    setOverview(overviewResponse);
  }, []);

  const loadLatestAnalysis = useCallback(async () => {
    const response = await apiService.zerodhaThreatsLatest();
    setAnalysis(response.analysis);
    if (response.analysis?.report) {
      setLastReportAnalysis(response.analysis);
      return;
    }

    if (!response.analysis || !isJobActive(response.analysis.status)) {
      return;
    }

    const history = await apiService.zerodhaThreatsHistory({ limit: 100 });
    const previousCompleted = history.history.find(
      (item) => item.status === 'completed' && item.job_id !== response.analysis?.job_id,
    );
    if (!previousCompleted) {
      return;
    }

    const fallbackAnalysis = await apiService.zerodhaThreatJob(previousCompleted.job_id);
    if (fallbackAnalysis.report) {
      setLastReportAnalysis(fallbackAnalysis);
    }
  }, []);

  const loadAnalysisJob = useCallback(async (jobId: number) => {
    const response = await apiService.zerodhaThreatJob(jobId);
    setAnalysis(response);
    if (response.report) {
      setLastReportAnalysis(response);
    }
  }, []);

  const loadAnalysisHistory = useCallback(async () => {
    const response = await apiService.zerodhaThreatsHistory({ limit: 100 });
    return response.history;
  }, []);

  const pollPortfolioOverview = useCallback(
    async (baselineCapturedAt: string | null) => {
      setSyncingPortfolio(true);
      try {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          await sleep(attempt === 0 ? 1500 : 2000);
          const refreshed = await apiService.zerodhaPortfolioOverview();
          setOverview(refreshed);
          const latestCapturedAt = refreshed.latest?.captured_at ?? null;
          if (latestCapturedAt && latestCapturedAt !== baselineCapturedAt) {
            return;
          }
        }
      } finally {
        setSyncingPortfolio(false);
      }
    },
    [],
  );

  const handleSyncPortfolio = useCallback(async () => {
    const baselineCapturedAt = overview?.latest?.captured_at ?? null;
    setError(null);
    try {
      await apiService.zerodhaSyncPortfolio();
      await pollPortfolioOverview(baselineCapturedAt);
      await loadStatusAndPortfolio();
    } catch (err) {
      setError(normalizeError(err));
    }
  }, [loadStatusAndPortfolio, overview?.latest?.captured_at, pollPortfolioOverview]);

  const handleRunAnalysis = useCallback(async (target: ProviderModelTarget | null) => {
    setRunningAnalysis(true);
    setError(null);
    try {
      const queued = await apiService.zerodhaRunThreats(target ?? undefined);
      await loadAnalysisJob(queued.job_id);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setRunningAnalysis(false);
    }
  }, [loadAnalysisJob]);

  useEffect(() => {
    let mounted = true;

    const load = async () => {
      setLoadingPage(true);
      setError(null);
      try {
        await Promise.all([loadStatusAndPortfolio(), loadLatestAnalysis()]);
      } catch (err) {
        if (mounted) {
          setError(normalizeError(err));
        }
      } finally {
        if (mounted) {
          setLoadingPage(false);
        }
      }
    };

    void load();
    return () => {
      mounted = false;
    };
  }, [loadLatestAnalysis, loadStatusAndPortfolio]);

  useEffect(() => {
    if (!analysis?.job_id || !isJobActive(analysis.status)) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void loadAnalysisJob(analysis.job_id).catch((err) => {
        setError(normalizeError(err));
      });
    }, 4000);

    return () => window.clearInterval(intervalId);
  }, [analysis?.job_id, analysis?.status, loadAnalysisJob]);

  const latestSnapshot = overview?.latest ?? null;
  const analysisIsActive = isJobActive(analysis?.status);
  const displayedAnalysis = analysis?.report ? analysis : lastReportAnalysis;
  const historicalEstimatedCostInrByTarget = useHistoricalAnalysisCosts({
    analysis,
    loadHistory: loadAnalysisHistory,
    usdInrRate,
  });
  const holdingMetrics = buildHoldingMetrics(
    latestSnapshot?.holdings ?? [],
    latestSnapshot?.holdings_market_value ?? 0,
  );
  const topHoldings = [...(latestSnapshot?.holdings ?? [])]
    .sort((left, right) => right.market_value - left.market_value)
    .slice(0, 5);
  const severityCounts = countSeverities(displayedAnalysis?.report?.tables ?? []);
  const urgentSection = findSection(displayedAnalysis, 'urgent_actionables');
  const firstAction = urgentSection?.rows[0]?.['Urgent Action Needed']?.toLowerCase() ?? '';
  const hasUrgentActions = Boolean(
    urgentSection
    && urgentSection.rows.length > 0
    && !firstAction.includes('no urgent action required'),
  );

  if (loadingPage) {
    return (
      <div className="flex items-center gap-3 text-sm text-slate-500">
        <Loader2 className="size-4 animate-spin" />
        Loading threat dashboard...
      </div>
    );
  }

  return (
    <div className="mx-auto flex flex-col gap-6">
      <div className="flex justify-end">
        <PortfolioAnalysisNav portfolio="zerodha" active="threats" />
      </div>

      <section className="overflow-hidden rounded-[34px] border border-slate-200 bg-linear-to-br from-slate-950 via-slate-900 to-amber-950 text-white shadow-lg">
        <div className="grid gap-6 px-6 py-7 lg:grid-cols-[1.4fr_0.9fr] lg:px-8">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/8 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-100">
              <Radar className="size-3.5" />
              Threat Radar
            </div>
            <h1 className="mt-4 font-serif text-3xl tracking-tight text-white md:text-4xl">
              Zerodha:Threats and Weakness
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-200/90">
              This screen sends your latest synced Zerodha portfolio through the selected AI model with live web-search context, then turns the response into a trading-focused threats map for the next 1-3 months.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <EventScanRunControls
                onRun={handleRunAnalysis}
                disabled={!latestSnapshot}
                running={runningAnalysis || analysisIsActive}
                buttonLabel="Run Threat Scan"
                defaultTarget={analysis ? { provider: analysis.provider, model: analysis.model } : undefined}
                historicalEstimatedCostInrByTarget={historicalEstimatedCostInrByTarget}
                buttonClassName="rounded-full bg-amber-400 px-5 text-slate-950 hover:bg-amber-300"
              />
              <ScanHistoryButton
                title="Threat scan history"
                emptyMessage="No threat scans have been run yet."
                loadHistory={loadAnalysisHistory}
                usdInrRate={usdInrRate}
              />
              <Button
                variant="outline"
                onClick={handleSyncPortfolio}
                disabled={!status?.connected || syncingPortfolio}
                className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10 hover:text-white"
              >
                {syncingPortfolio ? <Loader2 className="mr-2 size-4 animate-spin" /> : <RefreshCw className="mr-2 size-4" />}
                Sync Portfolio
              </Button>
              <Button asChild variant="ghost" className="rounded-full text-amber-100 hover:bg-white/10 hover:text-white">
                <Link href={URLs.routes.console.zerodha()}>
                  Open Zerodha
                  <ArrowRight className="ml-2 size-4" />
                </Link>
              </Button>
            </div>
          </div>

          <div className="rounded-[28px] border border-white/10 bg-white/8 p-5 backdrop-blur">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-100">
              <Clock3 className="size-3.5" />
              Current Snapshot
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-300">Latest Sync</div>
                <div className="mt-1 text-sm text-white">{formatTs(latestSnapshot?.captured_at ?? status?.last_portfolio_sync_at)}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-300">Snapshot Date</div>
                <div className="mt-1 text-sm text-white">{latestSnapshot?.snapshot_date ?? status?.last_portfolio_snapshot_date ?? '-'}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-300">Holdings Value</div>
                <div className="mt-1 text-sm text-white">{formatInr(latestSnapshot?.holdings_market_value)}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-300">Unrealized P&amp;L</div>
                <div className="mt-1 text-sm text-white">{formatInr(latestSnapshot?.holdings_pnl)}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-300">Connection</div>
                <div className="mt-1 text-sm text-white">{status?.connected ? 'Connected' : 'Disconnected'}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-300">Threat Model</div>
                <div className="mt-1 text-sm text-white">{analysis ? `${analysis.provider}/${analysis.model}` : 'OpenAI gpt-4o-mini'}</div>
              </div>
            </div>

            {topHoldings.length > 0 && (
              <div className="mt-5">
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-300">Top Holdings by Value</div>
                <div className="mt-3 flex flex-wrap gap-2">
	                  {topHoldings.map((holding) => (
	                    <TradingViewSymbolLink
	                      key={`${holding.exchange}-${holding.tradingsymbol}`}
	                      symbol={holding.tradingsymbol}
	                      market="india"
	                      exchange={holding.exchange}
	                      className="inline-flex items-center rounded-full border border-white/10 bg-white/8 px-3 py-1.5 text-xs text-slate-100 hover:bg-white/12"
	                    >
	                      <span className="font-semibold">{holding.tradingsymbol}</span>
	                      <span className="ml-2 text-slate-300">{formatInr(holding.market_value)}</span>
	                    </TradingViewSymbolLink>
	                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {error && (
        <div className="flex items-start gap-3 rounded-[24px] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!latestSnapshot && (
        <div className="rounded-[28px] border border-slate-200 bg-white px-6 py-8 text-sm text-slate-600 shadow-sm">
          <div className="font-semibold text-slate-900">No synced Zerodha portfolio found yet.</div>
          <p className="mt-2 max-w-2xl leading-7">
            Connect Zerodha and sync at least one snapshot before running the threats workflow. The analysis uses the latest synced holdings as the portfolio source of truth.
          </p>
          <Button asChild className="mt-4 rounded-full">
            <Link href={URLs.routes.console.zerodha()}>
              Go to Zerodha
              <ArrowRight className="ml-2 size-4" />
            </Link>
          </Button>
        </div>
      )}

      {analysis && (
        <section className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-[28px] border border-slate-200 bg-white px-5 py-5 shadow-sm">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              <LineChart className="size-3.5" />
              Latest Analysis
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <div>
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Status</div>
                <div className="mt-1 text-sm font-semibold capitalize text-slate-900">{analysis.status}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Snapshot Used</div>
                <div className="mt-1 text-sm text-slate-900">{analysis.snapshot_date ?? '-'}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Completed / Updated</div>
                <div className="mt-1 text-sm text-slate-900">{formatTs(analysis.updated_at)}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Estimated Cost</div>
                <div className="mt-1 text-sm font-semibold text-slate-900">
                  {hasKnownCost(analysis.estimated_cost)
                    ? formatInrCost(analysis.estimated_cost, usdInrRate)
                    : 'Not captured'}
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-[28px] border border-slate-200 bg-white px-5 py-5 shadow-sm">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              <ShieldAlert className="size-3.5" />
              Severity Pulse
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 text-sm lg:grid-cols-4">
              <div className="rounded-2xl bg-rose-50 px-4 py-3 text-rose-800">
                <div className="text-[11px] uppercase tracking-[0.16em]">Very High</div>
                <div className="mt-1 text-xl font-semibold">{severityCounts.veryHigh}</div>
              </div>
              <div className="rounded-2xl bg-orange-50 px-4 py-3 text-orange-800">
                <div className="text-[11px] uppercase tracking-[0.16em]">High</div>
                <div className="mt-1 text-xl font-semibold">{severityCounts.high}</div>
              </div>
              <div className="rounded-2xl bg-amber-50 px-4 py-3 text-amber-900">
                <div className="text-[11px] uppercase tracking-[0.16em]">Medium</div>
                <div className="mt-1 text-xl font-semibold">{severityCounts.medium}</div>
              </div>
              <div className="rounded-2xl bg-emerald-50 px-4 py-3 text-emerald-800">
                <div className="text-[11px] uppercase tracking-[0.16em]">Low</div>
                <div className="mt-1 text-xl font-semibold">{severityCounts.low}</div>
              </div>
            </div>
          </div>
        </section>
      )}

      {analysis?.error_message && analysis.status === 'failed' && (
        <div className="rounded-[24px] border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-800">
          <div className="font-semibold">Threat scan failed</div>
          <div className="mt-1">{analysis.error_message}</div>
        </div>
      )}

      {displayedAnalysis?.report && (
        <>
          <ThreatsSummaryCards summary={displayedAnalysis.report.summary} />

          {hasUrgentActions && urgentSection && (
            <section className="rounded-[30px] border border-rose-200 bg-linear-to-br from-rose-50 to-white p-1 shadow-sm">
	              <ThreatsReportTable
	                section={urgentSection}
	                market="india"
	                holdingMetrics={holdingMetrics}
	                className="bg-transparent ring-0 shadow-none"
	              />
            </section>
          )}

          {displayedAnalysis.report.tables
	            .filter((section) => section.key !== 'urgent_actionables')
	            .map((section) => (
	              <ThreatsReportTable
	                key={section.key}
	                section={section}
	                market="india"
	                holdingMetrics={holdingMetrics}
	              />
	            ))}

          <section className="rounded-[30px] border border-slate-200 bg-white px-6 py-6 shadow-sm">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Bottom Line</div>
            <div className="mt-4">
              <BottomLineCards items={displayedAnalysis.report.bottom_line} />
            </div>
          </section>

          <details className="rounded-[24px] border border-slate-200 bg-white px-5 py-4 shadow-sm">
            <summary className="cursor-pointer text-sm font-semibold text-slate-900">
              Raw model response
            </summary>
            <div className="mt-4 prose max-w-none prose-slate">
              <MarkdownRenderer content={displayedAnalysis.report.raw_markdown} />
            </div>
          </details>
        </>
      )}

      {!analysis && latestSnapshot && (
        <div className="rounded-[28px] border border-slate-200 bg-white px-6 py-8 text-sm text-slate-600 shadow-sm">
          <div className="font-semibold text-slate-900">No threat scan has been run yet.</div>
          <p className="mt-2 max-w-2xl leading-7">
            Run the Threat Radar to turn your latest synced holdings into a short-term risk map with concentration checks, technical breakdown watchpoints, event risks, scenario analysis, and urgent actionables.
          </p>
        </div>
      )}
    </div>
  );
}
