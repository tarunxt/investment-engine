"use client";

import { useState } from "react";

import {
  BullpenQuestionsTable,
  type BullpenTableSortState,
} from "@/app/console/bullpen-ai/_components/BullpenQuestionsTable";
import { StageTwoLlmRunDetailsDialog } from "@/app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard";
import { buildBullpenAutoRunWorkflowView } from "@/app/console/bullpen-ai/_components/bullpenAutoRunProgress";
import {
  buildStageTwoEventsSummaryRows,
  getStageTwoLlmReviewedRows,
  resolveStageTwoEventsSummaryUpdatedAt,
  resolveStageTwoHistoricalAsOfTimestamp,
} from "@/app/console/bullpen-ai/_components/bullpenAutoRunStageTwoHistory";
import type { BullpenAutoLiveRun, BullpenAutoLiveStageResult } from "@/types/api";

type StageTwoDialogState = Parameters<
  typeof StageTwoLlmRunDetailsDialog
>[0]["state"];

type FixtureTableState = {
  dialogState: StageTwoDialogState;
  rows: Parameters<typeof BullpenQuestionsTable>[0]["rowsOverride"];
  updatedAt: string | null;
  statusMessage: string | null;
};

const FIXTURE_COMPLETED_AT = "2026-07-16T18:15:07Z";
const FIXTURE_SCAN_COMPLETED_AT = "2026-07-16T18:15:00Z";
const FIXTURE_STATUS_MESSAGE = "Partial results: 4 completed, 1 partial and 4 failed.";

function createStageResult({
  stageNumber,
  workflowStageKey,
  startedAt,
  completedAt,
  reason,
  outputs,
}: {
  stageNumber: number;
  workflowStageKey: "scan" | "llm" | "invest";
  startedAt: string;
  completedAt: string;
  reason: string;
  outputs: Record<string, unknown>;
}) {
  return {
    stage_number: stageNumber,
    stage_name: `Stage ${stageNumber}`,
    status: "pass",
    reason,
    inputs: {},
    outputs: {
      workflow_stage_key: workflowStageKey,
      phase_status: "completed",
      ...outputs,
    },
    guardrails_checked: [],
    hard_block: false,
    started_at: startedAt,
    completed_at: completedAt,
  } satisfies BullpenAutoLiveStageResult;
}

function createFailedEventOutput(model: string) {
  return [
    {
      market_id: "market-alpha",
      question_id: "question-alpha",
      output: {
        provider: "failed-provider",
        model,
        error: "Provider returned no usable probability.",
        completed_at: FIXTURE_COMPLETED_AT,
      },
    },
  ];
}

