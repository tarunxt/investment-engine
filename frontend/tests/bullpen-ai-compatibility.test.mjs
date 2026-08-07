import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

async function loadBullpenAiModule() {
  const strategySource = readFileSync(
    new URL("../lib/bullpenStage2To3Strategy.ts", import.meta.url),
    "utf8",
  );
  const { outputText: strategyOutputText } = ts.transpileModule(strategySource, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: "bullpenStage2To3Strategy.ts",
  });
  const strategyModuleUrl = `data:text/javascript;base64,${Buffer.from(
    strategyOutputText,
  ).toString("base64")}`;
  const source = readFileSync(
    new URL("../lib/bullpen-ai.ts", import.meta.url),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: "bullpen-ai.ts",
  });
  const rewrittenOutputText = outputText.replace(
    'from "@/lib/bullpenStage2To3Strategy";',
    `from ${JSON.stringify(strategyModuleUrl)};`,
  );

  return import(
    `data:text/javascript;base64,${Buffer.from(rewrittenOutputText).toString("base64")}`
  );
}

async function loadBullpenScanExclusionsModule() {
  const source = readFileSync(
    new URL("../lib/bullpenScanExclusions.ts", import.meta.url),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: "bullpenScanExclusions.ts",
  });

  return import(
    `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
  );
}

function createQuestionRow() {
  return {
    id: "Q1",
    question: "Will candidate X win?",
    closeTime: "2026-06-30T23:59:00Z",
    category: "Politics",
    yesOdds: 44,
    noOdds: 56,
    volume: "$10,000",
    liquidity: "$5,000",
    sourceUrl: "https://example.com/source",
    slug: "candidate-x-win",
    marketUrl: "https://polymarket.com/event/candidate-x-win",
    outcomeLabels: ["Yes", "No"],
    outcomeCount: 2,
    isBinaryYesNo: true,
    daysUntilClose: 9,
    rules: 'This market resolves to "Yes" if candidate X wins.',
    marketContext:
      "Experimental AI-generated summary referencing Polymarket data. Candidate X has gained support.",
    resolutionSource: "Official election results will decide this market.",
    llmYesOdds: 55,
    llmNoOdds: 45,
    llmAverageYesOdds: 55,
    llmMedianYesOdds: 55,
    llmTrimmedMeanYesOdds: 55,
    llmMinYesOdds: 55,
    llmMaxYesOdds: 55,
    llmSpreadYesOdds: 0,
    llmDisagreementLevel: "Low",
    adjudicationRequired: false,
    evidenceStatus: "scheduled_not_occurred",
    eventState: "scheduled_not_occurred",
    currentVsLlmOddsDifference: -11,
    returnsPerDay: 6.22,
    amountToBeInvested: 15.5,
    isAmountToBeInvestedHighlighted: true,
    llmNotes: "Prompt compatibility test.",
    llmProvider: "openai",
    llmModel: "gpt-4o-mini",
    llmRunId: null,
    llmCompletedAt: null,
    llmBreakdown: [],
  };
}

test("Bullpen x AI prompt builder still supports default and legacy prompt templates", async () => {
  const {
    buildBullpenQuestionPreflightEvidenceBlock,
    buildBullpenLlmPrompt,
    DEFAULT_BULLPEN_LLM_PROMPT_TEMPLATE,
    LEGACY_BULLPEN_LLM_PROMPT_TEMPLATES,
  } = await loadBullpenAiModule();

  const questionRow = createQuestionRow();
  const defaultPrompt = buildBullpenLlmPrompt([questionRow]);
  const legacyPrompt = buildBullpenLlmPrompt(
    [questionRow],
    LEGACY_BULLPEN_LLM_PROMPT_TEMPLATES[0],
  );
  const preflightEvidenceBlock = buildBullpenQuestionPreflightEvidenceBlock(
    questionRow,
    new Date("2026-06-23T12:00:00.000Z"),
  );

  assert.match(defaultPrompt, /Selected questions:/);
  assert.match(defaultPrompt, /"question_ref": "Q1"/);
  assert.match(defaultPrompt, /"market_id": "Q1"/);
  assert.match(defaultPrompt, /"current_yes_odds": 44/);
  assert.match(defaultPrompt, /"current_no_odds": 56/);
  assert.match(defaultPrompt, /"preflight_evidence_block": "Preflight Evidence Block:/);
  assert.match(
    defaultPrompt,
    /"exact_resolution_rules": "This market resolves to \\"Yes\\" if candidate X wins\."/,
  );
  assert.match(
    defaultPrompt,
    /"background_market_context": "Experimental AI-generated summary referencing Polymarket data\. Candidate X has gained support\."/,
  );
  assert.match(defaultPrompt, /Use event_id as the primary key\./);
  assert.match(defaultPrompt, /stage2_context/);
  assert.match(defaultPrompt, /Do not browse\. Do not add outside evidence\./);
  assert.match(
    defaultPrompt,
    /Experimental AI-generated summary referencing Polymarket data\./,
  );
  assert.notEqual(defaultPrompt, DEFAULT_BULLPEN_LLM_PROMPT_TEMPLATE.trim());

  assert.match(legacyPrompt, /Selected questions:/);
  assert.match(legacyPrompt, /"question_ref": "Q1"/);
  assert.match(legacyPrompt, /"llm_no_odds"/);
  assert.match(preflightEvidenceBlock, /Preflight Evidence Block:/);
  assert.match(preflightEvidenceBlock, /Market:\nWill candidate X win\?/);
  assert.match(
    preflightEvidenceBlock,
    /Rules:\nThis market resolves to "Yes" if candidate X wins\./,
  );
  assert.match(preflightEvidenceBlock, /Verified current facts:/);
  assert.match(
    preflightEvidenceBlock,
    /These facts are authoritative\. Do not contradict them\. Only estimate the unresolved condition\./,
  );
});

test("Bullpen preflight uses the selected market's by-date instead of a stale event close time", async () => {
  const { buildBullpenQuestionPreflightEvidenceBlock } = await loadBullpenAiModule();
  const questionRow = {
    ...createQuestionRow(),
    question: "Will Iran announce withdrawal from MOU negotiations by July 24?",
    // Event-level data can be stale or refer to a resolved sibling market.
    closeTime: "2026-06-15T03:59:00Z",
  };

  const preflightEvidenceBlock = buildBullpenQuestionPreflightEvidenceBlock(
    questionRow,
    new Date("2026-07-17T12:00:00.000Z"),
  );

  assert.match(preflightEvidenceBlock, /deadline \(ET\): 2026-07-24 11:59:00 PM ET/);
  assert.match(preflightEvidenceBlock, /hours remaining: 183\.98/);
});

test("Bullpen x AI manual invest flow stays wired to the Polymarket manual-invest endpoint", () => {
  const bullpenAiPageSource = readFileSync(
    new URL("../app/console/bullpen-ai/_components/BullpenAiPageClient.tsx", import.meta.url),
    "utf8",
  );
  const urlsSource = readFileSync(
    new URL("../lib/urls.ts", import.meta.url),
    "utf8",
  );

  assert.match(bullpenAiPageSource, /function buildBullpenManualInvestOrder/);
  assert.match(bullpenAiPageSource, /market_id: marketId/);
  assert.match(urlsSource, /manualInvest: \(\) => `\$\{resolveApiBaseUrl\(\)\}\/polymarket\/manual-invest`/);
});

test("Bullpen x AI investment result is shown below the Invest button", () => {
  const bullpenAiPageSource = readFileSync(
    new URL("../app/console/bullpen-ai/_components/BullpenAiPageClient.tsx", import.meta.url),
    "utf8",
  );
  const investmentsSectionSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenInvestmentsSection.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(bullpenAiPageSource, /Investing was successful/);
  assert.match(bullpenAiPageSource, /Investing was partially successful/);
  assert.match(bullpenAiPageSource, /Investing was not successful/);
  assert.match(
    bullpenAiPageSource,
    /resultMessage=\{isManualScanView \? investmentNotice : null\}/,
  );
  assert.match(investmentsSectionSource, /resultMessage: string \| null/);
  assert.match(investmentsSectionSource, /!isInvesting && resultMessage/);
  assert.match(investmentsSectionSource, /\{resultMessage\}/);
});

test("Bullpen x AI shows selectable auto-run schedule tiles without the manual run-now button", () => {
  const bullpenAiPageSource = readFileSync(
    new URL("../app/console/bullpen-ai/_components/BullpenAiPageClient.tsx", import.meta.url),
    "utf8",
  );
  const autoRunCardSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const autoRunProgressSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/bullpenAutoRunProgress.ts",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(bullpenAiPageSource, /BullpenAutoRunScheduleCard/);
  assert.doesNotMatch(autoRunCardSource, /Run Scans and Invest Now/);
  assert.doesNotMatch(autoRunCardSource, /Bullpen Scan \+ LLM \+ Exit and Invest auto-run schedule/);
  assert.doesNotMatch(autoRunProgressSource, /Step 1 processes Event Exits/);
  assert.doesNotMatch(autoRunProgressSource, /Step 2 invests in the Stage 3 planned orders/);
  assert.match(autoRunCardSource, /InvestExecutionStepsSummary/);
  assert.match(autoRunCardSource, /execution_steps/);
  assert.match(autoRunCardSource, /Next scheduled run/);
  assert.match(autoRunCardSource, /Last completed run/);
  assert.match(autoRunCardSource, /Last failed run/);
  assert.match(autoRunCardSource, /formatLatestRunSummaryTileLabel\(latestTerminalRun\)/);
  assert.match(autoRunCardSource, /Stage 2 has no saved LLM targets/);
  assert.match(autoRunCardSource, /latestRunFailureMessage/);
  assert.match(autoRunCardSource, /isActivelyWorkingRunStatus\(visibleRun\?\.status\)/);
  assert.doesNotMatch(autoRunCardSource, /Boolean\(summary\?\.state\.running\)/);
  assert.match(autoRunCardSource, /setSelectedRunSummaryTile\("next"\)/);
  assert.match(autoRunCardSource, /setSelectedRunSummaryTile\("last"\)/);
  assert.doesNotMatch(autoRunCardSource, /Fixed times: 6 AM, 12 PM, 6 PM, and 12 AM IST\./);
  assert.match(autoRunCardSource, /Background execution monitor/);
  assert.match(autoRunCardSource, /Worker stages/);
  assert.doesNotMatch(autoRunCardSource, /refreshes every 4 seconds/);
  assert.match(autoRunCardSource, /timeoutMs: 5_000/);
  assert.match(autoRunCardSource, /bullpen_auto_run_dashboard_poll_degraded/);
  assert.match(autoRunCardSource, /nextPendingRunId: resolvedPendingRunId/);
  assert.match(autoRunCardSource, /active_position_rows_before_llm/);
  assert.match(autoRunCardSource, /Math\.max\(0, llmRanOn - activePositions\)/);
  assert.match(autoRunCardSource, /terminalRunEvidenceRef/);
  assert.match(autoRunCardSource, /getBullpenAutoLiveRun\(run\.id/);
  assert.match(
    autoRunCardSource,
    /bullpen_auto_run_terminal_evidence_hydration_failed/,
  );
  assert.match(autoRunCardSource, /Pause/);
  assert.match(autoRunCardSource, /Kill/);
  assert.match(autoRunCardSource, /Open .* output/);
  assert.match(autoRunCardSource, /Execution gate/);
  assert.match(autoRunCardSource, /BULLPEN_AUTO_LIVE_ALLOW_EXECUTION/);
  assert.match(autoRunCardSource, /Backend live execution is disabled/);
  assert.match(autoRunCardSource, /BullpenAutoRunStageOutputDialog/);
  assert.match(autoRunProgressSource, /Stage 1 · Bullpen Scan/);
  assert.match(autoRunProgressSource, /Stage 2 · Run LLM/);
  assert.match(autoRunProgressSource, /Stage 3 · Exit and Invest/);
  assert.match(autoRunProgressSource, /outputs: Record<string, unknown>/);
});

test("Bullpen x AI auto-run card exposes the dynamic trade amount formula", () => {
  const autoRunCardSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const strategySource = readFileSync(
    new URL("../lib/bullpenStage2To3Strategy.ts", import.meta.url),
    "utf8",
  );

  assert.match(autoRunCardSource, /Trade amount per new opportunity/);
  assert.match(autoRunCardSource, /formatBullpenStage2To3SizingFormulaLabel/);
  assert.match(
    strategySource,
    /return `Cash in Hand \/ \(\$\{maxPositions\} - Occupied Positions\)`;/,
  );
  assert.match(autoRunCardSource, /last_console_trade_amount_usd/);
  assert.match(autoRunCardSource, /Show trade amount formula/);
  assert.doesNotMatch(
    autoRunCardSource,
    /Future Bullpen x AI trades and automations will use/,
  );
});

test("Bullpen x AI auto-run card defers bounded summary hydration behind fast status", () => {
  const autoRunCardSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const overviewSource = readFileSync(
    new URL(
      "../app/console/trading-bots/_components/TradingBotsOverviewPage.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const apiSource = readFileSync(
    new URL("../services/api.ts", import.meta.url),
    "utf8",
  );
  const urlsSource = readFileSync(new URL("../lib/urls.ts", import.meta.url), "utf8");

  assert.match(autoRunCardSource, /summaryLoadInFlightRef/);
  assert.match(
    autoRunCardSource,
    /const nextSummary = await apiService\.getBullpenAutoLiveDashboardSummary\(\{\s*signal: requestSignal,\s*timeoutMs: 5_000,\s*\}\);/,
  );
  assert.match(autoRunCardSource, /getPersistedAutoRunStatus\(/);
  assert.match(autoRunCardSource, /AUTO_RUN_STATUS_TIMEOUT_MS/);
  assert.match(autoRunCardSource, /setSummary\(visiblePayload\.summary\);/);
  assert.doesNotMatch(autoRunCardSource, /summaryPromise/);
  assert.match(
    overviewSource,
    /apiService\.getBullpenAutoLiveDashboardSummary\(\)/,
  );
  assert.match(
    apiSource,
    /getBullpenAutoLiveDashboardSummary\([\s\S]*?URLs\.bullpenAutoLive\.dashboardSummary\(\)/,
  );
  assert.match(
    urlsSource,
    /dashboardSummary: \(\) =>\s*`\$\{resolveApiBaseUrl\(\)\}\/polymarket\/auto-live\/summary\/dashboard`/,
  );
});

test("Bullpen x AI auto-run Now controls keep a run-on-enable sentinel without persisting a timestamp", () => {
  const autoRunCardSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(autoRunCardSource, /setScheduleStartInput\("Now"\);/);
  assert.match(autoRunCardSource, /setScheduleSettingsDirty\(true\);/);
  assert.match(autoRunCardSource, /Run and Enable Auto Runs/);
  assert.match(autoRunCardSource, /Start Auto Run Now/);
  assert.match(autoRunCardSource, /handleStartAutoRunNow/);
  assert.match(autoRunCardSource, /const normalizedStart = startWasNow \? "" : scheduleStartInput\.trim\(\);/);
  assert.match(
    autoRunCardSource,
    /async function handleStartAutoRunNow\(\)[\s\S]*?startBullpenAutoLive\(\);[\s\S]*?runBullpenAutoLiveOnce\(\);/,
  );
  assert.match(
    autoRunCardSource,
    /if \(startWasNow\) \{[\s\S]*?runBullpenAutoLiveOnce\(\);/,
  );
  assert.match(
    autoRunCardSource,
    /const consoleLlmTargets = startWasNow\s*\?\s*await ensureCanonicalStage2LlmTargets\(\{\s*requireNonEmpty:\s*true,\s*\}\)\s*:\s*await ensureCanonicalStage2LlmTargets\(\);/,
  );
  assert.match(autoRunCardSource, /if \(startWasNow && !consoleLlmTargets\) \{/);
});

test("Bullpen x AI run-now request can reuse the current scan snapshot before manual LLM selection exists", () => {
  const bullpenAiPageSource = readFileSync(
    new URL("../app/console/bullpen-ai/_components/BullpenAiPageClient.tsx", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(bullpenAiPageSource, /selectedQuestionIds\.size === 0/);
  assert.match(bullpenAiPageSource, /const buildRunNowRequest = async \(\) =>/);
  assert.match(
    bullpenAiPageSource,
    /if \(!snapshot\) \{/,
  );
  assert.match(bullpenAiPageSource, /candidate_rows_prefiltered:\s*true/);
  assert.match(bullpenAiPageSource, /reuse_saved_llm_outputs:\s*false/);
});

test("Bullpen x AI shares Stage 2 execution settings across manual and auto LLM runs", () => {
  const bullpenAiPageSource = readFileSync(
    new URL("../app/console/bullpen-ai/_components/BullpenAiPageClient.tsx", import.meta.url),
    "utf8",
  );
  const autoRunCardSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(bullpenAiPageSource, /execution_options:\s*\{/);
  assert.match(bullpenAiPageSource, /execution_mode:\s*bullpenLlmExecutionMode/);
  assert.match(bullpenAiPageSource, /events_per_prompt:\s*bullpenLlmEventsPerPrompt/);
  assert.match(
    bullpenAiPageSource,
    /console_llm_prompt_template:\s*template/,
  );
  assert.match(
    bullpenAiPageSource,
    /summary\.settings\.console_llm_prompt_template/,
  );
  assert.match(
    bullpenAiPageSource,
    /updateBullpenAutoLiveSettings\(\{\s*console_llm_targets:\s*targets,\s*\}\)/,
  );
  assert.match(bullpenAiPageSource, /disableImplicitDefaultTarget/);
  assert.match(bullpenAiPageSource, /ignoreStoredSelection/);
  assert.match(autoRunCardSource, /stage-2-llm-execution-mode/);
  assert.match(autoRunCardSource, /Batched parallel/);
  assert.match(autoRunCardSource, /Single combined/);
  assert.match(autoRunCardSource, /Events\/prompt/);
  assert.match(autoRunCardSource, /Current run LLMs completed/);
  assert.match(autoRunCardSource, /displayModel:\s*\n\s*\(targetRunTotals\.get\(key\) \?\? 0\) > 1/);
  assert.match(autoRunCardSource, /`\$\{model\} \$\{duplicateIndex\}`/);
  assert.match(autoRunCardSource, /Open LLM completion diagnostics/);
  assert.match(
    autoRunCardSource,
    /stageTwoTargets\.length > 0\s*\?\s*stageTwoTargets\.filter\(\(target\) => hasStageTwoLlmIdentity\(target\)\)\s*\.length\s*:\s*null/,
  );
  assert.match(autoRunCardSource, /llm_execution_mode/);
  assert.match(autoRunCardSource, /llm_events_per_prompt/);
  assert.match(
    autoRunCardSource,
    /Changes are saved for the next run\. The running Stage 2 job uses the frozen target list/,
  );
  assert.match(autoRunCardSource, /disableImplicitDefaultTarget/);
  assert.match(autoRunCardSource, /ignoreStoredSelection/);
});

test("Bullpen auto-run only persists LLM target changes after explicit user interaction", () => {
  const runControlsSource = readFileSync(
    new URL("../components/shared/EventScanRunControls.tsx", import.meta.url),
    "utf8",
  );

  assert.match(runControlsSource, /selectionChangeVersionRef/);
  assert.match(runControlsSource, /emittedSelectionChangeVersionRef/);
  assert.match(runControlsSource, /markSelectionChangedByUser/);
  assert.match(
    runControlsSource,
    /emittedSelectionChangeVersionRef\.current ===\s*\n\s*selectionChangeVersionRef\.current/,
  );
});

test("Bullpen auto-run serializes LLM target saves so rapid multi-select changes do not overwrite newer selections", () => {
  const autoRunCardSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(autoRunCardSource, /pendingSelectedLlmTargetsSaveRef/);
  assert.match(autoRunCardSource, /selectedLlmTargetsSaveInFlightRef/);
  assert.match(autoRunCardSource, /flushSelectedLlmTargetSaves/);
  assert.match(
    autoRunCardSource,
    /pendingSelectedLlmTargetsSaveRef\.current = nextTargets/,
  );
  assert.match(autoRunCardSource, /defaultTargets=\{selectedLlmTargets\}/);
  assert.match(autoRunCardSource, /selectedLlmTargetsSavePromiseRef/);
  assert.match(autoRunCardSource, /await selectedLlmTargetsSavePromiseRef\.current/);
});

test("Bullpen auto-run bootstraps legacy Stage 2 LLM selections into canonical server settings", () => {
  const autoRunCardSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(autoRunCardSource, /readLegacyBullpenLlmTargetsFromStorage/);
  assert.match(autoRunCardSource, /legacyBullpenLlmTargetsBootstrapEligibleRef/);
  assert.match(
    autoRunCardSource,
    /pendingSelectedLlmTargetsSaveRef\.current = legacyTargets/,
  );
  assert.match(autoRunCardSource, /ensureCanonicalStage2LlmTargets/);
  assert.match(
    autoRunCardSource,
    /ensureCanonicalStage2LlmTargets\(\{\s*requireNonEmpty:\s*true,\s*\}\)/,
  );
});

test("Bullpen x AI Stage 2 prompt dialogs fall back to the saved run prompt template", () => {
  const autoRunCardSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(autoRunCardSource, /llm_prompt_template/);
  assert.match(autoRunCardSource, /getStageTwoDisplayedPrompt/);
  assert.match(
    autoRunCardSource,
    /showing the saved Stage 2 prompt template used for shared LLM execution/,
  );
});

test("Bullpen x AI separates Manual Scan and Auto Scan result tabs", () => {
  const bullpenAiPageSource = readFileSync(
    new URL("../app/console/bullpen-ai/_components/BullpenAiPageClient.tsx", import.meta.url),
    "utf8",
  );
  const investmentsSectionSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenInvestmentsSection.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(bullpenAiPageSource, /Manual Scan/);
  assert.match(bullpenAiPageSource, /Auto Scan/);
  assert.ok(
    bullpenAiPageSource.indexOf('source: "auto"') <
      bullpenAiPageSource.indexOf('source: "manual"'),
  );
  assert.match(
    bullpenAiPageSource,
    /function createEmptySnapshotSourceMap\(\): Record<ScanMode, BullpenSnapshotSource> \{\s+return \{\s+"30-days": "auto",\s+"end-of-month": "auto",\s+\};\s+\}/,
  );
  assert.doesNotMatch(
    bullpenAiPageSource,
    /Auto Scan is read-only here\.\s+Switch to Manual Scan to run\s+Bullpen scans, LLM analysis, or manual investing\./,
  );
  assert.doesNotMatch(bullpenAiPageSource, /Current Filters/);
  assert.doesNotMatch(bullpenAiPageSource, /Saved Snapshots/);
  assert.match(bullpenAiPageSource, /setAutoSnapshotsByMode/);
  assert.match(
    bullpenAiPageSource,
    /syncBullpenAutoRunSummarySnapshots\(\{\s*snapshotsByMode: current,/,
  );
  assert.match(investmentsSectionSource, /isReadOnly: boolean;/);
  assert.match(investmentsSectionSource, /readOnlyMessage: string \| null;/);
});

test("Bullpen x AI serializes active-run control mutations", () => {
  const autoRunCardSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(autoRunCardSource, /const startNowActionRequested = action === "start-now";/);
  assert.match(autoRunCardSource, /startNowActionRequested \|\|/);
  assert.match(
    autoRunCardSource,
    /const hasActiveWorkflowStage = liveWorkflowView\.stages\.some/,
  );
  assert.doesNotMatch(
    autoRunCardSource,
    /isActivelyWorkingRunStatus\(liveWorkflowView\.runStatus\)/,
  );
  assert.match(autoRunCardSource, /function claimAction\(nextAction:/);
  assert.match(autoRunCardSource, /actionInFlightRef\.current !== null \|\| action !== null/);
  assert.match(autoRunCardSource, /disabled=\{action !== null\}/);
  assert.match(autoRunCardSource, /action === "start-now" \? "start-now-pending" : null/);
  assert.match(autoRunCardSource, /setAction\(null\);\s*\n\s*\}/);
  assert.doesNotMatch(autoRunCardSource, /Run Scans and Invest Now/);
  assert.match(autoRunCardSource, /Status: \{autoRunStatusBadges\.statusLabel\}/);
  assert.match(autoRunCardSource, /Mode: \{mode\}/);
});

test("Bullpen x AI auto-run errors render detail text alongside the main message", () => {
  const autoRunCardSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(autoRunCardSource, /splitApiErrorSummary/);
  assert.match(autoRunCardSource, /error\.details/);
  assert.match(autoRunCardSource, /text-xs leading-5 text-rose-800/);
});

test("Bullpen x AI scan defaults exclude tweet counts", async () => {
  const { DEFAULT_BULLPEN_SCAN_FILTERS } = await loadBullpenAiModule();

  assert.equal(
    DEFAULT_BULLPEN_SCAN_FILTERS["30-days"].excludeTweetCountQuestions,
    true,
  );
  assert.equal(
    DEFAULT_BULLPEN_SCAN_FILTERS["end-of-month"].excludeTweetCountQuestions,
    true,
  );
});

test("Bullpen x AI scan defaults exclude release-by events", async () => {
  const { DEFAULT_BULLPEN_SCAN_FILTERS } = await loadBullpenAiModule();

  assert.equal(
    DEFAULT_BULLPEN_SCAN_FILTERS["30-days"].excludeReleasedByEvents,
    true,
  );
  assert.equal(
    DEFAULT_BULLPEN_SCAN_FILTERS["end-of-month"].excludeReleasedByEvents,
    true,
  );
});

test("Bullpen x AI investment candidates include strong LLM Yes or No odds", async () => {
  const { isBullpenQuestionInvestmentCandidate } = await loadBullpenAiModule();

  assert.equal(isBullpenQuestionInvestmentCandidate(createQuestionRow()), false);

  const eligibleQuestion = {
    ...createQuestionRow(),
    llmNoOdds: 85,
    llmYesOdds: 15,
    amountToBeInvested: 15.5,
  };
  assert.equal(isBullpenQuestionInvestmentCandidate(eligibleQuestion), true);

  assert.equal(
    isBullpenQuestionInvestmentCandidate({
      ...eligibleQuestion,
      llmYesOdds: 85,
      llmNoOdds: 15,
    }),
    true,
  );

  assert.equal(
    isBullpenQuestionInvestmentCandidate({
      ...eligibleQuestion,
      llmYesOdds: 79,
      llmNoOdds: 80,
    }),
    true,
  );

  assert.equal(
    isBullpenQuestionInvestmentCandidate({
      ...eligibleQuestion,
      llmDisagreementLevel: "High",
    }),
    true,
  );
  assert.equal(
    isBullpenQuestionInvestmentCandidate({
      ...eligibleQuestion,
      adjudicationRequired: true,
    }),
    true,
  );
});

test("Bullpen x AI sports filter catches Games category markets", () => {
  const exclusionsSource = readFileSync(
    new URL("../lib/bullpenScanExclusions.ts", import.meta.url),
    "utf8",
  );
  const routeSource = readFileSync(
    new URL("../app/api/bullpen-ai/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(exclusionsSource, /SPORTS_KEYWORD_GROUPS[\s\S]*"games"/);
  assert.match(exclusionsSource, /SPORTS_PATTERNS[\s\S]*halftime/);
  assert.match(routeSource, /collectCategoryLabels/);
  assert.match(routeSource, /SPORTS_PATTERNS\.some/);
});

test("Bullpen x AI category trail displays and filters nested esports paths", () => {
  const routeSource = readFileSync(
    new URL("../app/api/bullpen-ai/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(routeSource, /CATEGORY_TRAIL_KEYS/);
  assert.match(routeSource, /collectDeepCategoryTrailLabels/);
  assert.match(routeSource, /addCategoryTrailFromPath/);
  assert.match(routeSource, /titleCaseCategorySegment/);
  assert.match(routeSource, /slice\(esportsIndex, esportsIndex \+ 3\)/);
  assert.match(routeSource, /Dota 2/);
});

test("Bullpen x AI custom exclusion keywords normalize leading plus prop phrases", async () => {
  const { normalizeCustomExclusionKeywordVariants } =
    await loadBullpenScanExclusionsModule();

  assert.deepEqual(normalizeCustomExclusionKeywordVariants("+ shots"), [
    "+ shots",
    "shots",
  ]);
  assert.deepEqual(normalizeCustomExclusionKeywordVariants("+ assists"), [
    "+ assists",
    "assists",
  ]);
  assert.deepEqual(normalizeCustomExclusionKeywordVariants("1+ goals"), [
    "1+ goals",
    "goals",
  ]);
});

test("Bullpen x AI sports filter catches halftime, exact-score, and esports map phrasing", async () => {
  const { SPORTS_PATTERNS } = await loadBullpenScanExclusionsModule();
  const routeSource = readFileSync(
    new URL("../app/api/bullpen-ai/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(routeSource, /SPORTS_PATTERNS/);
  for (const prompt of [
    "Argentina leading at halftime?",
    "Argentina vs. Egypt: Both Teams to Score",
    "Exact Score: Argentina 1 - 0 Egypt?",
    "Will Team Liquid win map 1?",
  ]) {
    assert.equal(
      SPORTS_PATTERNS.some((pattern) => pattern.test(prompt)),
      true,
      prompt,
    );
  }
});

test("Bullpen x AI sports filter catches player-prop threshold phrasing", async () => {
  const { SPORTS_PATTERNS } = await loadBullpenScanExclusionsModule();

  for (const prompt of [
    "Achraf Hakimi: 1+ assists",
    "Achraf Hakimi: 1+ goals + assists",
    "Achraf Hakimi: 2+ shots on target",
    "Achraf Hakimi: 5+ shots",
  ]) {
    assert.equal(
      SPORTS_PATTERNS.some((pattern) => pattern.test(prompt)),
      true,
      prompt,
    );
  }
});

test("Bullpen x AI sports filter catches win-on-date phrasing without misclassifying elections", async () => {
  const { isLikelySportsWinOnText } = await loadBullpenScanExclusionsModule();

  assert.equal(
    isLikelySportsWinOnText("Will Norway win on 2026-06-26?"),
    true,
  );
  assert.equal(
    isLikelySportsWinOnText(
      "Will Donald Trump win the presidential election on 2028-11-07?",
    ),
    false,
  );
});

test("Bullpen x AI market prediction filter excludes largest-company-by-market-cap questions", () => {
  const exclusionsSource = readFileSync(
    new URL("../lib/bullpenScanExclusions.ts", import.meta.url),
    "utf8",
  );
  const backendScannerSource = readFileSync(
    new URL(
      "../../backend/app/domains/polymarket_auto_live/scanner.py",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(
    exclusionsSource,
    /largest company in the world by market cap/,
  );
  assert.match(exclusionsSource, /excludeMarketPredictions/);
  assert.match(
    backendScannerSource,
    /largest company in the world by market cap/,
  );
});

test("Bullpen x AI release-by filter is wired through UI, API, and backend scanner", async () => {
  const { RELEASED_BY_EVENT_KEYWORDS } =
    await loadBullpenScanExclusionsModule();
  const pageSource = readFileSync(
    new URL("../app/console/bullpen-ai/_components/BullpenAiPageClient.tsx", import.meta.url),
    "utf8",
  );
  const routeSource = readFileSync(
    new URL("../app/api/bullpen-ai/route.ts", import.meta.url),
    "utf8",
  );
  const backendScannerSource = readFileSync(
    new URL(
      "../../backend/app/domains/polymarket_auto_live/scanner.py",
      import.meta.url,
    ),
    "utf8",
  );

  assert.deepEqual(RELEASED_BY_EVENT_KEYWORDS, ["released by"]);
  assert.match(pageSource, /excludeReleasedByEvents/);
  assert.match(routeSource, /isReleasedByEventQuestion/);
  assert.match(backendScannerSource, /RELEASED_BY_EVENT_KEYWORDS/);
});

test("Bullpen x AI exclusions dialog includes exact-rule copy for tile drilldowns", () => {
  const pageSource = readFileSync(
    new URL("../app/console/bullpen-ai/_components/BullpenAiPageClient.tsx", import.meta.url),
    "utf8",
  );
  const dialogSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenScanFilterDetailsDialog.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(pageSource, /Click any card to/);
  assert.match(pageSource, /setOpenFilterDetailsId/);
  assert.match(dialogSource, /Exact exclusion algorithm/);
  assert.match(dialogSource, /Exact keep algorithm/);
});

test("Bullpen x AI active positions stay included in LLM runs and share the events-table layout", () => {
  const bullpenAiPageSource = readFileSync(
    new URL("../app/console/bullpen-ai/_components/BullpenAiPageClient.tsx", import.meta.url),
    "utf8",
  );
  const investmentsSectionSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenInvestmentsSection.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(bullpenAiPageSource, /buildBullpenLlmRunTargetSet\(\{/);
  assert.match(
    bullpenAiPageSource,
    /activePositions: (openActivePositions|refreshedOpenActivePositions)/,
  );
  assert.match(
    bullpenAiPageSource,
    /BULLPEN_ACTIVE_POSITION_LLM_STORAGE_KEY/,
  );
  assert.match(
    bullpenAiPageSource,
    /buildSnapshotBackfilledActivePositionAnalyses/,
  );
  assert.match(
    bullpenAiPageSource,
    /syncBullpenAutoRunActivePositionAnalyses/,
  );
  assert.match(
    bullpenAiPageSource,
    /mergeQuestionWithLatestActivePositionAnalysis/,
  );
  assert.match(
    bullpenAiPageSource,
    /BullpenEventIdentityResolver\.resolveMatch/,
  );
  assert.match(investmentsSectionSource, /activePositionQuestions:/);
  assert.match(investmentsSectionSource, /Current Yes \/ No/);
  assert.match(investmentsSectionSource, /LLM Yes \/ No/);
  assert.match(investmentsSectionSource, /Last LLM:/);
  assert.match(investmentsSectionSource, /Asia\/Kolkata/);
  assert.match(investmentsSectionSource, /CheckCircle2/);
});

test("Bullpen x AI stage refreshes keep fresh opportunities and active positions synced to canonical Polymarket odds", () => {
  const bullpenAiPageSource = readFileSync(
    new URL("../app/console/bullpen-ai/_components/BullpenAiPageClient.tsx", import.meta.url),
    "utf8",
  );
  const currentOddsRouteSource = readFileSync(
    new URL("../app/api/bullpen-ai/current-odds/route.ts", import.meta.url),
    "utf8",
  );
  const positionsRouteSource = readFileSync(
    new URL("../app/api/bullpen-ai/positions/route.ts", import.meta.url),
    "utf8",
  );
  const marketUrlsSource = readFileSync(
    new URL(
      "../app/api/bullpen-ai/_lib/polymarketMarketUrls.ts",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(
    bullpenAiPageSource,
    /const positionsRefreshTask = refreshBullpenPositions\(\{\s*suppressAutoClaim: true,/,
  );
  assert.match(
    bullpenAiPageSource,
    /refreshCurrentOdds\(\{\s*questionIds: selectedQuestions\.map\(\(question\) => question\.id\),/,
  );
  assert.match(
    bullpenAiPageSource,
    /activePositions: refreshedOpenActivePositions/,
  );
  assert.match(
    currentOddsRouteSource,
    /resolvePolymarketMarketsWithQuestionFallback/,
  );
  assert.match(
    positionsRouteSource,
    /resolvePolymarketMarketsWithQuestionFallback/,
  );
  assert.match(
    marketUrlsSource,
    /export async function resolvePolymarketMarketsWithQuestionFallback/,
  );
  assert.match(
    marketUrlsSource,
    /"resolutionCriteria",\s*"resolution_criteria",\s*"rules",\s*"description"/,
  );
  assert.match(marketUrlsSource, /yesOdds: resolved\.yesOdds/);
  assert.match(marketUrlsSource, /noOdds: resolved\.noOdds/);
});

test("Bullpen x AI keeps retrying auto-claim while the same resolved positions remain claimable", () => {
  const bullpenAiPageSource = readFileSync(
    new URL("../app/console/bullpen-ai/_components/BullpenAiPageClient.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    bullpenAiPageSource,
    /const AUTO_CLAIM_RETRY_COOLDOWN_MS = 60_000;/,
  );
  assert.match(bullpenAiPageSource, /lastAutoClaimAttemptRef/);
  assert.match(
    bullpenAiPageSource,
    /Cred-X will retry automatically after the redeem cooldown/,
  );
});

test("Bullpen x AI LLM breakdown dialog shows the preflight evidence block", () => {
  const dialogSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenLlmBreakdownDialog.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(dialogSource, /Preflight Evidence Block:/);
  assert.match(dialogSource, /buildBullpenQuestionPreflightEvidenceBlock/);
  assert.match(dialogSource, /Latest LLM update:/);
  assert.match(dialogSource, /BullpenEventHistoricalAssessmentTable/);
});

test("Bullpen x AI treats saved odds or timestamps as clickable LLM analysis", async () => {
  const { hasBullpenLlmAnalysis } = await loadBullpenAiModule();

  assert.equal(
    hasBullpenLlmAnalysis({
      llmYesOdds: null,
      llmNoOdds: null,
      llmRunId: null,
      llmCompletedAt: "2026-06-25T18:45:06.000Z",
      llmBreakdown: [],
    }),
    true,
  );
  assert.equal(
    hasBullpenLlmAnalysis({
      llmYesOdds: 82,
      llmNoOdds: 18,
      llmRunId: null,
      llmCompletedAt: null,
      llmBreakdown: [],
    }),
    true,
  );
  assert.equal(
    hasBullpenLlmAnalysis({
      llmYesOdds: null,
      llmNoOdds: null,
      llmRunId: null,
      llmCompletedAt: null,
      llmBreakdown: [],
    }),
    false,
  );

  const investmentsSectionSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenInvestmentsSection.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const questionsTableSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenQuestionsTable.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(investmentsSectionSource, /hasBullpenLlmAnalysis/);
  assert.match(investmentsSectionSource, /Open LLM odds breakdown for/);
  assert.match(questionsTableSource, /hasBullpenLlmAnalysis/);
});

test("Bullpen auto-run summary sync keeps completed run visible after refresh", () => {
  const scheduleCardSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(
    scheduleCardSource,
    /summary\.latest_run\?\.status === "completed"/,
  );
  assert.match(
    scheduleCardSource,
    /reconcileBullpenConsoleRunCopies\(recentCopy, summary\.latest_run\)/,
  );
  assert.match(
    scheduleCardSource,
    /const latestRun = summary\?\.latest_run\s+\? reconcileBullpenConsoleRunCopies/,
  );
  assert.match(
    scheduleCardSource,
    /recent_runs\.find\(\(run\) => run\.status === "completed"\)/,
  );
});

test("Bullpen x AI keeps BullpenQuestionsTable as the single canonical Events Summary table", () => {
  const bullpenAiPageSource = readFileSync(
    new URL("../app/console/bullpen-ai/_components/BullpenAiPageClient.tsx", import.meta.url),
    "utf8",
  );
  const scheduleCardSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const questionsTableSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenQuestionsTable.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(bullpenAiPageSource, /<BullpenQuestionsTable/);
  assert.match(scheduleCardSource, /<BullpenQuestionsTable/);
  assert.match(questionsTableSource, /const columnDefinitions:/);
  assert.doesNotMatch(scheduleCardSource, /const columnDefinitions:/);
  assert.doesNotMatch(bullpenAiPageSource, /const columnDefinitions:/);
});

test("Bullpen returns/day uses unpriced upside for current odds matching strongest LLM side divided by days left", async () => {
  const { getBullpenReturnsPerDayBreakdown } = await loadBullpenAiModule();

  const result = getBullpenReturnsPerDayBreakdown({
    ...createQuestionRow(),
    yesOdds: 75.5,
    noOdds: 24.5,
    llmYesOdds: 10,
    llmNoOdds: 90,
    daysUntilClose: 1.6,
  });

  assert.equal(result.currentSide, "No");
  assert.equal(result.currentOdds, 24.5);
  assert.equal(result.result, 47.19);
});

test("Events Summary can filter strongest LLM odds and rank its top 10 by returns per day", () => {
  const questionsTableSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenQuestionsTable.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(questionsTableSource, /Strongest LLM odds ≥ 80%/);
  assert.match(questionsTableSource, />\s*Top 10\s*</);
  assert.match(questionsTableSource, /hasBullpenStrongLlmOdds/);
  assert.match(questionsTableSource, /getBullpenTopTenStrongestLlmOddsRows/);
  assert.match(questionsTableSource, /"active-retained"/);
  assert.match(questionsTableSource, /"event-exit"/);
  assert.match(questionsTableSource, /"new-opportunity"/);
});

test("Bullpen Top 10 helper keeps only strongest-odds rows and orders them by returns per day", async () => {
  const { getBullpenTopTenStrongestLlmOddsRows } = await loadBullpenAiModule();

  const rows = [
    {
      ...createQuestionRow(),
      id: "excluded",
      question: "Excluded even with huge returns",
      llmYesOdds: 79,
      llmNoOdds: 21,
      returnsPerDay: 999,
    },
    ...Array.from({ length: 11 }, (_, index) => ({
      ...createQuestionRow(),
      id: `qualified-${index}`,
      question: `Qualified ${String.fromCharCode(65 + index)}`,
      llmYesOdds: index === 5 ? 18 : 85,
      llmNoOdds: index === 5 ? 82 : 15,
      returnsPerDay: 50 - index,
    })),
  ];

  const result = getBullpenTopTenStrongestLlmOddsRows(rows);

  assert.equal(result.length, 10);
  assert.deepEqual(
    result.map((row) => row.id),
    [
      "qualified-0",
      "qualified-1",
      "qualified-2",
      "qualified-3",
      "qualified-4",
      "qualified-5",
      "qualified-6",
      "qualified-7",
      "qualified-8",
      "qualified-9",
    ],
  );
  assert.ok(!result.some((row) => row.id === "excluded"));
});

test("Bullpen x AI Stage 2 popup keeps responsive dialog sizing and left-edge table scroll reset", () => {
  const scheduleCardSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const questionsTableSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenQuestionsTable.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(scheduleCardSource, /max-h-\[92vh\]/);
  assert.match(scheduleCardSource, /w-\[calc\(100vw-2rem\)\]/);
  assert.match(scheduleCardSource, /max-w-\[1500px\]/);
  assert.match(scheduleCardSource, /overflow-y-auto overflow-x-hidden/);
  assert.match(scheduleCardSource, /updatedAt=\{eventsSummaryUpdatedAt\}/);
  assert.match(scheduleCardSource, /scrollResetKey=\{state\.run\?\.id \?\? "stage-two-llm-run"\}/);
  assert.match(questionsTableSource, /scrollResetKey\?: string \| number \| null;/);
  assert.match(questionsTableSource, /displayDensity\?: "default" \| "compact";/);
  assert.match(questionsTableSource, /line-clamp-2/);
  assert.match(questionsTableSource, /scrollTo\(\{\s*left: 0,/);
});

test("Bullpen x AI stale fact validation excludes contradictory public-listing claims", async () => {
  const { validateBullpenStaleFacts } = await loadBullpenAiModule();

  const validation = validateBullpenStaleFacts(
    [
      "Preflight Evidence Block:",
      "Verified current facts:",
      "- detailed market context: SpaceX started trading on Nasdaq under ticker SPACEX on June 1, 2026.",
      "- resolution source: Official exchange listings confirm the ticker is active.",
      "",
      "Instruction:",
      "These facts are authoritative. Do not contradict them.",
    ].join("\n"),
    "SpaceX is still private and there is no IPO yet.",
  );

  assert.equal(validation.invalidStaleFact, true);
  assert.match(validation.staleFactReason, /already confirmed the company is public/i);
});

test("auto-run active position sync uses the shared event identity resolver", () => {
  const source = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/bullpenAutoRunSync.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const pageSource = readFileSync(
    new URL("../app/console/bullpen-ai/_components/BullpenAiPageClient.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /activePositions\?: BullpenActivePositionView\[\]/);
  assert.match(source, /BullpenEventIdentityResolver\.resolveMatch/);
  assert.match(source, /snapshotAnalysesByKey\?: Record<string, BullpenActivePositionLlmAnalysis>/);
  assert.match(pageSource, /activePositions: openActivePositions/);
});

test("Bullpen portfolio uses Stage 1 verification only as a live-data fallback", () => {
  const source = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(source, /shouldUseVerifiedStage1PortfolioFallback/);
  assert.match(source, /positionsVerifiedByStage1={useVerifiedStage1Fallback}/);
  assert.doesNotMatch(
    source,
    /verifiedStage1Portfolio\?\.activePositions \?\? activePositions/,
  );
});
