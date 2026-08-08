"use client";

import { AlertTriangle, X } from "lucide-react";
import { useState } from "react";

import {
  buildBullpenQuestionPreflightEvidenceBlock,
  computeBullpenLlmConsensus,
  getBullpenLlmDisagreementCategoryLabel,
  getBullpenLlmReviewState,
  type BullpenQuestionRow,
} from "@/lib/bullpen-ai";
import { formatApiTimestamp } from "@/lib/datetime";
import type { BullpenAutoLiveDecision, BullpenAutoLiveRun } from "@/types/api";
import { BullpenEventHistoricalAssessmentTable } from "./BullpenEventHistoricalAssessmentTable";

type BullpenLlmBreakdownDialogProps = {
  question: BullpenQuestionRow;
  onClose: () => void;
  historicalRuns?: BullpenAutoLiveRun[] | null;
  historicalDecisions?: BullpenAutoLiveDecision[] | null;
};

function formatDate(value: string | null) {
  return formatApiTimestamp(value, {
    emptyValue: "—",
    second: undefined,
  });
}

function formatOdds(value: number | null) {
  if (value === null) return "—";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

function formatRange(minValue: number | null, maxValue: number | null) {
  if (minValue === null || maxValue === null) return "—";
  return `${formatOdds(minValue)} / ${formatOdds(maxValue)}`;
}

function formatSpread(value: number | null) {
  if (value === null) return "—";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })} pts`;
}

function formatDisagreementLabel(value: string | null) {
  if (!value) return "—";
  return value
    .split(/[_\s]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function StatCard({
  label,
  value,
  onClick,
}: {
  label: string;
  value: string;
  onClick?: () => void;
}) {
  const content = (
    <>
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
        {label}
      </p>
      <p className="mt-1 text-sm font-semibold text-slate-900">{value}</p>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-left transition hover:border-indigo-200 hover:bg-indigo-50 focus:outline-none focus:ring-2 focus:ring-indigo-300"
      >
        {content}
      </button>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
      {content}
    </div>
  );
}


type MetricExplanation = {
  label: string;
  value: string;
  meaning: string;
  rationale: string;
};

function getMetricExplanation(
  label: string,
  value: string,
  question: BullpenQuestionRow,
): MetricExplanation {
  const modelCount = question.llmBreakdown.length.toLocaleString();
  const consensusMethod = formatDisagreementLabel(
    computeBullpenLlmConsensus(question.llmBreakdown).consensusMethod,
  );
  const spread = formatSpread(question.llmSpreadYesOdds);
  const median = formatOdds(question.llmMedianYesOdds);
  const trimmed = formatOdds(question.llmTrimmedMeanYesOdds);
  const explanations: Record<string, string> = {
    "Consensus Yes": "Final robust Yes probability used by the table after combining usable model outputs.",
    "Consensus No": "Final robust No probability paired with Consensus Yes.",
    "Average Yes": "Simple average of usable per-model Yes odds before robust outlier handling.",
    "Median Yes": "Middle usable Yes odds estimate; this is resistant to one-off outliers.",
    "Trimmed Mean Yes": "Average after trimming extreme usable Yes estimates when enough outputs exist.",
    IQR: "Interquartile range of usable Yes estimates, showing middle-spread disagreement.",
    "Trimmed Range": "Range after excluding extremes where possible, used to separate true disagreement from outliers.",
    "Min / Max Yes": "Lowest and highest usable model Yes probabilities observed in this scan.",
    Spread: "Raw max-minus-min spread across usable model Yes probabilities.",
    "Disagreement Level": "Low/Medium/High summary of how far usable model estimates diverge.",
    "Consensus Signal": "Category assigned from model camps, robust center, and outlier checks.",
    "Current Yes vs Consensus": "Current market Yes odds minus the LLM consensus Yes odds.",
    "Model Outputs": "Number of per-model LLM outputs saved for this event.",
    "Rationale Mismatches": "Count of outputs where the written rationale appears inconsistent with the numeric odds.",
    "Evidence Status": "Consensus label for whether available evidence is strong, moderate, low, or conflicting.",
    "Event State": "Consensus label for whether the event appears resolved, scheduled, conflicting, or uncertain.",
  };

  return {
    label,
    value,
    meaning: explanations[label] || "This tile summarizes one part of the latest LLM odds calculation.",
    rationale: `This event has ${modelCount} model output(s). The consensus method is ${consensusMethod || "—"}; median Yes is ${median}, trimmed mean Yes is ${trimmed}, and raw spread is ${spread}. The tile value is shown as ${value} because it was derived from the latest saved breakdown for this event.`,
  };
}

function MetricExplanationDialog({
  explanation,
  onClose,
}: {
  explanation: MetricExplanation;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[220] flex items-center justify-center bg-slate-950/35 p-4">
      <div className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_24px_70px_-24px_rgba(15,23,42,0.45)]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Metric explanation</p>
            <h3 className="mt-2 text-lg font-semibold text-slate-950">{explanation.label}</h3>
            <p className="mt-1 text-2xl font-semibold text-slate-950">{explanation.value}</p>
          </div>
          <button type="button" onClick={onClose} className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 text-slate-500 hover:bg-slate-100" aria-label="Close metric explanation">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-4 space-y-3 text-sm leading-6 text-slate-700">
          <p><span className="font-semibold text-slate-950">Meaning:</span> {explanation.meaning}</p>
          <p><span className="font-semibold text-slate-950">Why this event is in this category:</span> {explanation.rationale}</p>
        </div>
      </div>
    </div>
  );
}

function getReviewReason(question: BullpenQuestionRow) {
  const spread = formatSpread(question.llmSpreadYesOdds);
  const minYes = formatOdds(question.llmMinYesOdds);
  const maxYes = formatOdds(question.llmMaxYesOdds);
  const modelCount = question.llmBreakdown.length.toLocaleString();
  const medianYes = formatOdds(question.llmMedianYesOdds);
  const trimmedMeanYes = formatOdds(question.llmTrimmedMeanYesOdds);

  if (question.llmSpreadYesOdds === null) {
    return `This event is marked for adjudication, but the per-model spread is not available. ${modelCount} model outputs were received.`;
  }

  switch (question.llmDisagreementCategory) {
    case "HIGH_DISAGREEMENT":
      return `Provider-level consensus shows meaningful support on both the Yes and No sides. Raw model estimates still span ${spread} (${minYes} to ${maxYes}) across ${modelCount} outputs, so this needs manual review.`;
    case "CONSENSUS_WITH_OUTLIER":
      return `Raw model estimates span ${spread} (${minYes} to ${maxYes}), but the robust center still clusters near ${medianYes} median / ${trimmedMeanYes} trimmed mean. This looks like a broad consensus with only a small outlier set.`;
    case "MOSTLY_CONSENSUS_SOME_UNCERTAINTY":
      return `Most providers cluster around ${medianYes} median / ${trimmedMeanYes} trimmed mean. One or more models stayed near 50/50, so this is uncertainty rather than true Yes-vs-No disagreement.`;
    default:
      return `Model outputs range from ${minYes} to ${maxYes} across ${modelCount} runs, while the robust center stays near ${medianYes} median / ${trimmedMeanYes} trimmed mean.`;
  }
}

function HighDisagreementCriteriaDialog({
  question,
  onClose,
}: {
  question: BullpenQuestionRow;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[215] flex items-center justify-center bg-slate-950/40 p-4">
      <div className="w-full max-w-2xl overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_24px_70px_-24px_rgba(15,23,42,0.45)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-amber-700">
              LLM Consensus Criteria
            </p>
            <h3 className="mt-2 text-lg font-semibold text-slate-950">
              Why this event was classified this way
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close LLM consensus criteria"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-5 px-6 py-5 text-sm leading-6 text-slate-700">
          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-950">
            {getReviewReason(question)}
          </div>
          <div>
            <h4 className="font-semibold text-slate-950">Criteria used</h4>
            <ul className="mt-2 list-disc space-y-2 pl-5">
              <li>
                Classify each model as Yes camp ({">="}60), No camp ({"<="}40),
                or Uncertain (40-60).
              </li>
              <li>
                Use provider medians plus median, trimmed mean, IQR, and trimmed
                range as the main consensus signal.
              </li>
              <li>
                Flag <span className="font-semibold text-slate-950">High LLM disagreement</span>{" "}
                only when both Yes and No sides have meaningful support.
              </li>
              <li>
                Flag <span className="font-semibold text-slate-950">Consensus with outlier</span>{" "}
                when the raw spread is wide but the robust center strongly stays on
                one side.
              </li>
              <li>
                Treat 50/50-style outputs as uncertainty, not as opposition to the
                majority camp.
              </li>
            </ul>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <StatCard
              label="Raw Spread"
              value={formatSpread(question.llmSpreadYesOdds)}
            />
            <StatCard
              label="Trimmed Range"
              value={formatSpread(question.llmTrimmedRangeYesOdds)}
            />
            <StatCard
              label="Consensus Method"
              value={formatDisagreementLabel(
                computeBullpenLlmConsensus(question.llmBreakdown).consensusMethod,
              )}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export function BullpenLlmBreakdownDialog({
  question,
  onClose,
  historicalRuns,
  historicalDecisions,
}: BullpenLlmBreakdownDialogProps) {
  const [isCriteriaOpen, setIsCriteriaOpen] = useState(false);
  const [metricExplanation, setMetricExplanation] =
    useState<MetricExplanation | null>(null);
  const reviewState = getBullpenLlmReviewState(question);
  const disagreementLabel = getBullpenLlmDisagreementCategoryLabel(
    question.llmDisagreementCategory,
  );
  const preflightEvidenceBlock =
    question.preflightEvidenceBlock ||
    buildBullpenQuestionPreflightEvidenceBlock(question);

  return (
    <div className="fixed inset-0 z-[210] flex items-center justify-center bg-slate-950/55 p-4">
      <div className="flex max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.45)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
              LLM Odds Breakdown
            </p>
            <h2 className="max-w-4xl text-xl font-semibold text-slate-950">
              {question.question}
            </h2>
            <p className="text-sm text-slate-600">
              Latest LLM update: {formatDate(question.llmCompletedAt)}
            </p>
            <div className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-5">
              <StatCard
                label="Consensus Yes"
                value={formatOdds(question.llmYesOdds)}
                onClick={() => setMetricExplanation(getMetricExplanation("Consensus Yes", formatOdds(question.llmYesOdds), question))}
              />
              <StatCard
                label="Consensus No"
                value={formatOdds(question.llmNoOdds)}
                onClick={() => setMetricExplanation(getMetricExplanation("Consensus No", formatOdds(question.llmNoOdds), question))}
              />
              <StatCard
                label="Average Yes"
                value={formatOdds(question.llmAverageYesOdds)}
                onClick={() => setMetricExplanation(getMetricExplanation("Average Yes", formatOdds(question.llmAverageYesOdds), question))}
              />
              <StatCard
                label="Median Yes"
                value={formatOdds(question.llmMedianYesOdds)}
                onClick={() => setMetricExplanation(getMetricExplanation("Median Yes", formatOdds(question.llmMedianYesOdds), question))}
              />
              <StatCard
                label="Trimmed Mean Yes"
                value={formatOdds(question.llmTrimmedMeanYesOdds)}
                onClick={() => setMetricExplanation(getMetricExplanation("Trimmed Mean Yes", formatOdds(question.llmTrimmedMeanYesOdds), question))}
              />
              <StatCard
                label="IQR"
                value={formatSpread(question.llmIqrYesOdds)}
                onClick={() => setMetricExplanation(getMetricExplanation("IQR", formatSpread(question.llmIqrYesOdds), question))}
              />
              <StatCard
                label="Trimmed Range"
                value={formatSpread(question.llmTrimmedRangeYesOdds)}
                onClick={() => setMetricExplanation(getMetricExplanation("Trimmed Range", formatSpread(question.llmTrimmedRangeYesOdds), question))}
              />
              <StatCard
                label="Min / Max Yes"
                value={formatRange(
                  question.llmMinYesOdds,
                  question.llmMaxYesOdds,
                )}
                onClick={() => setMetricExplanation(getMetricExplanation("Min / Max Yes", formatRange(question.llmMinYesOdds, question.llmMaxYesOdds), question))}
              />
              <StatCard
                label="Spread"
                value={formatSpread(question.llmSpreadYesOdds)}
                onClick={() => setMetricExplanation(getMetricExplanation("Spread", formatSpread(question.llmSpreadYesOdds), question))}
              />
              <StatCard
                label="Disagreement Level"
                value={question.llmDisagreementLevel || "—"}
                onClick={() => setMetricExplanation(getMetricExplanation("Disagreement Level", question.llmDisagreementLevel || "—", question))}
              />
              <StatCard
                label="Consensus Signal"
                value={disagreementLabel || "—"}
                onClick={() => setMetricExplanation(getMetricExplanation("Consensus Signal", disagreementLabel || "—", question))}
              />
              <StatCard
                label="Current Yes vs Consensus"
                value={
                  question.currentVsLlmOddsDifference === null
                    ? "—"
                    : question.currentVsLlmOddsDifference.toLocaleString(
                        undefined,
                        {
                          maximumFractionDigits: 2,
                        },
                      )
                }
                onClick={() =>
                  setMetricExplanation(
                    getMetricExplanation(
                      "Current Yes vs Consensus",
                      question.currentVsLlmOddsDifference === null
                        ? "—"
                        : question.currentVsLlmOddsDifference.toLocaleString(
                            undefined,
                            { maximumFractionDigits: 2 },
                          ),
                      question,
                    ),
                  )
                }
              />
              <StatCard
                label="Model Outputs"
                value={question.llmBreakdown.length.toLocaleString()}
                onClick={() => setMetricExplanation(getMetricExplanation("Model Outputs", question.llmBreakdown.length.toLocaleString(), question))}
              />
              <StatCard
                label="Rationale Mismatches"
                value={question.llmRationaleMismatchCount.toLocaleString()}
                onClick={() => setMetricExplanation(getMetricExplanation("Rationale Mismatches", question.llmRationaleMismatchCount.toLocaleString(), question))}
              />
              <StatCard
                label="Evidence Status"
                value={formatDisagreementLabel(question.evidenceStatus)}
                onClick={() => setMetricExplanation(getMetricExplanation("Evidence Status", formatDisagreementLabel(question.evidenceStatus), question))}
              />
              <StatCard
                label="Event State"
                value={formatDisagreementLabel(question.eventState)}
                onClick={() => setMetricExplanation(getMetricExplanation("Event State", formatDisagreementLabel(question.eventState), question))}
              />
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close LLM odds breakdown"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-6 py-5">
          <section className="mb-4 overflow-hidden rounded-2xl border border-slate-200" aria-label="Individual LLM odds and commentary">
            <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
              <h3 className="text-sm font-semibold text-slate-950">Individual LLM odds and commentary</h3>
              <p className="mt-1 text-xs text-slate-500">Every model saved for this event/run, including its probability estimate and descriptive rationale.</p>
            </div>
            {question.llmBreakdown.length ? (
              <div className="divide-y divide-slate-200">
                {question.llmBreakdown.map((output, index) => (
                  <article key={`${output.provider}-${output.model}-${output.runId ?? index}`} className="grid gap-3 px-4 py-4 md:grid-cols-[minmax(12rem,0.8fr)_minmax(10rem,0.6fr)_minmax(20rem,2fr)]">
                    <div><p className="text-xs font-bold text-slate-950">{output.provider || "Unknown provider"}</p><p className="mt-1 break-words text-xs text-slate-500">{output.model || "Unknown model"}</p></div>
                    <div className="text-sm font-semibold text-slate-800"><span className="text-emerald-700">Yes {formatOdds(output.llmYesOdds)}</span><br/><span className="text-rose-700">No {formatOdds(output.llmNoOdds)}</span></div>
                    <div><p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Commentary</p><p className="mt-1 whitespace-pre-wrap text-sm leading-5 text-slate-700">{output.rationale || output.invalidReason || output.providerError || "No commentary was saved for this model."}</p></div>
                  </article>
                ))}
              </div>
            ) : <p className="px-4 py-5 text-sm text-slate-500">No individual model outputs were saved for this event/run.</p>}
          </section>
          {reviewState ? (
            <div
              className={`mb-4 flex items-start gap-3 rounded-2xl px-4 py-3 text-sm ${
                reviewState.tone === "high"
                  ? "border border-amber-300 bg-amber-50 text-amber-900"
                  : "border border-sky-200 bg-sky-50 text-sky-900"
              }`}
            >
              <button
                type="button"
                onClick={() => setIsCriteriaOpen(true)}
                className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition focus:outline-none focus:ring-2 ${
                  reviewState.tone === "high"
                    ? "text-amber-800 hover:bg-amber-100 hover:text-amber-950 focus:ring-amber-400"
                    : "text-sky-800 hover:bg-sky-100 hover:text-sky-950 focus:ring-sky-400"
                }`}
                aria-label="Open LLM consensus criteria"
                title="Open LLM consensus criteria"
              >
                <AlertTriangle className="h-4 w-4" />
              </button>
              <p>
                <button
                  type="button"
                  onClick={() => setIsCriteriaOpen(true)}
                  className={`font-semibold underline underline-offset-4 transition ${
                    reviewState.tone === "high"
                      ? "decoration-amber-500/60 hover:text-amber-950"
                      : "decoration-sky-500/60 hover:text-sky-950"
                  }`}
                >
                  {reviewState.label}
                </button>{" "}
                —{" "}
                {reviewState.tone === "high"
                  ? "provider-level camps are split, so manual/adjudicator review is needed."
                  : "robust consensus exists, but the breakdown still deserves a quick sanity-check."}
              </p>
            </div>
          ) : null}
          <div className="mb-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm text-slate-700">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Preflight Evidence Block:
            </p>
            <p className="mt-2 text-xs leading-5 text-slate-500">
              This is the event evidence package sent into the latest Bullpen
              LLM run.
            </p>
            <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words rounded-2xl border border-slate-200 bg-white px-4 py-4 font-mono text-xs leading-6 text-slate-700">
              {preflightEvidenceBlock}
            </pre>
          </div>
          <BullpenEventHistoricalAssessmentTable
            question={question}
            runs={historicalRuns}
            decisions={historicalDecisions}
          />
        </div>
      </div>
      {isCriteriaOpen ? (
        <HighDisagreementCriteriaDialog
          question={question}
          onClose={() => setIsCriteriaOpen(false)}
        />
      ) : null}
      {metricExplanation ? (
        <MetricExplanationDialog
          explanation={metricExplanation}
          onClose={() => setMetricExplanation(null)}
        />
      ) : null}
    </div>
  );
}
