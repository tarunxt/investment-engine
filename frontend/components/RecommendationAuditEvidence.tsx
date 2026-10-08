import type { ReactNode } from "react";
import type { AuditComparison, AuditLegacySuggestion, AuditScoreInput, AuditVerification } from "@/types/recommendationAudit";
import { auditLabel, auditNumber, describeAuditCoverage, describeAuditValue, formatAuditNumber, formatAuditTime, savedInputScore, scoreInputContribution, uniqueAuditFindings } from "@/lib/recommendationAuditPresentation";

export function EvidenceNotice({ tone = "caution", label, children }: { tone?: "recorded" | "caution" | "conflict"; label: string; children: ReactNode }) {
  const style = { recorded: "border-blue-200 bg-blue-50 text-blue-950", caution: "border-amber-300 bg-amber-50 text-amber-950", conflict: "border-red-300 bg-red-50 text-red-950" }[tone];
  return <div className={"min-w-0 rounded-lg border p-3 " + style}><p className="font-semibold"><span aria-hidden="true">{tone === "recorded" ? "✓" : tone === "conflict" ? "!" : "⚠"}</span> {label}</p><div className="mt-1 text-sm leading-relaxed">{children}</div></div>;
}
function Value({ label, children }: { label: string; children: ReactNode }) {
  return <div className="min-w-0 rounded-lg border border-slate-200 bg-white p-3"><dt className="text-xs font-semibold text-slate-600">{label}</dt><dd className="mt-1 break-words text-sm text-slate-950">{children}</dd></div>;
}
export type RecommendationAuditEvidenceProps = {
  comparison: AuditComparison; verification: AuditVerification | null; runId: number | null; runCount: number;
  currentScore: number | null; currentAction: string | null; currentUnits?: number | null; currentFormulaUnits?: number | null;
  scoreInputs?: AuditScoreInput[]; scoreDenominator?: number | null; technicalRunId?: number | null;
  legacyHistory?: AuditLegacySuggestion[]; legacyHistoryHasMore?: boolean; legacyHistoryError?: string | null; market: string; children?: ReactNode;
};

