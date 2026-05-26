'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  LogOut,
  Unplug,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiService, APIError } from '@/services/api';
import { cn } from '@/lib/utils';
import type { GoogleSheetsStatusResponse } from '@/types/api';

function normalizeError(err: unknown) {
  if (err instanceof APIError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}

export default function GoogleSheetsPanel() {
  const [status, setStatus] = useState<GoogleSheetsStatusResponse | null>(null);
  const [authUrl, setAuthUrl] = useState('');
  const [configured, setConfigured] = useState(true);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const [s, urlRes] = await Promise.all([
        apiService.googleSheetsStatus(),
        apiService.googleSheetsAuthUrl(),
      ]);
      setStatus(s);
      setAuthUrl(urlRes.auth_url);
      setConfigured(urlRes.configured);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    const handler = (ev: MessageEvent) => {
      if (ev.origin !== window.location.origin) return;
      if (ev.data?.type === 'google_sheets_connected') {
        fetchStatus();
        setError(null);
      } else if (ev.data?.type === 'google_sheets_error') {
        setError(ev.data.message ?? 'Google Sheets login failed');
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [fetchStatus]);

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await apiService.googleSheetsDisconnect();
      setStatus({ connected: false, token_expiry: null });
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setDisconnecting(false);
    }
  };

  const handleConnect = async () => {
    if (!authUrl) return;
    setConnecting(true);
    setError(null);

    try {
      const width = 500;
      const height = 600;
      const left = window.screenX + (window.outerWidth - width) / 2;
      const top = window.screenY + (window.outerHeight - height) / 2;

      window.open(authUrl, 'google_sheets_auth', `width=${width},height=${height},left=${left},top=${top}`);

      // The popup will post a message back when done
      // The message handler above will capture it
    } catch (err) {
      setError(normalizeError(err));
      setConnecting(false);
    }
  };

  if (loadingStatus) {
    return (
      <div className="flex items-center gap-3 text-sm text-gray-500">
        <Loader2 className="size-4 animate-spin" />
        Loading Google Sheets status…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-gray-950">
            Google Sheets Integration
          </h1>
          <p className="text-sm text-gray-500">
            Export investment analysis to Google Sheets
          </p>
        </div>
        {status?.connected && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleDisconnect}
            disabled={disconnecting}
            className="text-red-600 hover:text-red-700"
          >
            {disconnecting ? (
              <Loader2 className="mr-2 size-3.5 animate-spin" />
            ) : (
              <Unplug className="mr-2 size-3.5" />
            )}
            Disconnect
          </Button>
        )}
      </div>

      {/* Not configured warning */}
      {!configured && (
        <div className="flex items-start gap-3 border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>
            Google Sheets is not configured. Add{' '}
            <code className="font-mono text-xs">GOOGLE_CLIENT_ID</code> and{' '}
            <code className="font-mono text-xs">GOOGLE_CLIENT_SECRET</code> to your
            backend <code className="font-mono text-xs">.env</code> file.
          </span>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="flex items-start gap-3 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            className="ml-auto text-red-600 hover:text-red-800"
          >
            ✕
          </button>
        </div>
      )}

      {/* Connection status banner */}
      <div
        className={cn(
          'flex items-center gap-3 border px-4 py-3',
          status?.connected ? 'border-emerald-200 bg-emerald-50' : 'border-gray-200 bg-gray-50'
        )}
      >
        {status?.connected ? (
          <>
            <CheckCircle2 className="size-4 text-emerald-600" />
            <div className="text-sm">
              <span className="font-medium text-emerald-800">Connected to Google Sheets</span>
              {status.token_expiry && (
                <span className="ml-2 text-emerald-600 text-xs">
                  Token expires {new Date(status.token_expiry).toLocaleDateString()}
                </span>
              )}
            </div>
          </>
        ) : (
          <>
            <LogOut className="size-4 text-gray-400" />
            <span className="text-sm text-gray-600">
              Not connected — log in below to get started.
            </span>
          </>
        )}
      </div>

      {/* Login button (shown when not connected and configured) */}
      {!status?.connected && configured && (
        <div className="border border-gray-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">
              Login with Google
            </span>
            {authUrl && (
              <a
                href={authUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800"
              >
                Open in new tab →
              </a>
            )}
          </div>
          <div className="p-5">
            {authUrl ? (
              <Button
                onClick={handleConnect}
                disabled={connecting}
                className="bg-blue-600 hover:bg-blue-700"
              >
                {connecting && <Loader2 className="mr-2 size-4 animate-spin" />}
                Connect Google Sheets
              </Button>
            ) : (
              <p className="text-sm text-gray-500">Failed to load Google login</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
