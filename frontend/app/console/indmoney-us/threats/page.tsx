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
  ShieldAlert,
} from 'lucide-react';

import { PortfolioAnalysisNav } from '@/components/shared/PortfolioAnalysisNav';
import { EventScanRunControls } from '@/components/shared/EventScanRunControls';
import MarkdownRenderer from '@/components/shared/MarkdownRenderer';
import { ScanHistoryButton } from '@/components/shared/ScanHistoryButton';
import { Button } from '@/components/ui/button';
import { useUsdInrRate } from '@/hooks/useUsdInrRate';
import { URLs } from '@/lib/urls';
import { apiService, APIError } from '@/services/api';
import type {
  IndMoneyUsHolding,
  IndMoneyUsPortfolioOverviewResponse,
  IndMoneyUsThreatAnalysis,
  IndMoneyUsThreatKeyValueItem,
  IndMoneyUsThreatTableSection,
  ProviderModelTarget,
} from '@/types/api';

import { ThreatsReportTable } from '../../zerodha/threats/_components/ThreatsReportTable';
import { ThreatsSummaryCards } from '../../zerodha/threats/_components/ThreatsSummaryCards';

function normalizeError(err: unknown) {
  if (err instanceof APIError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}

function formatTs(iso: string | null | undefined) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function formatUsd(value: number | null | undefined) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 4,
  }).format(value || 0);
}

function formatInrCost(value: number, usdInrRate: number) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(value * usdInrRate);
}

