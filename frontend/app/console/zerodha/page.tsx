'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Link2,
  Loader2,
  LogOut,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  Unplug,
} from 'lucide-react';
import { TradingViewSymbolLink } from '@/components/shared/TradingViewSymbolLink';
import { Button } from '@/components/ui/button';
import { PortfolioAnalysisNav } from '@/components/shared/PortfolioAnalysisNav';
import { apiService, APIError } from '@/services/api';
import { cn } from '@/lib/utils';
import { URLs } from '@/lib/urls';
import { PortfolioSnapshotsPanel } from './_components/PortfolioSnapshotsPanel';
import { ZerodhaConnectionGuide } from './_components/ZerodhaConnectionGuide';
import {
  type ZerodhaOrder,
  type ZerodhaPortfolioOverviewResponse,
  type ZerodhaPortfolioSnapshotDetail,
  type ZerodhaPlaceOrderRequest,
  type ZerodhaStatusResponse,
} from '@/types/api';

function normalizeError(err: unknown) {
  if (err instanceof APIError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}

function formatTs(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

const STATUS_COLORS: Record<string, string> = {
  COMPLETE: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  REJECTED: 'bg-red-50 text-red-700 ring-red-200',
  CANCELLED: 'bg-gray-50 text-gray-600 ring-gray-200',
  OPEN: 'bg-blue-50 text-blue-700 ring-blue-200',
  TRIGGER_PENDING: 'bg-amber-50 text-amber-700 ring-amber-200',
};

function StatusRevealButton({
  active,
  label,
  onClick,
  className,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="icon-sm"
      aria-expanded={active}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={className}
    >
      {children}
      <span className="sr-only">{label}</span>
    </Button>
  );
}

// ─── Place-order form ────────────────────────────────────────────────────────

const EXCHANGES = ['NSE', 'BSE', 'NFO', 'MCX'];
const PRODUCTS = ['CNC', 'MIS', 'NRML'];
const ORDER_TYPES = ['MARKET', 'LIMIT', 'SL', 'SL-M'];

function PlaceOrderForm({ onPlaced }: { onPlaced: () => void }) {
  const [form, setForm] = useState<ZerodhaPlaceOrderRequest>({
    tradingsymbol: '',
    exchange: 'NSE',
    transaction_type: 'BUY',
    order_type: 'MARKET',
    quantity: 1,
    product: 'CNC',
    validity: 'DAY',
    price: 0,
    trigger_price: 0,
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const set = (k: keyof ZerodhaPlaceOrderRequest, v: string | number) =>
    setForm((f) => ({ ...f, [k]: v }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiService.zerodhaPlaceOrder(form);
      setSuccess(`Order placed — ID: ${res.order_id}`);
      onPlaced();
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const needsPrice = form.order_type === 'LIMIT' || form.order_type === 'SL';
  const needsTrigger = form.order_type === 'SL' || form.order_type === 'SL-M';

  return (
    <form onSubmit={handleSubmit} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {/* Symbol */}
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Symbol</label>
        <input
          required
          placeholder="e.g. RELIANCE"
          value={form.tradingsymbol}
          onChange={(e) => set('tradingsymbol', e.target.value.toUpperCase())}
          className="border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {/* Exchange */}
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Exchange</label>
        <select
          value={form.exchange}
          onChange={(e) => set('exchange', e.target.value)}
          className="border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {EXCHANGES.map((x) => <option key={x}>{x}</option>)}
        </select>
      </div>

      {/* Transaction type */}
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Side</label>
        <div className="flex">
          {(['BUY', 'SELL'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => set('transaction_type', t)}
              className={cn(
                'flex-1 py-2 text-sm font-semibold transition-colors',
                t === 'BUY'
                  ? form.transaction_type === 'BUY'
                    ? 'bg-emerald-600 text-white'
                    : 'border border-gray-200 text-gray-600 hover:bg-gray-50'
                  : form.transaction_type === 'SELL'
                  ? 'bg-red-600 text-white'
                  : 'border border-gray-200 text-gray-600 hover:bg-gray-50',
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Order type */}
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Order type</label>
        <select
          value={form.order_type}
          onChange={(e) => set('order_type', e.target.value)}
          className="border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {ORDER_TYPES.map((x) => <option key={x}>{x}</option>)}
        </select>
      </div>

      {/* Product */}
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Product</label>
        <select
          value={form.product}
          onChange={(e) => set('product', e.target.value)}
          className="border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {PRODUCTS.map((x) => <option key={x}>{x}</option>)}
        </select>
      </div>

      {/* Quantity */}
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Quantity</label>
        <input
          type="number"
          min={1}
          required
          value={form.quantity}
          onChange={(e) => set('quantity', parseInt(e.target.value, 10) || 1)}
          className="border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {needsPrice && (
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Price</label>
          <input
            type="number"
            step="0.05"
            min={0}
            value={form.price}
            onChange={(e) => set('price', parseFloat(e.target.value) || 0)}
            className="border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      )}

      {needsTrigger && (
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Trigger price</label>
          <input
            type="number"
            step="0.05"
            min={0}
            value={form.trigger_price}
            onChange={(e) => set('trigger_price', parseFloat(e.target.value) || 0)}
            className="border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      )}

      {/* Messages + submit */}
      <div className="sm:col-span-2 lg:col-span-3 flex flex-col gap-3">
        {error && (
          <p className="flex items-center gap-2 text-sm text-red-700">
            <AlertCircle className="size-4 shrink-0" /> {error}
          </p>
        )}
        {success && (
          <p className="flex items-center gap-2 text-sm text-emerald-700">
            <CheckCircle2 className="size-4 shrink-0" /> {success}
          </p>
        )}
        <Button
          type="submit"
          disabled={submitting}
          className={cn(
            'self-start',
            form.transaction_type === 'BUY' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-red-600 hover:bg-red-700',
          )}
        >
          {submitting ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
          {form.transaction_type === 'BUY' ? 'Place Buy Order' : 'Place Sell Order'}
        </Button>
      </div>
    </form>
  );
}

// ─── Orders table ────────────────────────────────────────────────────────────

function OrdersTable({ orders }: { orders: ZerodhaOrder[] }) {
  if (orders.length === 0) {
    return <p className="py-8 text-center text-sm text-gray-400">No orders today.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">
            <th className="pb-2 pr-4">Symbol</th>
            <th className="pb-2 pr-4">Side</th>
            <th className="pb-2 pr-4">Type</th>
            <th className="pb-2 pr-4">Qty</th>
            <th className="pb-2 pr-4">Price</th>
            <th className="pb-2 pr-4">Avg</th>
            <th className="pb-2 pr-4">Status</th>
            <th className="pb-2">Time</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
	          {orders.map((o) => (
	            <tr key={o.order_id} className="hover:bg-gray-50">
	              <td className="py-2.5 pr-4 font-medium text-gray-900">
	                <TradingViewSymbolLink
	                  symbol={o.tradingsymbol}
	                  market="india"
	                  exchange={o.exchange}
	                  className="hover:text-blue-700"
	                >
	                  <span className="underline-offset-4 hover:underline">{o.tradingsymbol}</span>
	                </TradingViewSymbolLink>
	                <span className="ml-1 text-xs text-gray-400">{o.exchange}</span>
	              </td>
              <td className="py-2.5 pr-4">
                {o.transaction_type === 'BUY' ? (
                  <span className="inline-flex items-center gap-1 text-emerald-600">
                    <TrendingUp className="size-3" /> BUY
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-red-600">
                    <TrendingDown className="size-3" /> SELL
                  </span>
                )}
              </td>
              <td className="py-2.5 pr-4 text-gray-600">{o.order_type}</td>
              <td className="py-2.5 pr-4 text-gray-700">
                {o.filled_quantity}/{o.quantity}
              </td>
              <td className="py-2.5 pr-4 text-gray-700">{o.price > 0 ? o.price.toFixed(2) : 'MKT'}</td>
              <td className="py-2.5 pr-4 text-gray-700">
                {o.average_price > 0 ? o.average_price.toFixed(2) : '—'}
              </td>
              <td className="py-2.5 pr-4">
                <span
                  className={cn(
                    'inline-flex items-center px-2 py-0.5 text-xs font-semibold capitalize ring-1',
                    STATUS_COLORS[o.status] ?? 'bg-gray-50 text-gray-600 ring-gray-200',
                  )}
                >
                  {o.status}
                </span>
              </td>
              <td className="py-2.5 text-xs text-gray-400">{formatTs(o.order_timestamp)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Manual token exchange ───────────────────────────────────────────────────

function ManualTokenForm({ onConnected }: { onConnected: () => void }) {
  const [token, setToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const t = token.trim();
    if (!t) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiService.zerodhaCallback(t);
      onConnected();
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="border border-blue-200 bg-white px-5 py-4 shadow-sm">
      <p className="mb-3 text-xs leading-6 text-blue-700">
        After logging in via Kite, copy the <code className="font-mono">request_token</code> from the
        redirect URL (e.g. <code className="font-mono text-[11px]">…?request_token=abc123&amp;status=success</code>) and paste it below.
      </p>
      <form onSubmit={handleSubmit} className="flex items-start gap-2">
        <input
          required
          placeholder="Paste request_token here"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="flex-1 border border-gray-200 bg-white px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <Button type="submit" size="sm" disabled={submitting || !token.trim()}>
          {submitting ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
          Connect
        </Button>
      </form>
      {error && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-red-700">
          <AlertCircle className="size-3.5 shrink-0" /> {error}
        </p>
      )}
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function ZerodhaPage() {
  const [status, setStatus] = useState<ZerodhaStatusResponse | null>(null);
  const [loginUrl, setLoginUrl] = useState('');
  const [configured, setConfigured] = useState(true);
  const [orders, setOrders] = useState<ZerodhaOrder[]>([]);
  const [portfolioOverview, setPortfolioOverview] = useState<ZerodhaPortfolioOverviewResponse | null>(null);
  const [selectedSnapshot, setSelectedSnapshot] = useState<ZerodhaPortfolioSnapshotDetail | null>(null);
  const [selectedSnapshotDate, setSelectedSnapshotDate] = useState<string | null>(null);

  const [loadingStatus, setLoadingStatus] = useState(true);
  const [loadingPortfolio, setLoadingPortfolio] = useState(true);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [selectingSnapshot, setSelectingSnapshot] = useState(false);
  const [syncingPortfolio, setSyncingPortfolio] = useState(false);
  const [connectingPopup, setConnectingPopup] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [portfolioError, setPortfolioError] = useState<string | null>(null);
  const [showOrderForm, setShowOrderForm] = useState(false);
  const [showConnectionDetails, setShowConnectionDetails] = useState(false);
  const [showRedirectDetails, setShowRedirectDetails] = useState(false);
  const popupRef = useRef<Window | null>(null);
  const popupPollRef = useRef<number | null>(null);

  const stopPopupTracking = useCallback((updateState = true) => {
    if (popupPollRef.current !== null) {
      window.clearInterval(popupPollRef.current);
      popupPollRef.current = null;
    }
    popupRef.current = null;
    if (updateState) {
      setConnectingPopup(false);
    }
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const [s, urlRes] = await Promise.all([
        apiService.zerodhaStatus(),
        apiService.zerodhaLoginUrl(),
      ]);
      setStatus(s);
      setLoginUrl(urlRes.login_url);
      setConfigured(urlRes.configured);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  const applyPortfolioOverview = useCallback(
    (overview: ZerodhaPortfolioOverviewResponse) => {
      setPortfolioOverview(overview);

      const availableDates = new Set(overview.history.map((snapshot) => snapshot.snapshot_date));
      if (!selectedSnapshotDate || !availableDates.has(selectedSnapshotDate)) {
        setSelectedSnapshotDate(overview.latest?.snapshot_date ?? null);
        setSelectedSnapshot(overview.latest);
        return;
      }

      if (overview.latest?.snapshot_date === selectedSnapshotDate) {
        setSelectedSnapshot(overview.latest);
      }
    },
    [selectedSnapshotDate],
  );

  const fetchPortfolioOverview = useCallback(async () => {
    setLoadingPortfolio(true);
    setPortfolioError(null);
    try {
      const overview = await apiService.zerodhaPortfolioOverview();
      applyPortfolioOverview(overview);
    } catch (err) {
      setPortfolioError(normalizeError(err));
    } finally {
      setLoadingPortfolio(false);
    }
  }, [applyPortfolioOverview]);

  const fetchOrders = useCallback(async () => {
    setLoadingOrders(true);
    try {
      const res = await apiService.zerodhaOrders();
      setOrders(res.data);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoadingOrders(false);
    }
  }, []);

  const pollPortfolioOverview = useCallback(
    async (baselineCapturedAt: string | null) => {
      setSyncingPortfolio(true);
      setPortfolioError(null);

      try {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          await sleep(attempt === 0 ? 1500 : 2000);
          const overview = await apiService.zerodhaPortfolioOverview();
          applyPortfolioOverview(overview);

          const latestCapturedAt = overview.latest?.captured_at ?? null;
          if (latestCapturedAt && latestCapturedAt !== baselineCapturedAt) {
            return;
          }
        }
      } catch (err) {
        setPortfolioError(normalizeError(err));
      } finally {
        setSyncingPortfolio(false);
      }
    },
    [applyPortfolioOverview],
  );

  const handleSyncPortfolio = useCallback(async () => {
    const baselineCapturedAt = portfolioOverview?.latest?.captured_at ?? null;
    setPortfolioError(null);

    try {
      await apiService.zerodhaSyncPortfolio();
    } catch (err) {
      setPortfolioError(normalizeError(err));
      return;
    }

    await pollPortfolioOverview(baselineCapturedAt);
  }, [pollPortfolioOverview, portfolioOverview?.latest?.captured_at]);

  const handlePopupConnect = useCallback(() => {
    if (!loginUrl) {
      setError('Zerodha login URL is not ready yet. Please retry in a moment.');
      return;
    }

    setError(null);
    setConnectingPopup(true);

    const width = 560;
    const height = 760;
    const left = Math.max(window.screenX + (window.outerWidth - width) / 2, 0);
    const top = Math.max(window.screenY + (window.outerHeight - height) / 2, 0);
    const popup = window.open(
      loginUrl,
      'zerodha-connect',
      `popup=yes,width=${width},height=${height},left=${Math.round(left)},top=${Math.round(top)}`,
    );

    if (!popup) {
      setConnectingPopup(false);
      setError('Popup blocked. Allow popups for this site or use the manual token option below.');
      return;
    }

    popupRef.current = popup;
    popup.focus();

    if (popupPollRef.current !== null) {
      window.clearInterval(popupPollRef.current);
    }

    popupPollRef.current = window.setInterval(() => {
      if (popupRef.current?.closed) {
        stopPopupTracking();
      }
    }, 500);
  }, [loginUrl, stopPopupTracking]);

  const handleSelectSnapshot = useCallback(
    async (snapshotDate: string) => {
      if (snapshotDate === selectedSnapshotDate && selectedSnapshot) {
        return;
      }

      setSelectingSnapshot(true);
      setPortfolioError(null);
      setSelectedSnapshotDate(snapshotDate);

      try {
        if (portfolioOverview?.latest?.snapshot_date === snapshotDate && portfolioOverview.latest) {
          setSelectedSnapshot(portfolioOverview.latest);
          return;
        }

        const snapshot = await apiService.zerodhaPortfolioSnapshot(snapshotDate);
        setSelectedSnapshot(snapshot);
      } catch (err) {
        setPortfolioError(normalizeError(err));
      } finally {
        setSelectingSnapshot(false);
      }
    },
    [portfolioOverview, selectedSnapshot, selectedSnapshotDate],
  );

  // Handle postMessage from the callback window or embedded callback page.
  useEffect(() => {
    const handler = (ev: MessageEvent) => {
      if (ev.origin !== window.location.origin) return;
      if (ev.data?.type === 'zerodha_connected') {
        stopPopupTracking();
        const baselineCapturedAt = portfolioOverview?.latest?.captured_at ?? null;
        fetchStatus().then(() => {
          fetchOrders();
          pollPortfolioOverview(baselineCapturedAt);
        });
      } else if (ev.data?.type === 'zerodha_error') {
        stopPopupTracking();
        setError(ev.data.message ?? 'Zerodha login failed');
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [fetchOrders, fetchStatus, pollPortfolioOverview, portfolioOverview?.latest?.captured_at, stopPopupTracking]);

  useEffect(
    () => () => {
      stopPopupTracking(false);
    },
    [stopPopupTracking],
  );

  useEffect(() => {
    const load = async () => {
      await fetchStatus();
      await fetchPortfolioOverview();
    };

    void load();
  }, [fetchPortfolioOverview, fetchStatus]);

  useEffect(() => {
    if (!status?.connected) return;

    const loadOrders = async () => {
      await fetchOrders();
    };

    void loadOrders();
  }, [status?.connected, fetchOrders]);

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await apiService.zerodhaDisconnect();
      setStatus((current) => ({
        connected: false,
        login_time: null,
        expires_at: null,
        last_portfolio_sync_at: current?.last_portfolio_sync_at ?? null,
        last_portfolio_snapshot_date: current?.last_portfolio_snapshot_date ?? null,
      }));
      setOrders([]);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setDisconnecting(false);
    }
  };

  if (loadingStatus) {
    return (
      <div className="flex items-center gap-3 text-sm text-gray-500">
        <Loader2 className="size-4 animate-spin" />
        Loading Zerodha status…
      </div>
    );
  }

  return (
    <div className="mx-auto flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="inline-flex items-start gap-1">
            <h1 className="text-lg font-semibold tracking-tight text-gray-950">Zerodha</h1>
            {status?.connected && (
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={handleDisconnect}
                disabled={disconnecting}
                aria-label="Disconnect Zerodha"
                title="Disconnect Zerodha"
                className="-mt-1 text-red-600 hover:text-red-700"
              >
                {disconnecting ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Unplug className="size-3" />
                )}
                <span className="sr-only">Disconnect</span>
              </Button>
            )}
          </div>
          <p className="text-sm text-gray-500">
            Kite Connect integration — save daywise portfolio history and manage orders
          </p>
        </div>
        <div className="flex items-center gap-2">
          <PortfolioAnalysisNav portfolio="zerodha" active="portfolio" />
        </div>
      </div>

      {/* Not configured warning */}
      {!configured && (
        <div className="flex items-start gap-3 border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>
            Zerodha is not configured. Add <code className="font-mono text-xs">ZERODHA_API_KEY</code> and{' '}
            <code className="font-mono text-xs">ZERODHA_API_SECRET</code> to your backend <code className="font-mono text-xs">.env</code> file.
          </span>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="flex items-start gap-3 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-auto text-red-600 hover:text-red-800">✕</button>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <StatusRevealButton
          active={showConnectionDetails}
          label={status?.connected ? 'Show Zerodha connection details' : 'Show Zerodha login status'}
          onClick={() => setShowConnectionDetails((current) => !current)}
          className={cn(
            status?.connected
              ? 'border-emerald-200 text-emerald-700 hover:bg-emerald-50'
              : 'border-gray-200 text-gray-600 hover:bg-gray-100',
          )}
        >
          {status?.connected ? <CheckCircle2 className="size-4" /> : <LogOut className="size-4" />}
        </StatusRevealButton>
        {configured ? (
          <StatusRevealButton
            active={showRedirectDetails}
            label="Show Zerodha redirect URL details"
            onClick={() => setShowRedirectDetails((current) => !current)}
            className="border-blue-200 text-blue-700 hover:bg-blue-50"
          >
            <Link2 className="size-4" />
          </StatusRevealButton>
        ) : null}
      </div>

      {showConnectionDetails ? (
        <div
          className={cn(
            'flex items-center gap-3 border px-4 py-3 text-sm',
            status?.connected
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-gray-200 bg-gray-50 text-gray-600',
          )}
        >
          {status?.connected ? (
            <>
              <CheckCircle2 className="size-4 shrink-0 text-emerald-600" />
              <div>
                <span className="font-medium">Connected to Zerodha</span>
                <span className="ml-2 text-xs text-emerald-600">
                  Session expires {formatTs(status.expires_at)}
                </span>
              </div>
            </>
          ) : (
            <>
              <LogOut className="size-4 shrink-0 text-gray-400" />
              <span>Not connected — log in below to get started.</span>
            </>
          )}
        </div>
      ) : null}

      {configured && showRedirectDetails ? (
        <div className="border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          Register this redirect URL in your Kite app:{' '}
          <code className="font-mono text-xs">{`${URLs.frontend}/zerodha/callback`}</code>
        </div>
      ) : null}

      {!status?.connected && (
        <ZerodhaConnectionGuide
          configured={configured}
          loginUrl={loginUrl}
          redirectUrl={`${URLs.frontend}/zerodha/callback`}
          connecting={connectingPopup}
          onQuickConnect={handlePopupConnect}
        >
          {configured ? (
            <ManualTokenForm
              onConnected={() => {
                const baselineCapturedAt = portfolioOverview?.latest?.captured_at ?? null;
                fetchStatus().then(() => {
                  fetchOrders();
                  pollPortfolioOverview(baselineCapturedAt);
                });
              }}
            />
          ) : null}
        </ZerodhaConnectionGuide>
      )}

      <PortfolioSnapshotsPanel
        connected={Boolean(status?.connected)}
        overview={portfolioOverview}
        selectedSnapshot={selectedSnapshot}
        selectedSnapshotDate={selectedSnapshotDate}
        loading={loadingPortfolio}
        selecting={selectingSnapshot}
        syncing={syncingPortfolio}
        error={portfolioError}
        onSelectSnapshot={handleSelectSnapshot}
        onSync={handleSyncPortfolio}
      />

      {/* Connected — orders + place order */}
      {status?.connected && (
        <>
          {/* Place order section */}
          <div className="border border-gray-200 bg-white shadow-sm">
            <button
              onClick={() => setShowOrderForm((v) => !v)}
              className="flex w-full items-center justify-between border-b border-gray-200 px-5 py-3 text-left"
            >
              <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">
                Place Order
              </span>
              {showOrderForm ? (
                <ChevronUp className="size-4 text-gray-400" />
              ) : (
                <ChevronDown className="size-4 text-gray-400" />
              )}
            </button>
            {showOrderForm && (
              <div className="p-5">
                <PlaceOrderForm onPlaced={fetchOrders} />
              </div>
            )}
          </div>

          {/* Orders table */}
          <div className="border border-gray-200 bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3">
              <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">
                Today&apos;s Orders
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={fetchOrders}
                disabled={loadingOrders}
              >
                <RefreshCw className={cn('size-3.5', loadingOrders && 'animate-spin')} />
              </Button>
            </div>
            <div className="p-5">
              {loadingOrders ? (
                <div className="flex items-center gap-2 text-sm text-gray-400">
                  <Loader2 className="size-4 animate-spin" /> Loading orders…
                </div>
              ) : (
                <OrdersTable orders={orders} />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
