import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Stage 2 invest list keeps shortlisted BUY_NEW rows visible until Stage 3 finishes", () => {
  const source = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(source, /if \(decision\.decision === "BUY_NEW"\) \{\s*return true;/);
  assert.match(source, /buildBullpenStage2TopTenHandoffRows/);
  assert.match(source, /Persisted Stage 2 Top 10 candidates that Stage 3 is trying to\s+execute\./);
  assert.match(source, /If a transferred event never became a concrete Step 2\s+buy plan/);
  assert.match(source, /Execution blocker \/ detail:/);
  assert.match(source, /row\.missingFromStage3/);
  assert.match(source, /decision\.stage3_result\?\.replaceAll\("_", " "\) \?\? "Pending"/);
});
