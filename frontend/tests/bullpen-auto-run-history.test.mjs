import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const scheduleCard = readFileSync(
  new URL(
    "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
    import.meta.url,
  ),
  "utf8",
);
const historyContent = readFileSync(new URL("../app/console/bullpen-ai/_components/BullpenRunHistoryContent.tsx", import.meta.url), "utf8");
const trendsTable = readFileSync(new URL("../app/console/bullpen-ai/_components/BullpenEventTrendsTable.tsx", import.meta.url), "utf8");
const llmDialog = readFileSync(new URL("../app/console/bullpen-ai/_components/BullpenLlmBreakdownDialog.tsx", import.meta.url), "utf8");
const apiService = readFileSync(
  new URL("../services/api.ts", import.meta.url),
  "utf8",
);
const urls = readFileSync(
  new URL("../lib/urls.ts", import.meta.url),
  "utf8",
);
const bullpenAi = readFileSync(
  new URL("../lib/bullpen-ai.ts", import.meta.url),
  "utf8",
);

test("Bullpen history modal loads a compact page and lazy selected-run detail", () => {
  assert.match(scheduleCard, /apiService\.getBullpenAutoLiveHistory\(/);
  assert.match(
    scheduleCard,
    /apiService\.getBullpenAutoLiveRun\(item\.id,[\s\S]*?apiService\.getBullpenAutoLiveRunDecisions\(item\.id,/,
  );
  assert.match(
    scheduleCard,
    /getBullpenAutoLiveRunConsole\(item\.id,[\s\S]*?const visibleDecisionIds = Array\.isArray\([\s\S]*?consoleDetail\.visible_decision_ids/,
  );
  assert.match(
    scheduleCard,
    /persistedDecisions = Array\.isArray\(decisions\) \? decisions : \[\]/,
  );
  assert.match(
    scheduleCard,
    /detailDecisions\.length < visibleDecisionIds\.length/,
  );
  assert.doesNotMatch(
    scheduleCard,
    /detailDecisions\.length <\s*consoleDetail\.visible_decision_ids\.length/,
  );
  assert.match(historyContent, /page\?\.items\.map\(run =>/);
  assert.match(
    scheduleCard,
    /runHistoryOwnerKey === autoRunStatusCacheKey/,
  );
  assert.doesNotMatch(
    scheduleCard,
    /runHistoryPage \?\? summary\?\.recent_runs/,
  );
});

test("Bullpen history requests bypass caches and remain abortable", () => {
  assert.match(
    apiService,
    /getBullpenAutoLiveHistory\([\s\S]*?\{ cache: "no-store", \.\.\.options \}/,
  );
  assert.match(
    apiService,
    /getBullpenAutoLiveRunDecisions\([\s\S]*?\{ cache: "no-store", \.\.\.options \}/,
  );
  assert.match(scheduleCard, /runHistoryAbortControllerRef\.current\?\.abort\(\)/);
  assert.match(
    scheduleCard,
    /runHistoryDetailAbortControllerRef\.current\?\.abort\(\)/,
  );
  assert.match(historyContent, /Close Bullpen run history/);
  assert.match(historyContent, /Page \{page\.page\}/);
});

test("Bullpen history shows scored event trends for exactly 20 newest-first scans", () => {
  assert.match(historyContent, /Recurring Events Across the Last 20 Scans/);
  assert.match(historyContent, /latest \+ 0\.5 × previous \+ 0\.25 × third-latest/);
  assert.match(trendsTable, /event\.scan_scores\.map\(\(score,i\) =>/);
  assert.match(historyContent, /Grey = not covered \/ no valid LLM score/);
  assert.match(historyContent, /Latest saved run:/);
  assert.match(historyContent, /Latest scored LLM scan:/);
  assert.match(historyContent, /page\?\.page === 1 \? page\.items\[0\]\?\.started_at/);
  assert.match(historyContent, /Strongest LLM odds ≥80%/);
  assert.match(historyContent, /role="switch" aria-checked=\{showStrongestOnly\}/);
  assert.match(trendsTable, /\(event\.scan_scores\[0\] \?\? -1\) >= 80/);
  assert.match(trendsTable, /hasStrongestLatestLlmOdds\(event\) \|\| event\.is_active_position \|\| event\.is_claimable_position/);
  assert.match(trendsTable, /hasHeldSideOddsBelowThreshold\(event\)[\s\S]*?activeBelowOddsThreshold \? "bg-red-200 text-red-950 ring-2 ring-inset ring-red-600/);
  assert.match(trendsTable, /data-active-below-odds-threshold=\{activeBelowOddsThreshold \|\| undefined\}/);
  assert.match(trendsTable, /data-active-below-current-odds-threshold=\{heldSideCurrentBelowThreshold \|\| undefined\}/);
  assert.match(trendsTable, /Active held-side odds alert:/);
  assert.match(trendsTable, /aExpiredNotYetClaimable[\s\S]*?return aExpiredNotYetClaimable \? -1 : 1/);
  assert.match(trendsTable, /aClaimable[\s\S]*?return aClaimable \? -1 : 1/);
  assert.match(trendsTable, /aReturnsUnavailable[\s\S]*?return aReturnsUnavailable \? -1 : 1/);
  assert.match(trendsTable, /isExpiredNotYetClaimablePosition/);
  assert.match(trendsTable, /if \(!event\.is_active_position \|\| event\.is_claimable_position \|\| !event\.close_time\) return false/);
  assert.match(trendsTable, /data-expired-not-yet-claimable=\{expiredNotYetClaimable \|\| undefined\}/);
  assert.match(trendsTable, /expiredNotYetClaimable \? "bg-emerald-100 text-emerald-950 ring-1 ring-inset ring-emerald-400/);
  assert.match(trendsTable, /data-claimable=\{claimable \|\| undefined\}/);
  assert.match(trendsTable, /claimable \? "bg-emerald-300 text-emerald-950 ring-2 ring-inset ring-emerald-600/);
  assert.match(trendsTable, /available to claim now/);
  assert.match(trendsTable, />Claim<\/span>/);
  assert.match(trendsTable, /data-returns-unavailable=\{returnsUnavailable \|\| undefined\}/);
  assert.match(trendsTable, /returnsUnavailable \? "bg-emerald-100 text-emerald-950 ring-1 ring-inset ring-emerald-400/);
  assert.match(scheduleCard, /max-w-7xl/);
  assert.match(apiService, /getBullpenAutoLiveHistoryEventTrends/);
  assert.match(urls, /history\/event-trends/);
  assert.match(scheduleCard, /Promise\.allSettled/);
  assert.match(historyContent, /Loading event trends/);
  assert.match(scheduleCard, /Event trends are temporarily unavailable/);
  assert.match(trendsTable, /href=\{buildBullpenMarketUrl\(event\.market_id\)\}/);
  assert.match(trendsTable, /aria-label=\{`Open \$\{event\.market_title\} on Polymarket`\}/);
  assert.match(trendsTable, /href=\{event\.market_url\}/);
  assert.match(trendsTable, /Not covered<br\/>in latest scan/);
  assert.match(trendsTable, /rounded-full bg-green-600 text-white/);
  assert.match(trendsTable, /heldSideLlmOdds != null && heldSideLlmOdds < HELD_SIDE_ODDS_ALERT_THRESHOLD/);
  assert.match(trendsTable, /activePositionSide === "YES" \? event\.llm_yes_odds : activePositionSide === "NO" \? event\.llm_no_odds/);
  assert.match(trendsTable, /activePositionSide === "YES" \? event\.current_yes_odds : activePositionSide === "NO" \? event\.current_no_odds/);
  assert.match(trendsTable, /hasHeldSideLlmOddsBelowThreshold\(event\) \|\| hasHeldSideCurrentOddsBelowThreshold\(event\)/);
  assert.match(trendsTable, /animate-pulse rounded bg-red-600 px-1 font-black text-white ring-2 ring-red-300/);
  assert.match(trendsTable, /ALERT: held-side LLM odds are below 80%/);
  assert.match(trendsTable, /border-\[1\.5px\] border-black/);
  assert.match(historyContent, /<BullpenLlmBreakdownDialog question=\{llmQuestion\}/);
  assert.match(historyContent, /<BullpenInvestmentMathDialog focus="returnsPerDay"/);
  assert.match(historyContent, /calculateTrendDaysUntilClose/);
  assert.match(historyContent, /event\.scan_timestamps\.find\(Boolean\)/);
  assert.match(historyContent, /daysUntilClose: calculateTrendDaysUntilClose\(event\)/);
});

test("Run History Returns/day header opens a persistent Excel-style formula editor", () => {
  const historyContent = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenRunHistoryContent.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const trendsTable = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenEventTrendsTable.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const formulaDialog = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenReturnsPerDayInfo.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(trendsTable, /BullpenReturnsPerDayHeaderInfo/);
  assert.match(historyContent, /BullpenReturnsPerDayFormulaDialog/);
  assert.match(formulaDialog, /Excel-style formula/);
  assert.match(formulaDialog, /returns_per_day_formula: formula/);
  assert.match(
    formulaDialog,
    /=\(100-CURRENT_CHOSEN_SIDE_BULLPEN_ODDS\)\/\(DAYS_UNTIL_CLOSE\+4\)/,
  );
});

test("Bullpen event links use the direct market route instead of the trending search", () => {
  assert.match(
    bullpenAi,
    /BULLPEN_PREDICTIONS_MARKET_URL\s*=\s*[\s\S]*?\/predictions\/market/,
  );
  assert.match(bullpenAi, /encodeURIComponent\(normalizedMarketId\)/);
  assert.doesNotMatch(
    bullpenAi,
    /BULLPEN_PREDICTIONS_URL[\s\S]*?searchParams\.set\("marketId"/,
  );
});

test("event trends support deadlines, persistent table controls, and stable scan details", () => {
  assert.match(trendsTable, /label: "Deadline"/);
  assert.match(trendsTable, /localStorage\.setItem\(STORAGE_KEY/);
  assert.match(trendsTable, /draggable/);
  assert.match(trendsTable, /cursor-col-resize/);
  assert.match(trendsTable, /rowIndex===9/);
  assert.match(trendsTable, /Click the event circle to keep these details open/);
  assert.match(trendsTable, /scan_llm_outputs/);
  assert.match(llmDialog, /Individual LLM odds and commentary/);
  assert.match(llmDialog, /output\.rationale/);
});

test("active run detail keeps polling the exact selected run and stops when hidden or closed", () => {
  assert.match(
    urls,
    /runConsole: \(runId: string\)[\s\S]*?encodeURIComponent\(runId\)\}\/console/,
  );
  assert.match(
    apiService,
    /getBullpenAutoLiveRunConsole\([\s\S]*?URLs\.bullpenAutoLive\.runConsole\(runId\)[\s\S]*?\{ cache: "no-store", \.\.\.options \}/,
  );
  assert.match(
    scheduleCard,
    /apiService\.getBullpenAutoLiveRunConsole\(\s*runDetailRefreshRunId,/,
  );
  const activePollSource = scheduleCard.slice(
    scheduleCard.indexOf("const refreshExactRun = async () =>"),
    scheduleCard.indexOf(
      "}, [runDetailRefreshRunId, runDetailRefreshRunStatus]);",
    ),
  );
  assert.doesNotMatch(activePollSource, /getBullpenAutoLiveRunDecisions/);
  assert.doesNotMatch(activePollSource, /getBullpenAutoLiveRun\(/);
  assert.match(scheduleCard, /document\.visibilityState === "hidden"/);
  assert.match(
    scheduleCard,
    /runDetailRefreshAbortControllerRef\.current\?\.abort\(\)/,
  );
  assert.match(
    scheduleCard,
    /current\.run\.id !== run\.id/,
  );
  assert.match(scheduleCard, /projection_available: projectionAvailable/);
  assert.match(scheduleCard, /decisions_truncated: decisionsTruncated/);
  assert.match(scheduleCard, /mergeBullpenConsoleRunProjection/);
  assert.match(scheduleCard, /mergeBullpenConsoleDecisionProjection/);
});
