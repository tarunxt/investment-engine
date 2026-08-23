'use client';

import { useCallback, useEffect, useMemo, useState, type ElementType } from 'react';
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
import { formatApiTimestamp } from '@/lib/datetime';
import {
  getAutoRebalanceRunDisplayLabel,
  getRunDetailPathFromPrompt,
} from '@/lib/runPresentation';
import { cn } from '@/lib/utils';
import { apiService, APIError } from '@/services/api';
import type { BullpenAutoLiveHistoryItem, RunListItem } from '@/types/api';
import { INDIA_TIMEZONE } from '../dashboard/_context';

const STATUS_STYLES: Record<string, string> = {
  scheduled: 'bg-violet-50 text-violet-700 ring-violet-200',
  pending: 'bg-amber-50 text-amber-700 ring-amber-200',
  processing: 'bg-blue-50 text-blue-700 ring-blue-200',
  running: 'bg-blue-50 text-blue-700 ring-blue-200',
  completed: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  partial: 'bg-amber-50 text-amber-700 ring-amber-200',
  partial_success: 'bg-amber-50 text-amber-700 ring-amber-200',
  failed: 'bg-red-50 text-red-700 ring-red-200',
};

const STATUS_ICONS: Record<string, ElementType> = {
  scheduled: CalendarClock,
  pending: Clock3,
  processing: Loader2,
  running: Loader2,
  completed: CheckCircle2,
  partial: AlertCircle,
  partial_success: AlertCircle,
  failed: AlertCircle,
};

const TABS = [
  { id: 'indmoney', label: 'IndMoney Runs' },
  { id: 'zerodha', label: 'Zerodha' },
  { id: 'bullpen', label: 'Bullpen' },
] as const;

type RunTab = (typeof TABS)[number]['id'];
type PortfolioTab = Exclude<RunTab, 'bullpen'>;

const PAGE_SIZE = 20;
const API_PAGE_SIZE = 100;
const BULLPEN_API_PAGE_SIZE = 50;