function createFixtureRun(id: string, startedAt: string): BullpenAutoLiveRun {
  return {
    id,
    triggered_by: "manual",
    status: "completed",
    dry_run: false,
    started_at: startedAt,
    completed_at: FIXTURE_COMPLETED_AT,
    summary: "Stage 2 completed with partial provider coverage.",
    live_execution_requested: false,
    live_execution_attempted: false,
    decisions_count: 0,
    orders_planned: 0,
    orders_submitted: 0,
    error_message: null,
    guardrail_checks: [],
    decision_ids: [],
    stage_results: [
      createStageResult({
        stageNumber: 1,
        workflowStageKey: "scan",
        startedAt: "2026-07-16T18:44:10Z",
        completedAt: FIXTURE_SCAN_COMPLETED_AT,
        reason: "Bullpen scan completed.",
        outputs: {
          completed_items: 2,
          total_items: 2,
          scanned_at: FIXTURE_SCAN_COMPLETED_AT,
          accepted_candidates: [
            {
              question_id: "question-alpha",
              market_id: "market-alpha",
              question: "Will Alpha launch before July 31?",
              market_title: "Will Alpha launch before July 31?",
              market_url: "https://example.com/markets/alpha-launch",
              slug: "alpha-launch",
              close_time: "2026-07-20T18:45:07Z",
              theme: "Launches",
              current_yes_odds: 60,
              current_no_odds: 40,
              volume_usd: 120000,
              liquidity_usd: 54000,
              rules: "Resolves Yes if Alpha launches before July 31, 2026.",
            },
            {
              question_id: "question-beta",
              market_id: "market-beta",
              question: "Will Beta approval happen before August 1?",
              market_title: "Will Beta approval happen before August 1?",
              market_url: "https://example.com/markets/beta-approval",
              slug: "beta-approval",
              close_time: "2026-07-18T11:33:07Z",
              theme: "Biotech",
              current_yes_odds: 19.5,
              current_no_odds: 80.5,
              volume_usd: 98000,
              liquidity_usd: 30000,
              rules: "Resolves Yes if the approval is announced before August 1, 2026.",
            },
          ],
        },
      }),
      createStageResult({
        stageNumber: 2,
        workflowStageKey: "llm",
        startedAt: "2026-07-16T18:44:20Z",
        completedAt: FIXTURE_COMPLETED_AT,
        reason: "Stage 2 finished with partial provider results.",
        outputs: {
          completed_items: 5,
          total_items: 9,
          llm_reviewed_candidates: [],
          llm_target_runs: [
            {
              provider: "openai",
              model: "gpt-4o-mini",
              requested_model: "gpt-4o-mini",
              status: "completed",
              started_at: "2026-07-16T18:44:20Z",
              completed_at: FIXTURE_COMPLETED_AT,
              event_outputs: [
                {
                  market_id: "market-alpha",
                  question_id: "question-alpha",
                  output: {
                    provider: "openai",
                    model: "gpt-4o-mini",
                    yes_odds: 88,
                    no_odds: 12,
                    completed_at: FIXTURE_COMPLETED_AT,
                  },
                },
                {
                  market_id: "market-beta",
                  question_id: "question-beta",
                  output: {
                    provider: "openai",
                    model: "gpt-4o-mini",
                    yes_odds: 12.5,
                    no_odds: 87.5,
                    completed_at: FIXTURE_COMPLETED_AT,
                  },
                },
              ],
            },
            {
              provider: "anthropic",
              model: "claude-3.5-sonnet",
              requested_model: "claude-3.5-sonnet",
              status: "completed",
              started_at: "2026-07-16T18:44:22Z",
              completed_at: FIXTURE_COMPLETED_AT,
              event_outputs: [
                {
                  market_id: "market-alpha",
                  question_id: "question-alpha",
                  output: {
                    provider: "anthropic",
                    model: "claude-3.5-sonnet",
                    yesProbability: 86,
                    noProbability: 14,
                    completed_at: FIXTURE_COMPLETED_AT,
                  },
                },
                {
                  market_id: "market-beta",
                  question_id: "question-beta",
                  output: {
                    provider: "anthropic",
                    model: "claude-3.5-sonnet",
                    fair_yes_probability_pct: 14,
                    fair_no_probability_pct: 86,
                    completed_at: FIXTURE_COMPLETED_AT,
                  },
                },
              ],
            },
            {
              provider: "gemini",
              model: "gemini-2.5-flash",
              requested_model: "gemini-2.5-flash",
              status: "completed",
              started_at: "2026-07-16T18:44:24Z",
              completed_at: FIXTURE_COMPLETED_AT,
              event_outputs: [
                {
                  market_id: "market-alpha",
                  question_id: "question-alpha",
                  output: {
                    provider: "gemini",
                    model: "gemini-2.5-flash",
                    probability_yes: 84,
                    probability_no: 16,
                    completed_at: FIXTURE_COMPLETED_AT,
                  },
                },
                {
                  market_id: "market-beta",
                  question_id: "question-beta",
                  output: {
                    provider: "gemini",
                    model: "gemini-2.5-flash",
                    prob_yes: 13,
                    prob_no: 87,
                    completed_at: FIXTURE_COMPLETED_AT,
                  },
                },
              ],
            },
            {
              provider: "deepseek",
              model: "deepseek-chat",
              requested_model: "deepseek-chat",
              status: "completed",
              started_at: "2026-07-16T18:44:26Z",
              completed_at: FIXTURE_COMPLETED_AT,
              event_outputs: [
                {
                  market_id: "market-alpha",
                  question_id: "question-alpha",
                  output: {
                    provider: "deepseek",
                    model: "deepseek-chat",
                    probabilityYes: 82,
                    probabilityNo: 18,
                    completed_at: FIXTURE_COMPLETED_AT,
                  },
                },
                {
                  market_id: "market-beta",
                  question_id: "question-beta",
                  output: {
                    provider: "deepseek",
                    model: "deepseek-chat",
                    yesOdds: 11,
                    noOdds: 89,
                    completed_at: FIXTURE_COMPLETED_AT,
                  },
                },
              ],
            },
            {
              provider: "openai",
              model: "gpt-4.1-mini",
              requested_model: "gpt-4.1-mini",
              status: "partial",
              started_at: "2026-07-16T18:44:28Z",
              completed_at: FIXTURE_COMPLETED_AT,
              event_outputs: [
                {
                  market_id: "market-alpha",
                  question_id: "question-alpha",
                  output: {
                    provider: "openai",
                    model: "gpt-4.1-mini",
                    yesOdds: 80,
                    noOdds: 20,
                    completed_at: FIXTURE_COMPLETED_AT,
                  },
                },
              ],
            },
            {
              provider: "failed-provider",
              model: "model-fail-1",
              requested_model: "model-fail-1",
              status: "failed",
              started_at: "2026-07-16T18:44:29Z",
              completed_at: FIXTURE_COMPLETED_AT,
              event_outputs: createFailedEventOutput("model-fail-1"),
            },
            {
              provider: "failed-provider",
              model: "model-fail-2",
              requested_model: "model-fail-2",
              status: "failed",
              started_at: "2026-07-16T18:44:30Z",
              completed_at: FIXTURE_COMPLETED_AT,
              event_outputs: createFailedEventOutput("model-fail-2"),
            },
            {
              provider: "failed-provider",
              model: "model-fail-3",
              requested_model: "model-fail-3",
              status: "failed",
              started_at: "2026-07-16T18:44:31Z",
              completed_at: FIXTURE_COMPLETED_AT,
              event_outputs: createFailedEventOutput("model-fail-3"),
            },
            {
              provider: "failed-provider",
              model: "model-fail-4",
              requested_model: "model-fail-4",
              status: "failed",
              started_at: "2026-07-16T18:44:32Z",
              completed_at: FIXTURE_COMPLETED_AT,
              event_outputs: createFailedEventOutput("model-fail-4"),
            },
          ],
        },
      }),
    ],
  };
}

