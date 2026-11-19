'use client';

import { onWorkflowOwnerInvalidated } from '@/lib/workflowOwnerLifetime';
import { acquireZerodhaLogin } from '@/lib/zerodhaLoginArbitration';
import { BrokerPortfolioTabs } from '@/app/console/_components/BrokerPortfolioTabs';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Link2,
  Loader2,
  LogOut,
  Unplug,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiService, APIError } from '@/services/api';
import { cn } from '@/lib/utils';
import { URLs } from '@/lib/urls';
import { PortfolioSnapshotsPanel } from './_components/PortfolioSnapshotsPanel';
import { ZerodhaConnectionGuide } from './_components/ZerodhaConnectionGuide';
import {
  type ZerodhaPortfolioOverviewResponse,
  type ZerodhaPortfolioSnapshotDetail,
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
  const [portfolioOverview, setPortfolioOverview] = useState<ZerodhaPortfolioOverviewResponse | null>(null);
  const [selectedSnapshot, setSelectedSnapshot] = useState<ZerodhaPortfolioSnapshotDetail | null>(null);
  const [selectedSnapshotDate, setSelectedSnapshotDate] = useState<string | null>(null);

  const [loadingStatus, setLoadingStatus] = useState(true);
  const [loadingPortfolio, setLoadingPortfolio] = useState(true);
  const [selectingSnapshot, setSelectingSnapshot] = useState(false);
  const [syncingPortfolio, setSyncingPortfolio] = useState(false);
  const [connectingPopup, setConnectingPopup] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [portfolioError, setPortfolioError] = useState<string | null>(null);
  const [showConnectionDetails, setShowConnectionDetails] = useState(false);
  const [showRedirectDetails, setShowRedirectDetails] = useState(false);
  const popupRef = useRef<Window | null>(null);
  const popupPollRef = useRef<number | null>(null);
  const loginReleaseRef = useRef<(() => void) | null>(null);

  const stopPopupTracking = useCallback((updateState = true) => {
    if (popupPollRef.current !== null) {
      window.clearInterval(popupPollRef.current);
      popupPollRef.current = null;
    }
    popupRef.current = null;
    loginReleaseRef.current?.();
    loginReleaseRef.current = null;
    if (updateState) {
      setConnectingPopup(false);
    }
  }, []);

  useEffect(() => onWorkflowOwnerInvalidated(() => {
    popupRef.current?.close();
    stopPopupTracking();
  }), [stopPopupTracking]);

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

    const release = acquireZerodhaLogin();
    if (!release) { setError("Another Zerodha sign-in is already open. Complete or close it before retrying."); return; }
    loginReleaseRef.current = release;
    setError(null);
    setConnectingPopup(true);

    const width = 560;
    const height = 760;
    const left = Math.max(window.screenX + (window.outerWidth - width) / 2, 0);
    const top = Math.max(window.screenY + (window.outerHeight - height) / 2, 0);
    const popup = window.open(
      loginUrl,
      'zerodha-portfolio-connect',
      `popup=yes,width=${width},height=${height},left=${Math.round(left)},top=${Math.round(top)}`,
    );

    if (!popup) {
      stopPopupTracking();
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
      if (!popupRef.current || ev.source !== popupRef.current) return;
      if (ev.data?.type === 'zerodha_connected') {
        stopPopupTracking();
        const baselineCapturedAt = portfolioOverview?.latest?.captured_at ?? null;
        fetchStatus().then(() => {
          pollPortfolioOverview(baselineCapturedAt);
        });
      } else if (ev.data?.type === 'zerodha_error') {
        stopPopupTracking();
        setError(ev.data.message ?? 'Zerodha login failed');
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [fetchStatus, pollPortfolioOverview, portfolioOverview?.latest?.captured_at, stopPopupTracking]);

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
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setDisconnecting(false);
    }
  };

  // The initial status placeholder can delay mounting a bookmarked fragment target.
  useEffect(() => {
    if (loadingStatus) return;
    const id = window.location.hash.slice(1);
    if (id !== 'saved-portfolio-snapshots' && id !== 'portfolio-top') return;
    const target = document.getElementById(id);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView();
  }, [loadingStatus]);

  if (loadingStatus) {
    return (
      <div className="flex items-center gap-3 text-sm text-gray-500">
        <Loader2 className="size-4 animate-spin" />
        Loading India Portfolio · Zerodha status…
      </div>
    );
  }

  return (
    <BrokerPortfolioTabs market="zerodha">
      <div className="mx-auto flex flex-col gap-6">
        {/* Header */}
        <header id="portfolio-top" tabIndex={-1} className="flex scroll-mt-6 flex-col gap-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-950">
          <div>
            <div className="inline-flex items-start gap-1">
              <h1 className="text-lg font-semibold tracking-tight text-gray-950">India Portfolio · Zerodha</h1>
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
            <p className="flex flex-wrap gap-x-2 text-sm text-gray-500">
              <span>India</span>
              <span aria-hidden="true">·</span>
              <span>
                {selectedSnapshot
                  ? `Saved snapshot ${new Date(`${selectedSnapshot.snapshot_date}T00:00:00+05:30`).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium' })}`
                  : loadingPortfolio
                    ? 'Loading saved snapshots…'
                    : portfolioError
                      ? 'Saved snapshot status unavailable'
                      : 'No saved snapshot'}
              </span>
              <span aria-hidden="true">·</span>
              <span>{status ? (status.connected ? 'Connected' : 'Not connected') : 'Connection status unavailable'}</span>
            </p>
          </div>
        </header>

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
                ? 'border-emerald-200 text-emerald-700 hover:bg-emerald-50 focus-visible:bg-emerald-50'
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
              className="border-blue-200 text-blue-700 hover:bg-blue-50 focus-visible:bg-blue-50"
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
                <span>Not connected. Saved snapshots remain available; open connection guidance to sign in.</span>
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
          <details className="border border-gray-200 bg-white">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-gray-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-950">
              Connection guidance
              <span className="ml-2 text-xs font-normal text-gray-500">Review login options separately from saved data</span>
            </summary>
            <div className="border-t border-gray-200 p-4">
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
                        pollPortfolioOverview(baselineCapturedAt);
                      });
                    }}
                  />
                ) : null}
              </ZerodhaConnectionGuide>
            </div>
          </details>
        )}

        <section
          id="saved-portfolio-snapshots"
          aria-label="Saved portfolio snapshots"
          tabIndex={-1}
          className="scroll-mt-6 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-950"
        >
          {portfolioError && !selectedSnapshot && !loadingPortfolio ? (
            <div role="alert" className="border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-800">
              <h2 className="font-semibold">Saved snapshots unavailable</h2>
              <p className="mt-1">{portfolioError}</p>
              <p className="mt-1">Saved data could not be loaded. This does not mean it was erased.</p>
            </div>
          ) : (
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
          )}
        </section>
      </div>
    </BrokerPortfolioTabs>
  );
}
