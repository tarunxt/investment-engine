"use client";

import { type ReactNode } from "react";
import { X } from "lucide-react";
import { formatOddsPercent, formatUsdCost, formatPriceCents, isRecord, getStageTwoLlmFailureFixAdvice, hasReturnedValue, formatJsonForDisplay, readNestedRecord, readFirstReturnedValue, getStageTwoDisplayedPrompt, getStageTwoLlmPromptInputs, getStageTwoLlmPromptInputMarket, getStageTwoLlmPromptInputEvidencePacket, getStageTwoLlmMissingValueReason, getStageTwoPromptMissingValueReason } from "./bullpenDetailPresentationSupport";
import type { StageTwoDecisionDialogState, StageTwoDecisionDialogMode, StageTwoLlmEventInputDialogState, RunSummaryWarning, PlannedOrderDetailState, DecisionLlmOddsState, StageTwoRunSummaryStatus, StageTwoLlmRunSummaryRow, StageTwoLlmFailureDialogRow } from "./bullpenDetailPresentationSupport";

export function RunWarningsDialog({
  warnings,
  onClose,
}: {
  warnings: RunSummaryWarning[];
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[155] flex items-center justify-center bg-slate-950/60 p-4">
      <div className="flex max-h-[80vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-amber-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.55)]">
        <div className="flex items-start justify-between gap-4 border-b border-amber-100 px-6 py-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-amber-700">
              Brief warnings / errors
            </p>
            <h3 className="mt-1 text-lg font-semibold text-slate-950">
              Detailed messages
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close warnings"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-y-auto px-6 py-5">
          <div className="space-y-3">
            {warnings.map((warning, index) => (
              <div
                key={`${warning.label}-${index}`}
                className="rounded-2xl border border-amber-100 bg-amber-50/60 p-4"
              >
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-800">
                  {warning.label}
                </p>
                <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">
                  {warning.detail}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function DecisionLlmOddsDialog({
  state,
  onClose,
}: {
  state: DecisionLlmOddsState;
  onClose: () => void;
}) {
  const { decision } = state;
  return (
    <div className="fixed inset-0 z-[155] flex items-center justify-center bg-slate-950/60 p-4">
      <div className="flex max-h-[82vh] w-full max-w-5xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.55)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-violet-700">
              LLM Odds Breakdown
            </p>
            <h3 className="mt-1 text-lg font-semibold text-slate-950">
              {decision.market_title}
            </h3>
            <p className="mt-2 text-sm text-slate-600">
              Consensus Yes{" "}
              {formatOddsPercent(decision.fair_yes_probability_pct ?? null)} ·
              Consensus No{" "}
              {formatOddsPercent(decision.fair_no_probability_pct ?? null)}
            </p>
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
        <div className="overflow-y-auto px-6 py-5">
          {decision.llm_outputs.length ? (
            <div className="space-y-3">
              {decision.llm_outputs.map((output, index) => (
                <div
                  key={`${output.provider}-${output.model}-${index}`}
                  className="rounded-2xl border border-violet-100 bg-violet-50/40 p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-slate-950">
                      {output.provider} · {output.model}
                    </p>
                    <div className="flex gap-2 text-xs font-semibold">
                      <span className="rounded-full border border-violet-200 bg-white px-2.5 py-1 text-violet-800">
                        Yes {formatOddsPercent(output.llm_yes_odds ?? null)}
                      </span>
                      <span className="rounded-full border border-violet-200 bg-white px-2.5 py-1 text-violet-800">
                        No {formatOddsPercent(output.llm_no_odds ?? null)}
                      </span>
                    </div>
                  </div>
                  {output.rationale ? (
                    <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-700">
                      {output.rationale}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <p className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
              No per-model LLM outputs were recorded for this decision.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export function PlannedOrderDetailDialog({
  state,
  onClose,
}: {
  state: PlannedOrderDetailState;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[155] flex items-center justify-center bg-slate-950/60 p-4">
      <div className="flex max-h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.55)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
              Planned but not submitted
            </p>
            <h3 className="mt-1 text-lg font-semibold text-slate-950">
              {state.title}
            </h3>
            <p className="mt-2 text-sm text-slate-600">{state.summary}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close planned order detail"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-y-auto px-6 py-5">
          <pre className="whitespace-pre-wrap break-words rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-700">
            {state.detail}
          </pre>
        </div>
      </div>
    </div>
  );
}

export function StageTwoLlmFailureDialog({
  row,
  onClose,
}: {
  row: StageTwoLlmFailureDialogRow;
  onClose: () => void;
}) {
  const errorMessage =
    row.error || "No safe provider error was captured for this target.";
  const diagnosticJson = JSON.stringify(
    {
      provider: row.provider,
      requested_model: row.requestedModel,
      actual_model: row.model,
      failure_category: row.failureCategory,
      first_error: row.firstError,
      last_error: row.lastError,
      batch_errors: row.batchErrors,
    },
    null,
    2,
  );
  const diagnostics = [
    ["Runtime", row.runtime],
    ["Cost", formatUsdCost(row.cost)],
    ["Failure category", row.failureCategory ?? "—"],
    ["Requested model", row.requestedModel ?? "—"],
    ["Actual model", row.model],
    ["Failed events", row.failedEventCount?.toLocaleString("en-IN") ?? "—"],
    ["Invalid events", row.invalidEventCount?.toLocaleString("en-IN") ?? "—"],
    ["Blocked events", row.blockedEventCount?.toLocaleString("en-IN") ?? "—"],
    ["Retry requests", row.retryRequestCount?.toLocaleString("en-IN") ?? "—"],
    [
      "Recovery batches",
      row.recoveryBatchCount?.toLocaleString("en-IN") ?? "—",
    ],
  ];

  return (
    <div className="fixed inset-0 z-[170] flex items-center justify-center bg-slate-950/50 p-4">
      <div className="w-full max-w-2xl overflow-hidden rounded-3xl border border-red-200 bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-red-100 bg-red-50 px-6 py-5">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.22em] text-red-600">
              LLM failure details
            </p>
            <h3 className="mt-1 text-xl font-extrabold text-slate-950">
              {row.provider} · {row.model}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-red-200 bg-white text-red-600 transition hover:bg-red-100"
            aria-label="Close LLM failure details"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-5 px-6 py-5">
          <section>
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">
              Why it failed / error
            </p>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-2xl border border-red-100 bg-red-50 p-4 text-sm font-semibold text-red-800">
              {errorMessage}
            </pre>
          </section>
          <section>
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">
              What to do to fix it
            </p>
            <p className="mt-2 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-900">
              {getStageTwoLlmFailureFixAdvice(row)}
            </p>
          </section>
          <section>
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">
              Run diagnostics
            </p>
            <dl className="mt-2 grid gap-2 sm:grid-cols-2">
              {diagnostics.map(([label, value]) => (
                <div
                  key={label}
                  className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3"
                >
                  <dt className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
                    {label}
                  </dt>
                  <dd className="mt-1 font-mono text-sm font-bold text-slate-900">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
          <section>
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">
              Copyable diagnostic JSON
            </p>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs leading-5 text-slate-800">
              {diagnosticJson}
            </pre>
          </section>
        </div>
      </div>
    </div>
  );
}

export function MissingValueNote({ children }: { children: ReactNode }) {
  return (
    <p className="mt-1 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] leading-4 text-amber-800">
      {children}
    </p>
  );
}

export function StageTwoInputPromptDialog({
  llmContext,
  promptTemplate,
  onClose,
}: {
  llmContext: Record<string, unknown> | null;
  promptTemplate: unknown;
  onClose: () => void;
}) {
  const prompt = getStageTwoDisplayedPrompt(llmContext, promptTemplate);
  const missingReason = getStageTwoPromptMissingValueReason(
    "Stage 2 Input prompt",
    llmContext,
    promptTemplate,
  );

  return (
    <div className="fixed inset-0 z-[170] flex items-center justify-center bg-slate-950/60 p-4">
      <div className="flex max-h-[86vh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.55)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
              Stage 2 Input prompt
            </p>
            <h2 className="mt-1 text-xl font-semibold text-slate-950">
              Stage 2 Input prompt
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close Stage 2 input prompt"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-auto px-6 py-5 text-sm text-slate-700">
          <pre className="max-h-[62vh] overflow-auto whitespace-pre-wrap rounded-2xl border border-violet-200 bg-violet-50/60 p-4 text-xs leading-5 text-slate-800">
            {formatJsonForDisplay(prompt)}
          </pre>
          {missingReason ? (
            <MissingValueNote>{missingReason}</MissingValueNote>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function StageTwoLlmEventInputDialog({
  state,
  promptTemplate,
  onClose,
}: {
  state: StageTwoLlmEventInputDialogState;
  promptTemplate: unknown;
  onClose: () => void;
}) {
  const { title, llmContext } = state;
  const prompt = getStageTwoDisplayedPrompt(llmContext, promptTemplate);
  const promptInputs = getStageTwoLlmPromptInputs(llmContext);
  const promptInputMarket = getStageTwoLlmPromptInputMarket(llmContext);
  const evidencePacket = getStageTwoLlmPromptInputEvidencePacket(llmContext);
  const promptMissingReason = getStageTwoPromptMissingValueReason(
    "Common prompt sent to LLM",
    llmContext,
    promptTemplate,
  );
  const eventInputEntries = [
    ["market_id", llmContext?.market_id, promptInputMarket?.market_id],
    ["slug", llmContext?.slug, promptInputMarket?.slug],
    [
      "question",
      llmContext?.question ?? llmContext?.market_title,
      promptInputMarket?.question,
    ],
    ["market_url", llmContext?.market_url, promptInputMarket?.market_url],
    [
      "current_yes_odds",
      llmContext?.current_yes_odds,
      promptInputMarket?.current_yes_odds,
    ],
    [
      "current_no_odds",
      llmContext?.current_no_odds,
      promptInputMarket?.current_no_odds,
    ],
    ["volume_usd", llmContext?.volume_usd, promptInputMarket?.volume_usd],
    [
      "liquidity_usd",
      llmContext?.liquidity_usd,
      promptInputMarket?.liquidity_usd,
    ],
    ["close_time", llmContext?.close_time, promptInputMarket?.close_time],
    ["theme", llmContext?.theme, promptInputMarket?.theme],
    ["source", llmContext?.source, promptInputMarket?.source],
  ] as const;

  return (
    <div className="fixed inset-0 z-[170] flex items-center justify-center bg-slate-950/60 p-4">
      <div className="flex max-h-[86vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.55)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
              Event LLM input
            </p>
            <h2 className="mt-1 text-xl font-semibold text-slate-950">
              {title}
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              Input data and common prompt used for the LLM review of this
              event.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close event LLM input"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-auto px-6 py-5 text-sm text-slate-700">
          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-2xl border border-sky-200 bg-sky-50/60 p-4">
              <p className="font-semibold text-sky-950">
                Easy-read event input
              </p>
              <dl className="mt-3 space-y-2">
                {eventInputEntries.map(([key, primaryValue, fallbackValue]) => {
                  const value = readFirstReturnedValue(
                    primaryValue,
                    fallbackValue,
                  );
                  const missingReason = getStageTwoLlmMissingValueReason(
                    key.replaceAll("_", " "),
                    primaryValue,
                    fallbackValue,
                  );
                  return (
                    <div key={key} className="rounded-xl bg-white/80 px-3 py-2">
                      <dt className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                        {key.replaceAll("_", " ")}
                      </dt>
                      <dd className="mt-1 break-words font-medium text-slate-900">
                        {formatJsonForDisplay(value)}
                      </dd>
                      {missingReason ? (
                        <MissingValueNote>{missingReason}</MissingValueNote>
                      ) : null}
                    </div>
                  );
                })}
              </dl>
            </section>
            <section className="rounded-2xl border border-violet-200 bg-violet-50/60 p-4">
              <p className="font-semibold text-violet-950">
                Common prompt sent to LLM
              </p>
              <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap rounded-xl bg-white p-4 text-xs leading-5 text-slate-800">
                {formatJsonForDisplay(prompt)}
              </pre>
              {promptMissingReason ? (
                <MissingValueNote>{promptMissingReason}</MissingValueNote>
              ) : null}
            </section>
          </div>
          <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
            <p className="font-semibold text-slate-950">
              Full organised prompt inputs
            </p>
            <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap rounded-xl bg-slate-50 p-4 text-xs leading-5 text-slate-800">
              {formatJsonForDisplay(promptInputs)}
            </pre>
          </section>
          <section className="mt-4 rounded-2xl border border-amber-200 bg-amber-50/70 p-4">
            <p className="font-semibold text-amber-950">Evidence packet</p>
            <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap rounded-xl bg-white p-4 text-xs leading-5 text-slate-800">
              {formatJsonForDisplay(evidencePacket)}
            </pre>
            {getStageTwoLlmMissingValueReason(
              "Evidence packet",
              llmContext?.evidence_packet,
              evidencePacket,
            ) ? (
              <MissingValueNote>
                {getStageTwoLlmMissingValueReason(
                  "Evidence packet",
                  llmContext?.evidence_packet,
                  evidencePacket,
                )}
              </MissingValueNote>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}

export function StageTwoDecisionDetailDialog({
  mode,
  state,
  promptTemplate,
  onClose,
}: {
  mode: StageTwoDecisionDialogMode;
  state: StageTwoDecisionDialogState;
  promptTemplate: unknown;
  onClose: () => void;
}) {
  const { decision, llmContext } = state;
  const prompt = getStageTwoDisplayedPrompt(llmContext, promptTemplate);
  const promptInputs = getStageTwoLlmPromptInputs(llmContext);
  const evidencePacket = getStageTwoLlmPromptInputEvidencePacket(llmContext);
  const title =
    mode === "tag" ? "Decision tag details" : "LLM prompt + input packet";
  const promptMissingReason = getStageTwoPromptMissingValueReason(
    "Prompt sent to the LLM",
    llmContext,
    promptTemplate,
  );

  return (
    <div className="fixed inset-0 z-[170] flex items-center justify-center bg-slate-950/60 p-4">
      <div className="flex max-h-[86vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.55)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
              {title}
            </p>
            <h2 className="mt-1 text-xl font-semibold text-slate-950">
              {decision.market_title}
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              {decision.decision} · {decision.risk_status} · {decision.side}{" "}
              side · Current YES/NO{" "}
              {formatPriceCents(decision.current_yes_odds ?? null)} /{" "}
              {formatPriceCents(decision.current_no_odds ?? null)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close decision details"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-auto px-6 py-5 text-sm text-slate-700">
          {mode === "tag" ? (
            <div className="space-y-4">
              <section className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="font-semibold text-slate-950">
                  What this tag means
                </p>
                <p className="mt-2 leading-6">
                  Action <b>{decision.decision}</b> with risk status{" "}
                  <b>{decision.risk_status}</b> means the Stage 2 LLM/rules
                  pipeline classified this event as{" "}
                  {decision.decision === "EXIT"
                    ? "an event exit candidate that should move to the exit flow"
                    : decision.decision === "SKIP"
                      ? "not currently actionable for investment"
                      : "an actionable portfolio decision"}
                  .
                </p>
              </section>
              <section className="rounded-2xl border border-slate-200 bg-white p-4">
                <p className="font-semibold text-slate-950">
                  Why this event was tagged this way
                </p>
                <p className="mt-2 leading-6">
                  <span className="font-semibold">Summary:</span>{" "}
                  {decision.summary || decision.reason}
                </p>
                <p className="mt-2 leading-6">
                  <span className="font-semibold">Rationale:</span>{" "}
                  {decision.rationale || decision.reason}
                </p>
                {decision.exit_signals.length ? (
                  <ul className="mt-3 list-disc space-y-1 pl-5">
                    {decision.exit_signals.map((signal, index) => (
                      <li key={`${signal.reasonCode}-${index}`}>
                        <b>{signal.label}:</b> {signal.description}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            </div>
          ) : (
            <div className="space-y-4">
              <section className="rounded-2xl border border-violet-200 bg-violet-50/60 p-4">
                <p className="font-semibold text-violet-950">
                  Prompt sent to the LLM
                </p>
                <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-white p-4 text-xs leading-5 text-slate-800">
                  {formatJsonForDisplay(prompt)}
                </pre>
                {promptMissingReason ? (
                  <MissingValueNote>{promptMissingReason}</MissingValueNote>
                ) : null}
              </section>
              <section className="rounded-2xl border border-slate-200 bg-white p-4">
                <p className="font-semibold text-slate-950">
                  Organised prompt inputs
                </p>
                <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-slate-50 p-4 text-xs leading-5 text-slate-800">
                  {formatJsonForDisplay(promptInputs)}
                </pre>
              </section>
              <section className="rounded-2xl border border-amber-200 bg-amber-50/70 p-4">
                <p className="font-semibold text-amber-950">Evidence packet</p>
                <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-white p-4 text-xs leading-5 text-slate-800">
                  {formatJsonForDisplay(evidencePacket)}
                </pre>
              </section>
              {!llmContext ? (
                <p className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-slate-600">
                  This run did not return a matching Stage 2 LLM review context
                  for this decision.
                </p>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
