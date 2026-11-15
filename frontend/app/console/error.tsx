'use client';

import { useEffect, useMemo } from 'react';
import Link from 'next/link';
import { AlertTriangle, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { URLs } from '@/lib/urls';

const CHUNK_RELOAD_STORAGE_KEY = 'investment-engine:console:chunk-reload-attempted';

function isChunkLoadError(error: Error) {
  const message = error.message || '';
  const name = error.name || '';

  return (
    name === 'ChunkLoadError' ||
    /failed to load chunk/i.test(message) ||
    /loading chunk [\w-]+ failed/i.test(message) ||
    /_next\/static\/chunks/i.test(message)
  );
}

function clearChunkReloadAttempt() {
  window.sessionStorage.removeItem(CHUNK_RELOAD_STORAGE_KEY);
}

export default function ConsoleError({
  error,
  reset,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  reset?: () => void;
  unstable_retry?: () => void;
}) {
  const isRecoverableChunkError = useMemo(() => isChunkLoadError(error), [error]);

  useEffect(() => {
    console.error('Console route failed to render:', error);
  }, [error]);

  useEffect(() => {
    if (!isRecoverableChunkError) {
      clearChunkReloadAttempt();
      return;
    }

    const previousAttempt = window.sessionStorage.getItem(CHUNK_RELOAD_STORAGE_KEY);
    if (previousAttempt === window.location.pathname) {
      return;
    }

    window.sessionStorage.setItem(CHUNK_RELOAD_STORAGE_KEY, window.location.pathname);
    window.location.reload();
  }, [isRecoverableChunkError]);

  const retryRender = () => {
    if (isRecoverableChunkError) {
      clearChunkReloadAttempt();
      window.location.reload();
      return;
    }

    (reset ?? unstable_retry)?.();
  };

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4 py-12">
      <div className="w-full max-w-2xl rounded-3xl border border-amber-200 bg-amber-50 p-6 text-amber-950 shadow-sm">
        <div className="flex items-start gap-4">
          <div className="rounded-2xl bg-amber-100 p-3 text-amber-700">
            <AlertTriangle className="size-6" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold text-amber-950">
              The console hit a display error
            </h1>
            <p className="mt-2 text-sm leading-6 text-amber-900">
              {isRecoverableChunkError
                ? 'This page tried to use an older console bundle that is no longer available. The console will reload once automatically to fetch the latest code.'
                : 'The app shell loaded, but this console page failed while rendering. Try reloading the page. If it keeps happening, share the message below.'}
            </p>
            <pre className="mt-4 max-h-44 overflow-auto rounded-2xl bg-white/70 p-4 text-xs text-amber-950">
              {error.message || 'Unknown console render error'}
              {error.digest ? `\nDigest: ${error.digest}` : ''}
            </pre>
            <div className="mt-5 flex flex-wrap gap-3">
              <Button type="button" onClick={retryRender} className="gap-2">
                <RefreshCw className="size-4" />
                {isRecoverableChunkError ? 'Reload page' : 'Try again'}
              </Button>
              <Button asChild type="button" variant="outline">
                <Link href={URLs.routes.console.dashboard()}>Open dashboard</Link>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
