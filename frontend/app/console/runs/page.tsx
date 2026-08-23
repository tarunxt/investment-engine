'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ElementType,
} from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Loader2,
  RefreshCw,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { apiService, APIError } from '@/services/api';
import type { BullpenAutoLiveRun, RunListItem } from '@/types/api';
import { formatApiTimestamp } from '@/lib/datetime';
import { cn } from '@/lib/utils';
import { URLs } from '@/lib/urls';
import { getAutoRebalanceRunDisplayLabel } from '@/lib/runPresentation';
import { WSClient } from '@/services/websocket';
import { INDIA_TIMEZONE } from '../dashboard/_context';

const STATUS_STYLES: Record<string, string> = {
  scheduled: 'bg-violet-50 text-violet-700 ring-violet-200',
  pending: 'bg-amber-50 text-amber-700 ring-amber-200',
  processing: 'bg-blue-50 text-blue-700 ring-blue-200',
  running: 'bg-blue-50 text-blue-700 ring-blue-200',
  confirming: 'bg-sky-50 text-sky-700 ring-sky-200',
  completed: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  partial_success: 'bg-amber-50 text-amber-700 ring-amber-200',
  failed: 'bg-red-50 text-red-700 ring-red-200',
  skipped: 'bg-gray-50 text-gray-700 ring-gray-200',
};

const STATUS_ICONS: Record<string, ElementType> = {
  scheduled: CalendarClock,
  pending: Clock3,
  processing: Loader2,
  running: Loader2,
  confirming: Loader2,
  completed: CheckCircle2,
  partial_success: AlertCircle,
  failed: AlertCircle,
  skipped: Clock3,
};

type RunTab = 'indmoney' | 'zerodha' | 'bullpen';

const PAGE_SIZE = 20;
const API_PAGE_SIZE = 100;

const TABS: Array<{ id: RunTab; label: string }> = [
  { id: 'indmoney', label: 'IndMoney Runs' },
  { id: 'zerodha', label: 'Zerodha Runs' },
  { id: 'bullpen', label: 'Bullpen Runs' },
];

