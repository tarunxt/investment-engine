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

test("Bullpen history modal loads durable runs instead of relying on summary recent runs", () => {
  assert.match(scheduleCard, /apiService\.getBullpenAutoLiveRuns\(\{/);
  assert.match(scheduleCard, /apiService\.getBullpenAutoLiveDecisions\(\{/);
  assert.match(
    scheduleCard,
    /const visibleRunHistoryRuns = runHistoryBelongsToCurrentUser[\s\S]*?runHistoryRuns \?\? summary\?\.recent_runs \?\? \[\]/,
  );
  assert.match(scheduleCard, /visibleRunHistoryRuns\.map\(\(run\) =>/);
  assert.match(
    scheduleCard,
    /runHistoryOwnerKey === autoRunStatusCacheKey/,
  );
  assert.doesNotMatch(
    scheduleCard,
    /\{summary\?\.recent_runs\.length \? \([\s\S]*?\{summary\.recent_runs\.map\(\(run\) =>/,
  );
});

test("Bullpen history requests bypass caches and remain abortable", () => {
  assert.match(
    apiService,
    /getBullpenAutoLiveRuns\([\s\S]*?\{ cache: "no-store", \.\.\.options \}/,
  );
  assert.match(
    apiService,
    /getBullpenAutoLiveDecisions\([\s\S]*?\{ cache: "no-store", \.\.\.options \}/,
  );
  assert.match(scheduleCard, /runHistoryAbortControllerRef\.current\?\.abort\(\)/);
  assert.match(scheduleCard, /Refresh Bullpen run history/);
});
