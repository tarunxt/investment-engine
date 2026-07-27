from __future__ import annotations

from pathlib import Path


def replace_once(text: str, old: str, new: str, *, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


def patch_console_projection() -> None:
    path = Path("backend/app/domains/polymarket_auto_live/console_projection.py")
    text = path.read_text(encoding="utf-8")
    text = replace_once(
        text,
        "CONSOLE_PROJECTION_VERSION = 1",
        "CONSOLE_PROJECTION_VERSION = 2",
        label="projection version",
    )
    text = replace_once(
        text,
        '''_LIST_LIMITS = {
    "active_positions_found": 10,
''',
        '''_LIST_LIMITS = {
    # Candidate identity rows are required to repopulate the Auto Scan table.
    # Keep the list bounded, while allowing the normal 30-day/EOM scan universe
    # to survive the lightweight dashboard projection without an extra read.
    "accepted_candidates": 100,
    "active_positions_found": 10,
''',
        label="candidate projection list limit",
    )
    text = replace_once(
        text,
        '''    "accepted_candidates_count",
    "candidate_rows_before_llm",
''',
        '''    "accepted_candidates_count",
    "accepted_candidates",
    "candidate_rows_before_llm",
''',
        label="candidate projection key",
    )
    text = replace_once(
        text,
        '''    "active_position_rows",
    "active_positions_found",
''',
        '''    "active_position_rows",
    "active_position_rows_before_llm",
    "active_positions_found",
''',
        label="active row projection key",
    )
    text = replace_once(
        text,
        '''    "llm_candidate_count",
    "llm_reviewed_candidates",
''',
        '''    "llm_candidate_count",
    "llm_reviewed_candidates",
    "llm_started_provider_target_count",
''',
        label="LLM started target projection key",
    )
    path.write_text(text, encoding="utf-8")


def patch_projection_tests() -> None:
    path = Path("backend/tests/test_polymarket_auto_live_console_projection.py")
    text = path.read_text(encoding="utf-8")
    text = replace_once(
        text,
        '''            "accepted_candidates_count": 25,
            "console_trade_cash_in_hand_usd": 3.44,
''',
        '''            "accepted_candidates_count": 44,
            "accepted_candidates": [
                {
                    "question_id": f"question-{index}",
                    "market_id": f"market-{index}",
                    "question": f"Will event {index} happen?",
                    "slug": f"market-{index}",
                    "close_time": "2026-08-01T10:00:00+00:00",
                    "current_yes_odds": 40,
                    "current_no_odds": 60,
                    "rules": "Expandable rules are omitted from the live projection.",
                }
                for index in range(44)
            ],
            "active_position_rows_before_llm": 3,
            "console_trade_cash_in_hand_usd": 3.44,
''',
        label="projection fixture candidate evidence",
    )
    text = replace_once(
        text,
        '''    assert len(
        projection["stage_results"][0]["outputs"]["llm_reviewed_candidates"]
    ) == 10
    assert (
''',
        '''    assert len(
        projection["stage_results"][0]["outputs"]["llm_reviewed_candidates"]
    ) == 10
    assert len(
        projection["stage_results"][0]["outputs"]["accepted_candidates"]
    ) == 44
    assert (
        projection["stage_results"][0]["outputs"][
            "active_position_rows_before_llm"
        ]
        == 3
    )
    assert (
''',
        label="projection candidate assertions",
    )
    path.write_text(text, encoding="utf-8")


def patch_console_detail_merge() -> None:
    path = Path("frontend/lib/bullpenRunConsoleDetail.ts")
    text = path.read_text(encoding="utf-8")
    text = replace_once(
        text,
        '''  "active_position_rows",
  "wallet_snapshot_status",
''',
        '''  "active_position_rows",
  "active_position_rows_before_llm",
  "wallet_snapshot_status",
''',
        label="authoritative active row count",
    )
    text = replace_once(
        text,
        '''const FROZEN_EVIDENCE_OUTPUT_KEYS = [
  "active_positions_found",
''',
        '''const FROZEN_EVIDENCE_OUTPUT_KEYS = [
  "accepted_candidates",
  "active_positions_found",
''',
        label="preserve exact accepted candidates",
    )
    path.write_text(text, encoding="utf-8")


def patch_auto_run_sync() -> None:
    path = Path(
        "frontend/app/console/bullpen-ai/_components/bullpenAutoRunSync.ts"
    )
    text = path.read_text(encoding="utf-8")
    text = replace_once(
        text,
        '''  const acceptedCandidates = readAcceptedCandidates(stage1);
  if (acceptedCandidates.length === 0) return snapshotsByMode;

  const currentHistory = snapshotsByMode[mode];
''',
        '''  const acceptedCandidates = readAcceptedCandidates(stage1);
  const stage2 = findWorkflowStage(run, "llm", 2);
  const reviewedCandidateFallback = readReviewedCandidates(stage2).filter(
    (candidate) => {
      if (!isRecord(candidate)) return false;
      const sourceKind = readString(candidate.source_kind);
      return (
        sourceKind === "candidate" ||
        (sourceKind !== "active_position" && !readString(candidate.position_key))
      );
    },
  );
  // Older or aggressively compacted projections may omit Stage 1's candidate
  // rows while retaining Stage 2's reviewed candidate identities. Never leave
  // Auto Scan pinned to an old snapshot when the completed run still contains
  // enough durable evidence to rebuild the table.
  const snapshotCandidates =
    acceptedCandidates.length > 0
      ? acceptedCandidates
      : reviewedCandidateFallback;
  if (snapshotCandidates.length === 0) return snapshotsByMode;

  const currentHistory = snapshotsByMode[mode];
''',
        label="Stage 2 candidate recovery fallback",
    )
    text = replace_once(
        text,
        '''  const totalCandidates =
    readNumber(stage1Outputs.scanned_candidates) ?? acceptedCandidates.length;
''',
        '''  const totalCandidates =
    readNumber(stage1Outputs.scanned_candidates) ?? snapshotCandidates.length;
''',
        label="snapshot fallback total",
    )
    text = replace_once(
        text,
        '''    questions: acceptedCandidates.map((candidate) => {
''',
        '''    questions: snapshotCandidates.map((candidate) => {
''',
        label="snapshot fallback rows",
    )
    path.write_text(text, encoding="utf-8")


def patch_sync_tests() -> None:
    path = Path("frontend/tests/bullpen-auto-run-sync.test.mjs")
    text = path.read_text(encoding="utf-8")
    addition = r'''

test("Bullpen auto-run sync rebuilds Auto Scan from Stage 2 when compact Stage 1 rows are absent", async () => {
  const { syncBullpenAutoRunSummarySnapshots } =
    await loadBullpenAutoRunSyncModule();

  const run = createRun({
    acceptedCandidates: [],
    reviewedCandidates: [
      createReviewedCandidate({
        source_kind: "candidate",
        question_id: "question-1",
        slug: "market-1",
        current_yes_odds: 46,
        current_no_odds: 54,
      }),
    ],
  });
  run.stage_results[0].outputs.scanned_candidates = 44;

  const nextSnapshots = syncBullpenAutoRunSummarySnapshots({
    snapshotsByMode: createEmptySnapshots(),
    summary: { recent_decisions: [] },
    run,
  });

  assert.equal(nextSnapshots["30-days"].current?.totalCandidates, 44);
  assert.equal(nextSnapshots["30-days"].current?.questions.length, 1);
  assert.equal(
    nextSnapshots["30-days"].current?.questions[0]?.llmNoOdds,
    88,
  );
});
'''
    if addition.strip() in text:
        raise RuntimeError("sync fallback test already exists")
    text = text.rstrip() + addition + "\n"
    path.write_text(text, encoding="utf-8")


def patch_schedule_card() -> None:
    path = Path(
        "frontend/app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx"
    )
    text = path.read_text(encoding="utf-8")
    text = replace_once(
        text,
        '''function getStageActivePositionCounts(stage: WorkflowStageView) {
  const claimableFromOutputs = Array.isArray(stage.outputs.available_for_claim)
    ? stage.outputs.available_for_claim.length
    : null;
  const claimableFromSnapshot = stage.activePositionsFound.filter(
    (position) => position.isClaimable,
  ).length;
  const openFromSnapshot = stage.activePositionsFound.length;

  return {
    open: openFromSnapshot,
    claimable: claimableFromOutputs ?? claimableFromSnapshot,
  };
}
''',
        '''function getStageActivePositionCounts(stage: WorkflowStageView) {
  const claimableFromOutputs = Array.isArray(stage.outputs.available_for_claim)
    ? stage.outputs.available_for_claim.length
    : null;
  const claimableFromSnapshot = stage.activePositionsFound.filter(
    (position) => position.isClaimable,
  ).length;
  const openFromOutputs =
    readStageOutputNumber(stage.outputs.active_position_rows_before_llm) ??
    readStageOutputNumber(stage.outputs.active_position_rows) ??
    readStageOutputNumber(stage.outputs.active_positions_total);
  const openFromSnapshot = stage.activePositionsFound.length;

  return {
    open: openFromOutputs ?? openFromSnapshot,
    claimable: claimableFromOutputs ?? claimableFromSnapshot,
  };
}
''',
        label="active position scalar statistics",
    )
    text = replace_once(
        text,
        '''  const newOpportunities =
    readStageOutputNumber(stage.outputs.stage1_accepted_candidate_count) ??
    readStageOutputNumber(stage.outputs.candidate_rows_before_llm) ??
    readStageOutputNumber(stage.inputs.candidate_rows_before_llm) ??
    stage.scanCandidates.length;
  const llmRanOn =
    readStageOutputNumber(stage.outputs.llm_candidate_count) ??
    readStageOutputNumber(stage.outputs.total_items) ??
    activePositions + newOpportunities;
''',
        '''  const explicitNewOpportunities =
    readStageOutputNumber(stage.outputs.stage1_accepted_candidate_count) ??
    readStageOutputNumber(stage.outputs.candidate_rows_before_llm) ??
    readStageOutputNumber(stage.inputs.candidate_rows_before_llm) ??
    (stage.scanCandidates.length > 0 ? stage.scanCandidates.length : null);
  const llmRanOn =
    readStageOutputNumber(stage.outputs.llm_candidate_count) ??
    readStageOutputNumber(stage.outputs.total_items) ??
    activePositions + (explicitNewOpportunities ?? 0);
  // A compact or legacy run can retain the authoritative LLM total while its
  // Stage 1 row arrays/count aliases are absent. Keep the displayed equation
  // internally consistent instead of reporting “44 unique rows (0 + 0)”.
  const newOpportunities =
    explicitNewOpportunities ?? Math.max(0, llmRanOn - activePositions);
''',
        label="consistent Stage 2 row decomposition",
    )
    text = replace_once(
        text,
        '''    readStageOutputNumber(stage.inputs.llm_selected_target_count) ??
    readStageOutputNumber(stage.inputs.llm_target_count) ??
    (stageTwoTargets.length > 0
''',
        '''    readStageOutputNumber(stage.inputs.llm_selected_target_count) ??
    readStageOutputNumber(stage.inputs.llm_target_count) ??
    (run?.stage2_llm_targets_snapshot?.length
      ? run.stage2_llm_targets_snapshot.length
      : null) ??
    (stageTwoTargets.length > 0
''',
        label="run-snapshot LLM target count fallback",
    )
    text = replace_once(
        text,
        '''  const summaryAbortControllerRef = useRef<AbortController | null>(null);
  const portfolioLoadInFlightRef = useRef(false);
''',
        '''  const summaryAbortControllerRef = useRef<AbortController | null>(null);
  const terminalRunEvidenceRef = useRef(
    new Map<
      string,
      { run: BullpenAutoLiveRun; decisions: BullpenAutoLiveDecision[] }
    >(),
  );
  const terminalRunHydrationInFlightRef = useRef(
    new Map<string, Promise<void>>(),
  );
  const terminalRunHydrationRetryAtRef = useRef(new Map<string, number>());
  const portfolioLoadInFlightRef = useRef(false);
''',
        label="terminal evidence refs",
    )

    helper = r'''  function mergeTerminalRunEvidence(
    nextSummary: BullpenAutoLiveSummaryResponse,
    trackedRun: BullpenAutoLiveRun | null,
  ): {
    summary: BullpenAutoLiveSummaryResponse;
    run: BullpenAutoLiveRun | null;
  } {
    if (!trackedRun) return { summary: nextSummary, run: null };
    const cachedEvidence = terminalRunEvidenceRef.current.get(trackedRun.id);
    if (!cachedEvidence) return { summary: nextSummary, run: trackedRun };

    const mergedRun = mergeBullpenConsoleRunProjection({
      existing: cachedEvidence.run,
      projected: trackedRun,
      projectionAvailable: true,
    });
    const projectedDecisions = nextSummary.recent_decisions.filter(
      (decision) => decision.run_id === trackedRun.id,
    );
    const mergedDecisions = mergeBullpenConsoleDecisionProjection({
      existing: cachedEvidence.decisions,
      projected: projectedDecisions,
      truncated: true,
    });
    terminalRunEvidenceRef.current.set(trackedRun.id, {
      run: mergedRun,
      decisions: mergedDecisions,
    });

    const recentRuns = nextSummary.recent_runs.some(
      (recentRun) => recentRun.id === trackedRun.id,
    )
      ? nextSummary.recent_runs.map((recentRun) =>
          recentRun.id === trackedRun.id ? mergedRun : recentRun,
        )
      : [mergedRun, ...nextSummary.recent_runs];
    const otherDecisions = nextSummary.recent_decisions.filter(
      (decision) => decision.run_id !== trackedRun.id,
    );

    return {
      summary: {
        ...nextSummary,
        latest_run:
          nextSummary.latest_run?.id === trackedRun.id
            ? mergedRun
            : nextSummary.latest_run,
        recent_runs: recentRuns,
        recent_decisions: [...mergedDecisions, ...otherDecisions],
      },
      run: mergedRun,
    };
  }

  async function hydrateTerminalRunEvidence({
    summary: nextSummary,
    run,
    pendingRunId: resolvedPendingRunId,
    signal,
  }: {
    summary: BullpenAutoLiveSummaryResponse;
    run: BullpenAutoLiveRun | null;
    pendingRunId: string | null;
    signal?: AbortSignal;
  }) {
    if (!run) return;
    if (!isBullpenAutoRunWorkflowSettled(buildBullpenAutoRunWorkflowView(run))) {
      return;
    }
    if (terminalRunEvidenceRef.current.has(run.id)) return;
    const retryAt = terminalRunHydrationRetryAtRef.current.get(run.id) ?? 0;
    if (retryAt > Date.now()) return;

    const existingTask = terminalRunHydrationInFlightRef.current.get(run.id);
    if (existingTask) return existingTask;

    const task = (async () => {
      try {
        const [fullRun, fullDecisions] = await Promise.all([
          apiService.getBullpenAutoLiveRun(run.id, {
            signal,
            timeoutMs: 15_000,
          }),
          apiService.getBullpenAutoLiveRunDecisions(run.id, {
            signal,
            timeoutMs: 15_000,
          }),
        ]);
        if (signal?.aborted) return;

        const mergedRun = mergeBullpenConsoleRunProjection({
          existing: fullRun,
          projected: run,
          projectionAvailable: true,
        });
        const projectedDecisions = nextSummary.recent_decisions.filter(
          (decision) => decision.run_id === run.id,
        );
        const mergedDecisions = mergeBullpenConsoleDecisionProjection({
          existing: fullDecisions,
          projected: projectedDecisions,
          truncated: true,
        });
        terminalRunEvidenceRef.current.set(run.id, {
          run: mergedRun,
          decisions: mergedDecisions,
        });
        terminalRunHydrationRetryAtRef.current.delete(run.id);
        while (terminalRunEvidenceRef.current.size > 5) {
          const oldestRunId = terminalRunEvidenceRef.current.keys().next().value;
          if (typeof oldestRunId !== "string") break;
          terminalRunEvidenceRef.current.delete(oldestRunId);
        }

        const hydrated = mergeTerminalRunEvidence(nextSummary, mergedRun);
        if (signal?.aborted) return;
        setSummary(hydrated.summary);
        onSummaryUpdated?.({
          summary: hydrated.summary,
          run: hydrated.run,
          pendingRunId: resolvedPendingRunId,
        });
      } catch (nextError) {
        if (signal?.aborted || isRequestAbort(nextError)) return;
        terminalRunHydrationRetryAtRef.current.set(
          run.id,
          Date.now() + 15_000,
        );
        console.warn(
          JSON.stringify({
            event: "bullpen_auto_run_terminal_evidence_hydration_failed",
            run_id: run.id,
            error: formatUnknownError(nextError),
          }),
        );
      } finally {
        terminalRunHydrationInFlightRef.current.delete(run.id);
      }
    })();

    terminalRunHydrationInFlightRef.current.set(run.id, task);
    return task;
  }

'''
    text = replace_once(
        text,
        '''  async function loadSummary(options?: {
''',
        helper + '''  async function loadSummary(options?: {
''',
        label="terminal evidence hydration helpers",
    )
    text = replace_once(
        text,
        '''      if (requestSignal?.aborted) return null;
      setSummary(nextSummary);
      summaryLastLoadedAtRef.current = Date.now();
      markBullpenAutoRunPerformance("bullpen-workflow-ready");
      setError(null);
      const nextTrackedRun = getVisibleRun(nextSummary, resolvedPendingRunId);
      onSummaryUpdated?.({
        summary: nextSummary,
        run: nextTrackedRun,
        pendingRunId: resolvedPendingRunId,
      });
      if (!loadingCleared) {
        setLoading(false);
        loadingCleared = true;
      }
      return nextSummary;
''',
        '''      if (requestSignal?.aborted) return null;
      const projectedTrackedRun = getVisibleRun(
        nextSummary,
        resolvedPendingRunId,
      );
      const visiblePayload = mergeTerminalRunEvidence(
        nextSummary,
        projectedTrackedRun,
      );
      setSummary(visiblePayload.summary);
      summaryLastLoadedAtRef.current = Date.now();
      markBullpenAutoRunPerformance("bullpen-workflow-ready");
      setError(null);
      onSummaryUpdated?.({
        summary: visiblePayload.summary,
        run: visiblePayload.run,
        pendingRunId: resolvedPendingRunId,
      });
      void hydrateTerminalRunEvidence({
        summary: visiblePayload.summary,
        run: visiblePayload.run,
        pendingRunId: resolvedPendingRunId,
        signal: requestSignal,
      });
      if (!loadingCleared) {
        setLoading(false);
        loadingCleared = true;
      }
      return visiblePayload.summary;
''',
        label="load summary exact terminal evidence",
    )
    path.write_text(text, encoding="utf-8")


def patch_frontend_compatibility_tests() -> None:
    path = Path("frontend/tests/bullpen-ai-compatibility.test.mjs")
    text = path.read_text(encoding="utf-8")
    text = replace_once(
        text,
        '''  assert.match(autoRunCardSource, /nextPendingRunId: resolvedPendingRunId/);
  assert.match(autoRunCardSource, /Pause/);
''',
        '''  assert.match(autoRunCardSource, /nextPendingRunId: resolvedPendingRunId/);
  assert.match(autoRunCardSource, /active_position_rows_before_llm/);
  assert.match(autoRunCardSource, /Math\.max\(0, llmRanOn - activePositions\)/);
  assert.match(autoRunCardSource, /terminalRunEvidenceRef/);
  assert.match(autoRunCardSource, /getBullpenAutoLiveRun\(run\.id/);
  assert.match(
    autoRunCardSource,
    /bullpen_auto_run_terminal_evidence_hydration_failed/,
  );
  assert.match(autoRunCardSource, /Pause/);
''',
        label="permanent auto-run data regression assertions",
    )
    path.write_text(text, encoding="utf-8")


def main() -> None:
    patch_console_projection()
    patch_projection_tests()
    patch_console_detail_merge()
    patch_auto_run_sync()
    patch_sync_tests()
    patch_schedule_card()
    patch_frontend_compatibility_tests()


if __name__ == "__main__":
    main()