function normalizeError(error: unknown) {
  if (error instanceof APIError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong';
}

function normalizeTab(value: string | null): RunTab {
  if (value === 'zerodha' || value === 'bullpen') return value;
  return 'indmoney';
}

function getRunTab(run: RunListItem): Exclude<RunTab, 'bullpen'> | null {
  if (run.auto_rebalance_portfolio === 'indmoney_us') return 'indmoney';
  if (run.auto_rebalance_portfolio === 'india') return 'zerodha';

  const linkedPortfolio = run.run_jobs.find(
    ({ job }) => job.auto_rebalance_portfolio,
  )?.job.auto_rebalance_portfolio;
  if (linkedPortfolio === 'indmoney_us') return 'indmoney';
  if (linkedPortfolio === 'india') return 'zerodha';

  const prompt = run.prompt_preview.toLowerCase();
  if (
    prompt.includes('indmoney') ||
    prompt.includes('market: us equities') ||
    prompt.includes('[rebalance_flow:us]')
  ) {
    return 'indmoney';
  }
  if (
    prompt.includes('zerodha') ||
    prompt.includes('market: india equities') ||
    prompt.includes('[rebalance_flow:india]')
  ) {
    return 'zerodha';
  }
  return null;
}

function formatTimestamp(value?: string | null) {
  return formatApiTimestamp(value, {
    emptyValue: null,
    timeZone: INDIA_TIMEZONE,
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function humanize(value: string) {
  return value
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function getRunDetailPath(run: RunListItem, tab: Exclude<RunTab, 'bullpen'>) {
  return tab === 'indmoney'
    ? `/console/indmoney-us-swing-run/${run.id}`
    : `/console/zerodha-swing-run/${run.id}`;
}

export default function RunsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState<RunTab>(() =>
    normalizeTab(searchParams.get('tab')),
  );
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [bullpenRuns, setBullpenRuns] = useState<BullpenAutoLiveRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [page, setPage] = useState(() => Number(searchParams.get('page')) || 1);
  const [wsConnected, setWsConnected] = useState(false);

  const wsClientRef = useRef<WSClient | null>(null);
  const loadRunsRef = useRef<(options?: { silent?: boolean }) => Promise<void>>(
    async () => {},
  );

  const updateURLParams = useCallback(
    (tab: RunTab, nextPage: number) => {
      const params = new URLSearchParams(searchParams);
      if (tab === 'indmoney') params.delete('tab');
      else params.set('tab', tab);
      if (nextPage === 1) params.delete('page');
      else params.set('page', String(nextPage));
      const query = params.toString();
      router.replace(query ? `/console/runs?${query}` : '/console/runs', {
        scroll: false,
      });
    },
    [router, searchParams],
  );

  const loadRuns = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!silent) setLoading(true);
    try {
      const firstPage = await apiService.getRuns({
        page: 1,
        limit: API_PAGE_SIZE,
        summary: true,
      });
      const remainingPages = Array.from(
        { length: Math.max(0, firstPage.pages - 1) },
        (_, index) => index + 2,
      );
      const remainingResults = await Promise.all(
        remainingPages.map((nextPage) =>
          apiService.getRuns({
            page: nextPage,
            limit: API_PAGE_SIZE,
            summary: true,
          }),
        ),
      );
      const allRuns = [
        ...firstPage.items,
        ...remainingResults.flatMap((result) => result.items),
      ];

      const latestBullpenRuns = await apiService.getBullpenAutoLiveRuns(
        { timeoutMs: 15_000 },
        false,
      );

      setRuns(allRuns);
      setBullpenRuns(
        [...latestBullpenRuns].sort(
          (left, right) =>
            Date.parse(right.started_at) - Date.parse(left.started_at),
        ),
      );
      setLastUpdated(new Date());
      setError(null);
    } catch (loadError) {
      setError(normalizeError(loadError));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useLayoutEffect(() => {
    loadRunsRef.current = loadRuns;
  }, [loadRuns]);

  useEffect(() => {
    void loadRuns();

    const client = new WSClient({
      url: URLs.runs.ws(),
      onMessage: (data) => {
        if (data.type !== 'run.updated') return;
        const { run_id, ...patch } = data as {
          type: string;
          run_id: number;
          [key: string]: unknown;
        };
        setRuns((currentRuns) => {
          if (!currentRuns.some((run) => run.id === run_id)) {
            window.setTimeout(() => void loadRunsRef.current({ silent: true }), 0);
            return currentRuns;
          }
          return currentRuns.map((run) =>
            run.id === run_id ? { ...run, ...patch } : run,
          );
        });
        setLastUpdated(new Date());
      },
      onStatusChange: setWsConnected,
    });
    wsClientRef.current = client;
    client.connect();

    return () => {
      wsClientRef.current?.close();
      wsClientRef.current = null;
    };
  }, [loadRuns]);

  useEffect(() => {
    const hasActiveRun =
      runs.some((run) =>
        ['scheduled', 'pending', 'processing'].includes(
          run.status.toLowerCase(),
        ),
      ) ||
      bullpenRuns.some((run) =>
        ['running', 'confirming'].includes(run.status.toLowerCase()),
      );
    if (!hasActiveRun) return;

    const timer = window.setInterval(
      () => void loadRunsRef.current({ silent: true }),
      10_000,
    );
    return () => window.clearInterval(timer);
  }, [bullpenRuns, runs]);

  const filteredRuns = useMemo(
    () =>
      activeTab === 'bullpen'
        ? []
        : runs.filter((run) => getRunTab(run) === activeTab),
    [activeTab, runs],
  );

  const total = activeTab === 'bullpen' ? bullpenRuns.length : filteredRuns.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, pages);
  const start = (safePage - 1) * PAGE_SIZE;
  const visibleRuns = filteredRuns.slice(start, start + PAGE_SIZE);
  const visibleBullpenRuns = bullpenRuns.slice(start, start + PAGE_SIZE);
  const from = total === 0 ? 0 : start + 1;
  const to = Math.min(start + PAGE_SIZE, total);

  function handleTabChange(tab: RunTab) {
    setActiveTab(tab);
    setPage(1);
    updateURLParams(tab, 1);
  }

  function handlePageChange(nextPage: number) {
    const boundedPage = Math.min(Math.max(nextPage, 1), pages);
    setPage(boundedPage);
    updateURLParams(activeTab, boundedPage);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-gray-950">
            Run History
          </h1>
          <p className="mt-1 text-sm text-gray-600">
            {lastUpdated
              ? `Last updated ${lastUpdated.toLocaleTimeString('en-IN', {
                  timeZone: INDIA_TIMEZONE,
                })}`
              : 'Loading…'}
            {wsConnected ? (
              <span className="ml-3 inline-flex items-center gap-1 text-emerald-600">
                <span className="inline-block size-1.5 rounded-full bg-emerald-500" />
                Live
              </span>
            ) : null}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => void loadRuns()}
          disabled={loading}
          className="w-full sm:w-auto"
        >
          <RefreshCw className={cn('mr-2 size-4', loading && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      <div
        className="flex overflow-x-auto border-b border-gray-200"
        role="tablist"
        aria-label="Run portfolio"
      >
        {TABS.map((tab) => {
          const tabCount =
            tab.id === 'bullpen'
              ? bullpenRuns.length
              : runs.filter((run) => getRunTab(run) === tab.id).length;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              onClick={() => handleTabChange(tab.id)}
              className={cn(
                'flex min-w-fit items-center gap-2 border-b-2 px-5 py-3 text-sm font-semibold transition-colors',
                activeTab === tab.id
                  ? 'border-violet-600 text-violet-700'
                  : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-900',
              )}
            >
              {tab.label}
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-xs',
                  activeTab === tab.id
                    ? 'bg-violet-100 text-violet-700'
                    : 'bg-gray-100 text-gray-600',
                )}
              >
                {tabCount}
              </span>
            </button>
          );
        })}
      </div>

      {error ? (
        <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="grid gap-4">
        {loading ? (
          <div className="rounded-2xl border border-gray-200 bg-white px-5 py-14 text-center text-sm text-gray-500 shadow-sm">
            <Loader2 className="mx-auto mb-2 size-5 animate-spin text-gray-400" />
            Loading runs…
          </div>
        ) : total === 0 ? (
          <div className="rounded-2xl border border-gray-200 bg-white px-5 py-14 text-center text-sm text-gray-500 shadow-sm">
            No runs found in this portfolio.
          </div>
        ) : activeTab === 'bullpen' ? (
          visibleBullpenRuns.map((run) => {
            const status = run.status.toLowerCase();
            const StatusIcon = STATUS_ICONS[status] ?? Clock3;
            return (
              <button
                key={run.id}
                type="button"
                onClick={() =>
                  router.push(`/console/bullpen-ai/runs/${encodeURIComponent(run.id)}`)
                }
                className="w-full rounded-2xl border border-gray-200 bg-white p-5 text-left shadow-sm transition hover:border-violet-300 hover:bg-violet-50/30 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
                      {humanize(run.triggered_by)} Run
                    </span>
                    <span
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ring-1',
                        STATUS_STYLES[status] ??
                          'bg-gray-50 text-gray-700 ring-gray-200',
                      )}
                    >
                      <StatusIcon
                        className={cn(
                          'size-3.5',
                          ['running', 'confirming'].includes(status) &&
                            'animate-spin',
                        )}
                      />
                      {humanize(run.status)}
                    </span>
                  </div>
                  <span className="text-sm font-semibold text-gray-700">
                    {formatTimestamp(run.started_at)}
                  </span>
                </div>
                <div className="mt-4 text-base font-semibold leading-6 text-gray-950">
                  {run.summary || 'Bullpen run'}
                </div>
                <div className="mt-1 break-all text-sm text-gray-500">
                  Run {run.id}
                </div>
                {run.stage_results.length > 0 ? (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {run.stage_results.map((stage) => (
                      <span
                        key={`${stage.stage_number}-${stage.stage_name}`}
                        className={cn(
                          'rounded-full border px-3 py-1 text-xs font-semibold',
                          stage.status === 'pass'
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                            : stage.status === 'warning'
                              ? 'border-amber-200 bg-amber-50 text-amber-700'
                              : stage.status === 'fail'
                                ? 'border-red-200 bg-red-50 text-red-700'
                                : 'border-gray-200 bg-gray-50 text-gray-600',
                        )}
                      >
                        {stage.stage_name}: {stage.status}
                      </span>
                    ))}
                  </div>
                ) : null}
              </button>
            );
          })
        ) : (
          visibleRuns.map((run) => {
            const status = run.status.toLowerCase();
            const StatusIcon = STATUS_ICONS[status] ?? Clock3;
            return (
              <button
                key={run.id}
                type="button"
                onClick={() => router.push(getRunDetailPath(run, activeTab))}
                className="w-full rounded-2xl border border-gray-200 bg-white p-5 text-left shadow-sm transition hover:border-violet-300 hover:bg-violet-50/30 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="text-base font-semibold text-gray-950">
                      {getAutoRebalanceRunDisplayLabel(run)}
                    </div>
                    <div className="mt-2 line-clamp-3 text-sm leading-6 text-gray-600">
                      {run.prompt_preview}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
                    <span
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ring-1',
                        STATUS_STYLES[status] ??
                          'bg-gray-50 text-gray-700 ring-gray-200',
                      )}
                    >
                      <StatusIcon
                        className={cn(
                          'size-3.5',
                          status === 'processing' && 'animate-spin',
                        )}
                      />
                      {humanize(run.status)}
                    </span>
                    <span className="text-sm text-gray-600">
                      {formatTimestamp(run.created_at)}
                    </span>
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>

      {!loading && total > 0 ? (
        <div className="flex items-center justify-between rounded-xl border border-gray-200 bg-white px-5 py-3 shadow-sm">
          <span className="text-xs text-gray-500">
            {from}–{to} of {total} run{total !== 1 ? 's' : ''}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Previous page"
              onClick={() => handlePageChange(safePage - 1)}
              disabled={safePage <= 1}
              className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:pointer-events-none disabled:opacity-40"
            >
              <ChevronLeft className="size-4" />
            </button>
            <span className="min-w-16 text-center text-xs text-gray-600">
              {safePage} / {pages}
            </span>
            <button
              type="button"
              aria-label="Next page"
              onClick={() => handlePageChange(safePage + 1)}
              disabled={safePage >= pages}
              className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:pointer-events-none disabled:opacity-40"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
