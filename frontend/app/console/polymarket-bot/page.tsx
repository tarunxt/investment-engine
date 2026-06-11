'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw, ShieldAlert } from 'lucide-react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { apiService, APIError } from '@/services/api';
import type {
  PolymarketBotState,
  PolymarketDiscoveryDebugReport,
} from '@/types/api';

import { MetricGrid, type MetricItem } from './_components/MetricGrid';
import { PendingConfirmationsTable } from './_components/PendingConfirmationsTable';
import { ManualWalletsTable, TrackedTradersTable } from './_components/TraderTables';

function normalizeError(error: unknown) {
  if (error instanceof APIError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong';
}

function formatTs(iso?: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function formatCountdown(iso?: string | null) {
  if (!iso) return '0s';
  const diff = Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 1000));
  return `${diff}s`;
}

function formatRuntime(from?: string | null, to?: string | null) {
  if (!from) return '—';
  const endTime = to ? new Date(to).getTime() : Date.now();
  const diff = Math.max(0, Math.floor((endTime - new Date(from).getTime()) / 1000));
  const hours = Math.floor(diff / 3600);
  const minutes = Math.floor((diff % 3600) / 60);
  const seconds = diff % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatMoney(value: number, digits = 2) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: digits,
  }).format(value || 0);
}