function normalizeError(error: unknown) {
  if (error instanceof APIError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong';
}

function normalizeStatus(value?: string | null) {
  return (value || 'pending').trim().toLowerCase();
}

function formatTimestamp(value?: string | null) {
  return formatApiTimestamp(value, {
    emptyValue: 'Time unavailable',
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

function getPortfolioTab(run: RunListItem): PortfolioTab | null {
  if (run.auto_rebalance_portfolio === 'indmoney_us') return 'indmoney';
  if (run.auto_rebalance_portfolio === 'india') return 'zerodha';

  const text = [run.auto_rebalance_label, run.prompt_preview]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();

  if (
    text.includes('indmoney') ||
    text.includes('market: us equities') ||
    text.includes('[rebalance_flow:us]') ||
    /\b(?:us|u\.s\.|usa|united states)\b.{0,160}\b(?:equities|stocks|portfolio|swing)\b/i.test(text)
  ) {
    return 'indmoney';
  }

  if (
    text.includes('india run') ||
    text.includes('market: india equities') ||
    text.includes('[rebalance_flow:india]') ||
    /\b(?:india|indian)\b.{0,160}\b(?:equities|stocks|portfolio|swing)\b/i.test(text)
  ) {
    return 'zerodha';
  }

  return null;
}

async function loadAllPortfolioRuns() {
  const first = await apiService.getRuns({
    page: 1,
    limit: API_PAGE_SIZE,
    summary: true,
  });
  if (first.pages <= 1) return first.items;

  const remaining = await Promise.all(
    Array.from({ length: first.pages - 1 }, (_, index) =>
      apiService.getRuns({
        page: index + 2,
        limit: API_PAGE_SIZE,
        summary: true,
      }),
    ),
  );
  return [first, ...remaining].flatMap((response) => response.items);
}

async function loadAllBullpenRuns() {
  const first = await apiService.getBullpenAutoLiveHistory({
    page: 1,
    size: BULLPEN_API_PAGE_SIZE,
  });
  if (!first.has_next) return first.items;

  const remaining = await Promise.all(
    Array.from({ length: Math.max(0, first.pages - 1) }, (_, index) =>
      apiService.getBullpenAutoLiveHistory({
        page: index + 2,
        size: BULLPEN_API_PAGE_SIZE,
      }),
    ),
  );
  return [first, ...remaining].flatMap((response) => response.items);
}

function StatusBadge({ status }: { status?: string | null }) {
  const normalized = normalizeStatus(status);
  const StatusIcon = STATUS_ICONS[normalized] ?? Clock3;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold capitalize ring-1',
        STATUS_STYLES[normalized] ?? 'bg-gray-50 text-gray-700 ring-gray-200',
      )}
    >
      <StatusIcon
        className={cn(
          'size-3.5',
          (normalized === 'processing' || normalized === 'running') && 'animate-spin',
        )}
      />
      {normalized.replaceAll('_', ' ')}
    </span>
  );
}

function PortfolioRunTile({
  run,
  onOpen,
}: {
  run: RunListItem;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full rounded-2xl border border-gray-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-violet-300 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="font-semibold text-gray-950">
            {getAutoRebalanceRunDisplayLabel(run)}
          </h2>
          <p className="mt-1 line-clamp-2 text-sm leading-6 text-gray-600">
            {run.prompt_preview || 'Run details and generated results'}
          </p>
        </div>
        <StatusBadge status={run.status} />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-gray-100 pt-4 text-xs text-gray-500">
        <span>Run #{run.id}</span>
        <span>{formatTimestamp(run.created_at)}</span>
        <span>{run.run_jobs.length} provider job{run.run_jobs.length === 1 ? '' : 's'}</span>
      </div>
    </button>
  );
}

function BullpenRunTile({
  run,
  onOpen,
}: {
  run: BullpenAutoLiveHistoryItem;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full rounded-2xl border border-gray-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-violet-300 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
              {run.triggered_by === 'manual' ? 'Manual Run' : 'Auto Run'}
            </span>
            {run.dry_run ? (
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
                Dry run
              </span>
            ) : null}
          </div>
          <h2 className="mt-3 font-semibold text-gray-950">
            {run.summary || 'Bullpen allocation run'}
          </h2>
          <p className="mt-1 truncate text-sm text-gray-500">Run {run.id}</p>
        </div>
        <StatusBadge status={run.status} />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 border-t border-gray-100 pt-4 text-xs sm:grid-cols-4">
        <span className="rounded-lg bg-gray-50 px-3 py-2 text-gray-600">
          {run.decisions_count} decisions
        </span>
        <span className="rounded-lg bg-gray-50 px-3 py-2 text-gray-600">
          {run.orders_planned} planned
        </span>
        <span className="rounded-lg bg-gray-50 px-3 py-2 text-gray-600">
          {run.orders_submitted} submitted
        </span>
        <span className="rounded-lg bg-gray-50 px-3 py-2 text-gray-600">
          {formatTimestamp(run.started_at)}
        </span>
      </div>
      {run.error_message || run.blocker_preview ? (
        <p className="mt-3 line-clamp-2 text-xs leading-5 text-amber-700">
          {run.error_message || run.blocker_preview}
        </p>
      ) : null}
    </button>
  );
}

export default function RunsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const initialTab = TABS.some((tab) => tab.id === requestedTab)
    ? (requestedTab as RunTab)
    : 'indmoney';

  const [activeTab, setActiveTab] = useState<RunTab>(initialTab);
  const [portfolioRuns, setPortfolioRuns] = useState<RunListItem[]>([]);
  const [bullpenRuns, setBullpenRuns] = useState<BullpenAutoLiveHistoryItem[]>([]);
  const [page, setPage] = useState(() => Math.max(1, Number(searchParams.get('page')) || 1));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const loadRuns = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [portfolioResult, bullpenResult] = await Promise.allSettled([
      loadAllPortfolioRuns(),
      loadAllBullpenRuns(),
    ]);

    const errors: string[] = [];
    if (portfolioResult.status === 'fulfilled') {
      setPortfolioRuns(portfolioResult.value);
    } else {
      errors.push('IndMoney/Zerodha: ' + normalizeError(portfolioResult.reason));
    }

    if (bullpenResult.status === 'fulfilled') {
      setBullpenRuns(bullpenResult.value);
    } else {
      errors.push('Bullpen: ' + normalizeError(bullpenResult.reason));
    }

    setError(errors.length ? errors.join(' ') : null);
    setLastUpdated(new Date());
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  const categorizedRuns = useMemo(
    () => ({
      indmoney: portfolioRuns.filter((run) => getPortfolioTab(run) === 'indmoney'),
      zerodha: portfolioRuns.filter((run) => getPortfolioTab(run) === 'zerodha'),
    }),
    [portfolioRuns],
  );

  const selectedItems =
    activeTab === 'bullpen' ? bullpenRuns : categorizedRuns[activeTab];
  const pages = Math.max(1, Math.ceil(selectedItems.length / PAGE_SIZE));
  const safePage = Math.min(page, pages);
  const visibleItems = selectedItems.slice(
    (safePage - 1) * PAGE_SIZE,
    safePage * PAGE_SIZE,
  );

  function updateLocation(nextTab: RunTab, nextPage: number) {
    const params = new URLSearchParams(searchParams);
    params.set('tab', nextTab);
    if (nextPage > 1) params.set('page', String(nextPage));
    else params.delete('page');
    router.replace('/console/runs?' + params.toString(), { scroll: false });
  }

  function selectTab(tab: RunTab) {
    setActiveTab(tab);
    setPage(1);
    updateLocation(tab, 1);
  }

  function selectPage(nextPage: number) {
    setPage(nextPage);
    updateLocation(activeTab, nextPage);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const from = selectedItems.length === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1;
  const to = Math.min(safePage * PAGE_SIZE, selectedItems.length);

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-gray-950">Run History</h1>
          <p className="mt-1 text-sm text-gray-600">
            {lastUpdated
              ? 'Last updated ' +
                lastUpdated.toLocaleTimeString('en-IN', { timeZone: INDIA_TIMEZONE })
              : 'Loading all runs…'}
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
        className="grid grid-cols-3 gap-1 rounded-xl border border-gray-200 bg-gray-100 p-1"
        role="tablist"
        aria-label="Run categories"
      >
        {TABS.map((tab) => {
          const count =
            tab.id === 'bullpen'
              ? bullpenRuns.length
              : categorizedRuns[tab.id].length;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              onClick={() => selectTab(tab.id)}
              className={cn(
                'rounded-lg px-3 py-3 text-sm font-semibold transition',
                activeTab === tab.id
                  ? 'bg-white text-violet-700 shadow-sm'
                  : 'text-gray-600 hover:bg-white/60 hover:text-gray-950',
              )}
            >
              <span>{tab.label}</span>
              <span className="ml-2 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
                {count}
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

      <div className="space-y-3" role="tabpanel">
        {loading && selectedItems.length === 0 ? (
          <div className="rounded-2xl border border-gray-200 bg-white px-5 py-16 text-center text-sm text-gray-500">
            <Loader2 className="mx-auto mb-3 size-5 animate-spin text-gray-400" />
            Loading all {TABS.find((tab) => tab.id === activeTab)?.label}…
          </div>
        ) : visibleItems.length === 0 ? (
          <div className="rounded-2xl border border-gray-200 bg-white px-5 py-16 text-center text-sm text-gray-500">
            No runs found in this category.
          </div>
        ) : activeTab === 'bullpen' ? (
          (visibleItems as BullpenAutoLiveHistoryItem[]).map((run) => (
            <BullpenRunTile
              key={run.id}
              run={run}
              onOpen={() =>
                router.push('/console/bullpen-ai/runs/' + encodeURIComponent(run.id))
              }
            />
          ))
        ) : (
          (visibleItems as RunListItem[]).map((run) => (
            <PortfolioRunTile
              key={run.id}
              run={run}
              onOpen={() =>
                router.push(getRunDetailPathFromPrompt(run.id, run.prompt_preview))
              }
            />
          ))
        )}
      </div>

      <div className="flex items-center justify-between rounded-xl border border-gray-200 bg-white px-5 py-3 shadow-sm">
        <span className="text-xs text-gray-500">
          {selectedItems.length === 0
            ? 'No results'
            : from + '–' + to + ' of ' + selectedItems.length + ' runs'}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous page"
            onClick={() => selectPage(safePage - 1)}
            disabled={safePage <= 1 || loading}
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
            onClick={() => selectPage(safePage + 1)}
            disabled={safePage >= pages || loading}
            className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:pointer-events-none disabled:opacity-40"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
