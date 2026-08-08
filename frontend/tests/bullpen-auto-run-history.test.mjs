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
  assert.match(historyContent, /Grey = not covered/);
  assert.match(scheduleCard, /max-w-7xl/);
  assert.match(apiService, /getBullpenAutoLiveHistoryEventTrends/);
  assert.match(urls, /history\/event-trends/);
  assert.match(scheduleCard, /Promise\.allSettled/);
  assert.match(historyContent, /Loading event trends/);
  assert.match(scheduleCard, /Event trends are temporarily unavailable/);
  assert.match(trendsTable, /href=\{event\.market_url\}/);
  assert.match(trendsTable, /rounded-full bg-green-600 text-white/);
  assert.match(trendsTable, /border-\[1\.5px\] border-black/);
  assert.match(historyContent, /<BullpenLlmBreakdownDialog question=\{llmQuestion\}/);
  assert.match(historyContent, /<BullpenInvestmentMathDialog focus="returnsPerDay"/);
  assert.match(historyContent, /calculateTrendDaysUntilClose/);
  assert.match(historyContent, /event\.scan_timestamps\.find\(Boolean\)/);
  assert.match(historyContent, /daysUntilClose: calculateTrendDaysUntilClose\(event\)/);
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
