import type {CardResult} from "@/lib/independentScorecards";
import {Grid} from "./ScorecardResultGrid";

export function PairwiseCoverage({result}:{result:CardResult}) {
  const c=result.pair_counts;
  if (!c) return null;
  return <section aria-label="Pairwise evidence coverage" className="space-y-2 rounded-lg border p-3 text-sm">
    <h3 className="font-semibold">{c.mode==="balanced" ? "Balanced trial" : "Full round robin"} · {c.judged}/{c.expected} pairs judged</h3>
    <p>{c.ready}/{c.listings} listings have usable evidence. {c.complete_stocks}/{c.listings} have all scheduled opponents judged.</p>
    <p>{c.eligible-c.judged} eligible pairs await a judgment. {c.one_missing} pairs lack evidence on one side and {c.both_missing} on both. {c.benchmark_ready}/{c.listings} have benchmark-relative returns.</p>
    <p>{c.returned} pairs have a recorded response. {c.jobs} model jobs in this attempt{c.carried ? ` · ${c.carried} previous judgments retained` : ""}.</p>
    {result.attempt_cost_inr!=null && <p>Attempt cost ₹{result.attempt_cost_inr.toFixed(2)}{result.attempt_elapsed_seconds!=null ? ` · ${Math.round(result.attempt_elapsed_seconds)} seconds` : ""}.</p>}
    {!!result.observed_at && <p>Decision cutoff {result.as_of} · evidence retrieved {result.observed_at}</p>}
    {result.recovery && <div>
      <p>Recovery · {result.recovery.phase}{result.recovery.next_at ? " · next check "+new Date(result.recovery.next_at*1000).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})+" IST" : ""}</p>
      {result.recovery.error && <p>{result.recovery.error}</p>}
      {Object.keys(result.recovery.listings).length>0 && <details><summary>Pending recovery by listing</summary>
        <Grid rows={Object.entries(result.recovery.listings).map(([listing,gap])=>({
          Listing:listing, Missing:gap.needs.join(", "), Reason:gap.reason, Attempts:gap.attempts,
          "Last attempt":gap.last_attempt ? new Date(gap.last_attempt*1000).toISOString() : null,
          "Last recovered component":gap.last_success ? new Date(gap.last_success*1000).toISOString() : null,
          "Next retry":gap.next_retry ? new Date(gap.next_retry*1000).toISOString() : null,
        }))}/></details>}
    </div>}
    {!!result.evidence_readiness?.length && <details><summary>Evidence by listing</summary><Grid rows={result.evidence_readiness}/></details>}
  </section>;
}
