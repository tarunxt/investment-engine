/** Copy-only boundary: no effects, processing callbacks, or automatic refresh. */
export function WorkflowRunBoundary({ historyHref }: { historyHref: string }) {
  return (
    <section aria-label="Workflow purpose and review boundary" className="mt-3 max-w-2xl space-y-2 text-sm leading-6 text-slate-700">
      <p>
        Run prepares rebalance recommendations: it runs all stages, or only your selected stages.
        Included stages can sync holdings, request paid LLM scans and save calculated actionables.
        After a confirmed run including Actionables, it can queue a completion email.
      </p>
      <p>
        <a href={historyHref} className="inline-flex min-h-9 items-center rounded-md font-semibold text-indigo-800 underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2">
          Review saved run history (read-only)
        </a>
        {" "}or choose Saved evidence and configuration → Saved output. These views do not start a run or sync.
        Sync Now separately requests a portfolio sync.
      </p>
      <p>
        Manual order review begins at Place Order (India) or Final Order (US), which opens the basket review.
        India orders require separate basket confirmation; the US basket is for manual execution review.
        Run does not submit orders.
      </p>
    </section>
  );
}