function hasKnownCost(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isJobActive(status: string | null | undefined) {
  return status === 'pending' || status === 'processing' || status === 'scheduled';
}

function findSection(analysis: IndMoneyUsThreatAnalysis | null, key: string) {
  return analysis?.report?.tables.find((section) => section.key === key) ?? null;
}

function countSeverities(tables: IndMoneyUsThreatTableSection[]) {
  const counts = { veryHigh: 0, high: 0, medium: 0, low: 0 };

  for (const table of tables) {
    for (const row of table.rows) {
      for (const [column, value] of Object.entries(row)) {
        if (!/severity|risk|priority/i.test(column)) continue;
        const normalized = value.trim().toLowerCase();
        if (normalized === 'very high') counts.veryHigh += 1;
        if (normalized === 'high') counts.high += 1;
        if (normalized === 'medium') counts.medium += 1;
        if (normalized === 'low') counts.low += 1;
      }
    }
  }

  return counts;
}

function BottomLineCards({ items }: { items: IndMoneyUsThreatKeyValueItem[] }) {
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

export default function IndMoneyUsThreatsPage() {
  const [overview, setOverview] = useState<IndMoneyUsPortfolioOverviewResponse | null>(null);
  const [analysis, setAnalysis] = useState<IndMoneyUsThreatAnalysis | null>(null);
  const [loadingPage, setLoadingPage] = useState(true);
  const [runningAnalysis, setRunningAnalysis] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const usdInrRate = useUsdInrRate();

  const loadOverview = useCallback(async () => {
    const response = await apiService.indmoneyUsPortfolioOverview();
    setOverview(response);
  }, []);

  const loadLatestAnalysis = useCallback(async () => {
    const response = await apiService.indmoneyUsThreatsLatest();
    setAnalysis(response.analysis);
  }, []);

  const loadAnalysisJob = useCallback(async (jobId: number) => {
    const response = await apiService.indmoneyUsThreatJob(jobId);
    setAnalysis(response);
  }, []);

  const loadAnalysisHistory = useCallback(async () => {
    const response = await apiService.indmoneyUsThreatsHistory({ limit: 100 });
    return response.history;
  }, []);

  const handleRunAnalysis = useCallback(async (target: ProviderModelTarget | null) => {
    setRunningAnalysis(true);
    setError(null);
    try {
      const queued = await apiService.indmoneyUsRunThreats(target ?? undefined);
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
        await Promise.all([loadOverview(), loadLatestAnalysis()]);
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
  }, [loadLatestAnalysis, loadOverview]);

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
  const topHoldings = [...(latestSnapshot?.holdings ?? [])]
    .sort((left, right) => (right.current_value ?? 0) - (left.current_value ?? 0))
    .slice(0, 5);
  const severityCounts = countSeverities(analysis?.report?.tables ?? []);
  const urgentSection = findSection(analysis, 'urgent_actionables');
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
        <PortfolioAnalysisNav portfolio="indmoneyUs" active="threats" />
      </div>

      <section className="overflow-hidden rounded-[34px] border border-slate-200 bg-linear-to-br from-slate-950 via-slate-900 to-sky-950 text-white shadow-lg">
        <div className="grid gap-6 px-6 py-7 lg:grid-cols-[1.4fr_0.9fr] lg:px-8">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/8 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-100">
              <Radar className="size-3.5" />
              Threat Radar
            </div>
            <h1 className="mt-4 font-serif text-3xl tracking-tight text-white md:text-4xl">
              Short-term risk intelligence for your pasted INDmoney US book
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-200/90">
              This screen sends your latest pasted INDmoney US snapshot through the selected AI model with live web-search context,
              then turns the response into a trading-focused threats map for the next 1-3 months.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <EventScanRunControls
                onRun={handleRunAnalysis}
                disabled={!latestSnapshot}
                running={runningAnalysis}
                buttonLabel="Run Threat Scan"
                defaultTarget={analysis ? { provider: analysis.provider, model: analysis.model } : undefined}
                buttonClassName="rounded-full bg-sky-300 px-5 text-slate-950 hover:bg-sky-200"
              />
              <ScanHistoryButton
                title="Threat scan history"
                emptyMessage="No threat scans have been run yet."
                loadHistory={loadAnalysisHistory}
                usdInrRate={usdInrRate}
              />
              <Button asChild variant="ghost" className="rounded-full text-sky-100 hover:bg-white/10 hover:text-white">
                <Link href={URLs.routes.console.indmoneyUs()}>
                  Open Portfolio
                  <ArrowRight className="ml-2 size-4" />
                </Link>
              </Button>
            </div>
          </div>

          <div className="rounded-[28px] border border-white/10 bg-white/8 p-5 backdrop-blur">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-100">
              <Clock3 className="size-3.5" />
              Current Snapshot
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-300">Latest Paste</div>
                <div className="mt-1 text-sm text-white">{formatTs(latestSnapshot?.captured_at)}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-300">Snapshot Date</div>
                <div className="mt-1 text-sm text-white">{latestSnapshot?.snapshot_date ?? '-'}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-300">Current Value</div>
                <div className="mt-1 text-sm text-white">{formatUsd(latestSnapshot?.current_value)}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-300">Total Return</div>
                <div className="mt-1 text-sm text-white">{formatUsd(latestSnapshot?.total_return_value)}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-300">Parse Status</div>
                <div className="mt-1 text-sm capitalize text-white">{latestSnapshot?.parse_status ?? 'missing'}</div>
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
                  {topHoldings.map((holding: IndMoneyUsHolding) => (
                    <div
                      key={holding.symbol}
                      className="rounded-full border border-white/10 bg-white/8 px-3 py-1.5 text-xs text-slate-100"
                    >
                      <span className="font-semibold">{holding.symbol}</span>
                      <span className="ml-2 text-slate-300">{formatUsd(holding.current_value)}</span>
                    </div>
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
          <div className="font-semibold text-slate-900">No INDmoney US snapshot found yet.</div>
          <p className="mt-2 max-w-2xl leading-7">
            Paste at least one INDmoney snapshot before running the threats workflow. The analysis uses the latest
            pasted holdings as the portfolio source of truth.
          </p>
          <Button asChild className="mt-4 rounded-full">
            <Link href={URLs.routes.console.indmoneyUs()}>
              Go to INDmoney US
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
                {hasKnownCost(analysis.estimated_cost) ? (
                  <div className="text-xs text-slate-500">{formatUsd(analysis.estimated_cost)}</div>
                ) : null}
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

      {analysis?.report && (
        <>
          <ThreatsSummaryCards summary={analysis.report.summary} />

          {hasUrgentActions && urgentSection && (
            <section className="rounded-[30px] border border-rose-200 bg-linear-to-br from-rose-50 to-white p-1 shadow-sm">
              <ThreatsReportTable section={urgentSection} className="bg-transparent ring-0 shadow-none" />
            </section>
          )}

          {analysis.report.tables
            .filter((section) => section.key !== 'urgent_actionables')
            .map((section) => (
              <ThreatsReportTable key={section.key} section={section} />
            ))}

          <section className="rounded-[30px] border border-slate-200 bg-white px-6 py-6 shadow-sm">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Bottom Line</div>
            <div className="mt-4">
              <BottomLineCards items={analysis.report.bottom_line} />
            </div>
          </section>

          <details className="rounded-[24px] border border-slate-200 bg-white px-5 py-4 shadow-sm">
            <summary className="cursor-pointer text-sm font-semibold text-slate-900">
              Raw model response
            </summary>
            <div className="mt-4 prose max-w-none prose-slate">
              <MarkdownRenderer content={analysis.report.raw_markdown} />
            </div>
          </details>
        </>
      )}

      {!analysis && latestSnapshot && (
        <div className="rounded-[28px] border border-slate-200 bg-white px-6 py-8 text-sm text-slate-600 shadow-sm">
          <div className="font-semibold text-slate-900">No threat scan has been run yet.</div>
          <p className="mt-2 max-w-2xl leading-7">
            Run the Threat Radar to turn your latest pasted holdings into a short-term risk map with concentration
            checks, technical breakdown watchpoints, event risks, scenario analysis, and urgent actionables.
          </p>
        </div>
      )}
    </div>
  );
}
