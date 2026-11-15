"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Keeps an isolated Bullpen render failure from falling through to Next's
 * unhelpful production 500 response. The page has several independently
 * loaded dashboard sections, so a retry is preferable to leaving the console
 * unusable after a transient chunk or render failure.
 */
export default function BullpenAiError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Bullpen AI console failed to render", error);
  }, [error]);

  return (
    <section
      className="mx-auto flex min-h-[60vh] max-w-xl items-center justify-center"
      aria-labelledby="bullpen-error-title"
    >
      <div className="w-full rounded-2xl border border-amber-200 bg-amber-50 p-6 text-center shadow-sm">
        <AlertTriangle
          className="mx-auto h-9 w-9 text-amber-600"
          aria-hidden="true"
        />
        <h1
          id="bullpen-error-title"
          className="mt-4 text-xl font-semibold text-slate-950"
        >
          Bullpen AI is temporarily unavailable
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate-700">
          We could not load this console. Your saved scans and active positions
          have not been changed.
        </p>
        <Button type="button" className="mt-5 gap-2" onClick={reset}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Try again
        </Button>
        {error.digest ? (
          <p className="mt-4 text-xs text-slate-500">
            Reference: {error.digest}
          </p>
        ) : null}
      </div>
    </section>
  );
}