export default function PolymarketBotPage() {
  const [state, setState] = useState<PolymarketBotState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [busyTradeId, setBusyTradeId] = useState<string | null>(null);
  const [showAllPending, setShowAllPending] = useState(false);
  const [debugTarget, setDebugTarget] = useState('swisstony');
  const [debugReport, setDebugReport] = useState<PolymarketDiscoveryDebugReport | null>(null);
  const [debugLoading, setDebugLoading] = useState(false);
  const lastMutationAt = useRef(0);
  const actionInFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const requestedAt = Date.now();
      try {
        const nextState = await apiService.polymarketState();
        if (cancelled || actionInFlight.current || requestedAt < lastMutationAt.current) return;
        setState(nextState);
        setError(null);
      } catch (loadError) {
        if (cancelled) return;
        setError(normalizeError(loadError));
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();

    const interval = window.setInterval(() => {
      void load();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  async function runAction(label: string, action: () => Promise<PolymarketBotState>) {
    actionInFlight.current = true;
    lastMutationAt.current = Date.now();
    setPendingAction(label);
    setActionError(null);
    try {
      const nextState = await action();
      lastMutationAt.current = Date.now();
      setState(nextState);
    } catch (runError) {
      setActionError(normalizeError(runError));
    } finally {
      actionInFlight.current = false;
      setPendingAction(null);
    }
  }

  async function runTradeAction(tradeId: string, kind: 'confirm' | 'reject') {
    actionInFlight.current = true;
    lastMutationAt.current = Date.now();
    setBusyTradeId(tradeId);
    setActionError(null);
    try {
      const nextState =
        kind === 'confirm'
          ? await apiService.polymarketLiveTradeConfirm(tradeId)
          : await apiService.polymarketLiveTradeReject(tradeId);
      lastMutationAt.current = Date.now();
      setState(nextState);
    } catch (tradeError) {
      setActionError(normalizeError(tradeError));
    } finally {
      actionInFlight.current = false;
      setBusyTradeId(null);
    }
  }

  async function rejectVisible() {
    if (!state) return;
    const visible = state.live.pending_confirmations.slice(0, showAllPending ? undefined : 25);
    for (const trade of visible) {
      await runTradeAction(trade.id, 'reject');
    }
  }

  async function runDiscoveryDebug() {
    setDebugLoading(true);
    setActionError(null);
    try {
      const report = await apiService.polymarketDiscoveryDebug({ target: debugTarget.trim() || 'swisstony' });
      setDebugReport(report);
    } catch (debugError) {
      setActionError(normalizeError(debugError));
    } finally {
      setDebugLoading(false);
    }
  }

  if (loading && !state) {
    return (
      <div className="flex items-center gap-3 text-sm text-slate-500">
        <Loader2 className="size-4 animate-spin" />
        Loading Polymarket Copy Bot…
      </div>
    );
  }

  if (!state) {
    return (
      <div className="rounded-[24px] border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-800">
        {error || 'Unable to load Polymarket bot state.'}
      </div>
    );
  }

  const subtitle = `${state.running ? 'Running' : 'Stopped'} | ${state.paused ? 'Paused' : 'Active'} | ${state.mode} | Bullpen real-money trading`;
  const visiblePending = state.live.pending_confirmations.slice(0, showAllPending ? undefined : 25);
  const confirmDisabled = !state.live.unlocked || state.live.emergency_stopped;
  const manualInvalid = state.live.source_status.manual_wallets_invalid;

  const botStatusItems: MetricItem[] = [
    { label: 'Bot Status', value: state.running ? 'RUNNING' : 'STOPPED', tone: state.running ? 'positive' : 'negative' },
    { label: 'Mode', value: state.mode },
    { label: 'Execution Mode', value: state.config.paper_trading ? 'Sandbox mode active' : 'Real money via Bullpen', tone: state.config.paper_trading ? 'warning' : 'positive' },
    { label: 'Last Poll Time', value: formatTs(state.last_poll_at) },
    { label: 'Next Poll Countdown', value: `${state.seconds_until_next_poll}s` },
    {
      label: 'Session Runtime',
      value:
        state.running || state.started_at
          ? formatRuntime(state.session_started_at, state.running ? null : state.stopped_at)
          : '—',
    },
    {
      label: 'Bot Runtime',
      value: formatRuntime(state.started_at, state.running ? null : state.stopped_at),
    },
    { label: 'Poll Interval', value: `${Math.round(state.config.poll_interval_ms / 1000)}s` },
    { label: 'Tracked Traders Count', value: state.tracked_traders.length },
    {
      label: 'Open Positions Count',
      value: state.open_positions.length,
      onClick: () => document.getElementById('open-positions')?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      helper: 'Click to view open positions.',
    },
  ];

  const liveControlItems: MetricItem[] = [
    {
      label: 'Doctor Status',
      value: state.live.doctor.ok ? 'Passed' : 'Failed',
      helper: state.live.doctor.message,
      tone: state.live.doctor.ok ? 'positive' : 'negative',
    },
    {
      label: 'Live Mode',
      value: state.live.unlocked ? `Unlocked (${state.live.unlock_mode})` : 'Locked',
      helper: state.live.locked_reason || null,
      tone: state.live.unlocked ? 'positive' : 'negative',
    },
    { label: 'Max Live Trade Size', value: formatMoney(state.live.max_live_trade_size) },
    { label: 'Live Trades Today', value: state.live.live_trades_today },
    { label: 'Pending Confirmations', value: state.live.pending_confirmations.length },
    { label: 'Max Pending Confirmations', value: state.config.max_pending_confirmations },
    { label: 'Last Doctor Refresh', value: formatTs(state.live.doctor.checked_at) },
    { label: 'Bullpen Available Balance', value: state.live.balance.message, tone: state.live.balance.status === 'ready' ? 'positive' : 'default' },
    { label: 'Last Balance Refresh', value: formatTs(state.live.balance.checked_at) },
    { label: 'Next Balance Refresh', value: formatCountdown(state.live.balance.next_refresh_at) },
    { label: 'Balance Refresh Status', value: state.live.balance.status.toUpperCase() },
    {
      label: 'Live Locked Status',
      value: state.live.unlocked ? 'UNLOCKED' : 'LOCKED',
      helper: state.live.emergency_stopped ? 'Emergency stop active.' : state.live.locked_reason,
      tone: state.live.unlocked ? 'positive' : 'negative',
    },
  ];

  const discoveryItems: MetricItem[] = [
    { label: 'Discovery Mode', value: state.live.source_status.discovery_mode },
    { label: 'Candidate Rows Considered', value: state.live.source_status.candidate_rows_considered },
    { label: 'Candidate Wallets Extracted', value: state.live.source_status.candidate_wallets_extracted },
    { label: 'Active Traders Found', value: state.live.source_status.active_traders_found },
    { label: 'Fallback Traders Selected', value: state.live.source_status.fallback_traders_selected },
    { label: 'Activity Source Used', value: state.live.source_status.activity_source_used || '—' },
    { label: 'Rows Rejected Last Discovery', value: state.live.source_status.rows_rejected_last_discovery },
    { label: 'Accepted Activity Trades', value: state.live.source_status.accepted_activity_trades_last_discovery },
    { label: 'Manual Wallets Configured', value: state.live.source_status.manual_wallets_configured },
    { label: 'Manual Wallets Valid', value: state.live.source_status.manual_wallets_valid },
    { label: 'Manual Wallets Invalid', value: manualInvalid.length },
    { label: 'Last Discovery Time', value: formatTs(state.live.source_status.last_active_trader_discovery_time) },
    { label: 'Last Discovery Error', value: state.live.source_status.last_discovery_error || '—' },
    { label: 'Tracked Traders Selected', value: state.tracked_traders.length },
  ];

  const liveSourceItems: MetricItem[] = [
    { label: 'Source Mode', value: state.live.source_status.source_mode },
    { label: 'Discovery Mode', value: state.live.source_status.discovery_mode },
    { label: 'Active Traders Found', value: state.live.source_status.active_traders_found },
    { label: 'Live-Read Traders Count', value: state.live.source_status.live_read_traders_count },
    { label: 'Manual Wallets Configured', value: state.live.source_status.manual_wallets_configured },
    { label: 'Manual Wallets Valid', value: state.live.source_status.manual_wallets_valid },
    { label: 'Manual Wallets Invalid', value: state.live.source_status.manual_wallets_invalid.length },
    { label: 'Last Poll Time', value: formatTs(state.live.source_status.last_poll_time) },
    { label: 'Last Active Trader Discovery', value: formatTs(state.live.source_status.last_active_trader_discovery_time) },
    { label: 'Live Baseline Completed At', value: formatTs(state.live.source_status.live_baseline_completed_at) },
    { label: 'Seen Live Trades Baseline Count', value: state.live.source_status.seen_live_trades_baseline_count },
    { label: 'Source Trades Found Last Poll', value: state.live.source_status.source_trades_found_last_poll },
    { label: 'Source Trades After Filters', value: state.live.source_status.source_trades_after_filters_last_poll },
    { label: 'New Live Proposals Created', value: state.live.source_status.new_live_proposals_created_last_poll },
    { label: 'Skipped By Filters', value: state.live.source_status.skipped_by_filters_last_poll },
    { label: 'Skipped By Limits', value: state.live.source_status.skipped_by_limits_last_poll },
    { label: 'Skipped Duplicates', value: state.live.source_status.skipped_duplicates_last_poll },
    { label: 'Last Live-Read Error', value: state.live.source_status.last_live_read_error || '—' },
    {
      label: 'Trending Market Activity',
      value: state.live.source_status.trending_market_activity_enabled ? 'Enabled' : 'Disabled',
      helper: state.live.source_status.trending_market_activity_unavailable || null,
    },
  ];

  return (
    <div className="mx-auto flex flex-col gap-6 pb-8">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-slate-950">Polymarket Copy Bot</h1>
          <p className="text-sm text-slate-500">{subtitle}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            className="rounded-full bg-sky-300 px-5 text-slate-950 hover:bg-sky-200"
            disabled={pendingAction !== null}
            onClick={() => runAction('start', () => apiService.polymarketStart())}
          >
            Start bot
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="rounded-full border-slate-300"
            disabled={pendingAction !== null}
            onClick={() => runAction('stop', () => apiService.polymarketStop())}
          >
            Stop bot
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="rounded-full border-slate-300"
            disabled={pendingAction !== null}
            onClick={() => runAction('pause', () => apiService.polymarketPause())}
          >
            Pause proposals
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="rounded-full border-slate-300"
            disabled={pendingAction !== null}
            onClick={() => runAction('resume', () => apiService.polymarketResume())}
          >
            Resume
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-[20px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {error}
        </div>
      ) : null}
      {actionError ? (
        <div className="rounded-[20px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {actionError}
        </div>
      ) : null}

      <Card className="border border-slate-200 bg-white py-6">
        <CardHeader className="pb-0">
          <CardTitle className="text-base tracking-[0.18em] text-slate-950">Bot Status</CardTitle>
          <CardDescription>Current runtime and Bullpen polling state for the real-money copy bot.</CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <MetricGrid items={botStatusItems} columns="md:grid-cols-2 xl:grid-cols-5" />
        </CardContent>
      </Card>

      <Card id="open-positions" className="scroll-mt-6 border border-slate-200 bg-white py-6">
        <CardHeader className="pb-0">
          <CardTitle className="text-base tracking-[0.18em] text-slate-950">Open Positions</CardTitle>
          <CardDescription>Current open Polymarket positions tracked by the copy bot.</CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <div className="overflow-x-auto rounded-[24px] border border-slate-200 bg-white shadow-sm">
            <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
              <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                <tr>
                  <th className="px-4 py-3">Market</th>
                  <th className="px-4 py-3">Outcome</th>
                  <th className="px-4 py-3">Shares</th>
                  <th className="px-4 py-3">Average Price</th>
                  <th className="px-4 py-3">Cost Basis</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {state.open_positions.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-sm text-slate-500">
                      No open positions are currently tracked.
                    </td>
                  </tr>
                ) : (
                  state.open_positions.map((position) => (
                    <tr key={position.key} className="align-top">
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-950">{position.market_title || position.market_id}</div>
                        <div className="mt-1 text-xs text-slate-500">{position.market_id}</div>
                      </td>
                      <td className="px-4 py-3 text-slate-700">{position.outcome}</td>
                      <td className="px-4 py-3 text-slate-700">{position.shares.toFixed(4)}</td>
                      <td className="px-4 py-3 text-slate-700">{formatMoney(position.average_price, 4)}</td>
                      <td className="px-4 py-3 text-slate-700">{formatMoney(position.cost_basis)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card className="border border-slate-200 bg-white py-6">
        <CardHeader className="pb-0">
          <CardTitle className="text-base tracking-[0.18em] text-slate-950">Live Trading Control</CardTitle>
          <CardDescription>
            Sandbox execution is disabled. Real Polymarket orders route through Bullpen after live guards pass.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 pt-4">
          <MetricGrid items={liveControlItems} columns="md:grid-cols-2 xl:grid-cols-4" />

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              className="rounded-full border-slate-300"
              disabled={pendingAction !== null}
              onClick={() =>
                runAction('toggle-live', () =>
                  state.live.unlocked ? apiService.polymarketLiveLock() : apiService.polymarketLiveUnlock(),
                )
              }
            >
              {state.live.unlocked ? 'Lock live' : 'Unlock live'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="rounded-full border-slate-300"
              disabled={pendingAction !== null}
              onClick={() => runAction('doctor', () => apiService.polymarketLiveDoctor())}
            >
              Refresh doctor
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="rounded-full border-slate-300"
              disabled={pendingAction !== null}
              onClick={() => runAction('balance', () => apiService.polymarketLiveBalanceRefresh())}
            >
              Refresh balance
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="rounded-full border-slate-300"
              disabled={pendingAction !== null || visiblePending.length === 0}
              onClick={() => void rejectVisible()}
            >
              Reject visible pending
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="rounded-full border-slate-300"
              disabled={pendingAction !== null || state.live.pending_confirmations.length === 0}
              onClick={() => runAction('reject-all', () => apiService.polymarketLiveRejectAll())}
            >
              Reject all pending
            </Button>
            <Button
              size="sm"
              variant="destructive"
              className="rounded-full"
              disabled={pendingAction !== null}
              onClick={() => runAction('emergency-stop', () => apiService.polymarketLiveEmergencyStop())}
            >
              Emergency stop
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="rounded-full border-slate-300"
              disabled={pendingAction !== null}
              onClick={() => runAction('emergency-reset', () => apiService.polymarketLiveResetEmergencyStop())}
            >
              Reset emergency stop
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="border border-slate-200 bg-white py-6">
        <CardHeader className="pb-0">
          <CardTitle className="text-base tracking-[0.18em] text-slate-950">Pending Confirmations</CardTitle>
          <CardDescription>
            Confirming a pending trade may place a real Polymarket order through Bullpen. Confirm is disabled
            whenever live is locked or emergency stop is active.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 pt-4">
          <div className="flex items-start gap-3 rounded-[20px] border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" />
            <span>
              Pending rows are real-money Bullpen candidates. Confirm is required unless AUTO_EXECUTE_LIVE=true and
              REQUIRE_MANUAL_CONFIRMATION=false in the backend environment.
            </span>
          </div>

          <label className="inline-flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={showAllPending}
              onChange={(event) => setShowAllPending(event.target.checked)}
            />
            Show all pending
          </label>

          <PendingConfirmationsTable
            rows={visiblePending}
            maxPending={state.config.max_pending_confirmations}
            showAll={showAllPending}
            confirmDisabled={confirmDisabled}
            busyTradeId={busyTradeId}
            onConfirm={(tradeId) => void runTradeAction(tradeId, 'confirm')}
            onReject={(tradeId) => void runTradeAction(tradeId, 'reject')}
          />
        </CardContent>
      </Card>

      <Card className="border border-slate-200 bg-white py-6">
        <CardHeader className="pb-0">
          <CardTitle className="text-base tracking-[0.18em] text-slate-950">Trader Discovery Logic</CardTitle>
          <CardDescription>
            Detection can be broad, but proposal creation is selective. Tracked does not mean a trade will be
            copied.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 pt-4">
          <MetricGrid items={discoveryItems} columns="md:grid-cols-2 xl:grid-cols-4" />
          <div className="rounded-[20px] border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
            Pending confirmations appear only after a new live-read trade is detected after startup baseline.
            If manual wallets are configured, they are preferred over auto-discovered traders.
          </div>
          {manualInvalid.length > 0 ? (
            <div className="rounded-[20px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
              Invalid manual wallet entries were ignored: {manualInvalid.join(', ')}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card className="border border-slate-200 bg-white py-6">
        <CardHeader className="pb-0">
          <CardTitle className="text-base tracking-[0.18em] text-slate-950">Live Source Status</CardTitle>
          <CardDescription>
            Poll-level diagnostics for the live-read source, baseline tracking, and proposal-control filters.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <MetricGrid items={liveSourceItems} columns="md:grid-cols-2 xl:grid-cols-4" />
        </CardContent>
      </Card>

      <Card className="border border-slate-200 bg-white py-6">
        <CardHeader className="pb-0">
          <CardTitle className="text-base tracking-[0.18em] text-slate-950">Top Tracked Traders</CardTitle>
          <CardDescription>Tracked public trader identities selected for copy-read monitoring.</CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <TrackedTradersTable traders={state.tracked_traders} />
        </CardContent>
      </Card>

      <Card className="border border-slate-200 bg-white py-6">
        <CardHeader className="pb-0">
          <CardTitle className="text-base tracking-[0.18em] text-slate-950">Manual Tracked Wallets</CardTitle>
          <CardDescription>
            `MANUAL_TRACKED_WALLETS` entries remain tracked even if not discovered by the active-trader scan.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <ManualWalletsTable wallets={state.live.source_status.manual_tracked_wallets} />
        </CardContent>
      </Card>

      <Card className="border border-slate-200 bg-white py-6">
        <CardHeader className="pb-0">
          <CardTitle className="text-base tracking-[0.18em] text-slate-950">Recent Bullpen Activity</CardTitle>
          <CardDescription>Live-read, guard, balance, and execution events from the Bullpen-backed bot.</CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <div className="rounded-[24px] border border-slate-200 bg-slate-50 px-4 py-4 shadow-sm">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Event Log
            </div>
            <div className="mt-3 space-y-3">
              {state.recent_activity.length === 0 ? (
                <div className="text-sm text-slate-500">No Bullpen activity yet.</div>
              ) : (
                state.recent_activity.map((entry) => (
                  <div key={`${entry.timestamp}-${entry.message}`} className="rounded-[18px] bg-white px-3 py-3 shadow-sm ring-1 ring-slate-200">
                    <div className="text-xs font-medium uppercase tracking-[0.16em] text-slate-400">
                      {formatTs(entry.timestamp)}
                    </div>
                    <div className="mt-1 text-sm text-slate-700">{entry.message}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border border-slate-200 bg-white py-6">
        <CardHeader className="pb-0">
          <CardTitle className="text-base tracking-[0.18em] text-slate-950">Discovery Debug</CardTitle>
          <CardDescription>
            Safe debug helper for a public handle or wallet. Results are redacted and do not expose local secrets.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 pt-4">
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              value={debugTarget}
              onChange={(event) => setDebugTarget(event.target.value)}
              className="h-10 flex-1 rounded-full border border-slate-300 px-4 text-sm outline-none focus:border-sky-400"
              placeholder="swisstony"
            />
            <Button
              size="sm"
              variant="outline"
              className="rounded-full border-slate-300"
              disabled={debugLoading}
              onClick={() => void runDiscoveryDebug()}
            >
              {debugLoading ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Debugging
                </>
              ) : (
                <>
                  <RefreshCw className="size-3.5" />
                  Run debug
                </>
              )}
            </Button>
          </div>

          {debugReport ? (
            <div className="rounded-[24px] border border-slate-200 bg-slate-50 px-4 py-4 text-sm text-slate-700">
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <div><span className="font-semibold text-slate-950">Target:</span> {debugReport.target}</div>
                <div><span className="font-semibold text-slate-950">Rows:</span> {debugReport.rows_returned_count}</div>
                <div><span className="font-semibold text-slate-950">Accepted:</span> {debugReport.accepted_trades_count}</div>
                <div><span className="font-semibold text-slate-950">Rejected:</span> {debugReport.rejected_rows_count}</div>
              </div>
              <div className="mt-4 space-y-2 text-xs text-slate-600">
                <div>
                  <span className="font-semibold uppercase tracking-[0.16em] text-slate-500">Commands attempted</span>
                  <pre className="mt-2 overflow-x-auto rounded-[18px] bg-white p-3 shadow-sm ring-1 ring-slate-200">
                    {JSON.stringify(debugReport.commands_attempted, null, 2)}
                  </pre>
                </div>
                <div>
                  <span className="font-semibold uppercase tracking-[0.16em] text-slate-500">Accepted samples</span>
                  <pre className="mt-2 overflow-x-auto rounded-[18px] bg-white p-3 shadow-sm ring-1 ring-slate-200">
                    {JSON.stringify(debugReport.accepted, null, 2)}
                  </pre>
                </div>
                {debugReport.errors.length > 0 ? (
                  <div>
                    <span className="font-semibold uppercase tracking-[0.16em] text-slate-500">Errors</span>
                    <pre className="mt-2 overflow-x-auto rounded-[18px] bg-white p-3 shadow-sm ring-1 ring-slate-200">
                      {JSON.stringify(debugReport.errors, null, 2)}
                    </pre>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {pendingAction ? (
        <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-slate-500">
          <Loader2 className="size-3.5 animate-spin" />
          Processing {pendingAction}
        </div>
      ) : null}
    </div>
  );
}
