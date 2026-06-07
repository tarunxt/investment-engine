'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { History, Loader2, RefreshCw, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { APIError } from '@/services/api';

type ScanHistoryItem = {
  job_id: number;
  run_id?: number | null;
  status: string;
  provider: string;
  model: string;
  created_at: string;
  updated_at: string;
  snapshot_date?: string | null;
  estimated_cost?: number | null;
  error_message?: string | null;
};

interface ScanHistoryButtonProps {
  buttonClassName?: string;
  emptyMessage: string;
  loadHistory: () => Promise<ScanHistoryItem[]>;
  title: string;
  usdInrRate: number;
}

function normalizeError(err: unknown) {
  if (err instanceof APIError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Unable to load scan history right now.';
}

function parseTimestampMs(value: string | null | undefined) {
  if (!value) return 0;
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const parsed = /[zZ]|[+-]\d{2}:\d{2}$/.test(normalized)
    ? new Date(normalized)
    : new Date(`${normalized}Z`);
  const ms = parsed.getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function formatTs(iso: string | null | undefined) {
  if (!iso) return '-';
  const ms = parseTimestampMs(iso);
  if (!ms) return iso;
  return new Date(ms).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function formatProviderModel(provider: string, model: string) {
  return `${provider}/${model}`;
}

function formatStatus(status: string) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function formatKnownCost(costUsd: number, usdInrRate: number) {
  return `₹${(costUsd * usdInrRate).toFixed(2)}`;
}

function hasKnownCost(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isActiveStatus(status: string) {
  return ['pending', 'processing', 'scheduled'].includes(status);
}

function statusBadgeClassName(status: string) {
  switch (status) {
    case 'completed':
      return 'bg-emerald-50 text-emerald-700 ring-emerald-200';
    case 'failed':
      return 'bg-red-50 text-red-700 ring-red-200';
    case 'processing':
      return 'bg-amber-50 text-amber-700 ring-amber-200';
    default:
      return 'bg-slate-100 text-slate-600 ring-slate-200';
  }
}

export function ScanHistoryButton({
  buttonClassName,
  emptyMessage,
  loadHistory,
  title,
  usdInrRate,
}: ScanHistoryButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<ScanHistoryItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refreshHistory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextHistory = await loadHistory();
      setHistory(nextHistory);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoading(false);
    }
  }, [loadHistory]);

  const handleOpen = useCallback(() => {
    setOpen(true);
    void refreshHistory();
  }, [refreshHistory]);

  useEffect(() => {
    if (!open) return;

    const hasActiveRun = history.some((item) => isActiveStatus(item.status));
    if (!hasActiveRun) return;

    const interval = window.setInterval(() => {
      void refreshHistory();
    }, 5000);

    return () => window.clearInterval(interval);
  }, [history, open, refreshHistory]);

  useEffect(() => {
    if (!open) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleEscape);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  const totalKnownCostInr = useMemo(
    () => history.reduce((total, item) => total + ((item.estimated_cost ?? 0) * usdInrRate), 0),
    [history, usdInrRate],
  );

  const handleOpenDetails = useCallback(
    (item: ScanHistoryItem) => {
      setOpen(false);
      router.push(item.run_id ? `/console/runs/${item.run_id}` : `/console/jobs/${item.job_id}`);
    },
    [router],
  );

  return (
    <>
      <button
        type="button"
        title={title}
        aria-label={title}
        onClick={handleOpen}
        className={cn(
          'flex h-11 w-11 items-center justify-center rounded-full border border-white/15 bg-white/8 text-white transition hover:bg-white/14 focus:outline-none focus:ring-2 focus:ring-white/20',
          buttonClassName,
        )}
      >
        <History className="size-4" />
      </button>

      {open && typeof document !== 'undefined'
        ? createPortal(
          <div
            className="fixed inset-0 z-[120] flex items-start justify-end bg-slate-950/40 p-4 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-label={title}
              className="flex max-h-[calc(100vh-2rem)] w-full max-w-md flex-col overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-[0_28px_90px_-32px_rgba(15,23,42,0.55)]"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
                <div>
                  <div className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-900">
                    {title}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <div className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                      {history.length} runs
                    </div>
                    <div className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
                      Total known cost: ₹{totalKnownCostInr.toFixed(2)}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 rounded-full text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                    onClick={() => void refreshHistory()}
                    disabled={loading}
                  >
                    {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 rounded-full text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                    onClick={() => setOpen(false)}
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                {error ? (
                  <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    {error}
                  </div>
                ) : null}

                {loading && history.length === 0 ? (
                  <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm text-slate-600">
                    <Loader2 className="size-4 animate-spin" />
                    Loading scan history...
                  </div>
                ) : null}

                {!loading && history.length === 0 && !error ? (
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm text-slate-600">
                    {emptyMessage}
                  </div>
                ) : null}

                {history.length > 0 ? (
                  <div className="space-y-3">
                    {history.map((item) => (
                      <button
                        key={item.job_id}
                        type="button"
                        onClick={() => handleOpenDetails(item)}
                        aria-label={`Open details for ${item.run_id ? `run #${item.run_id}` : `job #${item.job_id}`}`}
                        className="w-full rounded-[22px] border border-slate-200 bg-white px-4 py-4 text-left shadow-sm transition hover:border-blue-200 hover:bg-blue-50/35 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <div className="text-sm font-semibold text-slate-900">
                              {formatProviderModel(item.provider, item.model)}
                            </div>
                            <div className="mt-1 text-xs text-slate-500">
                              Ran {formatTs(item.created_at)}
                            </div>
                            <div className="mt-1 text-xs text-slate-500">
                              Updated {formatTs(item.updated_at)}
                            </div>
                          </div>

                          <div className="text-right">
                            <div
                              className={cn(
                                'inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] ring-1 ring-inset',
                                statusBadgeClassName(item.status),
                              )}
                            >
                              {formatStatus(item.status)}
                            </div>
                            <div className="mt-3 text-sm font-semibold text-slate-900">
                              {hasKnownCost(item.estimated_cost)
                                ? formatKnownCost(item.estimated_cost, usdInrRate)
                                : item.status === 'pending' || item.status === 'processing' || item.status === 'scheduled'
                                  ? 'Pending'
                                  : 'Not captured'}
                            </div>
                          </div>
                        </div>

                        <div className="mt-4 flex flex-wrap items-center gap-2">
                          <div className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">
                            Job #{item.job_id}
                          </div>
                          {item.snapshot_date ? (
                            <div className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">
                              Snapshot {item.snapshot_date}
                            </div>
                          ) : null}
                        </div>

                        {item.error_message ? (
                          <div className="mt-3 rounded-2xl bg-red-50 px-3 py-2 text-xs leading-5 text-red-700">
                            {item.error_message}
                          </div>
                        ) : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          </div>,
          document.body,
        )
        : null}
    </>
  );
}