export function RecommendationAuditEvidence({ comparison, verification, runId, runCount, currentScore, currentAction, currentUnits, currentFormulaUnits, scoreInputs = [], scoreDenominator, technicalRunId, legacyHistory = [], legacyHistoryHasMore, legacyHistoryError, market, children }: RecommendationAuditEvidenceProps) {
  const current = comparison.current, previous = comparison.previous, present = comparison.present_calculation;
  const findings = uniqueAuditFindings(comparison);
  const oldScore = auditNumber(current?.calculation.score);
  const delta = oldScore !== null && currentScore !== null ? currentScore - oldScore : null;
  const held = currentUnits === undefined ? auditNumber(current?.calculation.current_units) : currentUnits;
  const requested = currentFormulaUnits === undefined ? auditNumber(current?.calculation.formula_units) : currentFormulaUnits;
  const requiresReview = market === "india" && currentAction === "Trim" && held !== null && held > 0 && requested !== null && Math.abs(requested) > 0 && Math.abs(requested) < 1;
  const sameFamily = current?.provider_families?.length === 1 || findings.some(item => item.code === "same_model_consensus");
  const verdict = !current || !previous ? "insufficient_evidence" : verification?.verdict;
  const verdictLabel = verdict === "supported" ? "Supported within the checked scope" : verdict === "unsupported" ? "Not supported within the checked scope" : verdict === "insufficient_evidence" || !current || !previous ? "Insufficient evidence" : "Stored evidence has not been checked";
  const verdictTone = verdict === "unsupported" ? "conflict" : verdict === "supported" ? "recorded" : "caution";
  const oldSuggestions = legacyHistory.filter(item => item.run_id !== runId);
  const numeric = (action: string | null | undefined, score: unknown) => (action ?? "Unknown") + " · " + formatAuditNumber(score);
  const layers = [
    ["Provider action", previous?.calculation.raw_action ?? "Unknown", current?.calculation.raw_action ?? "Unknown"],
    ["Rationale mean", formatAuditNumber(previous?.calculation.rationale_mean), formatAuditNumber(current?.calculation.rationale_mean)],
    ["Saved formula", numeric(previous?.calculation.formula_action, previous?.calculation.score), numeric(current?.calculation.formula_action, current?.calculation.score)],
    ["Requested share change", formatAuditNumber(previous?.calculation.formula_units, true), formatAuditNumber(current?.calculation.formula_units, true)],
    ["Held shares", formatAuditNumber(previous?.calculation.current_units), formatAuditNumber(current?.calculation.current_units)],
    ["Saved sizing", (previous?.sizing.action ?? "Unknown") + " · " + formatAuditNumber(previous?.sizing.units, true) + " shares", (current?.sizing.action ?? "Unknown") + " · " + formatAuditNumber(current?.sizing.units, true) + " shares"],
  ];
  const technicalInputs = scoreInputs.filter(row => ["technical-scan-confidence", "premarket-trend", "last-5-candles-trend"].includes(row.id) && row.score !== null && row.multiplier !== 0);
  return <div className="min-w-0 space-y-5 break-words [overflow-wrap:anywhere]">
    <section aria-label="Quick overview of findings" className="min-w-0 space-y-3">
      <h4 className="text-base font-semibold text-slate-950">Quick overview of findings</h4>
      <EvidenceNotice tone={verdictTone} label={verdictLabel}>
        <p>{verdict === "supported" || verdict === "unsupported" ? "This result covers the stated claims and captured checks; it does not certify profitability or authorize a trade." : "The reversal is not established by the available evidence. Missing coverage must not become a confident buy or sell verdict."}</p>
        {verification && <p className="mt-1">Check status: {auditLabel(verification.status)}. {verification.result?.checked_at ? "Last checked " + formatAuditTime(verification.result.checked_at) + "." : "Results are pending."}</p>}
      </EvidenceNotice>
      <dl className="grid min-w-0 gap-2 sm:grid-cols-3">
        <Value label="Provider recommendation">{current?.calculation.raw_action ?? "Unknown"}</Value>
        <Value label="Saved formula / current formula">{numeric(current?.calculation.formula_action, current?.calculation.score)}<br />{numeric(currentAction, currentScore)}</Value>
        <Value label="Saved sizing / practical limit">{current?.sizing.action ?? "Unknown"} · {formatAuditNumber(current?.sizing.units, true)} shares<br />{requiresReview ? "Whole-share review required; no order selected." : "Sizing is separate from strength of evidence."}</Value>
      </dl>
      {requiresReview && <EvidenceNotice tone="conflict" label="Whole-share choice required">
        <p>The formula requests a trim of {formatAuditNumber(Math.abs(requested ?? 0))} shares from {formatAuditNumber(held)} held. A fractional-share sale is unavailable for this India holding. Selling one share would exit the entire position.</p>
        <p className="mt-1">Default: no order. In basket review, explicitly choose to keep the position or review a full exit; a reviewed exit still requires separate selection. This popup never places orders or changes holdings.</p>
      </EvidenceNotice>}
      {!previous && <EvidenceNotice label="Prior frozen snapshot missing"><p>{oldSuggestions.length ? oldSuggestions.length + " older recommendation history records are available below, but " : ""}no preceding frozen snapshot is available for this comparison. Legacy suggestions cannot certify the original formula, holdings, source availability or reversal.</p></EvidenceNotice>}
      {delta !== null && Math.abs(delta) > 0.000001 && <EvidenceNotice label="Saved and current scores differ"><p>Saved {formatAuditNumber(oldScore)} → current {formatAuditNumber(currentScore)}; change {formatAuditNumber(delta, true)}. {technicalInputs.length ? "Current technical inputs and their weighted contributions are shown below." : "A complete contribution comparison is unavailable."} This recalculation is separate from a historical reversal.</p></EvidenceNotice>}
      <EvidenceNotice tone="recorded" label="Recorded coverage and freshness">
        <p>{current ? formatAuditNumber(current.coverage.successful) + "/" + formatAuditNumber(current.coverage.attempted) + " source attempts completed. Captured " + formatAuditTime(current.captured_at) + "." : "No frozen decision for the selected source."} {runCount > 1 ? "The popup combines " + runCount + " source runs; the frozen comparison covers run #" + runId + "." : ""}</p>
        <p className="mt-1">{current?.original_completion_at ? "Recorded original completion: " + formatAuditTime(current.original_completion_at) + ". This alone does not prove market-source publication time." : "Original completion or source availability is unknown. A recent observation does not establish decision-time availability."}</p>
      </EvidenceNotice>
      {sameFamily && <EvidenceNotice label="Agreement is not independent corroboration">The samples agree within one provider/model family. A 2/2 count or a same-model explanation is not proof that the recommendation is supported.</EvidenceNotice>}
      {findings.slice(0, 3).map((finding, index) => <EvidenceNotice key={finding.code + index} tone={finding.severity === "error" ? "conflict" : "caution"} label={finding.severity === "error" ? "Conflict in recorded inputs" : "Evidence caution"}>{finding.detail}</EvidenceNotice>)}
      {children}
      <p className="text-xs text-slate-600">Blue ✓ = recorded or checked evidence; amber ⚠ = missing evidence or caution; red ! = conflict or review required. These labels do not indicate that a trade is safe.</p>
    </section>

    <section aria-label="In-depth details" className="min-w-0 space-y-4 border-t border-slate-200 pt-4">
      <h4 className="text-base font-semibold text-slate-950">In-depth details</h4>
      <div><h5 className="font-semibold">Frozen source comparison</h5><p className="mt-1 text-xs text-slate-600">Previous {previous ? "run #" + previous.run_id : "snapshot unavailable"} · saved run #{current?.run_id ?? runId ?? "unknown"}. Identity: {comparison.comparison?.comparable ? "matched under the captured mapping" : "unverified"}.</p>
        <div className="mt-2 space-y-2">{layers.map(([label, before, after]) => <div key={label} className="grid min-w-0 gap-1 rounded border border-slate-200 p-2 text-sm sm:grid-cols-3"><strong>{label}</strong><span><span className="text-xs text-slate-500 sm:hidden">Previous: </span>{before}</span><span><span className="text-xs text-slate-500 sm:hidden">Saved: </span>{after}</span></div>)}</div>
      </div>
      <div><h5 className="font-semibold">Saved versus current score</h5><p className="mt-1 text-sm">Saved {formatAuditNumber(oldScore)} · current {formatAuditNumber(currentScore)} · difference {formatAuditNumber(delta, true)}. Current action: {currentAction ?? "Unknown"}.</p>
        <p className="mt-1 text-xs text-slate-600">Saved numerator / denominator: {formatAuditNumber(current?.calculation.numerator)} / {formatAuditNumber(current?.calculation.denominator)}. Current numerator / denominator: {scoreInputs.length ? formatAuditNumber(scoreInputs.reduce((total, row) => total + (scoreInputContribution(row) ?? 0), 0)) : "Unknown"} / {formatAuditNumber(scoreDenominator)}. Different inputs, weights or denominators can change the score without a new provider recommendation.</p>
        {technicalInputs.length > 0 && <p className="mt-2 text-sm">Current technical evidence {technicalRunId ? "comes from run #" + technicalRunId : "has no identified source run"}. {current?.technical ? "The saved snapshot also contains technical evidence; compare the actual values below." : "The saved snapshot contains no matching frozen technical evidence. These are added current inputs, not proof that they were available for the original decision."}</p>}
        {scoreInputs.length ? <div className="mt-2 space-y-2">{scoreInputs.map(row => <div key={row.id} className="grid min-w-0 gap-1 rounded border border-slate-200 p-2 text-sm sm:grid-cols-2"><strong>{auditLabel(row.id)}</strong><span>Saved input {current ? formatAuditNumber(savedInputScore(current, row.id)) : "Unknown"} → current input {formatAuditNumber(row.score)}; current weight {formatAuditNumber(row.multiplier)}; numerator contribution {formatAuditNumber(scoreInputContribution(row), true)}</span></div>)}</div> : <p className="mt-2 text-sm text-amber-900">Component-level current inputs were not supplied; the cause of the score difference remains unresolved.</p>}
        <p className="mt-2 text-xs text-slate-600">Current settings and sources are observations now. They do not reconstruct missing original policy or publication timing.</p>
        {present && <p className="mt-2 rounded bg-blue-50 p-3 text-sm">Present calculation observed {formatAuditTime(present.captured_at)}: {numeric(present.calculation.formula_action, present.calculation.score)}. This is separate from the saved decision and is not the frozen pair sent to verification.</p>}
      </div>
      <div><h5 className="font-semibold">Changed evidence and provenance</h5>
        <dl className="mt-2 grid min-w-0 gap-2 sm:grid-cols-2"><Value label="Capture origin">{current ? auditLabel(current.provenance) : "Unavailable"}</Value><Value label="Decision time">{formatAuditTime(current?.decision_at)}</Value><Value label="Objective / horizon">{current?.objective || "Unknown"} / {current?.horizon || "Unknown"}</Value><Value label="Source revisions">{current?.source_hashes?.length ?? "Unknown"} saved revisions; original provider bytes are not certified.</Value></dl>
        <p className="mt-2 text-sm">{describeAuditCoverage(comparison.coverage)}</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{comparison.comparison?.changes.map(change => <li key={change.field}>{auditLabel(change.field)}: {describeAuditValue(change.before)} → {describeAuditValue(change.after)}</li>)}{Object.entries(comparison.comparison?.score_component_changes ?? {}).map(([key, value]) => <li key={key}>{auditLabel(key)} input-score change: {formatAuditNumber(value, true)}. This is an input delta, not a weighted final-score contribution.</li>)}</ul>
        {findings.slice(3).map((finding, index) => <EvidenceNotice key={finding.code + index} tone={finding.severity === "error" ? "conflict" : "caution"} label={finding.severity === "error" ? "Conflict in recorded inputs" : "Evidence caution"}>{finding.detail}</EvidenceNotice>)}
      </div>
      <div><h5 className="font-semibold">Legacy recommendation history</h5><p className="mt-1 text-sm text-amber-950">Saved suggestion records and current reconstructions are context. They are separate from preceding frozen snapshots and do not certify a reversal.</p>
        {legacyHistoryError && <p className="mt-2 text-sm text-amber-950">History coverage incomplete: {legacyHistoryError}</p>}
        {oldSuggestions.length ? <ul className="mt-2 space-y-2">{oldSuggestions.map((item, index) => <li key={item.origin + item.run_id + index} className="min-w-0 rounded border border-amber-200 bg-amber-50 p-2 text-sm"><a href={"/console/runs/" + item.run_id} className="font-semibold text-blue-800 underline">Run #{item.run_id}</a> · {formatAuditTime(item.timestamp)} · {item.action ?? "Unknown action"} · score {formatAuditNumber(item.score)}<p className="mt-1 text-xs">{item.origin === "saved_suggestion" ? "Saved suggestion history" : "Reconstructed using current settings"}; coverage {auditLabel(item.coverage)}; original policy and availability not certified.</p></li>)}</ul> : <p className="mt-2 text-sm">No older suggestion rows have been loaded for this selection. This does not establish that no older recommendations exist.</p>}
        {legacyHistoryHasMore && <p className="mt-2 text-xs">More suggestion history exists; use “Load older suggestions” in the history section.</p>}
      </div>
      {verification && <div role="status" className="min-w-0 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3"><h5 className="font-semibold">Verification findings and unresolved claims</h5><p className="text-sm">{verdictLabel}. Spent USD {formatAuditNumber(verification.spent_usd)}; reserved USD {formatAuditNumber(verification.reserved_usd)}.</p>{verification.error && <p className="text-red-950">{verification.error}</p>}<ul className="list-disc space-y-1 pl-5 text-sm">{[...(verification.result?.findings ?? []), ...(verification.result?.limitations ?? [])].map((finding, index) => <li key={index}>{finding}</li>)}</ul>{verification.result?.claims?.map(item => <EvidenceNotice key={item.claim.id} tone={item.state === "contradicted" ? "conflict" : item.state === "supported" ? "recorded" : "caution"} label={auditLabel(item.state)}><p>{item.claim.text}</p>{item.observations?.map((observation, index) => <p key={index} className="mt-1">{observation.detail} Original availability: {formatAuditTime(observation.available_at)}.</p>)}</EvidenceNotice>)}{verification.result?.sources?.map((source, index) => <div key={index} className="min-w-0 rounded border border-slate-200 bg-white p-3 text-sm"><a href={source.source_url} target="_blank" rel="noreferrer" className="text-blue-800 underline">Source evidence {index + 1}</a><p className="mt-1">Observed {formatAuditTime(source.observed_at)}. Published {formatAuditTime(source.published_at)}. Originally available {formatAuditTime(source.available_at)}.</p>{source.limitations?.map((limit, item) => <p key={item} className="mt-1 text-amber-950">{limit}</p>)}{source.facts?.slice(0, 8).map((fact, item) => <p key={item} className="mt-2">{auditLabel(fact.concept.split("}").pop() ?? fact.concept)}: {fact.value ?? "Unknown"} {fact.unit_measures.map(unit => unit.split("}").pop()).join(", ")} · {fact.instant ?? (fact.period_start ?? "Unknown start") + " to " + (fact.period_end ?? "Unknown end")} · {Object.entries(fact.dimensions).map(([key, value]) => key.split("}").pop() + ": " + value.split("}").pop()).join("; ") || "No reported dimensions"}</p>)}{source.facts?.length ? <p className="mt-2 text-xs text-amber-950">Up to eight reported facts. Entity mapping, concept semantics and original availability remain unverified; these facts do not certify the recommendation.</p> : null}</div>)}</div>}
    </section>
  </div>;
}
