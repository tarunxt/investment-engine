'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  ExternalLink,
  Loader2,
  LogOut,
  Save,
  Sparkles,
  Unplug,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiService, APIError } from '@/services/api';
import { useClipboard } from '@/hooks/useClipboard';
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
  const [redirectUri, setRedirectUri] = useState('');
  const [configured, setConfigured] = useState(true);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [savingSheet, setSavingSheet] = useState(false);
  const [creatingSheet, setCreatingSheet] = useState(false);
  const [sheetUrlInput, setSheetUrlInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const { copy, copied } = useClipboard();

  const fetchStatus = useCallback(async () => {
    try {
      const [s, urlRes] = await Promise.all([
        apiService.googleSheetsStatus(),
        apiService.googleSheetsAuthUrl(),
      ]);
      setStatus(s);
      setAuthUrl(urlRes.auth_url);
      setConfigured(urlRes.configured);
      setRedirectUri(urlRes.redirect_uri ?? '');
      setSheetUrlInput(s.default_spreadsheet_url ?? '');
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoadingStatus(false);
      setConnecting(false);
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
        setSuccess('Google Sheets connected. Your personal sheet is ready to use.');
        setError(null);
        setConnecting(false);
        fetchStatus();
      } else if (ev.data?.type === 'google_sheets_error') {
        setConnecting(false);
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
      setStatus((prev) =>
        prev
          ? {
              ...prev,
              connected: false,
              token_expiry: null,
            }
          : { connected: false, token_expiry: null, default_spreadsheet_url: null },
      );
      setSuccess('Google Sheets disconnected.');
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setDisconnecting(false);
    }
  };

  const handleConnect = async () => {
    if (!authUrl) return;
    setConnecting(true);
    setSuccess(null);
    setError(null);

    try {
      const width = 520;
      const height = 680;
      const left = window.screenX + (window.outerWidth - width) / 2;
      const top = window.screenY + (window.outerHeight - height) / 2;
      const popup = window.open(
        authUrl,
        'google_sheets_auth',
        `width=${width},height=${height},left=${left},top=${top}`,
      );

      if (popup) {
        popup.focus();
        return;
      }

      window.open(authUrl, '_blank', 'noopener,noreferrer');
      setConnecting(false);
    } catch (err) {
      setError(normalizeError(err));
      setConnecting(false);
    }
  };

  const handleCopy = async (text: string, message: string) => {
    if (!text) return;
    const ok = await copy(text);
    if (ok) {
      setSuccess(message);
      setError(null);
    }
  };

  const saveDefaultSheet = async (mode: 'save' | 'create') => {
    const trimmedUrl = sheetUrlInput.trim();

    if (mode === 'save' && !trimmedUrl) {
      setError('Paste a Google Sheets URL first, or create a fresh personal sheet.');
      setSuccess(null);
      return;
    }

    if (mode === 'save') {
      setSavingSheet(true);
    } else {
      setCreatingSheet(true);
    }
    setError(null);
    setSuccess(null);

    try {
      const res = await apiService.googleSheetsSaveDefaultSheet(
        mode === 'save' ? { spreadsheet_url: trimmedUrl } : {},
      );
      setSheetUrlInput(res.spreadsheet_url);
      setStatus((prev) =>
        prev
          ? { ...prev, default_spreadsheet_url: res.spreadsheet_url }
          : {
              connected: true,
              token_expiry: null,
              default_spreadsheet_url: res.spreadsheet_url,
            },
      );
      setSuccess(
        res.created_new
          ? 'Created a fresh personal Google Sheet for this user.'
          : 'Saved this Google Sheet as the user default.',
      );
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setSavingSheet(false);
      setCreatingSheet(false);
    }
  };

  if (loadingStatus) {
    return (
      <div className="flex items-center gap-3 text-sm text-gray-500">
        <Loader2 className="size-4 animate-spin" />
        Loading Google Sheets status...
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 border border-gray-200 bg-white p-6 shadow-sm lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold tracking-tight text-gray-950">
            Google Sheets Integration
          </h1>
          <p className="text-sm text-gray-500">
            Each user can connect Google once and export into their own personal sheet.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {status?.connected && status.default_spreadsheet_url && (
            <>
              <Button asChild variant="outline" size="sm">
                <a
                  href={status.default_spreadsheet_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink className="mr-2 size-3.5" />
                  Open Sheet
                </a>
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  handleCopy(
                    status.default_spreadsheet_url ?? '',
                    'Copied personal sheet URL.',
                  )
                }
              >
                <Copy className="mr-2 size-3.5" />
                {copied ? 'Copied' : 'Copy URL'}
              </Button>
            </>
          )}
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
      </div>

      {!configured && (
        <div className="border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <div className="flex-1 space-y-3">
              <p className="font-medium text-amber-900">
                Google login is not enabled on this deployment yet.
              </p>
              <p>
                Add <code className="font-mono text-xs">GOOGLE_CLIENT_ID</code> and{' '}
                <code className="font-mono text-xs">GOOGLE_CLIENT_SECRET</code> to the backend,
                then register this redirect URI in Google Cloud:
              </p>
              {redirectUri ? (
                <div className="flex flex-col gap-2 lg:flex-row">
                  <Input value={redirectUri} readOnly className="bg-white text-sm" />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleCopy(redirectUri, 'Copied redirect URI.')}
                  >
                    <Copy className="mr-2 size-3.5" />
                    {copied ? 'Copied' : 'Copy URI'}
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-3 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            className="ml-auto text-red-600 hover:text-red-800"
          >
            x
          </button>
        </div>
      )}

      {success && (
        <div className="flex items-start gap-3 border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
          <span>{success}</span>
          <button
            onClick={() => setSuccess(null)}
            className="ml-auto text-emerald-700 hover:text-emerald-900"
          >
            x
          </button>
        </div>
      )}

      <div
        className={cn(
          'flex items-center gap-3 border px-4 py-3',
          status?.connected
            ? 'border-emerald-200 bg-emerald-50'
            : 'border-gray-200 bg-gray-50',
        )}
      >
        {status?.connected ? (
          <>
            <CheckCircle2 className="size-4 text-emerald-600" />
            <div className="text-sm">
              <span className="font-medium text-emerald-800">
                Connected to Google Sheets
              </span>
              {status.token_expiry && (
                <span className="ml-2 text-xs text-emerald-600">
                  Token expires{' '}
                  {new Date(status.token_expiry).toLocaleDateString()}
                </span>
              )}
            </div>
          </>
        ) : (
          <>
            <LogOut className="size-4 text-gray-400" />
            <span className="text-sm text-gray-600">
              {configured
                ? 'Not connected. Log in once to create the user personal sheet.'
                : 'Waiting for Google app credentials.'}
            </span>
          </>
        )}
      </div>

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
                Open in new tab
                <ExternalLink className="size-3" />
              </a>
            )}
          </div>
          <div className="space-y-3 p-5">
            <p className="text-sm text-gray-600">
              After login we create a dedicated default Google Sheet for this user automatically.
            </p>
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

      {status?.connected && (
        <div className="border border-gray-200 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-gray-950">Personal Export Sheet</h2>
              <p className="text-sm text-gray-500">
                New exports will use this sheet by default. Every user keeps a separate sheet.
              </p>
            </div>
            {status.default_spreadsheet_url && (
              <Button asChild variant="outline" size="sm">
                <a
                  href={status.default_spreadsheet_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink className="mr-2 size-3.5" />
                  Open Current Sheet
                </a>
              </Button>
            )}
          </div>

          <div className="mt-5 space-y-3">
            <label className="text-xs font-semibold uppercase tracking-wider text-gray-500">
              Default Sheet URL
            </label>
            <div className="flex flex-col gap-3 xl:flex-row">
              <Input
                value={sheetUrlInput}
                onChange={(e) => setSheetUrlInput(e.target.value)}
                placeholder="https://docs.google.com/spreadsheets/d/..."
                className="text-sm"
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => saveDefaultSheet('save')}
                  disabled={savingSheet}
                >
                  {savingSheet ? (
                    <Loader2 className="mr-2 size-3.5 animate-spin" />
                  ) : (
                    <Save className="mr-2 size-3.5" />
                  )}
                  Save URL
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => saveDefaultSheet('create')}
                  disabled={creatingSheet}
                >
                  {creatingSheet ? (
                    <Loader2 className="mr-2 size-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="mr-2 size-3.5" />
                  )}
                  Create New Sheet
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    handleCopy(sheetUrlInput.trim(), 'Copied personal sheet URL.')
                  }
                  disabled={!sheetUrlInput.trim()}
                >
                  <Copy className="mr-2 size-3.5" />
                  {copied ? 'Copied' : 'Copy URL'}
                </Button>
              </div>
            </div>
            <p className="text-xs text-gray-500">
              Paste any Google Sheet you want to reuse, or create a fresh one for this user in one click.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
