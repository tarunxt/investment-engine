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
    /getBullpenAutoLiveRunConsole\(item\.id,[\s\S]*?visibleDecisionIds:\s*consoleDetail\.visible_decision_ids/,
  );
  assert.match(scheduleCard, /visibleRunHistoryItems\.map\(\(run\) =>/);
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
  assert.match(scheduleCard, /Refresh Bullpen run history/);
  assert.match(scheduleCard, /Page \{visibleRunHistoryPage\.page\}/);
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
