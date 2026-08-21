'use client';

import { useEffect, useRef, useState } from 'react';
import { use } from 'react';
import { apiService } from '@/services/api';

export default function ZerodhaCallbackPage({
  searchParams,
}: {
  searchParams: Promise<{ request_token?: string; status?: string; message?: string }>;
}) {
  const params = use(searchParams);
  const [state, setState] = useState<'loading' | 'success' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;

    const { request_token, status, message } = params;
    const notifyHost = (payload: { type: 'zerodha_connected' } | { type: 'zerodha_error'; message: string }) => {
      if (window.parent !== window) {
        window.parent.postMessage(payload, window.location.origin);
      }
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(payload, window.location.origin);
      }
    };

    if (status !== 'success' || !request_token) {
      const reason = message ?? 'Login was cancelled or failed.';
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setErrorMsg(reason);
      setState('error');
      notifyHost({ type: 'zerodha_error', message: reason });
      return;
    }

    apiService
      .zerodhaCallback(request_token)
      .then(() => {
        setState('success');
        notifyHost({ type: 'zerodha_connected' });
        window.setTimeout(() => {
          window.close();
        }, 900);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : 'Token exchange failed';
        setErrorMsg(msg);
        setState('error');
        notifyHost({ type: 'zerodha_error', message: msg });
      });
  }, [params]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-white">
      {state === 'loading' && (
        <div className="text-center">
          <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-gray-200 border-t-blue-600" />
          <p className="text-sm text-gray-600">Connecting to Zerodha…</p>
        </div>
      )}
      {state === 'success' && (
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
            <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <p className="text-sm font-medium text-gray-900">Connected!</p>
          <p className="mt-1 text-xs text-gray-500">Returning to dashboard…</p>
        </div>
      )}
      {state === 'error' && (
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100">
            <svg className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <p className="text-sm font-medium text-gray-900">Connection failed</p>
          <p className="mt-1 text-xs text-gray-500">{errorMsg}</p>
        </div>
      )}
    </div>
  );
}
