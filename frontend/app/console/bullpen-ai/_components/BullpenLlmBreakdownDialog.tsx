"use client";

import { AlertTriangle, X } from "lucide-react";
import { useState } from "react";

import {
  buildBullpenQuestionPreflightEvidenceBlock,
  type BullpenQuestionRow,
} from "@/lib/bullpen-ai";
import { formatApiTimestamp } from "@/lib/datetime";
import {
  getInternetAccessBadgeText,
  getInternetAccessTooltipText,
  getResolvedProviderInternetAccess,
  isWebCapableInternetAccess,
} from "@/lib/llmInternetAccess";

type BullpenLlmBreakdownDialogProps = {
  question: BullpenQuestionRow;
  onClose: () => void;
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

function formatYesNo(value: boolean | null | undefined) {
  if (value === true) return "Yes";
  if (value === false) return "No";
  return "—";
}

function isLikelyUrl(value: string) {
  return /^https?:\/\//i.test(value);
}

function StatCard({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
        {label}
      </p>
      <p className="mt-1 text-sm font-semibold text-slate-900">{value}</p>
    </div>
  );
}

function getHighDisagreementReason(question: BullpenQuestionRow) {
  const spread = formatSpread(question.llmSpreadYesOdds);
  const minYes = formatOdds(question.llmMinYesOdds);
  const maxYes = formatOdds(question.llmMaxYesOdds);
  const modelCount = question.llmBreakdown.length.toLocaleString();

  if (question.llmSpreadYesOdds === null) {
    return `This event is marked for adjudication, but the per-model spread is not available. ${modelCount} model outputs were received.`;
  }

  return `This event has a ${spread} gap between the lowest Yes estimate (${minYes}) and highest Yes estimate (${maxYes}) across ${modelCount} model outputs. That is above the 30-point high-disagreement threshold.`;
}

function HighDisagreementCriteriaDialog({
  question,
  onClose,
}: {
  question: BullpenQuestionRow;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[140] flex items-center justify-center bg-slate-950/40 p-4">
      <div className="w-full max-w-2xl overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_24px_70px_-24px_rgba(15,23,42,0.45)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-amber-700">
              High LLM Disagreement Criteria
            </p>
            <h3 className="mt-2 text-lg font-semibold text-slate-950">
              Why this event needs manual review
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close high disagreement criteria"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-5 px-6 py-5 text-sm leading-6 text-slate-700">
          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-950">
            {getHighDisagreementReason(question)}
          </div>
          <div>
            <h4 className="font-semibold text-slate-950">Criteria used</h4>
            <ul className="mt-2 list-disc space-y-2 pl-5">
              <li>
                Calculate each model&apos;s normalized Yes odds, then compare the
                minimum and maximum Yes estimates.
              </li>
              <li>
                <span className="font-semibold text-slate-950">Low:</span> spread is
                15 points or less.
              </li>
              <li>
                <span className="font-semibold text-slate-950">Medium:</span> spread
                is greater than 15 points and up to 30 points.
              </li>
              <li>
                <span className="font-semibold text-slate-950">High:</span> spread is
                greater than 30 points. High disagreement also sets
                adjudicationRequired and switches consensus odds to the median
                instead of the simple average.
              </li>
            </ul>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <StatCard
              label="This Event Spread"
              value={formatSpread(question.llmSpreadYesOdds)}
            />
            <StatCard
              label="Min / Max Yes"
              value={formatRange(
                question.llmMinYesOdds,
                question.llmMaxYesOdds,
              )}
            />
            <StatCard
              label="Consensus Method"
              value={
                question.llmDisagreementLevel === "High" ? "Median" : "Average"
              }
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
}: BullpenLlmBreakdownDialogProps) {
  const [isCriteriaOpen, setIsCriteriaOpen] = useState(false);
  const preflightEvidenceBlock =
    question.preflightEvidenceBlock ||
    buildBullpenQuestionPreflightEvidenceBlock(question);

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/55 p-4">
      <div className="flex max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.45)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
              LLM Odds Breakdown
            </p>
            <h2 className="max-w-4xl text-xl font-semibold text-slate-950">
              {question.question}
            </h2>
            <div className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-5">
              <StatCard
                label="Consensus Yes"
                value={formatOdds(question.llmYesOdds)}
              />
              <StatCard
                label="Consensus No"
                value={formatOdds(question.llmNoOdds)}
              />
              <StatCard
                label="Average Yes"
                value={formatOdds(question.llmAverageYesOdds)}
              />
              <StatCard
                label="Median Yes"
                value={formatOdds(question.llmMedianYesOdds)}
              />
              <StatCard
                label="Trimmed Mean Yes"
                value={formatOdds(question.llmTrimmedMeanYesOdds)}
              />
              <StatCard
                label="Min / Max Yes"
                value={formatRange(
                  question.llmMinYesOdds,
                  question.llmMaxYesOdds,
                )}
              />
              <StatCard
                label="Spread"
                value={formatSpread(question.llmSpreadYesOdds)}
              />
              <StatCard
                label="Disagreement Level"
                value={question.llmDisagreementLevel || "—"}
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
              />
              <StatCard
                label="Model Outputs"
                value={question.llmBreakdown.length.toLocaleString()}
              />
              <StatCard
                label="Evidence Status"
                value={formatDisagreementLabel(question.evidenceStatus)}
              />
              <StatCard
                label="Event State"
                value={formatDisagreementLabel(question.eventState)}
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
          {question.adjudicationRequired ? (
            <div className="mb-4 flex items-start gap-3 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <button
                type="button"
                onClick={() => setIsCriteriaOpen(true)}
                className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-amber-800 transition hover:bg-amber-100 hover:text-amber-950 focus:outline-none focus:ring-2 focus:ring-amber-400"
                aria-label="Open high LLM disagreement criteria"
                title="Open high LLM disagreement criteria"
              >
                <AlertTriangle className="h-4 w-4" />
              </button>
              <p>
                <button
                  type="button"
                  onClick={() => setIsCriteriaOpen(true)}
                  className="font-semibold underline decoration-amber-500/60 underline-offset-4 transition hover:text-amber-950"
                >
                  High LLM disagreement
                </button>{" "}
                — do not rely on simple average. Manual/adjudicator review needed.
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
          {question.llmBreakdown.length > 0 ? (
            <div className="overflow-hidden rounded-2xl border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Provider</th>
                    <th className="px-4 py-3">Model</th>
                    <th className="px-4 py-3">LLM Yes Odds</th>
                    <th className="px-4 py-3">LLM No Odds</th>
                    <th className="px-4 py-3">Timestamp</th>
                    <th className="px-4 py-3">Rationale</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {question.llmBreakdown.map((entry) => (
                    <tr key={`${entry.provider}::${entry.model}::${entry.jobId ?? "job"}`}>
                      <td className="whitespace-nowrap px-4 py-3 font-medium text-slate-900">
                        {entry.provider}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                        {entry.model}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-semibold text-indigo-700">
                        {formatOdds(entry.llmYesOdds)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-semibold text-violet-700">
                        {formatOdds(entry.llmNoOdds)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                        {formatDate(entry.timestamp)}
                      </td>
                      <td className="min-w-[320px] px-4 py-3 leading-6 text-slate-700">
                        {(() => {
                          const internetAccess = getResolvedProviderInternetAccess(
                            entry.provider,
                          );
                          const webCapable =
                            isWebCapableInternetAccess(internetAccess);
                          const showNoSearchWarning =
                            webCapable && entry.webSearchUsed === false;
                          const showNoSourcesWarning =
                            entry.webSearchUsed === true &&
                            (entry.webSources?.length || 0) === 0;

                          return (
                            <div className="space-y-2">
                              <p>{entry.rationale || "—"}</p>
                              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3 text-xs leading-5 text-slate-600">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span
                                    title={getInternetAccessTooltipText(
                                      internetAccess,
                                    )}
                                    className="rounded-full bg-sky-50 px-2 py-0.5 font-medium text-sky-700 ring-1 ring-sky-100"
                                  >
                                    {getInternetAccessBadgeText(internetAccess)}
                                  </span>
                                  {entry.invalidStaleFact ? (
                                    <span className="rounded-full bg-rose-50 px-2 py-0.5 font-medium text-rose-700 ring-1 ring-rose-100">
                                      Invalid stale fact
                                    </span>
                                  ) : null}
                                </div>
                                <div>Web used: {formatYesNo(entry.webSearchUsed)}</div>
                                <div>
                                  Sources count:{" "}
                                  {(entry.webSources || []).length.toLocaleString()}
                                </div>
                                {entry.webSearchQueries.length > 0 ? (
                                  <div>
                                    Search queries:{" "}
                                    {entry.webSearchQueries.join(" | ")}
                                  </div>
                                ) : null}
                                {entry.webSources.length > 0 ? (
                                  <div className="space-y-1">
                                    <div>Sources:</div>
                                    {entry.webSources.slice(0, 4).map((source) =>
                                      isLikelyUrl(source) ? (
                                        <a
                                          key={source}
                                          href={source}
                                          target="_blank"
                                          rel="noreferrer"
                                          className="block break-all text-sky-700 underline decoration-sky-300 underline-offset-2"
                                        >
                                          {source}
                                        </a>
                                      ) : (
                                        <div key={source} className="break-words">
                                          {source}
                                        </div>
                                      ),
                                    )}
                                    {entry.webSources.length > 4 ? (
                                      <div>
                                        +{entry.webSources.length - 4} more source
                                        {entry.webSources.length - 4 === 1
                                          ? ""
                                          : "s"}
                                      </div>
                                    ) : null}
                                  </div>
                                ) : null}
                                {showNoSearchWarning ? (
                                  <div className="font-medium text-amber-700">
                                    Warning: This model can use live web data, but no
                                    search was actually used in this run.
                                  </div>
                                ) : null}
                                {showNoSourcesWarning ? (
                                  <div className="font-medium text-amber-700">
                                    Warning: Live web/search ran, but no sources were
                                    returned or saved.
                                  </div>
                                ) : null}
                                {entry.invalidStaleFact && entry.staleFactReason ? (
                                  <div className="font-medium text-rose-700">
                                    Excluded from consensus: {entry.staleFactReason}
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          );
                        })()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-600">
              No per-model LLM breakdown is available for this question yet.
            </div>
          )}
        </div>
      </div>
      {isCriteriaOpen ? (
        <HighDisagreementCriteriaDialog
          question={question}
          onClose={() => setIsCriteriaOpen(false)}
        />
      ) : null}
    </div>
  );
}
