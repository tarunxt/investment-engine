import { allocationScoreContract } from "@/lib/basketDisplayCalculations";

const scoreText = (value: number | null) => value === null ? "Unavailable" : value.toLocaleString("en-IN", { maximumFractionDigits: 12 });

/** Labels the approved interpretation for a new calculation; never use for a frozen legacy score. */
export function AllocationScoreContext({ rawScore }: { rawScore: number | null }) {
  const score = allocationScoreContract(rawScore);
  return <div className="mt-1 text-xs font-normal text-slate-600" data-score-policy={score.scorePolicy}>
    <span>Raw formula score: {scoreText(score.rawScore)}</span>{" · "}
    <span>Effective allocation score: {scoreText(score.effectiveScore)}</span>
    <p>New allocation calculations limit the effective score to −3 through +3. Your formula and original saved scores are unchanged.</p>
  </div>;
}
