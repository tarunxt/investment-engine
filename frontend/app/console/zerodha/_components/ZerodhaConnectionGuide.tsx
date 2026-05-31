'use client';

import {
  CheckCircle2,
  Copy,
  ExternalLink,
  KeyRound,
  Loader2,
  ShieldCheck,
  Wrench,
} from 'lucide-react';

import { useClipboard } from '@/hooks/useClipboard';
import { Button } from '@/components/ui/button';

export function ZerodhaConnectionGuide({
  configured,
  loginUrl,
  redirectUrl,
  connecting,
  onQuickConnect,
  children,
}: {
  configured: boolean;
  loginUrl: string;
  redirectUrl: string;
  connecting: boolean;
  onQuickConnect: () => void;
  children?: React.ReactNode;
}) {
  const redirectClipboard = useClipboard();

  if (!configured) {
    return (
      <section className="flex flex-col gap-4">
        <div className="border border-amber-200 bg-amber-50 px-5 py-4 shadow-sm">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex size-9 items-center justify-center rounded-full bg-amber-100">
              <Wrench className="size-4 text-amber-700" />
            </div>
            <div className="flex-1">
              <h2 className="text-sm font-semibold text-amber-950">Finish one-time Zerodha setup</h2>
              <p className="mt-1 text-sm leading-6 text-amber-800">
                This workspace already knows how to talk to Zerodha. The server just needs your Kite Connect app
                credentials before users can sign in.
              </p>
            </div>
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
          <div className="border border-gray-200 bg-white px-5 py-5 shadow-sm">
            <div className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-gray-600" />
              <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Setup Steps</h3>
            </div>
            <ol className="mt-4 space-y-3 text-sm leading-6 text-gray-700">
              <li>1. Create or open your Kite Connect app in the Zerodha developer dashboard.</li>
              <li>2. Register this redirect URL in that app.</li>
              <li>3. Add the app credentials to the backend environment as `ZERODHA_API_KEY` and `ZERODHA_API_SECRET`.</li>
              <li>4. Restart the backend, then return here and click Connect with Zerodha.</li>
            </ol>
          </div>

          <div className="border border-gray-200 bg-slate-950 px-5 py-5 text-slate-100 shadow-sm">
            <div className="flex items-center gap-2">
              <KeyRound className="size-4 text-slate-300" />
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">Values To Use</h3>
            </div>

            <div className="mt-4 space-y-4">
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-slate-400">Redirect URL</p>
                <code className="mt-2 block break-all border border-slate-800 bg-slate-900 px-3 py-2 text-[11px] text-slate-100">
                  {redirectUrl}
                </code>
                <Button
                  variant="outline"
                  size="xs"
                  className="mt-2 border-slate-700 text-slate-100 hover:bg-slate-800"
                  onClick={() => {
                    void redirectClipboard.copy(redirectUrl);
                  }}
                >
                  <Copy className="size-3" />
                  {redirectClipboard.copied ? 'Copied' : 'Copy Redirect URL'}
                </Button>
              </div>

              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-slate-400">Backend `.env`</p>
                <code className="mt-2 block whitespace-pre-wrap border border-slate-800 bg-slate-900 px-3 py-2 text-[11px] text-slate-100">
                  ZERODHA_API_KEY=your_kite_connect_api_key{'\n'}
                  ZERODHA_API_SECRET=your_kite_connect_api_secret
                </code>
              </div>
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="border border-gray-200 bg-white px-5 py-5 shadow-sm">
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div>
            <h2 className="text-base font-semibold text-gray-950">Connect Zerodha</h2>
            <p className="mt-1 text-sm leading-6 text-gray-600">
              Sign in with Kite, let the app exchange the request token, and we&apos;ll start syncing your latest
              holdings snapshot automatically.
            </p>
          </div>
          <div className="inline-flex items-center gap-2 self-start border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700">
            <CheckCircle2 className="size-3.5" />
            Two connection options available
          </div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <div className="border border-emerald-200 bg-emerald-50 px-5 py-5 shadow-sm">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-emerald-700" />
            <h3 className="text-xs font-semibold uppercase tracking-wider text-emerald-800">Option 1: Quick Connect</h3>
          </div>
          <p className="mt-3 text-sm leading-6 text-emerald-900">
            Best for most users. This opens Zerodha in a small popup and returns you here after approval.
          </p>
          <ol className="mt-4 space-y-3 text-sm leading-6 text-emerald-950">
            <li>1. Click `Connect with Zerodha`.</li>
            <li>2. Log in to Kite and approve access for this app.</li>
            <li>3. Wait a few seconds while we refresh your connection and sync the newest portfolio snapshot.</li>
          </ol>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Button onClick={onQuickConnect} disabled={connecting || !loginUrl}>
              {connecting ? <Loader2 className="size-4 animate-spin" /> : <ExternalLink className="size-4" />}
              {connecting ? 'Waiting For Zerodha' : 'Connect With Zerodha'}
            </Button>
            {loginUrl ? (
              <a
                href={loginUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-emerald-700 hover:text-emerald-900"
              >
                Open full-page login <ExternalLink className="size-3" />
              </a>
            ) : (
              <span className="text-xs text-emerald-700">Login URL is still loading.</span>
            )}
          </div>
        </div>

        <div className="border border-blue-200 bg-blue-50 px-5 py-5 shadow-sm">
          <div className="flex items-center gap-2">
            <KeyRound className="size-4 text-blue-700" />
            <h3 className="text-xs font-semibold uppercase tracking-wider text-blue-800">Option 2: Manual Token</h3>
          </div>
          <p className="mt-3 text-sm leading-6 text-blue-900">
            Use this fallback if your browser blocks popups or if you want to handle the Kite login in a separate tab.
          </p>
          <ol className="mt-4 space-y-3 text-sm leading-6 text-blue-950">
            <li>1. Open the Zerodha login page in a new tab.</li>
            <li>2. Complete login and copy the `request_token` from the callback URL.</li>
            <li>3. Paste that token below and click `Connect`.</li>
          </ol>
          <div className="mt-5">{children}</div>
        </div>
      </div>
    </section>
  );
}
