'use client';

import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { apiService, APIError } from '@/services/api';
import { AlertCircle, Loader2, CheckCircle2 } from 'lucide-react';

export default function GoogleSheetsCallbackPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('');

  useEffect(() => {
    const code = searchParams.get('code');
    const error = searchParams.get('error');

    if (error) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStatus('error');
       
      setMessage(`Google authorization failed: ${error}`);
      // Notify parent window of error
      if (window.opener) {
        window.opener.postMessage(
          { type: 'google_sheets_error', message: `Authorization denied: ${error}` },
          window.location.origin
        );
        setTimeout(() => window.close(), 2000);
      }
      return;
    }

    if (!code) {
       
      setStatus('error');
       
      setMessage('No authorization code received from Google');
      if (window.opener) {
        window.opener.postMessage(
          { type: 'google_sheets_error', message: 'No authorization code received' },
          window.location.origin
        );
        setTimeout(() => window.close(), 2000);
      }
      return;
    }

    // Exchange code for tokens
    const exchangeCode = async () => {
      try {
         
        setMessage('Exchanging authorization code...');

        await apiService.googleSheetsExchangeCode(code);

         
        setStatus('success');
         
        setMessage('Successfully connected to Google Sheets!');

        // Notify parent window of success
        if (window.opener) {
          window.opener.postMessage(
            { type: 'google_sheets_connected' },
            window.location.origin
          );
          setTimeout(() => window.close(), 2000);
        } else {
          // Fallback: redirect back to Google Sheets page if opened directly
          setTimeout(() => {
            router.push('/console/google-sheets');
          }, 2000);
        }
      } catch (err) {
        const errorMsg = err instanceof APIError ? err.message : 'Failed to connect Google Sheets';
         
        setStatus('error');
         
        setMessage(errorMsg);

        if (window.opener) {
          window.opener.postMessage(
            { type: 'google_sheets_error', message: errorMsg },
            window.location.origin
          );
          setTimeout(() => window.close(), 3000);
        }
      }
    };

    exchangeCode();
  }, [searchParams, router]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md">
        <div className="rounded-lg border border-gray-200 bg-white p-8 shadow-sm">
          {status === 'loading' && (
            <div className="flex flex-col items-center gap-4">
              <Loader2 className="size-8 animate-spin text-blue-600" />
              <div className="text-center">
                <h1 className="text-lg font-semibold text-gray-950">Connecting Google Sheets</h1>
                <p className="mt-2 text-sm text-gray-600">{message}</p>
                <p className="mt-4 text-xs text-gray-500">
                  This window will close automatically...
                </p>
              </div>
            </div>
          )}

          {status === 'success' && (
            <div className="flex flex-col items-center gap-4">
              <CheckCircle2 className="size-8 text-emerald-600" />
              <div className="text-center">
                <h1 className="text-lg font-semibold text-gray-950">Connected!</h1>
                <p className="mt-2 text-sm text-emerald-600">{message}</p>
                <p className="mt-4 text-xs text-gray-500">Returning to Google Sheets...</p>
              </div>
            </div>
          )}

          {status === 'error' && (
            <div className="flex flex-col items-center gap-4">
              <AlertCircle className="size-8 text-red-600" />
              <div className="text-center">
                <h1 className="text-lg font-semibold text-gray-950">Connection Failed</h1>
                <p className="mt-2 text-sm text-red-600">{message}</p>
                <p className="mt-4 text-xs text-gray-500">Closing this window...</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
