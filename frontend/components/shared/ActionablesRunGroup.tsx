import type { RunResponse } from "@/types/api";

export function ActionablesRunGroup({
  market, latestRun, runCount, stockCount, loading, error, onDetails,
}: {
  market: "india" | "us";
  latestRun: RunResponse | null;
  runCount: number;
  stockCount: number;
  loading: boolean;
  error: string | null;
  onDetails?: () => void;
}) {
  const label = market === "us" ? "US" : "India";
  const settled = !loading && !error;
  const hasSource = Boolean(latestRun);
  const unresolved = loading ? "Checking…" : "Unavailable";
  const bundleMarker = "## Rebalance Input Bundle";
  const markerIndex = latestRun?.prompt?.indexOf(bundleMarker) ?? -1;
  const capturedInput = markerIndex >= 0 ? latestRun!.prompt.slice(markerIndex) : latestRun?.prompt;

  return (
    <section aria-label={`${label} run group`} aria-busy={loading} className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
      <h3 className="font-semibold text-slate-900">Run Group · {label}</h3>
      {loading ? <p role="status" className="mt-2">{hasSource ? "Refreshing runs; showing the last available source group." : "Loading final actionables; checking matching runs…"}</p> : error ? <p role="alert" className="mt-2">{hasSource ? "Refresh failed; showing the last available source group. Current matching results are unverified." : "Matching runs could not be checked. Retry with Refresh."}</p> : null}
      <dl className="mt-3 grid gap-4 sm:grid-cols-3">
        <div><dt className="font-semibold text-slate-900">Latest matching run</dt><dd>{latestRun ? `#${latestRun.id}` : settled ? "No qualifying run in loaded results" : unresolved}</dd></div>
        <div><dt className="font-semibold text-slate-900">Runs consolidated</dt><dd>{hasSource || settled ? runCount : unresolved}</dd>{onDetails ? <button type="button" disabled={!settled && !hasSource} onClick={onDetails} className="mt-1 text-xs text-blue-700 underline disabled:opacity-50">Open run consideration details</button> : null}</div>
        <div><dt className="font-semibold text-slate-900">Total Stocks consolidated</dt><dd>{hasSource || settled ? stockCount : unresolved}</dd></div>
      </dl>
      <p className="mt-3 text-xs leading-5">Matching uses {label} rebalance run identity and completed/partial run status or saved completed/partial model output. The newest qualifying run by creation time selects the input set; runs consolidate only when their rebalance input bundle matches after whitespace normalization. Legacy prompts without the bundle marker use the full normalized prompt.</p>
      {latestRun ? (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer font-semibold text-blue-700">Selected source inputs and timestamps · Run #{latestRun.id}</summary>
          <p className="mt-2">Run created: {latestRun.created_at ? <time dateTime={latestRun.created_at}>{latestRun.created_at}</time> : "Timestamp unavailable"}. Status: {latestRun.status || "Unavailable"}.</p>
          <p className="mt-2">Captured portfolio snapshot, selected swing runs and threats inputs are shown below exactly as saved in this source prompt. Any source IDs and timestamps belong to that saved input set.</p>
          {capturedInput?.trim() ? <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded border border-slate-200 p-3">{capturedInput}</pre> : <p className="mt-2">Captured input text unavailable for this source.</p>}
        </details>
      ) : settled ? <p className="mt-3 text-xs">No source input set was selected from these loaded results. Review this market’s saved run status and captured inputs in Runs, then refresh.</p> : null}
    </section>
  );
}

export function ActionablesEmptyState({ loading, error, hasMatchingRun }: { loading: boolean; error: string | null; hasMatchingRun: boolean }) {
  if (loading) return <p role="status">Loading final actionables…</p>;
  if (error) return <p role="alert">Final actionables could not be verified. Retry with Refresh.</p>;
  return <p>{hasMatchingRun ? "No parsable stock rows were found in the selected run group’s saved model output. Review the source runs and output tables." : "No qualifying rebalance run was found in the loaded results for this market. Review saved runs and captured inputs, then refresh."}</p>;
}