function buildFixtureTableState(run: BullpenAutoLiveRun): FixtureTableState {
  const workflowView = buildBullpenAutoRunWorkflowView(run);
  const scanStage = workflowView.stages.find((stage) => stage.key === "scan")!;
  const llmStage = workflowView.stages.find((stage) => stage.key === "llm")!;
  const reviewedRows = getStageTwoLlmReviewedRows(llmStage, scanStage.scanCandidates);
  const asOfTimestamp = resolveStageTwoHistoricalAsOfTimestamp({
    reviewedRows,
    scanCompletedAt: scanStage.timerCompletedAt,
    stageCompletedAt: llmStage.timerCompletedAt,
    runStartedAt: run.started_at,
    runCompletedAt: run.completed_at ?? null,
  });

  return {
    dialogState: {
      run,
      stage: llmStage,
      decisions: [],
    },
    rows: buildStageTwoEventsSummaryRows({
      reviewedRows,
      decisions: [],
      runId: run.id,
      asOfTimestamp,
    }),
    updatedAt: resolveStageTwoEventsSummaryUpdatedAt({
      reviewedRows,
      stageCompletedAt: llmStage.timerCompletedAt,
      scanCompletedAt: scanStage.timerCompletedAt,
    }),
    statusMessage: FIXTURE_STATUS_MESSAGE,
  };
}

const FIXTURE_RUN_A = buildFixtureTableState(
  createFixtureRun("fixture-run-a", "2026-07-16T18:14:05Z"),
);
const FIXTURE_RUN_B = buildFixtureTableState(
  createFixtureRun("fixture-run-b", "2026-07-16T18:14:35Z"),
);

export default function StageTwoLlmPopupFixturePage() {
  const [dialogState, setDialogState] = useState<StageTwoDialogState | null>(null);
  const [sortState, setSortState] = useState<BullpenTableSortState>({
    key: "returnsPerDay",
    direction: "desc",
  });

  return (
    <main className="min-h-screen bg-slate-100 px-4 py-8 text-slate-950 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                Fixture Harness
              </p>
              <h1 className="mt-2 text-3xl font-semibold text-slate-950">
                Stage 2 Events Summary parity
              </h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
                This page renders the canonical Bullpen Events Summary table and the
                historical Stage 2 popup against the same fixture data so layout,
                scrolling, and historical reconstruction can be verified together.
              </p>
            </div>
            <div className="flex gap-3">
              <button
                data-testid="open-run-a"
                type="button"
                onClick={() => setDialogState(FIXTURE_RUN_A.dialogState)}
                className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:bg-slate-50"
              >
                Open Run A
              </button>
              <button
                data-testid="open-run-b"
                type="button"
                onClick={() => setDialogState(FIXTURE_RUN_B.dialogState)}
                className="rounded-full border border-indigo-300 bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500"
              >
                Open Run B
              </button>
            </div>
          </div>
        </section>

        <section
          data-testid="fixture-main-events-summary"
          className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"
        >
          <BullpenQuestionsTable
            snapshot={null}
            rowsOverride={FIXTURE_RUN_A.rows}
            headerContent={null}
            updatedAt={FIXTURE_RUN_A.updatedAt}
            updateStatusMessage={FIXTURE_RUN_A.statusMessage ?? undefined}
            emptyMessage="Fixture rows unavailable."
            isLoading={false}
            selectionEnabled={false}
            selectedQuestionIds={new Set<string>()}
            sortState={sortState}
            onSortChange={(key) =>
              setSortState((current) => ({
                key,
                direction:
                  current.key === key && current.direction === "desc"
                    ? "asc"
                    : "desc",
              }))
            }
            onToggleQuestion={() => undefined}
            onToggleSelectAll={() => undefined}
          />
        </section>
      </div>

      {dialogState ? (
        <StageTwoLlmRunDetailsDialog
          state={dialogState}
          onClose={() => setDialogState(null)}
        />
      ) : null}
    </main>
  );
}
