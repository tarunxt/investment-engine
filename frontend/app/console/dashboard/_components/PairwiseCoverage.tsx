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
    {!!result.evidence_readiness?.length && <details><summary>Evidence by listing</summary><Grid rows={result.evidence_readiness}/></details>}
  </section>;
}
