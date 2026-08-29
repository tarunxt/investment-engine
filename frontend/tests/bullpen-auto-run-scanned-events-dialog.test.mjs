import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL(
    "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
    import.meta.url,
  ),
  "utf8",
);

test("scanned events dialog uses the authoritative total and explains missing rows", () => {
  assert.match(
    source,
    /All Events Scanned \(\{state\.totalScanned\}\)/,
  );
  assert.match(source, /No detailed event rows are available\./);
  assert.match(source, /retained aggregate scan counts only/);
  assert.match(source, /detailed rows have not been published yet/);
  assert.match(source, /events passed Stage 1 filters/);
});

test("scanned events dialog displays per-event filter reasons", () => {
  assert.match(source, />Reason<\/th>/);
  assert.match(source, /candidate\.filterReasons\.join\("; "\)/);
  assert.match(source, /Passed all Stage 1 filters\./);
});

test("scanned events dialog analyses every filter reason with event drill-down", () => {
  assert.match(source, /Analyse Filtered Events/);
  assert.match(source, /Filtered Events Analysis/);
  assert.match(source, /Every assigned filter reason is counted/);
  assert.match(source, />Events caught<\/th>/);
  assert.match(source, /setSelectedFilterReason\(group\.reason\)/);
  assert.match(source, /Stage 1 filter drill-down/);
  assert.match(source, /Back to all scanned events/);
});

test("scanned events dialog searches and paginates large exhaustive scans", () => {
  assert.match(source, /aria-label="Search scanned events"/);
  assert.match(source, /const eventRowsPerPage = 100/);
  assert.match(source, /visibleCandidates\.map/);
  assert.match(source, /Page \{boundedEventPage\} of \{eventPageCount\}/);
});

test("Stage 1 passed-filter count shows the exact included active-event overlap", () => {
  assert.match(source, /function getStageOneIncludedActiveCount/);
  assert.match(source, /activeRows\.length !== stats\.activePositions/);
  assert.match(source, /stage\.scanCandidates\.length !== stats\.passedFilters/);
  assert.match(source, /return null/);
  assert.match(
    source,
    /Includes \$\{includedActiveCount\} active event\$\{includedActiveCount === 1 \? "" : "s"\}/,
  );
  assert.match(source, /\{includedActiveLabel\}/);
});
