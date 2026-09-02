'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  ExternalLink,
  GitBranch,
  Mail,
  RefreshCw,
  Save,
  Send,
  Wrench,
} from 'lucide-react';

import { URLs } from '@/lib/urls';

const RECIPIENT = 'tarun.singh6893@gmail.com';
const MESSAGE = "Hi, this a message from Tarun's Cred-X";

const SEGMENT_BADGE_STYLES: Record<string, string> = {
  Zerodha: 'border-blue-200 bg-blue-50 text-blue-700',
  IndMoney: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  Bullpen: 'border-amber-200 bg-amber-50 text-amber-800',
  All: 'border-violet-200 bg-violet-50 text-violet-700',
};

type MailHistoryItem = {
  id: number;
  created_at: string;
  status: string;
  category: 'runs' | 'alerts' | 'account';
  trigger: string;
  recipients: string[];
  subject: string;
  message: string;
  remarks: string;
  run_id?: string | null;
  warnings: Array<{
    market_id?: string;
    question?: string;
    position_side?: string;
    held_side_llm_odds?: number;
    held_side_bullpen_odds?: number;
    breach_sources?: string[];
    recommended_action?: string;
  }>;
  provider_code?: string | null;
  provider_summary?: string | null;
  provider_message?: string | null;
  sell_action?: SellAction | null;
};

type SellActionStatus =
  | 'detected'
  | 'awaiting_confirmation'
  | 'confirmed'
  | 'submitting'
  | 'filled'
  | 'pending'
  | 'failed'
  | 'cleared';

type SellAction = {
  status: SellActionStatus;
  updated_at: string;
  inferred?: boolean;
  market_ids?: string[];
  evaluated_market_id?: string | null;
  market_question?: string | null;
  position_side?: 'YES' | 'NO' | null;
  live_held_side_bullpen_odds?: number | null;
  sell_threshold?: number | null;
  average_sell_price?: number | null;
  evaluated_at?: string | null;
  batch_id?: string | null;
  eligibility_decision?: 'eligible' | 'recovered' | 'unverified';
  shares?: number | null;
  expected_proceeds?: number | null;
  proceeds?: number | null;
  transaction_url?: string | null;
  note?: string | null;
  error?: string | null;
  history?: Array<{
    status: SellActionStatus;
    at: string;
    note?: string | null;
    shares?: number | null;
    expected_proceeds?: number | null;
    proceeds?: number | null;
    transaction_url?: string | null;
    error?: string | null;
  }>;
};

type MailHistoryTab = 'all' | 'runs' | 'alerts' | 'account' | 'github';

type MailPreference = {
  key: string;
  label: string;
  description: string;
  category: 'runs' | 'alerts' | 'account';
  segments: Array<'Zerodha' | 'IndMoney' | 'Bullpen' | 'All'>;
  enabled: boolean;
};

type GitHubWorkflowRun = {
  id: number;
  name: string;
  display_title: string;
  event: string;
  status: string;
  conclusion?: string | null;
  head_branch?: string | null;
  head_sha: string;
  html_url: string;
  run_number: number;
  created_at: string;
  updated_at: string;
};

type MailFailure = {
  code: string;
  summary: string;
  provider_message?: string | null;
  how_to_fix: string[];
  configuration?: {
    host: string;
    port?: number | null;
    username_configured: boolean;
    password_configured: boolean;
    from_email: string;
    from_name: string;
  };
};

function normalizeFailure(payload: unknown): MailFailure {
  const candidate =
    payload && typeof payload === 'object' && 'detail' in payload
      ? (payload as { detail?: unknown }).detail
      : payload;

  if (candidate && typeof candidate === 'object' && 'code' in candidate) {
    const detail = candidate as Partial<MailFailure>;
    return {
      code: detail.code || 'EMAIL_SEND_FAILED',
      summary: detail.summary || 'The email could not be sent.',
      provider_message: detail.provider_message,
      how_to_fix: Array.isArray(detail.how_to_fix) ? detail.how_to_fix : [],
      configuration: detail.configuration,
    };
  }

  return {
    code: 'EMAIL_SEND_FAILED',
    summary:
      typeof candidate === 'string'
        ? candidate
        : 'The email could not be sent.',
    how_to_fix: [
      'Check the investor-backend logs and verify the SMTP configuration.',
    ],
  };
}

const SELL_ACTION_NEXT: Record<SellActionStatus, SellActionStatus[]> = {
  detected: ['awaiting_confirmation', 'cleared'],
  awaiting_confirmation: ['confirmed', 'cleared'],
  confirmed: ['submitting', 'cleared'],
  submitting: ['filled', 'pending', 'failed'],
  pending: ['filled', 'failed'],
  filled: [],
  failed: [],
  cleared: [],
};

function sellActionTone(status: SellActionStatus) {
  if (status === 'filled') return 'border-emerald-200 bg-emerald-50 text-emerald-800';
  if (status === 'failed') return 'border-red-200 bg-red-50 text-red-800';
  if (status === 'cleared') return 'border-slate-200 bg-slate-50 text-slate-700';
  if (status === 'pending' || status === 'submitting') {
    return 'border-amber-200 bg-amber-50 text-amber-800';
  }
  return 'border-blue-200 bg-blue-50 text-blue-800';
}

