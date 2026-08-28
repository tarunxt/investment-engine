"use client";

import { useState } from "react";
import { AlertTriangle, RefreshCw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function normalizeOperationalErrorMessage(message: string) {
  const uniqueParts = Array.from(new Set(
    message
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean),
  ));
  return uniqueParts.join("; ");
}

export function OperationalErrorNotice({
  title,
  error,
  context,
  onRetry,
}: {
  title: string;
  error: string;
  context: "captured-details" | "server-history";
  onRetry?: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const normalizedError = normalizeOperationalErrorMessage(error);
  const timedOut = /timed?\s*out|did not respond in time/i.test(normalizedError);
  const diagnosis = timedOut
    ? "The browser stopped waiting before the backend completed the read. This commonly happens while the service is cold, busy, restarting, or waiting on the database. No stock data was changed or deleted."
    : context === "server-history"
      ? "The complete persisted-history request failed, so the popup kept the recent rows reconstructed from the already loaded runs instead of showing a blank table."
      : "One or more supporting captured-detail requests failed. Data that loaded successfully remains available; only the failed supporting sections may be incomplete.";
  const steps = context === "server-history"
    ? [
        "Select Retry now to request the complete persisted history again.",
        "If it repeats, wait for the backend/database health check to recover, then retry; locally reconstructed rows remain safe to use meanwhile.",
        "For an operator-level check, verify the backend and PostgreSQL services are healthy and inspect the request correlation ID in the server logs if one is shown in the technical detail.",
      ]
    : [
        "Select Retry now to reload the latest portfolio, events, and threats details independently.",
        "If only portfolio data remains unavailable, run Sync Portfolio and reopen this stock popup.",
        "If the timeout repeats, verify the backend service and its database connection are healthy; successful sections will continue to display.",
      ];

  const retry = async () => {
    if (!onRetry || retrying) return;
    setRetrying(true);
    try {
      await onRetry();
      setOpen(false);
    } catch {
      // The notice remains open with the refreshed technical detail.
    } finally {
      setRetrying(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full cursor-pointer rounded-lg border border-amber-200 bg-amber-50 p-3 text-left text-amber-800 transition hover:border-amber-400 hover:bg-amber-100/70 focus:outline-none focus:ring-2 focus:ring-amber-400"
        aria-label={`Open detailed error for ${title}`}
      >
        <span className="inline-flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            <span className="font-semibold underline decoration-amber-400 underline-offset-2">{title}</span>{" "}
            {normalizedError}
            <span className="ml-2 whitespace-nowrap text-xs font-semibold">View details and fix steps</span>
          </span>
        </span>
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-black/50 px-4 py-12"
          role="dialog"
          aria-modal="true"
          aria-label={`${title} details`}
          onClick={() => setOpen(false)}
        >
          <div className="w-full max-w-2xl rounded-2xl bg-white shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-4 border-b px-5 py-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-700">Error details</p>
                <h3 className="mt-1 text-lg font-bold text-slate-950">{title}</h3>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="rounded-full p-2 text-slate-500 hover:bg-slate-100" aria-label="Close error details">
                <X className="size-5" />
              </button>
            </div>
            <div className="space-y-5 px-5 py-5 text-sm text-slate-700">
              <section>
                <h4 className="font-bold text-slate-950">Why this happened</h4>
                <p className="mt-1 leading-6">{diagnosis}</p>
              </section>
              <section>
                <h4 className="font-bold text-slate-950">Technical detail</h4>
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-slate-950 p-3 text-xs leading-5 text-slate-100">{normalizedError}</pre>
              </section>
              <section>
                <h4 className="font-bold text-slate-950">Steps to fix</h4>
                <ol className="mt-2 list-decimal space-y-2 pl-5 leading-6">
                  {steps.map((step) => <li key={step}>{step}</li>)}
                </ol>
              </section>
              <div className="flex justify-end gap-2 border-t pt-4">
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>Close</Button>
                {onRetry ? (
                  <Button type="button" onClick={() => void retry()} disabled={retrying}>
                    <RefreshCw className={cn("mr-2 size-4", retrying && "animate-spin")} />
                    {retrying ? "Retrying…" : "Retry now"}
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
