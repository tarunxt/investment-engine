import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("historical assessment filtering retains valid rows from every run", () => {
  const source = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenEventHistoricalAssessmentTable.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(source, /buildBullpenHistoricalAssessmentGroups\(historicalRows\)/);
  assert.match(source, /historicalGroups\.flatMap/);
  assert.match(
    source,
    /group\.rows\.filter\(\s*\(row\) => !isBullpenHistoricalAssessmentRowInvalid\(row\)/,
  );
  assert.doesNotMatch(source, /buildBullpenHistoricalAssessmentGroups\(visibleRows\)/);
});