function formatActionStatus(status: SellActionStatus) {
  return status.replaceAll('_', ' ');
}

function SellActionAudit({
  item,
  onUpdated,
}: {
  item: MailHistoryItem;
  onUpdated: (sellAction: SellAction) => void;
}) {
  const action = item.sell_action;
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [note, setNote] = useState(action?.note || '');
  const [shares, setShares] = useState(action?.shares?.toString() || '');
  const [expectedProceeds, setExpectedProceeds] = useState(
    action?.expected_proceeds?.toString() || '',
  );
  const [proceeds, setProceeds] = useState(action?.proceeds?.toString() || '');
  const [transactionUrl, setTransactionUrl] = useState(action?.transaction_url || '');
  const [executionError, setExecutionError] = useState(action?.error || '');
  const [marketId, setMarketId] = useState(
    action?.evaluated_market_id || action?.market_ids?.[0] || '',
  );
  const [marketQuestion, setMarketQuestion] = useState(
    action?.market_question || item.warnings[0]?.question || '',
  );
  const [positionSide, setPositionSide] = useState(
    action?.position_side || item.warnings[0]?.position_side || '',
  );
  const [liveBullpenOdds, setLiveBullpenOdds] = useState(
    action?.live_held_side_bullpen_odds?.toString() || '',
  );
  const [averageSellPrice, setAverageSellPrice] = useState(
    action?.average_sell_price?.toString() || '',
  );
  const [batchId, setBatchId] = useState(action?.batch_id || '');

  if (!action) return null;

  async function updateStatus(status: SellActionStatus) {
    setUpdating(true);
    setUpdateError(null);
    try {
      const response = await fetch(URLs.mails.sellAction(item.id), {
        method: 'PATCH',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status,
          note: note || null,
          market_id: marketId || null,
          market_question: marketQuestion || null,
          position_side: positionSide || null,
          live_held_side_bullpen_odds: liveBullpenOdds ? Number(liveBullpenOdds) : null,
          sell_threshold: 80,
          average_sell_price: averageSellPrice ? Number(averageSellPrice) : null,
          evaluated_at: liveBullpenOdds ? new Date().toISOString() : null,
          batch_id: batchId || null,
          shares: shares ? Number(shares) : null,
          expected_proceeds: expectedProceeds ? Number(expectedProceeds) : null,
          proceeds: proceeds ? Number(proceeds) : null,
          transaction_url: transactionUrl || null,
          error: executionError || null,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { sell_action?: SellAction; detail?: string }
        | null;
      if (!response.ok || !payload?.sell_action) {
        throw new Error(payload?.detail || 'Sell action status could not be updated.');
      }
      onUpdated(payload.sell_action);
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : 'Sell action status could not be updated.');
    } finally {
      setUpdating(false);
    }
  }

  return (
    <section className="mt-4 rounded-2xl border border-red-200 bg-red-50/40 p-4" aria-label="Sell action audit">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-red-700">Sell action taken</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Delivery audit #{item.id}{action.inferred ? ' · inferred from historical EXIT email' : ''}
          </p>
        </div>
        <span className={`rounded-full border px-2.5 py-1 text-xs font-bold uppercase ${sellActionTone(action.status)}`}>
          {formatActionStatus(action.status)}
        </span>
      </div>

      <div className="mt-3 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-950">
        Sell eligibility uses only the fresh live held-side Bullpen odds: strictly below 80.0%. LLM odds are ignored.
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="text-xs font-semibold text-foreground">
          Event
          <input aria-label={`Sell event for mail ${item.id}`} value={marketQuestion} onChange={(event) => setMarketQuestion(event.target.value)} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 font-normal" />
        </label>
        <label className="text-xs font-semibold text-foreground">
          Market ID
          <input aria-label={`Sell market ID for mail ${item.id}`} value={marketId} onChange={(event) => setMarketId(event.target.value)} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 font-normal" />
        </label>
        <label className="text-xs font-semibold text-foreground">
          Held side
          <select aria-label={`Sell held side for mail ${item.id}`} value={positionSide} onChange={(event) => setPositionSide(event.target.value)} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 font-normal">
            <option value="">Select side</option>
            <option value="YES">YES</option>
            <option value="NO">NO</option>
          </select>
        </label>
        <label className="text-xs font-semibold text-foreground">
          Live held-side Bullpen odds (%)
          <input aria-label={`Live held-side Bullpen odds for mail ${item.id}`} value={liveBullpenOdds} onChange={(event) => setLiveBullpenOdds(event.target.value)} inputMode="decimal" className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 font-normal" />
        </label>
        <label className="text-xs font-semibold text-foreground">
          Average Sell price (¢)
          <input aria-label={`Average Sell price for mail ${item.id}`} value={averageSellPrice} onChange={(event) => setAverageSellPrice(event.target.value)} inputMode="decimal" className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 font-normal" />
        </label>
        <label className="text-xs font-semibold text-foreground">
          Batch ID
          <input aria-label={`Sell batch ID for mail ${item.id}`} value={batchId} onChange={(event) => setBatchId(event.target.value)} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 font-normal" />
        </label>
        <label className="text-xs font-semibold text-foreground">
          Shares
          <input aria-label={`Sell shares for mail ${item.id}`} value={shares} onChange={(event) => setShares(event.target.value)} inputMode="decimal" className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 font-normal" />
        </label>
        <label className="text-xs font-semibold text-foreground">
          Expected proceeds ($)
          <input aria-label={`Expected Sell proceeds for mail ${item.id}`} value={expectedProceeds} onChange={(event) => setExpectedProceeds(event.target.value)} inputMode="decimal" className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 font-normal" />
        </label>
        <label className="text-xs font-semibold text-foreground">
          Filled proceeds ($)
          <input aria-label={`Filled Sell proceeds for mail ${item.id}`} value={proceeds} onChange={(event) => setProceeds(event.target.value)} inputMode="decimal" className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 font-normal" />
        </label>
        <label className="text-xs font-semibold text-foreground sm:col-span-2">
          Bullpen transaction link
          <input aria-label={`Sell transaction link for mail ${item.id}`} value={transactionUrl} onChange={(event) => setTransactionUrl(event.target.value)} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 font-normal" />
        </label>
        <label className="text-xs font-semibold text-foreground">
          Note or failure detail
          <input aria-label={`Sell action note for mail ${item.id}`} value={executionError || note} onChange={(event) => action.status === 'submitting' ? setExecutionError(event.target.value) : setNote(event.target.value)} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 font-normal" />
        </label>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" disabled={updating} onClick={() => void updateStatus(action.status)} className="rounded-lg border border-blue-200 bg-background px-3 py-2 text-xs font-bold text-blue-800 transition hover:bg-blue-100 disabled:opacity-50">
          Save live details
        </button>
        {SELL_ACTION_NEXT[action.status].map((nextStatus) => (
          <button key={nextStatus} type="button" disabled={updating} onClick={() => void updateStatus(nextStatus)} className="rounded-lg border border-red-200 bg-background px-3 py-2 text-xs font-bold capitalize text-red-800 transition hover:bg-red-100 disabled:opacity-50">
            Mark {formatActionStatus(nextStatus)}
          </button>
        ))}
      </div>
      {updateError ? <p role="alert" className="mt-3 text-xs font-semibold text-red-700">{updateError}</p> : null}

      {action.history?.length ? (
        <ol className="mt-4 space-y-1 border-t border-red-200 pt-3 text-xs text-muted-foreground">
          {action.history.map((entry, index) => (
            <li key={`${entry.status}-${entry.at}-${index}`}>
              <span className="font-semibold capitalize text-foreground">{formatActionStatus(entry.status)}</span>
              {' · '}{new Date(entry.at).toLocaleString('en-IN')}{entry.note ? ` · ${entry.note}` : ''}
            </li>
          ))}
        </ol>
      ) : null}
      {action.transaction_url ? (
        <a href={action.transaction_url} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-xs font-bold text-blue-700">
          Open Bullpen transaction <ExternalLink className="h-3.5 w-3.5" />
        </a>
      ) : null}
    </section>
  );
}


function SellBatchPreparation({ history }: { history: MailHistoryItem[] }) {
  type BatchRow = {
    key: string;
    event: string;
    marketId: string;
    side: string;
    emailOdds?: number;
    emailAt: string;
    liveOdds?: number;
    evaluatedAt?: string | null;
    threshold: number;
    decision: 'included' | 'recovered' | 'unverified';
    shares?: number | null;
    averageSellPrice?: number | null;
    expectedProceeds?: number | null;
    batchId?: string | null;
    status: SellActionStatus;
    auditIds: number[];
  };

  const rowsByMarket = new Map<string, BatchRow>();
  for (const item of history) {
    const action = item.sell_action;
    if (!action || (action.status === 'detected' && !action.evaluated_at)) continue;
    const warning =
      item.warnings.find(
        (candidate) => candidate.market_id === action.evaluated_market_id,
      ) || item.warnings[0];
    const marketId =
      action.evaluated_market_id || action.market_ids?.[0] || warning?.market_id || '';
    const event = action.market_question || warning?.question || item.subject;
    const key = marketId || event;
    const threshold = action.sell_threshold ?? 80;
    const liveOdds = action.live_held_side_bullpen_odds ?? undefined;
    const decision =
      typeof liveOdds !== 'number'
        ? 'unverified'
        : liveOdds < threshold && action.status !== 'cleared'
          ? 'included'
          : 'recovered';
    const candidate: BatchRow = {
      key,
      event,
      marketId,
      side: action.position_side || warning?.position_side || '—',
      emailOdds: warning?.held_side_bullpen_odds,
      emailAt: item.created_at,
      liveOdds,
      evaluatedAt: action.evaluated_at,
      threshold,
      decision,
      shares: action.shares,
      averageSellPrice: action.average_sell_price,
      expectedProceeds: action.expected_proceeds,
      batchId: action.batch_id,
      status: action.status,
      auditIds: [item.id],
    };
    const existing = rowsByMarket.get(key);
    if (!existing) {
      rowsByMarket.set(key, candidate);
      continue;
    }
    const candidateTime = new Date(candidate.evaluatedAt || candidate.emailAt).getTime();
    const existingTime = new Date(existing.evaluatedAt || existing.emailAt).getTime();
    const latest = candidateTime >= existingTime ? candidate : existing;
    latest.auditIds = Array.from(new Set([...existing.auditIds, item.id])).sort(
      (left, right) => left - right,
    );
    rowsByMarket.set(key, latest);
  }

  const rows = Array.from(rowsByMarket.values()).sort((left, right) => {
    const order = { included: 0, recovered: 1, unverified: 2 };
    return order[left.decision] - order[right.decision];
  });
  const included = rows.filter((row) => row.decision === 'included');
  const recovered = rows.filter((row) => row.decision === 'recovered');
  const unverified = rows.filter((row) => row.decision === 'unverified');
  const expectedTotal = included.reduce(
    (total, row) => total + (row.expectedProceeds || 0),
    0,
  );

  return (
    <section
      className="mt-8 overflow-hidden rounded-3xl border border-blue-200 bg-card shadow-sm"
      aria-label="Sell batch preparation"
    >
      <div className="border-b border-blue-200 bg-blue-50/70 px-6 py-5">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700">
          Bullpen exit control
        </p>
        <h2 className="mt-1 text-xl font-bold text-foreground">
          Sell Batch Preparation
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Include a position only when its fresh live held-side Bullpen odds are strictly below 80.0%. LLM odds are ignored.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-4">
          <div className="rounded-xl border border-red-200 bg-white p-3"><p className="text-xs text-muted-foreground">Included</p><p className="mt-1 text-2xl font-bold text-red-700">{included.length}</p></div>
          <div className="rounded-xl border border-emerald-200 bg-white p-3"><p className="text-xs text-muted-foreground">Recovered / excluded</p><p className="mt-1 text-2xl font-bold text-emerald-700">{recovered.length}</p></div>
          <div className="rounded-xl border border-amber-200 bg-white p-3"><p className="text-xs text-muted-foreground">Awaiting live validation</p><p className="mt-1 text-2xl font-bold text-amber-700">{unverified.length}</p></div>
          <div className="rounded-xl border border-blue-200 bg-white p-3"><p className="text-xs text-muted-foreground">Expected proceeds</p><p className="mt-1 text-2xl font-bold text-blue-700">${expectedTotal.toFixed(2)}</p></div>
        </div>
      </div>
      {rows.length ? (
        <div className="overflow-x-auto">
          <table className="min-w-[1380px] w-full text-left text-xs">
            <thead className="border-b border-border bg-muted/50 uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Event</th>
                <th className="px-4 py-3">Market ID</th>
                <th className="px-4 py-3">Held side</th>
                <th className="px-4 py-3">Email Bullpen odds</th>
                <th className="px-4 py-3">Fresh live odds</th>
                <th className="px-4 py-3">Live read at</th>
                <th className="px-4 py-3">80% test</th>
                <th className="px-4 py-3">Full shares</th>
                <th className="px-4 py-3">Avg. Sell</th>
                <th className="px-4 py-3">Expected proceeds</th>
                <th className="px-4 py-3">Batch</th>
                <th className="px-4 py-3">Audit IDs</th>
                <th className="px-4 py-3">Lifecycle</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => (
                <tr key={row.key} className={row.decision === 'included' ? 'bg-red-50/50' : row.decision === 'recovered' ? 'bg-emerald-50/40' : 'bg-amber-50/40'}>
                  <td className="max-w-sm px-4 py-3 font-semibold text-foreground">{row.event}</td>
                  <td className="px-4 py-3 font-mono">{row.marketId || '—'}</td>
                  <td className="px-4 py-3 font-bold">{row.side}</td>
                  <td className="px-4 py-3">{typeof row.emailOdds === 'number' ? `${row.emailOdds.toFixed(1)}%` : 'Unavailable'}<span className="mt-1 block text-[10px] text-muted-foreground">{new Date(row.emailAt).toLocaleString('en-IN')}</span></td>
                  <td className="px-4 py-3 font-bold">{typeof row.liveOdds === 'number' ? `${row.liveOdds.toFixed(1)}%` : 'Not read'}</td>
                  <td className="px-4 py-3">{row.evaluatedAt ? new Date(row.evaluatedAt).toLocaleString('en-IN') : '—'}</td>
                  <td className="px-4 py-3"><span className={`rounded-full border px-2 py-1 font-bold ${row.decision === 'included' ? 'border-red-200 bg-red-100 text-red-800' : row.decision === 'recovered' ? 'border-emerald-200 bg-emerald-100 text-emerald-800' : 'border-amber-200 bg-amber-100 text-amber-800'}`}>{row.decision === 'included' ? `INCLUDE · < ${row.threshold.toFixed(1)}%` : row.decision === 'recovered' ? `EXCLUDE · ≥ ${row.threshold.toFixed(1)}%` : 'UNVERIFIED'}</span></td>
                  <td className="px-4 py-3">{row.shares ?? '—'}</td>
                  <td className="px-4 py-3">{typeof row.averageSellPrice === 'number' ? `${row.averageSellPrice.toFixed(1)}¢` : '—'}</td>
                  <td className="px-4 py-3">{typeof row.expectedProceeds === 'number' ? `${row.expectedProceeds.toFixed(2)}` : '—'}</td>
                  <td className="px-4 py-3 font-mono">{row.batchId || '—'}</td>
                  <td className="px-4 py-3">{row.auditIds.map((id) => `#${id}`).join(', ')}</td>
                  <td className="px-4 py-3 capitalize">{formatActionStatus(row.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="p-6 text-sm text-muted-foreground">
          No Sell alerts have been evaluated against live Bullpen odds yet.
        </div>
      )}
    </section>
  );
}

export default function MailsPage() {
  const [selected, setSelected] = useState(true);
  const [sending, setSending] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [failure, setFailure] = useState<MailFailure | null>(null);
  const [history, setHistory] = useState<MailHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [githubRuns, setGithubRuns] = useState<GitHubWorkflowRun[]>([]);
  const [githubLoading, setGithubLoading] = useState(true);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [historyTab, setHistoryTab] = useState<MailHistoryTab>('all');
  const [preferences, setPreferences] = useState<MailPreference[]>([]);
  const [preferencesLoading, setPreferencesLoading] = useState(true);
  const [preferencesSaving, setPreferencesSaving] = useState(false);
  const [preferencesDirty, setPreferencesDirty] = useState(false);
  const [preferencesError, setPreferencesError] = useState<string | null>(null);
  const [preferencesSaved, setPreferencesSaved] = useState(false);

  const loadPreferences = useCallback(async () => {
    setPreferencesLoading(true);
    setPreferencesError(null);
    try {
      const response = await fetch(URLs.mails.preferences(), {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      const payload = (await response.json().catch(() => null)) as
        | { items?: MailPreference[] }
        | null;
      if (!response.ok || !Array.isArray(payload?.items)) {
        throw new Error('Mail preferences could not be loaded.');
      }
      setPreferences(payload.items);
      setPreferencesDirty(false);
    } catch (preferenceFailure) {
      setPreferencesError(
        preferenceFailure instanceof Error
          ? preferenceFailure.message
          : 'Mail preferences could not be loaded.',
      );
    } finally {
      setPreferencesLoading(false);
    }
  }, []);

  useEffect(() => {
    // Initial network synchronization is intentionally performed after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadPreferences();
  }, [loadPreferences]);

  function setPreference(key: string, enabled: boolean) {
    setPreferences((current) =>
      current.map((item) => (item.key === key ? { ...item, enabled } : item)),
    );
    setPreferencesDirty(true);
    setPreferencesSaved(false);
  }

  function setAllPreferences(enabled: boolean) {
    setPreferences((current) => current.map((item) => ({ ...item, enabled })));
    setPreferencesDirty(true);
    setPreferencesSaved(false);
  }

  async function savePreferences() {
    if (preferencesSaving || !preferencesDirty) return;
    setPreferencesSaving(true);
    setPreferencesError(null);
    setPreferencesSaved(false);
    try {
      const response = await fetch(URLs.mails.preferences(), {
        method: 'PUT',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          preferences: Object.fromEntries(
            preferences.map((item) => [item.key, item.enabled]),
          ),
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { items?: MailPreference[] }
        | null;
      if (!response.ok || !Array.isArray(payload?.items)) {
        throw new Error('Mail preferences could not be saved.');
      }
      setPreferences(payload.items);
      setPreferencesDirty(false);
      setPreferencesSaved(true);
    } catch (preferenceFailure) {
      setPreferencesError(
        preferenceFailure instanceof Error
          ? preferenceFailure.message
          : 'Mail preferences could not be saved.',
      );
    } finally {
      setPreferencesSaving(false);
    }
  }

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const response = await fetch(URLs.mails.history(), {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      const payload = (await response.json().catch(() => null)) as
        | { items?: MailHistoryItem[]; detail?: unknown }
        | null;
      if (!response.ok || !Array.isArray(payload?.items)) {
        throw new Error('Mail history could not be loaded.');
      }
      setHistory(payload.items);
    } catch (historyFailure) {
      setHistoryError(
        historyFailure instanceof Error
          ? historyFailure.message
          : 'Mail history could not be loaded.',
      );
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    // Initial network synchronization is intentionally performed after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    if (historyLoading || typeof window === 'undefined') return;
    const deliveryId = new URLSearchParams(window.location.search).get('deliveryId');
    if (!deliveryId) return;
    document.getElementById(`mail-delivery-${deliveryId}`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
  }, [historyLoading, history]);

  const loadGitHubRuns = useCallback(async () => {
    setGithubLoading(true);
    setGithubError(null);
    try {
      const response = await fetch(
        'https://api.github.com/repos/tarunxt/investment-engine/actions/runs?per_page=50',
        {
          headers: {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          cache: 'no-store',
        },
      );
      const payload = (await response.json().catch(() => null)) as
        | { workflow_runs?: GitHubWorkflowRun[]; message?: string }
        | null;
      if (!response.ok || !Array.isArray(payload?.workflow_runs)) {
        throw new Error(payload?.message || 'GitHub workflow history could not be loaded.');
      }
      setGithubRuns(payload.workflow_runs);
    } catch (githubFailure) {
      setGithubError(
        githubFailure instanceof Error
          ? githubFailure.message
          : 'GitHub workflow history could not be loaded.',
      );
    } finally {
      setGithubLoading(false);
    }
  }, []);

  useEffect(() => {
    // Initial network synchronization is intentionally performed after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadGitHubRuns();
  }, [loadGitHubRuns]);

  async function refreshHistory() {
    await Promise.all([loadHistory(), loadGitHubRuns()]);
  }

  async function sendMail() {
    if (!selected || sending) return;

    setSending(true);
    setSuccess(null);
    setFailure(null);

    try {
      const response = await fetch(URLs.mails.sendTest(), {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        setFailure(normalizeFailure(payload));
        return;
      }

      setSuccess(`Email sent successfully to ${RECIPIENT}.`);
    } catch (sendError) {
      setFailure({
        code: 'MAIL_API_UNREACHABLE',
        summary:
          sendError instanceof Error
            ? sendError.message
            : 'The mail API could not be reached.',
        how_to_fix: [
          'Reload the page and try once more.',
          'If it continues, verify that investor-backend is running and inspect its logs.',
        ],
      });
    } finally {
      await loadHistory();
      setSending(false);
    }
  }

  const categoryCounts = history.reduce<Record<Exclude<MailHistoryTab, 'all' | 'github'>, number>>(
    (counts, item) => {
      counts[item.category] += 1;
      return counts;
    },
    { runs: 0, alerts: 0, account: 0 },
  );
  const historyTabs: Array<{ id: MailHistoryTab; label: string; count: number }> = [
    { id: 'all', label: 'All Cred-X', count: history.length },
    { id: 'runs', label: 'Run notifications', count: categoryCounts.runs },
    { id: 'alerts', label: 'Risk alerts & tests', count: categoryCounts.alerts },
    { id: 'account', label: 'Account & security', count: categoryCounts.account },
    { id: 'github', label: 'GitHub checks', count: githubRuns.length },
  ];
  const visibleHistory =
    historyTab === 'all'
      ? history
      : historyTab === 'github'
        ? []
        : history.filter((item) => item.category === historyTab);
  const emptyHistoryMessage =
    historyTab === 'all'
      ? 'No Cred-X mail attempts have been recorded yet.'
      : `No ${historyTabs
          .find((tab) => tab.id === historyTab)
          ?.label.toLowerCase()} mails have been recorded yet.`;

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <section className="overflow-hidden rounded-3xl border border-border bg-card shadow-sm">
        <div className="border-b border-border bg-linear-to-r from-violet-600 to-indigo-600 px-6 py-7 text-white sm:px-8">
          <div className="flex items-center gap-3">
            <div className="rounded-2xl bg-white/15 p-3">
              <Mail className="h-6 w-6" />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/75">
                Cred-X Communications
              </p>
              <h1 className="mt-1 text-2xl font-bold">Mails</h1>
            </div>
          </div>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-white/80">
            Choose exactly which automatic Cred-X emails you want to receive, then review every delivery below.
          </p>
        </div>

        <div className="space-y-6 p-6 sm:p-8">
          <section className="rounded-2xl border border-border bg-muted/20 p-5" aria-labelledby="mail-preferences-heading">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 id="mail-preferences-heading" className="text-base font-bold text-foreground">
                  Email notification settings
                </h2>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  Checked mail types are sent. Unchecked types are stopped before SMTP delivery. Changes apply to future emails only.
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  onClick={() => setAllPreferences(true)}
                  disabled={preferencesLoading || preferencesSaving}
                  className="rounded-lg border border-border px-3 py-2 text-xs font-semibold text-foreground transition hover:bg-muted disabled:opacity-50"
                >
                  Select all
                </button>
                <button
                  type="button"
                  onClick={() => setAllPreferences(false)}
                  disabled={preferencesLoading || preferencesSaving}
                  className="rounded-lg border border-border px-3 py-2 text-xs font-semibold text-foreground transition hover:bg-muted disabled:opacity-50"
                >
                  Deselect all
                </button>
              </div>
            </div>

            {preferencesLoading ? (
              <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
                <RefreshCw className="h-4 w-4 animate-spin" />
                Loading notification settings…
              </div>
            ) : (
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {preferences.map((preference) => (
                  <label
                    key={preference.key}
                    className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-card p-4 transition hover:bg-muted/40"
                  >
                    <input
                      type="checkbox"
                      checked={preference.enabled}
                      onChange={(event) => setPreference(preference.key, event.target.checked)}
                      disabled={preferencesSaving}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-violet-600"
                    />
                    <span>
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-foreground">
                          {preference.label}
                        </span>
                        <span className="flex flex-wrap gap-1.5" aria-label="Applicable segments">
                          {preference.segments.map((segment) => (
                            <span
                              key={segment}
                              className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${SEGMENT_BADGE_STYLES[segment] || SEGMENT_BADGE_STYLES.All}`}
                            >
                              {segment}
                            </span>
                          ))}
                        </span>
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                        {preference.description}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            )}

            {preferencesError ? (
              <div role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                {preferencesError}
              </div>
            ) : null}
            {preferencesSaved ? (
              <div role="status" className="mt-4 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
                <CheckCircle2 className="h-4 w-4" />
                Mail preferences saved. Disabled mail types will no longer be sent.
              </div>
            ) : null}

            <button
              type="button"
              onClick={() => void savePreferences()}
              disabled={preferencesLoading || preferencesSaving || !preferencesDirty}
              className="mt-4 inline-flex items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {preferencesSaving ? 'Saving…' : 'Save preferences'}
            </button>
          </section>

          <div>
            <h2 className="text-sm font-semibold text-foreground">Recipients</h2>
            <label className="mt-3 flex cursor-pointer items-center gap-3 rounded-2xl border border-border bg-muted/35 p-4 transition hover:bg-muted/60">
              <input
                type="checkbox"
                checked={selected}
                onChange={(event) => setSelected(event.target.checked)}
                className="h-4 w-4 accent-violet-600"
              />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-foreground">
                  Tarun Singh
                </span>
                <span className="block truncate text-sm text-muted-foreground">
                  {RECIPIENT}
                </span>
              </span>
            </label>
          </div>

          <div className="rounded-2xl border border-border bg-muted/25 p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Message preview
            </p>
            <p className="mt-3 text-sm text-foreground">{MESSAGE}</p>
          </div>

          {success ? (
            <div role="status" className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              {success}
            </div>
          ) : null}

          {failure ? (
            <div role="alert" className="space-y-4 rounded-2xl border border-red-200 bg-red-50 p-5 text-red-950">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
                <div>
                  <p className="text-sm font-bold">{failure.summary}</p>
                  <p className="mt-1 font-mono text-xs font-semibold text-red-700">
                    Error code: {failure.code}
                  </p>
                  {failure.provider_message ? (
                    <p className="mt-2 rounded-lg bg-white/70 px-3 py-2 font-mono text-xs leading-5 text-red-800">
                      Provider response: {failure.provider_message}
                    </p>
                  ) : null}
                </div>
              </div>

              {failure.configuration ? (
                <div className="grid gap-2 rounded-xl border border-red-200 bg-white/70 p-3 text-xs sm:grid-cols-2">
                  <p><span className="font-semibold">SMTP server:</span> {failure.configuration.host}:{failure.configuration.port ?? 'not set'}</p>
                  <p><span className="font-semibold">Sender:</span> {failure.configuration.from_name} &lt;{failure.configuration.from_email}&gt;</p>
                  <p><span className="font-semibold">Username:</span> {failure.configuration.username_configured ? 'Configured' : 'Missing'}</p>
                  <p><span className="font-semibold">Password:</span> {failure.configuration.password_configured ? 'Configured (hidden)' : 'Missing'}</p>
                </div>
              ) : null}

              {failure.how_to_fix.length ? (
                <div>
                  <div className="flex items-center gap-2 text-sm font-bold">
                    <Wrench className="h-4 w-4" />
                    How to fix
                  </div>
                  <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm leading-5">
                    {failure.how_to_fix.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                </div>
              ) : null}
            </div>
          ) : null}

          <button
            type="button"
            onClick={() => void sendMail()}
            disabled={!selected || sending}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-violet-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Send className="h-4 w-4" />
            {sending ? 'Sending…' : 'Send email'}
          </button>
        </div>
      </section>

      <SellBatchPreparation history={history} />

      <section className="mt-8 overflow-hidden rounded-3xl border border-border bg-card shadow-sm">
        <div className="flex flex-col gap-3 border-b border-border px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-600">
              Delivery audit
            </p>
            <h2 className="mt-1 text-xl font-bold text-foreground">Sent mail history</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Every email sent through Cred-X SMTP, grouped by purpose. New mail types appear in All Cred-X automatically.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void refreshHistory()}
            disabled={historyLoading || githubLoading}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-border px-4 py-2 text-sm font-semibold text-foreground transition hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${historyLoading || githubLoading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        <div className="border-b border-border px-6 pt-4">
          <div className="flex gap-1 overflow-x-auto" role="tablist" aria-label="Mail history categories">
            {historyTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={historyTab === tab.id}
                onClick={() => setHistoryTab(tab.id)}
                className={`shrink-0 border-b-2 px-4 py-3 text-sm font-semibold transition ${
                  historyTab === tab.id
                    ? 'border-violet-600 text-violet-700'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {tab.label}
                <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs">
                  {tab.count}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-4 p-6">
          {historyTab === 'github' ? (
            <>
              <div className="rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm leading-6 text-blue-950">
                <div className="flex items-center gap-2 font-bold">
                  <GitBranch className="h-4 w-4" />
                  GitHub-generated notifications
                </div>
                <p className="mt-1">
                  These are the live workflow records behind GitHub PR and deployment emails. They are shown separately because GitHub—not Cred-X SMTP—sends those messages.
                </p>
              </div>
              {githubError ? (
                <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                  {githubError}
                </div>
              ) : null}
              {!githubLoading && !githubError && githubRuns.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                  No GitHub workflow notifications are available.
                </div>
              ) : null}
              {githubRuns.map((run) => {
                const failed = run.conclusion === 'failure';
                const complete = run.status === 'completed';
                const tone = failed
                  ? 'border-red-200 bg-red-50 text-red-800'
                  : complete
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                    : 'border-amber-200 bg-amber-50 text-amber-800';
                return (
                  <article key={run.id} className="rounded-2xl border border-border bg-muted/20 p-5">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`rounded-full border px-2.5 py-1 text-xs font-bold uppercase tracking-wide ${tone}`}>
                            {run.conclusion || run.status}
                          </span>
                          <span className="text-xs font-semibold text-blue-700">
                            {run.name} · #{run.run_number}
                          </span>
                        </div>
                        <h3 className="mt-3 text-base font-bold text-foreground">
                          {run.display_title}
                        </h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {run.event} · {run.head_branch || 'No branch'} · {run.head_sha.slice(0, 7)}
                        </p>
                      </div>
                      <p className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                        <Clock3 className="h-3.5 w-3.5" />
                        {new Date(run.created_at).toLocaleString('en-IN')}
                      </p>
                    </div>
                    <a
                      href={run.html_url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-blue-700 hover:text-blue-800"
                    >
                      Open workflow details
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  </article>
                );
              })}
            </>
          ) : null}

          {historyTab !== 'github' && historyError ? (
            <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              {historyError}
            </div>
          ) : null}

          {historyTab !== 'github' && !historyLoading && visibleHistory.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              {emptyHistoryMessage}
            </div>
          ) : null}

          {visibleHistory.map((item) => {
            const statusTone =
              item.status === 'sent'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                : item.status === 'failed'
                  ? 'border-red-200 bg-red-50 text-red-800'
                  : 'border-amber-200 bg-amber-50 text-amber-800';
            return (
              <article id={`mail-delivery-${item.id}`} key={item.id} className="rounded-2xl border border-border bg-muted/20 p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-full border px-2.5 py-1 text-xs font-bold uppercase tracking-wide ${statusTone}`}>
                        {item.status}
                      </span>
                      <span className="text-xs font-semibold text-violet-700">{item.trigger}</span>
                    </div>
                    <h3 className="mt-3 text-base font-bold text-foreground">{item.subject}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      To: {item.recipients.join(', ') || 'No recipient recorded'}
                    </p>
                  </div>
                  <p className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <Clock3 className="h-3.5 w-3.5" />
                    {new Date(item.created_at).toLocaleString('en-IN')}
                  </p>
                </div>

                {item.warnings.length ? (
                  <div className="mt-4 space-y-2">
                    {item.warnings.map((warning, index) => (
                      <div key={warning.market_id || index} className="rounded-xl border border-red-200 bg-red-50/70 p-3 text-sm text-red-950">
                        <p className="font-bold">{warning.question || warning.market_id}</p>
                        <p className="mt-1">
                          Held {warning.position_side} · LLM: {warning.held_side_llm_odds ?? 'unavailable'}
                          {typeof warning.held_side_llm_odds === 'number' ? '%' : ''} · Actual Bullpen: {warning.held_side_bullpen_odds ?? 'unavailable'}
                          {typeof warning.held_side_bullpen_odds === 'number' ? '%' : ''}
                        </p>
                        <p className="mt-1 font-semibold">
                          Trigger: {warning.breach_sources?.join(' and ') || 'Held-side odds below threshold'} — {warning.recommended_action || 'EXIT'}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : null}

                <SellActionAudit
                  item={item}
                  onUpdated={(sellAction) => setHistory((current) => current.map((entry) => entry.id === item.id ? { ...entry, sell_action: sellAction } : entry))}
                />

                <details className="mt-4 rounded-xl border border-border bg-background p-4">
                  <summary className="cursor-pointer text-sm font-semibold text-foreground">
                    Message and delivery remarks
                  </summary>
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-foreground">{item.message}</p>
                  <p className="mt-3 border-t border-border pt-3 text-sm text-muted-foreground">
                    <span className="font-semibold text-foreground">Remarks:</span> {item.remarks || 'None'}
                  </p>
                  {item.run_id ? (
                    <p className="mt-2 font-mono text-xs text-muted-foreground">Run: {item.run_id}</p>
                  ) : null}
                  {item.provider_summary ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Provider: {item.provider_code || 'unknown'} — {item.provider_summary}
                    </p>
                  ) : null}
                  {item.provider_message ? (
                    <p className="mt-2 rounded-lg bg-red-50 p-2 font-mono text-xs text-red-800">
                      {item.provider_message}
                    </p>
                  ) : null}
                </details>
              </article>
            );
          })}
        </div>
      </section>
    </main>
  );
}
